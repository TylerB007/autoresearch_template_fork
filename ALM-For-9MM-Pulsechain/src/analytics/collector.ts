/**
 * Analytics data collection orchestrator.
 * Creates lightweight snapshots during monitoring and comprehensive analytics at rebalance.
 * All writes are async and non-blocking.
 */

import { randomUUID } from 'node:crypto';
import type { PositionStatus, RebalanceResult, AppConfig, StrategyType } from '../types.js';
import type {
  PositionSnapshot,
  RebalanceAnalytics,
  RebalanceLifecycleEvent,
  PositionEntryRecord,
  GasUsageData,
  RebalanceTxHashes,
  TriggerEvent,
  StrategyRuleSetSnapshot,
  PriceHistoryRecord,
} from './types.js';
import { calculateRebalanceMetrics } from './metrics.js';
import { writeAnalyticsRecord, queryRebalances, chainStoragePath, ensureStorageDir } from './storage.js';
import { updateSnapshotCache, updateRebalanceCache, updateEventCache } from './cache.js';
import { bigintToFloat, bigintWeiToFloat, sqrtPriceX96ToPrice } from '../bigintFloat.js';
import { enqueuePendingPrice } from '../pricing/index.js';
import { CHAIN_REGISTRY } from '../config/chains.js';
import { appendPriceHistory, buildPriceHistoryRecord, computeSigma, computeViabilityFields } from './priceHistory.js';
import type { PoolContext } from '../server/services/priceService.js';
import logger from '../logger.js';

// ============================================================
// STRATEGY RULE SET SNAPSHOT — version counter per position
// ============================================================

// In-memory version counters (reset on restart — version is for ordering within a run)
const ruleSetVersionCounters = new Map<string, number>();

/**
 * Build a StrategyRuleSetSnapshot from a PositionConfig.
 * Call this whenever a position is deployed or its strategy params change.
 */
export function buildStrategyRuleSetSnapshot(
  posConfig: import('../types.js').PositionConfig,
  chainId: number,
  notes?: string,
): StrategyRuleSetSnapshot {
  const key = `${chainId}-${posConfig.token_id}`;
  const version = (ruleSetVersionCounters.get(key) ?? 0) + 1;
  ruleSetVersionCounters.set(key, version);

  const params = posConfig.params;
  return {
    ruleSetId: randomUUID(),
    tokenId: posConfig.token_id,
    chainId,
    version,
    createdAt: Date.now(),
    strategy: posConfig.strategy,
    widthTicks: params.width_ticks,
    triggerDistanceTicks: params.trigger_distance_ticks,
    confirmMinutes: params.confirm_minutes ?? 0,
    criticalDistanceTicks: params.critical_distance_ticks,
    maxRebalancesPerWindow: params.max_rebalances_per_window,
    churnWindowHours: params.churn_window_hours,
    escalationWidthTicks: params.escalation_width,
    costBenefitEnabled: params.cost_benefit_enabled,
    minFeeToCostRatio: params.min_fee_to_cost_ratio,
    killSwitchMaxLossPct: params.kill_switch?.max_loss_percent,
    killSwitchMaxConsecutiveLosses: params.kill_switch?.max_consecutive_losses,
    killSwitchLossWindowHours: params.kill_switch?.loss_window_hours,
    killSwitchMinHodlRatio: params.kill_switch?.min_hodl_ratio,
    notes,
  };
}

export class AnalyticsCollector {
  private lastSnapshotTime = new Map<number, number>();
  private snapshotIntervalMs: number;
  private storagePath: string;
  private persistToDisk: boolean;

  constructor(config: AppConfig) {
    this.snapshotIntervalMs = config.analytics.snapshot_interval_minutes * 60 * 1000;
    this.storagePath = config.analytics.storage_path;
    this.persistToDisk = config.analytics.persist_to_disk;
  }

  /** Get the storage path for a specific chain (creates subdir if needed). */
  getChainStoragePath(chainId: number): string {
    return chainStoragePath(this.storagePath, chainId);
  }

  /** Get the base storage path (for queries that span all chains). */
  getBasePath(): string {
    return this.storagePath;
  }

  /**
   * Create a lightweight snapshot from current position status.
   * Called every monitoring cycle — only persists at configured interval.
   *
   * @param prices       Optional USD prices for token0, token1, and the chain native token.
   * @param options      Optional extended fields: pool context, HODL benchmark data, cumulative costs,
   *                     sigma volatility, trigger type, and initial capital for HODL comparison.
   */
  createSnapshot(
    status: PositionStatus,
    prices?: { priceUsd0: number; priceUsd1: number; nativePriceUsd: number; source?: string },
    options?: {
      chainId?: number;
      dex?: string;
      poolContext?: PoolContext;
      /** Initial token quantities at position entry — needed for HODL benchmark */
      initialAmount0?: bigint;
      initialAmount1?: bigint;
      /** Initial capital in USD (from PositionEntryRecord.entryCostUsd) */
      initialCapitalUsd?: number;
      /** Cumulative fees earned to date in USD */
      cumulativeFeesUsd?: number;
      /** Cumulative gas costs in USD */
      cumulativeGasCostUsd?: number;
      /** Cumulative Type-B costs (slippage + impact) in USD */
      cumulativeTypeBCostUsd?: number;
      /** Annualized σ_7d from price history */
      sigma7d?: number;
      /** Annualized σ_30d from price history */
      sigma30d?: number;
      /** Volatility ratio sigma7d/sigma30d */
      volatilityRatio?: number;
      /** Volatility estimate confidence */
      sigmaConfidence?: 'high' | 'medium' | 'low';
      /** Cumulative time-in-range % since entry */
      timeInRangePct?: number;
      /** Why this snapshot was taken */
      snapshotTrigger?: 'scheduled' | 'pre_rebalance' | 'post_rebalance' | 'manual';
    },
  ): PositionSnapshot {
    const priceUsd0 = prices?.priceUsd0 ?? 0;
    const priceUsd1 = prices?.priceUsd1 ?? 0;
    const nativePriceUsd = prices?.nativePriceUsd ?? 0;
    const d0 = status.token0Info.decimals;
    const d1 = status.token1Info.decimals;

    const positionValueUsd =
      bigintToFloat(status.amount0, d0) * priceUsd0 +
      bigintToFloat(status.amount1, d1) * priceUsd1;

    const unclaimedFeesUsd =
      bigintToFloat(status.unclaimedFees0, d0) * priceUsd0 +
      bigintToFloat(status.unclaimedFees1, d1) * priceUsd1;

    // Price ratio: token1/token0 (decimal-adjusted, human-readable)
    let priceRatio: number | undefined;
    if (priceUsd0 > 0 && priceUsd1 > 0) {
      priceRatio = priceUsd0 / priceUsd1;
    } else {
      // Derive from sqrtPriceX96 if USD prices unavailable
      const rawRatio = sqrtPriceX96ToPrice(status.pool.sqrtPriceX96);
      if (rawRatio > 0) {
        const decimalAdjust = 10 ** (d0 - d1);
        priceRatio = rawRatio * decimalAdjust;
      }
    }

    // Distance to range bounds as % of current price
    let distanceToLowerPct: number | undefined;
    let distanceToUpperPct: number | undefined;
    if (priceRatio !== undefined && priceRatio > 0) {
      // Convert ticks to prices for lower/upper bounds
      const lowerPrice = Math.pow(1.0001, status.position.tickLower) * (10 ** d0) / (10 ** d1);
      const upperPrice = Math.pow(1.0001, status.position.tickUpper) * (10 ** d0) / (10 ** d1);
      distanceToLowerPct = ((priceRatio - lowerPrice) / priceRatio) * 100;
      distanceToUpperPct = ((upperPrice - priceRatio) / priceRatio) * 100;
    }

    // HODL benchmark
    let hodlValueUsd: number | undefined;
    let unrealizedIlPct: number | undefined;
    let lpReturnPct: number | undefined;
    let hodlReturnPct: number | undefined;
    let lpVsHodlPct: number | undefined;
    if (options?.initialAmount0 !== undefined && options?.initialAmount1 !== undefined && priceUsd0 > 0 && priceUsd1 > 0) {
      hodlValueUsd =
        bigintToFloat(options.initialAmount0, d0) * priceUsd0 +
        bigintToFloat(options.initialAmount1, d1) * priceUsd1;

      const initialCapital = options.initialCapitalUsd ?? hodlValueUsd;
      if (initialCapital > 0) {
        unrealizedIlPct = ((positionValueUsd - hodlValueUsd) / initialCapital) * 100;
        const cumulFees = options.cumulativeFeesUsd ?? 0;
        lpReturnPct = ((positionValueUsd + cumulFees - initialCapital) / initialCapital) * 100;
        hodlReturnPct = ((hodlValueUsd - initialCapital) / initialCapital) * 100;
        lpVsHodlPct = lpReturnPct - hodlReturnPct;
      }
    }

    // Running cost totals and net P&L
    const cumulativeGasCostUsd = options?.cumulativeGasCostUsd;
    const cumulativeTypeBCostUsd = options?.cumulativeTypeBCostUsd;
    const cumulativeTotalCostUsd =
      cumulativeGasCostUsd !== undefined && cumulativeTypeBCostUsd !== undefined
        ? cumulativeGasCostUsd + cumulativeTypeBCostUsd
        : undefined;
    const cumulativeFeesUsd = options?.cumulativeFeesUsd;
    const costAsPctOfFees =
      cumulativeTotalCostUsd !== undefined && cumulativeFeesUsd !== undefined && cumulativeFeesUsd > 0
        ? (cumulativeTotalCostUsd / cumulativeFeesUsd) * 100
        : undefined;
    const netPnlUsd =
      cumulativeTotalCostUsd !== undefined && cumulativeFeesUsd !== undefined && options?.initialCapitalUsd !== undefined
        ? positionValueUsd + cumulativeFeesUsd - options.initialCapitalUsd - cumulativeTotalCostUsd
        : undefined;

    // Pool context fields
    const poolCtx = options?.poolContext;
    const poolTvlUsd = poolCtx?.tvlUsd;
    const poolVolume24hUsd = poolCtx?.volume24hUsd;
    const poolFeeRate = poolCtx?.feeRate;
    const volumeToTvlRatio = poolCtx?.volumeToTvlRatio;

    // Range width in % for viability calculations
    const widthPct = priceRatio !== undefined && priceRatio > 0 ? (() => {
      const lowerPrice = Math.pow(1.0001, status.position.tickLower) * (10 ** d0) / (10 ** d1);
      const upperPrice = Math.pow(1.0001, status.position.tickUpper) * (10 ** d0) / (10 ** d1);
      return ((upperPrice - lowerPrice) / priceRatio) * 100;
    })() : undefined;

    // Profitability viability (sigma²/8 vs pool fee rate)
    const viability = computeViabilityFields(options?.sigma30d, poolFeeRate, widthPct);

    // Data staleness flag
    const dataStale = (priceUsd0 === 0 && priceUsd1 === 0) || poolTvlUsd === undefined;

    return {
      timestamp: Date.now(),
      tokenId: status.position.tokenId,
      chainId: options?.chainId,
      dex: options?.dex,
      liquidity: status.position.liquidity,
      tickLower: status.position.tickLower,
      tickUpper: status.position.tickUpper,
      amount0: status.amount0,
      amount1: status.amount1,
      currentTick: status.pool.currentTick,
      sqrtPriceX96: status.pool.sqrtPriceX96,
      poolLiquidity: status.pool.liquidity,
      isInRange: status.isInRange,
      tickDistance: status.tickDistance,
      distanceToLowerPct,
      distanceToUpperPct,
      tokensOwed0: status.position.tokensOwed0,
      tokensOwed1: status.position.tokensOwed1,
      token0Symbol: status.token0Info.symbol,
      token1Symbol: status.token1Info.symbol,
      token0Decimals: d0,
      token1Decimals: d1,
      poolFee: status.pool.fee,
      priceUsd0,
      priceUsd1,
      nativePriceUsd,
      priceRatio,
      positionValueUsd,
      unclaimedFeesUsd,
      cumulativeFeesUsd,
      hodlValueUsd,
      unrealizedIlPct,
      lpReturnPct,
      hodlReturnPct,
      lpVsHodlPct,
      cumulativeGasCostUsd,
      cumulativeTypeBCostUsd,
      cumulativeTotalCostUsd,
      costAsPctOfFees,
      netPnlUsd,
      poolTvlUsd,
      poolVolume24hUsd,
      poolFeeRate,
      volumeToTvlRatio,
      sigma7d: options?.sigma7d,
      sigma30d: options?.sigma30d,
      volatilityRatio: options?.volatilityRatio,
      sigmaConfidence: options?.sigmaConfidence,
      minPlRate: viability.minPlRate,
      profitabilityMargin: viability.profitabilityMargin,
      profitabilityViable: viability.profitabilityViable,
      effectiveAprPct: viability.effectiveAprPct,
      timeInRangePct: options?.timeInRangePct,
      dataStale,
      snapshotTrigger: options?.snapshotTrigger ?? 'scheduled',
      priceSource: prices?.source,
      timestampMs: Date.now(),
    };
  }

  /**
   * Process a snapshot: always update cache, persist to disk at configured interval.
   * When chainId is provided, writes to per-chain subdirectory.
   */
  async processSnapshot(snapshot: PositionSnapshot, chainId?: number): Promise<void> {
    // Always update in-memory cache
    updateSnapshotCache(snapshot);

    // Only persist to disk at the configured interval
    if (!this.persistToDisk) return;

    const lastTime = this.lastSnapshotTime.get(snapshot.tokenId) ?? 0;
    if (Date.now() - lastTime < this.snapshotIntervalMs) return;

    this.lastSnapshotTime.set(snapshot.tokenId, Date.now());
    const path = chainId !== undefined ? this.getChainStoragePath(chainId) : this.storagePath;
    await ensureStorageDir(path);
    await writeAnalyticsRecord(
      { type: 'snapshot', timestamp: snapshot.timestamp, data: snapshot },
      path,
    );
  }

  /**
   * Emit a lifecycle event — records a single step during a rebalance.
   * Fire-and-forget: never throws, logs warnings only.
   */
  async emitEvent(event: RebalanceLifecycleEvent, chainId?: number): Promise<void> {
    try {
      updateEventCache(event);
      if (this.persistToDisk) {
        const path = chainId !== undefined ? this.getChainStoragePath(chainId) : this.storagePath;
        await ensureStorageDir(path);
        const writeResult = await writeAnalyticsRecord(
          { type: 'lifecycle_event', timestamp: event.timestamp, data: event },
          path,
        );

        // Enqueue for backfill if prices are pending
        if (event.priceStatus === 'pending' && writeResult && event.token0Address && event.token1Address) {
          const chainSlug = chainId !== undefined
            ? (CHAIN_REGISTRY[chainId]?.dexScreenerSlug ?? 'pulsechain')
            : 'pulsechain';

          enqueuePendingPrice({
            filePath: writeResult.filePath,
            lineIndex: writeResult.lineIndex,
            recordType: `lifecycle:${event.eventType}`,
            tokenId: event.tokenId,
            eventTimestamp: event.timestamp,
            token0Address: event.token0Address,
            token1Address: event.token1Address,
            nativeWrappedAddress: event.nativeWrappedAddress ?? '',
            chainSlug,
            chainId,
            dex: event.dex,
          });
        }
      }
    } catch (error) {
      logger.warn(`Failed to emit lifecycle event: ${error}`);
    }
  }

  /**
   * Emit a structured trigger event — records every monitoring-cycle check outcome.
   * This includes both "rebalance" decisions AND "hold" / "near-edge warning" decisions.
   * Fire-and-forget: never throws.
   */
  async emitTriggerEvent(event: TriggerEvent, chainId?: number): Promise<void> {
    try {
      if (this.persistToDisk) {
        const path = chainId !== undefined ? this.getChainStoragePath(chainId) : this.storagePath;
        await ensureStorageDir(path);
        await writeAnalyticsRecord(
          { type: 'trigger_event', timestamp: event.timestamp, data: event },
          path,
        );
      }
    } catch (error) {
      logger.warn(`Failed to emit trigger event: ${error}`);
    }
  }

  /**
   * Write a versioned strategy rule set snapshot.
   * Called when a position is first deployed or when /config changes a parameter.
   * Fire-and-forget: never throws.
   */
  async captureStrategyRuleSet(snapshot: StrategyRuleSetSnapshot, chainId?: number): Promise<void> {
    try {
      if (this.persistToDisk) {
        const path = chainId !== undefined ? this.getChainStoragePath(chainId) : this.storagePath;
        await ensureStorageDir(path);
        await writeAnalyticsRecord(
          { type: 'strategy_rule_set', timestamp: snapshot.createdAt, data: snapshot },
          path,
        );
        logger.debug(`Strategy rule set v${snapshot.version} captured for position ${snapshot.tokenId}`);
      }
    } catch (error) {
      logger.warn(`Failed to capture strategy rule set: ${error}`);
    }
  }

  /**
   * Append a price observation to the rolling per-pool price history.
   * Also triggers pruning to enforce 30-day retention.
   * Used to build the price history needed for sigma_7d/sigma_30d computation.
   * Fire-and-forget: never throws.
   */
  async appendPriceObservation(record: PriceHistoryRecord, chainId?: number): Promise<void> {
    try {
      const path = chainId !== undefined ? this.getChainStoragePath(chainId) : this.storagePath;
      await appendPriceHistory(path, record);
    } catch (error) {
      logger.warn(`Failed to append price observation: ${error}`);
    }
  }

  /**
   * Compute current sigma_7d / sigma_30d for a pool from stored price history.
   * Returns undefined fields if insufficient history is available.
   */
  async getSigma(poolAddress: string, chainId?: number): Promise<{
    sigma7d?: number;
    sigma30d?: number;
    volatilityRatio?: number;
    sigmaConfidence?: 'high' | 'medium' | 'low';
  }> {
    try {
      const path = chainId !== undefined ? this.getChainStoragePath(chainId) : this.storagePath;
      const result = await computeSigma(path, poolAddress);
      const confidence = result.confidence === 'insufficient' ? undefined : result.confidence;
      return {
        sigma7d: result.sigma7d,
        sigma30d: result.sigma30d,
        volatilityRatio: result.volatilityRatio,
        sigmaConfidence: confidence,
      };
    } catch {
      return {};
    }
  }

  /**
   * Capture comprehensive analytics for a completed rebalance.
   */
  async captureRebalance(
    preStatus: PositionStatus,
    postStatus: PositionStatus,
    result: RebalanceResult,
    txHashes: RebalanceTxHashes,
    gasUsed: GasUsageData,
    gasPrice: bigint,
    dust: { amount0: bigint, amount1: bigint },
    strategy: StrategyType,
    rebalanceId?: string,
    chainId?: number,
    dex?: string,
    prices?: { priceUsd0: number; priceUsd1: number; nativePriceUsd: number; source?: string; priceStatus?: 'live' | 'backfilled' | 'pending' | 'permanently_missing'; nativeWrappedAddress?: string; chainSlug?: string },
  ): Promise<RebalanceAnalytics> {
    const preSnapshot = this.createSnapshot(preStatus, prices, { chainId, dex });
    const postSnapshot = this.createSnapshot(postStatus, prices, { chainId, dex });

    const totalGasCostPLS = gasUsed.totalCostWei 
      ? bigintWeiToFloat(gasUsed.totalCostWei)
      : bigintWeiToFloat(gasUsed.total * gasPrice);

    // Look up previous rebalance timestamp for duration calculation
    const queryPath = chainId !== undefined ? this.getChainStoragePath(chainId) : this.storagePath;
    let previousTimestamp: number | undefined;
    try {
      const previous = await queryRebalances(queryPath);
      const lastForPosition = previous
        .filter((r) => r.newTokenId === result.oldTokenId || r.oldTokenId === result.oldTokenId)
        .pop();
      previousTimestamp = lastForPosition?.timestamp;
    } catch {
      // No previous data — first rebalance
    }

    // Build swap details if swap was executed
    let swapDetails: RebalanceAnalytics['swap'] = undefined;
    if (result.swapExecuted) {
      const isToken0In = result.swapExecuted.tokenIn.toLowerCase() ===
        preStatus.pool.token0.toLowerCase();
      const amountIn = result.swapExecuted.amountIn;
      const actualOut = result.swapExecuted.amountOut;

      // Compute expected output using pool sqrtPriceX96 to convert between tokens.
      // Previous code compared amountIn to amountOut directly (different tokens!),
      // producing nonsensical slippage values like 17 trillion bps.
      const Q96 = 2n ** 96n;
      const sqrtPrice = preSnapshot.sqrtPriceX96;
      let expectedOut: bigint;
      if (isToken0In) {
        // token0 -> token1: expectedOut = amountIn * sqrtPrice^2 / Q96^2
        // Split to avoid overflow: (amountIn * sqrtPrice / Q96) * sqrtPrice / Q96
        expectedOut = sqrtPrice > 0n
          ? (amountIn * sqrtPrice / Q96) * sqrtPrice / Q96
          : 0n;
      } else {
        // token1 -> token0: expectedOut = amountIn * Q96^2 / sqrtPrice^2
        expectedOut = sqrtPrice > 0n
          ? (amountIn * Q96 / sqrtPrice) * Q96 / sqrtPrice
          : 0n;
      }

      // Calculate slippage in basis points, clamped to a sane range
      let slippageBps = 0;
      if (expectedOut > 0n) {
        const diff = expectedOut > actualOut
          ? expectedOut - actualOut
          : actualOut - expectedOut;
        slippageBps = Number(diff * 10000n / expectedOut);
      }
      // Clamp to 0-500 bps (5%) — any value higher indicates a calculation
      // error (e.g., stale sqrtPriceX96, multi-hop routing via aggregator).
      // Real DEX slippage on PulseChain rarely exceeds 2-3%.
      slippageBps = Math.min(500, Math.abs(slippageBps));

      swapDetails = {
        tokenIn: isToken0In ? 'token0' : 'token1',
        amountIn: result.swapExecuted.amountIn,
        amountOut: result.swapExecuted.amountOut,
        configuredSlippageBps: result.swapExecuted.configuredSlippageBps,
        realizedExecutionDeltaBps: slippageBps,
        slippageBps,
      };
    }

    // Compute range metadata (width % and center price) for both old and new ranges
    const d0 = preStatus.token0Info.decimals;
    const d1 = preStatus.token1Info.decimals;
    const priceUsd0 = prices?.priceUsd0 ?? 0;
    const priceUsd1 = prices?.priceUsd1 ?? 0;

    // Helper: tick range to center price (decimal-adjusted token1/token0)
    function tickRangeCenterPrice(tickLow: number, tickHigh: number): number {
      const centerTick = (tickLow + tickHigh) / 2;
      return Math.pow(1.0001, centerTick) * (10 ** d0) / (10 ** d1);
    }
    function tickRangeWidthPct(tickLow: number, tickHigh: number, refTick: number): number {
      const lowerPrice = Math.pow(1.0001, tickLow) * (10 ** d0) / (10 ** d1);
      const upperPrice = Math.pow(1.0001, tickHigh) * (10 ** d0) / (10 ** d1);
      const refPrice = Math.pow(1.0001, refTick) * (10 ** d0) / (10 ** d1);
      if (refPrice <= 0) return 0;
      return ((upperPrice - lowerPrice) / refPrice) * 100;
    }

    const oldTickLower = preStatus.position.tickLower;
    const oldTickUpper = preStatus.position.tickUpper;
    const newTickLower = postStatus.position.tickLower;
    const newTickUpper = postStatus.position.tickUpper;

    const oldWidthPct = tickRangeWidthPct(oldTickLower, oldTickUpper, preSnapshot.currentTick);
    const oldCenterPrice = tickRangeCenterPrice(oldTickLower, oldTickUpper);
    const newWidthPct = tickRangeWidthPct(newTickLower, newTickUpper, postSnapshot.currentTick);
    const newCenterPrice = tickRangeCenterPrice(newTickLower, newTickUpper);

    // Swap fee cost (Type A): the pool fee paid on the swap itself
    // swapAmount * poolFeeRate (feeTier is in the pool state)
    const poolFeeTier = preStatus.pool.fee; // e.g. 2500 = 0.25% → divide by 1e6
    let swapFeeCostUsd: number | undefined;
    if (prices && swapDetails) {
      const dIn = swapDetails.tokenIn === 'token0' ? d0 : d1;
      const pIn = swapDetails.tokenIn === 'token0' ? priceUsd0 : priceUsd1;
      const swapValueUsd = bigintToFloat(swapDetails.amountIn, dIn) * pIn;
      swapFeeCostUsd = swapValueUsd * (poolFeeTier / 1_000_000);
    }

    // Swap friction (existing field) = total value lost in swap (pool fee + price impact + routing)
    const swapFrictionUsdValue: number | undefined = prices && swapDetails ? (() => {
      const dIn = swapDetails.tokenIn === 'token0' ? d0 : d1;
      const dOut = swapDetails.tokenIn === 'token0' ? d1 : d0;
      const pIn = swapDetails.tokenIn === 'token0' ? priceUsd0 : priceUsd1;
      const pOut = swapDetails.tokenIn === 'token0' ? priceUsd1 : priceUsd0;
      const valueIn = bigintToFloat(swapDetails.amountIn, dIn) * pIn;
      const valueOut = bigintToFloat(swapDetails.amountOut, dOut) * pOut;
      return Math.max(0, valueIn - valueOut);
    })() : undefined;

    // Price impact = swap friction - swap fee (residual)
    const priceImpactCostUsd =
      swapFrictionUsdValue !== undefined && swapFeeCostUsd !== undefined
        ? Math.max(0, swapFrictionUsdValue - swapFeeCostUsd)
        : undefined;

    const gasCostUsd = prices ? totalGasCostPLS * prices.nativePriceUsd : undefined;

    // Type A: gas + swap fee. Type B: price impact (slippage is captured in swapFrictionUsd)
    const totalTypeACostUsd =
      gasCostUsd !== undefined && swapFeeCostUsd !== undefined
        ? gasCostUsd + swapFeeCostUsd
        : gasCostUsd;
    const totalTypeBCostUsd = priceImpactCostUsd;

    // IL crystallization in USD
    // impermanentLossPercent is computed in metrics (after analytics is built), so we store formula
    // We'll fill crystallizedIlUsd after metrics are calculated below

    const dustUsdValue: number | undefined = prices ? (
      bigintToFloat(dust.amount0, d0) * priceUsd0 +
      bigintToFloat(dust.amount1, d1) * priceUsd1
    ) : undefined;

    const analytics: RebalanceAnalytics = {
      timestamp: Date.now(),
      rebalanceId: rebalanceId ?? randomUUID(),
      chainId,
      dex,
      blockNumber: result.newPosition?.blockNumber,
      oldTokenId: result.oldTokenId,
      newTokenId: result.newTokenId!,
      strategy,
      preSnapshot,
      postSnapshot,
      txHashes,
      feesCollected0: result.feesCollected.amount0,
      feesCollected1: result.feesCollected.amount1,
      liquidityRemoved0: result.liquidityRemoved.amount0,
      liquidityRemoved1: result.liquidityRemoved.amount1,
      swap: swapDetails,
      newLiquidity: result.newPosition?.liquidity ?? 0n,
      newAmount0: result.newPosition?.amount0 ?? 0n,
      newAmount1: result.newPosition?.amount1 ?? 0n,
      newTickLower,
      newTickUpper,
      gasUsed,
      gasPrice,
      totalGasCostPLS,
      nativeTokenPriceUsd: prices?.nativePriceUsd,
      priceUsd0: priceUsd0 || undefined,
      priceUsd1: priceUsd1 || undefined,
      // Pre-computed USD values — historically accurate, never recalculated
      feesCollectedUsd: prices ? (
        bigintToFloat(result.feesCollected.amount0, d0) * priceUsd0 +
        bigintToFloat(result.feesCollected.amount1, d1) * priceUsd1
      ) : undefined,
      gasCostUsd,
      swapFrictionUsd: swapFrictionUsdValue,
      swapFeeCostUsd,
      priceImpactCostUsd,
      totalTypeACostUsd,
      totalTypeBCostUsd,
      dust0: dust.amount0,
      dust1: dust.amount1,
      dustUsd: dustUsdValue,
      // Range metadata
      oldWidthPct,
      oldCenterPrice,
      newWidthPct,
      newCenterPrice,
      priceSource: prices?.source,
      priceStatus: prices?.priceStatus ?? (prices ? 'live' : undefined),
      timestampMs: Date.now(),
      metrics: null as unknown as RebalanceAnalytics['metrics'], // calculated below
    };

    // Calculate metrics
    analytics.metrics = calculateRebalanceMetrics(analytics, previousTimestamp);

    // Post-metrics: IL crystallization USD + break-even estimates
    const ilPct = analytics.metrics.impermanentLossPercent;
    const posValueBefore = preSnapshot.positionValueUsd;
    if (posValueBefore > 0 && ilPct !== 0) {
      analytics.priceDisadvantageUsd = Math.abs(ilPct / 100) * posValueBefore;
      analytics.priceDisadvantagePct = Math.abs(ilPct);
      analytics.crystallizedIlUsd = analytics.priceDisadvantageUsd;
      const totalRebalanceCost = (gasCostUsd ?? 0) + (swapFrictionUsdValue ?? 0) + (dustUsdValue ?? 0);
      analytics.totalLossUsd = analytics.priceDisadvantageUsd + totalRebalanceCost;
      analytics.totalLossPct = (analytics.totalLossUsd / posValueBefore) * 100;

      // Break-even: use post-rebalance feeAPR if available
      const newApr = analytics.metrics.feeAPR;
      if (newApr > 0) {
        analytics.estimatedNewAprPct = newApr;
        analytics.estimatedBreakEvenDays = (analytics.totalLossPct / newApr) * 365;
        // Calendar days = break-even days / estimated time-in-range fraction
        const tirFraction = (analytics.metrics.timeInRangePercent ?? 100) / 100;
        if (tirFraction > 0) {
          analytics.estimatedBreakEvenCalendarDays = analytics.estimatedBreakEvenDays / tirFraction;
        }
      }
    }

    // Update cache
    updateRebalanceCache(analytics);

    // Persist to disk
    if (this.persistToDisk) {
      const writePath = chainId !== undefined ? this.getChainStoragePath(chainId) : this.storagePath;
      await ensureStorageDir(writePath);
      
      // 1. Write to dedicated lightweight rebalance history (CRITICAL for chain)
      // Import dynamically to avoid circular dependencies if any
      const { writeRebalanceRecord, writeAnalyticsRecord } = await import('./storage.js');
      await writeRebalanceRecord(writePath, analytics);

      // 2. Also write to daily log for full chronological backup (optional but good)
      const rebalanceWriteResult = await writeAnalyticsRecord(
        { type: 'rebalance', timestamp: analytics.timestamp, data: analytics },
        writePath,
      );

      // 3. Write position entry record for cost basis tracking
      const d0 = postStatus.token0Info.decimals;
      const d1 = postStatus.token1Info.decimals;
      const entryPrice0 = prices?.priceUsd0 ?? 0;
      const entryPrice1 = prices?.priceUsd1 ?? 0;
      const entryAmount0 = analytics.newAmount0;
      const entryAmount1 = analytics.newAmount1;
      const entryCostUsd =
        bigintToFloat(entryAmount0, d0) * entryPrice0 +
        bigintToFloat(entryAmount1, d1) * entryPrice1;
      const entryGasCostUsd = analytics.totalGasCostPLS * (prices?.nativePriceUsd ?? 0);

      const entryRecord: PositionEntryRecord = {
        timestamp: analytics.timestamp,
        tokenId: analytics.newTokenId,
        dex,
        blockNumber: result.newPosition?.blockNumber,
        txHash: analytics.txHashes.mint,
        amount0: entryAmount0,
        amount1: entryAmount1,
        priceUsd0: entryPrice0,
        priceUsd1: entryPrice1,
        nativePriceUsd: prices?.nativePriceUsd ?? 0,
        entryCostUsd,
        gasCostUsd: entryGasCostUsd,
        source: 'rebalance',
        fromTokenId: analytics.oldTokenId,
        token0Symbol: postStatus.token0Info.symbol,
        token1Symbol: postStatus.token1Info.symbol,
        token0Decimals: d0,
        token1Decimals: d1,
        tickLower: analytics.newTickLower,
        tickUpper: analytics.newTickUpper,
        chainId,
        priceSource: prices?.source ?? 'unavailable',
        priceStatus: prices?.priceStatus ?? (prices ? 'live' : 'pending'),
      };

      const entryWriteResult = await writeAnalyticsRecord(
        { type: 'position_entry', timestamp: entryRecord.timestamp, data: entryRecord },
        writePath,
      );

      // If prices were pending, enqueue both rebalance and entry records for backfill
      if (prices?.priceStatus === 'pending' || !prices) {
        const token0Addr = preStatus.pool.token0;
        const token1Addr = preStatus.pool.token1;
        const nativeAddr = prices?.nativeWrappedAddress ?? '';
        const chainSlug = prices?.chainSlug
          ?? (chainId !== undefined ? (CHAIN_REGISTRY[chainId]?.dexScreenerSlug ?? 'pulsechain') : 'pulsechain');

        // Enqueue the rebalance daily log record for backfill
        if (rebalanceWriteResult) {
          enqueuePendingPrice({
            filePath: rebalanceWriteResult.filePath,
            lineIndex: rebalanceWriteResult.lineIndex,
            recordType: 'rebalance',
            tokenId: analytics.oldTokenId,
            eventTimestamp: analytics.timestamp,
            token0Address: token0Addr,
            token1Address: token1Addr,
            nativeWrappedAddress: nativeAddr,
            chainSlug,
            chainId,
            dex,
          });
        }

        // Enqueue the position entry record for backfill
        if (entryWriteResult) {
          enqueuePendingPrice({
            filePath: entryWriteResult.filePath,
            lineIndex: entryWriteResult.lineIndex,
            recordType: 'position_entry',
            tokenId: analytics.newTokenId,
            eventTimestamp: analytics.timestamp,
            token0Address: token0Addr,
            token1Address: token1Addr,
            nativeWrappedAddress: nativeAddr,
            chainSlug,
            chainId,
            dex,
          });
        }
      }
    }

    logger.info(`Analytics captured for rebalance ${analytics.rebalanceId}`, {
      oldTokenId: analytics.oldTokenId,
      newTokenId: analytics.newTokenId,
      gasCostPLS: analytics.totalGasCostPLS.toFixed(4),
      feeAPR: analytics.metrics.feeAPR.toFixed(2) + '%',
      netROI: analytics.metrics.netROIPercent.toFixed(2) + '%',
    });

    return analytics;
  }
}

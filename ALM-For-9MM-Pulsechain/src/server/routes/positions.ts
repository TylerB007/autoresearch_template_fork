/**
 * Positions routes — CRUD for position configs + live blockchain status
 */

import { Router, type Request, type Response } from 'express';
import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import type { ContractInstances } from '../../contracts.js';
import type { ChainContext } from '../../chain.js';
import type { AppConfig, StrategyType } from '../../types.js';
import type { MultiChainContext } from '../../multiChain.js';
import { reloadPositions } from '../../configLoader.js';
import { getPositionStatus } from '../../position.js';
import { getTokenPrices } from '../services/priceService.js';
import { writeAnalyticsRecord, querySnapshots as queryPositionSnapshots, chainStoragePath } from '../../analytics/storage.js';
import { calculateTickVolatility } from '../../analytics/volatility.js';
import { GAS_LIMITS } from '../../config/index.js';
import { bigintToFloat } from '../../bigintFloat.js';
import { sendNotification } from '../../notifications.js';
import { getMintTimestamp, formatAge, calculateLifetimeAPR } from '../../mintDate.js';
import { queryFeeCollections, queryRebalances } from '../../analytics/storage.js';
import { getAmountsForLiquidity, tickToSqrtPriceX96, nearestUsableTick, ticksToPercentage, calculateSwapAmount, getLiquidityForAmounts } from '../../math.js';
import { getTickSpacing } from '../../config/fees.js';
import { CHAIN_REGISTRY } from '../../config/chains.js';
import { evaluateStrategy, PRESET_WIDTH_REGEX, parseStrategy } from '../../strategy.js';
import { checkAndRebalance, isRebalanceLocked, acquireRebalanceLock, releaseRebalanceLock, isSafeMode, posKey, increaseLiquidity, decreasePositionLiquidity } from '../../rebalancer.js';
import { executeSwap } from '../../swap.js';
import { getPoolState } from '../../pool.js';
import { isKillSwitchTriggered } from '../../killSwitch.js';
import logger from '../../logger.js';

/**
 * Compute the new range the strategy would create if price were at `edgeTick`.
 * Mirrors the logic in src/strategy.ts so cost estimates reflect actual rebalance behavior.
 */
function computeNewRangeForEdge(
  edgeTick: number,
  strategy: string,
  widthTicks: number,
  tickSpacing: number,
  lowerRatioPercent?: number,
): { newTickLower: number; newTickUpper: number } {
  // Parse strategy name: "pulse_300" or "center_3pct" -> base + presetWidth
  const parsed = parseStrategy(strategy);
  const width = parsed.presetWidth ?? widthTicks;

  // Resolve aliases: bullish → snuggle_up, bearish → snuggle_down
  const ALIAS_MAP: Record<string, string> = { center: 'pulse', bullish: 'snuggle_up', bearish: 'snuggle_down', lazy_up: 'lazy_ascending', lazy_down: 'lazy_descending' };
  const base = ALIAS_MAP[parsed.base] ?? parsed.base;

  switch (base) {
    case 'snuggle_up': {
      const lowerRatio = lowerRatioPercent ?? 30;
      const lowerWidth = Math.floor((width * lowerRatio) / 100);
      const upperWidth = width - lowerWidth;
      return {
        newTickLower: nearestUsableTick(edgeTick - lowerWidth, tickSpacing),
        newTickUpper: nearestUsableTick(edgeTick + upperWidth, tickSpacing),
      };
    }
    case 'snuggle_down': {
      const upperRatio = lowerRatioPercent ?? 30;
      const upperWidth = Math.floor((width * upperRatio) / 100);
      const lowerWidth = width - upperWidth;
      return {
        newTickLower: nearestUsableTick(edgeTick - lowerWidth, tickSpacing),
        newTickUpper: nearestUsableTick(edgeTick + upperWidth, tickSpacing),
      };
    }
    default: {
      // pulse, lazy_ascending, lazy_descending, static — all centered
      const halfWidth = Math.floor(width / 2);
      return {
        newTickLower: nearestUsableTick(edgeTick - halfWidth, tickSpacing),
        newTickUpper: nearestUsableTick(edgeTick + halfWidth, tickSpacing),
      };
    }
  }
}

/**
 * Estimate the raw swap amount (no fee inflation) needed to enter a new range.
 * Computes the target token0/token1 value ratio from the new range, then
 * determines how much of the one-sided holdings must be swapped.
 */
function estimateSwapForNewRange(
  amount0: bigint,
  amount1: bigint,
  currentTick: number,
  newTickLower: number,
  newTickUpper: number,
  decimals0: number,
  decimals1: number,
  priceUsd0: number,
  priceUsd1: number,
): { tokenIn: 'token0' | 'token1'; swapAmountUsd: number; swapPct: number } {
  // Total position value in USD
  const value0Usd = (Number(amount0) / 10 ** decimals0) * priceUsd0;
  const value1Usd = (Number(amount1) / 10 ** decimals1) * priceUsd1;
  const totalValueUsd = value0Usd + value1Usd;

  if (totalValueUsd <= 0) {
    return { tokenIn: 'token0', swapAmountUsd: 0, swapPct: 0 };
  }

  // Get the target token ratio for the new range at currentTick price
  const sqrtPriceX96 = tickToSqrtPriceX96(currentTick);
  const sqrtPriceAX96 = tickToSqrtPriceX96(newTickLower);
  const sqrtPriceBX96 = tickToSqrtPriceX96(newTickUpper);

  // Use large reference liquidity to get precise target amounts
  const refLiquidity = 1n << 96n;
  const target = getAmountsForLiquidity(sqrtPriceX96, sqrtPriceAX96, sqrtPriceBX96, refLiquidity);

  // Convert target amounts to a value ratio using USD prices
  const targetValue0 = (Number(target.amount0) / 10 ** decimals0) * priceUsd0;
  const targetValue1 = (Number(target.amount1) / 10 ** decimals1) * priceUsd1;
  const targetTotal = targetValue0 + targetValue1;

  if (targetTotal <= 0) {
    // Entirely one-sided target — swap all of the other token
    if (target.amount0 === 0n) return { tokenIn: 'token0', swapAmountUsd: value0Usd, swapPct: totalValueUsd > 0 ? (value0Usd / totalValueUsd) * 100 : 0 };
    return { tokenIn: 'token1', swapAmountUsd: value1Usd, swapPct: totalValueUsd > 0 ? (value1Usd / totalValueUsd) * 100 : 0 };
  }

  // Target fraction of total value that should be token0
  const targetFrac0 = targetValue0 / targetTotal;
  // Current fraction that IS token0
  const currentFrac0 = value0Usd / totalValueUsd;

  if (currentFrac0 > targetFrac0) {
    // Have too much token0, sell some
    const excessUsd = (currentFrac0 - targetFrac0) * totalValueUsd;
    return { tokenIn: 'token0', swapAmountUsd: excessUsd, swapPct: (excessUsd / totalValueUsd) * 100 };
  } else {
    // Have too much token1, sell some
    const excessUsd = (targetFrac0 - currentFrac0) * totalValueUsd;
    return { tokenIn: 'token1', swapAmountUsd: excessUsd, swapPct: (excessUsd / totalValueUsd) * 100 };
  }
}

/** Base strategy names (without preset width suffix). Includes new + legacy names. */
const VALID_BASE_STRATEGIES: string[] = [
  // New descriptive names
  'center', 'bullish', 'bearish', 'lazy_up', 'lazy_down',
  // Legacy names (backward compat)
  'pulse', 'snuggle_up', 'snuggle_down', 'lazy_ascending', 'lazy_descending',
  // Passive
  'static',
];

/** Validate a strategy string: must be a known base name, optionally with a preset suffix (_300, _3pct, etc.). */
function isValidStrategy(strategy: string): boolean {
  const match = strategy.match(PRESET_WIDTH_REGEX);
  if (match) {
    const base = strategy.replace(/_\d+(pct)?$/, '');
    return VALID_BASE_STRATEGIES.includes(base);
  }
  return VALID_BASE_STRATEGIES.includes(strategy);
}

const bigIntReplacer = (_key: string, value: unknown): unknown =>
  typeof value === 'bigint' ? value.toString() : value;

function getConfigPath(): string {
  return resolve(process.cwd(), 'config.yaml');
}

function readRawConfig(): Record<string, unknown> {
  const yamlPath = getConfigPath();
  const content = readFileSync(yamlPath, 'utf-8');
  return parseYaml(content) as Record<string, unknown>;
}

function writeRawConfig(raw: Record<string, unknown>): void {
  const yamlPath = getConfigPath();
  const dir = dirname(yamlPath);
  const tempPath = resolve(dir, '.config.yaml.tmp');
  const yamlStr = stringifyYaml(raw, { lineWidth: 120 });
  writeFileSync(tempPath, yamlStr, 'utf-8');
  renameSync(tempPath, yamlPath);
}

export function createPositionsRouter(
  config: AppConfig,
  chain: ChainContext,
  contracts: ContractInstances,
  multiChain?: MultiChainContext,
): Router {
  const router = Router();

  /** Resolve chain context + contracts for a position (multi-chain aware) */
  function resolveForPos(pos: { chain_id?: number; dex?: string }): { posChain: ChainContext; posContracts: ContractInstances } {
    if (multiChain) {
      const cid = pos.chain_id ?? multiChain.defaultChainId;
      return {
        posChain: multiChain.getChainById(cid),
        posContracts: multiChain.getContracts(pos as import('../../types.js').PositionConfig),
      };
    }
    return { posChain: chain, posContracts: contracts };
  }

  // GET /api/positions — list all positions with live status
  router.get('/', async (_req: Request, res: Response) => {
    try {
      // Re-read positions from config.yaml so dashboard stays in sync with Telegram/rebalancer changes
      reloadPositions(config);

      const positions = [];
      for (const pos of config.positions) {
        try {
          const { posChain, posContracts } = resolveForPos(pos);
          const status = await getPositionStatus(pos.token_id, posContracts, posChain);
          const posChainId = pos.chain_id ?? (multiChain?.defaultChainId ?? config.chain.chainId);
          const pk = posKey(posChainId, pos.token_id);
          positions.push({
            token_id: pos.token_id,
            chainId: posChainId,
            pair: `${status.token0Info.symbol}/${status.token1Info.symbol}`,
            strategy: pos.strategy,
            width_ticks: pos.params.width_ticks,
            trigger_distance_ticks: pos.params.trigger_distance_ticks,
            width_percentage: pos.params.width_ticks > 0 ? +ticksToPercentage(pos.params.width_ticks).toFixed(1) : 0,
            trigger_percentage: pos.params.trigger_distance_ticks > 0 ? +ticksToPercentage(pos.params.trigger_distance_ticks).toFixed(2) : 0,
            status: status.isInRange ? 'in_range' : 'out_of_range',
            inRange: status.isInRange,
            currentTick: status.pool.currentTick,
            tickLower: status.position.tickLower,
            tickUpper: status.position.tickUpper,
            amount0: status.amount0.toString(),
            amount1: status.amount1.toString(),
            token0Symbol: status.token0Info.symbol,
            token1Symbol: status.token1Info.symbol,
            token0Decimals: status.token0Info.decimals,
            token1Decimals: status.token1Info.decimals,
            feesOwed0: status.unclaimedFees0.toString(),
            feesOwed1: status.unclaimedFees1.toString(),
            gauge_address: pos.gauge_address,
            inSafeMode: isSafeMode(pk),
            killSwitchTriggered: isKillSwitchTriggered(pk),
            rebalanceLocked: isRebalanceLocked(posChainId, pos.token_id),
          });
        } catch (err) {
          positions.push({
            token_id: pos.token_id,
            pair: 'Unknown',
            strategy: pos.strategy,
            width_ticks: pos.params.width_ticks,
            trigger_distance_ticks: pos.params.trigger_distance_ticks,
            width_percentage: pos.params.width_ticks > 0 ? +ticksToPercentage(pos.params.width_ticks).toFixed(1) : 0,
            trigger_percentage: pos.params.trigger_distance_ticks > 0 ? +ticksToPercentage(pos.params.trigger_distance_ticks).toFixed(2) : 0,
            status: 'error',
            inRange: false,
            currentTick: 0,
            tickLower: 0,
            tickUpper: 0,
            amount0: '0',
            amount1: '0',
            token0Symbol: '?',
            token1Symbol: '?',
          });
        }
      }

      res.json(JSON.parse(JSON.stringify(positions, bigIntReplacer)));
    } catch (err) {
      logger.error('List positions error', { error: err instanceof Error ? err.message : String(err) });
      res.status(500).json({ error: 'Failed to fetch positions' });
    }
  });

  // GET /api/positions/:tokenId/status — detailed live status for one position
  router.get('/:tokenId/status', async (req: Request, res: Response) => {
    try {
      // Re-read positions from config.yaml so dashboard stays in sync
      reloadPositions(config);

      const tokenId = parseInt(req.params.tokenId as string, 10);
      if (isNaN(tokenId) || tokenId <= 0) {
        res.status(400).json({ error: 'Invalid tokenId — must be a positive integer' });
        return;
      }

      const posConfig = config.positions.find((p) => p.token_id === tokenId);
      if (!posConfig) {
        res.status(404).json({ error: `Position ${tokenId} not found in config` });
        return;
      }

      const { posChain, posContracts } = resolveForPos(posConfig);
      const chainId = posConfig.chain_id ?? config.chain.chainId;
      const chainEntry = CHAIN_REGISTRY[chainId];
      const chainSlug = chainEntry?.dexScreenerSlug ?? config.chain.dexScreenerSlug;
      const status = await getPositionStatus(tokenId, posContracts, posChain);

      // Fetch USD prices for both tokens
      const prices = await getTokenPrices([status.token0Info.address, status.token1Info.address], chainSlug);
      const priceUsd0 = prices.get(status.token0Info.address.toLowerCase()) ?? 0;
      const priceUsd1 = prices.get(status.token1Info.address.toLowerCase()) ?? 0;

      // Fetch mint date (cached after first lookup)
      const mintTimestamp = await getMintTimestamp(tokenId, posContracts, posChain);

      // Calculate position value and age
      const d0 = status.token0Info.decimals;
      const d1 = status.token1Info.decimals;
      const positionValueUsd =
        (Number(status.amount0) / 10 ** d0) * priceUsd0 +
        (Number(status.amount1) / 10 ** d1) * priceUsd1;

      // Current unclaimed fees in USD
      const unclaimedFeesUsd =
        (Number(status.unclaimedFees0) / 10 ** d0) * priceUsd0 +
        (Number(status.unclaimedFees1) / 10 ** d1) * priceUsd1;

      // Fetch claimed fees from analytics (rebalance fees + manual collections)
      let claimedFeesUsd = 0;
      try {
        const storagePath = chainStoragePath(config.analytics?.storage_path ?? './analytics', chainId);
        const [rebalances, feeCollections] = await Promise.all([
          queryRebalances(storagePath),
          queryFeeCollections(storagePath, tokenId),
        ]);
        // Rebalance-collected fees for this position
        for (const rb of rebalances.filter(r => r.oldTokenId === tokenId || r.newTokenId === tokenId)) {
          const rd0 = rb.preSnapshot.token0Decimals;
          const rd1 = rb.preSnapshot.token1Decimals;
          claimedFeesUsd +=
            (Number(rb.feesCollected0) / 10 ** rd0) * priceUsd0 +
            (Number(rb.feesCollected1) / 10 ** rd1) * priceUsd1;
        }
        // Manual fee collections
        for (const fc of feeCollections) {
          claimedFeesUsd += fc.totalValueUsd;
        }
      } catch {
        // Analytics unavailable — continue with unclaimed fees only
      }

      const totalFeesUsd = claimedFeesUsd + unclaimedFeesUsd;
      const ageMs = mintTimestamp ? Date.now() - mintTimestamp : 0;
      const lifetimeAPR = calculateLifetimeAPR(totalFeesUsd, positionValueUsd, ageMs);

      // === Rebalance cost estimates at each range edge ===
      // Gas cost: collect + decreaseLiquidity + collect + burn + approve + swap + mint
      const totalGasUnits = GAS_LIMITS.COLLECT + GAS_LIMITS.BURN + GAS_LIMITS.COLLECT
        + GAS_LIMITS.BURN + GAS_LIMITS.APPROVE + GAS_LIMITS.SWAP + GAS_LIMITS.MINT;
      // Use current gas price from the chain
      let gasPriceWei = 0n;
      let plsPriceUsd = 0;
      try {
        const feeData = await posChain.provider.getFeeData();
        gasPriceWei = feeData.gasPrice ?? 0n;
        const wrappedNativeAddress = chainEntry?.wrappedNativeAddress;
        if (wrappedNativeAddress) {
          const nativePrices = await getTokenPrices([wrappedNativeAddress], chainSlug);
          plsPriceUsd = nativePrices.get(wrappedNativeAddress.toLowerCase()) ?? 0;
        }
      } catch { /* gas estimate unavailable */ }
      const gasCostPLS = Number(gasPriceWei * BigInt(totalGasUnits)) / 1e18;
      const gasCostUsd = gasCostPLS * plsPriceUsd;

      // Estimate slippage cost at each edge
      // When price hits the lower tick: position is 100% token0, needs swap to balanced ratio for NEW range
      // When price hits the upper tick: position is 100% token1, needs swap to balanced ratio for NEW range
      const fee = status.position.fee;
      const { tickLower, tickUpper } = status.position;
      const liquidity = status.position.liquidity;
      const sqrtPriceLower = tickToSqrtPriceX96(tickLower);
      const sqrtPriceUpper = tickToSqrtPriceX96(tickUpper);
      const tickSpacing = getTickSpacing(fee);

      // At lower edge: all value in token0
      const amountsAtLower = getAmountsForLiquidity(sqrtPriceLower, sqrtPriceLower, sqrtPriceUpper, liquidity);
      // At upper edge: all value in token1
      const amountsAtUpper = getAmountsForLiquidity(sqrtPriceUpper, sqrtPriceLower, sqrtPriceUpper, liquidity);

      // Compute the NEW range the strategy would create at each edge (centered on edge tick)
      const lowerNewRange = computeNewRangeForEdge(
        tickLower, posConfig.strategy, posConfig.params.width_ticks, tickSpacing, posConfig.params.lower_ratio_percent,
      );
      const upperNewRange = computeNewRangeForEdge(
        tickUpper, posConfig.strategy, posConfig.params.width_ticks, tickSpacing, posConfig.params.lower_ratio_percent,
      );

      // Estimate raw swap amounts by computing the target token ratio for each new range.
      // Uses getAmountsForLiquidity with a reference liquidity to determine what fraction
      // of value should be token0 vs token1, then computes the swap needed from the
      // one-sided holdings. No fee inflation — this is a cost *estimate*.
      const lowerSwapEstimate = estimateSwapForNewRange(
        amountsAtLower.amount0, amountsAtLower.amount1,
        tickLower, lowerNewRange.newTickLower, lowerNewRange.newTickUpper,
        d0, d1, priceUsd0, priceUsd1,
      );
      const upperSwapEstimate = estimateSwapForNewRange(
        amountsAtUpper.amount0, amountsAtUpper.amount1,
        tickUpper, upperNewRange.newTickLower, upperNewRange.newTickUpper,
        d0, d1, priceUsd0, priceUsd1,
      );

      // Combined slippage rate: pool fee + slippage tolerance (default 50 bps = 0.50%)
      const slippageBps = 50; // 0.50% combined default
      const lowerSlippageCostUsd = lowerSwapEstimate.swapAmountUsd * (slippageBps / 10000);
      const upperSlippageCostUsd = upperSwapEstimate.swapAmountUsd * (slippageBps / 10000);

      // Total rebalance cost at each edge = gas + slippage
      const lowerRebalanceCostUsd = gasCostUsd + lowerSlippageCostUsd;
      const upperRebalanceCostUsd = gasCostUsd + upperSlippageCostUsd;

      // Break-even time: how long in range to earn back rebalance cost at current APR
      // hourlyIncome = positionValueUsd * (lifetimeAPR / 100) / 8760
      const hourlyIncomeUsd = positionValueUsd > 0 && lifetimeAPR > 0
        ? positionValueUsd * (lifetimeAPR / 100) / 8760
        : 0;

      const lowerBreakEvenHours = hourlyIncomeUsd > 0 ? lowerRebalanceCostUsd / hourlyIncomeUsd : 0;
      const upperBreakEvenHours = hourlyIncomeUsd > 0 ? upperRebalanceCostUsd / hourlyIncomeUsd : 0;

      // Critical distance break-even (only if critical_distance_ticks is configured)
      const criticalTicks = posConfig?.params.critical_distance_ticks;
      let criticalBreakEven: { lowerBreakEvenHours: number; upperBreakEvenHours: number; distanceTicks: number } | undefined;
      if (criticalTicks !== undefined && criticalTicks > 0 && liquidity > 0n) {
        try {
          // Clamp simulated ticks to V3 min/max
          const criticalLowerTick = Math.max(tickLower - criticalTicks, -887272);
          const criticalUpperTick = Math.min(tickUpper + criticalTicks, 887272);

          // At critical lower: position is 100% token0 (even further beyond edge)
          const sqrtPriceCritLower = tickToSqrtPriceX96(criticalLowerTick);
          const amountsAtCritLower = getAmountsForLiquidity(sqrtPriceCritLower, sqrtPriceLower, sqrtPriceUpper, liquidity);
          // At critical upper: position is 100% token1
          const sqrtPriceCritUpper = tickToSqrtPriceX96(criticalUpperTick);
          const amountsAtCritUpper = getAmountsForLiquidity(sqrtPriceCritUpper, sqrtPriceLower, sqrtPriceUpper, liquidity);

          const critLowerNewRange = computeNewRangeForEdge(
            criticalLowerTick, posConfig.strategy, posConfig.params.width_ticks, tickSpacing, posConfig.params.lower_ratio_percent,
          );
          const critUpperNewRange = computeNewRangeForEdge(
            criticalUpperTick, posConfig.strategy, posConfig.params.width_ticks, tickSpacing, posConfig.params.lower_ratio_percent,
          );

          const critLowerSwap = estimateSwapForNewRange(
            amountsAtCritLower.amount0, amountsAtCritLower.amount1,
            criticalLowerTick, critLowerNewRange.newTickLower, critLowerNewRange.newTickUpper,
            d0, d1, priceUsd0, priceUsd1,
          );
          const critUpperSwap = estimateSwapForNewRange(
            amountsAtCritUpper.amount0, amountsAtCritUpper.amount1,
            criticalUpperTick, critUpperNewRange.newTickLower, critUpperNewRange.newTickUpper,
            d0, d1, priceUsd0, priceUsd1,
          );

          const critLowerCostUsd = gasCostUsd + critLowerSwap.swapAmountUsd * (slippageBps / 10000);
          const critUpperCostUsd = gasCostUsd + critUpperSwap.swapAmountUsd * (slippageBps / 10000);

          criticalBreakEven = {
            lowerBreakEvenHours: hourlyIncomeUsd > 0 ? critLowerCostUsd / hourlyIncomeUsd : 0,
            upperBreakEvenHours: hourlyIncomeUsd > 0 ? critUpperCostUsd / hourlyIncomeUsd : 0,
            distanceTicks: criticalTicks,
          };
        } catch { /* non-fatal — critical break-even just won't be included */ }
      }

      // Volatility from recent snapshots
      let volatility: { stdDev: number; regime: string; avgTickChange: number } | null = null;
      try {
        const volStoragePath = config.analytics?.storage_path ?? './analytics';
        const recentSnaps = await queryPositionSnapshots(
          volStoragePath, tokenId,
          Date.now() - 60 * 60 * 1000,
        );
        if (recentSnaps.length >= 2) {
          const vol = calculateTickVolatility(recentSnaps, 60);
          volatility = { stdDev: vol.stdDev, regime: vol.regime, avgTickChange: vol.avgTickChange };
        }
      } catch { /* non-fatal */ }

      const response = {
        token_id: tokenId,
        pair: `${status.token0Info.symbol}/${status.token1Info.symbol}`,
        strategy: posConfig.strategy,
        width_ticks: posConfig.params.width_ticks,
        trigger_distance_ticks: posConfig.params.trigger_distance_ticks,
        status: status.isInRange ? 'in_range' : 'out_of_range',
        inRange: status.isInRange,
        currentTick: status.pool.currentTick,
        tickLower: status.position.tickLower,
        tickUpper: status.position.tickUpper,
        amount0: status.amount0.toString(),
        amount1: status.amount1.toString(),
        token0Symbol: status.token0Info.symbol,
        token1Symbol: status.token1Info.symbol,
        token0Decimals: status.token0Info.decimals,
        token1Decimals: status.token1Info.decimals,
        feesOwed0: status.unclaimedFees0.toString(),
        feesOwed1: status.unclaimedFees1.toString(),
        priceUsd0,
        priceUsd1,
        mintTimestamp,
        age: ageMs > 0 ? formatAge(ageMs) : null,
        positionValueUsd,
        claimedFeesUsd,
        unclaimedFeesUsd,
        totalFeesUsd,
        lifetimeAPR,
        volatility,
        gauge_address: posConfig.gauge_address,
        rebalanceCosts: {
          gasCostUsd,
          gasCostPLS,
          totalGasUnits,
          slippageBps,
          hourlyIncomeUsd,
          lower: {
            swapAmountUsd: lowerSwapEstimate.swapAmountUsd,
            swapTokenIn: lowerSwapEstimate.tokenIn,
            swapTokenInSymbol: lowerSwapEstimate.tokenIn === 'token0' ? status.token0Info.symbol : status.token1Info.symbol,
            swapPct: lowerSwapEstimate.swapPct,
            slippageCostUsd: lowerSlippageCostUsd,
            totalCostUsd: lowerRebalanceCostUsd,
            breakEvenHours: lowerBreakEvenHours,
          },
          upper: {
            swapAmountUsd: upperSwapEstimate.swapAmountUsd,
            swapTokenIn: upperSwapEstimate.tokenIn,
            swapTokenInSymbol: upperSwapEstimate.tokenIn === 'token0' ? status.token0Info.symbol : status.token1Info.symbol,
            swapPct: upperSwapEstimate.swapPct,
            slippageCostUsd: upperSlippageCostUsd,
            totalCostUsd: upperRebalanceCostUsd,
            breakEvenHours: upperBreakEvenHours,
          },
          ...(criticalBreakEven && { critical: criticalBreakEven }),
        },
      };

      res.json(JSON.parse(JSON.stringify(response, bigIntReplacer)));
    } catch (err) {
      logger.error('Position status error', { error: err instanceof Error ? err.message : String(err) });
      res.status(500).json({ error: 'Failed to fetch position status' });
    }
  });

  // POST /api/positions — add a new position to config.yaml
  router.post('/', (req: Request, res: Response) => {
    try {
      const { token_id, strategy, params } = req.body as {
        token_id?: number;
        strategy?: string;
        params?: { width_ticks?: number; trigger_distance_ticks?: number };
      };

      // Validate token_id
      if (token_id === undefined || !Number.isInteger(token_id) || token_id <= 0) {
        res.status(400).json({ error: 'token_id must be a positive integer' });
        return;
      }

      // Validate strategy
      if (!strategy || !isValidStrategy(strategy)) {
        res.status(400).json({
          error: `strategy must be a valid base strategy (${VALID_BASE_STRATEGIES.join(', ')}) with optional _N or _Npct suffix`,
        });
        return;
      }

      // Validate params
      // Preset strategies (e.g., pulse_300, center_3pct) have width in the name, so width_ticks can be 0
      const hasPresetWidth = PRESET_WIDTH_REGEX.test(strategy);
      if (!params) {
        res.status(400).json({ error: 'params is required' });
        return;
      }
      if (!hasPresetWidth && (!params.width_ticks || params.width_ticks <= 0)) {
        res.status(400).json({ error: 'params.width_ticks must be a positive number for non-preset strategies' });
        return;
      }
      if (params.trigger_distance_ticks === undefined || params.trigger_distance_ticks < 0) {
        res.status(400).json({ error: 'params.trigger_distance_ticks must be non-negative' });
        return;
      }

      // Check for duplicates
      const existing = config.positions.find((p) => p.token_id === token_id);
      if (existing) {
        res.status(409).json({ error: `Position ${token_id} already exists in config` });
        return;
      }

      // Write to config.yaml atomically
      const raw = readRawConfig();
      const rawPositions = (raw.positions as Record<string, unknown>[]) ?? [];
      // Use 0 for preset strategies (width is in the strategy name), otherwise required
      const widthTicks = hasPresetWidth ? 0 : (params.width_ticks ?? 0);
      rawPositions.push({
        token_id,
        strategy,
        params: {
          width_ticks: widthTicks,
          trigger_distance_ticks: params.trigger_distance_ticks,
        },
      });
      raw.positions = rawPositions;
      writeRawConfig(raw);

      // Update in-memory config
      config.positions.push({
        token_id,
        strategy: strategy as StrategyType,
        params: {
          width_ticks: widthTicks,
          trigger_distance_ticks: params.trigger_distance_ticks,
        },
      });

      logger.info('Position added via API', { token_id, strategy });

      // Send Telegram confirmation
      const parsedStrat = parseStrategy(strategy);
      const widthInfo = parsedStrat.presetWidth !== null
        ? `(preset width: ~${ticksToPercentage(parsedStrat.presetWidth).toFixed(1)}%)`
        : `width: ${params.width_ticks} ticks (~${ticksToPercentage(params.width_ticks ?? 0).toFixed(1)}%)`;
      sendNotification(
        `✅ *Position Added via Dashboard*\n\n` +
          `• Token ID: #${token_id}\n` +
          `• Strategy: ${strategy}\n` +
          `• ${widthInfo}\n` +
          `• Trigger distance: ${params.trigger_distance_ticks} ticks\n\n` +
          `_Changes will apply on next rebalance_`,
        config,
        'info',
      ).catch((err) => logger.warn('Failed to send Telegram notification', { error: err }));

      res.status(201).json({
        message: `Position ${token_id} added`,
        position: { token_id, strategy, params },
      });
    } catch (err) {
      logger.error('Add position error', { error: err instanceof Error ? err.message : String(err) });
      res.status(500).json({ error: 'Failed to add position' });
    }
  });

  // PUT /api/positions/:tokenId — update strategy/params for existing position
  router.put('/:tokenId', (req: Request, res: Response) => {
    try {
      const tokenId = parseInt(req.params.tokenId as string, 10);
      if (isNaN(tokenId) || tokenId <= 0) {
        res.status(400).json({ error: 'Invalid tokenId — must be a positive integer' });
        return;
      }

      const posIndex = config.positions.findIndex((p) => p.token_id === tokenId);
      if (posIndex === -1) {
        res.status(404).json({ error: `Position ${tokenId} not found in config` });
        return;
      }

      const { strategy, params } = req.body as {
        strategy?: string;
        params?: { width_ticks?: number; trigger_distance_ticks?: number };
      };

      // Validate strategy if provided
      if (strategy !== undefined && !isValidStrategy(strategy)) {
        res.status(400).json({
          error: `strategy must be a valid base strategy (${VALID_BASE_STRATEGIES.join(', ')}) with optional _N or _Npct suffix`,
        });
        return;
      }

      // Validate params if provided
      if (params) {
        // Check if strategy (new or existing) has preset width
        const finalStrategy = strategy ?? config.positions[posIndex].strategy;
        const hasPresetWidth = PRESET_WIDTH_REGEX.test(finalStrategy);

        if (params.width_ticks !== undefined && !hasPresetWidth && params.width_ticks <= 0) {
          res.status(400).json({ error: 'params.width_ticks must be a positive number for non-preset strategies' });
          return;
        }
        if (params.trigger_distance_ticks !== undefined && params.trigger_distance_ticks < 0) {
          res.status(400).json({ error: 'params.trigger_distance_ticks must be non-negative' });
          return;
        }
      }

      // Update config.yaml atomically
      const raw = readRawConfig();
      const rawPositions = (raw.positions as Record<string, unknown>[]) ?? [];
      const rawPos = rawPositions.find(
        (p) => (p as Record<string, unknown>).token_id === tokenId,
      ) as Record<string, unknown> | undefined;

      if (!rawPos) {
        res.status(404).json({ error: `Position ${tokenId} not found in config file` });
        return;
      }

      if (strategy !== undefined) {
        rawPos.strategy = strategy;
        config.positions[posIndex].strategy = strategy as StrategyType;
      }

      if (params) {
        const rawParams = (rawPos.params as Record<string, unknown>) ?? {};
        if (params.width_ticks !== undefined) {
          rawParams.width_ticks = params.width_ticks;
          config.positions[posIndex].params.width_ticks = params.width_ticks;
        }
        if (params.trigger_distance_ticks !== undefined) {
          rawParams.trigger_distance_ticks = params.trigger_distance_ticks;
          config.positions[posIndex].params.trigger_distance_ticks = params.trigger_distance_ticks;
        }
        rawPos.params = rawParams;
      }

      raw.positions = rawPositions;
      writeRawConfig(raw);

      logger.info('Position updated via API', { token_id: tokenId, strategy, params });

      // Send Telegram confirmation
      const changes: string[] = [];
      if (strategy !== undefined) {
        const ps = parseStrategy(strategy);
        const widthInfo = ps.presetWidth !== null
          ? `(preset ~${ticksToPercentage(ps.presetWidth).toFixed(1)}%)`
          : '';
        changes.push(`• Strategy: ${strategy} ${widthInfo}`);
      }
      if (params?.width_ticks !== undefined) {
        changes.push(`• Width: ${params.width_ticks} ticks (~${ticksToPercentage(params.width_ticks).toFixed(1)}%)`);
      }
      if (params?.trigger_distance_ticks !== undefined) {
        changes.push(`• Trigger distance: ${params.trigger_distance_ticks} ticks (~${ticksToPercentage(params.trigger_distance_ticks).toFixed(2)}%)`);
      }

      sendNotification(
        `✏️ *Position Updated via Dashboard*\n\n` +
          `Position #${tokenId}:\n` +
          changes.join('\n') +
          `\n\n_Changes will apply on next rebalance_`,
        config,
        'info',
      ).catch((err) => logger.warn('Failed to send Telegram notification', { error: err }));

      res.json({
        message: `Position ${tokenId} updated`,
        position: config.positions[posIndex],
      });
    } catch (err) {
      logger.error('Update position error', { error: err instanceof Error ? err.message : String(err) });
      res.status(500).json({ error: 'Failed to update position' });
    }
  });

  // DELETE /api/positions/:tokenId — remove position from config.yaml
  router.delete('/:tokenId', (req: Request, res: Response) => {
    try {
      const tokenId = parseInt(req.params.tokenId as string, 10);
      if (isNaN(tokenId) || tokenId <= 0) {
        res.status(400).json({ error: 'Invalid tokenId — must be a positive integer' });
        return;
      }

      const posIndex = config.positions.findIndex((p) => p.token_id === tokenId);
      if (posIndex === -1) {
        res.status(404).json({ error: `Position ${tokenId} not found in config` });
        return;
      }

      // Update config.yaml atomically
      const raw = readRawConfig();
      const rawPositions = (raw.positions as Record<string, unknown>[]) ?? [];
      raw.positions = rawPositions.filter(
        (p) => (p as Record<string, unknown>).token_id !== tokenId,
      );
      writeRawConfig(raw);

      // Update in-memory config
      const removedPos = config.positions[posIndex];
      config.positions.splice(posIndex, 1);

      logger.info('Position removed via API', { token_id: tokenId });

      // Send Telegram confirmation
      sendNotification(
        `🗑️ *Position Removed via Dashboard*\n\n` +
          `• Token ID: #${tokenId}\n` +
          `• Strategy: ${removedPos.strategy}\n\n` +
          `_Position will no longer be monitored_`,
        config,
        'info',
      ).catch((err) => logger.warn('Failed to send Telegram notification', { error: err }));

      res.json({ message: `Position ${tokenId} removed` });
    } catch (err) {
      logger.error('Delete position error', { error: err instanceof Error ? err.message : String(err) });
      res.status(500).json({ error: 'Failed to delete position' });
    }
  });

  // POST /api/positions/:tokenId/collect — collect unclaimed fees
  const MAX_UINT128 = 2n ** 128n - 1n;
  router.post('/:tokenId/collect', async (req: Request, res: Response) => {
    try {
      const tokenId = parseInt(req.params.tokenId as string, 10);
      if (isNaN(tokenId) || tokenId <= 0) {
        res.status(400).json({ error: 'Invalid tokenId — must be a positive integer' });
        return;
      }

      const posConfig = config.positions.find((p) => p.token_id === tokenId);
      if (!posConfig) {
        res.status(404).json({ error: `Position ${tokenId} not found in config` });
        return;
      }

      if (config.dry_run) {
        res.status(403).json({ error: 'Cannot collect fees in DRY_RUN mode' });
        return;
      }

      // Guard: refuse if the bot process has an active rebalance on this position.
      // The bot and dashboard are separate PM2 processes with independent NonceTrackers —
      // concurrent on-chain txs race on nonce assignment and corrupt the multi-step flow.
      const collectLockChainId = posConfig.chain_id ?? config.chain.chainId;
      if (isRebalanceLocked(collectLockChainId, tokenId)) {
        res.status(409).json({
          error: `Position ${tokenId} is currently being rebalanced by the bot. Try again in a minute.`,
        });
        return;
      }

      // Acquire lock to prevent concurrent dashboard /collect requests from racing
      // on nonce assignment (two browser tabs, double-click, etc.).
      acquireRebalanceLock(collectLockChainId, tokenId);
      try {
        logger.info('Manual fee collection requested via dashboard', { token_id: tokenId });

        // Resolve per-position chain for on-chain calls
        const { posChain: collectChain, posContracts: collectContracts } = resolveForPos(posConfig);

        // Capture pre-collect fees for analytics
        const preStatus = await getPositionStatus(tokenId, collectContracts, collectChain);

        const nonce = await collectChain.nonceManager.getNextNonce();
        try {
          const tx = await collectContracts.positionManager.collect(
            {
              tokenId,
              recipient: collectChain.wallet.address,
              amount0Max: MAX_UINT128,
              amount1Max: MAX_UINT128,
            },
            { gasLimit: GAS_LIMITS.COLLECT, nonce },
          );
          const receipt = await tx.wait();
          collectChain.nonceManager.confirmNonce(nonce);

          const gasUsed = BigInt(receipt.gasUsed);
          const gasPrice = BigInt(receipt.gasPrice ?? 0n);
          logger.info('Fee collection successful', {
            token_id: tokenId,
            txHash: receipt.hash,
            gasUsed: gasUsed.toString(),
          });

          // Record fee collection to analytics
          try {
            const chainSlug = CHAIN_REGISTRY[collectLockChainId]?.dexScreenerSlug ?? config.chain.dexScreenerSlug;
            const prices = await getTokenPrices([preStatus.token0Info.address, preStatus.token1Info.address], chainSlug);
            const priceUsd0 = prices.get(preStatus.token0Info.address.toLowerCase()) ?? 0;
            const priceUsd1 = prices.get(preStatus.token1Info.address.toLowerCase()) ?? 0;
            const d0 = preStatus.token0Info.decimals;
            const d1 = preStatus.token1Info.decimals;
            const valueUsd0 = bigintToFloat(preStatus.unclaimedFees0, d0) * priceUsd0;
            const valueUsd1 = bigintToFloat(preStatus.unclaimedFees1, d1) * priceUsd1;

            const storagePath = chainStoragePath(config.analytics?.storage_path ?? './analytics', collectLockChainId);
            logger.info('Recording fee collection to analytics', {
              tokenId,
              txHash: receipt.hash,
              storagePath,
              totalValueUsd: valueUsd0 + valueUsd1,
            });
            await writeAnalyticsRecord({
              type: 'fee_collection',
              timestamp: Date.now(),
              data: {
                timestamp: Date.now(),
                tokenId,
                chainId: collectLockChainId,
                dex: posConfig.dex,
                blockNumber: receipt.blockNumber,
                txHash: receipt.hash,
                amount0: preStatus.unclaimedFees0,
                amount1: preStatus.unclaimedFees1,
                gasUsed,
                gasPrice,
                gasCostPLS: Number(gasUsed * gasPrice) / 1e18,
                priceUsd0,
                priceUsd1,
                valueUsd0,
                valueUsd1,
                totalValueUsd: valueUsd0 + valueUsd1,
                token0Symbol: preStatus.token0Info.symbol,
                token1Symbol: preStatus.token1Info.symbol,
                token0Decimals: d0,
                token1Decimals: d1,
              },
            }, storagePath);
            logger.info('✓ Fee collection analytics recorded successfully');
          } catch (analyticsErr) {
            const errMsg = 'FAILED to record fee collection analytics';
            logger.error(errMsg, {
              error: analyticsErr instanceof Error ? analyticsErr.message : String(analyticsErr),
              stack: analyticsErr instanceof Error ? analyticsErr.stack : undefined,
              tokenId,
              txHash: receipt.hash,
            });
            console.error(`❌ ${errMsg}:`, analyticsErr);
          }

          // Re-fetch status to get updated fee amounts
          const status = await getPositionStatus(tokenId, collectContracts, collectChain);

          res.json(JSON.parse(JSON.stringify({
            success: true,
            txHash: receipt.hash,
            gasUsed: gasUsed.toString(),
            collected0: status.position.tokensOwed0.toString(),
            collected1: status.position.tokensOwed1.toString(),
          }, bigIntReplacer)));
        } catch (err) {
          logger.error('Fee collection transaction failed', {
            token_id: tokenId,
            error: err instanceof Error ? err.message : String(err),
          });
          res.status(500).json({ error: 'Fee collection failed' });
        }
      } finally {
        releaseRebalanceLock(collectLockChainId, tokenId);
      }
    } catch (err) {
      logger.error('Collect fees error', { error: err instanceof Error ? err.message : String(err) });
      res.status(500).json({ error: 'Failed to collect fees' });
    }
  });

  // ─────────────────────────────────────────────────────────────────────────
  // GET /api/positions/:tokenId/rebalance-preview
  // Returns what the strategy WOULD do if a rebalance were triggered now,
  // including the new tick range and estimated swap — without executing.
  // ─────────────────────────────────────────────────────────────────────────
  router.get('/:tokenId/rebalance-preview', async (req: Request, res: Response) => {
    try {
      const tokenId = parseInt(req.params.tokenId as string, 10);
      if (isNaN(tokenId) || tokenId <= 0) {
        res.status(400).json({ error: 'Invalid tokenId' });
        return;
      }

      const posConfig = config.positions.find((p) => p.token_id === tokenId);
      if (!posConfig) {
        res.status(404).json({ error: `Position ${tokenId} not found in config` });
        return;
      }

      // Get live position status (multi-chain aware)
      const { posContracts: previewContracts, posChain: previewChain } = resolveForPos(posConfig);
      const status = await getPositionStatus(tokenId, previewContracts, previewChain);

      // Evaluate strategy — always provides new range if shouldRebalance
      const decision = evaluateStrategy(status, posConfig);

      // Get token prices for USD estimates
      const tokenAddresses = [status.position.token0, status.position.token1];
      let priceMap = new Map<string, number>();
      try {
        const chainId = posConfig.chain_id ?? config.chain.chainId;
        const chainSlug = CHAIN_REGISTRY[chainId]?.dexScreenerSlug ?? config.chain.dexScreenerSlug;
        priceMap = await getTokenPrices(tokenAddresses, chainSlug);
      } catch { /* prices unavailable */ }

      const decimals0 = status.token0Info.decimals;
      const decimals1 = status.token1Info.decimals;
      const price0 = priceMap.get(status.position.token0.toLowerCase()) ?? 0;
      const price1 = priceMap.get(status.position.token1.toLowerCase()) ?? 0;

      // Current position value in USD
      const amount0Usd = price0 > 0
        ? (Number(status.amount0) / 10 ** decimals0) * price0
        : 0;
      const amount1Usd = price1 > 0
        ? (Number(status.amount1) / 10 ** decimals1) * price1
        : 0;
      const positionValueUsd = amount0Usd + amount1Usd;

      // Unclaimed fees value
      const fees0Usd = price0 > 0
        ? (Number(status.unclaimedFees0) / 10 ** decimals0) * price0
        : 0;
      const fees1Usd = price1 > 0
        ? (Number(status.unclaimedFees1) / 10 ** decimals1) * price1
        : 0;
      const feesUsd = fees0Usd + fees1Usd;

      // Compute the target range. If strategy says shouldRebalance use its ticks,
      // otherwise compute what the range would look like if centered on current tick.
      const tickSpacing = getTickSpacing(status.position.fee);
      const forcedRange = computeNewRangeForEdge(
        status.pool.currentTick,
        posConfig.strategy,
        posConfig.params.width_ticks ?? 300,
        tickSpacing,
        posConfig.params.lower_ratio_percent,
      );
      const newTickLower = decision.newTickLower ?? forcedRange.newTickLower;
      const newTickUpper = decision.newTickUpper ?? forcedRange.newTickUpper;

      // Estimate swap amount needed to enter new range
      const swapRaw = estimateSwapForNewRange(
        status.amount0,
        status.amount1,
        status.pool.currentTick,
        newTickLower,
        newTickUpper,
        decimals0,
        decimals1,
        price0,
        price1,
      );
      const swapEstimate = {
        tokenIn: swapRaw.tokenIn,
        symbol: swapRaw.tokenIn === 'token0' ? status.token0Info.symbol : status.token1Info.symbol,
        amountUsd: swapRaw.swapAmountUsd,
        pct: swapRaw.swapPct,
      };

      res.json({
        tokenId,
        currentTick: status.pool.currentTick,
        inRange: status.isInRange,
        pair: `${status.token0Info.symbol}/${status.token1Info.symbol}`,
        token0Symbol: status.token0Info.symbol,
        token1Symbol: status.token1Info.symbol,
        positionValueUsd,
        feesUsd,
        currentRange: {
          tickLower: status.position.tickLower,
          tickUpper: status.position.tickUpper,
        },
        newRange: {
          tickLower: newTickLower,
          tickUpper: newTickUpper,
        },
        strategy: posConfig.strategy,
        shouldRebalance: decision.shouldRebalance,
        reason: decision.reason,
        swapEstimate,
        dryRun: config.dry_run,
      });
    } catch (err) {
      logger.error('Rebalance preview error', { error: err instanceof Error ? err.message : String(err) });
      res.status(500).json({ error: 'Failed to generate rebalance preview' });
    }
  });

  // ─────────────────────────────────────────────────────────────────────────
  // POST /api/positions/:tokenId/rebalance
  // Force a full manual rebalance: collect fees → remove → swap → mint.
  // Bypasses cooldown and confirmation timer; TWAP safety check still enforced.
  // ─────────────────────────────────────────────────────────────────────────
  router.post('/:tokenId/rebalance', async (req: Request, res: Response) => {
    try {
      const tokenId = parseInt(req.params.tokenId as string, 10);
      if (isNaN(tokenId) || tokenId <= 0) {
        res.status(400).json({ error: 'Invalid tokenId' });
        return;
      }

      const posConfig = config.positions.find((p) => p.token_id === tokenId);
      if (!posConfig) {
        res.status(404).json({ error: `Position ${tokenId} not found in config` });
        return;
      }

      if (config.dry_run) {
        res.status(403).json({ error: 'Cannot rebalance in dry_run mode' });
        return;
      }

      // Guard: refuse if bot already has an active rebalance on this position
      if (isRebalanceLocked(posConfig?.chain_id ?? config.chain.chainId, tokenId)) {
        res.status(409).json({
          error: `Position ${tokenId} is currently being rebalanced by the bot. Try again in a minute.`,
        });
        return;
      }

      logger.info('Manual rebalance requested via dashboard', { token_id: tokenId });

      const { posChain: rebalChain, posContracts: rebalContracts } = resolveForPos(posConfig);
      const result = await checkAndRebalance(
        posConfig,
        config,
        rebalContracts,
        rebalChain,
        null,  // analyticsCollector — not available in server context
        true,  // force — bypass cooldown & confirmation timer
      );

      if (!result) {
        res.status(409).json({
          error: 'Rebalance did not execute — position may be in safe mode, TWAP check failed, or zero liquidity.',
        });
        return;
      }

      if (!result.success) {
        res.status(500).json({ error: result.error ?? 'Rebalance failed' });
        return;
      }

      logger.info('Manual rebalance complete', {
        token_id: tokenId,
        oldTokenId: result.oldTokenId,
        newTokenId: result.newTokenId,
      });

      res.json(JSON.parse(JSON.stringify({
        success: true,
        oldTokenId: result.oldTokenId,
        newTokenId: result.newTokenId,
        feesCollected: {
          amount0: result.feesCollected.amount0.toString(),
          amount1: result.feesCollected.amount1.toString(),
        },
        liquidityRemoved: {
          amount0: result.liquidityRemoved.amount0.toString(),
          amount1: result.liquidityRemoved.amount1.toString(),
        },
        swap: result.swapExecuted ? {
          tokenIn: result.swapExecuted.tokenIn,
          tokenOut: result.swapExecuted.tokenOut,
          amountIn: result.swapExecuted.amountIn.toString(),
          amountOut: result.swapExecuted.amountOut.toString(),
          txHash: result.swapExecuted.txHash,
        } : null,
        newPosition: result.newPosition ? {
          tokenId: result.newPosition.newTokenId,
          liquidity: result.newPosition.liquidity.toString(),
          txHash: result.newPosition.txHash,
        } : null,
      }, bigIntReplacer)));

    } catch (err) {
      logger.error('Manual rebalance error', { error: err instanceof Error ? err.message : String(err) });
      res.status(500).json({ error: 'Rebalance failed' });
    }
  });

  // ─────────────────────────────────────────────────────────────────────────
  // GET /api/positions/:tokenId/increase-preview
  // Returns expected swap and liquidity increase for given amounts
  // ─────────────────────────────────────────────────────────────────────────
  router.get('/:tokenId/increase-preview', async (req: Request, res: Response) => {
    try {
      const tokenId = parseInt(req.params.tokenId as string, 10);
      if (isNaN(tokenId) || tokenId <= 0) {
        res.status(400).json({ error: 'Invalid tokenId' });
        return;
      }

      const posConfig = config.positions.find((p) => p.token_id === tokenId);
      if (!posConfig) {
        res.status(404).json({ error: `Position ${tokenId} not found in config` });
        return;
      }

      const amount0Str = req.query.amount0 as string | undefined;
      const amount1Str = req.query.amount1 as string | undefined;
      if (!amount0Str && !amount1Str) {
        res.status(400).json({ error: 'Provide amount0 and/or amount1 query parameters' });
        return;
      }

      const amount0 = BigInt(amount0Str || '0');
      const amount1 = BigInt(amount1Str || '0');

      const { posContracts, posChain } = resolveForPos(posConfig);
      const status = await getPositionStatus(tokenId, posContracts, posChain);
      const { position, pool, token0Info, token1Info } = status;

      // Calculate swap needed to balance the amounts for this range
      const swapCalc = calculateSwapAmount(
        amount0, amount1,
        pool.currentTick,
        position.tickLower, position.tickUpper,
        pool.fee,
      );

      // Calculate expected liquidity from the provided amounts (after theoretical swap)
      const sqrtPriceAX96 = tickToSqrtPriceX96(position.tickLower);
      const sqrtPriceBX96 = tickToSqrtPriceX96(position.tickUpper);
      const expectedLiquidity = getLiquidityForAmounts(
        pool.sqrtPriceX96, sqrtPriceAX96, sqrtPriceBX96, amount0, amount1,
      );

      // Get prices for USD estimates
      let priceMap = new Map<string, number>();
      try {
        const chainId = posConfig.chain_id ?? config.chain.chainId;
        const chainSlug = CHAIN_REGISTRY[chainId]?.dexScreenerSlug ?? config.chain.dexScreenerSlug;
        priceMap = await getTokenPrices([position.token0, position.token1], chainSlug);
      } catch { /* prices unavailable */ }
      const price0 = priceMap.get(position.token0.toLowerCase()) ?? 0;
      const price1 = priceMap.get(position.token1.toLowerCase()) ?? 0;
      const d0 = token0Info.decimals;
      const d1 = token1Info.decimals;

      // Estimate gas cost
      const gasPrice = await posChain.provider.getFeeData();
      const gasPriceWei = gasPrice.gasPrice ?? 0n;
      const swapGas = swapCalc.amountIn > 0n ? BigInt(GAS_LIMITS.SWAP + GAS_LIMITS.APPROVE) : 0n;
      const totalGas = swapGas + BigInt(GAS_LIMITS.INCREASE_LIQUIDITY + GAS_LIMITS.APPROVE * 2);
      const gasCostWei = totalGas * gasPriceWei;

      res.json(JSON.parse(JSON.stringify({
        swap: swapCalc.amountIn > 0n ? {
          tokenIn: swapCalc.tokenIn,
          amountIn: swapCalc.amountIn.toString(),
          tokenInSymbol: swapCalc.tokenIn === 'token0' ? token0Info.symbol : token1Info.symbol,
          tokenOutSymbol: swapCalc.tokenIn === 'token0' ? token1Info.symbol : token0Info.symbol,
        } : null,
        expectedLiquidity: expectedLiquidity.toString(),
        currentLiquidity: position.liquidity.toString(),
        estimatedGasCostWei: gasCostWei.toString(),
        token0Symbol: token0Info.symbol,
        token1Symbol: token1Info.symbol,
        token0Decimals: d0,
        token1Decimals: d1,
        priceUsd0: price0,
        priceUsd1: price1,
      }, bigIntReplacer)));
    } catch (err) {
      logger.error('Increase preview error', { error: err instanceof Error ? err.message : String(err) });
      res.status(500).json({ error: 'Failed to generate increase preview' });
    }
  });

  // ─────────────────────────────────────────────────────────────────────────
  // POST /api/positions/:tokenId/increase — add liquidity to existing position
  // ─────────────────────────────────────────────────────────────────────────
  router.post('/:tokenId/increase', async (req: Request, res: Response) => {
    try {
      const tokenId = parseInt(req.params.tokenId as string, 10);
      if (isNaN(tokenId) || tokenId <= 0) {
        res.status(400).json({ error: 'Invalid tokenId' });
        return;
      }

      const posConfig = config.positions.find((p) => p.token_id === tokenId);
      if (!posConfig) {
        res.status(404).json({ error: `Position ${tokenId} not found in config` });
        return;
      }

      if (config.dry_run) {
        res.status(403).json({ error: 'Cannot increase liquidity in dry_run mode' });
        return;
      }

      const chainId = posConfig.chain_id ?? config.chain.chainId;
      if (isRebalanceLocked(chainId, tokenId)) {
        res.status(409).json({ error: `Position ${tokenId} is currently being rebalanced. Try again in a minute.` });
        return;
      }

      const { amount0, amount1, swapIfNeeded } = req.body as {
        amount0?: string;
        amount1?: string;
        swapIfNeeded?: boolean;
      };

      if (!amount0 && !amount1) {
        res.status(400).json({ error: 'Provide amount0 and/or amount1' });
        return;
      }

      let amt0 = BigInt(amount0 || '0');
      let amt1 = BigInt(amount1 || '0');

      acquireRebalanceLock(chainId, tokenId);
      try {
        logger.info('Increase liquidity requested via dashboard', { token_id: tokenId, amount0: amt0.toString(), amount1: amt1.toString() });

        const { posContracts, posChain } = resolveForPos(posConfig);
        const status = await getPositionStatus(tokenId, posContracts, posChain);

        // If swapIfNeeded, calculate and execute swap to balance token ratio
        let swapResult = null;
        if (swapIfNeeded && (amt0 > 0n || amt1 > 0n)) {
          const swapCalc = calculateSwapAmount(
            amt0, amt1,
            status.pool.currentTick,
            status.position.tickLower, status.position.tickUpper,
            status.pool.fee,
          );

          if (swapCalc.amountIn > 0n) {

            const tokenInAddr = swapCalc.tokenIn === 'token0' ? status.position.token0 : status.position.token1;
            const tokenOutAddr = swapCalc.tokenIn === 'token0' ? status.position.token1 : status.position.token0;
            const zeroForOne = swapCalc.tokenIn === 'token0';

            swapResult = await executeSwap(
              tokenInAddr, tokenOutAddr,
              status.pool.fee,
              swapCalc.amountIn,
              status.pool.sqrtPriceX96,
              zeroForOne,
              config, posContracts, posChain,
            );

            // Update amounts after swap
            if (zeroForOne) {
              amt0 -= swapResult.amountIn;
              amt1 += swapResult.amountOut;
            } else {
              amt1 -= swapResult.amountIn;
              amt0 += swapResult.amountOut;
            }
          }
        }

        const result = await increaseLiquidity(
          tokenId, amt0, amt1,
          config.slippage_tolerance_bps,
          posContracts, posChain,
        );

        // Record analytics
        try {
          const chainSlug = CHAIN_REGISTRY[chainId]?.dexScreenerSlug ?? config.chain.dexScreenerSlug;
          const prices = await getTokenPrices([status.position.token0, status.position.token1], chainSlug);
          const d0 = status.token0Info.decimals;
          const d1 = status.token1Info.decimals;
          const p0 = prices.get(status.position.token0.toLowerCase()) ?? 0;
          const p1 = prices.get(status.position.token1.toLowerCase()) ?? 0;
          const storagePath = chainStoragePath(config.analytics?.storage_path ?? './analytics', chainId);
          await writeAnalyticsRecord({
            type: 'position_increase',
            timestamp: Date.now(),
            data: {
              tokenId,
              chainId,
              dex: posConfig.dex,
              blockNumber: result.blockNumber,
              txHash: result.txHash,
              amount0: result.amount0.toString(),
              amount1: result.amount1.toString(),
              liquidity: result.liquidity.toString(),
              gasUsed: result.gasUsed.toString(),
              valueUsd0: (Number(result.amount0) / 10 ** d0) * p0,
              valueUsd1: (Number(result.amount1) / 10 ** d1) * p1,
              swap: swapResult ? {
                tokenIn: swapResult.tokenIn,
                amountIn: swapResult.amountIn.toString(),
                amountOut: swapResult.amountOut.toString(),
                txHash: swapResult.txHash,
              } : null,
            },
          }, storagePath);
        } catch (analyticsErr) {
          logger.error('Failed to record increase analytics', { error: analyticsErr instanceof Error ? analyticsErr.message : String(analyticsErr) });
        }

        // Send notification
        sendNotification(
          `📈 *Liquidity Increased — #${tokenId}*\n\n` +
          `• Added: ${(Number(result.amount0) / 10 ** status.token0Info.decimals).toFixed(4)} ${status.token0Info.symbol} + ` +
          `${(Number(result.amount1) / 10 ** status.token1Info.decimals).toFixed(4)} ${status.token1Info.symbol}\n` +
          `• Tx: \`${result.txHash}\``,
          config,
          'info',
        ).catch(() => {});

        res.json(JSON.parse(JSON.stringify({
          success: true,
          txHash: result.txHash,
          gasUsed: result.gasUsed.toString(),
          liquidity: result.liquidity.toString(),
          amount0: result.amount0.toString(),
          amount1: result.amount1.toString(),
          swap: swapResult ? {
            tokenIn: swapResult.tokenIn,
            tokenOut: swapResult.tokenOut,
            amountIn: swapResult.amountIn.toString(),
            amountOut: swapResult.amountOut.toString(),
            txHash: swapResult.txHash,
          } : null,
        }, bigIntReplacer)));
      } catch (err) {
        logger.error('Increase liquidity failed', { token_id: tokenId, error: err instanceof Error ? err.message : String(err) });
        res.status(500).json({ error: 'Increase liquidity failed' });
      } finally {
        releaseRebalanceLock(chainId, tokenId);
      }
    } catch (err) {
      logger.error('Increase liquidity error', { error: err instanceof Error ? err.message : String(err) });
      res.status(500).json({ error: 'Failed to increase liquidity' });
    }
  });

  // ─────────────────────────────────────────────────────────────────────────
  // POST /api/positions/:tokenId/decrease — remove partial liquidity
  // ─────────────────────────────────────────────────────────────────────────
  router.post('/:tokenId/decrease', async (req: Request, res: Response) => {
    try {
      const tokenId = parseInt(req.params.tokenId as string, 10);
      if (isNaN(tokenId) || tokenId <= 0) {
        res.status(400).json({ error: 'Invalid tokenId' });
        return;
      }

      const posConfig = config.positions.find((p) => p.token_id === tokenId);
      if (!posConfig) {
        res.status(404).json({ error: `Position ${tokenId} not found in config` });
        return;
      }

      if (config.dry_run) {
        res.status(403).json({ error: 'Cannot decrease liquidity in dry_run mode' });
        return;
      }

      const chainId = posConfig.chain_id ?? config.chain.chainId;
      if (isRebalanceLocked(chainId, tokenId)) {
        res.status(409).json({ error: `Position ${tokenId} is currently being rebalanced. Try again in a minute.` });
        return;
      }

      const { percentageBps } = req.body as { percentageBps?: number };
      if (!percentageBps || percentageBps <= 0 || percentageBps > 10000) {
        res.status(400).json({ error: 'percentageBps must be between 1 and 10000 (100%)' });
        return;
      }

      acquireRebalanceLock(chainId, tokenId);
      try {
        logger.info('Decrease liquidity requested via dashboard', { token_id: tokenId, percentageBps });

        const { posContracts, posChain } = resolveForPos(posConfig);
        const preStatus = await getPositionStatus(tokenId, posContracts, posChain);

        const result = await decreasePositionLiquidity(
          tokenId,
          percentageBps,
          config.slippage_tolerance_bps,
          posContracts,
          posChain,
        );

        // Record analytics
        try {
          const chainSlug = CHAIN_REGISTRY[chainId]?.dexScreenerSlug ?? config.chain.dexScreenerSlug;
          const prices = await getTokenPrices([preStatus.position.token0, preStatus.position.token1], chainSlug);
          const d0 = preStatus.token0Info.decimals;
          const d1 = preStatus.token1Info.decimals;
          const p0 = prices.get(preStatus.position.token0.toLowerCase()) ?? 0;
          const p1 = prices.get(preStatus.position.token1.toLowerCase()) ?? 0;
          const storagePath = chainStoragePath(config.analytics?.storage_path ?? './analytics', chainId);
          await writeAnalyticsRecord({
            type: 'position_decrease',
            timestamp: Date.now(),
            data: {
              tokenId,
              chainId,
              dex: posConfig.dex,
              blockNumber: result.collectBlockNumber,
              percentageBps,
              decreaseTxHash: result.decreaseTxHash,
              collectTxHash: result.collectTxHash,
              amount0: result.amount0.toString(),
              amount1: result.amount1.toString(),
              gasUsed: result.gasUsed.toString(),
              valueUsd0: (Number(result.amount0) / 10 ** d0) * p0,
              valueUsd1: (Number(result.amount1) / 10 ** d1) * p1,
            },
          }, storagePath);
        } catch (analyticsErr) {
          logger.error('Failed to record decrease analytics', { error: analyticsErr instanceof Error ? analyticsErr.message : String(analyticsErr) });
        }

        // Send notification
        sendNotification(
          `📉 *Liquidity Decreased — #${tokenId} (${(percentageBps / 100).toFixed(0)}%)*\n\n` +
          `• Received: ${(Number(result.amount0) / 10 ** preStatus.token0Info.decimals).toFixed(4)} ${preStatus.token0Info.symbol} + ` +
          `${(Number(result.amount1) / 10 ** preStatus.token1Info.decimals).toFixed(4)} ${preStatus.token1Info.symbol}\n` +
          `• Decrease tx: \`${result.decreaseTxHash}\``,
          config,
          'info',
        ).catch(() => {});

        res.json(JSON.parse(JSON.stringify({
          success: true,
          decreaseTxHash: result.decreaseTxHash,
          collectTxHash: result.collectTxHash,
          gasUsed: result.gasUsed.toString(),
          amount0: result.amount0.toString(),
          amount1: result.amount1.toString(),
          percentageBps,
        }, bigIntReplacer)));
      } catch (err) {
        logger.error('Decrease liquidity failed', { token_id: tokenId, error: err instanceof Error ? err.message : String(err) });
        res.status(500).json({ error: 'Decrease liquidity failed' });
      } finally {
        releaseRebalanceLock(chainId, tokenId);
      }
    } catch (err) {
      logger.error('Decrease liquidity error', { error: err instanceof Error ? err.message : String(err) });
      res.status(500).json({ error: 'Failed to decrease liquidity' });
    }
  });

  return router;
}

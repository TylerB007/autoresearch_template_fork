/**
 * Analytics routes — position lifecycle metrics, snapshot history, portfolio summary
 */

import { Router, type Request, type Response } from 'express';
import type { ContractInstances } from '../../contracts.js';
import type { ChainContext } from '../../chain.js';
import type { AppConfig } from '../../types.js';
import type { MultiChainContext } from '../../multiChain.js';
import { queryRebalances, querySnapshots, queryFeeCollections, queryPositionEntries, queryAllChainRebalances, queryAllChainFeeCollections, queryAllChainSnapshots, queryAllChainPositionEntries, resolveStoragePath, readManualLinks, writeManualLink, deleteManualLink, queryAllChainManualLinks } from '../../analytics/storage.js';
import { calculateImpermanentLoss, estimateTimeInRange, calculateFeeAPR } from '../../analytics/metrics.js';
import { calculateHealthScore } from '../../analytics/healthScore.js';
import { buildPositionChain } from '../../analytics/chain.js';
import { buildLineageAnalyticsSummary, type LivePositionAnalyticsState } from '../../analytics/lineageSummary.js';
import { buildExportReport } from '../../analytics/export.js';
import { getPositionStatus } from '../../position.js';
import { getTokenPrices } from '../services/priceService.js';
import { TOKENS } from '../../config/contracts.js';
import { CHAIN_REGISTRY } from '../../config/chains.js';
import { bigintToFloat } from '../../bigintFloat.js';
import logger from '../../logger.js';

const bigIntReplacer = (_key: string, value: unknown): unknown =>
  typeof value === 'bigint' ? value.toString() : value;

/** Escape a string for CSV: wrap in quotes if it contains comma, quote, or newline */
function csvEscape(value: string): string {
  if (value.includes(',') || value.includes('"') || value.includes('\n')) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

/** Format a BigInt token amount to a human-readable decimal string */
function formatTokenAmount(raw: bigint, decimals: number): string {
  const str = raw.toString();
  if (decimals === 0) return str;
  const padded = str.padStart(decimals + 1, '0');
  const intPart = padded.slice(0, padded.length - decimals);
  const fracPart = padded.slice(padded.length - decimals).replace(/0+$/, '');
  return fracPart.length > 0 ? `${intPart}.${fracPart}` : intPart;
}

/**
 * Compute fee USD value for a rebalance, preferring the historically-accurate
 * `feesCollectedUsd` field stored at rebalance time. Falls back to recalculation
 * using stored token prices, then live prices. Mirrors the logic in /earnings.
 */
function rebalanceFeeUsd(
  rb: import('../../analytics/types.js').RebalanceAnalytics,
  fallbackPrice0: number,
  fallbackPrice1: number,
): number {
  if (rb.feesCollectedUsd != null && rb.feesCollectedUsd > 0) {
    return rb.feesCollectedUsd;
  }
  const price0 = rb.priceUsd0 ?? fallbackPrice0;
  const price1 = rb.priceUsd1 ?? fallbackPrice1;
  const d0 = rb.preSnapshot.token0Decimals;
  const d1 = rb.preSnapshot.token1Decimals;
  return bigintToFloat(rb.feesCollected0, d0) * price0 +
         bigintToFloat(rb.feesCollected1, d1) * price1;
}

function downsample<T>(items: T[], maxPoints: number): T[] {
  if (items.length <= maxPoints) return items;
  const step = Math.ceil(items.length / maxPoints);
  const result: T[] = [];
  for (let i = 0; i < items.length; i += step) {
    result.push(items[i]);
  }
  // Always include the last item
  if (result[result.length - 1] !== items[items.length - 1]) {
    result.push(items[items.length - 1]);
  }
  return result;
}

async function resolveTokenAnalyticsStoragePath(
  tokenId: number,
  storagePath: string,
  config: AppConfig,
  multiChain?: MultiChainContext,
): Promise<{ storagePath: string; chainId?: number; dex?: string }> {
  const configuredMatches = config.positions.filter((position) => position.token_id === tokenId);
  if (configuredMatches.length > 1) {
    throw new Error(`Token #${tokenId} is configured multiple times. Resolve the duplicate config before requesting analytics.`);
  }

  if (configuredMatches.length === 1) {
    const chainId = configuredMatches[0] && multiChain
      ? multiChain.resolveChainId(configuredMatches[0])
      : (configuredMatches[0]?.chain_id ?? config.chain.chainId);
    return {
      storagePath: resolveStoragePath(storagePath, chainId),
      chainId,
      dex: configuredMatches[0]?.dex,
    };
  }

  const candidateChainIds = multiChain
    ? multiChain.getChainIds()
    : [...config.chains.keys()].length > 0
      ? [...config.chains.keys()]
      : [config.chain.chainId];

  const candidates: Array<{ storagePath: string; chainId?: number }> = [];
  for (const chainId of candidateChainIds) {
    const candidatePath = resolveStoragePath(storagePath, chainId);
    const [rebalances, snapshots, entries, feeCollections] = await Promise.all([
      queryRebalances(candidatePath),
      querySnapshots(candidatePath, tokenId),
      queryPositionEntries(candidatePath, tokenId),
      queryFeeCollections(candidatePath, tokenId),
    ]);
    const hasEvidence =
      rebalances.some((rebalance) => rebalance.oldTokenId === tokenId || rebalance.newTokenId === tokenId) ||
      snapshots.length > 0 ||
      entries.length > 0 ||
      feeCollections.length > 0;
    if (hasEvidence) {
      candidates.push({ storagePath: candidatePath, chainId });
    }
  }

  if (candidates.length > 1) {
    throw new Error(`Token #${tokenId} appears in multiple chain analytics stores. Add an active config entry so analytics can resolve the correct chain deterministically.`);
  }

  if (candidates.length === 1) {
    return candidates[0];
  }

  return { storagePath: resolveStoragePath(storagePath, config.chain.chainId), chainId: config.chain.chainId };
}

async function resolveManualLinkStoragePath(
  oldTokenId: number,
  newTokenId: number,
  storagePath: string,
  config: AppConfig,
  multiChain?: MultiChainContext,
): Promise<{ storagePath: string; chainId?: number; dex?: string }> {
  const oldScope = await resolveTokenAnalyticsStoragePath(oldTokenId, storagePath, config, multiChain);
  const newScope = await resolveTokenAnalyticsStoragePath(newTokenId, storagePath, config, multiChain);
  if (oldScope.chainId !== undefined && newScope.chainId !== undefined && oldScope.chainId !== newScope.chainId) {
    throw new Error('Manual links cannot span different chains.');
  }
  const chainId = oldScope.chainId ?? newScope.chainId;

  const oldConfigured = config.positions.find((position) => position.token_id === oldTokenId);
  const newConfigured = config.positions.find((position) => position.token_id === newTokenId);
  const oldDex = oldConfigured?.dex ?? oldScope.dex;
  const newDex = newConfigured?.dex ?? newScope.dex;
  if (oldDex !== undefined && newDex !== undefined && oldDex !== newDex) {
    throw new Error('Manual links cannot span different DEX contexts.');
  }

  return {
    storagePath: oldScope.storagePath,
    chainId,
    dex: oldDex ?? newDex,
  };
}

export function createAnalyticsRouter(
  config: AppConfig,
  chain: ChainContext,
  contracts: ContractInstances,
  multiChain?: MultiChainContext,
): Router {
  const router = Router();
  const storagePath = config.analytics?.storage_path ?? './analytics';

  // GET /api/analytics/export?days=30 — structured JSON export for LLM analysis
  router.get('/export', async (req: Request, res: Response) => {
    try {
      const days = Math.min(365, Math.max(1, parseInt(req.query.days as string, 10) || 30));
      const report = await buildExportReport(storagePath, { days });
      res.json(JSON.parse(JSON.stringify(report, bigIntReplacer)));
    } catch (err) {
      logger.error('Analytics export error', { error: err instanceof Error ? err.message : String(err) });
      res.status(500).json({ error: 'Failed to build export report' });
    }
  });

  // GET /api/analytics/export/csv?type=rebalances|snapshots&days=90&tokenId=<optional>
  // Flat CSV export for pasting into LLMs or spreadsheet analysis
  router.get('/export/csv', async (req: Request, res: Response) => {
    try {
      const type = (req.query.type as string) || 'rebalances';
      const days = Math.min(365, Math.max(1, parseInt(req.query.days as string, 10) || 90));
      const tokenIdParam = req.query.tokenId as string | undefined;
      const tokenId = tokenIdParam ? parseInt(tokenIdParam, 10) : undefined;
      const startTime = Date.now() - days * 86400 * 1000;

      if (type === 'combined') {
        const [snapshots, allRebalances] = await Promise.all([
          queryAllChainSnapshots(storagePath, tokenId, startTime),
          queryAllChainRebalances(storagePath, startTime),
        ]);
        const rebalances = tokenId !== undefined
          ? allRebalances.filter((r) => r.oldTokenId === tokenId || r.newTokenId === tokenId)
          : allRebalances;

        const header = [
          'row_type', 'date', 'tokenId', 'pair',
          // snapshot state columns
          'currentTick', 'tickLower', 'tickUpper', 'isInRange',
          'token0Amount', 'token1Amount', 'positionValueUsd',
          'unclaimedFees0', 'unclaimedFees1', 'unclaimedFeesUsd',
          'priceUsd0', 'priceUsd1', 'nativePriceUsd',
          // rebalance-only columns (empty on snapshot rows)
          'rebalanceId', 'strategy',
          'feesCollected0', 'feesCollected1', 'feesCollectedUsd',
          'gasCostNative', 'gasCostUsd', 'swapFrictionUsd',
          'rebalanceCostPct', 'configuredSlippageToleranceBps', 'realizedExecutionDeltaBps',
          'feeAPR', 'rawFeeYieldPct', 'netROIPct', 'trueNetROIPct', 'impermanentLossPct',
          'oldTickLower', 'oldTickUpper', 'newTickLower', 'newTickUpper',
          'durationDays', 'timeInRangePct', 'capitalEfficiency',
        ].join(',');

        type CombinedRow = { timestamp: number; cols: string[] };
        const combinedRows: CombinedRow[] = [];

        for (const s of snapshots) {
          const pair = csvEscape(`${s.token0Symbol}/${s.token1Symbol}`);
          combinedRows.push({
            timestamp: s.timestamp,
            cols: [
              'snapshot',
              new Date(s.timestamp).toISOString(),
              String(s.tokenId),
              pair,
              String(s.currentTick),
              String(s.tickLower),
              String(s.tickUpper),
              String(s.isInRange),
              formatTokenAmount(s.amount0, s.token0Decimals),
              formatTokenAmount(s.amount1, s.token1Decimals),
              s.positionValueUsd?.toFixed(2) ?? '',
              formatTokenAmount(s.tokensOwed0, s.token0Decimals),
              formatTokenAmount(s.tokensOwed1, s.token1Decimals),
              s.unclaimedFeesUsd?.toFixed(2) ?? '',
              s.priceUsd0?.toFixed(6) ?? '',
              s.priceUsd1?.toFixed(6) ?? '',
              s.nativePriceUsd?.toFixed(6) ?? '',
              // rebalance-only: empty
              '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '',
            ],
          });
        }

        for (const rb of rebalances) {
          const pre = rb.preSnapshot;
          const pair = csvEscape(`${pre.token0Symbol}/${pre.token1Symbol}`);
          const d0 = pre.token0Decimals;
          const d1 = pre.token1Decimals;
          combinedRows.push({
            timestamp: rb.timestamp,
            cols: [
              'rebalance',
              new Date(rb.timestamp).toISOString(),
              String(rb.oldTokenId),
              pair,
              // snapshot-equivalent state from preSnapshot
              String(pre.currentTick),
              String(pre.tickLower),
              String(pre.tickUpper),
              String(pre.isInRange),
              formatTokenAmount(pre.amount0, d0),
              formatTokenAmount(pre.amount1, d1),
              pre.positionValueUsd?.toFixed(2) ?? '',
              formatTokenAmount(pre.tokensOwed0, d0),
              formatTokenAmount(pre.tokensOwed1, d1),
              pre.unclaimedFeesUsd?.toFixed(2) ?? '',
              rb.priceUsd0?.toFixed(6) ?? '',
              rb.priceUsd1?.toFixed(6) ?? '',
              rb.nativeTokenPriceUsd?.toFixed(6) ?? '',
              // rebalance-only
              csvEscape(rb.rebalanceId),
              csvEscape(rb.strategy),
              formatTokenAmount(rb.feesCollected0, d0),
              formatTokenAmount(rb.feesCollected1, d1),
              rb.feesCollectedUsd?.toFixed(2) ?? '',
              rb.totalGasCostPLS.toFixed(4),
              rb.gasCostUsd?.toFixed(2) ?? '',
              rb.swapFrictionUsd?.toFixed(2) ?? '',
              (rb.metrics.rebalanceCostPercent ?? 0).toFixed(2),
              rb.swap?.configuredSlippageBps?.toString() ?? '',
              String(Math.min(rb.swap?.realizedExecutionDeltaBps ?? rb.swap?.slippageBps ?? 0, 500)),
              (rb.metrics.feeAPR ?? 0).toFixed(2),
              (rb.metrics.rawFeeYieldPercent ?? 0).toFixed(4),
              (rb.metrics.netROIPercent ?? 0).toFixed(2),
              (rb.metrics.trueNetROIPercent ?? 0).toFixed(2),
              (rb.metrics.impermanentLossPercent ?? 0).toFixed(2),
              String(pre.tickLower),
              String(pre.tickUpper),
              String(rb.newTickLower),
              String(rb.newTickUpper),
              (rb.metrics.durationDays ?? 0).toFixed(2),
              (rb.metrics.timeInRangePercent ?? 0).toFixed(1),
              (rb.metrics.capitalEfficiencyRatio ?? 0).toFixed(2),
            ],
          });
        }

        combinedRows.sort((a, b) => a.timestamp - b.timestamp);
        const csv = [header, ...combinedRows.map((r) => r.cols.join(','))].join('\n');
        res.setHeader('Content-Type', 'text/csv');
        res.setHeader('Content-Disposition', `attachment; filename="combined_${tokenId ?? 'all'}_${days}d.csv"`);
        res.send(csv);
      } else if (type === 'snapshots') {
        const snapshots = await queryAllChainSnapshots(storagePath, tokenId, startTime);
        const header = [
          'date', 'tokenId', 'pair',
          'currentTick', 'tickLower', 'tickUpper', 'isInRange',
          'token0Amount', 'token1Amount', 'positionValueUsd',
          'unclaimedFees0', 'unclaimedFees1', 'unclaimedFeesUsd',
          'priceUsd0', 'priceUsd1', 'nativePriceUsd',
        ].join(',');

        const rows = snapshots.map((s) => [
          new Date(s.timestamp).toISOString(),
          s.tokenId,
          csvEscape(`${s.token0Symbol}/${s.token1Symbol}`),
          s.currentTick,
          s.tickLower,
          s.tickUpper,
          s.isInRange,
          formatTokenAmount(s.amount0, s.token0Decimals),
          formatTokenAmount(s.amount1, s.token1Decimals),
          s.positionValueUsd?.toFixed(2) ?? '',
          formatTokenAmount(s.tokensOwed0, s.token0Decimals),
          formatTokenAmount(s.tokensOwed1, s.token1Decimals),
          s.unclaimedFeesUsd?.toFixed(2) ?? '',
          s.priceUsd0?.toFixed(6) ?? '',
          s.priceUsd1?.toFixed(6) ?? '',
          s.nativePriceUsd?.toFixed(6) ?? '',
        ].join(','));

        const csv = [header, ...rows].join('\n');
        res.setHeader('Content-Type', 'text/csv');
        res.setHeader('Content-Disposition', `attachment; filename="snapshots_${days}d.csv"`);
        res.send(csv);
      } else {
        // Default: rebalances
        const allRebalances = await queryAllChainRebalances(storagePath, startTime);
        const rebalances = tokenId !== undefined
          ? allRebalances.filter((r) => r.oldTokenId === tokenId || r.newTokenId === tokenId)
          : allRebalances;

        const header = [
          'date', 'rebalanceId', 'oldTokenId', 'newTokenId',
          'pair', 'strategy',
          'feesCollected0', 'feesCollected1', 'feesCollectedUsd',
          'gasCostNative', 'gasCostUsd', 'swapFrictionUsd',
          'rebalanceCostPct', 'configuredSlippageToleranceBps', 'realizedExecutionDeltaBps',
          'feeAPR', 'rawFeeYieldPct', 'netROIPct', 'trueNetROIPct',
          'impermanentLossPct',
          'oldTickLower', 'oldTickUpper', 'newTickLower', 'newTickUpper',
          'priceUsd0', 'priceUsd1', 'nativeTokenPriceUsd',
          'durationDays', 'timeInRangePct', 'capitalEfficiency',
        ].join(',');

        const rows = rebalances.map((rb) => {
          const d0 = rb.preSnapshot.token0Decimals;
          const d1 = rb.preSnapshot.token1Decimals;
          return [
            new Date(rb.timestamp).toISOString(),
            csvEscape(rb.rebalanceId),
            rb.oldTokenId,
            rb.newTokenId,
            csvEscape(`${rb.preSnapshot.token0Symbol}/${rb.preSnapshot.token1Symbol}`),
            csvEscape(rb.strategy),
            formatTokenAmount(rb.feesCollected0, d0),
            formatTokenAmount(rb.feesCollected1, d1),
            rb.feesCollectedUsd?.toFixed(2) ?? '',
            rb.totalGasCostPLS.toFixed(4),
            rb.gasCostUsd?.toFixed(2) ?? '',
            rb.swapFrictionUsd?.toFixed(2) ?? '',
            (rb.metrics.rebalanceCostPercent ?? 0).toFixed(2),
            rb.swap?.configuredSlippageBps?.toString() ?? '',
            Math.min(rb.swap?.realizedExecutionDeltaBps ?? rb.swap?.slippageBps ?? 0, 500),
            (rb.metrics.feeAPR ?? 0).toFixed(2),
            (rb.metrics.rawFeeYieldPercent ?? 0).toFixed(4),
            (rb.metrics.netROIPercent ?? 0).toFixed(2),
            (rb.metrics.trueNetROIPercent ?? 0).toFixed(2),
            (rb.metrics.impermanentLossPercent ?? 0).toFixed(2),
            rb.preSnapshot.tickLower,
            rb.preSnapshot.tickUpper,
            rb.newTickLower,
            rb.newTickUpper,
            rb.priceUsd0?.toFixed(6) ?? '',
            rb.priceUsd1?.toFixed(6) ?? '',
            rb.nativeTokenPriceUsd?.toFixed(6) ?? '',
            (rb.metrics.durationDays ?? 0).toFixed(2),
            (rb.metrics.timeInRangePercent ?? 0).toFixed(1),
            (rb.metrics.capitalEfficiencyRatio ?? 0).toFixed(2),
          ].join(',');
        });

        const csv = [header, ...rows].join('\n');
        res.setHeader('Content-Type', 'text/csv');
        res.setHeader('Content-Disposition', `attachment; filename="rebalances_${days}d.csv"`);
        res.send(csv);
      }
    } catch (err) {
      logger.error('CSV export error', { error: err instanceof Error ? err.message : String(err) });
      res.status(500).json({ error: 'Failed to generate CSV export' });
    }
  });

  // GET /api/analytics/positions/:tokenId/analytics
  router.get('/positions/:tokenId/analytics', async (req: Request, res: Response) => {
    try {
      const tokenId = parseInt(req.params.tokenId as string, 10);
      if (isNaN(tokenId) || tokenId <= 0) {
        res.status(400).json({ error: 'Invalid tokenId' });
        return;
      }

      const resolvedStore = await resolveTokenAnalyticsStoragePath(tokenId, storagePath, config, multiChain);
      const [allRebalances, allFeeCollections, allSnapshots, allPositionEntries, manualLinks] = await Promise.all([
        queryRebalances(resolvedStore.storagePath),
        queryFeeCollections(resolvedStore.storagePath),
        querySnapshots(resolvedStore.storagePath),
        queryPositionEntries(resolvedStore.storagePath),
        readManualLinks(resolvedStore.storagePath),
      ]);

      // Filter token-local data for existing charts while lineage summaries use the full chain set.
      const snapshots = allSnapshots.filter((snapshot) => snapshot.tokenId === tokenId);
      const positionEntries = allPositionEntries.filter((entry) => entry.tokenId === tokenId);
      const feeCollections = allFeeCollections.filter((feeCollection) => feeCollection.tokenId === tokenId);
      const rebalances = allRebalances.filter(
        (r) => r.oldTokenId === tokenId || r.newTokenId === tokenId,
      );

      const lineagePreview = buildLineageAnalyticsSummary({
        requestedTokenId: tokenId,
        requestedChainId: resolvedStore.chainId,
        requestedDex: resolvedStore.dex,
        rebalances: allRebalances,
        feeCollections: allFeeCollections,
        snapshots: allSnapshots,
        positionEntries: allPositionEntries,
        manualLinks,
      });
      const analyticsTokenId = lineagePreview.lineage.currentTokenId;

      // Fetch live position status + USD prices
      let currentUnclaimedFeesUsd = 0;
      let currentPositionValueUsd = 0;
      let currentILPercent = 0;
      let priceUsd0 = 0;
      let priceUsd1 = 0;
      let plsPriceUsd = 0;
      let liveAnalyticsState: LivePositionAnalyticsState | undefined;

      try {
          const posRef = config.positions.find(p => p.token_id === analyticsTokenId);
          const posChainId = posRef && multiChain ? multiChain.resolveChainId(posRef) : (resolvedStore.chainId ?? config.chain.chainId);
        const posChain = posRef && multiChain ? multiChain.getChainById(posChainId) : chain;
        const posContracts = posRef && multiChain ? multiChain.getContracts(posRef) : contracts;
        const chainEntry = CHAIN_REGISTRY[posChainId];
        const chainSlug = chainEntry?.dexScreenerSlug ?? config.chain.dexScreenerSlug;
        const nativeTokenAddr = chainEntry?.wrappedNativeAddress ?? TOKENS.WPLS;
        const status = await getPositionStatus(analyticsTokenId, posContracts, posChain);
        const tokenAddrs = [status.token0Info.address, status.token1Info.address, nativeTokenAddr];
        const prices = await getTokenPrices(tokenAddrs, chainSlug);
        priceUsd0 = prices.get(status.token0Info.address.toLowerCase()) ?? 0;
        priceUsd1 = prices.get(status.token1Info.address.toLowerCase()) ?? 0;
        plsPriceUsd = prices.get(nativeTokenAddr.toLowerCase()) ?? 0;

        const d0 = status.token0Info.decimals;
        const d1 = status.token1Info.decimals;
        currentUnclaimedFeesUsd =
          bigintToFloat(status.unclaimedFees0, d0) * priceUsd0 +
          bigintToFloat(status.unclaimedFees1, d1) * priceUsd1;

        currentPositionValueUsd =
          bigintToFloat(status.amount0, d0) * priceUsd0 +
          bigintToFloat(status.amount1, d1) * priceUsd1;

        liveAnalyticsState = {
          tokenId: analyticsTokenId,
          timestamp: Date.now(),
          currentPositionValueUsd,
          currentUnclaimedFeesUsd,
          priceUsd0,
          priceUsd1,
          nativePriceUsd: plsPriceUsd,
          token0Symbol: status.token0Info.symbol,
          token1Symbol: status.token1Info.symbol,
          token0Decimals: d0,
          token1Decimals: d1,
          source: 'live',
          priceStatus: 'live',
        };

        // Current IL: compare first snapshot to current
        if (snapshots.length > 0) {
          const first = snapshots[0];
          currentILPercent = calculateImpermanentLoss(
            first.amount0, first.amount1,
            first.sqrtPriceX96, status.pool.sqrtPriceX96,
            first.token0Decimals, first.token1Decimals,
          );
        }
      } catch (err) {
        logger.warn('Failed to fetch live position status for analytics', {
          tokenId: analyticsTokenId,
          error: err instanceof Error ? err.message : String(err),
        });
      }

      const lineageSummary = buildLineageAnalyticsSummary({
        requestedTokenId: tokenId,
        requestedChainId: resolvedStore.chainId,
        requestedDex: resolvedStore.dex,
        rebalances: allRebalances,
        feeCollections: allFeeCollections,
        snapshots: allSnapshots,
        positionEntries: allPositionEntries,
        manualLinks,
        liveState: liveAnalyticsState,
      });

      // Aggregate rebalance metrics
      let totalRebalanceFeesUsd = 0;
      let totalGasCostPLS = 0;
      let avgFeeAPR = 0;
      const rebalanceCosts: Array<{
        timestamp: number;
        rebalanceId: string;
        gasCostPLS: number;
        feesCollectedUsd: number;
        configuredSlippageToleranceBps?: number;
        realizedExecutionDeltaBps: number;
        executionCostUsd: number | null;
        executionCostQuality: 'exact' | 'partial' | 'estimated' | 'unavailable';
        gasCostSource: 'receipt_exact' | 'estimated_aggregate';
        feesToExecutionCostRatio: number | null;
        rebalanceCostPercent: number;
        netRoi: number;
      }> = [];

      for (const rb of rebalances) {
        // Prefer historically-accurate feesCollectedUsd; fall back to price recalculation
        const feesUsd = rebalanceFeeUsd(rb, priceUsd0, priceUsd1);
        totalRebalanceFeesUsd += feesUsd;
        totalGasCostPLS += rb.totalGasCostPLS;
        avgFeeAPR += rb.metrics.feeAPR;

        const executionCostUsd =
          typeof rb.gasCostUsd === 'number'
            ? rb.gasCostUsd + (rb.swapFrictionUsd ?? 0) + (rb.dustUsd ?? 0)
            : null;
        const executionCostQuality =
          typeof rb.gasCostUsd !== 'number'
            ? 'unavailable'
            : !rb.gasUsed.totalCostWei
              ? 'estimated'
              : rb.dustUsd === undefined
                ? 'partial'
                : 'exact';
        const feesToExecutionCostRatio =
          executionCostUsd !== null
            ? executionCostUsd > 0
              ? feesUsd / executionCostUsd
              : feesUsd > 0 ? Infinity : 0
            : null;

        rebalanceCosts.push({
          timestamp: rb.timestamp,
          rebalanceId: rb.rebalanceId,
          gasCostPLS: rb.totalGasCostPLS,
          feesCollectedUsd: feesUsd,
          configuredSlippageToleranceBps: rb.swap?.configuredSlippageBps,
          realizedExecutionDeltaBps: Math.min(rb.swap?.realizedExecutionDeltaBps ?? rb.swap?.slippageBps ?? 0, 500),
          executionCostUsd,
          executionCostQuality,
          gasCostSource: rb.gasUsed.totalCostWei ? 'receipt_exact' : 'estimated_aggregate',
          feesToExecutionCostRatio,
          rebalanceCostPercent: rb.metrics.rebalanceCostPercent ?? 0,
          netRoi: rb.metrics.netROIPercent,
        });
      }
      if (rebalances.length > 0) {
        avgFeeAPR /= rebalances.length;
      }

      // Aggregate manual fee collections
      let totalManualFeesUsd = 0;
      const feeCollectionsList = feeCollections.map((fc) => {
        totalManualFeesUsd += fc.totalValueUsd;
        totalGasCostPLS += fc.gasCostPLS;
        return {
          timestamp: fc.timestamp,
          txHash: fc.txHash,
          amount0: fc.amount0.toString(),
          amount1: fc.amount1.toString(),
          totalValueUsd: fc.totalValueUsd,
        };
      });

      const totalFeesClaimedUsd = totalRebalanceFeesUsd + totalManualFeesUsd;
      const combinedFeesUsd = totalFeesClaimedUsd + currentUnclaimedFeesUsd;
      // Gas cost in USD: use per-rebalance stored native price when available,
      // aggregate weighted by each rebalance's gas contribution
      let totalGasCostUsd = 0;
      for (const rb of rebalances) {
        const nativePrice = rb.nativeTokenPriceUsd ?? plsPriceUsd;
        totalGasCostUsd += rb.totalGasCostPLS * nativePrice;
      }
      // Add gas from manual fee collections (no stored native price — use live)
      for (const fc of feeCollections) {
        totalGasCostUsd += fc.gasCostPLS * plsPriceUsd;
      }
      const netPnlUsd = combinedFeesUsd - totalGasCostUsd;

      // Time metrics
      const firstSeen = snapshots.length > 0 ? snapshots[0].timestamp : Date.now();
      const daysSinceStart = (Date.now() - firstSeen) / (1000 * 86400);
      const lastRebalance = rebalances.length > 0 ? rebalances[rebalances.length - 1].timestamp : firstSeen;
      const daysSinceLastRebalance = (Date.now() - lastRebalance) / (1000 * 86400);
      const timeInRangePercent = estimateTimeInRange(snapshots);
      const avgRebalanceFrequencyDays = rebalances.length > 1
        ? daysSinceStart / rebalances.length
        : daysSinceStart;

      // Average rebalance execution cost
      const avgRebalanceCostPercent = rebalances.length > 0
        ? rebalances.reduce((sum, rb) => sum + (rb.metrics.rebalanceCostPercent ?? 0), 0) / rebalances.length
        : 0;

      // Health score
      const { score: healthScore, label: healthLabel } = calculateHealthScore({
        netPnlUsd: lineageSummary.lifetimeChain.truePnlUsd ?? lineageSummary.lifetimeChain.netIncomeUsd,
        avgFeeAPR,
        timeInRangePercent,
        avgRebalanceCostPercent,
      });

      // Fee time series: merge rebalance fees + manual collections chronologically.
      // Use the same deduplication and price preference as the /earnings endpoint.
      const feeEvents: Array<{ t: number; usd: number }> = [];
      const feeSeriesRebalanceTxHashes = new Set<string>();
      for (const rb of rebalances) {
        if (rb.txHashes.collectFees) feeSeriesRebalanceTxHashes.add(rb.txHashes.collectFees);
        if (rb.txHashes.collectTokens) feeSeriesRebalanceTxHashes.add(rb.txHashes.collectTokens);
        feeEvents.push({ t: rb.timestamp, usd: rebalanceFeeUsd(rb, priceUsd0, priceUsd1) });
      }
      for (const fc of feeCollections) {
        // Skip fee_collection records already counted via their rebalance record
        if (fc.txHash && feeSeriesRebalanceTxHashes.has(fc.txHash)) continue;
        feeEvents.push({ t: fc.timestamp, usd: fc.totalValueUsd });
      }
      feeEvents.sort((a, b) => a.t - b.t);

      let cumulative = 0;
      const feeTimeSeries = feeEvents.map((e) => {
        cumulative += e.usd;
        return { t: e.t, cumulativeUsd: cumulative };
      });

      // IL time series from snapshots
      const ilTimeSeriesRaw: Array<{ t: number; ilPercent: number }> = [];
      if (snapshots.length > 1) {
        const first = snapshots[0];
        for (const snap of snapshots) {
          const il = calculateImpermanentLoss(
            first.amount0, first.amount1,
            first.sqrtPriceX96, snap.sqrtPriceX96,
            first.token0Decimals, first.token1Decimals,
          );
          ilTimeSeriesRaw.push({ t: snap.timestamp, ilPercent: il });
        }
      }
      const ilTimeSeries = downsample(ilTimeSeriesRaw, 200);

      // ── True P&L computation ──────────────────────────────────────
      // Uses entry records (cost basis) + historical prices for accurate P&L.
      // Falls back gracefully when entry records don't exist (pre-feature positions).

      // Total swap friction from pre-computed values
      const totalSwapFrictionUsd = rebalances.reduce(
        (sum, rb) => sum + (rb.swapFrictionUsd ?? 0), 0,
      );

      // Entry cost basis: sum of all entry records for this position
      // For positions that existed before entry tracking, use first priced snapshot as fallback
      let entryCostUsd = 0;
      let hodlValueUsd = 0;  // What original tokens would be worth now if held (no LP)
      let hasEntryData = false;

      if (positionEntries.length > 0) {
        hasEntryData = true;
        // Use the most recent entry for this position (after last rebalance)
        const latestEntry = positionEntries[positionEntries.length - 1];
        entryCostUsd = latestEntry.entryCostUsd;
        // HODL value: original entry tokens at current prices
        hodlValueUsd =
          bigintToFloat(latestEntry.amount0, latestEntry.token0Decimals) * priceUsd0 +
          bigintToFloat(latestEntry.amount1, latestEntry.token1Decimals) * priceUsd1;
      } else if (snapshots.length > 0) {
        // Fallback: use first priced snapshot as approximate entry
        const firstPriced = snapshots.find((s) => s.positionValueUsd > 0);
        if (firstPriced) {
          hasEntryData = true;
          entryCostUsd = firstPriced.positionValueUsd;
          // HODL value from snapshot entry tokens
          hodlValueUsd =
            bigintToFloat(firstPriced.amount0, firstPriced.token0Decimals) * priceUsd0 +
            bigintToFloat(firstPriced.amount1, firstPriced.token1Decimals) * priceUsd1;
        }
      }

      // Unrealized IL in USD: difference between LP value and HODL value
      const unrealizedILUsd = hasEntryData ? currentPositionValueUsd - hodlValueUsd : 0;

      // Total P&L = (currentValue + claimedFees + unclaimedFees) - (entryCost + gasCost + swapFriction)
      const totalPnlUsd = hasEntryData
        ? (currentPositionValueUsd + totalFeesClaimedUsd + currentUnclaimedFeesUsd) -
          (entryCostUsd + totalGasCostUsd + totalSwapFrictionUsd)
        : netPnlUsd;  // fall back to old formula if no entry data

      const totalPnlPercent = hasEntryData && entryCostUsd > 0
        ? (totalPnlUsd / entryCostUsd) * 100
        : 0;

      // LP vs HODL: how much better/worse is LP-ing compared to simply holding
      const lpVsHodlUsd = hasEntryData
        ? (currentPositionValueUsd + totalFeesClaimedUsd + currentUnclaimedFeesUsd - totalGasCostUsd - totalSwapFrictionUsd) - hodlValueUsd
        : 0;
      const lpVsHodlPercent = hasEntryData && hodlValueUsd > 0
        ? (lpVsHodlUsd / hodlValueUsd) * 100
        : 0;

      const response = {
        tokenId,
        totalRebalances: lineageSummary.lifetimeChain.totalRebalances,
        totalFeesClaimedUsd: lineageSummary.lifetimeChain.claimedFeesUsd,
        totalFeesClaimed0: rebalances.reduce((sum, r) => sum + r.feesCollected0, 0n).toString(),
        totalFeesClaimed1: rebalances.reduce((sum, r) => sum + r.feesCollected1, 0n).toString(),
        totalManualCollections: lineageSummary.lifetimeChain.totalManualCollections,
        totalManualFeesUsd: totalManualFeesUsd,
        totalGasCostPLS,
        totalGasCostUsd: lineageSummary.lifetimeChain.totalGasCostUsd,
        currentUnclaimedFeesUsd: lineageSummary.lifetimeChain.unclaimedFeesUsd,
        combinedFeesUsd: lineageSummary.lifetimeChain.totalFeesUsd,
        currentILPercent,
        netPnlUsd: lineageSummary.lifetimeChain.netIncomeUsd,
        // True P&L metrics (available when entry records exist)
        currentPositionValueUsd: lineageSummary.lifetimeChain.currentPositionValueUsd,
        entryCostUsd: lineageSummary.lifetimeChain.entryCostUsd,
        hodlValueUsd: lineageSummary.lifetimeChain.hodlValueUsd,
        unrealizedILUsd: hasEntryData ? unrealizedILUsd : null,
        totalSwapFrictionUsd: lineageSummary.lifetimeChain.totalSwapFrictionUsd,
        totalPnlUsd: lineageSummary.lifetimeChain.truePnlUsd,
        totalPnlPercent: lineageSummary.lifetimeChain.truePnlPercent,
        lpVsHodlUsd: lineageSummary.lifetimeChain.lpVsHodlUsd,
        lpVsHodlPercent: lineageSummary.lifetimeChain.lpVsHodlPercent,
        hasEntryData: lineageSummary.lifetimeChain.hasEntryData,
        firstSeen: lineageSummary.lifetimeChain.firstSeen ?? firstSeen,
        daysSinceStart,
        daysSinceLastRebalance,
        timeInRangePercent,
        avgRebalanceFrequencyDays,
        avgFeeAPR,
        healthScore,
        healthLabel,
        rebalanceCosts,
        feeCollections: feeCollectionsList,
        feeTimeSeries: downsample(feeTimeSeries, 200),
        ilTimeSeries,
        currentInterval: lineageSummary.currentInterval,
        lifetimeChain: lineageSummary.lifetimeChain,
      };

      res.json(JSON.parse(JSON.stringify(response, bigIntReplacer)));
    } catch (err) {
      logger.error('Position analytics error', { error: err instanceof Error ? err.message : String(err) });
      res.status(500).json({ error: 'Failed to fetch position analytics' });
    }
  });

  // GET /api/analytics/positions/:tokenId/snapshots?days=N
  router.get('/positions/:tokenId/snapshots', async (req: Request, res: Response) => {
    try {
      const tokenId = parseInt(req.params.tokenId as string, 10);
      if (isNaN(tokenId) || tokenId <= 0) {
        res.status(400).json({ error: 'Invalid tokenId' });
        return;
      }

      const days = Math.min(365, Math.max(1, parseInt(req.query.days as string, 10) || 30));
      const startTime = Date.now() - days * 86400 * 1000;

      const snapshots = await querySnapshots(storagePath, tokenId, startTime);
      const downsampled = downsample(snapshots, 500);

      res.json(JSON.parse(JSON.stringify({
        tokenId,
        days,
        count: downsampled.length,
        snapshots: downsampled,
      }, bigIntReplacer)));
    } catch (err) {
      logger.error('Snapshots query error', { error: err instanceof Error ? err.message : String(err) });
      res.status(500).json({ error: 'Failed to fetch snapshots' });
    }
  });

  // GET /api/analytics/positions/:tokenId/chain — linked rebalance chain view
  router.get('/positions/:tokenId/chain', async (req: Request, res: Response) => {
    try {
      const tokenId = parseInt(req.params.tokenId as string, 10);
      if (isNaN(tokenId) || tokenId <= 0) {
        res.status(400).json({ error: 'Invalid tokenId' });
        return;
      }

      const resolvedStore = await resolveTokenAnalyticsStoragePath(tokenId, storagePath, config, multiChain);
      const positionChain = await buildPositionChain(tokenId, resolvedStore.storagePath, {
        chainId: resolvedStore.chainId,
        dex: resolvedStore.dex,
      });
      if (!positionChain) {
        res.status(404).json({ error: 'No chain data found for this position' });
        return;
      }

      res.json(JSON.parse(JSON.stringify(positionChain, bigIntReplacer)));
    } catch (err) {
      logger.error('Position chain error', { error: err instanceof Error ? err.message : String(err) });
      res.status(500).json({ error: 'Failed to build position chain' });
    }
  });

  // GET /api/analytics/links — list all manual chain links
  router.get('/links', async (_req: Request, res: Response) => {
    try {
      const links = await queryAllChainManualLinks(storagePath);
      res.json({ links });
    } catch (err) {
      logger.error('List manual links error', { error: err instanceof Error ? err.message : String(err) });
      res.status(500).json({ error: 'Failed to list manual links' });
    }
  });

  // POST /api/analytics/link — create a manual chain link
  router.post('/link', async (req: Request, res: Response) => {
    try {
      const { oldTokenId, newTokenId, note } = req.body;

      if (!Number.isInteger(oldTokenId) || oldTokenId <= 0) {
        res.status(400).json({ error: 'oldTokenId must be a positive integer' });
        return;
      }
      if (!Number.isInteger(newTokenId) || newTokenId <= 0) {
        res.status(400).json({ error: 'newTokenId must be a positive integer' });
        return;
      }
      if (oldTokenId === newTokenId) {
        res.status(400).json({ error: 'oldTokenId and newTokenId must be different' });
        return;
      }

      const resolvedStore = await resolveManualLinkStoragePath(oldTokenId, newTokenId, storagePath, config, multiChain);
      const link = {
        oldTokenId,
        newTokenId,
        chainId: resolvedStore.chainId,
        dex: resolvedStore.dex,
        createdAt: Date.now(),
        note: note || undefined,
      };
      await writeManualLink(resolvedStore.storagePath, link);
      res.json({ success: true, link });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('already exists')) {
        res.status(409).json({ error: msg });
        return;
      }
      logger.error('Create manual link error', { error: msg });
      res.status(500).json({ error: 'Failed to create manual link' });
    }
  });

  // DELETE /api/analytics/link — remove a manual chain link
  router.delete('/link', async (req: Request, res: Response) => {
    try {
      const { oldTokenId, newTokenId } = req.body;

      if (!Number.isInteger(oldTokenId) || !Number.isInteger(newTokenId)) {
        res.status(400).json({ error: 'Both oldTokenId and newTokenId must be integers' });
        return;
      }

      const resolvedStore = await resolveManualLinkStoragePath(oldTokenId, newTokenId, storagePath, config, multiChain);
      const deleted = await deleteManualLink(resolvedStore.storagePath, oldTokenId, newTokenId, resolvedStore.dex);
      res.json({ success: true, deleted });
    } catch (err) {
      logger.error('Delete manual link error', { error: err instanceof Error ? err.message : String(err) });
      res.status(500).json({ error: 'Failed to delete manual link' });
    }
  });

  // ============================================================
  // DAILY EARNINGS — fees collected per day (rebalances + manual collections)
  // ============================================================

  // GET /api/analytics/earnings?tokenId=<optional>
  router.get('/earnings', async (req: Request, res: Response) => {
    try {
      const tokenIdParam = req.query.tokenId as string | undefined;
      const tokenId = tokenIdParam ? parseInt(tokenIdParam, 10) : undefined;
      if (tokenIdParam !== undefined && (isNaN(tokenId!) || tokenId! <= 0)) {
        res.status(400).json({ error: 'Invalid tokenId' });
        return;
      }

      // Fetch rebalances and fee collections from disk — scan all chain subdirs
      const [allRebalances, feeCollections] = await Promise.all([
        queryAllChainRebalances(storagePath),
        queryAllChainFeeCollections(storagePath, tokenId),
      ]);

      // Filter rebalances by tokenId if specified
      const rebalances = tokenId !== undefined
        ? allRebalances.filter(r => r.oldTokenId === tokenId || r.newTokenId === tokenId)
        : allRebalances;

      // Build per-position price lookup (tokenId -> {priceUsd0, priceUsd1}).
      // Uses current live prices — same approximation as the per-position analytics endpoint.
      // Positions no longer in config (burned/removed) will default to $0 fees.
      const positionPrices = new Map<number, { priceUsd0: number; priceUsd1: number }>();
      try {
        // Collect token addresses per position, grouped by chain slug for correct DexScreener lookups
        const posTokenAddrs = new Map<number, { addr0: string; addr1: string }>();
        const addrsBySlug = new Map<string, Set<string>>();

        await Promise.allSettled(
          config.positions.map(async (pos) => {
            const posChainId = multiChain ? multiChain.resolveChainId(pos) : config.chain.chainId;
            const posChain = multiChain ? multiChain.getChainById(posChainId) : chain;
            const posContracts = multiChain ? multiChain.getContracts(pos) : contracts;
            const slug = CHAIN_REGISTRY[posChainId]?.dexScreenerSlug ?? config.chain.dexScreenerSlug;
            const status = await getPositionStatus(pos.token_id, posContracts, posChain);
            posTokenAddrs.set(pos.token_id, {
              addr0: status.token0Info.address,
              addr1: status.token1Info.address,
            });
            if (!addrsBySlug.has(slug)) addrsBySlug.set(slug, new Set());
            addrsBySlug.get(slug)!.add(status.token0Info.address);
            addrsBySlug.get(slug)!.add(status.token1Info.address);
          }),
        );

        if (addrsBySlug.size > 0) {
          // Fetch prices per chain slug in parallel
          const slugPriceMaps = await Promise.all(
            Array.from(addrsBySlug.entries()).map(([slug, addrs]) =>
              getTokenPrices([...addrs], slug),
            ),
          );
          // Merge all price maps
          const allEarningsPrices = new Map<string, number>();
          for (const priceMap of slugPriceMaps) {
            for (const [addr, price] of priceMap) allEarningsPrices.set(addr, price);
          }
          for (const [tokenId_, { addr0, addr1 }] of posTokenAddrs) {
            positionPrices.set(tokenId_, {
              priceUsd0: allEarningsPrices.get(addr0.toLowerCase()) ?? 0,
              priceUsd1: allEarningsPrices.get(addr1.toLowerCase()) ?? 0,
            });
          }
        }
      } catch (err) {
        logger.warn('Earnings: price fetch failed, rebalance fees will show $0', {
          error: err instanceof Error ? err.message : String(err),
        });
      }

      // Aggregate fees by date (YYYY-MM-DD UTC)
      const dailyMap = new Map<string, number>();

      function toISODate(ts: number): string {
        return new Date(ts).toISOString().split('T')[0];
      }

      // Build set of rebalance collect txHashes to prevent double-counting
      // fee_collection records that overlap with fees already in rebalance records
      const rebalanceCollectTxHashes = new Set<string>();
      for (const rb of rebalances) {
        if (rb.txHashes.collectFees) rebalanceCollectTxHashes.add(rb.txHashes.collectFees);
        if (rb.txHashes.collectTokens) rebalanceCollectTxHashes.add(rb.txHashes.collectTokens);
      }

      for (const rb of rebalances) {
        const date = toISODate(rb.timestamp);
        let usd: number;
        if (rb.feesCollectedUsd != null && rb.feesCollectedUsd > 0) {
          // Prefer historically-accurate pre-computed value (stored at rebalance time)
          usd = rb.feesCollectedUsd;
        } else {
          // Legacy fallback: recalculate with stored or live prices
          const livePrices = positionPrices.get(rb.oldTokenId) ?? positionPrices.get(rb.newTokenId);
          const rbPrice0 = rb.priceUsd0 ?? livePrices?.priceUsd0 ?? 0;
          const rbPrice1 = rb.priceUsd1 ?? livePrices?.priceUsd1 ?? 0;
          const d0 = rb.preSnapshot.token0Decimals;
          const d1 = rb.preSnapshot.token1Decimals;
          usd =
            bigintToFloat(rb.feesCollected0, d0) * rbPrice0 +
            bigintToFloat(rb.feesCollected1, d1) * rbPrice1;
        }
        dailyMap.set(date, (dailyMap.get(date) ?? 0) + usd);
      }

      for (const fc of feeCollections) {
        // Skip fee collections already counted as part of a rebalance
        if (fc.txHash && rebalanceCollectTxHashes.has(fc.txHash)) continue;
        // FeeCollectionRecord stores totalValueUsd at time of collection — use directly
        const date = toISODate(fc.timestamp);
        dailyMap.set(date, (dailyMap.get(date) ?? 0) + fc.totalValueUsd);
      }

      // Sort by date ascending
      const result = Array.from(dailyMap.entries())
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([date, feesUsd]) => ({ date, feesUsd }));

      res.json(result);
    } catch (err) {
      logger.error('Daily earnings error', { error: err instanceof Error ? err.message : String(err) });
      res.status(500).json({ error: 'Failed to fetch daily earnings' });
    }
  });

  // ============================================================
  // ANALYTICS SUMMARY — background refresh cache
  // ============================================================
  // Heavy endpoint: RPC calls, disk reads, HTTP price fetches.
  // Instead of computing on every request (30s+), we cache the result
  // and refresh in the background every 2 minutes. First request
  // triggers an immediate build; subsequent requests return instantly.

  interface SummaryCache {
    data: Record<string, unknown> | null;
    lastUpdated: number;
    refreshing: boolean;
  }

  const summaryCache: SummaryCache = { data: null, lastUpdated: 0, refreshing: false };
  const SUMMARY_REFRESH_MS = 2 * 60 * 1000; // 2 minutes

  async function buildSummary(): Promise<Record<string, unknown>> {
    // Phase 1: Fetch all shared data in parallel (disk reads) — scan all chain subdirs
    const [allRebalances, allFeeCollections, allSnapshots, allEntries, allManualLinks] = await Promise.all([
      queryAllChainRebalances(storagePath),
      queryAllChainFeeCollections(storagePath),
      queryAllChainSnapshots(storagePath),
      queryAllChainPositionEntries(storagePath),
      queryAllChainManualLinks(storagePath),
    ]);

    // Phase 2: Fetch all position statuses in parallel with 15s per-position timeout
    // Prevents one slow/dead chain from blocking the entire summary
    const POS_TIMEOUT_MS = 15_000;
    const posChainIds: number[] = [];
    const statusResults = await Promise.allSettled(
      config.positions.map(async (pos) => {
        const posChainId = multiChain ? multiChain.resolveChainId(pos) : config.chain.chainId;
        posChainIds.push(posChainId);
        const posChain = multiChain ? multiChain.getChainById(posChainId) : chain;
        const posContracts = multiChain ? multiChain.getContracts(pos) : contracts;
        return Promise.race([
          getPositionStatus(pos.token_id, posContracts, posChain),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error(`Position #${pos.token_id} RPC timeout`)), POS_TIMEOUT_MS),
          ),
        ]);
      }),
    );

    // Phase 3: Batch token prices per chain slug (10s timeout)
    // Group token addresses by DexScreener slug so each chain's tokens are priced correctly
    const addrsBySlug = new Map<string, Set<string>>();
    for (let i = 0; i < config.positions.length; i++) {
      const chainId = posChainIds[i];
      const chainEntry = CHAIN_REGISTRY[chainId];
      const slug = chainEntry?.dexScreenerSlug ?? config.chain.dexScreenerSlug;
      if (!addrsBySlug.has(slug)) addrsBySlug.set(slug, new Set());
      const addrSet = addrsBySlug.get(slug)!;
      // Always include the chain's wrapped native token for gas cost conversion
      if (chainEntry?.wrappedNativeAddress) addrSet.add(chainEntry.wrappedNativeAddress);
      const result = statusResults[i];
      if (result.status === 'fulfilled') {
        addrSet.add(result.value.token0Info.address);
        addrSet.add(result.value.token1Info.address);
      }
    }
    let allPrices = new Map<string, number>();
    if (addrsBySlug.size > 0) {
      try {
        const priceFetches = Array.from(addrsBySlug.entries()).map(
          ([slug, addrs]) => getTokenPrices([...addrs], slug),
        );
        const results = await Promise.race([
          Promise.all(priceFetches),
          new Promise<Map<string, number>[]>((_, reject) =>
            setTimeout(() => reject(new Error('Price fetch timeout')), 10_000),
          ),
        ]);
        for (const priceMap of results) {
          for (const [addr, price] of priceMap) allPrices.set(addr, price);
        }
      } catch {
        logger.debug('Summary price fetch timed out — using $0 for valuations');
      }
    }

    // Phase 4: Compute per-position results (pure computation, no I/O)
    let totalValueUsd = 0;
    let totalFeesEarnedUsd = 0;
    let totalGasCostUsd = 0;
    let portfolioEntryCostUsd = 0;
    let portfolioHodlValueUsd = 0;
    let portfolioSwapFrictionUsd = 0;
    let allPositionsHaveCanonicalBasis = config.positions.length > 0;

    const positionResults: Array<Record<string, unknown>> = [];

    for (let i = 0; i < config.positions.length; i++) {
      const pos = config.positions[i];
      let valueUsd = 0;
      let feesEarnedUsd = 0;
      let pair = 'Unknown';
      let priceUsd0 = 0;
      let priceUsd1 = 0;

      // Resolve native token price for this position's chain (for gas cost USD conversion)
      const chainId = posChainIds[i];
      const chainEntry = CHAIN_REGISTRY[chainId];
      const nativeAddr = chainEntry?.wrappedNativeAddress ?? TOKENS.WPLS;
      const nativePriceUsd = allPrices.get(nativeAddr.toLowerCase()) ?? 0;

      const statusResult = statusResults[i];
      if (statusResult.status === 'fulfilled') {
        const status = statusResult.value;
        pair = `${status.token0Info.symbol}/${status.token1Info.symbol}`;

        priceUsd0 = allPrices.get(status.token0Info.address.toLowerCase()) ?? 0;
        priceUsd1 = allPrices.get(status.token1Info.address.toLowerCase()) ?? 0;

        const d0 = status.token0Info.decimals;
        const d1 = status.token1Info.decimals;
        valueUsd =
          bigintToFloat(status.amount0, d0) * priceUsd0 +
          bigintToFloat(status.amount1, d1) * priceUsd1;
      }

      const posChainId = posChainIds[i];
      const posScope = { chainId: posChainId, dex: pos.dex };
      const posRebalances = allRebalances.filter(
        (r) => (r.oldTokenId === pos.token_id || r.newTokenId === pos.token_id)
          && (posScope.chainId === undefined || r.chainId === undefined || r.chainId === posScope.chainId)
          && (posScope.dex === undefined || r.dex === undefined || r.dex === posScope.dex),
      );
      for (const rb of posRebalances) {
        void rb;
      }

      const posCollections = allFeeCollections.filter((fc) => fc.tokenId === pos.token_id);

      const posSnapshots = allSnapshots.filter((s) => s.tokenId === pos.token_id);
      const timeInRangePercent = estimateTimeInRange(posSnapshots);
      const avgAPR = posRebalances.length > 0
        ? posRebalances.reduce((sum, r) => sum + r.metrics.feeAPR, 0) / posRebalances.length
        : 0;

      const liveState = statusResult.status === 'fulfilled'
        ? {
            tokenId: pos.token_id,
            chainId: posChainId,
            dex: pos.dex,
            timestamp: Date.now(),
            currentPositionValueUsd: valueUsd,
            currentUnclaimedFeesUsd:
              bigintToFloat(statusResult.value.unclaimedFees0, statusResult.value.token0Info.decimals) * priceUsd0 +
              bigintToFloat(statusResult.value.unclaimedFees1, statusResult.value.token1Info.decimals) * priceUsd1,
            priceUsd0,
            priceUsd1,
            nativePriceUsd,
            token0Symbol: statusResult.value.token0Info.symbol,
            token1Symbol: statusResult.value.token1Info.symbol,
            token0Decimals: statusResult.value.token0Info.decimals,
            token1Decimals: statusResult.value.token1Info.decimals,
            source: 'live' as const,
            priceStatus: 'live' as const,
          }
        : undefined;

      const canonicalSummary = buildLineageAnalyticsSummary({
        requestedTokenId: pos.token_id,
        requestedChainId: posChainId,
        requestedDex: pos.dex,
        rebalances: allRebalances,
        feeCollections: allFeeCollections,
        snapshots: allSnapshots,
        positionEntries: allEntries,
        manualLinks: allManualLinks,
        liveState,
      });

      const feesTotalUsd = canonicalSummary.lifetimeChain.totalFeesUsd;
      const gasCostUsd = canonicalSummary.lifetimeChain.totalGasCostUsd;
      const netPnl = canonicalSummary.lifetimeChain.netIncomeUsd;
      const canonicalPnl = canonicalSummary.lifetimeChain.truePnlUsd;
      const { score, label } = calculateHealthScore({
        netPnlUsd: canonicalPnl ?? netPnl, avgFeeAPR: avgAPR, timeInRangePercent,
      });

      // Per-position IL: compare first priced snapshot's value to current value.
      // Uses stored positionValueUsd (real historical price anchor) vs current live value.
      // Falls back to 0 if no priced snapshots exist (pre-feature positions).
      let positionILPercent = 0;
      const firstPricedSnap = posSnapshots.find((s) => s.positionValueUsd > 0);
      if (firstPricedSnap && valueUsd > 0 && firstPricedSnap.positionValueUsd > 0) {
        // IL = (current LP value - HODL value) / HODL value
        // HODL value: hold original tokens at current prices (approximated by scaling initial value)
        // We compare LP value (rebalanced) to what the original deposit would be worth HODL-ing.
        // Simplified: use stored IL from rebalance records when available, else derive from value delta.
        if (posRebalances.length > 0) {
          positionILPercent = posRebalances.reduce((sum, r) => sum + r.metrics.impermanentLossPercent, 0) / posRebalances.length;
        } else {
          // No rebalances — approximate IL as (currentValue - initialValue) / initialValue
          // adjusted for fee earnings (not true IL, but useful directional signal)
          positionILPercent = ((valueUsd - firstPricedSnap.positionValueUsd) / firstPricedSnap.positionValueUsd) * 100;
        }
      }

      totalValueUsd += canonicalSummary.lifetimeChain.currentPositionValueUsd;
      totalFeesEarnedUsd += feesTotalUsd;
      totalGasCostUsd += gasCostUsd;
      portfolioSwapFrictionUsd += canonicalSummary.lifetimeChain.totalSwapFrictionUsd;

      if (canonicalSummary.lifetimeChain.entryCostUsd !== null) {
        portfolioEntryCostUsd += canonicalSummary.lifetimeChain.entryCostUsd;
        portfolioHodlValueUsd += canonicalSummary.lifetimeChain.hodlValueUsd ?? 0;
      } else {
        allPositionsHaveCanonicalBasis = false;
      }

      positionResults.push({
        tokenId: pos.token_id, pair, strategy: pos.strategy,
        valueUsd: canonicalSummary.lifetimeChain.currentPositionValueUsd,
        feesEarnedUsd: feesTotalUsd,
        gasCostUsd,
        netPnlUsd: netPnl,
        healthScore: score, healthLabel: label,
        ilPercent: positionILPercent,
        entryCostUsd: canonicalSummary.lifetimeChain.entryCostUsd,
        hodlValueUsd: canonicalSummary.lifetimeChain.hodlValueUsd,
        totalPnlUsd: canonicalSummary.lifetimeChain.truePnlUsd,
        totalPnlPercent: canonicalSummary.lifetimeChain.truePnlPercent,
        swapFrictionUsd: canonicalSummary.lifetimeChain.totalSwapFrictionUsd,
      });
    }

    // Portfolio-level IL: weighted average of per-position IL by position value.
    // Positions with zero value are excluded from the weight (they can't contribute to IL).
    let portfolioILPercent = 0;
    let weightedILSum = 0;
    let weightedILTotal = 0;
    for (const pos of positionResults) {
      const v = (pos as Record<string, number>).valueUsd ?? 0;
      const il = (pos as Record<string, number>).ilPercent ?? 0;
      if (v > 0) {
        weightedILSum += il * v;
        weightedILTotal += v;
      }
    }
    if (weightedILTotal > 0) {
      portfolioILPercent = weightedILSum / weightedILTotal;
    }

    // Portfolio-level true P&L aggregation from canonical lineage summaries
    const portfolioTotalPnlUsd = allPositionsHaveCanonicalBasis
      ? (totalValueUsd + totalFeesEarnedUsd) - (portfolioEntryCostUsd + totalGasCostUsd + portfolioSwapFrictionUsd)
      : null;
    const portfolioTotalPnlPercent = allPositionsHaveCanonicalBasis && portfolioEntryCostUsd > 0
      ? (portfolioTotalPnlUsd! / portfolioEntryCostUsd) * 100
      : null;
    const portfolioLpVsHodlPercent = allPositionsHaveCanonicalBasis && portfolioHodlValueUsd > 0
      ? (((totalValueUsd + totalFeesEarnedUsd - totalGasCostUsd - portfolioSwapFrictionUsd) - portfolioHodlValueUsd) / portfolioHodlValueUsd) * 100
      : null;

    return {
      totalPositions: config.positions.length,
      totalValueUsd, totalFeesEarnedUsd, totalGasCostUsd,
      netPnlUsd: totalFeesEarnedUsd - totalGasCostUsd,
      portfolioILPercent,
      // True P&L (null when no entry data exists)
      portfolioEntryCostUsd: allPositionsHaveCanonicalBasis ? portfolioEntryCostUsd : null,
      portfolioTotalPnlUsd,
      portfolioTotalPnlPercent,
      portfolioLpVsHodlPercent,
      portfolioSwapFrictionUsd,
      positions: positionResults,
    };
  }

  /** Trigger a background refresh — never throws, never blocks the caller. */
  function triggerSummaryRefresh(): void {
    if (summaryCache.refreshing) return;
    summaryCache.refreshing = true;
    buildSummary()
      .then((data) => {
        summaryCache.data = data;
        summaryCache.lastUpdated = Date.now();
        logger.debug('Analytics summary cache refreshed');
      })
      .catch((err) => {
        logger.warn(`Analytics summary refresh failed: ${err instanceof Error ? err.message : String(err)}`);
      })
      .finally(() => {
        summaryCache.refreshing = false;
      });
  }

  // Kick off first build immediately so the cache is warm by the time the user loads the page
  triggerSummaryRefresh();

  // Background refresh timer
  setInterval(triggerSummaryRefresh, SUMMARY_REFRESH_MS);

  router.get('/summary', (_req: Request, res: Response) => {
    // If cache is warm, return instantly
    if (summaryCache.data) {
      const age = Date.now() - summaryCache.lastUpdated;
      res.json({
        ...summaryCache.data,
        _cached: true,
        _ageSeconds: Math.round(age / 1000),
        _refreshing: summaryCache.refreshing,
      });

      // If stale, trigger a background refresh for the next request
      if (age > SUMMARY_REFRESH_MS && !summaryCache.refreshing) {
        triggerSummaryRefresh();
      }
      return;
    }

    // Cache is cold (first request before background build completes) — wait up to 60s
    if (!summaryCache.refreshing) {
      triggerSummaryRefresh();
    }

    const startWait = Date.now();
    const poll = setInterval(() => {
      if (summaryCache.data) {
        clearInterval(poll);
        if (!res.headersSent) {
          res.json({ ...summaryCache.data, _cached: false });
        }
      } else if (Date.now() - startWait > 60_000) {
        clearInterval(poll);
        if (!res.headersSent) {
          res.status(504).json({ error: 'Summary is still loading — try again in a moment' });
        }
      }
    }, 500);
  });

  return router;
}

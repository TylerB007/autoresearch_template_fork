/**
 * Structured analytics export for LLM analysis and external consumption.
 * Aggregates all analytics data into a comprehensive JSON report.
 */

import type { RebalanceAnalytics, PositionSnapshot } from './types.js';
import { buildLineageAnalyticsSummary } from './lineageSummary.js';
import { queryAllChainFeeCollections, queryAllChainManualLinks, queryAllChainPositionEntries, queryAllChainRebalances, queryAllChainSnapshots, querySnapshots } from './storage.js';
import { estimateTimeInRange } from './metrics.js';
import { calculateTickVolatility, type VolatilityResult } from './volatility.js';
import { buildPositionChain, type ChainAggregate } from './chain.js';

// ============================================================
// TYPES
// ============================================================

export interface ExportOptions {
  days: number;
  tokenIds?: number[];
}

export interface PerPositionSummary {
  tokenId: number;
  pair: string;
  strategy: string;
  chainId?: number;
  dex?: string;
  rebalanceCount: number;
  avgTimeInRangePercent: number;
  totalFeesCollected0: string;
  totalFeesCollected1: string;
  totalGasCostPLS: number;
  avgFeeAPR: number;
  avgImpermanentLossPercent: number;
  avgNetROIPercent: number;
  currentValueUsd: number;
  totalFeesUsd: number;
  totalGasCostUsd: number;
  totalSwapFrictionUsd: number;
  totalPriceDisadvantageUsd: number;
  totalCostsUsd: number;
  entryCostUsd: number | null;
  truePnlUsd: number | null;
  truePnlPercent: number | null;
  lpVsHodlUsd: number | null;
  lpVsHodlPercent: number | null;
  profitabilityTrust?: string;
  chainSummary?: ChainAggregate;
  durationDays: number;
}

export interface PerRebalanceDetail {
  rebalanceId: string;
  timestamp: number;
  tokenId: number;
  strategy: string;
  timeSincePreviousSeconds: number;
  feesCollected0: string;
  feesCollected1: string;
  gasCostPLS: number;
  configuredSlippageToleranceBps?: number;
  realizedExecutionDeltaBps: number;
  rebalanceCostPercent: number;
  feeAPR: number;
  netROIPercent: number;
  rawFeeYieldPercent: number;
  oldRange: { tickLower: number; tickUpper: number };
  newRange: { tickLower: number; tickUpper: number };
}

export interface AggregateStats {
  totalPositions: number;
  totalRebalances: number;
  rebalancesPerDay: number;
  medianTimeBetweenRebalancesHours: number;
  totalGasCostPLS: number;
  byStrategy: Record<string, {
    rebalanceCount: number;
    avgFeeAPR: number;
    avgTimeInRange: number;
  }>;
}

export interface MarketContext {
  periodStart: number;
  periodEnd: number;
  volatility?: VolatilityResult;
}

export interface AnalyticsExportReport {
  exportedAt: number;
  periodDays: number;
  positions: PerPositionSummary[];
  rebalances: PerRebalanceDetail[];
  aggregateStats: AggregateStats;
  marketContext: MarketContext;
}

// ============================================================
// EXPORT BUILDER
// ============================================================

export async function buildExportReport(
  storagePath: string,
  options: ExportOptions,
): Promise<AnalyticsExportReport> {
  const now = Date.now();
  const startTime = now - options.days * 86400 * 1000;

  // Query all data
  const [allRebalances, allFeeCollections, allSnapshots, allEntries, allManualLinks] = await Promise.all([
    queryAllChainRebalances(storagePath, startTime),
    queryAllChainFeeCollections(storagePath),
    queryAllChainSnapshots(storagePath),
    queryAllChainPositionEntries(storagePath),
    queryAllChainManualLinks(storagePath),
  ]);

  // Filter by tokenIds if specified
  let rebalances = allRebalances;
  if (options.tokenIds && options.tokenIds.length > 0) {
    const ids = new Set(options.tokenIds);
    rebalances = allRebalances.filter(
      (r) => ids.has(r.oldTokenId) || ids.has(r.newTokenId),
    );
  }

  // Build per-rebalance details
  const rebalanceDetails: PerRebalanceDetail[] = [];
  for (let i = 0; i < rebalances.length; i++) {
    const rb = rebalances[i];
    const prevTimestamp = i > 0 ? rebalances[i - 1].timestamp : rb.timestamp - rb.metrics.durationSeconds * 1000;
    const timeSince = (rb.timestamp - prevTimestamp) / 1000;

    rebalanceDetails.push({
      rebalanceId: rb.rebalanceId,
      timestamp: rb.timestamp,
      tokenId: rb.oldTokenId,
      strategy: String(rb.strategy),
      timeSincePreviousSeconds: timeSince,
      feesCollected0: rb.feesCollected0.toString(),
      feesCollected1: rb.feesCollected1.toString(),
      gasCostPLS: rb.totalGasCostPLS,
      configuredSlippageToleranceBps: rb.swap?.configuredSlippageBps,
      realizedExecutionDeltaBps: Math.min(rb.swap?.realizedExecutionDeltaBps ?? rb.swap?.slippageBps ?? 0, 500),
      rebalanceCostPercent: rb.metrics.rebalanceCostPercent ?? 0,
      feeAPR: rb.metrics.feeAPR,
      netROIPercent: rb.metrics.netROIPercent,
      rawFeeYieldPercent: rb.metrics.rawFeeYieldPercent ?? 0,
      oldRange: {
        tickLower: rb.preSnapshot.tickLower,
        tickUpper: rb.preSnapshot.tickUpper,
      },
      newRange: {
        tickLower: rb.newTickLower,
        tickUpper: rb.newTickUpper,
      },
    });
  }

  // Build per-position summaries
  const positionMap = new Map<number, RebalanceAnalytics[]>();
  for (const rb of rebalances) {
    // Group by the active (new) token ID
    const existing = positionMap.get(rb.newTokenId) ?? [];
    existing.push(rb);
    positionMap.set(rb.newTokenId, existing);
  }

  const positions: PerPositionSummary[] = [];
  for (const [tokenId, posRebalances] of positionMap) {
    const requestedChainId = posRebalances[0]?.chainId;
    const requestedDex = posRebalances[0]?.dex;
    const snapshots = allSnapshots.filter(
      (snapshot) => snapshot.tokenId === tokenId
        && (requestedChainId === undefined || snapshot.chainId === undefined || snapshot.chainId === requestedChainId)
        && (requestedDex === undefined || snapshot.dex === undefined || snapshot.dex === requestedDex)
        && snapshot.timestamp >= startTime,
    );
    const timeInRange = estimateTimeInRange(snapshots);

    let totalFees0 = 0n;
    let totalFees1 = 0n;
    let totalGas = 0;
    let aprSum = 0;
    let ilSum = 0;
    let roiSum = 0;

    for (const rb of posRebalances) {
      totalFees0 += rb.feesCollected0;
      totalFees1 += rb.feesCollected1;
      totalGas += rb.totalGasCostPLS;
      aprSum += rb.metrics.feeAPR;
      ilSum += rb.metrics.impermanentLossPercent;
      roiSum += rb.metrics.netROIPercent;
    }

    const count = posRebalances.length;
    const first = posRebalances[0];
    const pair = `${first.preSnapshot.token0Symbol}/${first.preSnapshot.token1Symbol}`;
    const durationMs = now - (snapshots.length > 0 ? snapshots[0].timestamp : first.timestamp);

    // Try to build chain summary
    let chainSummary: ChainAggregate | undefined;
    try {
      const chain = await buildPositionChain(tokenId, storagePath);
      if (chain) chainSummary = chain.aggregate;
    } catch { /* non-fatal */ }

    const canonicalSummary = buildLineageAnalyticsSummary({
      requestedTokenId: tokenId,
      requestedChainId,
      requestedDex,
      rebalances: allRebalances,
      feeCollections: allFeeCollections,
      snapshots: allSnapshots,
      positionEntries: allEntries,
      manualLinks: allManualLinks,
    });

    positions.push({
      tokenId,
      pair,
      strategy: String(first.strategy),
      chainId: requestedChainId,
      dex: requestedDex,
      rebalanceCount: count,
      avgTimeInRangePercent: timeInRange,
      totalFeesCollected0: totalFees0.toString(),
      totalFeesCollected1: totalFees1.toString(),
      totalGasCostPLS: totalGas,
      avgFeeAPR: count > 0 ? aprSum / count : 0,
      avgImpermanentLossPercent: count > 0 ? ilSum / count : 0,
      avgNetROIPercent: count > 0 ? roiSum / count : 0,
      currentValueUsd: canonicalSummary.lifetimeChain.currentPositionValueUsd,
      totalFeesUsd: canonicalSummary.lifetimeChain.totalFeesUsd,
      totalGasCostUsd: canonicalSummary.lifetimeChain.totalGasCostUsd,
      totalSwapFrictionUsd: canonicalSummary.lifetimeChain.totalSwapFrictionUsd,
      totalPriceDisadvantageUsd: canonicalSummary.lifetimeChain.totalPriceDisadvantageUsd,
      totalCostsUsd: canonicalSummary.lifetimeChain.totalCostsUsd,
      entryCostUsd: canonicalSummary.lifetimeChain.entryCostUsd,
      truePnlUsd: canonicalSummary.lifetimeChain.truePnlUsd,
      truePnlPercent: canonicalSummary.lifetimeChain.truePnlPercent,
      lpVsHodlUsd: canonicalSummary.lifetimeChain.lpVsHodlUsd,
      lpVsHodlPercent: canonicalSummary.lifetimeChain.lpVsHodlPercent,
      profitabilityTrust: canonicalSummary.lifetimeChain.trust.overall,
      chainSummary,
      durationDays: durationMs / (1000 * 86400),
    });
  }

  // Aggregate stats
  const timeBetween: number[] = [];
  for (let i = 1; i < rebalances.length; i++) {
    timeBetween.push((rebalances[i].timestamp - rebalances[i - 1].timestamp) / (1000 * 3600));
  }
  timeBetween.sort((a, b) => a - b);
  const medianTimeBetween = timeBetween.length > 0
    ? timeBetween[Math.floor(timeBetween.length / 2)]
    : 0;

  const byStrategy: AggregateStats['byStrategy'] = {};
  for (const rb of rebalances) {
    const strat = String(rb.strategy);
    if (!byStrategy[strat]) {
      byStrategy[strat] = { rebalanceCount: 0, avgFeeAPR: 0, avgTimeInRange: 0 };
    }
    byStrategy[strat].rebalanceCount++;
    byStrategy[strat].avgFeeAPR += rb.metrics.feeAPR;
  }
  for (const strat of Object.keys(byStrategy)) {
    const count = byStrategy[strat].rebalanceCount;
    if (count > 0) byStrategy[strat].avgFeeAPR /= count;
  }

  // Market context with volatility from most recent snapshots
  let volatility: VolatilityResult | undefined;
  try {
    // Get snapshots from the last hour for any position
    const tokenIds = options.tokenIds ?? [...positionMap.keys()];
    if (tokenIds.length > 0) {
      const recentSnaps = await querySnapshots(storagePath, tokenIds[0], now - 3600 * 1000);
      if (recentSnaps.length >= 2) {
        volatility = calculateTickVolatility(recentSnaps, 60);
      }
    }
  } catch { /* non-fatal */ }

  return {
    exportedAt: now,
    periodDays: options.days,
    positions,
    rebalances: rebalanceDetails,
    aggregateStats: {
      totalPositions: positions.length,
      totalRebalances: rebalances.length,
      rebalancesPerDay: options.days > 0 ? rebalances.length / options.days : 0,
      medianTimeBetweenRebalancesHours: medianTimeBetween,
      totalGasCostPLS: rebalances.reduce((sum, r) => sum + r.totalGasCostPLS, 0),
      byStrategy,
    },
    marketContext: {
      periodStart: startTime,
      periodEnd: now,
      volatility,
    },
  };
}

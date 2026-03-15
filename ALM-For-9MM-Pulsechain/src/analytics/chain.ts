/**
 * Position lineage chain — traces the full history of a position through
 * all its rebalances, aggregating lifetime metrics across NFT burns/mints.
 *
 * Each rebalance burns the old NFT and mints a new one. This module follows
 * the oldTokenId → newTokenId links to reconstruct the complete chain.
 */

import type { RebalanceAnalytics, PositionSnapshot, ManualLink } from './types.js';
import { queryRebalances, querySnapshots, readManualLinks } from './storage.js';
import { estimateTimeInRange } from './metrics.js';

// ============================================================
// TYPES
// ============================================================

export interface ChainLink {
  tokenId: number;
  strategy: string;
  tickLower: number;
  tickUpper: number;
  widthTicks: number;
  mintTimestamp: number;
  burnTimestamp: number | null; // null = active position
  durationMs: number;
  feesCollected0: string; // stringified BigInt
  feesCollected1: string;
  gasCostPLS: number;
  swapExecDeltaBps: number;
  rebalanceCostPercent: number;
  timeInRangePercent: number;
  feeAPR: number;
  netROIPercent: number;
  rebalanceId: string | null; // null for the first link (original mint)
  isManualLink: boolean;      // true if user-created via /link command
}

export interface ChainAggregate {
  totalRebalances: number;
  totalFeesCollected0: string;
  totalFeesCollected1: string;
  totalGasCostPLS: number;
  avgExecDeltaBps: number;
  totalDurationMs: number;
  avgTimeInRangePercent: number;
  avgFeeAPR: number;
  cumulativeNetROIPercent: number;
  firstSeen: number;
  lastSeen: number;
}

export interface PositionChain {
  rootTokenId: number;
  currentTokenId: number;
  links: ChainLink[];
  aggregate: ChainAggregate;
}

function matchesScope(
  candidate: { chainId?: number; dex?: string },
  scope?: { chainId?: number; dex?: string },
): boolean {
  if (!scope) return true;
  if (scope.chainId !== undefined && candidate.chainId !== undefined && candidate.chainId !== scope.chainId) {
    return false;
  }
  if (scope.dex !== undefined && candidate.dex !== undefined && candidate.dex !== scope.dex) {
    return false;
  }
  return true;
}

// ============================================================
// CHAIN BUILDER
// ============================================================

/** Sentinel rebalanceId used to identify manual link stubs. */
const MANUAL_LINK_ID = 'manual-link';

/**
 * Create a minimal RebalanceAnalytics stub for a manual link.
 * The chain builder uses oldTokenId/newTokenId for traversal;
 * all amounts/fees/gas are zeroed since we don't know the execution details.
 */
function createManualLinkStub(ml: ManualLink): RebalanceAnalytics {
  const zeroSnapshot = {
    timestamp: ml.createdAt,
    tokenId: ml.oldTokenId,
    liquidity: 0n,
    tickLower: 0,
    tickUpper: 0,
    amount0: 0n,
    amount1: 0n,
    currentTick: 0,
    sqrtPriceX96: 0n,
    poolLiquidity: 0n,
    isInRange: false,
    tickDistance: 0,
    tokensOwed0: 0n,
    tokensOwed1: 0n,
    token0Symbol: '',
    token1Symbol: '',
    token0Decimals: 0,
    token1Decimals: 0,
    poolFee: 0,
    priceUsd0: 0,
    priceUsd1: 0,
    nativePriceUsd: 0,
    positionValueUsd: 0,
    unclaimedFeesUsd: 0,
  };

  return {
    timestamp: ml.createdAt,
    rebalanceId: MANUAL_LINK_ID,
    oldTokenId: ml.oldTokenId,
    newTokenId: ml.newTokenId,
    strategy: 'unknown' as never,
    preSnapshot: { ...zeroSnapshot },
    postSnapshot: { ...zeroSnapshot, tokenId: ml.newTokenId },
    txHashes: { collectFees: '', decreaseLiquidity: '', collectTokens: '', burn: '', mint: '' },
    feesCollected0: 0n,
    feesCollected1: 0n,
    liquidityRemoved0: 0n,
    liquidityRemoved1: 0n,
    newLiquidity: 0n,
    newAmount0: 0n,
    newAmount1: 0n,
    newTickLower: 0,
    newTickUpper: 0,
    gasUsed: {
      collectFees: 0n, decreaseLiquidity: 0n, collectTokens: 0n,
      burn: 0n, swap: 0n, approvals: 0n, mint: 0n, total: 0n,
    },
    gasPrice: 0n,
    totalGasCostPLS: 0,
    metrics: {
      durationSeconds: 0, durationDays: 0, feeAPR: 0, rawFeeYieldPercent: 0,
      capitalEfficiencyRatio: 0, timeInRangePercent: 0, feesToCostRatio: 0,
      impermanentLossPercent: 0, netROIPercent: 0, trueNetROIPercent: 0,
      rebalanceCostPercent: 0, rebalanceCostToken0: 0,
    },
  };
}

/**
 * Build the full position chain for a given token ID.
 * Walks backward to find the root ancestor, then forward to build links.
 */
export async function buildPositionChain(
  tokenId: number,
  storagePath: string,
  scope?: { chainId?: number; dex?: string },
): Promise<PositionChain | null> {
  const allRebalances = (await queryRebalances(storagePath)).filter((rebalance) => matchesScope(rebalance, scope));
  const manualLinks = (await readManualLinks(storagePath)).filter((link) => matchesScope(link, scope));

  if (allRebalances.length === 0 && manualLinks.length === 0) return null;

  // Build lookup maps
  const byOldToken = new Map<number, RebalanceAnalytics>();
  const byNewToken = new Map<number, RebalanceAnalytics>();
  for (const rb of allRebalances) {
    byOldToken.set(rb.oldTokenId, rb);
    byNewToken.set(rb.newTokenId, rb);
  }

  // Inject manual links (only where no real rebalance already covers the gap)
  for (const ml of manualLinks) {
    if (!byOldToken.has(ml.oldTokenId)) {
      const stub = createManualLinkStub(ml);
      byOldToken.set(ml.oldTokenId, stub);
      byNewToken.set(ml.newTokenId, stub);
    }
  }

  // Walk backward to find root ancestor
  let rootId = tokenId;
  const visited = new Set<number>();
  while (byNewToken.has(rootId) && !visited.has(rootId)) {
    visited.add(rootId);
    rootId = byNewToken.get(rootId)!.oldTokenId;
  }

  // Walk forward from root, collecting rebalance chain
  const rebalances: RebalanceAnalytics[] = [];
  let currentId = rootId;
  visited.clear();
  while (byOldToken.has(currentId) && !visited.has(currentId)) {
    visited.add(currentId);
    const rb = byOldToken.get(currentId)!;
    rebalances.push(rb);
    currentId = rb.newTokenId;
  }
  const finalTokenId = currentId;

  // If no rebalances found and the requested tokenId doesn't match any chain, return null
  if (rebalances.length === 0 && rootId !== tokenId) return null;

  // Build chain links
  const links: ChainLink[] = [];

  // First link: the root position (before any rebalance)
  if (rebalances.length > 0) {
    const firstRb = rebalances[0];
    const rootSnapshots = (await querySnapshots(storagePath, rootId)).filter((snapshot) => matchesScope(snapshot, scope));
    const rootTimeInRange = estimateTimeInRange(rootSnapshots);
    const rootMintTime = rootSnapshots.length > 0
      ? rootSnapshots[0].timestamp
      : firstRb.timestamp - firstRb.metrics.durationSeconds * 1000;

    links.push({
      tokenId: rootId,
      strategy: String(firstRb.strategy),
      tickLower: firstRb.preSnapshot.tickLower,
      tickUpper: firstRb.preSnapshot.tickUpper,
      widthTicks: firstRb.preSnapshot.tickUpper - firstRb.preSnapshot.tickLower,
      mintTimestamp: rootMintTime,
      burnTimestamp: firstRb.timestamp,
      durationMs: firstRb.timestamp - rootMintTime,
      feesCollected0: firstRb.feesCollected0.toString(),
      feesCollected1: firstRb.feesCollected1.toString(),
      gasCostPLS: firstRb.totalGasCostPLS,
      swapExecDeltaBps: Math.min(firstRb.swap?.realizedExecutionDeltaBps ?? firstRb.swap?.slippageBps ?? 0, 500),
      rebalanceCostPercent: firstRb.metrics.rebalanceCostPercent ?? 0,
      timeInRangePercent: rootTimeInRange,
      feeAPR: firstRb.metrics.feeAPR,
      netROIPercent: firstRb.metrics.netROIPercent,
      rebalanceId: null, // First link has no preceding rebalance
      isManualLink: false,
    });
  } else {
    // Single position with no rebalances — still build a 1-link chain
    const snapshots = (await querySnapshots(storagePath, tokenId)).filter((snapshot) => matchesScope(snapshot, scope));
    if (snapshots.length === 0) return null;

    const timeInRange = estimateTimeInRange(snapshots);
    links.push({
      tokenId,
      strategy: 'unknown',
      tickLower: snapshots[0].tickLower,
      tickUpper: snapshots[0].tickUpper,
      widthTicks: snapshots[0].tickUpper - snapshots[0].tickLower,
      mintTimestamp: snapshots[0].timestamp,
      burnTimestamp: null,
      durationMs: Date.now() - snapshots[0].timestamp,
      feesCollected0: '0',
      feesCollected1: '0',
      gasCostPLS: 0,
      swapExecDeltaBps: 0,
      rebalanceCostPercent: 0,
      timeInRangePercent: timeInRange,
      feeAPR: 0,
      netROIPercent: 0,
      rebalanceId: null,
      isManualLink: false,
    });
  }

  // Subsequent links: each rebalance creates a new link
  for (let i = 0; i < rebalances.length; i++) {
    const rb = rebalances[i];
    const isLast = i === rebalances.length - 1;
    const nextRb = isLast ? null : rebalances[i + 1];

    const burnTime = nextRb ? nextRb.timestamp : null;
    const mintTime = rb.timestamp;
    const durationMs = burnTime
      ? burnTime - mintTime
      : Date.now() - mintTime;

    // Get snapshots for this intermediate/final position
    const snapshots = (await querySnapshots(storagePath, rb.newTokenId)).filter((snapshot) => matchesScope(snapshot, scope));
    const timeInRange = estimateTimeInRange(snapshots);

    // For intermediate links, fees come from the NEXT rebalance (when that position was burned)
    const feesCollected0 = nextRb ? nextRb.feesCollected0.toString() : '0';
    const feesCollected1 = nextRb ? nextRb.feesCollected1.toString() : '0';
    const gasCost = nextRb ? nextRb.totalGasCostPLS : 0;
      const slippage = Math.min(nextRb?.swap?.realizedExecutionDeltaBps ?? nextRb?.swap?.slippageBps ?? 0, 500);
    const rebalanceCost = nextRb?.metrics.rebalanceCostPercent ?? 0;
    const feeAPR = nextRb ? nextRb.metrics.feeAPR : 0;
    const netROI = nextRb ? nextRb.metrics.netROIPercent : 0;

    links.push({
      tokenId: rb.newTokenId,
      strategy: String(rb.strategy),
      tickLower: rb.newTickLower,
      tickUpper: rb.newTickUpper,
      widthTicks: rb.newTickUpper - rb.newTickLower,
      mintTimestamp: mintTime,
      burnTimestamp: burnTime,
      durationMs,
      feesCollected0,
      feesCollected1,
      gasCostPLS: gasCost,
      swapExecDeltaBps: slippage,
      rebalanceCostPercent: rebalanceCost,
      timeInRangePercent: timeInRange,
      feeAPR,
      netROIPercent: netROI,
      rebalanceId: rb.rebalanceId,
      isManualLink: rb.rebalanceId === MANUAL_LINK_ID,
    });
  }

  // Compute aggregate
  let totalFees0 = 0n;
  let totalFees1 = 0n;
  let totalGas = 0;
  let totalExecDelta = 0;
  let execDeltaCount = 0;
  let totalDuration = 0;
  let weightedTimeInRange = 0;
  let aprSum = 0;
  let aprCount = 0;
  let roiSum = 0;

  for (const link of links) {
    totalFees0 += BigInt(link.feesCollected0);
    totalFees1 += BigInt(link.feesCollected1);
    totalGas += link.gasCostPLS;
    if (link.swapExecDeltaBps > 0) {
      totalExecDelta += link.swapExecDeltaBps;
      execDeltaCount++;
    }
    totalDuration += link.durationMs;
    weightedTimeInRange += link.timeInRangePercent * link.durationMs;
    if (link.feeAPR > 0) {
      aprSum += link.feeAPR;
      aprCount++;
    }
    roiSum += link.netROIPercent;
  }

  const aggregate: ChainAggregate = {
    totalRebalances: rebalances.length,
    totalFeesCollected0: totalFees0.toString(),
    totalFeesCollected1: totalFees1.toString(),
    totalGasCostPLS: totalGas,
    avgExecDeltaBps: execDeltaCount > 0 ? totalExecDelta / execDeltaCount : 0,
    totalDurationMs: totalDuration,
    avgTimeInRangePercent: totalDuration > 0 ? weightedTimeInRange / totalDuration : 0,
    avgFeeAPR: aprCount > 0 ? aprSum / aprCount : 0,
    cumulativeNetROIPercent: roiSum,
    firstSeen: links[0].mintTimestamp,
    lastSeen: Date.now(),
  };

  return {
    rootTokenId: rootId,
    currentTokenId: finalTokenId,
    links,
    aggregate,
  };
}

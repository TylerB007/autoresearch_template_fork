/**
 * Performance metric calculations for V3 concentrated liquidity positions.
 * All core calculations use BigInt; floating-point only for final display metrics.
 * Reuses existing math functions from src/math.ts.
 */

import type { RebalanceAnalytics, RebalanceMetrics, PositionSnapshot } from './types.js';
import { bigintToFloat, sqrtPriceX96ToPrice } from '../bigintFloat.js';

/**
 * Convert the native-currency gas cost (e.g. PLS, ETH) to token0-equivalent units
 * so it can be subtracted from fee/capital values that are also in token0-equivalent.
 *
 * Without this conversion, subtracting totalGasCostPLS (in PLS) from feesValue (in HEX-equiv)
 * produces a dimensionally wrong result — e.g. for HEX/WPLS where 1 HEX ≈ 1000 PLS,
 * gas would appear ~1000x more expensive than it actually is.
 */
function gasCostInToken0Equiv(analytics: RebalanceAnalytics): number {
  // Primary: gasCostUsd / priceUsd0 — both historically priced at rebalance time
  if (typeof analytics.gasCostUsd === 'number' && analytics.gasCostUsd > 0 &&
      typeof analytics.priceUsd0 === 'number' && analytics.priceUsd0 > 0) {
    return analytics.gasCostUsd / analytics.priceUsd0;
  }
  // Secondary: derive via native token and token0 USD prices
  if (typeof analytics.nativeTokenPriceUsd === 'number' && analytics.nativeTokenPriceUsd > 0 &&
      typeof analytics.priceUsd0 === 'number' && analytics.priceUsd0 > 0) {
    return (analytics.totalGasCostPLS * analytics.nativeTokenPriceUsd) / analytics.priceUsd0;
  }
  // Fallback: no price data — return 0 rather than the wrong-unit totalGasCostPLS.
  // Metrics will be slightly optimistic (gas excluded) but not nonsensical.
  return 0;
}

/**
 * Calculate all metrics for a completed rebalance.
 */
export function calculateRebalanceMetrics(
  analytics: RebalanceAnalytics,
  previousRebalanceTimestamp?: number,
): RebalanceMetrics {
  const pre = analytics.preSnapshot;
  const post = analytics.postSnapshot;

  // Duration since last rebalance (or position creation if first)
  const referenceTime = previousRebalanceTimestamp ?? pre.timestamp;
  const durationSeconds = Math.max(1, (analytics.timestamp - referenceTime) / 1000);
  const durationDays = durationSeconds / 86400;

  // Fee APR
  const feeAPR = calculateFeeAPR(
    analytics.feesCollected0,
    analytics.feesCollected1,
    pre.amount0,
    pre.amount1,
    pre.token0Decimals,
    pre.token1Decimals,
    pre.currentTick,
    durationDays,
  );

  // Capital efficiency
  const capitalEfficiencyRatio = calculateCapitalEfficiency(
    pre.liquidity,
    pre.tickLower,
    pre.tickUpper,
    pre.currentTick,
  );

  // Time in range (from snapshots if available, otherwise binary from pre-snapshot)
  const timeInRangePercent = pre.isInRange ? 100 : 0;

  // Fees-to-cost ratio: prefer historically-priced USD execution cost.
  // Fallback uses token0-equivalent conversion (not the raw PLS value, which has wrong units).
  const feesValue = tokenValueInToken0(
    analytics.feesCollected0,
    analytics.feesCollected1,
    pre.token0Decimals,
    pre.token1Decimals,
    pre.currentTick,
  );
  const totalExecutionCostUsd =
    typeof analytics.gasCostUsd === 'number'
      ? analytics.gasCostUsd + (analytics.swapFrictionUsd ?? 0) + (analytics.dustUsd ?? 0)
      : undefined;
  const gasInToken0 = gasCostInToken0Equiv(analytics);
  const feesToCostRatio =
    typeof analytics.feesCollectedUsd === 'number' && totalExecutionCostUsd !== undefined
      ? totalExecutionCostUsd > 0
        ? analytics.feesCollectedUsd / totalExecutionCostUsd
        : analytics.feesCollectedUsd > 0 ? Infinity : 0
      : gasInToken0 > 0
        ? feesValue / gasInToken0
        : feesValue > 0 ? Infinity : 0;

  // Impermanent loss
  const impermanentLossPercent = calculateImpermanentLoss(
    pre.amount0, pre.amount1,
    pre.sqrtPriceX96,
    post.sqrtPriceX96,
    pre.token0Decimals, pre.token1Decimals,
  );

  // Raw fee yield (non-annualized)
  const rawFeeYieldPercent = calculateRawFeeYield(
    analytics.feesCollected0,
    analytics.feesCollected1,
    pre.amount0,
    pre.amount1,
    pre.token0Decimals,
    pre.token1Decimals,
    pre.currentTick,
  );

  // Net ROI = (fees - gas) / capital value (excludes IL)
  // Gas cost converted to token0-equiv so the subtraction is dimensionally correct.
  const capitalValue = tokenValueInToken0(
    pre.amount0, pre.amount1,
    pre.token0Decimals, pre.token1Decimals,
    pre.currentTick,
  );
  const dustValue = tokenValueInToken0(
    analytics.dust0 ?? 0n, analytics.dust1 ?? 0n,
    pre.token0Decimals, pre.token1Decimals,
    pre.currentTick,
  );
  const effectiveCapitalDeployed = Math.max(0, capitalValue - dustValue);

  const netROIPercent = effectiveCapitalDeployed > 0
    ? ((feesValue - gasInToken0) / effectiveCapitalDeployed) * 100
    : 0;

  // True Net ROI = (fees - gas - IL_loss) / capital (includes IL impact)
  const ilLossAbsolute = effectiveCapitalDeployed * Math.abs(impermanentLossPercent) / 100;
  const trueNetROIPercent = effectiveCapitalDeployed > 0
    ? ((feesValue - gasInToken0 - ilLossAbsolute) / effectiveCapitalDeployed) * 100
    : 0;

  // Rebalance execution cost
  const { costPercent: rebalanceCostPercent, costToken0: rebalanceCostToken0 } =
    calculateRebalanceCost(analytics);

  return {
    durationSeconds,
    durationDays,
    feeAPR,
    rawFeeYieldPercent,
    capitalEfficiencyRatio,
    timeInRangePercent,
    feesToCostRatio,
    impermanentLossPercent,
    netROIPercent,
    trueNetROIPercent,
    rebalanceCostPercent,
    rebalanceCostToken0,
  };
}

/**
 * Minimum duration (in days) before annualizing APR.
 * Sub-24h positions produce wildly misleading APR numbers (e.g., 10M%).
 * For shorter periods, callers should use rawFeeYieldPercent instead.
 */
export const MIN_APR_DURATION_DAYS = 1;

/**
 * Annualized fee return: (fees / capital) * (365 / days) * 100%
 * Both fees and capital expressed in token0-equivalent value.
 * Returns 0 for sub-24h periods — use rawFeeYield for those.
 */
export function calculateFeeAPR(
  fees0: bigint,
  fees1: bigint,
  capital0: bigint,
  capital1: bigint,
  decimals0: number,
  decimals1: number,
  currentTick: number,
  durationDays: number,
): number {
  if (durationDays <= 0) return 0;

  const feesValue = tokenValueInToken0(fees0, fees1, decimals0, decimals1, currentTick);
  const capitalValue = tokenValueInToken0(capital0, capital1, decimals0, decimals1, currentTick);

  if (capitalValue <= 0) return 0;

  // Don't annualize sub-24h periods — the extrapolation is wildly misleading
  if (durationDays < MIN_APR_DURATION_DAYS) return 0;

  return (feesValue / capitalValue) * (365 / durationDays) * 100;
}

/**
 * Raw (non-annualized) fee yield: (fees / capital) * 100%
 * Useful for any period length, especially sub-24h.
 */
export function calculateRawFeeYield(
  fees0: bigint,
  fees1: bigint,
  capital0: bigint,
  capital1: bigint,
  decimals0: number,
  decimals1: number,
  currentTick: number,
): number {
  const feesValue = tokenValueInToken0(fees0, fees1, decimals0, decimals1, currentTick);
  const capitalValue = tokenValueInToken0(capital0, capital1, decimals0, decimals1, currentTick);
  if (capitalValue <= 0) return 0;
  return (feesValue / capitalValue) * 100;
}

/**
 * Capital efficiency ratio: concentrated liquidity depth relative to position width.
 * Wider ranges = lower efficiency, tighter = higher.
 * Simple ratio: full tick range / position tick range.
 */
export function calculateCapitalEfficiency(
  liquidity: bigint,
  tickLower: number,
  tickUpper: number,
  currentTick: number,
): number {
  if (liquidity === 0n) return 0;
  const positionWidth = tickUpper - tickLower;
  if (positionWidth <= 0) return 0;
  // Full range is approximately -887272 to 887272 = 1,774,544 ticks
  const fullRange = 1_774_544;
  return fullRange / positionWidth;
}

/**
 * Impermanent loss calculation for V3 positions.
 * Compares LP value to HODL value at the new price.
 *
 * IL = (V_lp - V_hodl) / V_hodl
 * For V3 in-range: standard formula applies within tick boundaries
 * For V3 out-of-range: single-sided exposure gives worst IL
 */
export function calculateImpermanentLoss(
  initialAmount0: bigint,
  initialAmount1: bigint,
  initialSqrtPriceX96: bigint,
  finalSqrtPriceX96: bigint,
  decimals0: number,
  decimals1: number,
): number {
  // Convert amounts to floating point (BigInt division first to avoid 2^53 overflow)
  const a0 = bigintToFloat(initialAmount0, decimals0);
  const a1 = bigintToFloat(initialAmount1, decimals1);

  if (a0 === 0 && a1 === 0) return 0;

  // Price = (sqrtPrice / 2^96)^2 — uses safe BigInt-first division
  // Old code used Number(sqrtPrice^2) / Number(Q96^2) which overflows (~192 bits)
  const initialPrice = sqrtPriceX96ToPrice(initialSqrtPriceX96);
  const finalPrice = sqrtPriceX96ToPrice(finalSqrtPriceX96);

  if (initialPrice <= 0 || finalPrice <= 0) return 0;

  // Adjust for decimals: price is in token1/token0 raw units
  const decimalAdjust = 10 ** (decimals0 - decimals1);
  const adjustedInitialPrice = initialPrice * decimalAdjust;
  const adjustedFinalPrice = finalPrice * decimalAdjust;

  // HODL value at final price (in token0 terms)
  const hodlValue = a0 + a1 / adjustedFinalPrice;

  if (hodlValue <= 0) return 0;

  // Price ratio
  const priceRatio = adjustedFinalPrice / adjustedInitialPrice;
  if (priceRatio <= 0) return 0;

  // Standard V3 IL approximation
  // IL = 2 * sqrt(priceRatio) / (1 + priceRatio) - 1
  const sqrtRatio = Math.sqrt(priceRatio);
  const il = (2 * sqrtRatio) / (1 + priceRatio) - 1;

  return il * 100; // Return as percentage (negative = loss)
}

/**
 * Calculate time-in-range from a series of snapshots using time-weighted interpolation.
 *
 * Each consecutive snapshot pair represents an interval. The position is assumed to have
 * been in the state recorded at the START of each interval for the full duration of that
 * interval. This is more accurate than a simple snapshot count because snapshot intervals
 * are not perfectly uniform (jitter, missed cycles, bot restarts).
 *
 * Falls back to single-snapshot binary result when only one snapshot is available.
 */
export function estimateTimeInRange(snapshots: PositionSnapshot[]): number {
  if (snapshots.length === 0) return 0;
  if (snapshots.length === 1) return snapshots[0].isInRange ? 100 : 0;

  const sorted = [...snapshots].sort((a, b) => a.timestamp - b.timestamp);
  let timeInRange = 0;
  let totalTime = 0;

  for (let i = 1; i < sorted.length; i++) {
    const interval = sorted[i].timestamp - sorted[i - 1].timestamp;
    // Skip abnormally large gaps (> 2 hours) — likely a bot restart or RPC outage,
    // not representative of continuous monitoring. These gaps would distort the metric.
    if (interval > 2 * 60 * 60 * 1000) continue;
    totalTime += interval;
    if (sorted[i - 1].isInRange) {
      timeInRange += interval;
    }
  }

  if (totalTime === 0) return sorted[sorted.length - 1].isInRange ? 100 : 0;
  return (timeInRange / totalTime) * 100;
}

/**
 * Calculate fee accrual rate from a series of snapshots.
 *
 * Measures how fast unclaimed fees are accumulating by computing the average
 * USD-denominated fee growth per hour across consecutive snapshot pairs.
 * Only uses snapshots where USD prices are available (priceUsd0/1 > 0).
 *
 * Returns null if insufficient data (fewer than 2 priced snapshots).
 */
export function calculateFeeAccrualRate(snapshots: PositionSnapshot[]): {
  /** Average fee accrual rate in USD per hour */
  rateUsdPerHour: number;
  /** Projected daily fee earnings in USD at the current rate */
  projectedDailyUsd: number;
  /** Number of snapshot intervals used in the calculation */
  sampleCount: number;
} | null {
  // Filter to snapshots that have USD prices anchored
  const priced = [...snapshots]
    .filter((s) => s.priceUsd0 > 0 || s.priceUsd1 > 0)
    .sort((a, b) => a.timestamp - b.timestamp);

  if (priced.length < 2) return null;

  let totalFeeGrowthUsd = 0;
  let totalHours = 0;
  let sampleCount = 0;

  for (let i = 1; i < priced.length; i++) {
    const prev = priced[i - 1];
    const curr = priced[i];
    const intervalMs = curr.timestamp - prev.timestamp;

    // Skip gaps > 2 hours — not representative of continuous fee earning
    if (intervalMs > 2 * 60 * 60 * 1000 || intervalMs <= 0) continue;

    // Fee growth = (current unclaimedFeesUsd - previous unclaimedFeesUsd)
    // Only count positive growth (fees earned), ignore drops (fee collection events)
    const feeGrowth = curr.unclaimedFeesUsd - prev.unclaimedFeesUsd;
    if (feeGrowth > 0) {
      totalFeeGrowthUsd += feeGrowth;
    }
    totalHours += intervalMs / (1000 * 3600);
    sampleCount++;
  }

  if (totalHours <= 0 || sampleCount === 0) return null;

  const rateUsdPerHour = totalFeeGrowthUsd / totalHours;
  return {
    rateUsdPerHour,
    projectedDailyUsd: rateUsdPerHour * 24,
    sampleCount,
  };
}

/**
 * Calculate the total execution cost of a rebalance as a percentage of pre-rebalance value.
 *
 * Uses the post-rebalance pool tick as a single reference price for both pre and post values,
 * which isolates execution cost from IL (IL is price-change dependent).
 *
 * Captures: swap pool fees, price impact, routing inefficiency, and token dust.
 */
export function calculateRebalanceCost(analytics: RebalanceAnalytics): {
  costPercent: number;
  costToken0: number;
} {
  const pre = analytics.preSnapshot;
  const post = analytics.postSnapshot;
  const refTick = post.currentTick;

  // Pre-rebalance total = position amounts + collected fees, valued at post-rebalance price
  const preTotal = tokenValueInToken0(
    pre.amount0 + analytics.feesCollected0,
    pre.amount1 + analytics.feesCollected1,
    pre.token0Decimals,
    pre.token1Decimals,
    refTick,
  );

  // Post-rebalance total = new minted position amounts
  const postTotal = tokenValueInToken0(
    analytics.newAmount0,
    analytics.newAmount1,
    pre.token0Decimals,
    pre.token1Decimals,
    refTick,
  );

  if (preTotal <= 0) return { costPercent: 0, costToken0: 0 };

  // Gas cost converted to token0-equiv for dimensional consistency.
  // preTotal and postTotal are in token0-equiv; subtracting raw PLS would be wrong
  // (e.g. for HEX/WPLS, 1 HEX ≈ 1000 PLS — gas would appear ~1000x too expensive).
  const gasToken0 = gasCostInToken0Equiv(analytics);
  const costToken0 = preTotal - postTotal - gasToken0;
  const costPercent = (costToken0 / preTotal) * 100;

  // Clamp: negative means price improvement (rare), cap at 50% for sanity
  return {
    costPercent: Math.max(0, Math.min(50, costPercent)),
    costToken0: Math.max(0, costToken0),
  };
}

/**
 * Convert a (token0, token1) pair to a single token0-equivalent value.
 * Uses the current tick to derive approximate price.
 */
function tokenValueInToken0(
  amount0: bigint,
  amount1: bigint,
  decimals0: number,
  decimals1: number,
  currentTick: number,
): number {
  const a0 = bigintToFloat(amount0, decimals0);
  const a1 = bigintToFloat(amount1, decimals1);

  // Price of token0 in terms of token1: P = 1.0001^tick * (10^d0 / 10^d1)
  const rawPrice = Math.pow(1.0001, currentTick);
  const price = rawPrice * (10 ** decimals0) / (10 ** decimals1);

  if (price <= 0) return a0;
  return a0 + a1 / price;
}

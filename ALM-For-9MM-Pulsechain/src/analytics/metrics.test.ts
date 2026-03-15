/**
 * Unit tests for src/analytics/metrics.ts — financial metric calculations.
 * Tests calculateFeeAPR, calculateRawFeeYield, calculateCapitalEfficiency,
 * calculateImpermanentLoss, estimateTimeInRange, calculateRebalanceCost.
 * Pure functions, no mocks required.
 */
import { describe, it, expect } from 'vitest';
import {
  calculateFeeAPR,
  calculateRawFeeYield,
  calculateCapitalEfficiency,
  calculateImpermanentLoss,
  estimateTimeInRange,
  calculateRebalanceCost,
  MIN_APR_DURATION_DAYS,
} from './metrics.js';
import { tickToSqrtPriceX96 } from '../math.js';
import type { RebalanceAnalytics, PositionSnapshot } from './types.js';

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeSnap(overrides: Partial<PositionSnapshot> = {}): PositionSnapshot {
  return {
    timestamp: Date.now(),
    tokenId: 1,
    liquidity: 1_000_000n,
    tickLower: -300,
    tickUpper: 300,
    amount0: 1_000_000_000_000_000_000n, // 1 token (18 dec)
    amount1: 1_000_000_000_000_000_000n,
    currentTick: 0,
    sqrtPriceX96: tickToSqrtPriceX96(0),
    poolLiquidity: 1_000_000n,
    isInRange: true,
    tickDistance: 0,
    tokensOwed0: 0n,
    tokensOwed1: 0n,
    token0Symbol: 'T0',
    token1Symbol: 'T1',
    token0Decimals: 18,
    token1Decimals: 18,
    poolFee: 2500,
    priceUsd0: 0,
    priceUsd1: 0,
    nativePriceUsd: 0,
    positionValueUsd: 0,
    unclaimedFeesUsd: 0,
    ...overrides,
  };
}

function makeAnalytics(overrides: Partial<RebalanceAnalytics> = {}): RebalanceAnalytics {
  const pre = makeSnap();
  const post = makeSnap();
  return {
    timestamp: Date.now(),
    rebalanceId: 'test-id',
    oldTokenId: 1,
    newTokenId: 2,
    strategy: 'pulse',
    preSnapshot: pre,
    postSnapshot: post,
    txHashes: { collectFees: '0x', decreaseLiquidity: '0x', collectTokens: '0x', burn: '0x', mint: '0x' },
    feesCollected0: 10_000_000_000_000_000n,  // 0.01 token0
    feesCollected1: 10_000_000_000_000_000n,  // 0.01 token1
    liquidityRemoved0: 1_000_000_000_000_000_000n,
    liquidityRemoved1: 1_000_000_000_000_000_000n,
    newLiquidity: 900_000n,
    newAmount0: 990_000_000_000_000_000n,
    newAmount1: 990_000_000_000_000_000n,
    newTickLower: -300,
    newTickUpper: 300,
    gasUsed: {
      collectFees: 0n, decreaseLiquidity: 0n, collectTokens: 0n,
      burn: 0n, swap: 0n, approvals: 0n, mint: 0n, total: 0n,
    },
    gasPrice: 1_000_000_000n,
    totalGasCostPLS: 0.001,
    metrics: {
      durationSeconds: 86400,
      durationDays: 1,
      feeAPR: 0,
      rawFeeYieldPercent: 0,
      capitalEfficiencyRatio: 0,
      timeInRangePercent: 100,
      feesToCostRatio: 0,
      impermanentLossPercent: 0,
      netROIPercent: 0,
      trueNetROIPercent: 0,
      rebalanceCostPercent: 0,
      rebalanceCostToken0: 0,
    },
    ...overrides,
  };
}

// ── calculateFeeAPR ──────────────────────────────────────────────────────────

describe('calculateFeeAPR', () => {
  // Both tokens at 18 decimals, currentTick=0 (price=1), so token0 and token1 equal in value
  const D = 18;

  it('returns 0 for durationDays <= 0', () => {
    expect(calculateFeeAPR(100n, 100n, 1000n, 1000n, D, D, 0, 0)).toBe(0);
    expect(calculateFeeAPR(100n, 100n, 1000n, 1000n, D, D, 0, -1)).toBe(0);
  });

  it(`returns 0 for sub-24h periods (durationDays < ${MIN_APR_DURATION_DAYS})`, () => {
    // 12 hours is below the MIN_APR_DURATION_DAYS guard
    const result = calculateFeeAPR(100n, 0n, 1000n, 0n, D, D, 0, 0.5);
    expect(result).toBe(0);
  });

  it('returns 0 for zero capital', () => {
    expect(calculateFeeAPR(100n, 100n, 0n, 0n, D, D, 0, 30)).toBe(0);
  });

  it('returns correct annualized APR for a 7-day period', () => {
    // fees = 0.01 tokens (18 dec), capital = 1 token (18 dec)
    // yield = 1%, annualized: 1% * (365/7) ≈ 52.14%
    const fees = 10_000_000_000_000_000n;    // 0.01
    const capital = 1_000_000_000_000_000_000n; // 1.0
    const apr = calculateFeeAPR(fees, 0n, capital, 0n, D, D, 0, 7);
    const expected = (0.01 / 1.0) * (365 / 7) * 100;
    expect(apr).toBeCloseTo(expected, 2);
  });

  it('is proportional to fee amount (2x fees → 2x APR)', () => {
    const capital = 1_000_000_000_000_000_000n;
    const apr1 = calculateFeeAPR(100_000_000_000_000_000n, 0n, capital, 0n, D, D, 0, 30);
    const apr2 = calculateFeeAPR(200_000_000_000_000_000n, 0n, capital, 0n, D, D, 0, 30);
    expect(apr2).toBeCloseTo(apr1 * 2, 5);
  });

  it('is inversely proportional to duration (2x longer → 0.5x APR for same fee)', () => {
    const fees = 100_000_000_000_000_000n;
    const capital = 1_000_000_000_000_000_000n;
    const apr30 = calculateFeeAPR(fees, 0n, capital, 0n, D, D, 0, 30);
    const apr60 = calculateFeeAPR(fees, 0n, capital, 0n, D, D, 0, 60);
    expect(apr60).toBeCloseTo(apr30 / 2, 5);
  });

  it('counts both token0 and token1 fees at tick=0 (equal price)', () => {
    const fees = 100_000_000_000_000_000n;
    const capital = 1_000_000_000_000_000_000n;
    const oneSided = calculateFeeAPR(fees, 0n, capital, capital, 18, 18, 0, 30);
    const twoSided = calculateFeeAPR(fees, fees, capital, capital, 18, 18, 0, 30);
    expect(twoSided).toBeGreaterThan(oneSided);
    expect(twoSided).toBeCloseTo(oneSided * 2, 2);
  });
});

// ── calculateRawFeeYield ─────────────────────────────────────────────────────

describe('calculateRawFeeYield', () => {
  const D = 18;

  it('returns 0 for zero capital', () => {
    expect(calculateRawFeeYield(100n, 0n, 0n, 0n, D, D, 0)).toBe(0);
  });

  it('returns correct yield percentage', () => {
    // 0.01 fees / 1.0 capital = 1%
    const yield_ = calculateRawFeeYield(
      10_000_000_000_000_000n, 0n,
      1_000_000_000_000_000_000n, 0n,
      D, D, 0,
    );
    expect(yield_).toBeCloseTo(1.0, 5);
  });

  it('works for sub-24h periods (unlike calculateFeeAPR)', () => {
    // This should return a non-zero value even for short periods
    const yield_ = calculateRawFeeYield(
      100_000_000_000_000_000n, 0n,
      1_000_000_000_000_000_000n, 0n,
      D, D, 0,
    );
    expect(yield_).toBeGreaterThan(0);
  });
});

// ── calculateCapitalEfficiency ───────────────────────────────────────────────

describe('calculateCapitalEfficiency', () => {
  it('returns 0 for zero liquidity', () => {
    expect(calculateCapitalEfficiency(0n, -300, 300, 0)).toBe(0);
  });

  it('returns 0 for zero or negative width', () => {
    expect(calculateCapitalEfficiency(1000n, 300, 300, 0)).toBe(0);  // same tick
    expect(calculateCapitalEfficiency(1000n, 300, 100, 0)).toBe(0);  // inverted
  });

  it('wider range → lower efficiency (ratio decreases)', () => {
    const narrow = calculateCapitalEfficiency(1000n, -100, 100, 0);
    const wide = calculateCapitalEfficiency(1000n, -1000, 1000, 0);
    expect(narrow).toBeGreaterThan(wide);
  });

  it('tighter range → higher efficiency ratio', () => {
    // Full range ≈ 1,774,544 ticks. 200-tick range → ratio ≈ 8872
    const eff = calculateCapitalEfficiency(1000n, -100, 100, 0);
    expect(eff).toBeCloseTo(1_774_544 / 200, 1);
  });

  it('does not use currentTick in the efficiency calculation', () => {
    // Efficiency is a static property of range width, not current price position
    const atCenter = calculateCapitalEfficiency(1000n, -300, 300, 0);
    const atEdge = calculateCapitalEfficiency(1000n, -300, 300, 299);
    expect(atCenter).toBe(atEdge);
  });
});

// ── calculateImpermanentLoss ─────────────────────────────────────────────────

describe('calculateImpermanentLoss', () => {
  it('returns 0 for equal initial and final price (no price change)', () => {
    const sqrtPrice = tickToSqrtPriceX96(0);
    const il = calculateImpermanentLoss(
      1_000_000_000_000_000_000n, 1_000_000_000_000_000_000n,
      sqrtPrice, sqrtPrice,
      18, 18,
    );
    expect(il).toBeCloseTo(0, 5);
  });

  it('returns 0 for zero initial amounts', () => {
    const sqrtPrice = tickToSqrtPriceX96(0);
    const il = calculateImpermanentLoss(0n, 0n, sqrtPrice, sqrtPrice, 18, 18);
    expect(il).toBe(0);
  });

  it('returns negative value for price change (IL is always a loss)', () => {
    const sqrtPriceInitial = tickToSqrtPriceX96(0);
    const sqrtPriceFinal = tickToSqrtPriceX96(1000); // price moved up
    const il = calculateImpermanentLoss(
      1_000_000_000_000_000_000n, 1_000_000_000_000_000_000n,
      sqrtPriceInitial, sqrtPriceFinal,
      18, 18,
    );
    expect(il).toBeLessThan(0);
  });

  it('IL is symmetric for equal up/down price moves', () => {
    const sqrtPriceInit = tickToSqrtPriceX96(0);
    const sqrtPriceUp = tickToSqrtPriceX96(500);
    const sqrtPriceDown = tickToSqrtPriceX96(-500);
    const amounts = { a: 1_000_000_000_000_000_000n, b: 1_000_000_000_000_000_000n };

    const ilUp = calculateImpermanentLoss(amounts.a, amounts.b, sqrtPriceInit, sqrtPriceUp, 18, 18);
    const ilDown = calculateImpermanentLoss(amounts.a, amounts.b, sqrtPriceInit, sqrtPriceDown, 18, 18);

    // Both should be negative, similar magnitude (V3 IL is approximately symmetric for small moves)
    expect(ilUp).toBeLessThan(0);
    expect(ilDown).toBeLessThan(0);
    expect(Math.abs(ilUp - ilDown)).toBeLessThan(1); // within 1 percentage point
  });

  it('larger price move → larger IL (monotonic)', () => {
    const sqrtPriceInit = tickToSqrtPriceX96(0);
    const amounts = { a: 1_000_000_000_000_000_000n, b: 1_000_000_000_000_000_000n };

    const ilSmall = calculateImpermanentLoss(amounts.a, amounts.b, sqrtPriceInit, tickToSqrtPriceX96(200), 18, 18);
    const ilLarge = calculateImpermanentLoss(amounts.a, amounts.b, sqrtPriceInit, tickToSqrtPriceX96(1000), 18, 18);

    expect(ilSmall).toBeGreaterThan(ilLarge); // ilSmall is less negative = closer to 0
  });

  it('returns value as percentage (not decimal)', () => {
    const sqrtPriceInit = tickToSqrtPriceX96(0);
    const sqrtPriceFinal = tickToSqrtPriceX96(500);
    const il = calculateImpermanentLoss(
      1_000_000_000_000_000_000n, 1_000_000_000_000_000_000n,
      sqrtPriceInit, sqrtPriceFinal,
      18, 18,
    );
    // IL expressed as percent — should be between -100 and 0
    expect(il).toBeLessThan(0);
    expect(il).toBeGreaterThan(-100);
  });

  it('handles tokens with different decimals (HEX=8, WPLS=18)', () => {
    const sqrtPriceInit = tickToSqrtPriceX96(-60000); // HEX/WPLS territory
    const sqrtPriceFinal = tickToSqrtPriceX96(-59000);
    const il = calculateImpermanentLoss(
      1_000_000_00n,                // 1 HEX (8 decimals)
      1_000_000_000_000_000_000n,   // 1 WPLS (18 decimals)
      sqrtPriceInit, sqrtPriceFinal,
      8, 18,
    );
    // Should return a finite, non-NaN number
    expect(isFinite(il)).toBe(true);
    expect(isNaN(il)).toBe(false);
  });
});

// ── estimateTimeInRange ──────────────────────────────────────────────────────

describe('estimateTimeInRange', () => {
  it('returns 0 for empty snapshots', () => {
    expect(estimateTimeInRange([])).toBe(0);
  });

  it('returns 100 when all snapshots are in range', () => {
    const snaps = [
      makeSnap({ isInRange: true }),
      makeSnap({ isInRange: true }),
      makeSnap({ isInRange: true }),
    ];
    expect(estimateTimeInRange(snaps)).toBe(100);
  });

  it('returns 0 when no snapshots are in range', () => {
    const snaps = [
      makeSnap({ isInRange: false }),
      makeSnap({ isInRange: false }),
    ];
    expect(estimateTimeInRange(snaps)).toBe(0);
  });

  it('returns correct percentage for mixed snapshots (time-weighted)', () => {
    // estimateTimeInRange is time-weighted: each interval uses the PREVIOUS snapshot's isInRange.
    // [true, false, true, false] with equal spacing → 2/3 intervals in-range ≈ 66.67
    // For exactly 50%, use [true, false, false, true] → snap[0]=true(1), snap[1]=false(0), snap[2]=false(0) → 1/3
    // Simplest 50%: [in, out, in, out, in, out] alternating with equal spacing → 3/5 = 60%
    // Use [in, out] with equal spacing to get 50%: 1 interval, snap[0]=true → 100%.
    // Correct 50% test: 4 intervals, 2 in-range start
    const base = Date.now();
    const snaps = [
      makeSnap({ isInRange: true, timestamp: base }),
      makeSnap({ isInRange: false, timestamp: base + 60_000 }),
      makeSnap({ isInRange: true, timestamp: base + 120_000 }),
      makeSnap({ isInRange: false, timestamp: base + 180_000 }),
      makeSnap({ isInRange: false, timestamp: base + 240_000 }),
    ];
    // Intervals: true→false(60k, in), false→true(60k, out), true→false(60k, in), false→false(60k, out)
    // timeInRange = 120k, totalTime = 240k → 50%
    expect(estimateTimeInRange(snaps)).toBe(50);
  });

  it('returns 75 for 3 out of 4 intervals in range', () => {
    const base = Date.now();
    const snaps = [
      makeSnap({ isInRange: true, timestamp: base }),
      makeSnap({ isInRange: true, timestamp: base + 60_000 }),
      makeSnap({ isInRange: true, timestamp: base + 120_000 }),
      makeSnap({ isInRange: false, timestamp: base + 180_000 }),
      makeSnap({ isInRange: false, timestamp: base + 240_000 }),
    ];
    // Intervals: true(60k), true(60k), true(60k), false(60k)
    // timeInRange = 180k, totalTime = 240k → 75%
    expect(estimateTimeInRange(snaps)).toBe(75);
  });
});

// ── calculateRebalanceCost ────────────────────────────────────────────────────

describe('calculateRebalanceCost', () => {
  it('returns 0 for zero pre-rebalance value', () => {
    const analytics = makeAnalytics({
      preSnapshot: makeSnap({ amount0: 0n, amount1: 0n }),
      feesCollected0: 0n,
      feesCollected1: 0n,
    });
    const result = calculateRebalanceCost(analytics);
    expect(result.costPercent).toBe(0);
    expect(result.costToken0).toBe(0);
  });

  it('cost is positive when pre > post (capital lost during rebalance)', () => {
    const analytics = makeAnalytics({
      preSnapshot: makeSnap({ amount0: 1_000_000_000_000_000_000n, amount1: 1_000_000_000_000_000_000n }),
      postSnapshot: makeSnap({ amount0: 1_000_000_000_000_000_000n, amount1: 1_000_000_000_000_000_000n }),
      feesCollected0: 10_000_000_000_000_000n,
      feesCollected1: 10_000_000_000_000_000n,
      newAmount0: 900_000_000_000_000_000n,   // 10% less than pre+fees
      newAmount1: 900_000_000_000_000_000n,
      totalGasCostPLS: 0,
    });
    const result = calculateRebalanceCost(analytics);
    expect(result.costPercent).toBeGreaterThan(0);
    expect(result.costToken0).toBeGreaterThan(0);
  });

  it('costPercent is clamped to [0, 50]', () => {
    // Edge case: post is much larger than pre (price improvement)
    // costToken0 = preTotal - postTotal - gas → negative → clamped to 0
    const analytics = makeAnalytics({
      newAmount0: 10_000_000_000_000_000_000n, // 10x more than pre
      newAmount1: 10_000_000_000_000_000_000n,
    });
    const result = calculateRebalanceCost(analytics);
    expect(result.costPercent).toBeGreaterThanOrEqual(0);
    expect(result.costPercent).toBeLessThanOrEqual(50);
    expect(result.costToken0).toBeGreaterThanOrEqual(0);
  });

  it('costToken0 accounts for gas cost (converted to token0-equiv) in the subtraction', () => {
    // costToken0 = preTotal - postTotal - gasCostInToken0Equiv
    // Gas cost is converted from native currency to token0-equivalent using USD prices.
    // With USD prices set (priceUsd0=1, gasCostUsd=0.001), gas of 0.001 PLS → 0.001 token0-equiv.
    // A small gas value yields a small positive costToken0.
    // A zero gas value yields a larger positive costToken0 (no gas deduction).
    const sharedOverrides = {
      preSnapshot: makeSnap({ amount0: 2_000_000_000_000_000_000n, amount1: 2_000_000_000_000_000_000n }),
      postSnapshot: makeSnap({ amount0: 2_000_000_000_000_000_000n, amount1: 2_000_000_000_000_000_000n }),
      feesCollected0: 0n,
      feesCollected1: 0n,
      newAmount0: 1_900_000_000_000_000_000n,  // 5% less → preTotal > postTotal
      newAmount1: 1_900_000_000_000_000_000n,
      priceUsd0: 1.0,  // USD prices needed for gas-to-token0 conversion
    };
    const noGasAnalytics = makeAnalytics({ ...sharedOverrides, totalGasCostPLS: 0, gasCostUsd: 0 });
    const smallGasAnalytics = makeAnalytics({ ...sharedOverrides, totalGasCostPLS: 0.001, gasCostUsd: 0.001 });

    const noGasCost = calculateRebalanceCost(noGasAnalytics);
    const smallGasCost = calculateRebalanceCost(smallGasAnalytics);

    // Both should show positive costs (pre > post)
    expect(noGasCost.costPercent).toBeGreaterThan(0);
    expect(smallGasCost.costPercent).toBeGreaterThan(0);
    // The gas deduction in costToken0 reduces the measured execution cost (gas is its own cost)
    expect(smallGasCost.costToken0).toBeLessThan(noGasCost.costToken0);
  });
});

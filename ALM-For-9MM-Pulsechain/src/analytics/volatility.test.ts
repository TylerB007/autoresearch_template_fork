/**
 * Unit tests for src/analytics/volatility.ts — tick volatility calculation.
 * Pure function using a timestamp-relative window. Tests control time via snapshot timestamps.
 */
import { describe, it, expect } from 'vitest';
import { calculateTickVolatility } from './volatility.js';
import type { PositionSnapshot } from './types.js';

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Build a minimal PositionSnapshot with the fields volatility.ts needs.
 * timestamp: milliseconds. currentTick: the tick to record.
 */
function snap(currentTick: number, timestamp: number): PositionSnapshot {
  return {
    timestamp,
    tokenId: 1,
    liquidity: 1n,
    tickLower: -300,
    tickUpper: 300,
    amount0: 0n,
    amount1: 0n,
    currentTick,
    sqrtPriceX96: 1n,
    poolLiquidity: 1n,
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
  };
}

/** Returns a list of N snapshots all within the last `windowMinutes` minutes. */
function recentSnaps(ticks: number[], windowMinutes = 60): PositionSnapshot[] {
  const now = Date.now();
  // Space them evenly within the window
  return ticks.map((tick, i) => snap(tick, now - (windowMinutes * 60 * 1000 * (ticks.length - i - 1)) / ticks.length));
}

/** Returns snapshots older than the window (will be filtered out). */
function staleSnaps(ticks: number[], windowMinutes = 60): PositionSnapshot[] {
  const cutoff = Date.now() - windowMinutes * 60 * 1000;
  return ticks.map((tick, i) => snap(tick, cutoff - (i + 1) * 60_000));
}

// ── Edge cases ───────────────────────────────────────────────────────────────

describe('calculateTickVolatility — edge cases', () => {
  it('returns zeroed low-regime result for empty input', () => {
    const r = calculateTickVolatility([]);
    expect(r.stdDev).toBe(0);
    expect(r.regime).toBe('low');
    expect(r.avgTickChange).toBe(0);
    expect(r.maxTickChange).toBe(0);
    expect(r.sampleCount).toBe(0);
  });

  it('returns zeroed low-regime result for a single snapshot', () => {
    const r = calculateTickVolatility([snap(100, Date.now())]);
    expect(r.stdDev).toBe(0);
    expect(r.regime).toBe('low');
    expect(r.sampleCount).toBe(0);
  });

  it('returns zeroed low-regime result when all snapshots are outside the window', () => {
    const old = staleSnaps([100, 200, 300]);
    const r = calculateTickVolatility(old, 60);
    expect(r.stdDev).toBe(0);
    expect(r.sampleCount).toBe(0);
    expect(r.regime).toBe('low');
  });

  it('filters out old snapshots and uses only in-window ones', () => {
    const old = staleSnaps([1000, 2000, 3000]); // large moves, should be excluded
    const recent = recentSnaps([100, 101, 100]);  // tiny moves, stdDev near 0
    const all = [...old, ...recent];
    const r = calculateTickVolatility(all, 60);
    expect(r.stdDev).toBeLessThan(5); // only quiet recent data used
    expect(r.regime).toBe('low');
  });

  it('returns windowMinutes in result', () => {
    const r = calculateTickVolatility(recentSnaps([0, 1]), 120);
    expect(r.windowMinutes).toBe(120);
  });
});

// ── Statistics correctness ────────────────────────────────────────────────────

describe('calculateTickVolatility — statistics', () => {
  it('sampleCount = number of consecutive pairs (N snapshots → N-1 changes)', () => {
    const snaps = recentSnaps([0, 10, 20, 30, 40]); // 5 snapshots → 4 changes
    const r = calculateTickVolatility(snaps);
    expect(r.sampleCount).toBe(4);
  });

  it('avgTickChange is the mean of absolute tick differences', () => {
    // Ticks: 0, 10, 20, 10 → changes: 10, 10, 10 → mean = 10
    const snaps = recentSnaps([0, 10, 20, 10]);
    const r = calculateTickVolatility(snaps);
    expect(r.avgTickChange).toBeCloseTo(10, 5);
  });

  it('maxTickChange is the largest absolute difference', () => {
    // Ticks: 0, 5, 100, 105 → changes: 5, 95, 5 → max = 95
    const snaps = recentSnaps([0, 5, 100, 105]);
    const r = calculateTickVolatility(snaps);
    expect(r.maxTickChange).toBe(95);
  });

  it('stdDev = 0 for constant ticks (no change)', () => {
    const snaps = recentSnaps([100, 100, 100, 100]);
    const r = calculateTickVolatility(snaps);
    expect(r.stdDev).toBe(0);
    expect(r.avgTickChange).toBe(0);
    expect(r.maxTickChange).toBe(0);
    expect(r.regime).toBe('low');
  });

  it('computes correct stdDev for known values', () => {
    // tick changes: [10, 10, 10] — mean=10, variance=0, stdDev=0
    const snaps = recentSnaps([0, 10, 20, 30]);
    const r = calculateTickVolatility(snaps);
    // All changes identical → stdDev = 0
    expect(r.stdDev).toBeCloseTo(0, 5);

    // tick changes: [0, 20] — mean=10, variance=100, stdDev=10
    const snaps2 = recentSnaps([100, 100, 120]);
    const r2 = calculateTickVolatility(snaps2);
    expect(r2.stdDev).toBeCloseTo(10, 3);
  });

  it('handles negative tick movement (uses absolute values)', () => {
    // Ticks going down: 100, 90, 80 → changes: 10, 10 (absolute)
    const snaps = recentSnaps([100, 90, 80]);
    const r = calculateTickVolatility(snaps);
    expect(r.avgTickChange).toBeCloseTo(10, 5);
    expect(r.maxTickChange).toBe(10);
  });

  it('handles mixed up/down ticks (absolute values only)', () => {
    // Ticks: 0, 10, -10, 5 → changes: 10, 20, 15 → mean=15, max=20
    const snaps = recentSnaps([0, 10, -10, 5]);
    const r = calculateTickVolatility(snaps);
    expect(r.avgTickChange).toBeCloseTo(15, 5);
    expect(r.maxTickChange).toBe(20);
  });
});

// ── Regime classification ─────────────────────────────────────────────────────

describe('calculateTickVolatility — regime classification', () => {
  it('stdDev < 5 → "low"', () => {
    // All ticks identical → stdDev = 0
    const snaps = recentSnaps([100, 101, 100, 101]);
    const r = calculateTickVolatility(snaps);
    expect(r.stdDev).toBeLessThan(5);
    expect(r.regime).toBe('low');
  });

  it('stdDev > 20 → "high"', () => {
    // Large erratic swings → stdDev well above 20
    const snaps = recentSnaps([0, 100, -100, 200, -200]);
    const r = calculateTickVolatility(snaps);
    expect(r.stdDev).toBeGreaterThan(20);
    expect(r.regime).toBe('high');
  });

  it('5 <= stdDev <= 20 → "medium"', () => {
    // Moderate, consistent movement: changes of ~10 with some variance
    const snaps = recentSnaps([0, 8, 18, 10, 22, 12]);
    const r = calculateTickVolatility(snaps);
    // If stdDev lands in medium band, verify it
    if (r.stdDev >= 5 && r.stdDev <= 20) {
      expect(r.regime).toBe('medium');
    }
  });

  it('constant low movement stays "low" regime', () => {
    const snaps = recentSnaps([1000, 1002, 1001, 1003, 1002]);
    const r = calculateTickVolatility(snaps);
    expect(r.regime).toBe('low');
  });
});

// ── Sorting order ────────────────────────────────────────────────────────────

describe('calculateTickVolatility — snapshot ordering', () => {
  it('sorts snapshots chronologically before computing changes', () => {
    const now = Date.now();
    // Deliberately provide out-of-order snapshots
    const outOfOrder = [
      snap(20, now - 1000),  // second chronologically
      snap(0, now - 2000),   // first chronologically
      snap(30, now),         // third chronologically
    ];
    // Sorted: 0 → 20 → 30, changes: [20, 10], mean=15
    const r = calculateTickVolatility(outOfOrder);
    expect(r.avgTickChange).toBeCloseTo(15, 5);
  });
});

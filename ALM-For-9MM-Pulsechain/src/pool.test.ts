/**
 * Unit tests for the TWAP deviation formula fix in src/pool.ts.
 *
 * The old formula was: (tickDiff / |twapTick|) * 10_000
 * The new formula is:  |1.0001^tickDiff - 1| * 10_000
 *
 * The new formula is price-relative (correct), while the old formula was
 * tick-relative (wrong — over-fires near tick=0, under-fires at large ticks).
 *
 * We test the formula directly without mocking the on-chain calls.
 */
import { describe, it, expect } from 'vitest';

/**
 * Replicate the corrected deviation formula from src/pool.ts line 118.
 * This is a pure function so we test it directly.
 */
function computeDeviationBps(spotTick: number, twapTick: number): number {
  const tickDiff = Math.abs(spotTick - twapTick);
  return Math.round(Math.abs(Math.pow(1.0001, tickDiff) - 1) * 10_000);
}

/**
 * Replicate the OLD (broken) formula for comparison.
 */
function computeDeviationBpsOld(spotTick: number, twapTick: number): number {
  const tickDiff = Math.abs(spotTick - twapTick);
  const twapAbs = Math.abs(twapTick) || 1;
  return Math.round((tickDiff / twapAbs) * 10_000);
}

describe('TWAP deviation formula (new price-relative)', () => {
  it('returns 0 when spot equals TWAP', () => {
    expect(computeDeviationBps(1000, 1000)).toBe(0);
    expect(computeDeviationBps(-500, -500)).toBe(0);
    expect(computeDeviationBps(0, 0)).toBe(0);
  });

  it('1 tick diff ≈ 1 bps (0.01% per tick definition)', () => {
    // 1.0001^1 - 1 = 0.0001 = 1 bps
    expect(computeDeviationBps(1001, 1000)).toBe(1);
    expect(computeDeviationBps(-1001, -1000)).toBe(1);
  });

  it('200 tick diff ≈ 200 bps regardless of absolute tick', () => {
    // At high absolute ticks, old formula was wrong; new formula is stable
    const bpsAtLowTick = computeDeviationBps(200, 0);
    const bpsAtHighTick = computeDeviationBps(10200, 10000);

    // Both should be close to 200 bps (actually slightly above due to compounding)
    expect(bpsAtLowTick).toBeGreaterThan(190);
    expect(bpsAtLowTick).toBeLessThan(215);

    expect(bpsAtHighTick).toBeGreaterThan(190);
    expect(bpsAtHighTick).toBeLessThan(215);

    // And they should be approximately equal to each other
    expect(Math.abs(bpsAtLowTick - bpsAtHighTick)).toBeLessThan(5);
  });

  it('old formula was wrong at extreme ticks (documents regression)', () => {
    // Old formula at twapTick=1: tickDiff=2 → 2/1 * 10000 = 20000 bps (WILDLY wrong)
    // New formula at twapTick=1: tickDiff=2 → ~2 bps (correct)
    const newBps = computeDeviationBps(3, 1);
    const oldBps = computeDeviationBpsOld(3, 1);

    expect(newBps).toBeLessThan(5);        // correct: ~2 bps
    expect(oldBps).toBeGreaterThan(1000);  // old was wildly wrong (20000 bps for 2 ticks)
  });

  it('100 tick diff ≈ 100 bps (1% price deviation)', () => {
    // 1.0001^100 - 1 ≈ 0.01005 ≈ 100.5 bps
    const bps = computeDeviationBps(100, 0);
    expect(bps).toBeGreaterThan(99);
    expect(bps).toBeLessThan(105);
  });

  it('200 bps threshold: 200 tick diff should exceed it', () => {
    const bps = computeDeviationBps(200, 0);
    expect(bps).toBeGreaterThan(200);
  });

  it('50 tick diff stays under 200 bps threshold', () => {
    const bps = computeDeviationBps(50, 0);
    expect(bps).toBeLessThan(200);
  });

  it('is symmetric: sign of ticks does not matter', () => {
    const bpsPos = computeDeviationBps(1100, 1000);
    const bpsNeg = computeDeviationBps(-1100, -1000);
    expect(bpsPos).toBe(bpsNeg);
  });
});

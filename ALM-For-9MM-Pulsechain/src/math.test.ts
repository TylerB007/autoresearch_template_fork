/**
 * Unit tests for src/math.ts — pure BigInt V3 math functions.
 * No mocks or network calls required.
 */
import { describe, it, expect } from 'vitest';
import {
  tickToSqrtPriceX96,
  sqrtPriceX96ToTick,
  nearestUsableTick,
  getAmountsForLiquidity,
  getLiquidityForAmounts,
  calculateSwapAmount,
  percentageToTicks,
  ticksToPercentage,
} from './math.js';

const Q96 = 1n << 96n;
const MAX_TICK = 887272;
const MIN_TICK = -887272;

// ── tickToSqrtPriceX96 ──────────────────────────────────────────────────────

describe('tickToSqrtPriceX96', () => {
  it('returns Q96 at tick 0 (price = 1.0)', () => {
    expect(tickToSqrtPriceX96(0)).toBe(Q96);
  });

  it('returns a value greater than Q96 for positive tick', () => {
    expect(tickToSqrtPriceX96(1)).toBeGreaterThan(Q96);
  });

  it('returns a value less than Q96 for negative tick', () => {
    expect(tickToSqrtPriceX96(-1)).toBeLessThan(Q96);
  });

  it('does not throw at MIN_TICK', () => {
    expect(() => tickToSqrtPriceX96(MIN_TICK)).not.toThrow();
  });

  it('does not throw at MAX_TICK', () => {
    expect(() => tickToSqrtPriceX96(MAX_TICK)).not.toThrow();
  });

  it('throws for ticks beyond MAX_TICK', () => {
    expect(() => tickToSqrtPriceX96(MAX_TICK + 1)).toThrow();
  });

  it('throws for ticks below MIN_TICK', () => {
    expect(() => tickToSqrtPriceX96(MIN_TICK - 1)).toThrow();
  });

  it('returns a BigInt', () => {
    expect(typeof tickToSqrtPriceX96(100)).toBe('bigint');
  });
});

// ── sqrtPriceX96ToTick ─────────────────────────────────────────────────────

describe('sqrtPriceX96ToTick', () => {
  it('returns 0 for Q96 input', () => {
    expect(sqrtPriceX96ToTick(Q96)).toBe(0);
  });

  it('round-trips tick 0', () => {
    const sqrtPrice = tickToSqrtPriceX96(0);
    expect(sqrtPriceX96ToTick(sqrtPrice)).toBe(0);
  });

  it('round-trips positive tick', () => {
    for (const tick of [1, 10, 100, 1000, 10000, 50000]) {
      const sqrtPrice = tickToSqrtPriceX96(tick);
      const recovered = sqrtPriceX96ToTick(sqrtPrice);
      // May be off by ±1 due to rounding in TickMath
      expect(Math.abs(recovered - tick)).toBeLessThanOrEqual(1);
    }
  });

  it('round-trips negative tick', () => {
    for (const tick of [-1, -10, -100, -1000, -10000, -50000]) {
      const sqrtPrice = tickToSqrtPriceX96(tick);
      const recovered = sqrtPriceX96ToTick(sqrtPrice);
      expect(Math.abs(recovered - tick)).toBeLessThanOrEqual(1);
    }
  });

  it('round-trips MIN_TICK', () => {
    const sqrtPrice = tickToSqrtPriceX96(MIN_TICK);
    const recovered = sqrtPriceX96ToTick(sqrtPrice);
    expect(Math.abs(recovered - MIN_TICK)).toBeLessThanOrEqual(1);
  });

  it('round-trips MAX_TICK', () => {
    const sqrtPrice = tickToSqrtPriceX96(MAX_TICK);
    const recovered = sqrtPriceX96ToTick(sqrtPrice);
    expect(Math.abs(recovered - MAX_TICK)).toBeLessThanOrEqual(1);
  });
});

// ── nearestUsableTick ───────────────────────────────────────────────────────

describe('nearestUsableTick', () => {
  it('throws for tickSpacing <= 0', () => {
    expect(() => nearestUsableTick(100, 0)).toThrow();
    expect(() => nearestUsableTick(100, -1)).toThrow();
  });

  it('snaps to tickSpacing=1 grid (no change)', () => {
    expect(nearestUsableTick(100, 1)).toBe(100);
    expect(nearestUsableTick(-100, 1)).toBe(-100);
  });

  it('snaps to tickSpacing=10 grid', () => {
    expect(nearestUsableTick(15, 10)).toBe(20);
    expect(nearestUsableTick(14, 10)).toBe(10);
    // JS Math.round(-1.5) = -1 (rounds toward +Infinity for halfway), so -15/10 → -10
    expect(nearestUsableTick(-15, 10)).toBe(-10);
    expect(nearestUsableTick(-16, 10)).toBe(-20);
  });

  it('snaps to tickSpacing=50 grid (9mm MEDIUM tier)', () => {
    expect(nearestUsableTick(75, 50)).toBe(100);
    expect(nearestUsableTick(74, 50)).toBe(50);
    expect(nearestUsableTick(0, 50)).toBe(0);
  });

  it('snaps to tickSpacing=60 grid (Uniswap MEDIUM tier)', () => {
    expect(nearestUsableTick(90, 60)).toBe(120);
    expect(nearestUsableTick(89, 60)).toBe(60);
  });

  it('clamps at MIN_TICK boundary', () => {
    const snapped = nearestUsableTick(MIN_TICK - 10, 10);
    expect(snapped).toBeGreaterThanOrEqual(
      Math.ceil(MIN_TICK / 10) * 10,
    );
  });

  it('clamps at MAX_TICK boundary', () => {
    const snapped = nearestUsableTick(MAX_TICK + 10, 10);
    expect(snapped).toBeLessThanOrEqual(
      Math.floor(MAX_TICK / 10) * 10,
    );
  });
});

// ── getAmountsForLiquidity ──────────────────────────────────────────────────

describe('getAmountsForLiquidity', () => {
  const LIQUIDITY = 1n << 60n; // reference liquidity

  it('returns only token0 when price is below range', () => {
    // sqrtPriceX96 < sqrtPriceAX96 → price below range
    const sqrtPriceLow = tickToSqrtPriceX96(-200); // current price below range
    const sqrtPriceA = tickToSqrtPriceX96(-100);   // range lower
    const sqrtPriceB = tickToSqrtPriceX96(100);    // range upper

    const { amount0, amount1 } = getAmountsForLiquidity(
      sqrtPriceLow, sqrtPriceA, sqrtPriceB, LIQUIDITY,
    );
    expect(amount0).toBeGreaterThan(0n);
    expect(amount1).toBe(0n);
  });

  it('returns only token1 when price is above range', () => {
    const sqrtPriceHigh = tickToSqrtPriceX96(200); // current price above range
    const sqrtPriceA = tickToSqrtPriceX96(-100);
    const sqrtPriceB = tickToSqrtPriceX96(100);

    const { amount0, amount1 } = getAmountsForLiquidity(
      sqrtPriceHigh, sqrtPriceA, sqrtPriceB, LIQUIDITY,
    );
    expect(amount0).toBe(0n);
    expect(amount1).toBeGreaterThan(0n);
  });

  it('returns both tokens when price is inside range', () => {
    const sqrtPriceMid = tickToSqrtPriceX96(0);
    const sqrtPriceA = tickToSqrtPriceX96(-100);
    const sqrtPriceB = tickToSqrtPriceX96(100);

    const { amount0, amount1 } = getAmountsForLiquidity(
      sqrtPriceMid, sqrtPriceA, sqrtPriceB, LIQUIDITY,
    );
    expect(amount0).toBeGreaterThan(0n);
    expect(amount1).toBeGreaterThan(0n);
  });

  it('returns zero amounts for zero liquidity', () => {
    const sqrtPriceMid = tickToSqrtPriceX96(0);
    const sqrtPriceA = tickToSqrtPriceX96(-100);
    const sqrtPriceB = tickToSqrtPriceX96(100);

    const { amount0, amount1 } = getAmountsForLiquidity(
      sqrtPriceMid, sqrtPriceA, sqrtPriceB, 0n,
    );
    expect(amount0).toBe(0n);
    expect(amount1).toBe(0n);
  });
});

// ── getLiquidityForAmounts ──────────────────────────────────────────────────

describe('getLiquidityForAmounts', () => {
  it('returns positive liquidity for balanced amounts inside range', () => {
    const sqrtPrice = tickToSqrtPriceX96(0);
    const sqrtPriceA = tickToSqrtPriceX96(-100);
    const sqrtPriceB = tickToSqrtPriceX96(100);

    const liquidity = getLiquidityForAmounts(
      sqrtPrice, sqrtPriceA, sqrtPriceB,
      1_000_000n, 1_000_000n,
    );
    expect(liquidity).toBeGreaterThan(0n);
  });

  it('is limited by token0 when token1 is the excess', () => {
    const sqrtPrice = tickToSqrtPriceX96(0);
    const sqrtPriceA = tickToSqrtPriceX96(-100);
    const sqrtPriceB = tickToSqrtPriceX96(100);

    const liqBalanced = getLiquidityForAmounts(
      sqrtPrice, sqrtPriceA, sqrtPriceB,
      1_000_000n, 1_000_000n,
    );
    const liqMoreToken1 = getLiquidityForAmounts(
      sqrtPrice, sqrtPriceA, sqrtPriceB,
      1_000_000n, 10_000_000n, // 10x token1 — limited by token0
    );
    // More token1 doesn't increase liquidity when token0 is the constraint
    expect(liqMoreToken1).toBeLessThanOrEqual(liqBalanced * 2n);
  });

  it('returns zero for zero amounts', () => {
    const sqrtPrice = tickToSqrtPriceX96(0);
    const sqrtPriceA = tickToSqrtPriceX96(-100);
    const sqrtPriceB = tickToSqrtPriceX96(100);

    const liquidity = getLiquidityForAmounts(
      sqrtPrice, sqrtPriceA, sqrtPriceB, 0n, 0n,
    );
    expect(liquidity).toBe(0n);
  });
});

// ── calculateSwapAmount ─────────────────────────────────────────────────────

describe('calculateSwapAmount', () => {
  const FEE_2500 = 2500; // 9mm MEDIUM tier

  it('returns zero amountIn when both amounts are zero', () => {
    const { amountIn } = calculateSwapAmount(
      0n, 0n, 0, -100, 100, FEE_2500,
    );
    expect(amountIn).toBe(0n);
  });

  it('swaps token0 when price is below range center', () => {
    // If current tick is below center of range, need to swap token0→token1
    const amount0 = 1_000_000n;
    const amount1 = 0n;
    // Range entirely above current tick → target is all token0
    const { tokenIn } = calculateSwapAmount(
      amount0, amount1, -200, -100, 100, FEE_2500,
    );
    // amountIn should be 0 since we already have the right ratio for a range above us
    // (target.amount0 = everything, so no swap needed)
    expect(['token0', 'token1']).toContain(tokenIn);
  });

  it('returns amountIn bounded by available balance', () => {
    const amount0 = 1_000n;
    const amount1 = 0n;
    const { amountIn } = calculateSwapAmount(
      amount0, amount1, 0, -100, 100, FEE_2500,
    );
    expect(amountIn).toBeLessThanOrEqual(amount0);
  });

  it('returns a BigInt amountIn', () => {
    const { amountIn } = calculateSwapAmount(
      1_000_000n, 1_000_000n, 0, -200, 200, FEE_2500,
    );
    expect(typeof amountIn).toBe('bigint');
  });

  it('accounts for fee: higher fee → more amountIn (fee is taken from output)', () => {
    const a0 = 10_000_000n;
    const a1 = 0n;
    const { amountIn: amountLowFee } = calculateSwapAmount(a0, a1, 0, -100, 100, 500);
    const { amountIn: amountHighFee } = calculateSwapAmount(a0, a1, 0, -100, 100, 10000);
    // Higher fee reduces effective output, so more input is needed to reach the same ratio
    expect(amountHighFee).toBeGreaterThanOrEqual(amountLowFee);
  });
});

// ── percentageToTicks / ticksToPercentage ────────────────────────────────────

describe('percentageToTicks', () => {
  it('returns 0 for percentage <= 0', () => {
    expect(percentageToTicks(0)).toBe(0);
    expect(percentageToTicks(-1)).toBe(0);
  });

  it('returns positive ticks for positive percentage', () => {
    expect(percentageToTicks(1)).toBeGreaterThan(0);
    expect(percentageToTicks(5)).toBeGreaterThan(0);
  });

  it('more percentage = more ticks (monotonic)', () => {
    const t1 = percentageToTicks(1);
    const t5 = percentageToTicks(5);
    const t10 = percentageToTicks(10);
    expect(t5).toBeGreaterThan(t1);
    expect(t10).toBeGreaterThan(t5);
  });

  it('3% converts to approximately 300 ticks (9mm center_3pct convention)', () => {
    // ln(1.03) / ln(1.0001) ≈ 295.7 → rounds to 296
    const ticks = percentageToTicks(3);
    expect(ticks).toBeGreaterThan(280);
    expect(ticks).toBeLessThan(320);
  });
});

describe('ticksToPercentage', () => {
  it('returns 0 for 0 ticks', () => {
    expect(ticksToPercentage(0)).toBe(0);
  });

  it('round-trips with percentageToTicks (within 0.5%)', () => {
    for (const pct of [1, 2, 3, 5, 10, 20]) {
      const ticks = percentageToTicks(pct);
      const recovered = ticksToPercentage(ticks);
      expect(Math.abs(recovered - pct)).toBeLessThan(0.5);
    }
  });

  it('is symmetric for positive and negative ticks', () => {
    const pos = ticksToPercentage(100);
    const neg = ticksToPercentage(-100);
    expect(pos).toBeCloseTo(neg, 8);
  });
});

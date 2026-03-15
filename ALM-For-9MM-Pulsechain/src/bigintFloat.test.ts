import { describe, it, expect } from 'vitest';
import { bigintToFloat, bigintWeiToFloat, sqrtPriceX96ToPrice } from './bigintFloat.js';
import { tickToSqrtPriceX96 } from './math.js';

describe('bigintToFloat', () => {
  it('converts 1.5 ETH (18 decimals) correctly', () => {
    expect(bigintToFloat(1_500_000_000_000_000_000n, 18)).toBeCloseTo(1.5, 14);
  });

  it('converts 100 HEX (8 decimals) correctly', () => {
    expect(bigintToFloat(10_000_000_000n, 8)).toBe(100);
  });

  it('converts 1 USDC (6 decimals) correctly', () => {
    expect(bigintToFloat(1_000_000n, 6)).toBe(1);
  });

  it('returns 0 for 0n', () => {
    expect(bigintToFloat(0n, 18)).toBe(0);
  });

  it('handles negative values', () => {
    expect(bigintToFloat(-1_500_000_000_000_000_000n, 18)).toBeCloseTo(-1.5, 14);
  });

  it('handles large 18-decimal amounts that exceed 2^53 in raw form', () => {
    // 10 billion tokens with 18 decimals = 10^28, far exceeds 2^53
    const raw = 10_000_000_000n * 10n ** 18n;
    const result = bigintToFloat(raw, 18);
    expect(result).toBeCloseTo(10_000_000_000, 0);
  });

  it('produces correct results for amounts far exceeding 2^53', () => {
    // 1 quadrillion tokens with 18 decimals = 10^33, way beyond 2^53
    const raw = 1_000_000_000_000_000n * 10n ** 18n;
    const result = bigintToFloat(raw, 18);
    expect(result).toBeCloseTo(1_000_000_000_000_000, 0);
    // Verify integer part is exact
    expect(Math.round(result)).toBe(1_000_000_000_000_000);
  });

  it('preserves fractional precision via split path for 18-decimal tokens', () => {
    // 1.123456789012345678 tokens — verify all 18 decimal places are reasonable
    const raw = 1_123_456_789_012_345_678n;
    const result = bigintToFloat(raw, 18);
    // Should be approximately 1.123456789012345678
    // Float64 can represent ~15-16 significant digits, so we check to 14
    expect(result).toBeCloseTo(1.123456789012345678, 14);
  });

  it('handles 0 decimals correctly', () => {
    expect(bigintToFloat(42n, 0)).toBe(42);
  });

  it('handles very small amounts correctly', () => {
    // 1 wei = 0.000000000000000001 ETH
    expect(bigintToFloat(1n, 18)).toBeCloseTo(1e-18, 30);
  });
});

describe('bigintWeiToFloat', () => {
  it('converts 1 ETH worth of wei', () => {
    expect(bigintWeiToFloat(10n ** 18n)).toBe(1);
  });

  it('converts gas cost (1M gas * 500 gwei = 0.5 native)', () => {
    const gasCost = 1_000_000n * 500_000_000_000n; // 5e14 wei = 0.0005 ETH
    // 1M * 500 gwei = 1e6 * 5e11 = 5e17 wei = 0.5 ETH
    expect(bigintWeiToFloat(gasCost)).toBeCloseTo(0.5, 10);
  });
});

describe('sqrtPriceX96ToPrice', () => {
  const Q96 = 1n << 96n;

  it('returns 0 for sqrtPriceX96 = 0', () => {
    expect(sqrtPriceX96ToPrice(0n)).toBe(0);
  });

  it('returns 1.0 for sqrtPriceX96 = Q96 (tick 0)', () => {
    expect(sqrtPriceX96ToPrice(Q96)).toBeCloseTo(1.0, 10);
  });

  it('returns correct price for tick 100', () => {
    const sqrtPrice = tickToSqrtPriceX96(100);
    const price = sqrtPriceX96ToPrice(sqrtPrice);
    const expected = Math.pow(1.0001, 100); // ~1.01005
    expect(price).toBeCloseTo(expected, 5);
  });

  it('returns correct price for tick -100', () => {
    const sqrtPrice = tickToSqrtPriceX96(-100);
    const price = sqrtPriceX96ToPrice(sqrtPrice);
    const expected = Math.pow(1.0001, -100);
    expect(price).toBeCloseTo(expected, 5);
  });

  it('handles extreme negative tick (HEX/WPLS territory, tick -60000)', () => {
    const sqrtPrice = tickToSqrtPriceX96(-60000);
    const price = sqrtPriceX96ToPrice(sqrtPrice);
    const expected = Math.pow(1.0001, -60000);
    expect(price).toBeCloseTo(expected, 8);
    expect(price).toBeGreaterThan(0);
    expect(price).toBeLessThan(1);
  });

  it('handles large positive tick (tick 60000)', () => {
    const sqrtPrice = tickToSqrtPriceX96(60000);
    const price = sqrtPriceX96ToPrice(sqrtPrice);
    const expected = Math.pow(1.0001, 60000);
    expect(price).toBeCloseTo(expected, -1); // large number, relative precision
    expect(price).toBeGreaterThan(1);
    expect(isFinite(price)).toBe(true);
  });

  it('does not return 0 or Infinity (regression for broken Number() approach)', () => {
    // The OLD code: Number(sqrtPrice^2) / Number(Q96^2) returned garbage
    const sqrtPrice = tickToSqrtPriceX96(-60000);
    const price = sqrtPriceX96ToPrice(sqrtPrice);
    expect(price).not.toBe(0);
    expect(price).not.toBe(Infinity);
    expect(price).not.toBe(-Infinity);
    expect(isNaN(price)).toBe(false);
  });

  it('works correctly at extreme ticks where old approach completely fails', () => {
    // At tick -200000, sqrtPriceX96 is very small, sqrtPriceX96^2 is tiny
    // but the Number() divisions of 192-bit values produce garbage
    const sqrtPrice = tickToSqrtPriceX96(-200000);
    const expected = Math.pow(1.0001, -200000);

    const newResult = sqrtPriceX96ToPrice(sqrtPrice);
    const relError = Math.abs(newResult - expected) / expected;
    expect(relError).toBeLessThan(0.001); // < 0.1% error
    expect(newResult).toBeGreaterThan(0);
    expect(isFinite(newResult)).toBe(true);
  });

  it('works correctly at large positive ticks', () => {
    const sqrtPrice = tickToSqrtPriceX96(200000);
    const expected = Math.pow(1.0001, 200000);

    const newResult = sqrtPriceX96ToPrice(sqrtPrice);
    const relError = Math.abs(newResult - expected) / expected;
    expect(relError).toBeLessThan(0.001);
    expect(isFinite(newResult)).toBe(true);
  });
});

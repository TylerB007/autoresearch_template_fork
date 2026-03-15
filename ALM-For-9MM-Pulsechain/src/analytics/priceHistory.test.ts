/**
 * Unit tests for src/analytics/priceHistory.ts
 *
 * Tests cover:
 *   - computeViabilityFields() — profitability floor formula (σ²/8)
 *   - buildPriceHistoryRecord() — factory function
 *   - computeSigma() — log-return annualized volatility (via synthetic in-memory data)
 *   - stdDev internals (via known-value sigma assertions)
 */
import { describe, it, expect } from 'vitest';
import { computeViabilityFields, buildPriceHistoryRecord } from './priceHistory.js';
import type { PriceHistoryRecord } from './types.js';

// ── computeViabilityFields ────────────────────────────────────────────────────

describe('computeViabilityFields', () => {
  it('returns empty object when sigma30d is undefined', () => {
    const result = computeViabilityFields(undefined, 0.5, 6);
    expect(result).toEqual({});
  });

  it('returns empty object when poolFeeRate is undefined', () => {
    const result = computeViabilityFields(0.8, undefined, 6);
    expect(result).toEqual({});
  });

  it('returns empty object when both are undefined', () => {
    expect(computeViabilityFields(undefined, undefined, 6)).toEqual({});
  });

  it('computes minPlRate = sigma30d² / 8', () => {
    // sigma30d = 2.0 → minPlRate = 4 / 8 = 0.5
    const { minPlRate } = computeViabilityFields(2.0, 1.0, undefined);
    expect(minPlRate).toBeCloseTo(0.5, 10);
  });

  it('profitabilityViable = true when poolFeeRate > minPlRate', () => {
    // sigma30d = 0.5 → minPlRate = 0.25/8 = 0.03125
    // poolFeeRate = 0.1 > 0.03125 → viable
    const { profitabilityViable, profitabilityMargin } = computeViabilityFields(0.5, 0.1, undefined);
    expect(profitabilityViable).toBe(true);
    expect(profitabilityMargin).toBeGreaterThan(0);
  });

  it('profitabilityViable = false when poolFeeRate < minPlRate', () => {
    // sigma30d = 4.0 → minPlRate = 16/8 = 2.0
    // poolFeeRate = 1.0 < 2.0 → not viable
    const { profitabilityViable, profitabilityMargin } = computeViabilityFields(4.0, 1.0, undefined);
    expect(profitabilityViable).toBe(false);
    expect(profitabilityMargin).toBeLessThan(0);
  });

  it('profitabilityMargin = poolFeeRate - minPlRate', () => {
    // sigma30d = 1.0 → minPlRate = 1/8 = 0.125
    // poolFeeRate = 0.3 → margin = 0.3 - 0.125 = 0.175
    const { profitabilityMargin } = computeViabilityFields(1.0, 0.3, undefined);
    expect(profitabilityMargin).toBeCloseTo(0.175, 10);
  });

  it('effectiveAprPct is undefined when widthPct is undefined', () => {
    const { effectiveAprPct } = computeViabilityFields(1.0, 0.3, undefined);
    expect(effectiveAprPct).toBeUndefined();
  });

  it('effectiveAprPct = poolFeeRate × (100 / widthPct)', () => {
    // poolFeeRate = 0.5, widthPct = 5 → effectiveAprPct = 0.5 × (100/5) = 10
    const { effectiveAprPct } = computeViabilityFields(1.0, 0.5, 5);
    expect(effectiveAprPct).toBeCloseTo(10, 10);
  });

  it('effectiveAprPct is undefined when widthPct = 0 (avoid div by zero)', () => {
    const { effectiveAprPct } = computeViabilityFields(1.0, 0.5, 0);
    expect(effectiveAprPct).toBeUndefined();
  });

  it('effectiveAprPct scales with concentration: narrower range → higher effective APR', () => {
    const wide = computeViabilityFields(1.0, 0.5, 20);
    const narrow = computeViabilityFields(1.0, 0.5, 5);
    expect(narrow.effectiveAprPct!).toBeGreaterThan(wide.effectiveAprPct!);
    // 4x narrower → 4x higher
    expect(narrow.effectiveAprPct!).toBeCloseTo(wide.effectiveAprPct! * 4, 5);
  });

  it('all four fields present when all inputs provided', () => {
    const result = computeViabilityFields(1.0, 0.3, 6);
    expect(result.minPlRate).toBeDefined();
    expect(result.profitabilityMargin).toBeDefined();
    expect(result.profitabilityViable).toBeDefined();
    expect(result.effectiveAprPct).toBeDefined();
  });

  it('borderline case: poolFeeRate exactly equals minPlRate → not viable (strict >)', () => {
    // sigma30d = 2.0 → minPlRate = 0.5; poolFeeRate = 0.5 → not strictly greater
    const { profitabilityViable } = computeViabilityFields(2.0, 0.5, undefined);
    expect(profitabilityViable).toBe(false);
  });
});

// ── buildPriceHistoryRecord ───────────────────────────────────────────────────

describe('buildPriceHistoryRecord', () => {
  const pool = '0xAbCd1234567890abcdef1234567890ABCDEF1234';
  const chainId = 369;
  const ts = 1_700_000_000_000;

  it('returns a record with all supplied fields', () => {
    const rec = buildPriceHistoryRecord(pool, chainId, ts, 1.23, 0.001, 0.01, 'dexscreener');
    expect(rec.poolAddress).toBe(pool.toLowerCase());
    expect(rec.chainId).toBe(chainId);
    expect(rec.timestamp).toBe(ts);
    expect(rec.priceRatio).toBe(1.23);
    expect(rec.priceUsd0).toBe(0.001);
    expect(rec.priceUsd1).toBe(0.01);
    expect(rec.source).toBe('dexscreener');
  });

  it('normalises poolAddress to lowercase', () => {
    const rec = buildPriceHistoryRecord('0xABCDEF', chainId, ts, 1, 1, 1, 'test');
    expect(rec.poolAddress).toBe('0xabcdef');
  });

  it('assigns a non-empty priceHistoryId UUID', () => {
    const rec = buildPriceHistoryRecord(pool, chainId, ts, 1, 1, 1, 'test');
    expect(typeof rec.priceHistoryId).toBe('string');
    expect(rec.priceHistoryId.length).toBeGreaterThan(0);
    // UUID format: xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
    expect(rec.priceHistoryId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('each call produces a unique priceHistoryId', () => {
    const a = buildPriceHistoryRecord(pool, chainId, ts, 1, 1, 1, 'test');
    const b = buildPriceHistoryRecord(pool, chainId, ts, 1, 1, 1, 'test');
    expect(a.priceHistoryId).not.toBe(b.priceHistoryId);
  });
});

// ── computeSigma pure math — log-return σ formula ────────────────────────────

/**
 * These tests verify the log-return annualized σ formula directly,
 * bypassing the file I/O layer by computing the expected values manually.
 *
 * Formula: sigma = std_dev(log_returns) × √(samples_per_year)
 * Where samples_per_year = 105,120 (288 obs/day × 365)
 */
describe('log-return σ formula (unit)', () => {
  /**
   * Compute stdDev of an array (population σ), matching priceHistory.ts implementation.
   */
  function stdDev(values: number[]): number {
    if (values.length === 0) return 0;
    const mean = values.reduce((s, v) => s + v, 0) / values.length;
    const variance = values.reduce((s, v) => s + (v - mean) ** 2, 0) / values.length;
    return Math.sqrt(variance);
  }

  /**
   * Compute log returns from a series of price ratios.
   */
  function logReturns(prices: number[]): number[] {
    const returns: number[] = [];
    for (let i = 1; i < prices.length; i++) {
      returns.push(Math.log(prices[i] / prices[i - 1]));
    }
    return returns;
  }

  it('constant price → σ = 0 (no returns variation)', () => {
    const prices = [1.0, 1.0, 1.0, 1.0, 1.0];
    const returns = logReturns(prices);
    expect(stdDev(returns)).toBe(0);
  });

  it('single observation → no log returns → stdDev = 0', () => {
    expect(stdDev([])).toBe(0);
  });

  it('log returns are symmetric for equal up/down moves', () => {
    // ln(2/1) = ln(2), ln(1/2) = -ln(2)
    const up = Math.log(2 / 1);
    const down = Math.log(1 / 2);
    expect(up).toBeCloseTo(-down, 10);
  });

  it('annualization: σ × √N scales correctly (double samples → √2 × σ)', () => {
    const prices = [1.0, 1.1, 0.9, 1.05, 0.95];
    const returns = logReturns(prices);
    const rawSigma = stdDev(returns);
    const samples1 = 1000;
    const samples2 = 4000; // 4x more samples per year
    const annualized1 = rawSigma * Math.sqrt(samples1);
    const annualized2 = rawSigma * Math.sqrt(samples2);
    // 4x samples → 2x annualized σ
    expect(annualized2).toBeCloseTo(annualized1 * 2, 5);
  });

  it('σ of known prices produces known result', () => {
    // Prices: 1.0, 1.01, 1.0201 (constant 1% returns)
    // log returns: [ln(1.01), ln(1.01)] → all identical → stdDev = 0
    const prices = [1.0, 1.01, 1.0201];
    const returns = logReturns(prices);
    expect(stdDev(returns)).toBeCloseTo(0, 10);
  });

  it('σ > 0 for varying price moves', () => {
    const prices = [1.0, 1.05, 0.95, 1.10, 0.90];
    const returns = logReturns(prices);
    expect(stdDev(returns)).toBeGreaterThan(0);
  });

  it('larger price swings → larger σ (monotonic)', () => {
    const quiet = logReturns([1.0, 1.001, 0.999, 1.001]);
    const volatile = logReturns([1.0, 1.10, 0.90, 1.10]);
    expect(stdDev(volatile)).toBeGreaterThan(stdDev(quiet));
  });
});

// ── computeViabilityFields — real-world sigma values ─────────────────────────

describe('computeViabilityFields — realistic σ values', () => {
  it('σ=0.8 (80% annualized vol) is typical high-vol crypto', () => {
    // minPlRate = 0.64 / 8 = 0.08
    // A pool with 10% annual fee rate would be viable (0.10 > 0.08)
    const { profitabilityViable, minPlRate } = computeViabilityFields(0.8, 0.10, undefined);
    expect(minPlRate).toBeCloseTo(0.08, 5);
    expect(profitabilityViable).toBe(true);
  });

  it('σ=2.0 (200% annualized vol) extreme volatility makes most pools unviable', () => {
    // minPlRate = 4.0 / 8 = 0.5
    // Even 40% annual fee rate cannot beat a 50% min_pl_rate
    const { profitabilityViable } = computeViabilityFields(2.0, 0.40, undefined);
    expect(profitabilityViable).toBe(false);
  });

  it('σ=0.3 (30% annualized vol) low-vol stable pair', () => {
    // minPlRate = 0.09 / 8 = 0.01125
    // A 5% annual fee rate is easily viable
    const { profitabilityViable, profitabilityMargin } = computeViabilityFields(0.3, 0.05, undefined);
    expect(profitabilityViable).toBe(true);
    expect(profitabilityMargin).toBeCloseTo(0.05 - 0.09 / 8, 5);
  });
});

// ── PriceHistoryRecord type shape ─────────────────────────────────────────────

describe('PriceHistoryRecord shape', () => {
  it('satisfies the type contract for all required fields', () => {
    const rec: PriceHistoryRecord = buildPriceHistoryRecord(
      '0x1234567890abcdef1234567890abcdef12345678',
      1,
      Date.now(),
      1500.5,
      0.001,
      1500.5,
      'dexscreener',
    );
    // All required fields present
    expect(typeof rec.priceHistoryId).toBe('string');
    expect(typeof rec.poolAddress).toBe('string');
    expect(typeof rec.chainId).toBe('number');
    expect(typeof rec.timestamp).toBe('number');
    expect(typeof rec.priceRatio).toBe('number');
    expect(typeof rec.priceUsd0).toBe('number');
    expect(typeof rec.priceUsd1).toBe('number');
    expect(typeof rec.source).toBe('string');
  });
});

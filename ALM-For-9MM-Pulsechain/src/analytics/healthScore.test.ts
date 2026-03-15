/**
 * Unit tests for src/analytics/healthScore.ts — position health score calculation.
 * Pure function, no mocks required.
 */
import { describe, it, expect } from 'vitest';
import { calculateHealthScore } from './healthScore.js';
import type { HealthScoreInput } from './healthScore.js';

// ── Baseline / neutral ───────────────────────────────────────────────────────

describe('calculateHealthScore — baseline', () => {
  it('starts at 50 when all components are neutral (no optionals)', () => {
    // APR 5-20 = 0, time 50-70 = 0, pnl<0 = -15 → 50-15 = 35 → label 'fair'
    // Use pnl>0 for true neutral: 50 + 15 (pnl) = 65
    const result = calculateHealthScore({
      netPnlUsd: 1,        // +15
      avgFeeAPR: 10,       // 0 (5-20 band)
      timeInRangePercent: 60, // 0 (50-70 band)
    });
    expect(result.score).toBe(65);
    expect(result.label).toBe('good');
  });

  it('returns a score, label, and full breakdown', () => {
    const result = calculateHealthScore({ netPnlUsd: 1, avgFeeAPR: 10, timeInRangePercent: 60 });
    expect(typeof result.score).toBe('number');
    expect(['excellent', 'good', 'fair', 'poor']).toContain(result.label);
    expect(typeof result.breakdown.pnlComponent).toBe('number');
    expect(typeof result.breakdown.aprComponent).toBe('number');
    expect(typeof result.breakdown.rangeComponent).toBe('number');
    expect(typeof result.breakdown.ilComponent).toBe('number');
    expect(typeof result.breakdown.proximityComponent).toBe('number');
    expect(typeof result.breakdown.executionCostComponent).toBe('number');
  });
});

// ── APR component ────────────────────────────────────────────────────────────

describe('calculateHealthScore — APR component', () => {
  const BASE: HealthScoreInput = { netPnlUsd: 0, avgFeeAPR: 0, timeInRangePercent: 60 };

  it('APR > 50% → +20', () => {
    const r = calculateHealthScore({ ...BASE, avgFeeAPR: 51 });
    expect(r.breakdown.aprComponent).toBe(20);
  });

  it('APR > 20% → +10', () => {
    const r = calculateHealthScore({ ...BASE, avgFeeAPR: 25 });
    expect(r.breakdown.aprComponent).toBe(10);
  });

  it('APR 5-20% → 0 (neutral band)', () => {
    const r = calculateHealthScore({ ...BASE, avgFeeAPR: 10 });
    expect(r.breakdown.aprComponent).toBe(0);
  });

  it('APR exactly 20% → 0 (boundary is exclusive: > 20)', () => {
    const r = calculateHealthScore({ ...BASE, avgFeeAPR: 20 });
    expect(r.breakdown.aprComponent).toBe(0);
  });

  it('APR exactly 50% → 0 (boundary is exclusive: > 50)', () => {
    const r = calculateHealthScore({ ...BASE, avgFeeAPR: 50 });
    expect(r.breakdown.aprComponent).toBe(10); // falls into > 20 band
  });

  it('APR < 5% → -10', () => {
    const r = calculateHealthScore({ ...BASE, avgFeeAPR: 2 });
    expect(r.breakdown.aprComponent).toBe(-10);
  });

  it('APR 0% → -10', () => {
    const r = calculateHealthScore({ ...BASE, avgFeeAPR: 0 });
    expect(r.breakdown.aprComponent).toBe(-10);
  });
});

// ── Time-in-range component ──────────────────────────────────────────────────

describe('calculateHealthScore — time-in-range component', () => {
  const BASE: HealthScoreInput = { netPnlUsd: 1, avgFeeAPR: 10, timeInRangePercent: 0 };

  it('> 90% → +15', () => {
    const r = calculateHealthScore({ ...BASE, timeInRangePercent: 95 });
    expect(r.breakdown.rangeComponent).toBe(15);
  });

  it('> 70% (and ≤ 90%) → +5', () => {
    const r = calculateHealthScore({ ...BASE, timeInRangePercent: 80 });
    expect(r.breakdown.rangeComponent).toBe(5);
  });

  it('50-70% → 0 (neutral)', () => {
    const r = calculateHealthScore({ ...BASE, timeInRangePercent: 60 });
    expect(r.breakdown.rangeComponent).toBe(0);
  });

  it('exactly 70% → 0 (boundary is exclusive: > 70)', () => {
    const r = calculateHealthScore({ ...BASE, timeInRangePercent: 70 });
    expect(r.breakdown.rangeComponent).toBe(0);
  });

  it('exactly 90% → 0 (boundary is exclusive: > 90)', () => {
    const r = calculateHealthScore({ ...BASE, timeInRangePercent: 90 });
    expect(r.breakdown.rangeComponent).toBe(5); // falls into > 70 band
  });

  it('< 50% → -15', () => {
    const r = calculateHealthScore({ ...BASE, timeInRangePercent: 30 });
    expect(r.breakdown.rangeComponent).toBe(-15);
  });

  it('0% → -15', () => {
    const r = calculateHealthScore({ ...BASE, timeInRangePercent: 0 });
    expect(r.breakdown.rangeComponent).toBe(-15);
  });
});

// ── P&L component ────────────────────────────────────────────────────────────

describe('calculateHealthScore — P&L component', () => {
  const BASE: HealthScoreInput = { netPnlUsd: 0, avgFeeAPR: 10, timeInRangePercent: 60 };

  it('positive P&L → +15', () => {
    const r = calculateHealthScore({ ...BASE, netPnlUsd: 0.01 });
    expect(r.breakdown.pnlComponent).toBe(15);
  });

  it('zero P&L → -15 (not positive)', () => {
    const r = calculateHealthScore({ ...BASE, netPnlUsd: 0 });
    expect(r.breakdown.pnlComponent).toBe(-15);
  });

  it('negative P&L → -15', () => {
    const r = calculateHealthScore({ ...BASE, netPnlUsd: -100 });
    expect(r.breakdown.pnlComponent).toBe(-15);
  });
});

// ── IL component ─────────────────────────────────────────────────────────────

describe('calculateHealthScore — IL component (optional)', () => {
  const BASE: HealthScoreInput = { netPnlUsd: 1, avgFeeAPR: 10, timeInRangePercent: 60 };

  it('omitted IL → ilComponent = 0', () => {
    const r = calculateHealthScore(BASE);
    expect(r.breakdown.ilComponent).toBe(0);
  });

  it('IL < 0.5% (minimal) → +10', () => {
    const r = calculateHealthScore({ ...BASE, impermanentLossPercent: -0.1 });
    expect(r.breakdown.ilComponent).toBe(10);
  });

  it('IL = 0% → +10', () => {
    const r = calculateHealthScore({ ...BASE, impermanentLossPercent: 0 });
    expect(r.breakdown.ilComponent).toBe(10);
  });

  it('IL between 0.5% and 5% → 0 (neutral)', () => {
    const r = calculateHealthScore({ ...BASE, impermanentLossPercent: -2 });
    expect(r.breakdown.ilComponent).toBe(0);
  });

  it('IL > 5% (severe) → -10', () => {
    const r = calculateHealthScore({ ...BASE, impermanentLossPercent: -10 });
    expect(r.breakdown.ilComponent).toBe(-10);
  });

  it('absIL is used — positive IL value treated same as negative', () => {
    const neg = calculateHealthScore({ ...BASE, impermanentLossPercent: -8 });
    const pos = calculateHealthScore({ ...BASE, impermanentLossPercent: 8 });
    expect(neg.breakdown.ilComponent).toBe(pos.breakdown.ilComponent);
  });
});

// ── Proximity component ──────────────────────────────────────────────────────

describe('calculateHealthScore — proximity component (optional)', () => {
  const BASE: HealthScoreInput = { netPnlUsd: 1, avgFeeAPR: 10, timeInRangePercent: 60 };

  it('omitted proximity inputs → proximityComponent = 0', () => {
    const r = calculateHealthScore(BASE);
    expect(r.breakdown.proximityComponent).toBe(0);
  });

  it('ratio > 2 (far from edge) → +5', () => {
    const r = calculateHealthScore({ ...BASE, distanceFromEdgeTicks: 300, triggerDistanceTicks: 100 });
    expect(r.breakdown.proximityComponent).toBe(5);
  });

  it('ratio 0.5–2 (mid) → 0', () => {
    const r = calculateHealthScore({ ...BASE, distanceFromEdgeTicks: 100, triggerDistanceTicks: 100 });
    expect(r.breakdown.proximityComponent).toBe(0);
  });

  it('ratio < 0.5 (near edge) → -5', () => {
    const r = calculateHealthScore({ ...BASE, distanceFromEdgeTicks: 20, triggerDistanceTicks: 100 });
    expect(r.breakdown.proximityComponent).toBe(-5);
  });

  it('triggerDistanceTicks = 0 → proximity ignored (no divide by zero)', () => {
    const r = calculateHealthScore({ ...BASE, distanceFromEdgeTicks: 100, triggerDistanceTicks: 0 });
    expect(r.breakdown.proximityComponent).toBe(0);
  });
});

// ── Execution cost component ─────────────────────────────────────────────────

describe('calculateHealthScore — execution cost component (optional)', () => {
  const BASE: HealthScoreInput = { netPnlUsd: 1, avgFeeAPR: 10, timeInRangePercent: 60 };

  it('omitted → executionCostComponent = 0', () => {
    const r = calculateHealthScore(BASE);
    expect(r.breakdown.executionCostComponent).toBe(0);
  });

  it('0% cost (undefined) → 0', () => {
    const r = calculateHealthScore({ ...BASE, avgRebalanceCostPercent: undefined });
    expect(r.breakdown.executionCostComponent).toBe(0);
  });

  it('< 0.5% cost (efficient) → +5', () => {
    const r = calculateHealthScore({ ...BASE, avgRebalanceCostPercent: 0.3 });
    expect(r.breakdown.executionCostComponent).toBe(5);
  });

  it('0.5-2% cost → 0 (neutral band)', () => {
    const r = calculateHealthScore({ ...BASE, avgRebalanceCostPercent: 1 });
    expect(r.breakdown.executionCostComponent).toBe(0);
  });

  it('2-5% cost → -10', () => {
    const r = calculateHealthScore({ ...BASE, avgRebalanceCostPercent: 3 });
    expect(r.breakdown.executionCostComponent).toBe(-10);
  });

  it('> 5% cost (very expensive) → -15', () => {
    const r = calculateHealthScore({ ...BASE, avgRebalanceCostPercent: 8 });
    expect(r.breakdown.executionCostComponent).toBe(-15);
  });
});

// ── Score clamping and label assignment ──────────────────────────────────────

describe('calculateHealthScore — clamping and labels', () => {
  it('score is clamped to minimum 0', () => {
    // Worst possible: low APR (-10), low TiR (-15), negative PnL (-15), high IL (-10), near edge (-5), high cost (-15)
    // 50 - 10 - 15 - 15 - 10 - 5 - 15 = -20 → clamped to 0
    const r = calculateHealthScore({
      netPnlUsd: -1,
      avgFeeAPR: 2,
      timeInRangePercent: 10,
      impermanentLossPercent: -20,
      distanceFromEdgeTicks: 5,
      triggerDistanceTicks: 50,
      avgRebalanceCostPercent: 10,
    });
    expect(r.score).toBe(0);
    expect(r.label).toBe('poor');
  });

  it('score is clamped to maximum 100', () => {
    // Best possible: APR>50 (+20), TiR>90 (+15), positive PnL (+15), IL<0.5 (+10), far edge (+5), low cost (+5)
    // 50 + 20 + 15 + 15 + 10 + 5 + 5 = 120 → clamped to 100
    const r = calculateHealthScore({
      netPnlUsd: 1000,
      avgFeeAPR: 100,
      timeInRangePercent: 99,
      impermanentLossPercent: 0,
      distanceFromEdgeTicks: 500,
      triggerDistanceTicks: 50,
      avgRebalanceCostPercent: 0.1,
    });
    expect(r.score).toBe(100);
    expect(r.label).toBe('excellent');
  });

  it('score >= 75 → "excellent"', () => {
    const r = calculateHealthScore({ netPnlUsd: 1, avgFeeAPR: 100, timeInRangePercent: 99 });
    expect(r.score).toBeGreaterThanOrEqual(75);
    expect(r.label).toBe('excellent');
  });

  it('score >= 50 and < 75 → "good"', () => {
    // 50 + 0 (APR neutral) + 0 (TiR neutral) + 15 (pnl) = 65 → good
    const r = calculateHealthScore({ netPnlUsd: 1, avgFeeAPR: 10, timeInRangePercent: 60 });
    expect(r.score).toBeGreaterThanOrEqual(50);
    expect(r.score).toBeLessThan(75);
    expect(r.label).toBe('good');
  });

  it('score >= 25 and < 50 → "fair"', () => {
    // 50 - 15 (pnl) - 10 (low APR) + 0 (TiR neutral) = 25 → fair
    const r = calculateHealthScore({ netPnlUsd: -1, avgFeeAPR: 2, timeInRangePercent: 60 });
    expect(r.score).toBeGreaterThanOrEqual(25);
    expect(r.score).toBeLessThan(50);
    expect(r.label).toBe('fair');
  });

  it('score < 25 → "poor"', () => {
    const r = calculateHealthScore({ netPnlUsd: -1, avgFeeAPR: 2, timeInRangePercent: 10 });
    // 50 - 15 - 10 - 15 = 10 → poor
    expect(r.score).toBeLessThan(25);
    expect(r.label).toBe('poor');
  });

  it('breakdown components sum to (score - 50) before clamping (unclamped case)', () => {
    const r = calculateHealthScore({ netPnlUsd: 1, avgFeeAPR: 10, timeInRangePercent: 60 });
    const componentSum =
      r.breakdown.pnlComponent + r.breakdown.aprComponent + r.breakdown.rangeComponent +
      r.breakdown.ilComponent + r.breakdown.proximityComponent + r.breakdown.executionCostComponent;
    expect(r.score).toBe(50 + componentSum);
  });
});

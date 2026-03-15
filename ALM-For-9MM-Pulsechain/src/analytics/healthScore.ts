/**
 * Position health score — single 0-100 metric combining multiple performance indicators.
 * Extracted from src/server/routes/analytics.ts for reuse across Telegram, dashboard, and export.
 */

// ============================================================
// TYPES
// ============================================================

export interface HealthScoreInput {
  /** Net P&L in USD (fees - gas costs) */
  netPnlUsd: number;
  /** Average annualized fee APR (%) */
  avgFeeAPR: number;
  /** Percentage of time position was in range (0-100) */
  timeInRangePercent: number;
  /** Impermanent loss percentage (optional, negative = loss) */
  impermanentLossPercent?: number;
  /** Average days between rebalances (optional) */
  rebalanceFrequencyDays?: number;
  /** Current distance from nearest range edge in ticks (optional) */
  distanceFromEdgeTicks?: number;
  /** Configured trigger distance in ticks (optional, for proximity scoring) */
  triggerDistanceTicks?: number;
  /** Average rebalance execution cost as % of position value (optional) */
  avgRebalanceCostPercent?: number;
}

export interface HealthScoreBreakdown {
  pnlComponent: number;
  aprComponent: number;
  rangeComponent: number;
  ilComponent: number;
  proximityComponent: number;
  executionCostComponent: number;
}

export interface HealthScoreResult {
  /** Overall health score (0-100) */
  score: number;
  /** Human-readable label */
  label: 'excellent' | 'good' | 'fair' | 'poor';
  /** Per-component breakdown showing what contributed to the score */
  breakdown: HealthScoreBreakdown;
}

// ============================================================
// SCORING
// ============================================================

/**
 * Calculate a position health score from 0-100.
 *
 * Starts at 50 (neutral) and adjusts based on five components:
 * - APR performance: +20 to -10
 * - Time in range: +15 to -15
 * - P&L direction: +15 or -15
 * - Impermanent loss severity: +10 to -10
 * - Edge proximity (how far from trigger): +5 to -5
 */
export function calculateHealthScore(input: HealthScoreInput): HealthScoreResult {
  let score = 50;
  const breakdown: HealthScoreBreakdown = {
    pnlComponent: 0,
    aprComponent: 0,
    rangeComponent: 0,
    ilComponent: 0,
    proximityComponent: 0,
    executionCostComponent: 0,
  };

  // APR component (max +/- 20)
  if (input.avgFeeAPR > 50) {
    breakdown.aprComponent = 20;
  } else if (input.avgFeeAPR > 20) {
    breakdown.aprComponent = 10;
  } else if (input.avgFeeAPR < 5) {
    breakdown.aprComponent = -10;
  }

  // Time-in-range component (max +/- 15)
  if (input.timeInRangePercent > 90) {
    breakdown.rangeComponent = 15;
  } else if (input.timeInRangePercent > 70) {
    breakdown.rangeComponent = 5;
  } else if (input.timeInRangePercent < 50) {
    breakdown.rangeComponent = -15;
  }

  // P&L component (+15 or -15)
  if (input.netPnlUsd > 0) {
    breakdown.pnlComponent = 15;
  } else {
    breakdown.pnlComponent = -15;
  }

  // IL component (optional, max +/- 10)
  if (input.impermanentLossPercent !== undefined) {
    const absIl = Math.abs(input.impermanentLossPercent);
    if (absIl < 0.5) {
      breakdown.ilComponent = 10;
    } else if (absIl > 5) {
      breakdown.ilComponent = -10;
    }
  }

  // Edge proximity component (optional, max +/- 5)
  if (
    input.distanceFromEdgeTicks !== undefined &&
    input.triggerDistanceTicks !== undefined &&
    input.triggerDistanceTicks > 0
  ) {
    const ratio = input.distanceFromEdgeTicks / input.triggerDistanceTicks;
    if (ratio > 2) {
      breakdown.proximityComponent = 5;
    } else if (ratio < 0.5) {
      breakdown.proximityComponent = -5;
    }
  }

  // Execution cost component (optional, max +5 / -15)
  if (input.avgRebalanceCostPercent !== undefined && input.avgRebalanceCostPercent > 0) {
    if (input.avgRebalanceCostPercent < 0.5) {
      breakdown.executionCostComponent = 5;
    } else if (input.avgRebalanceCostPercent > 5) {
      breakdown.executionCostComponent = -15;
    } else if (input.avgRebalanceCostPercent > 2) {
      breakdown.executionCostComponent = -10;
    }
  }

  // Sum components
  score += breakdown.pnlComponent + breakdown.aprComponent + breakdown.rangeComponent +
    breakdown.ilComponent + breakdown.proximityComponent + breakdown.executionCostComponent;

  // Clamp to 0-100
  score = Math.max(0, Math.min(100, score));

  const label: HealthScoreResult['label'] =
    score >= 75 ? 'excellent' :
    score >= 50 ? 'good' :
    score >= 25 ? 'fair' :
    'poor';

  return { score, label, breakdown };
}

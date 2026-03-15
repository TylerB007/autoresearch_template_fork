/**
 * Scoring system — computes the composite net_score metric.
 *
 * net_score = w1 * net_roi_pct
 *           + w2 * time_in_range_pct
 *           - w3 * max_drawdown_pct
 *           - w4 * churn_penalty
 *
 * Higher is better (opposite of autoresearch's val_bpb).
 */

import type { SimulationResult, BacktestConfig } from './types.js';

/**
 * Calculate the composite net_score from simulation results.
 */
export function calculateNetScore(
  result: Omit<SimulationResult, 'netScore'>,
  config: BacktestConfig,
): number {
  const { w1_roi, w2_time_in_range, w3_max_drawdown, w4_churn_penalty } = config;

  // Churn penalty: penalize if rebalancing more than roughly once per day
  const expectedRebalancesPerDay = 1;
  const expectedRebalances = result.simulationDays * expectedRebalancesPerDay;
  const excessRebalances = Math.max(0, result.rebalanceCount - expectedRebalances);
  const churnPenalty = excessRebalances;

  const score =
    w1_roi * result.netRoiPercent +
    w2_time_in_range * result.timeInRangePercent -
    w3_max_drawdown * result.maxDrawdownPercent -
    w4_churn_penalty * churnPenalty;

  return Math.round(score * 1000) / 1000; // 3 decimal places
}

/**
 * Calculate maximum drawdown from a value history series.
 * Drawdown = (peak - trough) / peak * 100
 */
export function calculateMaxDrawdown(
  valueHistory: { timestamp: number; valueToken0: number }[],
): number {
  if (valueHistory.length < 2) return 0;

  let peak = valueHistory[0].valueToken0;
  let maxDrawdown = 0;

  for (const entry of valueHistory) {
    if (entry.valueToken0 > peak) {
      peak = entry.valueToken0;
    }
    const drawdown = peak > 0 ? ((peak - entry.valueToken0) / peak) * 100 : 0;
    if (drawdown > maxDrawdown) {
      maxDrawdown = drawdown;
    }
  }

  return Math.round(maxDrawdown * 100) / 100;
}

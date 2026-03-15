/**
 * Tick volatility calculation from position snapshots.
 * Computes realized volatility as the standard deviation of tick changes
 * over a configurable rolling window.
 */

import type { PositionSnapshot } from './types.js';

// ============================================================
// TYPES
// ============================================================

export interface VolatilityResult {
  /** Standard deviation of absolute tick changes per snapshot interval */
  stdDev: number;
  /** Volatility regime classification */
  regime: 'low' | 'medium' | 'high';
  /** Mean absolute tick change per interval */
  avgTickChange: number;
  /** Maximum absolute tick change observed in window */
  maxTickChange: number;
  /** Number of tick-change observations used */
  sampleCount: number;
  /** Window duration in minutes */
  windowMinutes: number;
}

// ============================================================
// REGIME THRESHOLDS
// ============================================================

// Tuned for 9mm HEX/WPLS with 60s polling interval and tick spacing 50.
// - Low: price barely moving, few rebalances expected
// - Medium: normal market conditions
// - High: rapid price movement, rebalances likely frequent
const LOW_THRESHOLD = 5;   // stdDev < 5 ticks per interval
const HIGH_THRESHOLD = 20; // stdDev > 20 ticks per interval

// ============================================================
// CORE CALCULATION
// ============================================================

/**
 * Calculate tick volatility from a series of position snapshots.
 *
 * @param snapshots - Snapshots to analyze (will be filtered to window)
 * @param windowMinutes - Rolling window in minutes (default 60)
 * @returns Volatility metrics and regime classification
 */
export function calculateTickVolatility(
  snapshots: PositionSnapshot[],
  windowMinutes: number = 60,
): VolatilityResult {
  const windowMs = windowMinutes * 60 * 1000;
  const cutoff = Date.now() - windowMs;

  // Filter to window and sort chronologically
  const windowed = snapshots
    .filter((s) => s.timestamp >= cutoff)
    .sort((a, b) => a.timestamp - b.timestamp);

  if (windowed.length < 2) {
    return {
      stdDev: 0,
      regime: 'low',
      avgTickChange: 0,
      maxTickChange: 0,
      sampleCount: 0,
      windowMinutes,
    };
  }

  // Compute absolute tick changes between consecutive snapshots
  const tickChanges: number[] = [];
  for (let i = 1; i < windowed.length; i++) {
    tickChanges.push(Math.abs(windowed[i].currentTick - windowed[i - 1].currentTick));
  }

  // Statistics
  const mean = tickChanges.reduce((a, b) => a + b, 0) / tickChanges.length;
  const variance =
    tickChanges.reduce((sum, v) => sum + (v - mean) ** 2, 0) / tickChanges.length;
  const stdDev = Math.sqrt(variance);
  const maxTickChange = Math.max(...tickChanges);

  // Classify regime
  let regime: VolatilityResult['regime'];
  if (stdDev < LOW_THRESHOLD) regime = 'low';
  else if (stdDev > HIGH_THRESHOLD) regime = 'high';
  else regime = 'medium';

  return {
    stdDev,
    regime,
    avgTickChange: mean,
    maxTickChange,
    sampleCount: tickChanges.length,
    windowMinutes,
  };
}

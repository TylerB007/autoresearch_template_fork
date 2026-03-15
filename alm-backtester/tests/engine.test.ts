/**
 * Sanity tests for the backtester engine.
 */

import { describe, it, expect } from 'vitest';
import { generateSyntheticData } from '../src/data_loader.js';
import { runSimulation } from '../src/engine.js';
import type { BacktestConfig } from '../src/types.js';

function makeConfig(overrides: Partial<BacktestConfig> = {}): BacktestConfig {
  return {
    strategy: 'center',
    width_ticks: 600,
    trigger_distance_ticks: 50,
    confirm_minutes: 0,
    critical_distance_ticks: 200,
    lower_ratio_percent: 50,
    max_rebalances_per_window: 10,
    churn_window_hours: 6,
    cost_benefit_enabled: false,
    min_fee_to_cost_ratio: 1.5,
    pool_fee_bps: 2500,
    tick_spacing: 50,
    pool_liquidity_usd: 500_000,
    daily_volume_usd: 100_000,
    token0_decimals: 8,
    token1_decimals: 18,
    gas_cost_per_rebalance_usd: 0.05,
    slippage_bps: 50,
    initial_capital_usd: 10_000,
    initial_price_token0_usd: 0.005,
    w1_roi: 1.0,
    w2_time_in_range: 0.1,
    w3_max_drawdown: 0.2,
    w4_churn_penalty: 0.05,
    ...overrides,
  };
}

function makeSyntheticData(opts: { volatility?: number; drift?: number; days?: number } = {}) {
  return generateSyntheticData({
    startTick: -23000,
    durationDays: opts.days ?? 7,
    intervalSeconds: 60,
    volatility: opts.volatility ?? 0.5,
    drift: opts.drift ?? 0,
    seed: 42,
  });
}

describe('Engine sanity checks', () => {
  it('should produce valid simulation results', () => {
    const data = makeSyntheticData();
    const result = runSimulation(data, makeConfig());

    expect(result.netScore).toBeDefined();
    expect(typeof result.netScore).toBe('number');
    expect(result.simulationDays).toBeGreaterThan(0);
    expect(result.elapsedSeconds).toBeGreaterThan(0);
    expect(result.timeInRangePercent).toBeGreaterThanOrEqual(0);
    expect(result.timeInRangePercent).toBeLessThanOrEqual(100);
  });

  it('wider range should produce higher time-in-range', () => {
    const data = makeSyntheticData();
    const narrow = runSimulation(data, makeConfig({ width_ticks: 200 }));
    const wide = runSimulation(data, makeConfig({ width_ticks: 1200 }));

    expect(wide.timeInRangePercent).toBeGreaterThan(narrow.timeInRangePercent);
  });

  it('wider range should produce fewer rebalances', () => {
    const data = makeSyntheticData({ volatility: 0.8 });
    const narrow = runSimulation(data, makeConfig({ width_ticks: 200 }));
    const wide = runSimulation(data, makeConfig({ width_ticks: 1200 }));

    expect(wide.rebalanceCount).toBeLessThanOrEqual(narrow.rebalanceCount);
  });

  it('static strategy should never rebalance', () => {
    const data = makeSyntheticData({ volatility: 1.0 });
    const result = runSimulation(data, makeConfig({ strategy: 'static' }));

    expect(result.rebalanceCount).toBe(0);
    expect(result.totalGasCostsUsd).toBe(0);
  });

  it('gas costs should accumulate per rebalance', () => {
    const data = makeSyntheticData({ volatility: 0.8 });
    const gasCost = 0.10;
    const result = runSimulation(data, makeConfig({
      width_ticks: 200,
      gas_cost_per_rebalance_usd: gasCost,
      confirm_minutes: 0,
    }));

    if (result.rebalanceCount > 0) {
      // Gas costs should be at least rebalanceCount * gas_cost
      expect(result.totalGasCostsUsd).toBeGreaterThanOrEqual(
        result.rebalanceCount * gasCost * 0.99, // Allow small floating point tolerance
      );
    }
  });

  it('zero volatility should produce few or no rebalances', () => {
    const data = makeSyntheticData({ volatility: 0.01 });
    const result = runSimulation(data, makeConfig({ width_ticks: 600 }));

    expect(result.rebalanceCount).toBeLessThanOrEqual(1);
    expect(result.timeInRangePercent).toBeGreaterThan(90);
  });

  it('confirmation delay should reduce rebalance frequency', () => {
    const data = makeSyntheticData({ volatility: 0.8 });
    const noDelay = runSimulation(data, makeConfig({ confirm_minutes: 0 }));
    const withDelay = runSimulation(data, makeConfig({ confirm_minutes: 120 }));

    expect(withDelay.rebalanceCount).toBeLessThanOrEqual(noDelay.rebalanceCount);
  });

  it('should complete in under 30 seconds for 30-day data', () => {
    const data = makeSyntheticData({ days: 30 });
    const start = performance.now();
    runSimulation(data, makeConfig());
    const elapsed = (performance.now() - start) / 1000;

    expect(elapsed).toBeLessThan(30);
  });
});

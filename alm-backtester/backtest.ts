/**
 * Backtest entry point — loads data, runs simulation, prints results.
 *
 * Output format matches autoresearch pattern: grep-parseable key:value lines.
 * The agent extracts `net_score:` from the output to decide keep/discard.
 */

import { existsSync, readdirSync } from 'fs';
import { join } from 'path';
import CONFIG from './strategy_config.js';
import { loadPriceData, interpolateToUniform, generateSyntheticData } from './src/data_loader.js';
import { runSimulation } from './src/engine.js';
import type { SimulationResult } from './src/types.js';

function main() {
  console.log('=== ALM Strategy Backtester ===');
  console.log(`Strategy: ${CONFIG.strategy}`);
  console.log(`Width: ${CONFIG.width_ticks} ticks | Trigger: ${CONFIG.trigger_distance_ticks} ticks`);
  console.log(`Confirm: ${CONFIG.confirm_minutes} min | Critical: ${CONFIG.critical_distance_ticks} ticks`);
  console.log('');

  // Load price data — try JSONL files first, fall back to synthetic
  const dataDir = join(import.meta.dirname ?? '.', 'data');
  let allResults: SimulationResult[] = [];

  if (existsSync(dataDir)) {
    const dataFiles = readdirSync(dataDir).filter(f => f.endsWith('.jsonl'));

    if (dataFiles.length > 0) {
      console.log(`Found ${dataFiles.length} data file(s)`);

      for (const file of dataFiles) {
        const filePath = join(dataDir, file);
        console.log(`Running on: ${file}`);
        const raw = loadPriceData(filePath);
        const data = interpolateToUniform(raw, 60_000);
        console.log(`  ${data.length} data points (${(data.length / 1440).toFixed(1)} days)`);

        const result = runSimulation(data, CONFIG);
        allResults.push(result);
      }
    }
  }

  // Fall back to synthetic data if no JSONL files found
  if (allResults.length === 0) {
    console.log('No data files found — using synthetic price data');
    console.log('');

    // Generate 3 different market scenarios for robustness
    const scenarios = [
      { name: 'Sideways (low vol)', volatility: 0.3, drift: 0, seed: 42 },
      { name: 'Trending up (med vol)', volatility: 0.5, drift: 0.2, seed: 123 },
      { name: 'Volatile (high vol)', volatility: 0.8, drift: -0.1, seed: 999 },
    ];

    for (const scenario of scenarios) {
      console.log(`Scenario: ${scenario.name}`);
      const data = generateSyntheticData({
        startTick: -23000, // Approximate HEX/WPLS tick
        durationDays: 30,
        intervalSeconds: 60,
        volatility: scenario.volatility,
        drift: scenario.drift,
        seed: scenario.seed,
      });
      console.log(`  ${data.length} data points (30 days)`);

      const result = runSimulation(data, CONFIG);
      allResults.push(result);
    }
  }

  // Average results across all periods/scenarios
  const avgResult = averageResults(allResults);

  // Print results in grep-parseable format (like autoresearch's val_bpb output)
  console.log('');
  console.log('--- RESULTS ---');
  console.log(`net_score:            ${avgResult.netScore}`);
  console.log(`net_roi_pct:          ${avgResult.netRoiPercent}`);
  console.log(`time_in_range_pct:    ${avgResult.timeInRangePercent}`);
  console.log(`total_fees_token0:    ${avgResult.totalFeesToken0}`);
  console.log(`total_gas_costs_usd:  ${avgResult.totalGasCostsUsd}`);
  console.log(`total_slippage_usd:   ${avgResult.totalSlippageUsd}`);
  console.log(`impermanent_loss_pct: ${avgResult.impermanentLossPercent}`);
  console.log(`rebalance_count:      ${avgResult.rebalanceCount}`);
  console.log(`max_drawdown_pct:     ${avgResult.maxDrawdownPercent}`);
  console.log(`simulation_days:      ${avgResult.simulationDays}`);
  console.log(`elapsed_seconds:      ${avgResult.elapsedSeconds}`);
  console.log(`num_periods:          ${allResults.length}`);
}

function averageResults(results: SimulationResult[]): SimulationResult {
  if (results.length === 0) {
    throw new Error('No results to average');
  }
  if (results.length === 1) return results[0];

  const n = results.length;
  const avg = (key: keyof SimulationResult) =>
    Math.round((results.reduce((sum, r) => sum + (r[key] as number), 0) / n) * 1000) / 1000;

  return {
    netScore: avg('netScore'),
    netRoiPercent: avg('netRoiPercent'),
    timeInRangePercent: avg('timeInRangePercent'),
    totalFeesToken0: avg('totalFeesToken0'),
    totalGasCostsUsd: avg('totalGasCostsUsd'),
    totalSlippageUsd: avg('totalSlippageUsd'),
    impermanentLossPercent: avg('impermanentLossPercent'),
    rebalanceCount: Math.round(results.reduce((s, r) => s + r.rebalanceCount, 0) / n),
    maxDrawdownPercent: avg('maxDrawdownPercent'),
    simulationDays: avg('simulationDays'),
    elapsedSeconds: avg('elapsedSeconds'),
  };
}

main();

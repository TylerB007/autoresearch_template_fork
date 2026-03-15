/**
 * Data preparation script — generates synthetic price data for backtesting.
 *
 * Phase 1: Synthetic data only (GBM random walks with configurable params).
 * Phase 3 (future): Fetch real data from DexScreener API or on-chain events.
 *
 * Usage: npx tsx prepare.ts
 */

import { writeFileSync, mkdirSync, existsSync } from 'fs';
import { join } from 'path';
import { generateSyntheticData } from './src/data_loader.js';

const DATA_DIR = join(import.meta.dirname ?? '.', 'data');

function main() {
  // Ensure data directory exists
  if (!existsSync(DATA_DIR)) {
    mkdirSync(DATA_DIR, { recursive: true });
  }

  console.log('=== ALM Backtester Data Preparation ===');
  console.log('');

  // Generate a variety of market scenarios
  const scenarios = [
    {
      name: 'sideways-low-vol',
      startTick: 59650,
      durationDays: 30,
      volatility: 0.3,
      drift: 0,
      seed: 42,
    },
    {
      name: 'sideways-med-vol',
      startTick: 59650,
      durationDays: 30,
      volatility: 0.5,
      drift: 0,
      seed: 84,
    },
    {
      name: 'trending-up',
      startTick: 59650,
      durationDays: 30,
      volatility: 0.5,
      drift: 0.3,
      seed: 123,
    },
    {
      name: 'trending-down',
      startTick: 59650,
      durationDays: 30,
      volatility: 0.5,
      drift: -0.3,
      seed: 456,
    },
    {
      name: 'high-volatility',
      startTick: 59650,
      durationDays: 30,
      volatility: 1.0,
      drift: 0,
      seed: 789,
    },
    {
      name: 'choppy-mean-reverting',
      startTick: 59650,
      durationDays: 30,
      volatility: 0.6,
      drift: 0.05,
      seed: 999,
    },
  ];

  for (const scenario of scenarios) {
    const fileName = `synthetic-${scenario.name}.jsonl`;
    const filePath = join(DATA_DIR, fileName);

    console.log(`Generating: ${fileName}`);
    console.log(`  Duration: ${scenario.durationDays} days`);
    console.log(`  Volatility: ${(scenario.volatility * 100).toFixed(0)}%`);
    console.log(`  Drift: ${(scenario.drift * 100).toFixed(0)}%`);

    const data = generateSyntheticData({
      startTick: scenario.startTick,
      durationDays: scenario.durationDays,
      intervalSeconds: 60,
      volatility: scenario.volatility,
      drift: scenario.drift,
      seed: scenario.seed,
    });

    // Write as JSONL (omit sqrtPriceX96 since it's derived from tick)
    const lines = data.map(d =>
      JSON.stringify({ timestamp: d.timestamp, tick: d.tick }),
    );
    writeFileSync(filePath, lines.join('\n') + '\n');

    const tickRange = data.reduce(
      (acc, d) => ({ min: Math.min(acc.min, d.tick), max: Math.max(acc.max, d.tick) }),
      { min: Infinity, max: -Infinity },
    );
    console.log(`  Data points: ${data.length}`);
    console.log(`  Tick range: [${tickRange.min}, ${tickRange.max}] (${tickRange.max - tickRange.min} spread)`);
    console.log('');
  }

  console.log(`Done! ${scenarios.length} data files written to ${DATA_DIR}/`);
  console.log('');
  console.log('Next: run `npx tsx backtest.ts` to run your first backtest.');
}

main();

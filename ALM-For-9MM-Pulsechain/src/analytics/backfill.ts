/**
 * Backfill migration script — recalculates rebalanceCostPercent/rebalanceCostToken0
 * for historical rebalance records that predate the execution cost tracking feature.
 *
 * Usage: npx tsx src/analytics/backfill.ts [analytics-path]
 * Default analytics path: ./analytics/
 *
 * Idempotent — only patches records where rebalanceCostPercent is missing/undefined.
 * Safe to run multiple times.
 */

import { readdir, readFile, writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { calculateRebalanceCost } from './metrics.js';
import type { AnalyticsRecord, RebalanceAnalytics } from './types.js';

const bigintReplacer = (_key: string, value: unknown): unknown =>
  typeof value === 'bigint' ? value.toString() : value;

const bigintReviver = (key: string, value: unknown): unknown => {
  const bigintFields = new Set([
    'liquidity', 'sqrtPriceX96', 'poolLiquidity', 'amount0', 'amount1',
    'tokensOwed0', 'tokensOwed1', 'feesCollected0', 'feesCollected1',
    'liquidityRemoved0', 'liquidityRemoved1', 'amountIn', 'amountOut',
    'newLiquidity', 'newAmount0', 'newAmount1', 'gasPrice', 'gasUsed',
    'collectFees', 'decreaseLiquidity', 'collectTokens', 'burn',
    'swap', 'approvals', 'mint', 'total',
    'totalFeesCollected0', 'totalFeesCollected1',
  ]);
  if (bigintFields.has(key) && typeof value === 'string' && /^\d+$/.test(value)) {
    return BigInt(value);
  }
  return value;
};

async function main(): Promise<void> {
  const storagePath = process.argv[2] || './analytics';
  console.log(`Backfill: scanning ${storagePath} for rebalance records...`);

  let entries: string[];
  try {
    entries = await readdir(storagePath);
  } catch {
    console.error(`ERROR: Cannot read directory: ${storagePath}`);
    process.exit(1);
  }

  const files = entries
    .filter((f) => f.startsWith('analytics-') && f.endsWith('.jsonl'))
    .sort();

  if (files.length === 0) {
    console.log('No analytics files found. Nothing to backfill.');
    return;
  }

  let totalRebalances = 0;
  let patched = 0;

  for (const file of files) {
    const filePath = join(storagePath, file);
    const content = await readFile(filePath, 'utf-8');
    const lines = content.trim().split('\n').filter(Boolean);

    let modified = false;
    const updatedLines: string[] = [];

    for (const line of lines) {
      const record: AnalyticsRecord = JSON.parse(line, bigintReviver);

      if (record.type === 'rebalance') {
        totalRebalances++;
        const rb = record.data as RebalanceAnalytics;

        // Only patch if the field is truly missing (not if it's 0 from a real calculation)
        if (
          rb.metrics.rebalanceCostPercent === undefined ||
          rb.metrics.rebalanceCostPercent === null
        ) {
          try {
            const { costPercent, costToken0 } = calculateRebalanceCost(rb);
            rb.metrics.rebalanceCostPercent = costPercent;
            rb.metrics.rebalanceCostToken0 = costToken0;
            modified = true;
            patched++;
            console.log(
              `  Patched: ${file} — #${rb.oldTokenId}→#${rb.newTokenId} ` +
              `cost=${costPercent.toFixed(2)}%`,
            );
          } catch (err) {
            console.warn(
              `  WARN: Failed to calculate cost for #${rb.oldTokenId}→#${rb.newTokenId}: ` +
              `${(err as Error).message}`,
            );
          }
        }
      }

      updatedLines.push(JSON.stringify(record, bigintReplacer));
    }

    if (modified) {
      const tmpPath = filePath + '.tmp';
      await writeFile(tmpPath, updatedLines.join('\n') + '\n');
      await rename(tmpPath, filePath);
      console.log(`  Wrote: ${file}`);
    }
  }

  console.log(`\nBackfill complete: patched ${patched} of ${totalRebalances} rebalance records.`);
}

main().catch((err) => {
  console.error('Backfill failed:', err);
  process.exit(1);
});


import { readdir, readFile, appendFile, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

// Minimal types for migration
interface AnalyticsRecord {
  type: string;
  timestamp: number;
  data: any;
}

const REBALANCES_FILE = 'rebalances.jsonl';
console.log('Migration script starting...');

// Simple BigInt handling
function bigintReviver(key: string, value: any) {
  const fields = [
    'liquidity', 'sqrtPriceX96', 'poolLiquidity', 'amount0', 'amount1',
    'tokensOwed0', 'tokensOwed1', 'feesCollected0', 'feesCollected1',
    'liquidityRemoved0', 'liquidityRemoved1', 'amountIn', 'amountOut',
    'newLiquidity', 'newAmount0', 'newAmount1', 'gasPrice', 'gasUsed',
    'collectFees', 'decreaseLiquidity', 'collectTokens', 'burn',
    'swap', 'approvals', 'mint', 'total',
    'totalFeesCollected0', 'totalFeesCollected1',
  ];
  if (fields.includes(key) && typeof value === 'string' && /^\d+$/.test(value)) {
    return BigInt(value);
  }
  return value;
}

function bigintReplacer(key: string, value: any) {
  return typeof value === 'bigint' ? value.toString() : value;
}

async function migrateDirectory(dirPath: string) {
  const targetFile = join(dirPath, REBALANCES_FILE);
  
  if (existsSync(targetFile)) {
    console.log(`⚠️  ${REBALANCES_FILE} already exists in ${dirPath}. Skipping.`);
    return;
  }

  const files = await readdir(dirPath);
  const analyticsFiles = files
    .filter(f => f.startsWith('analytics-') && f.endsWith('.jsonl'))
    .sort();

  console.log(`Found ${analyticsFiles.length} analytics files in ${dirPath}`);
  
  let count = 0;
  for (const file of analyticsFiles) {
    const content = await readFile(join(dirPath, file), 'utf-8');
    const lines = content.trim().split('\n');
    
    for (const line of lines) {
      if (!line) continue;
      try {
        const record = JSON.parse(line, bigintReviver) as AnalyticsRecord;
        if (record.type === 'rebalance') {
          await appendFile(targetFile, JSON.stringify(record, bigintReplacer) + '\n');
          count++;
        }
      } catch (err) {
        // ignore parse errors
      }
    }
  }
  console.log(`✅  Migrated ${count} rebalance records to ${targetFile}`);
}

async function main() {
  const baseDir = resolve(process.cwd(), 'analytics');
  if (!existsSync(baseDir)) {
    console.error('Analytics directory not found');
    return;
  }

  const entries = await readdir(baseDir, { withFileTypes: true });
  
  // 1. Process base directory
  await migrateDirectory(baseDir);

  // 2. Process chain subdirectories
  for (const entry of entries) {
    if (entry.isDirectory() && entry.name.startsWith('chain-')) {
      await migrateDirectory(join(baseDir, entry.name));
    }
  }
}

main().catch(console.error);

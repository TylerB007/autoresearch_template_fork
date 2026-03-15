
const { readdir, stat, unlink } = require('fs/promises');
const { join, resolve } = require('path');
const { existsSync } = require('fs');

const MAX_DAYS = 30;
const REBALANCES_FILE = 'rebalances.jsonl';

async function pruneOldSnapshots(storagePath) {
  try {
    if (!existsSync(storagePath)) return;

    // 1. Safety Check: Ensure the permanent rebalance history exists
    const permanentHistoryPath = join(storagePath, REBALANCES_FILE);
    if (!existsSync(permanentHistoryPath)) {
      console.warn(`[PRUNE] Skipping pruning for ${storagePath}: Permanent rebalance history (${REBALANCES_FILE}) not found.`);
      return;
    }

    // 2. Identify old files
    const cutoffTime = Date.now() - (MAX_DAYS * 24 * 60 * 60 * 1000);
    const files = await readdir(storagePath);
    
    let deletedCount = 0;
    let freedSpace = 0;

    for (const file of files) {
      if (!file) continue;
      // Expected format: analytics-YYYY-MM-DD.jsonl
      const match = file.match(/analytics-(\d{4}-\d{2}-\d{2})\.jsonl/);
      if (!match) continue;

      const fileDate = new Date(match[1]);
      if (fileDate.getTime() < cutoffTime) {
        const fullPath = join(storagePath, file);
        const stats = await stat(fullPath);
        await unlink(fullPath);
        deletedCount++;
        freedSpace += stats.size;
      }
    }

    if (deletedCount > 0) {
      const mb = (freedSpace / 1024 / 1024).toFixed(2);
      console.log(`[PRUNE] Deleted ${deletedCount} old files from ${storagePath} (${mb} MB freed)`);
    }
  } catch (error) {
    console.error(`[PRUNE] Error pruning ${storagePath}:`, error.message);
  }
}

async function main() {
  const baseDir = resolve(__dirname, '../analytics');
  
  if (!existsSync(baseDir)) {
    console.log('Analytics directory not found, nothing to prune.');
    return;
  }

  const entries = await readdir(baseDir, { withFileTypes: true });
  
  // 1. Process chain subdirectories
  const chainDirs = entries.filter(e => e.isDirectory() && e.name.startsWith('chain-'));
  for (const dir of chainDirs) {
    await pruneOldSnapshots(join(baseDir, dir.name));
  }

  // 2. Process root directory (legacy)
  await pruneOldSnapshots(baseDir);
}

main();

/**
 * JSON Lines persistence layer for analytics data.
 * Daily rotated files: analytics/analytics-2026-02-09.jsonl
 * Async, non-blocking writes with BigInt serialization.
 */

import { appendFile, mkdir, readFile, readdir, writeFile, rename } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { AnalyticsRecord, RebalanceAnalytics, PositionSnapshot, FeeCollectionRecord, RebalanceLifecycleEvent, PositionEntryRecord, ManualLink, TriggerEvent, StrategyRuleSetSnapshot } from './types.js';
import logger from '../logger.js';

/**
 * Per-chain storage subdirectory: `{basePath}/chain-{chainId}/`
 * Falls back to basePath if the subdir doesn't exist (backward compat with flat layout).
 */
export function chainStoragePath(basePath: string, chainId: number): string {
  return join(basePath, `chain-${chainId}`);
}

/**
 * Resolve the actual storage path for a chain: returns the per-chain subdir if it exists,
 * otherwise the base path (backward compat with pre-multi-chain flat layout).
 */
export function resolveStoragePath(basePath: string, chainId?: number): string {
  if (chainId === undefined) return basePath;
  const perChain = chainStoragePath(basePath, chainId);
  if (existsSync(perChain)) return perChain;
  return basePath;
}

const bigintReplacer = (_key: string, value: unknown): unknown =>
  typeof value === 'bigint' ? value.toString() : value;

const bigintReviver = (key: string, value: unknown): unknown => {
  // Restore known bigint fields
  const bigintFields = new Set([
    'liquidity', 'sqrtPriceX96', 'poolLiquidity', 'amount0', 'amount1',
    'tokensOwed0', 'tokensOwed1', 'feesCollected0', 'feesCollected1',
    'liquidityRemoved0', 'liquidityRemoved1', 'amountIn', 'amountOut',
    'newLiquidity', 'newAmount0', 'newAmount1', 'gasPrice', 'gasUsed',
    'collectFees', 'decreaseLiquidity', 'collectTokens', 'burn',
    'swap', 'approvals', 'mint', 'total',
    'totalFeesCollected0', 'totalFeesCollected1',
    'dust0', 'dust1',
  ]);
  if (bigintFields.has(key) && typeof value === 'string' && /^\d+$/.test(value)) {
    return BigInt(value);
  }
  return value;
};

function getFilePath(storagePath: string, timestamp: number): string {
  const date = new Date(timestamp).toISOString().split('T')[0];
  return join(storagePath, `analytics-${date}.jsonl`);
}

export async function ensureStorageDir(storagePath: string): Promise<void> {
  if (!existsSync(storagePath)) {
    try {
      await mkdir(storagePath, { recursive: true });
      logger.info(`Created analytics storage directory: ${storagePath}`);
      console.log(`✓ Analytics directory created: ${storagePath}`);
    } catch (error) {
      const errMsg = `CRITICAL: Failed to create analytics directory: ${storagePath}`;
      logger.error(errMsg, { error });
      console.error(`❌ ${errMsg}`, error);
      throw error; // Re-throw to make caller aware
    }
  }
}

export async function writeAnalyticsRecord(
  record: AnalyticsRecord,
  storagePath: string,
): Promise<{ filePath: string; lineIndex: number } | undefined> {
  try {
    await ensureStorageDir(storagePath);
    const filePath = getFilePath(storagePath, record.timestamp);

    // Count existing lines to determine the index of the new record
    let lineIndex = 0;
    try {
      if (existsSync(filePath)) {
        const existing = await readFile(filePath, 'utf-8');
        lineIndex = existing.trim().split('\n').filter(Boolean).length;
      }
    } catch {
      // New file — lineIndex stays 0
    }

    const line = JSON.stringify(record, bigintReplacer) + '\n';
    await appendFile(filePath, line);
    logger.debug(`Analytics record written: ${record.type}`, { file: filePath });
    return { filePath, lineIndex };
  } catch (error) {
    const errMsg = `CRITICAL: Failed to write analytics record (type: ${record.type})`;
    logger.error(errMsg, { error, storagePath, recordType: record.type });
    console.error(`❌ ${errMsg}`, error);
    // Don't throw - analytics should never break the main flow
    return undefined;
  }
}

export async function readAnalyticsFile(filePath: string): Promise<AnalyticsRecord[]> {
  try {
    const content = await readFile(filePath, 'utf-8');
    const lines = content.trim().split('\n').filter(Boolean);
    return lines.map((line) => JSON.parse(line, bigintReviver) as AnalyticsRecord);
  } catch {
    return [];
  }
}

export async function queryRebalances(
  storagePath: string,
  startTime?: number,
  endTime?: number,
): Promise<RebalanceAnalytics[]> {
  // PREFERRED: Read from the lightweight dedicated file if it exists
  const dedicatedFile = join(storagePath, REBALANCES_FILE);

  let records: AnalyticsRecord[] = [];
  
  if (existsSync(dedicatedFile)) {
    // Fast path: cached history
    records = await readAnalyticsFile(dedicatedFile);
  } else {
    // Slow path: Fallback to scanning all daily files (legacy behavior)
    // This handles the case before migration is run
    const files = await listAnalyticsFiles(storagePath);
    for (const file of files) {
      const fileRecords = await readAnalyticsFile(join(storagePath, file));
      records.push(...fileRecords);
    }
  }

  const results: RebalanceAnalytics[] = [];
  for (const record of records) {
    if (record.type !== 'rebalance') continue;
    if (startTime && record.timestamp < startTime) continue;
    if (endTime && record.timestamp > endTime) continue;
    results.push(record.data as RebalanceAnalytics);
  }

  return results.sort((a, b) => a.timestamp - b.timestamp);
}

export async function querySnapshots(
  storagePath: string,
  tokenId?: number,
  startTime?: number,
  endTime?: number,
): Promise<PositionSnapshot[]> {
  const files = await listAnalyticsFiles(storagePath);
  const results: PositionSnapshot[] = [];

  for (const file of files) {
    const records = await readAnalyticsFile(join(storagePath, file));
    for (const record of records) {
      if (record.type !== 'snapshot') continue;
      if (startTime && record.timestamp < startTime) continue;
      if (endTime && record.timestamp > endTime) continue;
      const snapshot = record.data as PositionSnapshot;
      if (tokenId !== undefined && snapshot.tokenId !== tokenId) continue;
      results.push(snapshot);
    }
  }

  return results.sort((a, b) => a.timestamp - b.timestamp);
}

export async function queryFeeCollections(
  storagePath: string,
  tokenId?: number,
  startTime?: number,
  endTime?: number,
): Promise<FeeCollectionRecord[]> {
  const files = await listAnalyticsFiles(storagePath);
  const results: FeeCollectionRecord[] = [];

  for (const file of files) {
    const records = await readAnalyticsFile(join(storagePath, file));
    for (const record of records) {
      if (record.type !== 'fee_collection') continue;
      if (startTime && record.timestamp < startTime) continue;
      if (endTime && record.timestamp > endTime) continue;
      const fc = record.data as FeeCollectionRecord;
      if (tokenId !== undefined && fc.tokenId !== tokenId) continue;
      results.push(fc);
    }
  }

  return results.sort((a, b) => a.timestamp - b.timestamp);
}

export async function queryPositionEntries(
  storagePath: string,
  tokenId?: number,
): Promise<PositionEntryRecord[]> {
  const files = await listAnalyticsFiles(storagePath);
  const results: PositionEntryRecord[] = [];

  for (const file of files) {
    const records = await readAnalyticsFile(join(storagePath, file));
    for (const record of records) {
      if (record.type !== 'position_entry') continue;
      const entry = record.data as PositionEntryRecord;
      if (tokenId !== undefined && entry.tokenId !== tokenId) continue;
      results.push(entry);
    }
  }

  return results.sort((a, b) => a.timestamp - b.timestamp);
}

export async function queryLifecycleEvents(
  storagePath: string,
  tokenId?: number,
  rebalanceId?: string,
  startTime?: number,
  endTime?: number,
): Promise<RebalanceLifecycleEvent[]> {
  const files = await listAnalyticsFiles(storagePath);
  const results: RebalanceLifecycleEvent[] = [];

  for (const file of files) {
    const records = await readAnalyticsFile(join(storagePath, file));
    for (const record of records) {
      if (record.type !== 'lifecycle_event') continue;
      if (startTime && record.timestamp < startTime) continue;
      if (endTime && record.timestamp > endTime) continue;
      const event = record.data as RebalanceLifecycleEvent;
      if (tokenId !== undefined && event.tokenId !== tokenId && event.newTokenId !== tokenId) continue;
      if (rebalanceId !== undefined && event.rebalanceId !== rebalanceId) continue;
      results.push(event);
    }
  }

  return results.sort((a, b) => a.timestamp - b.timestamp);
}

/**
 * Query fee collections across ALL chain subdirectories plus the base (legacy) path.
 * Deduplicates by tokenId+txHash.
 */
export async function queryAllChainFeeCollections(
  basePath: string,
  tokenId?: number,
  startTime?: number,
  endTime?: number,
): Promise<FeeCollectionRecord[]> {
  const results: FeeCollectionRecord[] = [];
  results.push(...await queryFeeCollections(basePath, tokenId, startTime, endTime));
  if (existsSync(basePath)) {
    const entries = await readdir(basePath);
    for (const entry of entries) {
      if (entry.startsWith('chain-')) {
        results.push(...await queryFeeCollections(join(basePath, entry), tokenId, startTime, endTime));
      }
    }
  }
  const seen = new Set<string>();
  return results
    .filter((r) => {
      const key = `${r.tokenId}:${r.txHash}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => a.timestamp - b.timestamp);
}

/**
 * Query snapshots across ALL chain subdirectories plus the base (legacy) path.
 * Deduplicates by tokenId+timestamp.
 */
export async function queryAllChainSnapshots(
  basePath: string,
  tokenId?: number,
  startTime?: number,
  endTime?: number,
): Promise<PositionSnapshot[]> {
  const results: PositionSnapshot[] = [];
  results.push(...await querySnapshots(basePath, tokenId, startTime, endTime));
  if (existsSync(basePath)) {
    const entries = await readdir(basePath);
    for (const entry of entries) {
      if (entry.startsWith('chain-')) {
        results.push(...await querySnapshots(join(basePath, entry), tokenId, startTime, endTime));
      }
    }
  }
  const seen = new Set<string>();
  return results
    .filter((s) => {
      const key = `${s.tokenId}:${s.timestamp}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => a.timestamp - b.timestamp);
}

/**
 * Query position entries across ALL chain subdirectories plus the base (legacy) path.
 * Deduplicates by tokenId+txHash.
 */
export async function queryAllChainPositionEntries(
  basePath: string,
  tokenId?: number,
): Promise<PositionEntryRecord[]> {
  const results: PositionEntryRecord[] = [];
  results.push(...await queryPositionEntries(basePath, tokenId));
  if (existsSync(basePath)) {
    const entries = await readdir(basePath);
    for (const entry of entries) {
      if (entry.startsWith('chain-')) {
        results.push(...await queryPositionEntries(join(basePath, entry), tokenId));
      }
    }
  }
  const seen = new Set<string>();
  return results
    .filter((e) => {
      const key = `${e.tokenId}:${e.txHash}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => a.timestamp - b.timestamp);
}

/**
 * Query rebalances across ALL chain subdirectories plus the base (legacy) path.
 * Deduplicates by rebalanceId in case data exists in both locations.
 */
export async function queryAllChainRebalances(
  basePath: string,
  startTime?: number,
  endTime?: number,
): Promise<RebalanceAnalytics[]> {
  const results: RebalanceAnalytics[] = [];
  // 1. Base path (legacy flat layout)
  results.push(...await queryRebalances(basePath, startTime, endTime));
  // 2. Per-chain subdirectories
  if (existsSync(basePath)) {
    const entries = await readdir(basePath);
    for (const entry of entries) {
      if (entry.startsWith('chain-')) {
        results.push(...await queryRebalances(join(basePath, entry), startTime, endTime));
      }
    }
  }
  const seen = new Set<string>();
  return results
    .filter(r => { if (seen.has(r.rebalanceId)) return false; seen.add(r.rebalanceId); return true; })
    .sort((a, b) => a.timestamp - b.timestamp);
}

export async function queryAllChainManualLinks(basePath: string): Promise<ManualLink[]> {
  const results: ManualLink[] = [];
  results.push(...await readManualLinks(basePath));
  if (existsSync(basePath)) {
    const entries = await readdir(basePath);
    for (const entry of entries) {
      if (entry.startsWith('chain-')) {
        results.push(...await readManualLinks(join(basePath, entry)));
      }
    }
  }
  const seen = new Set<string>();
  return results.filter((link) => {
    const key = `${link.chainId ?? 'na'}:${link.dex ?? 'default'}:${link.oldTokenId}:${link.newTokenId}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Query lifecycle events across ALL chain subdirectories plus the base (legacy) path.
 * Deduplicates by timestamp+tokenId+step to avoid double-counting.
 */
export async function queryAllChainLifecycleEvents(
  basePath: string,
  tokenId?: number,
  rebalanceId?: string,
  startTime?: number,
  endTime?: number,
): Promise<RebalanceLifecycleEvent[]> {
  const results: RebalanceLifecycleEvent[] = [];
  // 1. Base path (legacy flat layout)
  results.push(...await queryLifecycleEvents(basePath, tokenId, rebalanceId, startTime, endTime));
  // 2. Per-chain subdirectories
  if (existsSync(basePath)) {
    const entries = await readdir(basePath);
    for (const entry of entries) {
      if (entry.startsWith('chain-')) {
        results.push(...await queryLifecycleEvents(join(basePath, entry), tokenId, rebalanceId, startTime, endTime));
      }
    }
  }
  const seen = new Set<string>();
  return results
    .filter(e => {
      const key = `${e.rebalanceId}-${e.eventType}-${e.timestamp}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => a.timestamp - b.timestamp);
}

/**
 * List analytics JSONL files, optionally limited to the most recent N days.
 * Files are named analytics-YYYY-MM-DD.jsonl and sorted chronologically.
 */
export async function listAnalyticsFiles(storagePath: string, maxDays?: number): Promise<string[]> {
  try {
    if (!existsSync(storagePath)) return [];
    const entries = await readdir(storagePath);
    let files = entries
      .filter((f) => f.startsWith('analytics-') && f.endsWith('.jsonl'))
      .sort();

    // Limit to most recent N days of files to cap memory usage
    if (maxDays !== undefined && maxDays > 0 && files.length > maxDays) {
      files = files.slice(-maxDays);
    }

    return files;
  } catch {
    return [];
  }
}

// ============================================================
// TRIGGER EVENTS
// ============================================================

export async function queryTriggerEvents(
  storagePath: string,
  tokenId?: number,
  startTime?: number,
  endTime?: number,
): Promise<TriggerEvent[]> {
  const files = await listAnalyticsFiles(storagePath);
  const results: TriggerEvent[] = [];

  for (const file of files) {
    const records = await readAnalyticsFile(join(storagePath, file));
    for (const record of records) {
      if (record.type !== 'trigger_event') continue;
      if (startTime && record.timestamp < startTime) continue;
      if (endTime && record.timestamp > endTime) continue;
      const event = record.data as TriggerEvent;
      if (tokenId !== undefined && event.tokenId !== tokenId) continue;
      results.push(event);
    }
  }

  return results.sort((a, b) => a.timestamp - b.timestamp);
}

export async function queryAllChainTriggerEvents(
  basePath: string,
  tokenId?: number,
  startTime?: number,
  endTime?: number,
): Promise<TriggerEvent[]> {
  const results: TriggerEvent[] = [];
  results.push(...await queryTriggerEvents(basePath, tokenId, startTime, endTime));
  if (existsSync(basePath)) {
    const entries = await readdir(basePath);
    for (const entry of entries) {
      if (entry.startsWith('chain-')) {
        results.push(...await queryTriggerEvents(join(basePath, entry), tokenId, startTime, endTime));
      }
    }
  }
  const seen = new Set<string>();
  return results
    .filter((e) => {
      if (seen.has(e.triggerEventId)) return false;
      seen.add(e.triggerEventId);
      return true;
    })
    .sort((a, b) => a.timestamp - b.timestamp);
}

// ============================================================
// STRATEGY RULE SET SNAPSHOTS
// ============================================================

export async function queryStrategyRuleSets(
  storagePath: string,
  tokenId?: number,
): Promise<StrategyRuleSetSnapshot[]> {
  const files = await listAnalyticsFiles(storagePath);
  const results: StrategyRuleSetSnapshot[] = [];

  for (const file of files) {
    const records = await readAnalyticsFile(join(storagePath, file));
    for (const record of records) {
      if (record.type !== 'strategy_rule_set') continue;
      const snap = record.data as StrategyRuleSetSnapshot;
      if (tokenId !== undefined && snap.tokenId !== tokenId) continue;
      results.push(snap);
    }
  }

  return results.sort((a, b) => a.createdAt - b.createdAt);
}

/**
 * Get the most recent strategy rule set snapshot for a position.
 */
export async function getLatestRuleSet(
  storagePath: string,
  tokenId: number,
): Promise<StrategyRuleSetSnapshot | undefined> {
  const all = await queryStrategyRuleSets(storagePath, tokenId);
  return all.length > 0 ? all[all.length - 1] : undefined;
}

export async function queryAllChainStrategyRuleSets(
  basePath: string,
  tokenId?: number,
): Promise<StrategyRuleSetSnapshot[]> {
  const results: StrategyRuleSetSnapshot[] = [];
  results.push(...await queryStrategyRuleSets(basePath, tokenId));
  if (existsSync(basePath)) {
    const entries = await readdir(basePath);
    for (const entry of entries) {
      if (entry.startsWith('chain-')) {
        results.push(...await queryStrategyRuleSets(join(basePath, entry), tokenId));
      }
    }
  }
  const seen = new Set<string>();
  return results
    .filter((s) => {
      if (seen.has(s.ruleSetId)) return false;
      seen.add(s.ruleSetId);
      return true;
    })
    .sort((a, b) => a.createdAt - b.createdAt);
}

// ============================================================
// MANUAL CHAIN LINKS — user-created position linkages
// ============================================================

const MANUAL_LINKS_FILE = 'manual-links.json';
const REBALANCES_FILE = 'rebalances.jsonl';

// ============================================================
// DEDICATED REBALANCE STORAGE (Lightweight Chain History)
// ============================================================

/**
 * Write a rebalance record to the dedicated lightweight file.
 * This ensures chain history is preserved even when daily snapshot logs are pruned.
 */
export async function writeRebalanceRecord(
  storagePath: string,
  record: RebalanceAnalytics,
): Promise<void> {
  await ensureStorageDir(storagePath);
  const filePath = join(storagePath, REBALANCES_FILE);
  // Wrap in the standard AnalyticsRecord envelope for consistency
  const wrapper: AnalyticsRecord = {
    type: 'rebalance',
    timestamp: record.timestamp,
    data: record,
  };
  const line = JSON.stringify(wrapper, bigintReplacer) + '\n';
  await appendFile(filePath, line);
  logger.info(`Rebalance record preserved in permanent history: ${record.rebalanceId}`);
}

/**
 * Prune daily snapshot files older than maxDays.
 * SAFEGUARD: Will NOT delete files if 'rebalances.jsonl' does not exist in the directory,
 * to preventing accidental data loss of chain history.
 */
export async function pruneOldSnapshots(storagePath: string, maxDays: number = 30): Promise<void> {
  try {
    if (!existsSync(storagePath)) return;

    // 1. Safety Check: Ensure the permanent rebalance history exists
    const permanentHistoryPath = join(storagePath, REBALANCES_FILE);
    if (!existsSync(permanentHistoryPath)) {
      logger.warn(`Skipping pruning for ${storagePath}: Permanent rebalance history (${REBALANCES_FILE}) not found.`);
      return;
    }

    // 2. Identify old files
    const cutoffTime = Date.now() - (maxDays * 24 * 60 * 60 * 1000);
    const files = await listAnalyticsFiles(storagePath);
     
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
        // Use fs.stat and fs.unlink from promise API (via import or require)
        // Since we are inside an async function in a module, dynamic import works
        const fs = await import('node:fs/promises');
        const stats = await fs.stat(fullPath);
        await fs.unlink(fullPath);
        deletedCount++;
        freedSpace += stats.size;
      }
    }

    if (deletedCount > 0) {
      const mb = (freedSpace / 1024 / 1024).toFixed(2);
      logger.info(`Pruned ${deletedCount} old analytics files from ${storagePath}, freed ${mb} MB`);
    } else {
      logger.debug(`No old analytics files found to prune in ${storagePath}`);
    }
  } catch (error) {
    logger.error(`Failed to prune old snapshots in ${storagePath}: ${error}`);
  }
}

export async function readManualLinks(storagePath: string): Promise<ManualLink[]> {
  try {
    const filePath = join(storagePath, MANUAL_LINKS_FILE);
    const content = await readFile(filePath, 'utf-8');
    const parsed = JSON.parse(content);
    if (!Array.isArray(parsed)) return [];
    return parsed as ManualLink[];
  } catch {
    return [];
  }
}

export async function writeManualLink(storagePath: string, link: ManualLink): Promise<void> {
  await ensureStorageDir(storagePath);
  const existing = await readManualLinks(storagePath);

  // Prevent duplicate within the same scoped old token identity
  if (existing.some((l) => l.oldTokenId === link.oldTokenId && (l.dex ?? '') === (link.dex ?? ''))) {
    throw new Error(`Manual link already exists from token #${link.oldTokenId}`);
  }

  existing.push(link);
  const filePath = join(storagePath, MANUAL_LINKS_FILE);
  const tmpPath = filePath + '.tmp';
  await writeFile(tmpPath, JSON.stringify(existing, null, 2));
  await rename(tmpPath, filePath);
  logger.info('Manual link created', { oldTokenId: link.oldTokenId, newTokenId: link.newTokenId });
}

export async function deleteManualLink(
  storagePath: string,
  oldTokenId: number,
  newTokenId: number,
  dex?: string,
): Promise<boolean> {
  const existing = await readManualLinks(storagePath);
  const idx = existing.findIndex(
    (l) => l.oldTokenId === oldTokenId && l.newTokenId === newTokenId && (dex === undefined || (l.dex ?? '') === dex),
  );
  if (idx === -1) return false;

  existing.splice(idx, 1);
  const filePath = join(storagePath, MANUAL_LINKS_FILE);
  const tmpPath = filePath + '.tmp';
  await writeFile(tmpPath, JSON.stringify(existing, null, 2));
  await rename(tmpPath, filePath);
  logger.info('Manual link deleted', { oldTokenId, newTokenId });
  return true;
}

/**
 * Retrospective outcome backfill for rebalance events.
 *
 * After sufficient time has passed (1d, 3d, 7d), this module computes:
 *   - feesEarned1dUsd / feesEarned3dUsd / feesEarned7dUsd
 *   - actualDaysToRecovery (days until cumulative post-rebalance fees >= totalLossUsd)
 *   - recoveredBeforeNextRebalance
 *   - nextRebalanceId
 *
 * Runs as a background job on bot startup and every 6 hours.
 * Modifies rebalances.jsonl in-place by rewriting records that have been updated.
 */

import { readFile, writeFile, rename } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { readdir } from 'node:fs/promises';
import type { RebalanceAnalytics, FeeCollectionRecord, AnalyticsRecord } from './types.js';
import logger from '../logger.js';

const REBALANCES_FILE = 'rebalances.jsonl';
const BACKFILL_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 hours
const WINDOWS_MS = {
  '1d': 24 * 60 * 60 * 1000,
  '3d': 3 * 24 * 60 * 60 * 1000,
  '7d': 7 * 24 * 60 * 60 * 1000,
};

let backfillTimer: ReturnType<typeof setInterval> | null = null;

// ============================================================
// STORAGE HELPERS
// ============================================================

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
    'dust0', 'dust1',
  ]);
  if (bigintFields.has(key) && typeof value === 'string' && /^\d+$/.test(value)) {
    return BigInt(value);
  }
  return value;
};

async function readRebalancesFile(path: string): Promise<Array<{ record: AnalyticsRecord; raw: string }>> {
  try {
    if (!existsSync(path)) return [];
    const content = await readFile(path, 'utf-8');
    const lines = content.trim().split('\n').filter(Boolean);
    return lines.map((raw) => ({ record: JSON.parse(raw, bigintReviver) as AnalyticsRecord, raw }));
  } catch {
    return [];
  }
}

async function writeRebalancesFile(path: string, rows: Array<{ record: AnalyticsRecord; raw: string }>): Promise<void> {
  const tmpPath = path + '.tmp';
  const content = rows.map((r) => JSON.stringify(r.record, bigintReplacer)).join('\n') + '\n';
  await writeFile(tmpPath, content, 'utf-8');
  await rename(tmpPath, path);
}

export function matchesRetrospectiveScope(
  candidate: { chainId?: number; dex?: string },
  scope: { chainId?: number; dex?: string },
): boolean {
  if (scope.chainId !== undefined && candidate.chainId !== undefined && candidate.chainId !== scope.chainId) {
    return false;
  }
  if (scope.dex !== undefined && candidate.dex !== undefined && candidate.dex !== scope.dex) {
    return false;
  }
  return true;
}

export function feeContributionForRecovery(
  record: AnalyticsRecord,
  tokenId: number,
  scope: { chainId?: number; dex?: string } = {},
): number {
  if (record.type === 'fee_collection') {
    const fc = record.data as FeeCollectionRecord;
    if (fc.tokenId === tokenId && matchesRetrospectiveScope(fc, scope)) {
      return fc.totalValueUsd ?? 0;
    }
    return 0;
  }

  if (record.type === 'rebalance') {
    const rb = record.data as RebalanceAnalytics;
    if (rb.oldTokenId === tokenId && matchesRetrospectiveScope(rb, scope)) {
      return rb.feesCollectedUsd ?? 0;
    }
  }

  return 0;
}

export function findNextRebalanceForChild(
  current: RebalanceAnalytics,
  candidates: RebalanceAnalytics[],
): RebalanceAnalytics | undefined {
  return candidates.find(
    (candidate) =>
      candidate.timestamp > current.timestamp &&
      candidate.oldTokenId === current.newTokenId &&
      matchesRetrospectiveScope(candidate, { chainId: current.chainId, dex: current.dex }),
  );
}

// ============================================================
// FEE EARNINGS LOOKUP FROM DAILY ANALYTICS FILES
// ============================================================

/**
 * Sum fees earned by a position during a time window from daily analytics files.
 * Looks at fee_collection records + snapshot unclaimed fee growth.
 */
async function sumFeesEarned(
  storagePath: string,
  tokenId: number,
  startMs: number,
  endMs: number,
  scope: { chainId?: number; dex?: string } = {},
): Promise<number> {
  let totalFees = 0;

  try {
    if (!existsSync(storagePath)) return 0;
    const entries = await readdir(storagePath);
    const dailyFiles = entries
      .filter((f) => f.startsWith('analytics-') && f.endsWith('.jsonl'))
      .sort();

    // Determine date range to scan
    const startDate = new Date(startMs).toISOString().split('T')[0];
    const endDate = new Date(endMs).toISOString().split('T')[0];

    for (const file of dailyFiles) {
      const fileDate = file.replace('analytics-', '').replace('.jsonl', '');
      if (fileDate < startDate || fileDate > endDate) continue;

      try {
        const content = await readFile(join(storagePath, file), 'utf-8');
        const lines = content.trim().split('\n').filter(Boolean);
        for (const line of lines) {
          try {
            const record = JSON.parse(line, bigintReviver) as AnalyticsRecord;
            if (record.timestamp < startMs || record.timestamp > endMs) continue;
            totalFees += feeContributionForRecovery(record, tokenId, scope);
          } catch {
            // Skip malformed lines
          }
        }
      } catch {
        // Skip unreadable files
      }
    }
  } catch {
    // Non-fatal
  }

  return totalFees;
}

// ============================================================
// CORE BACKFILL LOGIC
// ============================================================

/**
 * Process a single storage path's rebalances.jsonl.
 * Returns the number of records updated.
 */
async function backfillPath(storagePath: string): Promise<number> {
  const rebalancesPath = join(storagePath, REBALANCES_FILE);
  if (!existsSync(rebalancesPath)) return 0;

  const rows = await readRebalancesFile(rebalancesPath);
  if (rows.length === 0) return 0;

  const rebalances = rows
    .filter((r) => r.record.type === 'rebalance')
    .map((r) => r.record.data as RebalanceAnalytics);

  const now = Date.now();
  let updatedCount = 0;

  // Build an ordered list (sorted by timestamp) to find next rebalance linkage
  const sortedRebalances = [...rebalances].sort((a, b) => a.timestamp - b.timestamp);

  for (const row of rows) {
    if (row.record.type !== 'rebalance') continue;
    const rb = row.record.data as RebalanceAnalytics;
    const ageMs = now - rb.timestamp;

    let changed = false;

    // Link next rebalance ID
    if (rb.nextRebalanceId === undefined) {
      const nextRb = findNextRebalanceForChild(rb, sortedRebalances);
      if (nextRb) {
        rb.nextRebalanceId = nextRb.rebalanceId;
        rb.recoveredBeforeNextRebalance = undefined; // will be computed below
        changed = true;
      }
    }

    // 1-day fees (available after 24h)
    if (ageMs >= WINDOWS_MS['1d'] && rb.feesEarned1dUsd === undefined) {
      const fees = await sumFeesEarned(storagePath, rb.newTokenId, rb.timestamp, rb.timestamp + WINDOWS_MS['1d'], {
        chainId: rb.chainId,
        dex: rb.dex,
      });
      rb.feesEarned1dUsd = fees;
      changed = true;
    }

    // 3-day fees (available after 3 days)
    if (ageMs >= WINDOWS_MS['3d'] && rb.feesEarned3dUsd === undefined) {
      const fees = await sumFeesEarned(storagePath, rb.newTokenId, rb.timestamp, rb.timestamp + WINDOWS_MS['3d'], {
        chainId: rb.chainId,
        dex: rb.dex,
      });
      rb.feesEarned3dUsd = fees;
      changed = true;
    }

    // 7-day fees (available after 7 days)
    if (ageMs >= WINDOWS_MS['7d'] && rb.feesEarned7dUsd === undefined) {
      const fees = await sumFeesEarned(storagePath, rb.newTokenId, rb.timestamp, rb.timestamp + WINDOWS_MS['7d'], {
        chainId: rb.chainId,
        dex: rb.dex,
      });
      rb.feesEarned7dUsd = fees;
      changed = true;
    }

    // Actual days to recovery (scan fees day by day until totalLossUsd is covered)
    if (ageMs >= WINDOWS_MS['1d'] && rb.actualDaysToRecovery === undefined && rb.totalLossUsd !== undefined && rb.totalLossUsd > 0) {
      // Check daily intervals up to 30 days
      const maxDays = 30;
      let recovered = false;
      for (let d = 1; d <= Math.min(maxDays, Math.ceil(ageMs / WINDOWS_MS['1d'])); d++) {
        const windowEnd = rb.timestamp + d * WINDOWS_MS['1d'];
        if (windowEnd > now) break;
        const cumFees = await sumFeesEarned(storagePath, rb.newTokenId, rb.timestamp, windowEnd, {
          chainId: rb.chainId,
          dex: rb.dex,
        });
        if (cumFees >= rb.totalLossUsd) {
          rb.actualDaysToRecovery = d;
          recovered = true;
          changed = true;
          break;
        }
      }
      // If 7d window has passed and still not recovered, mark as not recovered within 7d
      if (!recovered && ageMs >= WINDOWS_MS['7d'] && rb.actualDaysToRecovery === undefined) {
        rb.actualDaysToRecovery = -1; // sentinel: not recovered within observed window
        changed = true;
      }
    }

    // recoveredBeforeNextRebalance
    if (rb.nextRebalanceId !== undefined && rb.recoveredBeforeNextRebalance === undefined && rb.totalLossUsd !== undefined) {
      const nextRb = sortedRebalances.find((r) => r.rebalanceId === rb.nextRebalanceId);
      if (nextRb) {
        const feesBeforeNext = await sumFeesEarned(storagePath, rb.newTokenId, rb.timestamp, nextRb.timestamp, {
          chainId: rb.chainId,
          dex: rb.dex,
        });
        rb.recoveredBeforeNextRebalance = feesBeforeNext >= (rb.totalLossUsd ?? 0);
        changed = true;
      }
    }

    if (changed) {
      rb.retrospectiveUpdatedAt = now;
      row.record.data = rb;
      updatedCount++;
    }
  }

  if (updatedCount > 0) {
    await writeRebalancesFile(rebalancesPath, rows);
    logger.info(`Retrospective backfill: updated ${updatedCount} records in ${storagePath}`);
  }

  return updatedCount;
}

// ============================================================
// BACKGROUND JOB
// ============================================================

/**
 * Run one backfill cycle across all chain storage paths.
 */
export async function runRetrospectiveBackfill(basePath: string): Promise<void> {
  try {
    let total = 0;

    // Base path
    total += await backfillPath(basePath);

    // Per-chain subdirectories
    if (existsSync(basePath)) {
      const entries = await readdir(basePath);
      for (const entry of entries) {
        if (entry.startsWith('chain-')) {
          total += await backfillPath(join(basePath, entry));
        }
      }
    }

    if (total > 0) {
      logger.info(`Retrospective backfill complete: ${total} rebalance records updated`);
    } else {
      logger.debug('Retrospective backfill: no new records to update');
    }
  } catch (err) {
    logger.warn(`Retrospective backfill failed (non-fatal): ${err}`);
  }
}

/**
 * Start the periodic retrospective backfill job.
 * Runs immediately then every 6 hours.
 */
export function startRetrospectiveBackfill(basePath: string): void {
  // Run immediately (non-blocking)
  runRetrospectiveBackfill(basePath).catch(() => {});

  // Then every 6 hours
  backfillTimer = setInterval(() => {
    runRetrospectiveBackfill(basePath).catch(() => {});
  }, BACKFILL_INTERVAL_MS);

  logger.info('Retrospective outcome backfill job started (interval: 6h)');
}

export function stopRetrospectiveBackfill(): void {
  if (backfillTimer) {
    clearInterval(backfillTimer);
    backfillTimer = null;
  }
}

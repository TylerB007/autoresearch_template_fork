/**
 * In-memory price backfill queue for analytics records with priceStatus='pending'.
 *
 * When the resolver fails to get prices during a position lifecycle event,
 * the caller pushes the record metadata onto a lightweight in-memory queue.
 * A background timer retries those specific entries — no file scanning needed.
 *
 * Design:
 *   - Queue is populated by the rebalancer/collector when resolveEventPrices returns 'pending'
 *   - Timer retries queued entries every 5 minutes using resolveEventPrices (2 retries per source)
 *   - On success: updates the JSONL record in-place, removes from queue
 *   - On expiry (>48h): marks as 'permanently_missing', removes from queue
 *   - Queue is naturally empty 99% of the time (both APIs rarely down simultaneously)
 *   - If process restarts while something is pending, priceStatus='pending' is
 *     already persisted in the JSONL for manual audit
 *   - Never synthesizes or derives prices — only real market data
 */

import { readFile, writeFile, rename } from 'node:fs/promises';
import { ethers } from 'ethers';
import { resolveEventPrices } from './resolver.js';
import { resolveHistoricalUsdPrices } from './historicalUsd.js';
import { getChainConfig } from '../config/chains.js';
import logger from '../logger.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PendingPriceEntry {
  /** JSONL file path where the record was written */
  filePath: string;
  /** Line index (0-based) in the JSONL file */
  lineIndex: number;
  /** Record type for logging context */
  recordType: string;
  /** Token ID for logging context */
  tokenId: number;
  /** Timestamp of the original event */
  eventTimestamp: number;
  /** Token addresses needed for price fetch */
  token0Address: string;
  token1Address: string;
  nativeWrappedAddress: string;
  /** DexScreener chain slug */
  chainSlug: string;
  /** EVM chain ID for historical indexed pricing and receipt lookup */
  chainId?: number;
  /** DEX identifier for the pending record */
  dex?: string;
  /** Number of backfill attempts so far */
  attempts: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const BACKFILL_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
const MAX_PENDING_AGE_MS = 48 * 60 * 60 * 1000; // 48 hours

// ---------------------------------------------------------------------------
// In-memory queue
// ---------------------------------------------------------------------------

const pendingQueue: PendingPriceEntry[] = [];
const providerCache = new Map<number, ethers.JsonRpcProvider>();

/**
 * Add a failed price fetch to the backfill queue.
 * Called by the rebalancer/collector when resolveEventPrices returns priceStatus='pending'.
 */
export function enqueuePendingPrice(entry: Omit<PendingPriceEntry, 'attempts'>): void {
  pendingQueue.push({ ...entry, attempts: 0 });
  logger.info(
    `[PriceBackfill] Queued pending price for token #${entry.tokenId} (${entry.recordType}) — ` +
    `queue size: ${pendingQueue.length}`,
  );
}

/**
 * Get current queue size (for monitoring/status).
 */
export function getPendingQueueSize(): number {
  return pendingQueue.length;
}

async function readJsonlLineData(
  filePath: string,
  lineIndex: number,
): Promise<Record<string, unknown> | null> {
  try {
    const content = await readFile(filePath, 'utf-8');
    const lines = content.trim().split('\n');
    if (lineIndex >= lines.length) return null;
    const record = JSON.parse(lines[lineIndex]) as Record<string, unknown>;
    return (record.data as Record<string, unknown> | undefined) ?? null;
  } catch (err) {
    logger.warn(`[PriceBackfill] Failed to read ${filePath}:${lineIndex} for context lookup: ${err}`);
    return null;
  }
}

function extractBlockNumber(data: Record<string, unknown> | null): number | null {
  if (!data) return null;
  const value = data.blockNumber;
  if (typeof value === 'number' && Number.isInteger(value) && value > 0) {
    return value;
  }
  return null;
}

function extractTxHash(data: Record<string, unknown> | null): string | null {
  if (!data) return null;
  if (typeof data.txHash === 'string' && data.txHash.length > 0) {
    return data.txHash;
  }

  const txHashes = data.txHashes;
  if (!txHashes || typeof txHashes !== 'object') {
    return null;
  }

  const txHashRecord = txHashes as Record<string, unknown>;
  const candidates = [
    txHashRecord.mint,
    txHashRecord.collectFees,
    txHashRecord.collectTokens,
    txHashRecord.burn,
    txHashRecord.swap,
    txHashRecord.decreaseLiquidity,
  ];

  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.length > 0) {
      return candidate;
    }
  }

  return null;
}

async function getProviderForChain(chainId: number): Promise<ethers.JsonRpcProvider | null> {
  const cached = providerCache.get(chainId);
  if (cached) {
    return cached;
  }

  const chain = getChainConfig(chainId);
  const network = new ethers.Network(chain.chainName.toLowerCase().replace(/\s+/g, '-'), chainId);
  for (const rpcUrl of chain.rpcUrls) {
    try {
      const provider = new ethers.JsonRpcProvider(rpcUrl, network, { staticNetwork: network });
      await provider.getBlockNumber();
      providerCache.set(chainId, provider);
      return provider;
    } catch {
      // Try next RPC.
    }
  }

  logger.warn(`[PriceBackfill] No reachable RPC found for chain ${chainId} during historical backfill`);
  return null;
}

async function resolveHistoricalBlockNumber(entry: PendingPriceEntry): Promise<number | null> {
  const data = await readJsonlLineData(entry.filePath, entry.lineIndex);
  const storedBlockNumber = extractBlockNumber(data);
  if (storedBlockNumber !== null) {
    return storedBlockNumber;
  }

  if (entry.chainId === undefined) return null;

  const txHash = extractTxHash(data);
  if (!txHash) return null;

  const provider = await getProviderForChain(entry.chainId);
  if (!provider) return null;

  try {
    const receipt = await provider.getTransactionReceipt(txHash);
    return receipt?.blockNumber ?? null;
  } catch (err) {
    logger.warn(`[PriceBackfill] Failed to resolve receipt for ${txHash}: ${err}`);
    return null;
  }
}

async function resolveBackfillPrices(entry: PendingPriceEntry): Promise<{
  priceUsd0: number;
  priceUsd1: number;
  nativePriceUsd: number;
  priceSource: string;
  priceStatus: 'backfilled' | 'pending';
}> {
  const blockNumber = await resolveHistoricalBlockNumber(entry);
  if (entry.chainId !== undefined && blockNumber !== null) {
    const historical = await resolveHistoricalUsdPrices({
      chainId: entry.chainId,
      dex: entry.dex,
      blockNumber,
      token0Address: entry.token0Address,
      token1Address: entry.token1Address,
      nativeWrappedAddress: entry.nativeWrappedAddress,
      context: `backfill:${entry.tokenId}:${entry.recordType}`,
    });

    if (historical) {
      return {
        priceUsd0: historical.priceUsd0,
        priceUsd1: historical.priceUsd1,
        nativePriceUsd: historical.nativePriceUsd,
        priceSource: historical.priceSource,
        priceStatus: 'backfilled',
      };
    }
  }

  const liveResolved = await resolveEventPrices({
    addresses: [entry.token0Address, entry.token1Address, entry.nativeWrappedAddress],
    chainSlug: entry.chainSlug,
    context: `backfill:${entry.tokenId}:${entry.recordType}`,
    maxRetries: 2,
    baseDelayMs: 1500,
  });

  return {
    priceUsd0: liveResolved.priceUsd0,
    priceUsd1: liveResolved.priceUsd1,
    nativePriceUsd: liveResolved.nativePriceUsd,
    priceSource: liveResolved.priceSource,
    priceStatus: liveResolved.priceStatus === 'pending' ? 'pending' : 'backfilled',
  };
}

// ---------------------------------------------------------------------------
// JSONL line rewriter
// ---------------------------------------------------------------------------

/**
 * Rewrite a specific line in a JSONL file with updated data.
 * Reads the file, replaces the line, writes it back atomically.
 */
async function rewriteJsonlLine(
  filePath: string,
  lineIndex: number,
  updater: (data: Record<string, unknown>) => void,
): Promise<boolean> {
  try {
    const content = await readFile(filePath, 'utf-8');
    const lines = content.trim().split('\n');

    if (lineIndex >= lines.length) {
      logger.warn(`[PriceBackfill] Line ${lineIndex} out of range in ${filePath} (${lines.length} lines)`);
      return false;
    }

    const record = JSON.parse(lines[lineIndex]) as Record<string, unknown>;
    const data = record.data as Record<string, unknown> | undefined;
    if (!data) return false;

    updater(data);

    lines[lineIndex] = JSON.stringify(record, (_key, value) =>
      typeof value === 'bigint' ? value.toString() : value,
    );

    const tmpPath = filePath + '.backfill.tmp';
    await writeFile(tmpPath, lines.join('\n') + '\n');
    await rename(tmpPath, filePath);
    return true;
  } catch (err) {
    logger.error(`[PriceBackfill] Failed to rewrite ${filePath}:${lineIndex}: ${err}`);
    return false;
  }
}

// ---------------------------------------------------------------------------
// Backfill engine
// ---------------------------------------------------------------------------

/**
 * Process a single pending entry: retry price fetch, update JSONL if successful.
 * Returns true if resolved (success or expired), false if still pending.
 */
async function processEntry(entry: PendingPriceEntry): Promise<boolean> {
  const now = Date.now();
  const age = now - entry.eventTimestamp;
  const ageHours = (age / (60 * 60 * 1000)).toFixed(1);
  entry.attempts++;

  // Expired — mark as permanently_missing and remove from queue
  if (age > MAX_PENDING_AGE_MS) {
    logger.warn(
      `[PriceBackfill] Token #${entry.tokenId} (${entry.recordType}) expired after ${ageHours}h ` +
      `and ${entry.attempts} attempts. Marking as permanently_missing.`,
    );

    await rewriteJsonlLine(entry.filePath, entry.lineIndex, (data) => {
      data.priceStatus = 'permanently_missing';
      data.priceSource = 'permanently_missing';
      data.backfillAttemptedAt = now;
      data.backfillAttempts = entry.attempts;
      data.backfillResult = 'expired';
    });

    return true; // resolved (expired)
  }

  logger.info(
    `[PriceBackfill] Attempt ${entry.attempts} for token #${entry.tokenId} (${entry.recordType}, age: ${ageHours}h)`,
  );

  const resolved = await resolveBackfillPrices(entry);

  if (resolved.priceStatus === 'pending') {
    logger.warn(
      `[PriceBackfill] Still no prices for token #${entry.tokenId} after attempt ${entry.attempts} ` +
      `(age: ${ageHours}h). Will retry next cycle.`,
    );
    return false; // still pending
  }

  // Got prices — update the JSONL record
  const updated = await rewriteJsonlLine(entry.filePath, entry.lineIndex, (data) => {
    data.priceUsd0 = resolved.priceUsd0;
    data.priceUsd1 = resolved.priceUsd1;
    data.nativePriceUsd = resolved.nativePriceUsd;
    data.priceSource = resolved.priceSource;
    data.priceStatus = 'backfilled';
    data.backfilledAt = now;
    data.backfillSource = resolved.priceSource;
    data.backfillDelayMs = now - entry.eventTimestamp;
    data.backfillAttempts = entry.attempts;
  });

  if (updated) {
    logger.info(
      `[PriceBackfill] ✓ Backfilled token #${entry.tokenId} (${entry.recordType}) via ${resolved.priceSource}: ` +
      `token0=$${resolved.priceUsd0}, token1=$${resolved.priceUsd1}, native=$${resolved.nativePriceUsd} ` +
      `(delay: ${((now - entry.eventTimestamp) / 60000).toFixed(1)} min, attempts: ${entry.attempts})`,
    );
  }

  return true; // resolved (backfilled)
}

// ---------------------------------------------------------------------------
// Background task
// ---------------------------------------------------------------------------

let backfillTimer: ReturnType<typeof setInterval> | null = null;

/**
 * Run a single backfill cycle: process all entries in the in-memory queue.
 */
export async function runBackfillCycle(): Promise<{
  processed: number;
  backfilled: number;
  expired: number;
  stillPending: number;
}> {
  const stats = { processed: 0, backfilled: 0, expired: 0, stillPending: 0 };

  if (pendingQueue.length === 0) {
    return stats;
  }

  logger.info(`[PriceBackfill] Processing ${pendingQueue.length} pending price(s)`);

  // Process in reverse so we can splice resolved entries without index shifting
  for (let i = pendingQueue.length - 1; i >= 0; i--) {
    stats.processed++;
    try {
      const resolved = await processEntry(pendingQueue[i]);
      if (resolved) {
        const age = Date.now() - pendingQueue[i].eventTimestamp;
        if (age > MAX_PENDING_AGE_MS) {
          stats.expired++;
        } else {
          stats.backfilled++;
        }
        pendingQueue.splice(i, 1);
      } else {
        stats.stillPending++;
      }
    } catch (err) {
      stats.stillPending++;
      logger.error(`[PriceBackfill] Error processing entry: ${err}`);
    }
  }

  logger.info(
    `[PriceBackfill] Cycle complete: ${stats.processed} processed, ` +
    `${stats.backfilled} backfilled, ${stats.expired} expired, ` +
    `${stats.stillPending} still pending (queue size: ${pendingQueue.length})`,
  );

  return stats;
}

/**
 * Start the background backfill timer.
 * Only processes the in-memory queue — no file scanning.
 */
export function startPriceBackfill(): void {
  if (backfillTimer) {
    logger.warn('[PriceBackfill] Already running — skipping duplicate start');
    return;
  }

  logger.info(`[PriceBackfill] Started (interval: ${BACKFILL_INTERVAL_MS / 60000} min, in-memory queue)`);

  backfillTimer = setInterval(() => {
    runBackfillCycle().catch((err) => {
      logger.error(`[PriceBackfill] Cycle failed: ${err}`);
    });
  }, BACKFILL_INTERVAL_MS);
}

/**
 * Stop the background backfill timer (for graceful shutdown).
 */
export function stopPriceBackfill(): void {
  if (backfillTimer) {
    clearInterval(backfillTimer);
    backfillTimer = null;
    if (pendingQueue.length > 0) {
      logger.warn(
        `[PriceBackfill] Stopped with ${pendingQueue.length} pending entry/entries. ` +
        `These records have priceStatus='pending' in their JSONL files for manual review.`,
      );
    } else {
      logger.info('[PriceBackfill] Stopped (queue empty)');
    }
  }
}

/**
 * Mint date lookup and caching for NFT positions.
 * Queries the Transfer event from address(0) to find the mint block,
 * then fetches the block timestamp. Caches results in a JSON file
 * so each position is only looked up once.
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { ethers } from 'ethers';
import type { ContractInstances } from './contracts.js';
import type { ChainContext } from './chain.js';
import logger from './logger.js';

const CACHE_FILE = resolve(process.cwd(), '.mint-dates.json');
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

/** In-memory cache: tokenId -> Unix timestamp (ms) */
let cache: Record<string, number> = {};

/** Load cache from disk on first access */
function loadCache(): void {
  if (Object.keys(cache).length > 0) return; // Already loaded
  try {
    if (existsSync(CACHE_FILE)) {
      cache = JSON.parse(readFileSync(CACHE_FILE, 'utf-8'));
    }
  } catch {
    cache = {};
  }
}

/** Persist cache to disk */
function saveCache(): void {
  try {
    writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2), 'utf-8');
  } catch (err) {
    logger.warn('Failed to save mint date cache', { error: err instanceof Error ? err.message : String(err) });
  }
}

/**
 * Get the mint timestamp for a position NFT.
 * Uses cached value if available, otherwise queries the chain.
 * Returns Unix timestamp in milliseconds, or null if unable to determine.
 */
export async function getMintTimestamp(
  tokenId: number,
  contracts: ContractInstances,
  chain: ChainContext,
): Promise<number | null> {
  loadCache();

  const key = String(tokenId);
  if (cache[key]) return cache[key];

  try {
    const mintTs = await chain.withRetry(async () => {
      // Query Transfer events from address(0) for this tokenId
      // This is the ERC-721 mint event
      const filter = contracts.positionManager.filters.Transfer(ZERO_ADDRESS, null, tokenId);

      // Some RPCs (Base, Arbitrum) limit eth_getLogs to 10k-50k blocks.
      // Try full range first; on failure, chunk backwards in 10k-block windows.
      let events: ethers.EventLog[] | ethers.Log[] = [];
      try {
        events = await contracts.positionManager.queryFilter(filter, 0, 'latest');
      } catch {
        // Full-range failed — use chunked scan from recent blocks backward
        const latestBlock = await chain.provider.getBlockNumber();
        const CHUNK_SIZE = 9_999;
        // Scan up to ~6 months of blocks (~2s/block on Base ≈ 7.9M blocks, ~13s/block on ETH ≈ 1.2M)
        const MAX_CHUNKS = 800; // 800 * 10k = 8M blocks
        for (let i = 0; i < MAX_CHUNKS; i++) {
          const toBlock = latestBlock - i * CHUNK_SIZE;
          const fromBlock = Math.max(0, toBlock - CHUNK_SIZE);
          if (toBlock < 0) break;
          try {
            events = await contracts.positionManager.queryFilter(filter, fromBlock, toBlock);
            if (events.length > 0) break;
          } catch {
            // Chunk also failed — skip and try next
          }
          if (fromBlock === 0) break;
        }
      }

      if (events.length === 0) {
        logger.warn('No mint event found for position', { tokenId });
        return null;
      }

      // Get the block timestamp from the mint transaction
      const mintEvent = events[0];
      const block = await mintEvent.getBlock();
      return block.timestamp * 1000; // Convert seconds to milliseconds
    });

    if (mintTs !== null) {
      cache[key] = mintTs;
      saveCache();
      logger.info('Cached mint date for position', {
        tokenId,
        mintDate: new Date(mintTs).toISOString(),
      });
    }

    return mintTs;
  } catch (err) {
    logger.warn('Failed to fetch mint date', {
      tokenId,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/**
 * Format a duration in milliseconds as human-readable age.
 * Examples: "2d 5hr", "13hr 42min", "45min"
 */
export function formatAge(durationMs: number): string {
  const totalMinutes = Math.floor(durationMs / 60_000);
  const totalHours = Math.floor(totalMinutes / 60);
  const days = Math.floor(totalHours / 24);
  const hours = totalHours % 24;
  const minutes = totalMinutes % 60;

  if (days > 0) {
    return `${days}d ${hours}hr`;
  }
  if (hours > 0) {
    return `${hours}hr ${minutes}min`;
  }
  return `${minutes}min`;
}

/**
 * Calculate lifetime APR based on total fees earned (claimed + unclaimed)
 * over the position's age and current position value.
 *
 * APR = (totalFeesUsd / positionValueUsd) * (365 * 24 / ageHours) * 100
 */
export function calculateLifetimeAPR(
  totalFeesUsd: number,
  positionValueUsd: number,
  ageMs: number,
): number {
  if (positionValueUsd <= 0 || ageMs <= 0) return 0;

  const ageHours = ageMs / (1000 * 3600);
  if (ageHours < 1) return 0; // Too early for meaningful APR

  const hoursPerYear = 365 * 24;
  return (totalFeesUsd / positionValueUsd) * (hoursPerYear / ageHours) * 100;
}

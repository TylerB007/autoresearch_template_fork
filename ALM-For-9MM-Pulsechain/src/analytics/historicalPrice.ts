/**
 * Historical price reconstruction from on-chain data.
 *
 * Queries a V3 pool's slot0 at a specific block number to recover the exact
 * sqrtPriceX96 and tick at the time of any historical event (Mint, Burn, Collect, Swap).
 *
 * This is the most accurate price source for analytics — it's the actual pool state
 * at the block where the event occurred, not a retroactive estimate from DexScreener.
 *
 * Price hierarchy:
 *   1. On-chain sqrtPriceX96 at event block (most accurate — direct pool oracle)
 *   2. DexScreener USD price at fetch time (good for recent events, degrades with time)
 *   3. 'unavailable' (no price data at all)
 */

import { ethers } from 'ethers';
import { sqrtPriceX96ToPrice } from '../bigintFloat.js';

const V3_POOL_SLOT0_ABI = [
  'function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)',
];

export interface HistoricalPoolPrice {
  /** Pool sqrtPriceX96 at the queried block */
  sqrtPriceX96: bigint;
  /** Pool tick at the queried block */
  tick: number;
  /** Derived price ratio: token1/token0 in raw units (before decimal adjustment) */
  rawPrice: number;
  /** Block number queried */
  blockNumber: number;
  /** Source identifier */
  source: 'on-chain';
}

/**
 * Query a V3 pool's slot0 at a specific block number.
 *
 * @param poolAddress  The V3 pool contract address
 * @param blockNumber  The block at which to read slot0
 * @param provider     An ethers JsonRpcProvider (must support eth_call with block override)
 * @returns Historical price data, or null if the query fails (RPC doesn't support archive calls, etc.)
 */
export async function getPoolPriceAtBlock(
  poolAddress: string,
  blockNumber: number,
  provider: ethers.JsonRpcProvider,
): Promise<HistoricalPoolPrice | null> {
  try {
    const pool = new ethers.Contract(poolAddress, V3_POOL_SLOT0_ABI, provider);
    const slot0 = await pool.slot0({ blockTag: blockNumber });

    const sqrtPriceX96 = BigInt(slot0.sqrtPriceX96);
    const tick = Number(slot0.tick);

    if (sqrtPriceX96 === 0n) return null;

    return {
      sqrtPriceX96,
      tick,
      rawPrice: sqrtPriceX96ToPrice(sqrtPriceX96),
      blockNumber,
      source: 'on-chain',
    };
  } catch {
    // RPC may not support archive/historical state queries —
    // PulseChain public RPCs typically do, but some don't.
    return null;
  }
}

/**
 * Convert sqrtPriceX96 to a human-readable price with decimal adjustment.
 *
 * @param sqrtPriceX96  The pool's sqrtPriceX96 value
 * @param decimals0     Token0 decimals
 * @param decimals1     Token1 decimals
 * @returns Price of token0 denominated in token1 (e.g., "1 HEX = X WPLS")
 */
export function sqrtPriceToHumanPrice(
  sqrtPriceX96: bigint,
  decimals0: number,
  decimals1: number,
): number {
  const rawPrice = sqrtPriceX96ToPrice(sqrtPriceX96);
  // rawPrice is token1/token0 in raw units. Adjust for decimals:
  // humanPrice = rawPrice * (10^decimals0 / 10^decimals1)
  return rawPrice * (10 ** decimals0) / (10 ** decimals1);
}

/**
 * Determine the best available price source for an analytics record.
 *
 * Priority:
 *   1. sqrtPriceX96 (on-chain) — always trustworthy if present
 *   2. priceUsd0/priceUsd1 (DexScreener) — accurate if fetched near event time
 *   3. 'unavailable' — no price data
 */
export function classifyPriceSource(record: {
  sqrtPriceX96?: bigint;
  priceUsd0?: number;
  priceUsd1?: number;
  priceSource?: string;
}): 'on-chain' | 'dexscreener' | 'estimated' | 'unavailable' {
  if (record.sqrtPriceX96 && record.sqrtPriceX96 > 0n) {
    return 'on-chain';
  }
  if ((record.priceUsd0 && record.priceUsd0 > 0) || (record.priceUsd1 && record.priceUsd1 > 0)) {
    if (record.priceSource === 'estimated') return 'estimated';
    return 'dexscreener';
  }
  return 'unavailable';
}

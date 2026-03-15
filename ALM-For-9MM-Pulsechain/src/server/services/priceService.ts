/**
 * Token price service — fetches USD prices from DexScreener with caching
 * Rate limit: stay well under 60 req/min (5-minute TTL cache)
 *
 * Multi-chain: Uses dexScreenerSlug from chain config (e.g. "pulsechain", "ethereum")
 */

import logger from '../../logger.js';

interface TokenPrice {
  address: string;
  priceUsd: number;
  fetchedAt: number;
}

const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const priceCache = new Map<string, TokenPrice>();

/** Module-level DexScreener chain slug (set once at server startup) */
let dexScreenerChainSlug = 'pulsechain';

/** Initialize the price service with the chain's DexScreener slug */
export function initPriceService(chainSlug: string): void {
  dexScreenerChainSlug = chainSlug;
  logger.info(`Price service initialized for DexScreener chain: ${chainSlug}`);
}

/**
 * Fetch USD prices for one or more token addresses.
 * Returns a map of lowercase address → USD price.
 * Uses DexScreener tokens endpoint which accepts comma-separated addresses.
 */
export async function getTokenPrices(addresses: string[], chainSlug?: string): Promise<Map<string, number>> {
  const slug = chainSlug ?? dexScreenerChainSlug;
  const result = new Map<string, number>();
  const now = Date.now();

  // Separate cached vs. stale (cache key includes chain slug to avoid cross-chain collisions)
  const toFetch: string[] = [];
  for (const addr of addresses) {
    const key = `${slug}:${addr.toLowerCase()}`;
    const cached = priceCache.get(key);
    if (cached && now - cached.fetchedAt < CACHE_TTL_MS) {
      result.set(addr.toLowerCase(), cached.priceUsd);
    } else {
      toFetch.push(addr);
    }
  }

  if (toFetch.length === 0) return result;

  try {
    const addrList = toFetch.join(',');
    const url = `https://api.dexscreener.com/tokens/v1/${slug}/${addrList}`;
    const res = await fetch(url, {
      headers: { 'Accept': 'application/json' },
      signal: AbortSignal.timeout(10_000),
    });

    if (!res.ok) {
      logger.warn('DexScreener API error', { status: res.status, statusText: res.statusText });
      return result;
    }

    const data = await res.json() as Array<{
      baseToken?: { address?: string };
      priceUsd?: string;
    }>;

    if (!Array.isArray(data)) {
      logger.warn('DexScreener unexpected response format');
      return result;
    }

    // DexScreener returns an array of pairs — pick the best (highest liquidity) price per token
    const bestPrices = new Map<string, number>();
    for (const pair of data) {
      const addr = pair.baseToken?.address?.toLowerCase();
      const price = pair.priceUsd ? parseFloat(pair.priceUsd) : 0;
      if (addr && price > 0) {
        // Keep the first price found (DexScreener sorts by volume/liquidity)
        if (!bestPrices.has(addr)) {
          bestPrices.set(addr, price);
        }
      }
    }

    // Update cache and result
    for (const [addr, price] of bestPrices) {
      priceCache.set(`${slug}:${addr}`, { address: addr, priceUsd: price, fetchedAt: now });
      result.set(addr, price);
    }
  } catch (err) {
    logger.warn('DexScreener fetch failed', {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  return result;
}

/**
 * Get a single token's USD price. Returns 0 if unavailable.
 */
export async function getTokenPrice(address: string): Promise<number> {
  const prices = await getTokenPrices([address]);
  return prices.get(address.toLowerCase()) ?? 0;
}

// ============================================================
// POOL CONTEXT — TVL, volume, fee rate from DexScreener pairs API
// ============================================================

export interface PoolContext {
  /** Pool/pair address (lowercase) */
  pairAddress: string;
  /** Total value locked in USD */
  tvlUsd: number;
  /** 24h trading volume in USD */
  volume24hUsd: number;
  /** Annualized pool fee rate: volume_24h * fee_tier * 365 / tvl (0 if tvl = 0) */
  feeRate: number;
  /** volume24hUsd / tvlUsd */
  volumeToTvlRatio: number;
  /** When this was fetched */
  fetchedAt: number;
}

const POOL_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const poolContextCache = new Map<string, PoolContext>();

/**
 * Fetch pool TVL and volume from DexScreener pairs API.
 * Returns undefined if the pair is not found or the API fails.
 *
 * @param pairAddress  Pool/pair contract address
 * @param chainSlug    DexScreener chain slug (e.g., 'pulsechain', 'base')
 * @param feeTier      Pool fee tier as a decimal fraction (e.g., 0.0025 for 0.25%)
 */
export async function getPoolContext(
  pairAddress: string,
  chainSlug?: string,
  feeTier?: number,
): Promise<PoolContext | undefined> {
  const slug = chainSlug ?? dexScreenerChainSlug;
  const key = `${slug}:${pairAddress.toLowerCase()}`;
  const now = Date.now();

  const cached = poolContextCache.get(key);
  if (cached && now - cached.fetchedAt < POOL_CACHE_TTL_MS) {
    return cached;
  }

  try {
    const url = `https://api.dexscreener.com/latest/dex/pairs/${slug}/${pairAddress.toLowerCase()}`;
    const res = await fetch(url, {
      headers: { 'Accept': 'application/json' },
      signal: AbortSignal.timeout(10_000),
    });

    if (!res.ok) {
      logger.warn('DexScreener pairs API error', { status: res.status, pairAddress });
      return undefined;
    }

    const data = await res.json() as {
      pairs?: Array<{
        pairAddress?: string;
        liquidity?: { usd?: number };
        volume?: { h24?: number };
      }>;
    };

    if (!data.pairs || data.pairs.length === 0) return undefined;

    const pair = data.pairs[0];
    const tvlUsd = pair.liquidity?.usd ?? 0;
    const volume24hUsd = pair.volume?.h24 ?? 0;
    const fee = feeTier ?? 0;
    const feeRate = tvlUsd > 0 ? (volume24hUsd * fee * 365) / tvlUsd : 0;
    const volumeToTvlRatio = tvlUsd > 0 ? volume24hUsd / tvlUsd : 0;

    const ctx: PoolContext = {
      pairAddress: pairAddress.toLowerCase(),
      tvlUsd,
      volume24hUsd,
      feeRate,
      volumeToTvlRatio,
      fetchedAt: now,
    };
    poolContextCache.set(key, ctx);
    return ctx;
  } catch (err) {
    logger.warn('DexScreener pool context fetch failed', {
      pairAddress,
      error: err instanceof Error ? err.message : String(err),
    });
    return undefined;
  }
}

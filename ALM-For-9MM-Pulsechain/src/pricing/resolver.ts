/**
 * Resilient multi-source price resolver for position lifecycle events.
 *
 * During routine monitoring snapshots, a missing price is tolerable (priceUsd=0).
 * During position lifecycle events (mint, collect, exit, rebalance), a missing
 * price permanently corrupts analytics — cost basis, fee USD, gas cost USD, and
 * ROI are all derived from the price captured at event time.
 *
 * This resolver:
 *   1. Tries DexScreener (primary)
 *   2. Falls back to GeckoTerminal (independent CDN, same data fidelity)
 *   3. Retries with exponential backoff (event-grade: 3 attempts per source)
 *   4. Logs EVERY attempt and failure for debug traceability
 *   5. Returns priceStatus: 'live' | 'pending' — never synthesizes prices
 */

import logger from '../logger.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ResolvedPrices {
  priceUsd0: number;
  priceUsd1: number;
  nativePriceUsd: number;
  /** Which API provided the prices */
  priceSource: string;
  /** 'live' = real market data; 'pending' = all sources failed, needs backfill */
  priceStatus: 'live' | 'pending';
}

export interface PriceResolverOptions {
  /** Token addresses to price [token0, token1, nativeWrapped] */
  addresses: [string, string, string];
  /** DexScreener chain slug (e.g., 'pulsechain', 'ethereum', 'base') */
  chainSlug: string;
  /** Context label for log messages (e.g., 'rebalance_triggered:155977') */
  context: string;
  /** Max retries per source (default: 3) */
  maxRetries?: number;
  /** Base delay in ms for exponential backoff (default: 2000) */
  baseDelayMs?: number;
}

// ---------------------------------------------------------------------------
// Source implementations
// ---------------------------------------------------------------------------

interface PriceSourceResult {
  prices: Map<string, number>;
  source: string;
}

/**
 * Fetch prices from DexScreener tokens API.
 * Endpoint: https://api.dexscreener.com/tokens/v1/{chain}/{addresses}
 */
async function fetchDexScreener(
  addresses: string[],
  chainSlug: string,
  context: string,
): Promise<PriceSourceResult> {
  const addrList = addresses.join(',');
  const url = `https://api.dexscreener.com/tokens/v1/${chainSlug}/${addrList}`;

  logger.debug(`[PriceResolver] DexScreener attempt for ${context}`, { url });

  const res = await fetch(url, {
    headers: { 'Accept': 'application/json' },
    signal: AbortSignal.timeout(10_000),
  });

  if (!res.ok) {
    throw new Error(`DexScreener HTTP ${res.status} ${res.statusText}`);
  }

  const data = await res.json() as Array<{
    baseToken?: { address?: string };
    priceUsd?: string;
  }>;

  if (!Array.isArray(data)) {
    throw new Error('DexScreener returned non-array response');
  }

  const prices = new Map<string, number>();
  for (const pair of data) {
    const addr = pair.baseToken?.address?.toLowerCase();
    const price = pair.priceUsd ? parseFloat(pair.priceUsd) : 0;
    if (addr && price > 0 && !prices.has(addr)) {
      prices.set(addr, price);
    }
  }

  return { prices, source: 'dexscreener' };
}

/**
 * Fetch prices from GeckoTerminal API (independent from DexScreener).
 * Endpoint: https://api.geckoterminal.com/api/v2/simple/networks/{chain}/token_price/{addresses}
 *
 * GeckoTerminal uses different chain slugs:
 *   - PulseChain: 'pulsechain'
 *   - Ethereum: 'eth'
 *   - Base: 'base'
 *   - Arbitrum: 'arbitrum'
 *   - Sonic: 'sonic'
 */
async function fetchGeckoTerminal(
  addresses: string[],
  chainSlug: string,
  context: string,
): Promise<PriceSourceResult> {
  // Map DexScreener slugs to GeckoTerminal network IDs
  const geckoChainMap: Record<string, string> = {
    pulsechain: 'pulsechain',
    ethereum: 'eth',
    base: 'base',
    arbitrum: 'arbitrum',
    sonic: 'sonic',
  };
  const geckoChain = geckoChainMap[chainSlug] ?? chainSlug;
  const addrList = addresses.join(',');
  const url = `https://api.geckoterminal.com/api/v2/simple/networks/${geckoChain}/token_price/${addrList}`;

  logger.debug(`[PriceResolver] GeckoTerminal attempt for ${context}`, { url });

  const res = await fetch(url, {
    headers: { 'Accept': 'application/json' },
    signal: AbortSignal.timeout(10_000),
  });

  if (!res.ok) {
    throw new Error(`GeckoTerminal HTTP ${res.status} ${res.statusText}`);
  }

  const json = await res.json() as {
    data?: {
      attributes?: {
        token_prices?: Record<string, string | null>;
      };
    };
  };

  const tokenPrices = json.data?.attributes?.token_prices;
  if (!tokenPrices || typeof tokenPrices !== 'object') {
    throw new Error('GeckoTerminal returned unexpected response structure');
  }

  const prices = new Map<string, number>();
  for (const [addr, priceStr] of Object.entries(tokenPrices)) {
    const price = priceStr ? parseFloat(priceStr) : 0;
    if (price > 0) {
      prices.set(addr.toLowerCase(), price);
    }
  }

  return { prices, source: 'geckoterminal' };
}

// ---------------------------------------------------------------------------
// Retry logic
// ---------------------------------------------------------------------------

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Attempt a price source with retries and exponential backoff.
 * Logs every attempt and failure.
 */
async function fetchWithRetry(
  sourceName: string,
  fetchFn: () => Promise<PriceSourceResult>,
  maxRetries: number,
  baseDelayMs: number,
  context: string,
): Promise<PriceSourceResult | null> {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      logger.info(`[PriceResolver] ${sourceName} attempt ${attempt}/${maxRetries} for ${context}`);
      const result = await fetchFn();

      // Check if we actually got prices
      if (result.prices.size === 0) {
        logger.warn(
          `[PriceResolver] ${sourceName} attempt ${attempt}/${maxRetries} returned 0 prices for ${context}`,
        );
        if (attempt < maxRetries) {
          const delay = baseDelayMs * Math.pow(2, attempt - 1);
          logger.debug(`[PriceResolver] Retrying ${sourceName} in ${delay}ms`);
          await sleep(delay);
          continue;
        }
        return null;
      }

      logger.info(
        `[PriceResolver] ${sourceName} succeeded on attempt ${attempt} for ${context} — ` +
        `got ${result.prices.size} price(s)`,
      );
      return result;
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      logger.warn(
        `[PriceResolver] ${sourceName} attempt ${attempt}/${maxRetries} FAILED for ${context}: ${errMsg}`,
      );

      if (attempt < maxRetries) {
        const delay = baseDelayMs * Math.pow(2, attempt - 1);
        logger.debug(`[PriceResolver] Retrying ${sourceName} in ${delay}ms`);
        await sleep(delay);
      }
    }
  }

  logger.error(`[PriceResolver] ${sourceName} exhausted all ${maxRetries} retries for ${context}`);
  return null;
}

// ---------------------------------------------------------------------------
// Main resolver
// ---------------------------------------------------------------------------

/**
 * Resolve USD prices for position lifecycle events.
 *
 * Tries DexScreener first, then GeckoTerminal. Each source is retried
 * with exponential backoff. Every attempt and failure is logged.
 *
 * Returns `priceStatus: 'live'` if at least one token has a real price.
 * Returns `priceStatus: 'pending'` if ALL sources failed — the caller
 * should store the record for backfill, never synthesize/derive prices.
 */
export async function resolveEventPrices(opts: PriceResolverOptions): Promise<ResolvedPrices> {
  const {
    addresses: [token0, token1, nativeWrapped],
    chainSlug,
    context,
    maxRetries = 3,
    baseDelayMs = 2000,
  } = opts;

  const allAddresses = [token0, token1, nativeWrapped].filter(Boolean);

  logger.info(
    `[PriceResolver] Starting event price resolution for ${context} ` +
    `(chain: ${chainSlug}, tokens: ${allAddresses.length})`,
  );

  // Source 1: DexScreener
  const dexResult = await fetchWithRetry(
    'DexScreener',
    () => fetchDexScreener(allAddresses, chainSlug, context),
    maxRetries,
    baseDelayMs,
    context,
  );

  if (dexResult && dexResult.prices.size > 0) {
    const resolved = extractPrices(dexResult, token0, token1, nativeWrapped);
    if (resolved.priceUsd0 > 0 || resolved.priceUsd1 > 0) {
      logger.info(
        `[PriceResolver] ✓ Resolved prices for ${context} via DexScreener: ` +
        `token0=$${resolved.priceUsd0}, token1=$${resolved.priceUsd1}, native=$${resolved.nativePriceUsd}`,
      );
      return resolved;
    }
  }

  logger.warn(`[PriceResolver] DexScreener failed for ${context}, falling back to GeckoTerminal`);

  // Source 2: GeckoTerminal
  const geckoResult = await fetchWithRetry(
    'GeckoTerminal',
    () => fetchGeckoTerminal(allAddresses, chainSlug, context),
    maxRetries,
    baseDelayMs,
    context,
  );

  if (geckoResult && geckoResult.prices.size > 0) {
    const resolved = extractPrices(geckoResult, token0, token1, nativeWrapped);
    if (resolved.priceUsd0 > 0 || resolved.priceUsd1 > 0) {
      logger.info(
        `[PriceResolver] ✓ Resolved prices for ${context} via GeckoTerminal: ` +
        `token0=$${resolved.priceUsd0}, token1=$${resolved.priceUsd1}, native=$${resolved.nativePriceUsd}`,
      );
      return resolved;
    }
  }

  // ALL sources exhausted
  logger.error(
    `[PriceResolver] ✗ ALL price sources failed for ${context}. ` +
    `Record will be stored with priceStatus='pending' for backfill. ` +
    `No synthetic/derived prices will be used.`,
  );

  return {
    priceUsd0: 0,
    priceUsd1: 0,
    nativePriceUsd: 0,
    priceSource: 'unavailable',
    priceStatus: 'pending',
  };
}

/**
 * Lightweight single-attempt price fetch for routine snapshots.
 * Uses DexScreener only, no retries (snapshots are expendable).
 */
export async function resolveSnapshotPrices(
  addresses: string[],
  chainSlug: string,
): Promise<{ prices: Map<string, number>; source: string } | null> {
  try {
    const result = await fetchDexScreener(addresses, chainSlug, 'snapshot');
    if (result.prices.size > 0) return result;
  } catch {
    // Snapshots are best-effort — silent failure is acceptable
  }
  return null;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function extractPrices(
  result: PriceSourceResult,
  token0: string,
  token1: string,
  nativeWrapped: string,
): ResolvedPrices {
  return {
    priceUsd0: result.prices.get(token0.toLowerCase()) ?? 0,
    priceUsd1: result.prices.get(token1.toLowerCase()) ?? 0,
    nativePriceUsd: result.prices.get(nativeWrapped.toLowerCase()) ?? 0,
    priceSource: result.source,
    priceStatus: 'live',
  };
}

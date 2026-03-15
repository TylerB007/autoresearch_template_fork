import logger from '../logger.js';
import { getHistoricalPricingSubgraph } from '../config/chains.js';

export interface HistoricalUsdResolutionOptions {
  chainId: number;
  dex?: string;
  blockNumber: number;
  token0Address: string;
  token1Address: string;
  nativeWrappedAddress: string;
  context: string;
  maxRetries?: number;
  baseDelayMs?: number;
}

export interface HistoricalUsdResolution {
  priceUsd0: number;
  priceUsd1: number;
  nativePriceUsd: number;
  priceSource: string;
}

interface SubgraphTokenPrice {
  derivedUSD?: string | null;
  derivedETH?: string | null;
}

interface HistoricalSubgraphResponse {
  data?: {
    token0?: SubgraphTokenPrice | null;
    token1?: SubgraphTokenPrice | null;
    nativeToken?: SubgraphTokenPrice | null;
    bundle?: {
      ethPriceUSD?: string | null;
    } | null;
  };
  errors?: Array<{ message?: string }>;
}

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parsePositiveNumber(value?: string | null): number {
  if (!value) return 0;
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function deriveTokenUsd(token: SubgraphTokenPrice | null | undefined, nativeUsd: number): number {
  const directUsd = parsePositiveNumber(token?.derivedUSD);
  if (directUsd > 0) return directUsd;

  const derivedNative = parsePositiveNumber(token?.derivedETH);
  if (derivedNative > 0 && nativeUsd > 0) {
    return derivedNative * nativeUsd;
  }

  return 0;
}

async function queryHistoricalUsdSubgraph(
  endpointUrl: string,
  blockNumber: number,
  token0Address: string,
  token1Address: string,
  nativeWrappedAddress: string,
  context: string,
): Promise<HistoricalUsdResolution | null> {
  const query = `query HistoricalUsdPrices($block: Int!) {
    token0: token(id: "${token0Address.toLowerCase()}", block: { number: $block }) {
      derivedUSD
      derivedETH
    }
    token1: token(id: "${token1Address.toLowerCase()}", block: { number: $block }) {
      derivedUSD
      derivedETH
    }
    nativeToken: token(id: "${nativeWrappedAddress.toLowerCase()}", block: { number: $block }) {
      derivedUSD
      derivedETH
    }
    bundle(id: "1", block: { number: $block }) {
      ethPriceUSD
    }
  }`;

  const response = await fetch(endpointUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
    body: JSON.stringify({ query, variables: { block: blockNumber } }),
    signal: AbortSignal.timeout(12_000),
  });

  if (!response.ok) {
    throw new Error(`Historical subgraph HTTP ${response.status} ${response.statusText}`);
  }

  const payload = await response.json() as HistoricalSubgraphResponse;
  if (payload.errors?.length) {
    const message = payload.errors.map((error) => error.message).filter(Boolean).join('; ');
    throw new Error(message || 'Historical subgraph returned GraphQL errors');
  }

  const nativeFromBundle = parsePositiveNumber(payload.data?.bundle?.ethPriceUSD);
  const nativeFromToken = deriveTokenUsd(payload.data?.nativeToken, nativeFromBundle);
  const nativePriceUsd = nativeFromToken > 0 ? nativeFromToken : nativeFromBundle;
  const priceUsd0 = deriveTokenUsd(payload.data?.token0, nativePriceUsd);
  const priceUsd1 = deriveTokenUsd(payload.data?.token1, nativePriceUsd);

  if (priceUsd0 <= 0 && priceUsd1 <= 0 && nativePriceUsd <= 0) {
    logger.warn(`[HistoricalUsd] No usable prices returned for ${context} at block ${blockNumber}`);
    return null;
  }

  return {
    priceUsd0,
    priceUsd1,
    nativePriceUsd,
    priceSource: 'historical_subgraph',
  };
}

export async function resolveHistoricalUsdPrices(
  opts: HistoricalUsdResolutionOptions,
): Promise<HistoricalUsdResolution | null> {
  const {
    chainId,
    dex,
    blockNumber,
    token0Address,
    token1Address,
    nativeWrappedAddress,
    context,
    maxRetries = 2,
    baseDelayMs = 1000,
  } = opts;

  const subgraph = getHistoricalPricingSubgraph(chainId, dex);
  if (!subgraph) {
    logger.debug(`[HistoricalUsd] No configured historical subgraph for ${context}`, { chainId, dex });
    return null;
  }

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      logger.info(
        `[HistoricalUsd] ${subgraph.key} attempt ${attempt}/${maxRetries} for ${context} at block ${blockNumber}`,
      );
      const resolved = await queryHistoricalUsdSubgraph(
        subgraph.url,
        blockNumber,
        token0Address,
        token1Address,
        nativeWrappedAddress,
        context,
      );

      if (resolved) {
        return {
          ...resolved,
          priceSource: `historical_subgraph:${subgraph.key}`,
        };
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.warn(
        `[HistoricalUsd] ${subgraph.key} attempt ${attempt}/${maxRetries} failed for ${context}: ${message}`,
      );
    }

    if (attempt < maxRetries) {
      await sleep(baseDelayMs * Math.pow(2, attempt - 1));
    }
  }

  return null;
}
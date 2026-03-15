import { afterEach, describe, expect, it, vi } from 'vitest';
import { getHistoricalPricingSubgraph } from '../config/chains.js';
import { resolveHistoricalUsdPrices } from './historicalUsd.js';

describe('getHistoricalPricingSubgraph', () => {
  it('maps PulseChain to the 9mm v3 endpoint', () => {
    expect(getHistoricalPricingSubgraph(369)).toEqual({
      key: '9mmV3',
      url: 'https://graph.9mm.pro/subgraphs/name/pulsechain/9mm-v3',
    });
  });

  it('returns null for dexes without a configured historical subgraph', () => {
    expect(getHistoricalPricingSubgraph(8453, 'aerodrome-cl')).toBeNull();
    expect(getHistoricalPricingSubgraph(42161, 'pancakeswap-v3')).toBeNull();
  });
});

describe('resolveHistoricalUsdPrices', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('uses direct derivedUSD values when the subgraph provides them', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        data: {
          token0: { derivedUSD: '1.25', derivedETH: '0.5' },
          token1: { derivedUSD: '0.75', derivedETH: '0.3' },
          nativeToken: { derivedUSD: '2.50', derivedETH: '1' },
          bundle: { ethPriceUSD: '2.50' },
        },
      }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const resolved = await resolveHistoricalUsdPrices({
      chainId: 369,
      blockNumber: 123,
      token0Address: '0x0000000000000000000000000000000000000001',
      token1Address: '0x0000000000000000000000000000000000000002',
      nativeWrappedAddress: '0x0000000000000000000000000000000000000003',
      context: 'test',
    });

    expect(resolved).toEqual({
      priceUsd0: 1.25,
      priceUsd1: 0.75,
      nativePriceUsd: 2.5,
      priceSource: 'historical_subgraph:9mmV3',
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('falls back to derivedETH multiplied by bundle ethPriceUSD', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        data: {
          token0: { derivedUSD: null, derivedETH: '3' },
          token1: { derivedUSD: null, derivedETH: '0.5' },
          nativeToken: { derivedUSD: null, derivedETH: '1' },
          bundle: { ethPriceUSD: '0.25' },
        },
      }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const resolved = await resolveHistoricalUsdPrices({
      chainId: 369,
      blockNumber: 456,
      token0Address: '0x0000000000000000000000000000000000000011',
      token1Address: '0x0000000000000000000000000000000000000012',
      nativeWrappedAddress: '0x0000000000000000000000000000000000000013',
      context: 'test-derived-eth',
    });

    expect(resolved).toEqual({
      priceUsd0: 0.75,
      priceUsd1: 0.125,
      nativePriceUsd: 0.25,
      priceSource: 'historical_subgraph:9mmV3',
    });
  });

  it('returns null when no configured subgraph exists for the requested dex', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const resolved = await resolveHistoricalUsdPrices({
      chainId: 8453,
      dex: 'aerodrome-cl',
      blockNumber: 789,
      token0Address: '0x0000000000000000000000000000000000000021',
      token1Address: '0x0000000000000000000000000000000000000022',
      nativeWrappedAddress: '0x0000000000000000000000000000000000000023',
      context: 'unsupported-dex',
    });

    expect(resolved).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
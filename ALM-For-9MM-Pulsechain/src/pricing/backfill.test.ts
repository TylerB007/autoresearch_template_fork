import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  resolveEventPricesMock: vi.fn(),
  resolveHistoricalUsdPricesMock: vi.fn(),
  getChainConfigMock: vi.fn(() => ({
    chainId: 369,
    chainName: 'PulseChain',
    rpcUrls: ['https://rpc.pulsechain.com'],
  })),
  getTransactionReceiptMock: vi.fn(async () => ({ blockNumber: 123456 })),
  getBlockNumberMock: vi.fn(async () => 999999),
}));

vi.mock('./resolver.js', () => ({
  resolveEventPrices: mocks.resolveEventPricesMock,
}));

vi.mock('./historicalUsd.js', () => ({
  resolveHistoricalUsdPrices: mocks.resolveHistoricalUsdPricesMock,
}));

vi.mock('../config/chains.js', () => ({
  getChainConfig: mocks.getChainConfigMock,
}));

vi.mock('ethers', () => ({
  ethers: {
    Network: class MockNetwork {
      constructor(_name: string, _chainId: number) {}
    },
    JsonRpcProvider: class MockJsonRpcProvider {
      constructor(_url: string, _network: unknown, _opts: unknown) {}
      getBlockNumber = mocks.getBlockNumberMock;
      getTransactionReceipt = mocks.getTransactionReceiptMock;
    },
  },
}));

import { enqueuePendingPrice, getPendingQueueSize, runBackfillCycle } from './backfill.js';

describe('runBackfillCycle', () => {
  let tempDir: string | null = null;

  afterEach(async () => {
    mocks.resolveEventPricesMock.mockReset();
    mocks.resolveHistoricalUsdPricesMock.mockReset();
    mocks.getChainConfigMock.mockClear();
    mocks.getTransactionReceiptMock.mockClear();
    mocks.getBlockNumberMock.mockClear();

    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true });
      tempDir = null;
    }

    if (getPendingQueueSize() > 0) {
      await runBackfillCycle();
    }
  });

  it('prefers historical indexed pricing over live resolver when tx hash and chain context exist', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'price-backfill-test-'));
    const filePath = join(tempDir, 'analytics.jsonl');

    await writeFile(
      filePath,
      `${JSON.stringify({
        type: 'position_entry',
        timestamp: 1,
        data: {
          tokenId: 155977,
          blockNumber: 123456,
          txHash: '0xmint',
          priceUsd0: 0,
          priceUsd1: 0,
          nativePriceUsd: 0,
          priceStatus: 'pending',
          priceSource: 'unavailable',
        },
      })}\n`,
      'utf-8',
    );

    mocks.resolveHistoricalUsdPricesMock.mockResolvedValue({
      priceUsd0: 1.11,
      priceUsd1: 2.22,
      nativePriceUsd: 0.33,
      priceSource: 'historical_subgraph:9mmV3',
    });
    mocks.resolveEventPricesMock.mockResolvedValue({
      priceUsd0: 9.99,
      priceUsd1: 8.88,
      nativePriceUsd: 7.77,
      priceSource: 'dexscreener',
      priceStatus: 'live',
    });

    enqueuePendingPrice({
      filePath,
      lineIndex: 0,
      recordType: 'position_entry',
      tokenId: 155977,
      eventTimestamp: Date.now(),
      token0Address: '0x0000000000000000000000000000000000000001',
      token1Address: '0x0000000000000000000000000000000000000002',
      nativeWrappedAddress: '0x0000000000000000000000000000000000000003',
      chainSlug: 'pulsechain',
      chainId: 369,
      dex: 'pancakeswap-v3',
    });

    const stats = await runBackfillCycle();
    const lines = (await readFile(filePath, 'utf-8')).trim().split('\n');
    const updated = JSON.parse(lines[0]) as { data: Record<string, unknown> };

    expect(stats.backfilled).toBe(1);
    expect(mocks.resolveHistoricalUsdPricesMock).toHaveBeenCalledWith(expect.objectContaining({
      chainId: 369,
      dex: 'pancakeswap-v3',
      blockNumber: 123456,
    }));
    expect(mocks.resolveEventPricesMock).not.toHaveBeenCalled();
    expect(mocks.getTransactionReceiptMock).not.toHaveBeenCalled();
    expect(updated.data.priceUsd0).toBe(1.11);
    expect(updated.data.priceUsd1).toBe(2.22);
    expect(updated.data.nativePriceUsd).toBe(0.33);
    expect(updated.data.priceStatus).toBe('backfilled');
    expect(updated.data.backfillSource).toBe('historical_subgraph:9mmV3');
  });
});
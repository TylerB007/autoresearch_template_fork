import { describe, expect, it } from 'vitest';
import type {
  FeeCollectionRecord,
  ManualLink,
  PositionEntryRecord,
  PositionSnapshot,
  RebalanceAnalytics,
} from './types.js';
import { buildLineageAnalyticsSummary, resolveLineageContext, type LivePositionAnalyticsState } from './lineageSummary.js';

function createSnapshot(overrides: Partial<PositionSnapshot>): PositionSnapshot {
  return {
    timestamp: 0,
    tokenId: 0,
    liquidity: 0n,
    tickLower: -100,
    tickUpper: 100,
    amount0: 0n,
    amount1: 0n,
    currentTick: 0,
    sqrtPriceX96: 0n,
    poolLiquidity: 0n,
    isInRange: true,
    tickDistance: 0,
    tokensOwed0: 0n,
    tokensOwed1: 0n,
    token0Symbol: 'HEX',
    token1Symbol: 'WPLS',
    token0Decimals: 18,
    token1Decimals: 18,
    poolFee: 2500,
    priceUsd0: 2,
    priceUsd1: 1,
    nativePriceUsd: 1,
    positionValueUsd: 0,
    unclaimedFeesUsd: 0,
    ...overrides,
  };
}

function createRebalance(overrides: Partial<RebalanceAnalytics>): RebalanceAnalytics {
  return {
    timestamp: 0,
    rebalanceId: 'rb-1',
    oldTokenId: 1,
    newTokenId: 2,
    strategy: 'center_6pct' as never,
    preSnapshot: createSnapshot({ tokenId: 1, positionValueUsd: 110, amount0: 10n * 10n ** 18n, amount1: 80n * 10n ** 18n }),
    postSnapshot: createSnapshot({ tokenId: 2, positionValueUsd: 110, amount0: 9n * 10n ** 18n, amount1: 92n * 10n ** 18n }),
    txHashes: { collectFees: '0x1', decreaseLiquidity: '0x2', collectTokens: '0x3', burn: '0x4', mint: '0x5' },
    feesCollected0: 2n * 10n ** 18n,
    feesCollected1: 6n * 10n ** 18n,
    liquidityRemoved0: 0n,
    liquidityRemoved1: 0n,
    newLiquidity: 0n,
    newAmount0: 0n,
    newAmount1: 0n,
    newTickLower: -100,
    newTickUpper: 100,
    gasUsed: {
      collectFees: 0n,
      decreaseLiquidity: 0n,
      collectTokens: 0n,
      burn: 0n,
      swap: 0n,
      approvals: 0n,
      mint: 0n,
      total: 0n,
    },
    gasPrice: 0n,
    totalGasCostPLS: 3,
    gasCostUsd: 3,
    nativeTokenPriceUsd: 1,
    priceUsd0: 2,
    priceUsd1: 1,
    feesCollectedUsd: 10,
    swapFrictionUsd: 2,
    metrics: {
      durationSeconds: 86_400,
      durationDays: 1,
      feeAPR: 12,
      rawFeeYieldPercent: 3,
      capitalEfficiencyRatio: 1,
      timeInRangePercent: 95,
      feesToCostRatio: 2,
      impermanentLossPercent: 1,
      netROIPercent: 9,
      trueNetROIPercent: 7,
      rebalanceCostPercent: 2,
      rebalanceCostToken0: 0,
    },
    ...overrides,
  };
}

describe('resolveLineageContext', () => {
  it('walks backward and forward through rebalances and manual links', () => {
    const rebalances = [createRebalance({ oldTokenId: 10, newTokenId: 11, rebalanceId: 'rb-a' })];
    const manualLinks: ManualLink[] = [{ oldTokenId: 11, newTokenId: 12, createdAt: 2_000 }];

    const lineage = resolveLineageContext(11, rebalances, manualLinks);

    expect(lineage.rootTokenId).toBe(10);
    expect(lineage.currentTokenId).toBe(12);
    expect(lineage.lineageTokenIds).toEqual([10, 11, 12]);
    expect(lineage.lineageRebalances).toHaveLength(1);
  });
});

describe('buildLineageAnalyticsSummary', () => {
  it('computes lifetime PnL from absolute USD values instead of summing ROI percentages', () => {
    const positionEntries: PositionEntryRecord[] = [
      {
        timestamp: 1_000,
        tokenId: 1,
        txHash: '0xentry1',
        amount0: 10n * 10n ** 18n,
        amount1: 80n * 10n ** 18n,
        priceUsd0: 2,
        priceUsd1: 1,
        nativePriceUsd: 1,
        entryCostUsd: 100,
        gasCostUsd: 1,
        source: 'manual',
        token0Symbol: 'HEX',
        token1Symbol: 'WPLS',
        token0Decimals: 18,
        token1Decimals: 18,
        tickLower: -100,
        tickUpper: 100,
      },
      {
        timestamp: 2_000,
        tokenId: 2,
        txHash: '0xentry2',
        amount0: 9n * 10n ** 18n,
        amount1: 92n * 10n ** 18n,
        priceUsd0: 2,
        priceUsd1: 1,
        nativePriceUsd: 1,
        entryCostUsd: 110,
        gasCostUsd: 0.5,
        source: 'rebalance',
        fromTokenId: 1,
        token0Symbol: 'HEX',
        token1Symbol: 'WPLS',
        token0Decimals: 18,
        token1Decimals: 18,
        tickLower: -100,
        tickUpper: 100,
      },
    ];
    const rebalances = [createRebalance({ timestamp: 2_000, oldTokenId: 1, newTokenId: 2 })];
    const feeCollections: FeeCollectionRecord[] = [
      {
        timestamp: 3_000,
        tokenId: 2,
        txHash: '0xfc1',
        amount0: 1n * 10n ** 18n,
        amount1: 2n * 10n ** 18n,
        gasUsed: 0n,
        gasPrice: 0n,
        gasCostPLS: 1,
        priceUsd0: 2,
        priceUsd1: 1,
        valueUsd0: 2,
        valueUsd1: 2,
        totalValueUsd: 4,
        token0Symbol: 'HEX',
        token1Symbol: 'WPLS',
        token0Decimals: 18,
        token1Decimals: 18,
      },
    ];
    const snapshots: PositionSnapshot[] = [
      createSnapshot({ timestamp: 1_000, tokenId: 1, positionValueUsd: 100, amount0: 10n * 10n ** 18n, amount1: 80n * 10n ** 18n }),
      createSnapshot({ timestamp: 2_500, tokenId: 2, positionValueUsd: 118, unclaimedFeesUsd: 5, amount0: 9n * 10n ** 18n, amount1: 92n * 10n ** 18n }),
    ];
    const liveState: LivePositionAnalyticsState = {
      tokenId: 2,
      timestamp: 4_000,
      currentPositionValueUsd: 120,
      currentUnclaimedFeesUsd: 6,
      priceUsd0: 2,
      priceUsd1: 1,
      nativePriceUsd: 1,
      token0Symbol: 'HEX',
      token1Symbol: 'WPLS',
      token0Decimals: 18,
      token1Decimals: 18,
      source: 'live',
      priceStatus: 'live',
    };

    const summary = buildLineageAnalyticsSummary({
      requestedTokenId: 2,
      rebalances,
      feeCollections,
      snapshots,
      positionEntries,
      manualLinks: [],
      liveState,
    });

    expect(summary.lifetimeChain.rootTokenId).toBe(1);
    expect(summary.lifetimeChain.currentTokenId).toBe(2);
    expect(summary.lifetimeChain.claimedFeesUsd).toBe(14);
    expect(summary.lifetimeChain.totalGasCostUsd).toBe(5);
    expect(summary.lifetimeChain.totalSwapFrictionUsd).toBe(2);
    expect(summary.lifetimeChain.totalCostsUsd).toBe(7);
    expect(summary.lifetimeChain.truePnlUsd).toBe(33);
    expect(summary.lifetimeChain.truePnlPercent).toBe(33);
    expect(summary.currentInterval.claimedFeesUsd).toBe(4);
    expect(summary.currentInterval.totalCostsUsd).toBe(1);
    expect(summary.currentInterval.truePnlUsd).toBe(19);
  });

  it('ignores rebalances from a different dex when a dex scope is provided', () => {
    const scoped = buildLineageAnalyticsSummary({
      requestedTokenId: 2,
      requestedChainId: 369,
      requestedDex: 'uniswap-v3',
      rebalances: [
        createRebalance({ timestamp: 2_000, oldTokenId: 1, newTokenId: 2, chainId: 369, dex: 'uniswap-v3', feesCollectedUsd: 10, gasCostUsd: 1 }),
        createRebalance({ timestamp: 3_000, oldTokenId: 1, newTokenId: 999, chainId: 369, dex: 'pancakeswap-v3', feesCollectedUsd: 999, gasCostUsd: 999 }),
      ],
      feeCollections: [],
      snapshots: [createSnapshot({ tokenId: 2, chainId: 369, dex: 'uniswap-v3', positionValueUsd: 100 })],
      positionEntries: [
        {
          timestamp: 1_000,
          tokenId: 1,
          txHash: '0xentry1',
          amount0: 10n,
          amount1: 10n,
          priceUsd0: 1,
          priceUsd1: 1,
          nativePriceUsd: 1,
          entryCostUsd: 50,
          gasCostUsd: 0,
          source: 'manual',
          token0Symbol: 'A',
          token1Symbol: 'B',
          token0Decimals: 18,
          token1Decimals: 18,
          tickLower: -1,
          tickUpper: 1,
          chainId: 369,
          dex: 'uniswap-v3',
        },
      ],
      manualLinks: [],
      liveState: {
        tokenId: 2,
        chainId: 369,
        dex: 'uniswap-v3',
        timestamp: 4_000,
        currentPositionValueUsd: 100,
        currentUnclaimedFeesUsd: 0,
        priceUsd0: 1,
        priceUsd1: 1,
        nativePriceUsd: 1,
        token0Symbol: 'A',
        token1Symbol: 'B',
        token0Decimals: 18,
        token1Decimals: 18,
        source: 'live',
        priceStatus: 'live',
      },
    });

    expect(scoped.lifetimeChain.totalRebalances).toBe(1);
    expect(scoped.lifetimeChain.claimedFeesUsd).toBe(10);
  });
});
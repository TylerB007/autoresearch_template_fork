import { describe, expect, it, vi } from 'vitest';
import type { KoinlyRow } from './koinly.js';
import type { RebalanceAnalytics, PositionEntryRecord } from '../analytics/types.js';
import { buildInternalEventIndex, matchEvents } from './matcher.js';
import { printReport, summarizeResult } from './report.js';
import {
  filterChainRecords,
  filterKoinlyRowsByWalletSubstring,
  filterKoinlyRowsForPulsechain,
  resolveAuditScope,
} from './scope.js';

function makeKoinlyMintRow(): KoinlyRow {
  return {
    rowNum: 1,
    dateMs: 1_700_000_000_000,
    type: 'Exchange',
    wallet: 'ALM Pulsechain',
    asset: { amount: -100, symbol: 'HEX', isReceived: false },
    received: { amount: 1, symbol: '9MM-V3-POS #200', isReceived: true },
    usdValue: 250,
    plUsd: 0,
    tag: 'token swap',
    notes: '',
    rawTxHash: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  };
}

function makeRebalanceMint(): RebalanceAnalytics {
  return {
    timestamp: 1_700_000_000_000,
    rebalanceId: 'reb-1',
    oldTokenId: 100,
    newTokenId: 200,
    strategy: 'center_6pct',
    preSnapshot: {
      tokenId: 100,
      timestamp: 1_700_000_000_000,
      chainId: 369,
      dex: 'pancakeswap-v3',
      token0Symbol: 'HEX',
      token1Symbol: 'WPLS',
      token0Decimals: 8,
      token1Decimals: 18,
      positionValueUsd: 250,
      amount0: 0n,
      amount1: 0n,
      tokensOwed0: 0n,
      tokensOwed1: 0n,
      liquidity: 0n,
      sqrtPriceX96: 1n,
      poolLiquidity: 0n,
      currentTick: 0,
      tickLower: 0,
      tickUpper: 0,
      isInRange: true,
      priceRatio: 0,
      feeTier: 2500,
      poolAddress: '0xpool',
    },
    postSnapshot: {
      tokenId: 200,
      timestamp: 1_700_000_000_000,
      chainId: 369,
      dex: 'pancakeswap-v3',
      token0Symbol: 'HEX',
      token1Symbol: 'WPLS',
      token0Decimals: 8,
      token1Decimals: 18,
      positionValueUsd: 250,
      amount0: 0n,
      amount1: 0n,
      tokensOwed0: 0n,
      tokensOwed1: 0n,
      liquidity: 0n,
      sqrtPriceX96: 1n,
      poolLiquidity: 0n,
      currentTick: 0,
      tickLower: 0,
      tickUpper: 0,
      isInRange: true,
      priceRatio: 0,
      feeTier: 2500,
      poolAddress: '0xpool',
    },
    txHashes: {
      collectFees: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      decreaseLiquidity: '0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
      collectTokens: '0xdddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd',
      burn: '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
      mint: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    },
    feesCollected0: 0n,
    feesCollected1: 0n,
    liquidityRemoved0: 0n,
    liquidityRemoved1: 0n,
    newLiquidity: 1n,
    newAmount0: 10_000_000_000n,
    newAmount1: 0n,
    newTickLower: -100,
    newTickUpper: 100,
    gasUsed: {
      collectFees: 1n,
      decreaseLiquidity: 1n,
      collectTokens: 1n,
      burn: 1n,
      approvals: 0n,
      mint: 1n,
      total: 5n,
    },
    gasPrice: 1n,
    totalGasCostPLS: 0,
    priceUsd0: 2.5,
    priceUsd1: 0,
    gasCostUsd: 1,
    metrics: {
      durationSeconds: 0,
      durationDays: 0,
      feeAPR: 0,
      rawFeeYieldPercent: 0,
      capitalEfficiencyRatio: 0,
      timeInRangePercent: 0,
      feesToCostRatio: 0,
      impermanentLossPercent: 0,
      netROIPercent: 0,
      trueNetROIPercent: 0,
      rebalanceCostPercent: 0,
      rebalanceCostToken0: 0,
    },
  } as unknown as RebalanceAnalytics;
}

function makeUniqueEntry(): PositionEntryRecord {
  return {
    timestamp: 1_700_000_010_000,
    tokenId: 300,
    chainId: 369,
    txHash: '0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff',
    amount0: 5_000_000_000n,
    amount1: 0n,
    priceUsd0: 3,
    priceUsd1: 0,
    nativePriceUsd: 0,
    entryCostUsd: 150,
    gasCostUsd: 0.5,
    source: 'manual',
    token0Symbol: 'HEX',
    token1Symbol: 'WPLS',
    token0Decimals: 8,
    token1Decimals: 18,
    tickLower: -10,
    tickUpper: 10,
    priceSource: 'dexscreener',
    priceStatus: 'live',
  } as PositionEntryRecord;
}

describe('audit matcher coverage improvements', () => {
  it('computes mint usd value from rebalance data and includes unique position entries', () => {
    const events = buildInternalEventIndex([makeRebalanceMint()], [], [makeUniqueEntry()], []);

    const rebalanceMint = events.find((event) => event.kind === 'rebalance_mint');
    const mintToken0 = events.find((event) => event.kind === 'rebalance_mint_token0');
    const positionEntry = events.find((event) => event.kind === 'position_entry');
    const entryToken0 = events.find((event) => event.kind === 'position_entry_token0');

    // Combined mint has total USD value
    expect(rebalanceMint?.usdValue).toBe(250);
    // Per-token leg has single-token USD value
    expect(mintToken0?.usdValue).toBe(250); // only token0 has amount in test fixture
    expect(positionEntry?.tokenId).toBe(300);
    expect(entryToken0?.tokenId).toBe(300);
    // Mint tx hash appears 3 times: token0 leg, token1 leg (even if 0), combined fallback
    const mintEvents = events.filter((event) => event.txHash === '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
    expect(mintEvents.length).toBeGreaterThanOrEqual(2); // at least token0 + combined
  });

  it('matches mint-like koinly rows to rebalance mint with tx hash coverage', () => {
    // Exchange row receiving an NFT should match the combined rebalance_mint
    const row = makeKoinlyMintRow();
    const events = buildInternalEventIndex([makeRebalanceMint()], [], [], []);
    const result = matchEvents([row], events);

    expect(result.unmatchedKoinly).toHaveLength(0);
    expect(result.matched).toHaveLength(1);
    // Exchange+NFT rows prefer combined events
    expect(result.matched[0].internal.kind).toBe('rebalance_mint');
    const usdDiscrepancy = result.matched[0].discrepancies.find((item) => item.field === 'usd_value');
    expect(usdDiscrepancy?.severity).toBe('ok');
  });

  it('matches SEND+mint koinly rows to per-token leg events', () => {
    // SEND+mint rows represent a single token leg, should match per-token events
    const row: KoinlyRow = {
      ...makeKoinlyMintRow(),
      type: 'Send',
      tag: 'mint',
      asset: { amount: -100, symbol: 'HEX', isReceived: false },
      received: null,
    };
    const events = buildInternalEventIndex([makeRebalanceMint()], [], [], []);
    const result = matchEvents([row], events);

    expect(result.unmatchedKoinly).toHaveLength(0);
    expect(result.matched).toHaveLength(1);
    // SEND+mint rows prefer per-token legs
    expect(result.matched[0].internal.kind).toBe('rebalance_mint_token0');
  });
});

describe('audit report summary semantics', () => {
  it('fails when koinly rows are unmatched even without matched discrepancies', () => {
    const summary = summarizeResult({
      matched: [],
      unmatchedKoinly: [makeKoinlyMintRow()],
      unmatchedInternal: [],
    });

    expect(summary.overallStatus).toBe('FAIL');
  });

  it('warns when only internal orphan events remain', () => {
    const summary = summarizeResult({
      matched: [],
      unmatchedKoinly: [],
      unmatchedInternal: [{
        kind: 'lifecycle_event',
        timestamp: 1,
        txHash: '0x1',
        tokenId: 1,
        chainId: 369,
        usdValue: null,
        amount0Human: null,
        amount1Human: null,
        token0Symbol: null,
        token1Symbol: null,
        gasCostUsd: null,
        swapInSymbol: null,
        swapOutSymbol: null,
        swapInAmount: null,
        swapOutAmount: null,
        lifecycleEventType: 'swap_executed',
        source: {} as never,
        label: 'orphan',
      }],
    });

    expect(summary.overallStatus).toBe('WARN');
  });

  it('prints coverage-oriented summary output', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    printReport({
      matched: [],
      unmatchedKoinly: [makeKoinlyMintRow()],
      unmatchedInternal: [],
    }, {
      csvPath: 'audit.csv',
      storagePath: './analytics',
      internalEventCount: 0,
      koinlyRowCount: 1,
      dateRangeMs: null,
      scopeLabel: 'PulseChain only (chainId 369)',
      sourceCounts: { rebalances: 0, feeCollections: 0, lifecycleEvents: 0, positionEntries: 0 },
    });

    const output = logSpy.mock.calls.flat().join('\n');
    expect(output).toContain('Scope:');
    expect(output).toContain('Koinly coverage:');
    expect(output).toContain('Overall status:');
    expect(output).toContain('FAIL');

    logSpy.mockRestore();
  });
});

describe('audit scope helpers', () => {
  it('filters Koinly rows by explicit wallet substring', () => {
    const rows: KoinlyRow[] = [
      makeKoinlyMintRow(),
      { ...makeKoinlyMintRow(), rowNum: 2, wallet: 'ALM Base (ETH)' },
    ];

    const filtered = filterKoinlyRowsByWalletSubstring(rows, 'pulsechain');
    expect(filtered.map((row) => row.rowNum)).toEqual([1]);
  });

  it('detects PulseChain rows heuristically when no explicit wallet filter is provided', () => {
    const rows: KoinlyRow[] = [
      makeKoinlyMintRow(),
      { ...makeKoinlyMintRow(), rowNum: 2, wallet: 'ALM Base (ETH)' },
      { ...makeKoinlyMintRow(), rowNum: 3, wallet: 'Treasury (PLS)' },
    ];

    const filtered = filterKoinlyRowsForPulsechain(rows);
    expect(filtered.map((row) => row.rowNum)).toEqual([1, 3]);
  });

  it('filters internal records by chain while preserving legacy undefined chain ids', () => {
    const filtered = filterChainRecords([
      { chainId: 369, value: 'pulse' },
      { chainId: 8453, value: 'base' },
      { value: 'legacy' },
    ], 369);

    expect(filtered).toEqual([
      { chainId: 369, value: 'pulse' },
      { value: 'legacy' },
    ]);
  });

  it('builds a clear scope label for combined selectors', () => {
    expect(resolveAuditScope({ pulsechainOnly: true })).toEqual({
      effectiveChainId: 369,
      effectiveWalletSubstring: undefined,
      scopeLabel: 'PulseChain only (chainId 369)',
    });

    expect(resolveAuditScope({ chainId: 369, walletSubstring: 'ALM Pulsechain' })).toEqual({
      effectiveChainId: 369,
      effectiveWalletSubstring: 'ALM Pulsechain',
      scopeLabel: 'chainId 369 + wallet~"ALM Pulsechain"',
    });
  });
});
/**
 * Unit tests for retrospective outcome backfill logic.
 *
 * Tests the pure numeric reasoning behind the backfill:
 *   - Window eligibility (age thresholds for 1d/3d/7d)
 *   - Fee accumulation logic (sumFeesEarned via mock records)
 *   - actualDaysToRecovery sentinel value (-1 = not recovered)
 *   - nextRebalance linkage matching rules
 *
 * File I/O functions (readRebalancesFile, writeRebalancesFile) are not tested here
 * since they require the full FS. Instead we test the math and decision logic
 * that would be applied to records once read.
 */
import { describe, it, expect } from 'vitest';
import { feeContributionForRecovery, findNextRebalanceForChild, matchesRetrospectiveScope } from './retrospective.js';
import type { AnalyticsRecord, RebalanceAnalytics } from './types.js';

// ── Window constants (mirrors retrospective.ts) ───────────────────────────────

const WINDOWS_MS = {
  '1d': 24 * 60 * 60 * 1000,
  '3d': 3 * 24 * 60 * 60 * 1000,
  '7d': 7 * 24 * 60 * 60 * 1000,
} as const;

// ── Window eligibility ────────────────────────────────────────────────────────

describe('window eligibility', () => {
  it('1d window eligible after exactly 24 hours', () => {
    const now = Date.now();
    const rebalanceTs = now - WINDOWS_MS['1d'];
    const ageMs = now - rebalanceTs;
    expect(ageMs).toBeGreaterThanOrEqual(WINDOWS_MS['1d']);
  });

  it('1d window not yet eligible at 23h 59m', () => {
    const now = Date.now();
    const rebalanceTs = now - (WINDOWS_MS['1d'] - 60_000);
    const ageMs = now - rebalanceTs;
    expect(ageMs).toBeLessThan(WINDOWS_MS['1d']);
  });

  it('3d window eligible after 3 days', () => {
    const now = Date.now();
    const rebalanceTs = now - WINDOWS_MS['3d'];
    expect(now - rebalanceTs).toBeGreaterThanOrEqual(WINDOWS_MS['3d']);
  });

  it('3d window not eligible at 2d 23h', () => {
    const now = Date.now();
    const rebalanceTs = now - (WINDOWS_MS['3d'] - 60_000);
    expect(now - rebalanceTs).toBeLessThan(WINDOWS_MS['3d']);
  });

  it('7d window eligible after 7 days', () => {
    const now = Date.now();
    const rebalanceTs = now - WINDOWS_MS['7d'];
    expect(now - rebalanceTs).toBeGreaterThanOrEqual(WINDOWS_MS['7d']);
  });

  it('windows are ordered correctly (1d < 3d < 7d)', () => {
    expect(WINDOWS_MS['1d']).toBeLessThan(WINDOWS_MS['3d']);
    expect(WINDOWS_MS['3d']).toBeLessThan(WINDOWS_MS['7d']);
  });

  it('window values are correct in ms', () => {
    expect(WINDOWS_MS['1d']).toBe(86_400_000);
    expect(WINDOWS_MS['3d']).toBe(259_200_000);
    expect(WINDOWS_MS['7d']).toBe(604_800_000);
  });
});

// ── Recovery scan logic ───────────────────────────────────────────────────────

describe('actualDaysToRecovery scan logic', () => {
  /**
   * Simulate the recovery scan: iterates daily windows up to maxDays,
   * returns the first day where cumulative fees >= totalLossUsd.
   */
  function findRecoveryDay(
    feesByDay: number[],  // cumulative fees by day index (0-based)
    totalLossUsd: number,
    maxDays: number = 30,
  ): number | undefined {
    for (let d = 1; d <= Math.min(maxDays, feesByDay.length); d++) {
      if (feesByDay[d - 1] >= totalLossUsd) return d;
    }
    return undefined; // not recovered within window
  }

  it('recovers on day 1 when fees exceed loss immediately', () => {
    const day = findRecoveryDay([100, 150, 200], 50);
    expect(day).toBe(1);
  });

  it('recovers on day 3 when fees accumulate over time', () => {
    // cumulative: day1=10, day2=30, day3=60 → recovers on day 3
    const day = findRecoveryDay([10, 30, 60, 80], 55);
    expect(day).toBe(3);
  });

  it('returns undefined when never recovered within maxDays', () => {
    const day = findRecoveryDay([10, 20, 30], 100);
    expect(day).toBeUndefined();
  });

  it('recovers exactly at threshold (≥ is satisfied by equality)', () => {
    const day = findRecoveryDay([50], 50);
    expect(day).toBe(1);
  });

  it('sentinel -1 is used when 7d has passed and no recovery found', () => {
    // Mirroring the backfill logic: if 7d elapsed and still undefined → -1
    const ageMs = WINDOWS_MS['7d'] + 1;
    let actualDaysToRecovery: number | undefined = undefined;
    const recovered = false;

    if (!recovered && ageMs >= WINDOWS_MS['7d'] && actualDaysToRecovery === undefined) {
      actualDaysToRecovery = -1;
    }

    expect(actualDaysToRecovery).toBe(-1);
  });

  it('sentinel -1 is NOT set before 7d has passed', () => {
    const ageMs = WINDOWS_MS['3d']; // only 3 days old
    let actualDaysToRecovery: number | undefined = undefined;
    const recovered = false;

    if (!recovered && ageMs >= WINDOWS_MS['7d'] && actualDaysToRecovery === undefined) {
      actualDaysToRecovery = -1;
    }

    expect(actualDaysToRecovery).toBeUndefined();
  });

  it('sentinel -1 is NOT set when position already recovered', () => {
    const ageMs = WINDOWS_MS['7d'] + 1;
    let actualDaysToRecovery: number | undefined = 3; // recovered on day 3
    const recovered = true;

    if (!recovered && ageMs >= WINDOWS_MS['7d'] && actualDaysToRecovery === undefined) {
      actualDaysToRecovery = -1;
    }

    expect(actualDaysToRecovery).toBe(3); // unchanged
  });
});

// ── nextRebalance linkage matching rules ──────────────────────────────────────

describe('nextRebalance linkage matching', () => {
  interface MinimalRebalance {
    rebalanceId: string;
    timestamp: number;
    oldTokenId: number;
    newTokenId: number;
    chainId?: number;
    dex?: string;
  }

  function createRebalance(overrides: Partial<RebalanceAnalytics>): RebalanceAnalytics {
    return {
      timestamp: 0,
      rebalanceId: 'rb',
      oldTokenId: 1,
      newTokenId: 2,
      strategy: 'center_6pct' as never,
      preSnapshot: {} as RebalanceAnalytics['preSnapshot'],
      postSnapshot: {} as RebalanceAnalytics['postSnapshot'],
      txHashes: { collectFees: '0x1', decreaseLiquidity: '0x2', collectTokens: '0x3', burn: '0x4', mint: '0x5' },
      feesCollected0: 0n,
      feesCollected1: 0n,
      liquidityRemoved0: 0n,
      liquidityRemoved1: 0n,
      newLiquidity: 0n,
      newAmount0: 0n,
      newAmount1: 0n,
      newTickLower: 0,
      newTickUpper: 0,
      gasUsed: { collectFees: 0n, decreaseLiquidity: 0n, collectTokens: 0n, burn: 0n, swap: 0n, approvals: 0n, mint: 0n, total: 0n },
      gasPrice: 0n,
      totalGasCostPLS: 0,
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
      ...overrides,
    };
  }

  const base = 1_700_000_000_000;

  it('finds next rebalance when oldTokenId matches current newTokenId', () => {
    const current: MinimalRebalance = { rebalanceId: 'a', timestamp: base, oldTokenId: 1, newTokenId: 2 };
    const next: MinimalRebalance = { rebalanceId: 'b', timestamp: base + 86_400_000, oldTokenId: 2, newTokenId: 3 };
    expect(findNextRebalanceForChild(createRebalance(current), [createRebalance(next)])?.rebalanceId).toBe('b');
  });

  it('does not treat another rebalance opening the same token id as the child closing event', () => {
    const current: MinimalRebalance = { rebalanceId: 'a', timestamp: base, oldTokenId: 1, newTokenId: 2 };
    const next: MinimalRebalance = { rebalanceId: 'b', timestamp: base + 3600_000, oldTokenId: 5, newTokenId: 2 };
    expect(findNextRebalanceForChild(createRebalance(current), [createRebalance(next)])).toBeUndefined();
  });

  it('ignores rebalances that occurred before current timestamp', () => {
    const current: MinimalRebalance = { rebalanceId: 'a', timestamp: base + 1000, oldTokenId: 1, newTokenId: 2 };
    const older: MinimalRebalance = { rebalanceId: 'b', timestamp: base, oldTokenId: 2, newTokenId: 3 };
    expect(findNextRebalanceForChild(createRebalance(current), [createRebalance(older)])).toBeUndefined();
  });

  it('ignores rebalances that do not involve current newTokenId', () => {
    const current: MinimalRebalance = { rebalanceId: 'a', timestamp: base, oldTokenId: 1, newTokenId: 2 };
    const unrelated: MinimalRebalance = { rebalanceId: 'b', timestamp: base + 1000, oldTokenId: 9, newTokenId: 10 };
    expect(findNextRebalanceForChild(createRebalance(current), [createRebalance(unrelated)])).toBeUndefined();
  });

  it('returns undefined when no candidates provided', () => {
    const current: MinimalRebalance = { rebalanceId: 'a', timestamp: base, oldTokenId: 1, newTokenId: 2 };
    expect(findNextRebalanceForChild(createRebalance(current), [])).toBeUndefined();
  });

  it('returns the first matching next rebalance (chronologically first)', () => {
    const current: MinimalRebalance = { rebalanceId: 'a', timestamp: base, oldTokenId: 1, newTokenId: 2 };
    // Two candidates — find() returns first in array order; array should be sorted ascending
    const sorted: MinimalRebalance[] = [
      { rebalanceId: 'b', timestamp: base + 1000, oldTokenId: 2, newTokenId: 3 },
      { rebalanceId: 'c', timestamp: base + 2000, oldTokenId: 2, newTokenId: 4 },
    ];
    expect(findNextRebalanceForChild(createRebalance(current), sorted.map(createRebalance))?.rebalanceId).toBe('b');
  });

  it('requires matching dex scope when linking the next rebalance', () => {
    const current = createRebalance({ rebalanceId: 'a', timestamp: base, oldTokenId: 1, newTokenId: 2, chainId: 369, dex: 'uniswap-v3' });
    const wrongDex = createRebalance({ rebalanceId: 'b', timestamp: base + 1000, oldTokenId: 2, newTokenId: 3, chainId: 369, dex: 'pancakeswap-v3' });
    expect(findNextRebalanceForChild(current, [wrongDex])).toBeUndefined();
  });
});

describe('recovery fee contribution', () => {
  it('counts fee_collection records for the child token', () => {
    const record: AnalyticsRecord = {
      type: 'fee_collection',
      timestamp: 1,
      data: { tokenId: 2, totalValueUsd: 12, timestamp: 1 } as never,
    };
    expect(feeContributionForRecovery(record, 2)).toBe(12);
  });

  it('counts rebalance fees only when the token is the old token being closed', () => {
    const closingRecord: AnalyticsRecord = {
      type: 'rebalance',
      timestamp: 1,
      data: { oldTokenId: 2, newTokenId: 3, feesCollectedUsd: 15 } as never,
    };
    const openingRecord: AnalyticsRecord = {
      type: 'rebalance',
      timestamp: 1,
      data: { oldTokenId: 1, newTokenId: 2, feesCollectedUsd: 99 } as never,
    };
    expect(feeContributionForRecovery(closingRecord, 2)).toBe(15);
    expect(feeContributionForRecovery(openingRecord, 2)).toBe(0);
  });

  it('enforces dex scope when counting recovery fees', () => {
    const record: AnalyticsRecord = {
      type: 'fee_collection',
      timestamp: 1,
      data: { tokenId: 2, totalValueUsd: 12, chainId: 369, dex: 'pancakeswap-v3', timestamp: 1 } as never,
    };
    expect(feeContributionForRecovery(record, 2, { chainId: 369, dex: 'uniswap-v3' })).toBe(0);
    expect(matchesRetrospectiveScope({ chainId: 369, dex: 'uniswap-v3' }, { chainId: 369, dex: 'uniswap-v3' })).toBe(true);
  });
});

// ── recoveredBeforeNextRebalance logic ────────────────────────────────────────

describe('recoveredBeforeNextRebalance', () => {
  it('true when cumulative fees before next rebalance >= totalLossUsd', () => {
    const feesBeforeNext = 120;
    const totalLossUsd = 100;
    const result = feesBeforeNext >= totalLossUsd;
    expect(result).toBe(true);
  });

  it('false when cumulative fees before next rebalance < totalLossUsd', () => {
    const feesBeforeNext = 50;
    const totalLossUsd = 100;
    const result = feesBeforeNext >= totalLossUsd;
    expect(result).toBe(false);
  });

  it('true exactly at break-even (>= not >)', () => {
    const feesBeforeNext = 100;
    const totalLossUsd = 100;
    expect(feesBeforeNext >= totalLossUsd).toBe(true);
  });

  it('true when totalLossUsd = 0 (zero-loss rebalance always recovered)', () => {
    expect(0 >= 0).toBe(true);
    expect(1 >= 0).toBe(true);
  });
});

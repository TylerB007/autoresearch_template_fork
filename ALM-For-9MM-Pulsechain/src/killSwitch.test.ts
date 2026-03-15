/**
 * Unit tests for src/killSwitch.ts — per-position automatic disable logic.
 *
 * killSwitch.ts has module-level state (`state`) that persists between evaluations.
 * Tests manipulate state via the exported API only (no direct state access).
 *
 * File I/O (persistState/loadKillSwitchState) writes to `.kill-switch-state.json`
 * in the process CWD. We use a unique posKey per test to prevent cross-test
 * contamination of the in-memory state.
 */
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { resolve } from 'path';
import {
  evaluateKillSwitch,
  isKillSwitchTriggered,
  getKillSwitchStatus,
  resetKillSwitch,
} from './killSwitch.js';
import type { KillSwitchParams } from './types.js';
import type { RebalanceAnalytics } from './analytics/types.js';

// ── Helpers ──────────────────────────────────────────────────────────────────

let testKeyCounter = 0;
/** Returns a unique posKey per test to isolate in-memory state. */
function uniqueKey(): string {
  return `test-${Date.now()}-${++testKeyCounter}`;
}

/** Minimal analytics stub with a controllable netROIPercent. */
function makeAnalytics(netROIPercent: number): RebalanceAnalytics {
  const snap = {
    timestamp: Date.now(),
    tokenId: 1,
    liquidity: 1n,
    tickLower: -300,
    tickUpper: 300,
    amount0: 1_000_000_000_000_000_000n,
    amount1: 1_000_000_000_000_000_000n,
    currentTick: 0,
    sqrtPriceX96: 1n,
    poolLiquidity: 1n,
    isInRange: true,
    tickDistance: 0,
    tokensOwed0: 0n,
    tokensOwed1: 0n,
    token0Symbol: 'T0',
    token1Symbol: 'T1',
    token0Decimals: 18,
    token1Decimals: 18,
    poolFee: 2500,
    priceUsd0: 0,
    priceUsd1: 0,
    nativePriceUsd: 0,
    positionValueUsd: 0,
    unclaimedFeesUsd: 0,
  };
  return {
    timestamp: Date.now(),
    rebalanceId: 'test',
    oldTokenId: 1,
    newTokenId: 2,
    strategy: 'pulse',
    preSnapshot: snap,
    postSnapshot: snap,
    txHashes: { collectFees: '0x', decreaseLiquidity: '0x', collectTokens: '0x', burn: '0x', mint: '0x' },
    feesCollected0: 0n,
    feesCollected1: 0n,
    liquidityRemoved0: 0n,
    liquidityRemoved1: 0n,
    newLiquidity: 0n,
    newAmount0: 0n,
    newAmount1: 0n,
    newTickLower: -300,
    newTickUpper: 300,
    gasUsed: { collectFees: 0n, decreaseLiquidity: 0n, collectTokens: 0n, burn: 0n, swap: 0n, approvals: 0n, mint: 0n, total: 0n },
    gasPrice: 0n,
    totalGasCostPLS: 0,
    metrics: {
      durationSeconds: 86400,
      durationDays: 1,
      feeAPR: 0,
      rawFeeYieldPercent: 0,
      capitalEfficiencyRatio: 0,
      timeInRangePercent: 100,
      feesToCostRatio: 0,
      impermanentLossPercent: 0,
      netROIPercent,
      trueNetROIPercent: 0,
      rebalanceCostPercent: 0,
      rebalanceCostToken0: 0,
    },
  };
}

const DEFAULT_PARAMS: KillSwitchParams = {
  max_loss_percent: -5,
  max_consecutive_losses: 3,
  loss_window_hours: 24,
  min_hodl_ratio: undefined,
};

// ── isKillSwitchTriggered — initial state ────────────────────────────────────

describe('isKillSwitchTriggered', () => {
  it('returns false for unknown posKey (no entry yet)', () => {
    expect(isKillSwitchTriggered(uniqueKey())).toBe(false);
  });

  it('returns false after evaluating a non-loss rebalance', () => {
    const key = uniqueKey();
    evaluateKillSwitch(key, makeAnalytics(1.0), DEFAULT_PARAMS, 1000);
    expect(isKillSwitchTriggered(key)).toBe(false);
  });
});

// ── getKillSwitchStatus ───────────────────────────────────────────────────────

describe('getKillSwitchStatus', () => {
  it('returns null for unknown posKey', () => {
    expect(getKillSwitchStatus(uniqueKey())).toBeNull();
  });

  it('returns status after first evaluation', () => {
    const key = uniqueKey();
    evaluateKillSwitch(key, makeAnalytics(0), DEFAULT_PARAMS, 1000);
    const status = getKillSwitchStatus(key);
    expect(status).not.toBeNull();
    expect(typeof status!.disabled).toBe('boolean');
    expect(typeof status!.consecutiveLosses).toBe('number');
  });
});

// ── evaluateKillSwitch — params=undefined ────────────────────────────────────

describe('evaluateKillSwitch — no params', () => {
  it('returns triggered=false immediately when params is undefined', () => {
    const result = evaluateKillSwitch(uniqueKey(), makeAnalytics(-99), undefined, 1000);
    expect(result.triggered).toBe(false);
  });
});

// ── evaluateKillSwitch — consecutive loss counting ───────────────────────────

describe('evaluateKillSwitch — consecutive losses', () => {
  it('increments consecutiveLosses for each loss', () => {
    const key = uniqueKey();
    const params: KillSwitchParams = { max_loss_percent: -5, max_consecutive_losses: 5 };

    evaluateKillSwitch(key, makeAnalytics(-10), params, 1000);
    expect(getKillSwitchStatus(key)!.consecutiveLosses).toBe(1);

    evaluateKillSwitch(key, makeAnalytics(-10), params, 1000);
    expect(getKillSwitchStatus(key)!.consecutiveLosses).toBe(2);
  });

  it('resets consecutiveLosses to 0 on a non-loss rebalance', () => {
    const key = uniqueKey();
    const params: KillSwitchParams = { max_loss_percent: -5, max_consecutive_losses: 5 };

    evaluateKillSwitch(key, makeAnalytics(-10), params, 1000);
    evaluateKillSwitch(key, makeAnalytics(-10), params, 1000);
    expect(getKillSwitchStatus(key)!.consecutiveLosses).toBe(2);

    // Non-loss resets the counter
    evaluateKillSwitch(key, makeAnalytics(1.0), params, 1000);
    expect(getKillSwitchStatus(key)!.consecutiveLosses).toBe(0);
    expect(isKillSwitchTriggered(key)).toBe(false);
  });

  it('triggers kill switch after max_consecutive_losses', () => {
    const key = uniqueKey();
    const params: KillSwitchParams = { max_loss_percent: -5, max_consecutive_losses: 3 };

    const r1 = evaluateKillSwitch(key, makeAnalytics(-10), params, 1000);
    expect(r1.triggered).toBe(false);

    const r2 = evaluateKillSwitch(key, makeAnalytics(-10), params, 1000);
    expect(r2.triggered).toBe(false);

    const r3 = evaluateKillSwitch(key, makeAnalytics(-10), params, 1000);
    expect(r3.triggered).toBe(true);
    expect(r3.reason).toBeDefined();
    expect(r3.reason).toContain('3 consecutive');
    expect(isKillSwitchTriggered(key)).toBe(true);
  });

  it('uses default max_consecutive_losses=3 when not specified', () => {
    const key = uniqueKey();
    const params: KillSwitchParams = { max_loss_percent: -5 }; // no max_consecutive_losses

    evaluateKillSwitch(key, makeAnalytics(-10), params, 1000);
    evaluateKillSwitch(key, makeAnalytics(-10), params, 1000);
    const r3 = evaluateKillSwitch(key, makeAnalytics(-10), params, 1000);
    expect(r3.triggered).toBe(true);
  });

  it('does NOT trigger if ROI exactly equals max_loss_percent (must be strictly below)', () => {
    const key = uniqueKey();
    const params: KillSwitchParams = { max_loss_percent: -5, max_consecutive_losses: 1 };
    // ROI = -5% which equals the threshold — should NOT count as a loss
    const result = evaluateKillSwitch(key, makeAnalytics(-5), params, 1000);
    expect(result.triggered).toBe(false);
    expect(getKillSwitchStatus(key)!.consecutiveLosses).toBe(0);
  });

  it('triggers if ROI is strictly below max_loss_percent', () => {
    const key = uniqueKey();
    const params: KillSwitchParams = { max_loss_percent: -5, max_consecutive_losses: 1 };
    const result = evaluateKillSwitch(key, makeAnalytics(-5.1), params, 1000);
    expect(result.triggered).toBe(true);
  });
});

// ── evaluateKillSwitch — HODL ratio ─────────────────────────────────────────

describe('evaluateKillSwitch — HODL ratio', () => {
  it('triggers when position value drops below min_hodl_ratio of initial', () => {
    const key = uniqueKey();
    const params: KillSwitchParams = { min_hodl_ratio: 0.85, max_consecutive_losses: 999 };

    // First call establishes initialValueUsd = 1000
    evaluateKillSwitch(key, makeAnalytics(0), params, 1000);

    // Second call: value is 800 → ratio = 0.8 < 0.85 → trigger
    const result = evaluateKillSwitch(key, makeAnalytics(0), params, 800);
    expect(result.triggered).toBe(true);
    expect(result.reason).toContain('HODL ratio');
  });

  it('does NOT trigger when HODL ratio is above minimum', () => {
    const key = uniqueKey();
    const params: KillSwitchParams = { min_hodl_ratio: 0.85, max_consecutive_losses: 999 };

    evaluateKillSwitch(key, makeAnalytics(0), params, 1000);
    // Value stayed at 900 → ratio = 0.9 >= 0.85 → no trigger
    const result = evaluateKillSwitch(key, makeAnalytics(0), params, 900);
    expect(result.triggered).toBe(false);
  });

  it('does NOT check HODL ratio on first call (initial value just set)', () => {
    const key = uniqueKey();
    const params: KillSwitchParams = { min_hodl_ratio: 0.99, max_consecutive_losses: 999 };
    // Even with ratio=1.0 (same value), first call should set initial, not trigger
    const result = evaluateKillSwitch(key, makeAnalytics(0), params, 100);
    expect(result.triggered).toBe(false);
  });

  it('does NOT trigger when min_hodl_ratio is undefined', () => {
    const key = uniqueKey();
    const params: KillSwitchParams = { max_consecutive_losses: 999 }; // no min_hodl_ratio

    evaluateKillSwitch(key, makeAnalytics(0), params, 1000);
    const result = evaluateKillSwitch(key, makeAnalytics(0), params, 1); // tiny value
    expect(result.triggered).toBe(false);
  });
});

// ── resetKillSwitch ──────────────────────────────────────────────────────────

describe('resetKillSwitch', () => {
  it('clears disabled flag after kill switch triggered', () => {
    const key = uniqueKey();
    const params: KillSwitchParams = { max_loss_percent: -5, max_consecutive_losses: 1 };

    evaluateKillSwitch(key, makeAnalytics(-10), params, 1000);
    expect(isKillSwitchTriggered(key)).toBe(true);

    resetKillSwitch(key);
    expect(isKillSwitchTriggered(key)).toBe(false);
  });

  it('resets consecutiveLosses to 0', () => {
    const key = uniqueKey();
    const params: KillSwitchParams = { max_loss_percent: -5, max_consecutive_losses: 5 };

    evaluateKillSwitch(key, makeAnalytics(-10), params, 1000);
    evaluateKillSwitch(key, makeAnalytics(-10), params, 1000);
    expect(getKillSwitchStatus(key)!.consecutiveLosses).toBe(2);

    resetKillSwitch(key);
    expect(getKillSwitchStatus(key)!.consecutiveLosses).toBe(0);
  });

  it('clears reason and disabledAt fields', () => {
    const key = uniqueKey();
    const params: KillSwitchParams = { max_loss_percent: -5, max_consecutive_losses: 1 };

    evaluateKillSwitch(key, makeAnalytics(-10), params, 1000);
    expect(getKillSwitchStatus(key)!.reason).toBeDefined();

    resetKillSwitch(key);
    const status = getKillSwitchStatus(key);
    expect(status!.reason).toBeUndefined();
    expect(status!.disabledAt).toBeUndefined();
  });

  it('does nothing for unknown posKey (no error)', () => {
    expect(() => resetKillSwitch(uniqueKey())).not.toThrow();
  });

  it('allows new evaluations to succeed normally after reset', () => {
    const key = uniqueKey();
    const params: KillSwitchParams = { max_loss_percent: -5, max_consecutive_losses: 1 };

    evaluateKillSwitch(key, makeAnalytics(-10), params, 1000);
    expect(isKillSwitchTriggered(key)).toBe(true);

    resetKillSwitch(key);

    // After reset, non-loss should not re-trigger
    const result = evaluateKillSwitch(key, makeAnalytics(1.0), params, 1000);
    expect(result.triggered).toBe(false);
    expect(isKillSwitchTriggered(key)).toBe(false);
  });

  // Remove test-* entries written to the production state file during this test run.
  // This prevents test artifacts from polluting the bot's kill switch state on disk.
  afterAll(() => {
    const stateFile = resolve(process.cwd(), '.kill-switch-state.json');
    if (!existsSync(stateFile)) return;
    try {
      const raw = JSON.parse(readFileSync(stateFile, 'utf-8')) as { positions?: Record<string, unknown> };
      if (!raw.positions) return;
      const cleaned = Object.fromEntries(
        Object.entries(raw.positions).filter(([k]) => !k.startsWith('test-')),
      );
      writeFileSync(stateFile, JSON.stringify({ ...raw, positions: cleaned }, null, 2));
    } catch {
      // Non-fatal — worst case the file stays polluted until next run
    }
  });
});

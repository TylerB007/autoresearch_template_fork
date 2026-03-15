/**
 * Unit tests for src/strategy.ts — strategy evaluation engine.
 * Tests parseStrategy() parsing and evaluateStrategy() for all 6 strategy branches.
 * No mocks required — pure logic only.
 */
import { describe, it, expect } from 'vitest';
import { parseStrategy, evaluateStrategy } from './strategy.js';
import { percentageToTicks } from './math.js';
import type { PositionStatus, PositionConfig } from './types.js';

// ── Helpers ─────────────────────────────────────────────────────────────────

function makeStatus(overrides: {
  currentTick?: number;
  tickLower?: number;
  tickUpper?: number;
  isInRange?: boolean;
  tickDistance?: number;
  liquidity?: bigint;
  tickSpacing?: number;
}): PositionStatus {
  const tickLower = overrides.tickLower ?? -300;
  const tickUpper = overrides.tickUpper ?? 300;
  const currentTick = overrides.currentTick ?? 0;
  const isInRange = overrides.isInRange ?? (currentTick >= tickLower && currentTick < tickUpper);
  const tickDistance = overrides.tickDistance ?? 0;

  return {
    position: {
      tokenId: 12345,
      nonce: 0n,
      operator: '0x0000000000000000000000000000000000000000',
      token0: '0x0000000000000000000000000000000000000002',
      token1: '0x0000000000000000000000000000000000000003',
      liquidity: overrides.liquidity ?? 1_000_000n,
      tickLower,
      tickUpper,
      fee: 2500,
      feeGrowthInside0LastX128: 0n,
      feeGrowthInside1LastX128: 0n,
      tokensOwed0: 0n,
      tokensOwed1: 0n,
    },
    pool: {
      address: '0x0000000000000000000000000000000000000001',
      token0: '0x0000000000000000000000000000000000000002',
      token1: '0x0000000000000000000000000000000000000003',
      fee: 2500,
      tickSpacing: overrides.tickSpacing ?? 50,
      sqrtPriceX96: 1n,
      currentTick,
      liquidity: 1_000_000n,
    },
    isInRange,
    tickDistance,
    token0Info: { address: '0x0000000000000000000000000000000000000002', symbol: 'TOKEN0', name: 'Token0', decimals: 18 },
    token1Info: { address: '0x0000000000000000000000000000000000000003', symbol: 'TOKEN1', name: 'Token1', decimals: 18 },
    amount0: 1_000_000_000_000_000_000n,
    amount1: 1_000_000_000_000_000_000n,
    unclaimedFees0: 0n,
    unclaimedFees1: 0n,
  };
}

function makeConfig(strategy: string, params: Partial<PositionConfig['params']> = {}): PositionConfig {
  return {
    token_id: 12345,
    strategy: strategy as PositionConfig['strategy'],
    params: {
      width_ticks: 600,
      trigger_distance_ticks: 50,
      ...params,
    },
  };
}

// ── parseStrategy ────────────────────────────────────────────────────────────

describe('parseStrategy', () => {
  it('returns base=strategy and presetWidth=null for plain strategy names', () => {
    expect(parseStrategy('pulse')).toEqual({ base: 'pulse', presetWidth: null });
    expect(parseStrategy('center')).toEqual({ base: 'center', presetWidth: null });
    expect(parseStrategy('static')).toEqual({ base: 'static', presetWidth: null });
    expect(parseStrategy('snuggle_up')).toEqual({ base: 'snuggle_up', presetWidth: null });
    expect(parseStrategy('lazy_ascending')).toEqual({ base: 'lazy_ascending', presetWidth: null });
  });

  it('parses tick-based presets (e.g. pulse_300)', () => {
    expect(parseStrategy('pulse_300')).toEqual({ base: 'pulse', presetWidth: 300 });
    expect(parseStrategy('pulse_600')).toEqual({ base: 'pulse', presetWidth: 600 });
    expect(parseStrategy('center_300')).toEqual({ base: 'center', presetWidth: 300 });
    expect(parseStrategy('snuggle_up_400')).toEqual({ base: 'snuggle_up', presetWidth: 400 });
  });

  it('parses percentage presets (e.g. center_3pct) and converts via percentageToTicks', () => {
    const { base, presetWidth } = parseStrategy('center_3pct');
    expect(base).toBe('center');
    expect(presetWidth).toBe(percentageToTicks(3));

    const { base: b2, presetWidth: pw2 } = parseStrategy('bullish_6pct');
    expect(b2).toBe('bullish');
    expect(pw2).toBe(percentageToTicks(6));
  });

  it('correctly identifies pct vs tick suffix', () => {
    const tick = parseStrategy('pulse_100');
    const pct = parseStrategy('pulse_100pct');
    // tick-based: presetWidth = 100 exactly
    expect(tick.presetWidth).toBe(100);
    // pct-based: presetWidth = percentageToTicks(100) >> 100
    expect(pct.presetWidth).toBeGreaterThan(100);
  });

  it('handles multi-word base names with underscore (lazy_ascending)', () => {
    const result = parseStrategy('lazy_ascending_300');
    expect(result.base).toBe('lazy_ascending');
    expect(result.presetWidth).toBe(300);
  });

  it('handles new alias names with pct suffix', () => {
    const result = parseStrategy('bearish_6pct');
    expect(result.base).toBe('bearish');
    expect(result.presetWidth).toBe(percentageToTicks(6));
  });
});

// ── zero liquidity guard ────────────────────────────────────────────────────

describe('evaluateStrategy — zero liquidity guard', () => {
  it('returns shouldRebalance=false for zero liquidity regardless of strategy', () => {
    const status = makeStatus({ liquidity: 0n, isInRange: false, tickDistance: 999 });
    const config = makeConfig('pulse');
    const result = evaluateStrategy(status, config);
    expect(result.shouldRebalance).toBe(false);
    expect(result.reason).toContain('zero liquidity');
  });
});

// ── STATIC strategy ──────────────────────────────────────────────────────────

describe('evaluateStrategy — static', () => {
  it('never rebalances when in range', () => {
    const status = makeStatus({ currentTick: 0, tickLower: -300, tickUpper: 300, isInRange: true, tickDistance: 0 });
    const result = evaluateStrategy(status, makeConfig('static'));
    expect(result.shouldRebalance).toBe(false);
    expect(result.reason).toContain('Static');
    expect(result.reason).toContain('in range');
  });

  it('never rebalances when out of range', () => {
    const status = makeStatus({ currentTick: 500, tickLower: -300, tickUpper: 300, isInRange: false, tickDistance: 200 });
    const result = evaluateStrategy(status, makeConfig('static'));
    expect(result.shouldRebalance).toBe(false);
    expect(result.reason).toContain('Manual action required');
  });
});

// ── PULSE / CENTER strategy ──────────────────────────────────────────────────

describe('evaluateStrategy — pulse (center)', () => {
  it('does NOT rebalance when in range', () => {
    const status = makeStatus({ currentTick: 0, tickLower: -300, tickUpper: 300, isInRange: true, tickDistance: 0 });
    const result = evaluateStrategy(status, makeConfig('pulse'));
    expect(result.shouldRebalance).toBe(false);
    expect(result.reason).toContain('in range');
  });

  it('does NOT rebalance when out of range but below trigger distance', () => {
    const status = makeStatus({ currentTick: 350, tickLower: -300, tickUpper: 300, isInRange: false, tickDistance: 30 });
    const config = makeConfig('pulse', { trigger_distance_ticks: 50 });
    const result = evaluateStrategy(status, config);
    expect(result.shouldRebalance).toBe(false);
    expect(result.reason).toContain('30 ticks out of range');
  });

  it('rebalances when out of range and beyond trigger distance', () => {
    const status = makeStatus({ currentTick: 400, tickLower: -300, tickUpper: 300, isInRange: false, tickDistance: 100 });
    const config = makeConfig('pulse', { width_ticks: 600, trigger_distance_ticks: 50 });
    const result = evaluateStrategy(status, config);
    expect(result.shouldRebalance).toBe(true);
    expect(result.newTickLower).toBeDefined();
    expect(result.newTickUpper).toBeDefined();
  });

  it('centers the new range on currentTick', () => {
    const currentTick = 500;
    const status = makeStatus({ currentTick, tickLower: -300, tickUpper: 300, isInRange: false, tickDistance: 200 });
    const config = makeConfig('pulse', { width_ticks: 600, trigger_distance_ticks: 50 });
    const result = evaluateStrategy(status, config);
    expect(result.shouldRebalance).toBe(true);
    // new range should straddle currentTick
    expect(result.newTickLower!).toBeLessThan(currentTick);
    expect(result.newTickUpper!).toBeGreaterThan(currentTick);
  });

  it('new range snaps to tick spacing grid', () => {
    const status = makeStatus({ currentTick: 123, tickLower: -300, tickUpper: 300, isInRange: false, tickDistance: 100, tickSpacing: 50 });
    const config = makeConfig('pulse', { width_ticks: 600, trigger_distance_ticks: 50 });
    const result = evaluateStrategy(status, config);
    expect(result.newTickLower! % 50).toBeCloseTo(0, 10);
    expect(result.newTickUpper! % 50).toBeCloseTo(0, 10);
  });

  it('alias "center" resolves to pulse behavior', () => {
    const status = makeStatus({ currentTick: 400, tickLower: -300, tickUpper: 300, isInRange: false, tickDistance: 100 });
    const pulse = evaluateStrategy(status, makeConfig('pulse', { width_ticks: 600, trigger_distance_ticks: 50 }));
    const center = evaluateStrategy(status, makeConfig('center', { width_ticks: 600, trigger_distance_ticks: 50 }));
    expect(center.shouldRebalance).toBe(pulse.shouldRebalance);
    expect(center.newTickLower).toBe(pulse.newTickLower);
    expect(center.newTickUpper).toBe(pulse.newTickUpper);
  });

  it('preset width overrides config width_ticks', () => {
    const status = makeStatus({ currentTick: 500, tickLower: -300, tickUpper: 300, isInRange: false, tickDistance: 200 });
    const withPreset = evaluateStrategy(status, makeConfig('pulse_300', { width_ticks: 600, trigger_distance_ticks: 50 }));
    const withoutPreset = evaluateStrategy(status, makeConfig('pulse', { width_ticks: 300, trigger_distance_ticks: 50 }));
    // Both should produce the same range width (300 ticks)
    expect(withPreset.newTickUpper! - withPreset.newTickLower!).toBeCloseTo(
      withoutPreset.newTickUpper! - withoutPreset.newTickLower!, 1,
    );
  });
});

// ── LAZY ASCENDING / LAZY_UP strategy ───────────────────────────────────────

describe('evaluateStrategy — lazy_ascending (lazy_up)', () => {
  it('does NOT rebalance when price is below range (bearish move is ignored)', () => {
    // Price dropped below lower — lazy_ascending does NOT act on downward moves
    const status = makeStatus({ currentTick: -500, tickLower: -300, tickUpper: 300, isInRange: false, tickDistance: 200 });
    const result = evaluateStrategy(status, makeConfig('lazy_ascending', { trigger_distance_ticks: 50 }));
    expect(result.shouldRebalance).toBe(false);
    expect(result.reason).toContain('not above upper bound');
  });

  it('does NOT rebalance when in range', () => {
    const status = makeStatus({ currentTick: 0, tickLower: -300, tickUpper: 300, isInRange: true, tickDistance: 0 });
    const result = evaluateStrategy(status, makeConfig('lazy_ascending', { trigger_distance_ticks: 50 }));
    expect(result.shouldRebalance).toBe(false);
  });

  it('does NOT rebalance when above upper but below trigger distance', () => {
    const status = makeStatus({ currentTick: 320, tickLower: -300, tickUpper: 300, isInRange: false, tickDistance: 20 });
    const result = evaluateStrategy(status, makeConfig('lazy_ascending', { trigger_distance_ticks: 50 }));
    expect(result.shouldRebalance).toBe(false);
    expect(result.reason).toContain('20 ticks above upper');
  });

  it('rebalances when price rises above upper AND exceeds trigger', () => {
    const status = makeStatus({ currentTick: 500, tickLower: -300, tickUpper: 300, isInRange: false, tickDistance: 200 });
    const result = evaluateStrategy(status, makeConfig('lazy_ascending', { width_ticks: 600, trigger_distance_ticks: 50 }));
    expect(result.shouldRebalance).toBe(true);
    expect(result.newTickLower).toBeDefined();
    expect(result.newTickUpper).toBeDefined();
  });

  it('alias "lazy_up" resolves to lazy_ascending behavior', () => {
    const status = makeStatus({ currentTick: 500, tickLower: -300, tickUpper: 300, isInRange: false, tickDistance: 200 });
    const asc = evaluateStrategy(status, makeConfig('lazy_ascending', { width_ticks: 600, trigger_distance_ticks: 50 }));
    const up = evaluateStrategy(status, makeConfig('lazy_up', { width_ticks: 600, trigger_distance_ticks: 50 }));
    expect(up.shouldRebalance).toBe(asc.shouldRebalance);
    expect(up.newTickLower).toBe(asc.newTickLower);
    expect(up.newTickUpper).toBe(asc.newTickUpper);
  });
});

// ── LAZY DESCENDING / LAZY_DOWN strategy ────────────────────────────────────

describe('evaluateStrategy — lazy_descending (lazy_down)', () => {
  it('does NOT rebalance when price is above range (bullish move is ignored)', () => {
    // Price rose above upper — lazy_descending does NOT act on upward moves
    const status = makeStatus({ currentTick: 500, tickLower: -300, tickUpper: 300, isInRange: false, tickDistance: 200 });
    const result = evaluateStrategy(status, makeConfig('lazy_descending', { trigger_distance_ticks: 50 }));
    expect(result.shouldRebalance).toBe(false);
    expect(result.reason).toContain('not below lower bound');
  });

  it('does NOT rebalance when in range', () => {
    const status = makeStatus({ currentTick: 0, tickLower: -300, tickUpper: 300, isInRange: true, tickDistance: 0 });
    const result = evaluateStrategy(status, makeConfig('lazy_descending', { trigger_distance_ticks: 50 }));
    expect(result.shouldRebalance).toBe(false);
  });

  it('does NOT rebalance when below lower but below trigger distance', () => {
    const status = makeStatus({ currentTick: -320, tickLower: -300, tickUpper: 300, isInRange: false, tickDistance: 20 });
    const result = evaluateStrategy(status, makeConfig('lazy_descending', { trigger_distance_ticks: 50 }));
    expect(result.shouldRebalance).toBe(false);
    expect(result.reason).toContain('20 ticks below lower');
  });

  it('rebalances when price drops below lower AND exceeds trigger', () => {
    const status = makeStatus({ currentTick: -500, tickLower: -300, tickUpper: 300, isInRange: false, tickDistance: 200 });
    const result = evaluateStrategy(status, makeConfig('lazy_descending', { width_ticks: 600, trigger_distance_ticks: 50 }));
    expect(result.shouldRebalance).toBe(true);
    expect(result.newTickLower).toBeDefined();
    expect(result.newTickUpper).toBeDefined();
  });

  it('alias "lazy_down" resolves to lazy_descending behavior', () => {
    const status = makeStatus({ currentTick: -500, tickLower: -300, tickUpper: 300, isInRange: false, tickDistance: 200 });
    const desc = evaluateStrategy(status, makeConfig('lazy_descending', { width_ticks: 600, trigger_distance_ticks: 50 }));
    const down = evaluateStrategy(status, makeConfig('lazy_down', { width_ticks: 600, trigger_distance_ticks: 50 }));
    expect(down.shouldRebalance).toBe(desc.shouldRebalance);
    expect(down.newTickLower).toBe(desc.newTickLower);
    expect(down.newTickUpper).toBe(desc.newTickUpper);
  });

  it('lazy_descending ignores upward price moves that lazy_ascending would act on', () => {
    // Confirm the two lazy strategies are directional opposites
    const upMove = makeStatus({ currentTick: 500, tickLower: -300, tickUpper: 300, isInRange: false, tickDistance: 200 });
    const downMove = makeStatus({ currentTick: -500, tickLower: -300, tickUpper: 300, isInRange: false, tickDistance: 200 });

    const ascUp = evaluateStrategy(upMove, makeConfig('lazy_ascending', { width_ticks: 600, trigger_distance_ticks: 50 }));
    const descUp = evaluateStrategy(upMove, makeConfig('lazy_descending', { trigger_distance_ticks: 50 }));
    const ascDown = evaluateStrategy(downMove, makeConfig('lazy_ascending', { trigger_distance_ticks: 50 }));
    const descDown = evaluateStrategy(downMove, makeConfig('lazy_descending', { width_ticks: 600, trigger_distance_ticks: 50 }));

    expect(ascUp.shouldRebalance).toBe(true);
    expect(descUp.shouldRebalance).toBe(false);
    expect(ascDown.shouldRebalance).toBe(false);
    expect(descDown.shouldRebalance).toBe(true);
  });
});

// ── SNUGGLE UP / BULLISH strategy ───────────────────────────────────────────

describe('evaluateStrategy — snuggle_up (bullish)', () => {
  it('does NOT rebalance when in range', () => {
    const status = makeStatus({ currentTick: 0, tickLower: -300, tickUpper: 300, isInRange: true, tickDistance: 0 });
    const result = evaluateStrategy(status, makeConfig('snuggle_up', { trigger_distance_ticks: 50 }));
    expect(result.shouldRebalance).toBe(false);
  });

  it('does NOT rebalance when below trigger distance', () => {
    const status = makeStatus({ currentTick: 330, tickLower: -300, tickUpper: 300, isInRange: false, tickDistance: 30 });
    const result = evaluateStrategy(status, makeConfig('snuggle_up', { trigger_distance_ticks: 50 }));
    expect(result.shouldRebalance).toBe(false);
  });

  it('rebalances when out of range and beyond trigger', () => {
    const status = makeStatus({ currentTick: 400, tickLower: -300, tickUpper: 300, isInRange: false, tickDistance: 100 });
    const result = evaluateStrategy(status, makeConfig('snuggle_up', { width_ticks: 600, trigger_distance_ticks: 50 }));
    expect(result.shouldRebalance).toBe(true);
  });

  it('places more ticks above than below (default 30% lower / 70% upper)', () => {
    const currentTick = 400;
    const status = makeStatus({ currentTick, tickLower: -300, tickUpper: 300, isInRange: false, tickDistance: 100 });
    const result = evaluateStrategy(status, makeConfig('snuggle_up', { width_ticks: 600, trigger_distance_ticks: 50 }));
    expect(result.shouldRebalance).toBe(true);
    const lowerDist = currentTick - result.newTickLower!;
    const upperDist = result.newTickUpper! - currentTick;
    // Upper should be wider than lower (70% above, 30% below)
    expect(upperDist).toBeGreaterThan(lowerDist);
  });

  it('respects configurable lower_ratio_percent', () => {
    const currentTick = 400;
    const status = makeStatus({ currentTick, tickLower: -300, tickUpper: 300, isInRange: false, tickDistance: 100 });
    const result = evaluateStrategy(status, makeConfig('snuggle_up', { width_ticks: 600, trigger_distance_ticks: 50, lower_ratio_percent: 50 }));
    // 50/50 split — lower and upper distances should be approximately equal
    const lowerDist = currentTick - result.newTickLower!;
    const upperDist = result.newTickUpper! - currentTick;
    expect(Math.abs(lowerDist - upperDist)).toBeLessThan(55); // within one tick spacing
  });

  it('alias "bullish" resolves to snuggle_up behavior', () => {
    const status = makeStatus({ currentTick: 400, tickLower: -300, tickUpper: 300, isInRange: false, tickDistance: 100 });
    const snuggle = evaluateStrategy(status, makeConfig('snuggle_up', { width_ticks: 600, trigger_distance_ticks: 50 }));
    const bullish = evaluateStrategy(status, makeConfig('bullish', { width_ticks: 600, trigger_distance_ticks: 50 }));
    expect(bullish.shouldRebalance).toBe(snuggle.shouldRebalance);
    expect(bullish.newTickLower).toBe(snuggle.newTickLower);
    expect(bullish.newTickUpper).toBe(snuggle.newTickUpper);
  });
});

// ── SNUGGLE DOWN / BEARISH strategy ─────────────────────────────────────────

describe('evaluateStrategy — snuggle_down (bearish)', () => {
  it('does NOT rebalance when in range', () => {
    const status = makeStatus({ currentTick: 0, tickLower: -300, tickUpper: 300, isInRange: true, tickDistance: 0 });
    const result = evaluateStrategy(status, makeConfig('snuggle_down', { trigger_distance_ticks: 50 }));
    expect(result.shouldRebalance).toBe(false);
  });

  it('rebalances when out of range and beyond trigger', () => {
    const status = makeStatus({ currentTick: -400, tickLower: -300, tickUpper: 300, isInRange: false, tickDistance: 100 });
    const result = evaluateStrategy(status, makeConfig('snuggle_down', { width_ticks: 600, trigger_distance_ticks: 50 }));
    expect(result.shouldRebalance).toBe(true);
  });

  it('places more ticks below than above (default 70% lower / 30% upper)', () => {
    const currentTick = -400;
    const status = makeStatus({ currentTick, tickLower: -300, tickUpper: 300, isInRange: false, tickDistance: 100 });
    const result = evaluateStrategy(status, makeConfig('snuggle_down', { width_ticks: 600, trigger_distance_ticks: 50 }));
    expect(result.shouldRebalance).toBe(true);
    const lowerDist = currentTick - result.newTickLower!;
    const upperDist = result.newTickUpper! - currentTick;
    // Lower should be wider than upper (70% below, 30% above)
    expect(lowerDist).toBeGreaterThan(upperDist);
  });

  it('snuggle_down is the mirror of snuggle_up — lower/upper widths are swapped', () => {
    const currentTick = 0;
    const status = makeStatus({ currentTick, tickLower: -300, tickUpper: 300, isInRange: false, tickDistance: 100 });
    const up = evaluateStrategy(status, makeConfig('snuggle_up', { width_ticks: 600, trigger_distance_ticks: 50 }));
    const down = evaluateStrategy(status, makeConfig('snuggle_down', { width_ticks: 600, trigger_distance_ticks: 50 }));
    // The lower dist of snuggle_up should equal the upper dist of snuggle_down (and vice versa)
    const upLower = currentTick - up.newTickLower!;
    const upUpper = up.newTickUpper! - currentTick;
    const downLower = currentTick - down.newTickLower!;
    const downUpper = down.newTickUpper! - currentTick;
    expect(upLower).toBe(downUpper);
    expect(upUpper).toBe(downLower);
  });

  it('alias "bearish" resolves to snuggle_down behavior', () => {
    const status = makeStatus({ currentTick: -400, tickLower: -300, tickUpper: 300, isInRange: false, tickDistance: 100 });
    const snuggle = evaluateStrategy(status, makeConfig('snuggle_down', { width_ticks: 600, trigger_distance_ticks: 50 }));
    const bearish = evaluateStrategy(status, makeConfig('bearish', { width_ticks: 600, trigger_distance_ticks: 50 }));
    expect(bearish.shouldRebalance).toBe(snuggle.shouldRebalance);
    expect(bearish.newTickLower).toBe(snuggle.newTickLower);
    expect(bearish.newTickUpper).toBe(snuggle.newTickUpper);
  });
});

// ── Unknown strategy ─────────────────────────────────────────────────────────

describe('evaluateStrategy — unknown strategy', () => {
  it('throws for an unknown strategy name', () => {
    const status = makeStatus({ isInRange: false, tickDistance: 999 });
    const config = makeConfig('totally_unknown_strategy_xyz');
    expect(() => evaluateStrategy(status, config)).toThrow('Unknown strategy');
  });
});

/**
 * Multi-chain verification tests — validates chain registry, fee tiers,
 * tick spacing, and helper functions across all supported DEXes.
 */
import { describe, it, expect } from 'vitest';
import {
  CHAIN_REGISTRY,
  getChainConfig,
  getTickSpacingForChain,
  getDexConfig,
  getSupportedDexes,
  getSupportedChainIds,
} from './config/chains.js';
import { nearestUsableTick, percentageToTicks, ticksToPercentage } from './math.js';

// ── CHAIN_REGISTRY completeness ──────────────────────────────────────────────

describe('CHAIN_REGISTRY completeness', () => {
  const chainIds = getSupportedChainIds();

  it('has at least 5 chains registered', () => {
    expect(chainIds.length).toBeGreaterThanOrEqual(5);
  });

  it.each(chainIds)('chain %i has all required fields', (chainId) => {
    const entry = CHAIN_REGISTRY[chainId];
    expect(entry.chainId).toBe(chainId);
    expect(entry.chainName).toBeTruthy();
    expect(entry.protocolName).toBeTruthy();
    expect(entry.rpcUrls.length).toBeGreaterThan(0);
    expect(entry.blockExplorerUrl).toMatch(/^https?:\/\//);
    expect(entry.nativeCurrencySymbol).toBeTruthy();
    expect(entry.blockTimeSeconds).toBeGreaterThan(0);
    expect(entry.dexScreenerSlug).toBeTruthy();
    expect(entry.wrappedNativeAddress).toMatch(/^0x[0-9a-fA-F]{40}$/);
    expect(['pancakeswap-v3', 'uniswap-v3', 'aerodrome-cl', 'algebra-v3']).toContain(entry.swapRouterType);
    expect(Object.keys(entry.feeTiers).length).toBeGreaterThan(0);
    expect(Object.keys(entry.tokens).length).toBeGreaterThan(0);
    expect(entry.contracts.nonfungiblePositionManager).toMatch(/^0x[0-9a-fA-F]{40}$/);
    expect(entry.contracts.swapRouter).toMatch(/^0x[0-9a-fA-F]{40}$/);
    expect(entry.contracts.factory).toMatch(/^0x[0-9a-fA-F]{40}$/);
    expect(entry.contracts.quoter).toMatch(/^0x[0-9a-fA-F]{40}$/);
  });
});

// ── PulseChain / 9mm V3 ─────────────────────────────────────────────────────

describe('PulseChain (369) — 9mm V3', () => {
  const chain = getChainConfig(369);

  it('uses PancakeSwap V3 router type', () => {
    expect(chain.swapRouterType).toBe('pancakeswap-v3');
  });

  it('MEDIUM tier is 2500 (0.25%) with tick spacing 50', () => {
    expect(chain.feeTiers[2500]).toBe(50);
  });

  it('does NOT have Uniswap 3000 fee tier', () => {
    expect(chain.feeTiers[3000]).toBeUndefined();
  });

  it('has Piteas aggregator', () => {
    expect(chain.aggregators.piteas).toBeTruthy();
  });

  it('WPLS is wrapped native token', () => {
    expect(chain.wrappedNativeAddress).toBe(chain.tokens.WPLS);
  });

  it('nearestUsableTick aligns to tick spacing 50', () => {
    expect(nearestUsableTick(123, 50)).toBe(100);
    expect(nearestUsableTick(149, 50)).toBe(150);
    expect(nearestUsableTick(-73, 50)).toBe(-50);
  });
});

// ── Ethereum / Uniswap V3 ───────────────────────────────────────────────────

describe('Ethereum (1) — Uniswap V3', () => {
  const chain = getChainConfig(1);

  it('uses Uniswap V3 router type', () => {
    expect(chain.swapRouterType).toBe('uniswap-v3');
  });

  it('MEDIUM tier is 3000 (0.30%) with tick spacing 60', () => {
    expect(chain.feeTiers[3000]).toBe(60);
  });

  it('does NOT have 9mm 2500 fee tier', () => {
    expect(chain.feeTiers[2500]).toBeUndefined();
  });

  it('has 1inch aggregator', () => {
    expect(chain.aggregators.oneinch).toBeTruthy();
  });

  it('WETH is wrapped native token', () => {
    expect(chain.wrappedNativeAddress).toBe(chain.tokens.WETH);
  });

  it('nearestUsableTick aligns to tick spacing 60', () => {
    expect(nearestUsableTick(123, 60)).toBe(120);
    expect(nearestUsableTick(150, 60)).toBe(180); // midpoint rounds up
    expect(nearestUsableTick(149, 60)).toBe(120);
  });
});

// ── Base / Aerodrome CL ─────────────────────────────────────────────────────

describe('Base (8453) — Uniswap V3 + Aerodrome CL', () => {
  const chain = getChainConfig(8453);

  it('default router is Uniswap V3', () => {
    expect(chain.swapRouterType).toBe('uniswap-v3');
  });

  it('has multiple DEXes registered', () => {
    const dexes = getSupportedDexes(8453);
    expect(dexes).toContain('uniswap-v3');
    expect(dexes).toContain('aerodrome-cl');
    expect(dexes).toContain('aerodrome-cl-gc');
  });

  it('Aerodrome CL uses tickSpacing as pool key (identity mapping)', () => {
    const aeroDex = getDexConfig(8453, 'aerodrome-cl');
    expect(aeroDex.swapRouterType).toBe('aerodrome-cl');
    // Identity: tickSpacing maps to itself
    expect(aeroDex.feeTiers[50]).toBe(50);
    expect(aeroDex.feeTiers[200]).toBe(200);
  });

  it('Gauge Caps deployment has different contract addresses', () => {
    const v1 = getDexConfig(8453, 'aerodrome-cl');
    const gc = getDexConfig(8453, 'aerodrome-cl-gc');
    expect(v1.contracts.nonfungiblePositionManager).not.toBe(gc.contracts.nonfungiblePositionManager);
    expect(v1.contracts.factory).not.toBe(gc.contracts.factory);
  });

  it('fallback to chain-level config when no dex specified', () => {
    const fallback = getDexConfig(8453);
    expect(fallback.protocolName).toBe('Uniswap V3');
    expect(fallback.swapRouterType).toBe('uniswap-v3');
  });
});

// ── Arbitrum / Multi-DEX ────────────────────────────────────────────────────

describe('Arbitrum One (42161) — Uniswap V3 + PancakeSwap V3', () => {
  const chain = getChainConfig(42161);

  it('default is Uniswap V3', () => {
    expect(chain.swapRouterType).toBe('uniswap-v3');
    expect(chain.feeTiers[3000]).toBe(60);
  });

  it('PancakeSwap V3 DEX uses 2500/50 MEDIUM tier', () => {
    const pcsDex = getDexConfig(42161, 'pancakeswap-v3');
    expect(pcsDex.swapRouterType).toBe('pancakeswap-v3');
    expect(pcsDex.feeTiers[2500]).toBe(50);
    expect(pcsDex.feeTiers[3000]).toBeUndefined();
  });

  it('Uniswap V3 DEX uses 3000/60 MEDIUM tier', () => {
    const uniDex = getDexConfig(42161, 'uniswap-v3');
    expect(uniDex.swapRouterType).toBe('uniswap-v3');
    expect(uniDex.feeTiers[3000]).toBe(60);
    expect(uniDex.feeTiers[2500]).toBeUndefined();
  });
});

// ── Sonic / Algebra V3 ──────────────────────────────────────────────────────

describe('Sonic (146) — Shadow V3 (Algebra V3)', () => {
  const chain = getChainConfig(146);

  it('uses Algebra V3 router type', () => {
    expect(chain.swapRouterType).toBe('algebra-v3');
  });

  it('uses tickSpacing as pool key like Aerodrome CL', () => {
    expect(chain.feeTiers[50]).toBe(50);
    expect(chain.feeTiers[200]).toBe(200);
  });

  it('has no aggregators', () => {
    expect(chain.aggregators.piteas).toBeFalsy();
    expect(chain.aggregators.oneinch).toBeFalsy();
  });

  it('wS (wrapped Sonic) is native token', () => {
    expect(chain.nativeCurrencySymbol).toBe('S');
    expect(chain.wrappedNativeAddress).toBe(chain.tokens.WS);
  });

  it('DexScreener slug is sonic', () => {
    expect(chain.dexScreenerSlug).toBe('sonic');
  });
});

// ── getTickSpacingForChain ──────────────────────────────────────────────────

describe('getTickSpacingForChain', () => {
  it('9mm MEDIUM: fee 2500 → spacing 50 on PulseChain', () => {
    expect(getTickSpacingForChain(2500, 369)).toBe(50);
  });

  it('Uniswap MEDIUM: fee 3000 → spacing 60 on Ethereum', () => {
    expect(getTickSpacingForChain(3000, 1)).toBe(60);
  });

  it('throws for unsupported fee tier on chain', () => {
    // 3000 is NOT valid on PulseChain
    expect(() => getTickSpacingForChain(3000, 369)).toThrow('Unsupported fee tier');
    // 2500 is NOT valid on Ethereum
    expect(() => getTickSpacingForChain(2500, 1)).toThrow('Unsupported fee tier');
  });

  it('throws for unsupported chain', () => {
    expect(() => getTickSpacingForChain(3000, 99999)).toThrow('Unsupported chain ID');
  });
});

// ── percentageToTicks / ticksToPercentage roundtrip ─────────────────────────

describe('percentageToTicks ↔ ticksToPercentage roundtrip', () => {
  it.each([1, 2, 3, 5, 6, 10, 20, 50])('%d%% roundtrips within 0.01%%', (pct) => {
    const ticks = percentageToTicks(pct);
    const backPct = ticksToPercentage(ticks);
    expect(Math.abs(backPct - pct)).toBeLessThan(0.01);
  });

  it('6% ≈ 583 ticks (NOT 600 — exponential formula)', () => {
    const ticks = percentageToTicks(6);
    expect(ticks).toBe(583);
  });

  it('3% ≈ 296 ticks', () => {
    const ticks = percentageToTicks(3);
    expect(ticks).toBe(296);
  });

  it('0% returns 0 ticks', () => {
    expect(percentageToTicks(0)).toBe(0);
  });

  it('ticksToPercentage(50) ≈ 0.5% (one standard tick spacing)', () => {
    const pct = ticksToPercentage(50);
    expect(pct).toBeCloseTo(0.5, 1);
  });
});

/**
 * Unit tests for src/costBenefit.ts — pre-rebalance cost-benefit gate.
 * All pure logic, no mocks or network calls.
 */
import { describe, it, expect } from 'vitest';
import { evaluateCostBenefit, estimateFullRebalanceCost } from './costBenefit.js';

// ── estimateFullRebalanceCost ────────────────────────────────────────────────

describe('estimateFullRebalanceCost', () => {
  it('returns 0 for gasPrice=0n', () => {
    expect(estimateFullRebalanceCost(0n)).toBe(0);
  });

  it('returns a positive number for nonzero gasPrice', () => {
    const cost = estimateFullRebalanceCost(1_000_000_000n); // 1 gwei
    expect(cost).toBeGreaterThan(0);
  });

  it('scales linearly with gasPrice', () => {
    const cost1 = estimateFullRebalanceCost(1_000_000_000n);
    const cost2 = estimateFullRebalanceCost(2_000_000_000n);
    expect(cost2).toBeCloseTo(cost1 * 2, 10);
  });

  it('returns a number (not BigInt)', () => {
    expect(typeof estimateFullRebalanceCost(1n)).toBe('number');
  });
});

// ── evaluateCostBenefit ─────────────────────────────────────────────────────

const BASE_INPUT = {
  gasPrice: 1_000_000_000n, // 1 gwei
  unclaimedFees0: 100_000_000_000_000_000n, // 0.1 token0 (18 decimals)
  unclaimedFees1: 100_000_000_000_000_000n, // 0.1 token1 (18 decimals)
  decimals0: 18,
  decimals1: 18,
  priceUsd0: 10.0,  // $10 per token0 → fee0 = $1
  priceUsd1: 10.0,  // $10 per token1 → fee1 = $1 → total = $2
  nativePriceUsd: 0.001, // $0.001 per native token
  minFeeToCostRatio: 1.5,
};

describe('evaluateCostBenefit', () => {
  it('returns shouldProceed=true when ratio exceeds threshold', () => {
    // gas cost = 1e9 * 1e6 / 1e18 native = 0.001 native = $0.000001
    // fee value = $2.00 → ratio >> 1.5
    const result = evaluateCostBenefit(BASE_INPUT);
    expect(result.shouldProceed).toBe(true);
    expect(result.feeToCostRatio).toBeGreaterThan(1.5);
  });

  it('returns shouldProceed=false when ratio is below threshold', () => {
    const result = evaluateCostBenefit({
      ...BASE_INPUT,
      unclaimedFees0: 0n,    // no fees
      unclaimedFees1: 0n,
    });
    expect(result.shouldProceed).toBe(false);
    expect(result.feeToCostRatio).toBe(0);
  });

  it('returns shouldProceed=false when ratio barely misses threshold', () => {
    // Set fees to exactly 1.4x of gas cost
    const nativeCostNative = estimateFullRebalanceCost(BASE_INPUT.gasPrice);
    const nativeCostUsd = nativeCostNative * BASE_INPUT.nativePriceUsd;
    const targetFeeUsd = nativeCostUsd * 1.4; // ratio = 1.4 < 1.5 threshold

    // All fees in token0 (18 decimals, $10/token)
    const feeAmount0 = BigInt(Math.floor(targetFeeUsd / 10 * 1e18));

    const result = evaluateCostBenefit({
      ...BASE_INPUT,
      unclaimedFees0: feeAmount0,
      unclaimedFees1: 0n,
    });
    expect(result.shouldProceed).toBe(false);
    expect(result.feeToCostRatio).toBeLessThan(1.5);
  });

  it('returns shouldProceed=true when ratio just meets threshold', () => {
    // Set fees to exactly 1.6x of gas cost
    const nativeCostNative = estimateFullRebalanceCost(BASE_INPUT.gasPrice);
    const nativeCostUsd = nativeCostNative * BASE_INPUT.nativePriceUsd;
    const targetFeeUsd = nativeCostUsd * 1.6;

    const feeAmount0 = BigInt(Math.floor(targetFeeUsd / 10 * 1e18));

    const result = evaluateCostBenefit({
      ...BASE_INPUT,
      unclaimedFees0: feeAmount0,
      unclaimedFees1: 0n,
    });
    expect(result.shouldProceed).toBe(true);
    expect(result.feeToCostRatio).toBeGreaterThan(1.5);
  });

  it('fails open when nativePriceUsd is 0 (price unavailable)', () => {
    const result = evaluateCostBenefit({
      ...BASE_INPUT,
      nativePriceUsd: 0,
    });
    expect(result.shouldProceed).toBe(true);
    expect(result.reason).toContain('unavailable');
  });

  it('fails open when gasPrice is 0 (e.g., local test node)', () => {
    const result = evaluateCostBenefit({
      ...BASE_INPUT,
      gasPrice: 0n,
    });
    expect(result.shouldProceed).toBe(true);
  });

  it('fails open when both token prices are 0', () => {
    const result = evaluateCostBenefit({
      ...BASE_INPUT,
      priceUsd0: 0,
      priceUsd1: 0,
    });
    expect(result.shouldProceed).toBe(true);
    expect(result.reason).toContain('unavailable');
  });

  it('includes feeToCostRatio, estimatedGasCostUsd, unclaimedFeeValueUsd in result', () => {
    const result = evaluateCostBenefit(BASE_INPUT);
    expect(typeof result.feeToCostRatio).toBe('number');
    expect(typeof result.estimatedGasCostUsd).toBe('number');
    expect(typeof result.unclaimedFeeValueUsd).toBe('number');
    expect(result.unclaimedFeeValueUsd).toBeGreaterThan(0);
  });

  it('respects custom minFeeToCostRatio', () => {
    // Scenario: ratio ≈ 4.0x
    //   gasPrice = 1 gwei = 1e9 wei
    //   estimatedGasUnits = 1_000_000 (from costBenefit.ts constant)
    //   costNative = 1e9 * 1e6 / 1e18 = 0.001 native
    //   nativePriceUsd = 1000 → costUsd = $1.00
    //   unclaimedFees0 = 4 tokens at $1/token = $4 → ratio = 4.0x
    const testInput = {
      gasPrice: 1_000_000_000n,               // 1 gwei
      unclaimedFees0: 4_000_000_000_000_000_000n, // 4 tokens (18 dec, $1/token = $4)
      unclaimedFees1: 0n,
      decimals0: 18,
      decimals1: 18,
      priceUsd0: 1.0,
      priceUsd1: 1.0,
      nativePriceUsd: 1000.0, // $1000/native → gas cost = 0.001 * 1000 = $1.00
      minFeeToCostRatio: 1.5, // placeholder, overridden below
    };
    // threshold 5.0x → actual ratio 4.0x < 5.0x → should not proceed
    const resultStrict = evaluateCostBenefit({ ...testInput, minFeeToCostRatio: 5.0 });
    // threshold 3.0x → actual ratio 4.0x > 3.0x → should proceed
    const resultLax = evaluateCostBenefit({ ...testInput, minFeeToCostRatio: 3.0 });

    expect(resultStrict.shouldProceed).toBe(false);
    expect(resultLax.shouldProceed).toBe(true);
  });

  it('handles different token decimal precisions correctly', () => {
    // USDC has 6 decimals; 100 USDC at $1 = $100
    const result = evaluateCostBenefit({
      ...BASE_INPUT,
      unclaimedFees0: 100_000_000n, // 100 USDC (6 decimals)
      decimals0: 6,
      priceUsd0: 1.0,
      unclaimedFees1: 0n,
    });
    expect(result.shouldProceed).toBe(true);
    expect(result.unclaimedFeeValueUsd).toBeCloseTo(100, 1);
  });
});

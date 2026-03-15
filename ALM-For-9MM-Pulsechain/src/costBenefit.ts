/**
 * Cost-benefit analysis for pre-rebalance gate.
 *
 * Determines whether unclaimed fees are large enough relative to the
 * estimated gas cost of a full rebalance to make execution worthwhile.
 *
 * This module is opt-in: set `cost_benefit_enabled: true` in config.yaml
 * per position. When disabled (the default), this gate is a no-op and
 * every rebalance proceeds as before.
 *
 * All arithmetic is done in USD to avoid cross-token comparison issues.
 * If price data is unavailable the gate fails open (rebalance proceeds).
 */

import { bigintToFloat, bigintWeiToFloat } from './bigintFloat.js';

/** Estimated gas units for a full rebalance across all steps */
const FULL_REBALANCE_GAS_UNITS = 1_000_000n; // conservative worst-case

/**
 * Estimate the native-currency cost of a full rebalance given a gas price.
 * Returns a floating-point number (not BigInt) for ratio comparison.
 */
export function estimateFullRebalanceCost(gasPrice: bigint): number {
  const costWei = gasPrice * FULL_REBALANCE_GAS_UNITS;
  return bigintWeiToFloat(costWei);
}

export interface CostBenefitInput {
  /** Current gas price from provider.getFeeData(), in wei */
  gasPrice: bigint;
  /** Unclaimed fee amounts in token0 and token1 (raw on-chain units) */
  unclaimedFees0: bigint;
  unclaimedFees1: bigint;
  /** Token0 decimals */
  decimals0: number;
  /** Token1 decimals */
  decimals1: number;
  /** Token0 price in USD (0 if unavailable) */
  priceUsd0: number;
  /** Token1 price in USD (0 if unavailable) */
  priceUsd1: number;
  /** Native-currency price in USD (e.g. PLS/USD or ETH/USD; 0 if unavailable) */
  nativePriceUsd: number;
  /** Minimum ratio of fee value to gas cost required to proceed (default 1.5) */
  minFeeToCostRatio: number;
}

export interface CostBenefitResult {
  /** Whether to proceed with the rebalance */
  shouldProceed: boolean;
  /** Human-readable reason for the decision */
  reason: string;
  /** fee value / gas cost ratio (0 if data unavailable) */
  feeToCostRatio: number;
  /** Estimated gas cost in USD */
  estimatedGasCostUsd: number;
  /** Total unclaimed fee value in USD */
  unclaimedFeeValueUsd: number;
}

/**
 * Evaluate whether unclaimed fees justify the cost of rebalancing.
 *
 * Fails open (shouldProceed=true) when price data is unavailable —
 * we never block a rebalance due to missing price feeds.
 */
export function evaluateCostBenefit(input: CostBenefitInput): CostBenefitResult {
  const {
    gasPrice,
    unclaimedFees0,
    unclaimedFees1,
    decimals0,
    decimals1,
    priceUsd0,
    priceUsd1,
    nativePriceUsd,
    minFeeToCostRatio,
  } = input;

  // If price data is missing, fail open
  if (nativePriceUsd <= 0) {
    return {
      shouldProceed: true,
      reason: 'Skipping cost-benefit check: native token price unavailable',
      feeToCostRatio: 0,
      estimatedGasCostUsd: 0,
      unclaimedFeeValueUsd: 0,
    };
  }

  const estimatedGasCostNative = estimateFullRebalanceCost(gasPrice);
  const estimatedGasCostUsd = estimatedGasCostNative * nativePriceUsd;

  // If gas cost rounds to zero (e.g., gasPrice=0 on test networks), proceed freely
  if (estimatedGasCostUsd <= 0) {
    return {
      shouldProceed: true,
      reason: 'Cost-benefit check: gas cost is zero — proceeding',
      feeToCostRatio: Infinity,
      estimatedGasCostUsd: 0,
      unclaimedFeeValueUsd: 0,
    };
  }

  const feeValue0Usd = priceUsd0 > 0
    ? bigintToFloat(unclaimedFees0, decimals0) * priceUsd0
    : 0;
  const feeValue1Usd = priceUsd1 > 0
    ? bigintToFloat(unclaimedFees1, decimals1) * priceUsd1
    : 0;
  const unclaimedFeeValueUsd = feeValue0Usd + feeValue1Usd;

  // If both fee values are zero (either truly zero or prices unavailable for both tokens),
  // fail open only if price data is missing; otherwise it's a genuine zero-fee situation.
  if (unclaimedFeeValueUsd <= 0) {
    if (priceUsd0 <= 0 && priceUsd1 <= 0) {
      return {
        shouldProceed: true,
        reason: 'Skipping cost-benefit check: token prices unavailable',
        feeToCostRatio: 0,
        estimatedGasCostUsd,
        unclaimedFeeValueUsd: 0,
      };
    }
    // Both tokens have prices but fees are genuinely zero — not worth rebalancing
    return {
      shouldProceed: false,
      reason: `Cost-benefit: no unclaimed fees (gas would cost $${estimatedGasCostUsd.toFixed(4)})`,
      feeToCostRatio: 0,
      estimatedGasCostUsd,
      unclaimedFeeValueUsd: 0,
    };
  }

  const feeToCostRatio = unclaimedFeeValueUsd / estimatedGasCostUsd;

  if (feeToCostRatio < minFeeToCostRatio) {
    return {
      shouldProceed: false,
      reason:
        `Cost-benefit: fee/cost ratio ${feeToCostRatio.toFixed(2)}x < ${minFeeToCostRatio}x threshold ` +
        `(fees $${unclaimedFeeValueUsd.toFixed(4)} vs gas $${estimatedGasCostUsd.toFixed(4)})`,
      feeToCostRatio,
      estimatedGasCostUsd,
      unclaimedFeeValueUsd,
    };
  }

  return {
    shouldProceed: true,
    reason:
      `Cost-benefit: ratio ${feeToCostRatio.toFixed(2)}x >= ${minFeeToCostRatio}x ` +
      `(fees $${unclaimedFeeValueUsd.toFixed(4)} vs gas $${estimatedGasCostUsd.toFixed(4)})`,
    feeToCostRatio,
    estimatedGasCostUsd,
    unclaimedFeeValueUsd,
  };
}

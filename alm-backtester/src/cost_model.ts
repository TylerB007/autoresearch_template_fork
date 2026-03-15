/**
 * Cost model — gas costs and swap slippage for simulated rebalances.
 */

import type { BacktestConfig } from './types.js';

/**
 * Calculate the total cost of a rebalance in USD.
 *
 * @param config - Backtest configuration
 * @param swapAmountUsd - USD value of the swap portion
 * @returns Total cost in USD (gas + slippage)
 */
export function calculateRebalanceCost(
  config: BacktestConfig,
  swapAmountUsd: number,
): { gasCostUsd: number; slippageCostUsd: number; totalCostUsd: number } {
  const gasCostUsd = config.gas_cost_per_rebalance_usd;

  // Slippage as a percentage of swap amount
  const slippageCostUsd = swapAmountUsd * (config.slippage_bps / 10_000);

  return {
    gasCostUsd,
    slippageCostUsd,
    totalCostUsd: gasCostUsd + slippageCostUsd,
  };
}

/**
 * Apply slippage to a swap output amount.
 * Returns the actual output after slippage is deducted.
 */
export function applySlippage(theoreticalOutput: bigint, slippageBps: number): bigint {
  if (slippageBps <= 0) return theoreticalOutput;
  const slippageAmount = (theoreticalOutput * BigInt(slippageBps)) / 10_000n;
  return theoreticalOutput - slippageAmount;
}

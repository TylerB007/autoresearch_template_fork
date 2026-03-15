/**
 * Position lifecycle simulator — manages a single V3 position through
 * a simulated time series, handling fee accrual, rebalance decisions,
 * and position value tracking.
 */

import type { PriceTick, SimulationState, BacktestConfig } from './types.js';
import {
  tickToSqrtPriceX96,
  getAmountsForLiquidity,
  getLiquidityForAmounts,
  calculateSwapAmount,
  nearestUsableTick,
  bigintToFloat,
  evaluateStrategy,
} from './alm_bridge.js';
import { estimatePositionShare, calculateStepFees, feeUsdToToken0 } from './fee_model.js';
import { calculateRebalanceCost, applySlippage } from './cost_model.js';

/**
 * Initialize a new simulated position centered on the starting tick.
 */
export function initializePosition(
  startTick: number,
  config: BacktestConfig,
  startTimestamp: number,
): SimulationState {
  const halfWidth = Math.floor(config.width_ticks / 2);
  const tickLower = nearestUsableTick(startTick - halfWidth, config.tick_spacing);
  const tickUpper = nearestUsableTick(startTick + halfWidth, config.tick_spacing);

  const sqrtPrice = tickToSqrtPriceX96(startTick);
  const sqrtPriceA = tickToSqrtPriceX96(tickLower);
  const sqrtPriceB = tickToSqrtPriceX96(tickUpper);

  // Convert initial capital USD to token amounts
  // Assume token0 price = initial_price_token0_usd
  const capitalToken0 = config.initial_capital_usd / config.initial_price_token0_usd;
  const capitalToken0Raw = BigInt(Math.floor(capitalToken0 * 10 ** config.token0_decimals));

  // Calculate how much token1 we'd need for the ratio
  // Use a large reference liquidity to compute the target ratio
  const refLiq = 1n << 96n;
  const targetAmounts = getAmountsForLiquidity(sqrtPrice, sqrtPriceA, sqrtPriceB, refLiq);

  // Total value in token0 terms: amount0 + amount1/price
  const price = Math.pow(1.0001, startTick) * Math.pow(10, config.token0_decimals - config.token1_decimals);
  const targetValue0 = bigintToFloat(targetAmounts.amount0, config.token0_decimals);
  const targetValue1InToken0 = bigintToFloat(targetAmounts.amount1, config.token1_decimals) / price;
  const totalTargetInToken0 = targetValue0 + targetValue1InToken0;

  let amount0: bigint;
  let amount1: bigint;

  if (totalTargetInToken0 > 0) {
    const fraction0 = targetValue0 / totalTargetInToken0;
    const token0Value = capitalToken0 * fraction0;
    const token1ValueInToken0 = capitalToken0 * (1 - fraction0);
    amount0 = BigInt(Math.floor(token0Value * 10 ** config.token0_decimals));
    amount1 = BigInt(Math.floor(token1ValueInToken0 * price * 10 ** config.token1_decimals));
  } else {
    // Edge case: all one-sided
    amount0 = capitalToken0Raw;
    amount1 = 0n;
  }

  // Compute liquidity from these amounts
  const liquidity = getLiquidityForAmounts(sqrtPrice, sqrtPriceA, sqrtPriceB, amount0, amount1);

  // Get actual amounts from the liquidity (may differ slightly due to rounding)
  const actualAmounts = getAmountsForLiquidity(sqrtPrice, sqrtPriceA, sqrtPriceB, liquidity);

  const initialValue = bigintToFloat(actualAmounts.amount0, config.token0_decimals) +
    bigintToFloat(actualAmounts.amount1, config.token1_decimals) / price;

  return {
    tickLower,
    tickUpper,
    liquidity,
    amount0: actualAmounts.amount0,
    amount1: actualAmounts.amount1,
    totalFeesCollected0: 0n,
    totalFeesCollected1: 0n,
    pendingFees0: 0n,
    pendingFees1: 0n,
    rebalanceCount: 0,
    rebalanceTimestamps: [],
    oorSinceTimestamp: null,
    valueHistory: [{ timestamp: startTimestamp, valueToken0: initialValue }],
    totalSteps: 0,
    inRangeSteps: 0,
    initialValueToken0: initialValue,
  };
}

/**
 * Check if position is in range at the given tick.
 */
export function isInRange(state: SimulationState, currentTick: number): boolean {
  return currentTick >= state.tickLower && currentTick < state.tickUpper;
}

/**
 * Calculate tick distance from the range boundary.
 * Positive = out of range (ticks beyond boundary)
 * Negative = in range (ticks from nearest boundary)
 */
export function getTickDistance(state: SimulationState, currentTick: number): number {
  if (currentTick < state.tickLower) {
    return state.tickLower - currentTick;
  }
  if (currentTick >= state.tickUpper) {
    return currentTick - state.tickUpper;
  }
  // In range: negative distance (from nearest boundary)
  const distToLower = currentTick - state.tickLower;
  const distToUpper = state.tickUpper - currentTick;
  return -Math.min(distToLower, distToUpper);
}

/**
 * Get current position value in token0-equivalent terms.
 */
export function getPositionValue(
  state: SimulationState,
  currentTick: number,
  config: BacktestConfig,
): number {
  const sqrtPrice = tickToSqrtPriceX96(currentTick);
  const sqrtPriceA = tickToSqrtPriceX96(state.tickLower);
  const sqrtPriceB = tickToSqrtPriceX96(state.tickUpper);
  const amounts = getAmountsForLiquidity(sqrtPrice, sqrtPriceA, sqrtPriceB, state.liquidity);

  const price = Math.pow(1.0001, currentTick) * Math.pow(10, config.token0_decimals - config.token1_decimals);

  const val0 = bigintToFloat(amounts.amount0, config.token0_decimals);
  const val1 = bigintToFloat(amounts.amount1, config.token1_decimals) / (price || 1);

  // Include pending fees
  const fees0 = bigintToFloat(state.pendingFees0, config.token0_decimals);
  const fees1 = bigintToFloat(state.pendingFees1, config.token1_decimals) / (price || 1);

  return val0 + val1 + fees0 + fees1;
}

/**
 * Execute a simulated rebalance: remove liquidity, swap, mint new position.
 * Modifies state in place.
 */
export function executeRebalance(
  state: SimulationState,
  currentTick: number,
  newTickLower: number,
  newTickUpper: number,
  config: BacktestConfig,
  timestamp: number,
): { gasCostUsd: number; slippageCostUsd: number } {
  const sqrtPrice = tickToSqrtPriceX96(currentTick);
  const oldSqrtPriceA = tickToSqrtPriceX96(state.tickLower);
  const oldSqrtPriceB = tickToSqrtPriceX96(state.tickUpper);

  // Step 1: Remove liquidity — get token amounts back
  const removed = getAmountsForLiquidity(sqrtPrice, oldSqrtPriceA, oldSqrtPriceB, state.liquidity);

  // Step 2: Collect pending fees
  let total0 = removed.amount0 + state.pendingFees0;
  let total1 = removed.amount1 + state.pendingFees1;
  state.totalFeesCollected0 += state.pendingFees0;
  state.totalFeesCollected1 += state.pendingFees1;
  state.pendingFees0 = 0n;
  state.pendingFees1 = 0n;

  // Step 3: Calculate swap needed for new range
  const swapResult = calculateSwapAmount(
    total0,
    total1,
    currentTick,
    newTickLower,
    newTickUpper,
    config.pool_fee_bps,
  );

  // Estimate swap value in USD for cost calculation
  const price = Math.pow(1.0001, currentTick) * Math.pow(10, config.token0_decimals - config.token1_decimals);
  let swapValueUsd: number;
  if (swapResult.tokenIn === 'token0') {
    swapValueUsd = bigintToFloat(swapResult.amountIn, config.token0_decimals) * config.initial_price_token0_usd;
  } else {
    swapValueUsd = bigintToFloat(swapResult.amountIn, config.token1_decimals) * config.initial_price_token0_usd / price;
  }

  // Apply swap with fee + slippage
  if (swapResult.amountIn > 0n) {
    const feeDeduction = (swapResult.amountIn * BigInt(config.pool_fee_bps)) / 1_000_000n;
    const afterFee = swapResult.amountIn - feeDeduction;

    if (swapResult.tokenIn === 'token0') {
      total0 -= swapResult.amountIn;
      // Convert token0 to token1 using price, then apply slippage
      const sqrtPriceSq = sqrtPrice * sqrtPrice;
      const Q192 = 1n << 192n;
      let expectedOut = (afterFee * sqrtPriceSq) / Q192;
      expectedOut = applySlippage(expectedOut, config.slippage_bps);
      total1 += expectedOut;
    } else {
      total1 -= swapResult.amountIn;
      // Convert token1 to token0 using price, then apply slippage
      const sqrtPriceSq = sqrtPrice * sqrtPrice;
      const Q192 = 1n << 192n;
      let expectedOut = sqrtPriceSq > 0n ? (afterFee * Q192) / sqrtPriceSq : 0n;
      expectedOut = applySlippage(expectedOut, config.slippage_bps);
      total0 += expectedOut;
    }
  }

  // Step 4: Mint new position
  const newSqrtPriceA = tickToSqrtPriceX96(newTickLower);
  const newSqrtPriceB = tickToSqrtPriceX96(newTickUpper);
  const newLiquidity = getLiquidityForAmounts(sqrtPrice, newSqrtPriceA, newSqrtPriceB, total0, total1);
  const newAmounts = getAmountsForLiquidity(sqrtPrice, newSqrtPriceA, newSqrtPriceB, newLiquidity);

  // Update state
  state.tickLower = newTickLower;
  state.tickUpper = newTickUpper;
  state.liquidity = newLiquidity;
  state.amount0 = newAmounts.amount0;
  state.amount1 = newAmounts.amount1;
  state.rebalanceCount++;
  state.rebalanceTimestamps.push(timestamp);
  state.oorSinceTimestamp = null;

  // Calculate costs
  const costs = calculateRebalanceCost(config, swapValueUsd);
  return { gasCostUsd: costs.gasCostUsd, slippageCostUsd: costs.slippageCostUsd };
}

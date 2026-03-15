/**
 * Core simulation engine — replays price data through the strategy/simulator
 * and produces a SimulationResult.
 */

import type { PriceTick, SimulationState, SimulationResult, BacktestConfig } from './types.js';
import {
  initializePosition,
  isInRange,
  getTickDistance,
  getPositionValue,
  executeRebalance,
} from './simulator.js';
import { evaluateStrategy } from './alm_bridge.js';
import { estimatePositionShare, calculateStepFees, feeUsdToToken0 } from './fee_model.js';
import { calculateNetScore, calculateMaxDrawdown } from './scoring.js';

/**
 * Run a complete backtest simulation on a price data series.
 */
export function runSimulation(
  data: PriceTick[],
  config: BacktestConfig,
): SimulationResult {
  const startTime = performance.now();

  if (data.length === 0) {
    throw new Error('No price data provided');
  }

  // Initialize position at the first data point
  const state = initializePosition(data[0].tick, config, data[0].timestamp);
  const positionShare = estimatePositionShare(config.initial_capital_usd, config.pool_liquidity_usd);

  // Cost accumulators
  let totalGasCostsUsd = 0;
  let totalSlippageCostsUsd = 0;

  // Anti-churn tracking
  const churnWindowMs = config.churn_window_hours * 3600 * 1000;

  // Step interval (derived from data)
  const stepSeconds = data.length > 1
    ? Math.max(1, (data[data.length - 1].timestamp - data[0].timestamp) / (data.length - 1) / 1000)
    : 60;

  // Main simulation loop
  for (let i = 0; i < data.length; i++) {
    const tick = data[i];
    const inRange = isInRange(state, tick.tick);
    const tickDistance = getTickDistance(state, tick.tick);

    state.totalSteps++;
    if (inRange) {
      state.inRangeSteps++;
      state.oorSinceTimestamp = null;
    }

    // Fee accrual (only when in range)
    if (inRange) {
      const stepFeesUsd = calculateStepFees(
        state.liquidity,
        config.pool_liquidity_usd,
        config.daily_volume_usd,
        config.pool_fee_bps,
        stepSeconds,
        true,
      ) * positionShare;

      // Add fees proportionally as token0
      const feeToken0 = feeUsdToToken0(
        stepFeesUsd,
        config.initial_price_token0_usd,
        config.token0_decimals,
      );
      state.pendingFees0 += feeToken0;
    }

    // Check rebalance conditions
    if (!inRange && tickDistance > 0) {
      // Start or check OOR timer
      if (state.oorSinceTimestamp === null) {
        state.oorSinceTimestamp = tick.timestamp;
      }

      const oorDurationMinutes = (tick.timestamp - state.oorSinceTimestamp) / 60_000;

      // Critical distance bypass
      const criticalBypass = config.critical_distance_ticks > 0 &&
        tickDistance >= config.critical_distance_ticks;

      // Confirmation delay check
      const confirmationMet = criticalBypass || oorDurationMinutes >= config.confirm_minutes;

      if (confirmationMet) {
        // Anti-churn check: count recent rebalances in window
        const windowStart = tick.timestamp - churnWindowMs;
        const recentRebalances = state.rebalanceTimestamps.filter(t => t >= windowStart).length;

        if (recentRebalances >= config.max_rebalances_per_window) {
          // Skip — too many recent rebalances (would auto-widen in production)
          continue;
        }

        // Evaluate strategy
        const decision = evaluateStrategy(
          {
            position: {
              tokenId: 0,
              tickLower: state.tickLower,
              tickUpper: state.tickUpper,
              liquidity: state.liquidity,
            },
            pool: {
              tickSpacing: config.tick_spacing,
              currentTick: tick.tick,
            },
            isInRange: false,
            tickDistance,
          },
          {
            strategy: config.strategy,
            params: {
              width_ticks: config.width_ticks,
              trigger_distance_ticks: config.trigger_distance_ticks,
              lower_ratio_percent: config.lower_ratio_percent,
            },
          },
        );

        if (decision.shouldRebalance && decision.newTickLower !== undefined && decision.newTickUpper !== undefined) {
          // Cost-benefit gate (optional)
          if (config.cost_benefit_enabled) {
            const pendingFeesUsd = Number(state.pendingFees0) / (10 ** config.token0_decimals) * config.initial_price_token0_usd;
            const estimatedCostUsd = config.gas_cost_per_rebalance_usd;
            const ratio = estimatedCostUsd > 0 ? pendingFeesUsd / estimatedCostUsd : Infinity;
            if (ratio < config.min_fee_to_cost_ratio) {
              continue; // Skip — fees don't justify gas
            }
          }

          // Execute rebalance
          const costs = executeRebalance(
            state,
            tick.tick,
            decision.newTickLower,
            decision.newTickUpper,
            config,
            tick.timestamp,
          );
          totalGasCostsUsd += costs.gasCostUsd;
          totalSlippageCostsUsd += costs.slippageCostUsd;
        }
      }
    }

    // Record value snapshot every 100 steps (for drawdown calc, keeps memory low)
    if (i % 100 === 0 || i === data.length - 1) {
      const value = getPositionValue(state, tick.tick, config);
      state.valueHistory.push({ timestamp: tick.timestamp, valueToken0: value });
    }
  }

  // Final calculations
  const lastTick = data[data.length - 1].tick;
  const finalValue = getPositionValue(state, lastTick, config);

  // Total fees in token0-equiv
  const totalFeesToken0 = Number(state.totalFeesCollected0 + state.pendingFees0) / (10 ** config.token0_decimals);

  // Total costs in token0-equiv
  const totalCostsToken0 = (totalGasCostsUsd + totalSlippageCostsUsd) / config.initial_price_token0_usd;

  // Net ROI
  const netRoiPercent = state.initialValueToken0 > 0
    ? ((finalValue + totalFeesToken0 - totalCostsToken0 - state.initialValueToken0) / state.initialValueToken0) * 100
    : 0;

  // Time in range
  const timeInRangePercent = state.totalSteps > 0
    ? (state.inRangeSteps / state.totalSteps) * 100
    : 0;

  // IL approximation: compare final value to HODL value
  // HODL value = initial amounts at final price (no rebalancing)
  const impermanentLossPercent = state.initialValueToken0 > 0
    ? ((finalValue - state.initialValueToken0) / state.initialValueToken0) * 100
    : 0;

  // Max drawdown
  const maxDrawdownPercent = calculateMaxDrawdown(state.valueHistory);

  // Simulation duration
  const simulationDays = data.length > 1
    ? (data[data.length - 1].timestamp - data[0].timestamp) / (86400 * 1000)
    : 0;

  const elapsedSeconds = (performance.now() - startTime) / 1000;

  const partialResult = {
    netRoiPercent: Math.round(netRoiPercent * 100) / 100,
    timeInRangePercent: Math.round(timeInRangePercent * 100) / 100,
    totalFeesToken0: Math.round(totalFeesToken0 * 10000) / 10000,
    totalGasCostsUsd: Math.round(totalGasCostsUsd * 100) / 100,
    totalSlippageUsd: Math.round(totalSlippageCostsUsd * 100) / 100,
    impermanentLossPercent: Math.round(impermanentLossPercent * 100) / 100,
    rebalanceCount: state.rebalanceCount,
    maxDrawdownPercent: Math.round(maxDrawdownPercent * 100) / 100,
    simulationDays: Math.round(simulationDays * 100) / 100,
    elapsedSeconds: Math.round(elapsedSeconds * 1000) / 1000,
  };

  return {
    ...partialResult,
    netScore: calculateNetScore(partialResult, config),
  };
}

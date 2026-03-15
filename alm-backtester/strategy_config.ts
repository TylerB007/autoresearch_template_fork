/**
 * Strategy Configuration — THE FILE THE AGENT MODIFIES
 *
 * This file contains all tunable parameters for the backtest.
 * The autoresearch agent modifies this file to explore the parameter
 * space and discover optimal strategy configurations.
 *
 * After each modification, the agent runs `npx tsx backtest.ts` and
 * checks if net_score improved.
 */

import type { BacktestConfig } from './src/types.js';

const CONFIG: BacktestConfig = {
  // ============================================================
  // STRATEGY — which strategy to use and how it behaves
  // ============================================================
  strategy: 'center',
  width_ticks: 1500,                 // Range width in ticks (~6% for 9mm medium)
  trigger_distance_ticks: 50,        // How far OOR before rebalance triggers
  confirm_minutes: 60,               // Must stay OOR for this long before rebalancing
  critical_distance_ticks: 200,      // Bypass confirmation if this far OOR
  lower_ratio_percent: 50,           // For bullish/bearish: % of width below current price

  // ============================================================
  // ANTI-CHURN — prevent excessive rebalancing
  // ============================================================
  max_rebalances_per_window: 3,      // Max rebalances in the window
  churn_window_hours: 6,             // Rolling window for churn detection

  // ============================================================
  // COST-BENEFIT GATE — skip rebalance if fees don't justify gas
  // ============================================================
  cost_benefit_enabled: false,
  min_fee_to_cost_ratio: 1.5,

  // ============================================================
  // POOL ASSUMPTIONS — model the pool's characteristics
  // ============================================================
  pool_fee_bps: 2500,                // 9mm medium tier (0.25%)
  tick_spacing: 50,                  // 9mm medium tick spacing
  pool_liquidity_usd: 500_000,      // Total pool TVL in USD
  daily_volume_usd: 100_000,        // Average daily trading volume

  // ============================================================
  // TOKEN ASSUMPTIONS
  // ============================================================
  token0_decimals: 8,                // e.g., HEX = 8 decimals
  token1_decimals: 18,               // e.g., WPLS = 18 decimals

  // ============================================================
  // COST ASSUMPTIONS — gas and slippage per rebalance
  // ============================================================
  gas_cost_per_rebalance_usd: 0.05,  // PulseChain is cheap
  slippage_bps: 50,                  // 0.5% slippage per swap

  // ============================================================
  // SIMULATION PARAMETERS
  // ============================================================
  initial_capital_usd: 10_000,       // Starting capital
  initial_price_token0_usd: 0.005,   // HEX price in USD (approximate)

  // ============================================================
  // SCORING WEIGHTS — how the net_score is computed
  // Higher net_score is better.
  // ============================================================
  w1_roi: 1.0,                      // Weight for net ROI %
  w2_time_in_range: 0.1,            // Weight for time-in-range %
  w3_max_drawdown: 0.2,             // Penalty for max drawdown %
  w4_churn_penalty: 0.05,           // Penalty per excess rebalance
};

export default CONFIG;

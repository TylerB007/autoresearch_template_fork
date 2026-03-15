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
  width_ticks: 4000,                 // ~40% range width (optimal for HEX/WPLS)
  trigger_distance_ticks: 50,        // How far OOR before rebalance triggers
  confirm_minutes: 0,                // No confirmation delay
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
  // POOL: HEX/WPLS on 9mm V3 (PulseChain)
  // Pool: 0x8C357BE2cf2c1DE1c4Dca8aeA0Af1529f789976b
  // Data: GeckoTerminal 2026-03-15
  //   TVL: ~$337,780  |  24h Volume: ~$402,760  |  HEX price: ~$0.0273
  // ============================================================
  pool_fee_bps: 2500,                // 9mm medium tier (0.25%)
  tick_spacing: 50,                  // 9mm medium tick spacing
  pool_liquidity_usd: 337_780,      // Real TVL from GeckoTerminal
  daily_volume_usd: 402_760,        // Real 24h volume from GeckoTerminal

  // ============================================================
  // TOKEN ASSUMPTIONS — HEX (token0) / WPLS (token1)
  // ============================================================
  token0_decimals: 8,                // HEX = 8 decimals
  token1_decimals: 18,               // WPLS = 18 decimals

  // ============================================================
  // COST ASSUMPTIONS — gas and slippage per rebalance
  // ============================================================
  gas_cost_per_rebalance_usd: 0.05,  // PulseChain is very cheap
  slippage_bps: 30,                  // 0.30% slippage (HEX/WPLS has decent liquidity)

  // ============================================================
  // SIMULATION PARAMETERS
  // ============================================================
  initial_capital_usd: 10_000,       // Starting capital
  initial_price_token0_usd: 0.0273,  // HEX price in USD (live: ~$0.02728)

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

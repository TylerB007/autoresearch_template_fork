/**
 * Backtester type definitions.
 * Minimal types specific to the simulation engine — ALM types imported via bridge.
 */

/** A single price observation in the time series */
export interface PriceTick {
  /** Unix timestamp in milliseconds */
  timestamp: number;
  /** V3 tick value */
  tick: number;
  /** sqrtPriceX96 derived from tick (BigInt as string for JSONL serialization) */
  sqrtPriceX96: bigint;
}

/** Tracks the state of a simulated position */
export interface SimulationState {
  /** Current tick range */
  tickLower: number;
  tickUpper: number;
  /** Position liquidity */
  liquidity: bigint;
  /** Token amounts in the position */
  amount0: bigint;
  amount1: bigint;
  /** Accumulated fees (collected at each rebalance) */
  totalFeesCollected0: bigint;
  totalFeesCollected1: bigint;
  /** Unclaimed fees since last rebalance */
  pendingFees0: bigint;
  pendingFees1: bigint;
  /** Rebalance tracking */
  rebalanceCount: number;
  rebalanceTimestamps: number[];
  /** OOR confirmation timer */
  oorSinceTimestamp: number | null;
  /** Portfolio value snapshots for drawdown calculation */
  valueHistory: { timestamp: number; valueToken0: number }[];
  /** Time tracking */
  totalSteps: number;
  inRangeSteps: number;
  /** Initial capital for ROI calculation */
  initialValueToken0: number;
}

/** Final results from a simulation run */
export interface SimulationResult {
  /** Primary metric (higher is better) */
  netScore: number;
  /** Detailed metrics */
  netRoiPercent: number;
  timeInRangePercent: number;
  totalFeesToken0: number;
  totalGasCostsUsd: number;
  totalSlippageUsd: number;
  impermanentLossPercent: number;
  rebalanceCount: number;
  maxDrawdownPercent: number;
  simulationDays: number;
  elapsedSeconds: number;
}

/** Full configuration for a backtest run */
export interface BacktestConfig {
  // Strategy
  strategy: string;
  width_ticks: number;
  trigger_distance_ticks: number;
  confirm_minutes: number;
  critical_distance_ticks: number;
  lower_ratio_percent: number;

  // Anti-churn
  max_rebalances_per_window: number;
  churn_window_hours: number;

  // Cost-benefit gate
  cost_benefit_enabled: boolean;
  min_fee_to_cost_ratio: number;

  // Pool assumptions
  pool_fee_bps: number;
  tick_spacing: number;
  pool_liquidity_usd: number;
  daily_volume_usd: number;

  // Token assumptions
  token0_decimals: number;
  token1_decimals: number;

  // Cost assumptions
  gas_cost_per_rebalance_usd: number;
  slippage_bps: number;

  // Simulation
  initial_capital_usd: number;
  initial_price_token0_usd: number;

  // Scoring weights
  w1_roi: number;
  w2_time_in_range: number;
  w3_max_drawdown: number;
  w4_churn_penalty: number;
}

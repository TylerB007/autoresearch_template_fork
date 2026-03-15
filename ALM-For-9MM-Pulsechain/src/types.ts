/**
 * TypeScript interfaces and types for the 9mm V3 LP Auto-Rebalancer
 */

// ============================================================
// CONFIGURATION TYPES (loaded from config.yaml + .env)
// ============================================================

export type StrategyType =
  // New descriptive names (preferred)
  | 'center' | 'center_3pct' | 'center_6pct'
  | 'bullish' | 'bullish_3pct' | 'bullish_6pct'
  | 'bearish' | 'bearish_3pct' | 'bearish_6pct'
  | 'lazy_up' | 'lazy_down'
  | 'static'
  // Legacy names (backward compat)
  | 'pulse' | 'pulse_300' | 'pulse_600'
  | 'snuggle_up' | 'snuggle_up_300' | 'snuggle_up_600'
  | 'snuggle_down' | 'snuggle_down_300' | 'snuggle_down_600'
  | 'lazy_ascending' | 'lazy_descending'
  | string; // Allow dynamic strategy names from auto-widen (e.g., center_12pct)

export interface StrategyParams {
  width_ticks: number;
  trigger_distance_ticks: number;
  width_percentage?: number;
  trigger_percentage?: number;
  lower_ratio_percent?: number;  // Optional: for snuggle strategies, % of width below current price (default 30)
  confirm_minutes?: number;      // Optional: position must stay out of range for this many minutes before rebalancing (default 0)

  // Critical distance — bypass confirm_minutes if position drifts too far
  critical_distance_ticks?: number;    // If tickDistance >= this, rebalance immediately (bypasses confirm_minutes)
  critical_percentage?: number;        // Alternative: percentage form, converted to ticks at load time

  // Anti-churn safeguards
  max_rebalances_per_window?: number;  // Max rebalances before auto-widening (default 3)
  churn_window_hours?: number;         // Rolling window for churn detection (default 6)
  escalation_width?: number;           // Width to escalate to (default: current width * 2)

  // Kill switch — automatic disable on excessive losses
  kill_switch?: KillSwitchParams;

  // Cost-benefit gate — skip rebalance if unclaimed fees don't justify gas cost
  cost_benefit_enabled?: boolean;    // Optional: enable pre-rebalance fee/gas ratio check (default: false)
  min_fee_to_cost_ratio?: number;    // Optional: minimum fee/gas ratio to proceed (default: 1.5)
}

export interface KillSwitchParams {
  max_loss_percent?: number;            // ROI below this per rebalance counts as a loss (default: -5)
  max_consecutive_losses?: number;      // Consecutive losses before kill (default: 3)
  loss_window_hours?: number;           // Rolling window for loss counting (default: 24)
  min_hodl_ratio?: number;             // Kill if (current value / initial value) < this ratio
}

export interface PositionConfig {
  token_id: number;
  /** Which chain this position lives on. Defaults to the first/only configured chain. */
  chain_id?: number;
  strategy: StrategyType;
  params: StrategyParams;
  /** Optional DEX identifier for multi-DEX chains (e.g. 'uniswap-v3', 'pancakeswap-v3') */
  dex?: string;
  /** Optional: CLGauge contract address. When set, bot auto-unstakes before
   *  rebalancing and re-stakes the new position after minting. */
  gauge_address?: string;
}

/** Notification alert categories — all default to true if not specified */
export interface NotificationPreferences {
  rebalance_success?: boolean;
  rebalance_failure?: boolean;
  approaching_range?: boolean;
  confirm_timer?: boolean;
  daily_summary?: boolean;
  fee_collection?: boolean;
}

/** Notification category names for type-safe filtering */
export type NotificationCategory = keyof NotificationPreferences;

export interface NotificationsConfig {
  enabled: boolean;
  telegram_bot_token?: string;
  telegram_chat_id?: string;
  discord_webhook_url?: string;
  preferences?: NotificationPreferences;
}

export interface ContractsConfig {
  nonfungiblePositionManager: string;
  swapRouter: string;
  factory: string;
  quoter: string;
  piteasRouter?: string;
}

export type SwapProvider = 'direct' | 'piteas' | 'oneinch';

export interface SwapConfig {
  provider: SwapProvider;
  slippageBps: number;
  useWETH?: boolean;
}

export interface ChainConfig {
  chainId: number;
  chainName: string;
  protocolName: string;
  rpcUrls: string[];
  blockExplorerUrl: string;
  nativeCurrencySymbol: string;
  dexScreenerSlug: string;
  wrappedNativeAddress: string;
  swapRouterType: 'pancakeswap-v3' | 'uniswap-v3' | 'aerodrome-cl' | 'algebra-v3';
}

export interface AnalyticsConfig {
  enabled: boolean;
  snapshot_interval_minutes: number;
  persist_to_disk: boolean;
  storage_path: string;
}

export interface AppConfig {
  polling_interval_seconds: number;
  max_gas_price_gwei: number;
  dry_run: boolean;
  slippage_tolerance_bps: number;
  rebalance_cooldown_seconds: number;
  swap_provider: SwapProvider;
  contracts: ContractsConfig;
  /** Default chain (first configured chain, or the single chain in legacy config) */
  chain: ChainConfig;
  /** All configured chains keyed by chainId */
  chains: Map<number, ChainConfig>;
  /** RPC URLs per chain (from .env overrides and/or config.yaml) */
  rpcUrlsByChain: Map<number, string[]>;
  notifications: NotificationsConfig;
  positions: PositionConfig[];
  privateKey: string;
  /** RPC URLs for the default chain (backward compat) */
  rpcUrls: string[];
  analytics: AnalyticsConfig;
  oneinchApiKey?: string;
}

// ============================================================
// ON-CHAIN DATA TYPES
// ============================================================

export interface PoolState {
  address: string;
  token0: string;
  token1: string;
  fee: number;
  tickSpacing: number;
  sqrtPriceX96: bigint;
  currentTick: number;
  liquidity: bigint;
}

export interface TokenInfo {
  address: string;
  symbol: string;
  name: string;
  decimals: number;
}

export interface PositionData {
  tokenId: number;
  nonce: bigint;
  operator: string;
  token0: string;
  token1: string;
  fee: number;
  tickLower: number;
  tickUpper: number;
  liquidity: bigint;
  feeGrowthInside0LastX128: bigint;
  feeGrowthInside1LastX128: bigint;
  tokensOwed0: bigint;
  tokensOwed1: bigint;
}

export interface PositionStatus {
  position: PositionData;
  pool: PoolState;
  token0Info: TokenInfo;
  token1Info: TokenInfo;
  isInRange: boolean;
  tickDistance: number;
  amount0: bigint;
  amount1: bigint;
  unclaimedFees0: bigint;
  unclaimedFees1: bigint;
}

// ============================================================
// STRATEGY TYPES
// ============================================================

export interface RebalanceDecision {
  shouldRebalance: boolean;
  reason: string;
  newTickLower?: number;
  newTickUpper?: number;
}

// ============================================================
// REBALANCE EXECUTION TYPES
// ============================================================

export interface CollectResult {
  amount0: bigint;
  amount1: bigint;
  txHash: string;
  gasUsed: bigint;
  blockNumber?: number;
}

export interface RemoveLiquidityResult {
  amount0: bigint;
  amount1: bigint;
  decreaseTxHash: string;
  collectTxHash: string;
  burnTxHash: string;
  decreaseGasUsed: bigint;
  collectGasUsed: bigint;
  burnGasUsed: bigint;
  decreaseBlockNumber?: number;
  collectBlockNumber?: number;
  burnBlockNumber?: number;
}

export interface SwapResult {
  tokenIn: string;
  tokenOut: string;
  amountIn: bigint;
  amountOut: bigint;
  configuredSlippageBps?: number;
  txHash: string;
  gasUsed: bigint;
  blockNumber?: number;
}

export interface MintResult {
  newTokenId: number;
  liquidity: bigint;
  amount0: bigint;
  amount1: bigint;
  txHash: string;
  gasUsed: bigint;
  blockNumber?: number;
}

export interface RebalanceResult {
  success: boolean;
  oldTokenId: number;
  newTokenId?: number;
  feesCollected: { amount0: bigint; amount1: bigint };
  liquidityRemoved: { amount0: bigint; amount1: bigint };
  swapExecuted?: SwapResult;
  newPosition?: MintResult;
  error?: string;
}

export interface IncreaseLiquidityResult {
  liquidity: bigint;
  amount0: bigint;
  amount1: bigint;
  txHash: string;
  gasUsed: bigint;
  blockNumber?: number;
}

export interface DecreaseLiquidityResult {
  amount0: bigint;
  amount1: bigint;
  decreaseTxHash: string;
  collectTxHash: string;
  gasUsed: bigint;
  decreaseBlockNumber?: number;
  collectBlockNumber?: number;
}

// ============================================================
// RECOVERY TYPES
// ============================================================

export interface RecoveryState {
  oldTokenId: number;
  /** Chain this recovery belongs to (defaults to default chain if missing — backward compat) */
  chainId?: number;
  /** DEX identifier for correct contract resolution during recovery (e.g. 'aerodrome-cl') */
  dex?: string;
  token0: string;
  token1: string;
  token0Symbol: string;
  token1Symbol: string;
  fee: number;
  tickSpacing: number;
  strategy: StrategyType;
  params: StrategyParams;
  timestamp: number;
  /** Gauge address to re-stake into after recovery mint, if position was staked */
  gauge_address?: string;
}

export interface StrandedFundsReport {
  recoveryState: RecoveryState;
  balance0: bigint;
  balance1: bigint;
}

// ============================================================
// NONCE MANAGEMENT
// ============================================================

export interface NonceManager {
  getNextNonce(): Promise<number>;
  confirmNonce(nonce: number): void;
  resetNonce(): Promise<void>;
}

// ============================================================
// RPC PROVIDER TYPES
// ============================================================

export interface RpcProviderState {
  url: string;
  failureCount: number;
  lastFailure: number;
}

export interface FallbackProviderState {
  currentIndex: number;
  providers: RpcProviderState[];
}

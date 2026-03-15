/**
 * Analytics type definitions for performance tracking and strategy refinement.
 * All on-chain values use bigint; floating-point only for derived display metrics.
 */

import type { StrategyType } from '../types.js';

// ============================================================
// POSITION SNAPSHOT — captured every monitoring cycle
// ============================================================

export interface PositionSnapshot {
  timestamp: number;
  tokenId: number;
  chainId?: number;
  dex?: string;

  // Position state
  liquidity: bigint;
  tickLower: number;
  tickUpper: number;
  amount0: bigint;
  amount1: bigint;

  // Pool state
  currentTick: number;
  sqrtPriceX96: bigint;
  poolLiquidity: bigint;

  // Range status
  isInRange: boolean;
  tickDistance: number;
  /** Distance to lower tick bound as % of current price: ((current - lower) / current) * 100 */
  distanceToLowerPct?: number;
  /** Distance to upper tick bound as % of current price: ((upper - current) / current) * 100 */
  distanceToUpperPct?: number;

  // Fees pending
  tokensOwed0: bigint;
  tokensOwed1: bigint;

  // Token info (for display)
  token0Symbol: string;
  token1Symbol: string;
  token0Decimals: number;
  token1Decimals: number;
  poolFee: number;

  // USD prices at snapshot time — 0 when price feed unavailable.
  // Anchors historical value to a real price so P&L can be reconstructed
  // accurately even after token prices move significantly.
  priceUsd0: number;
  priceUsd1: number;
  nativePriceUsd: number;
  /** Token0/token1 price ratio at snapshot time (token1 per token0, decimal-adjusted) */
  priceRatio?: number;
  /** Total position value in USD: amount0*priceUsd0 + amount1*priceUsd1 */
  positionValueUsd: number;
  /** Unclaimed fees value in USD: tokensOwed0*priceUsd0 + tokensOwed1*priceUsd1 */
  unclaimedFeesUsd: number;
  /** Running total of all fees earned to date (claimed + unclaimed), in USD */
  cumulativeFeesUsd?: number;

  // HODL benchmark — compares LP position performance to simply holding initial quantities
  /** Value if initial token quantities were held without providing liquidity */
  hodlValueUsd?: number;
  /** Unrealized IL: (positionValueUsd - hodlValueUsd) / initialCapitalUsd * 100 */
  unrealizedIlPct?: number;
  /** LP total return %: (positionValueUsd + cumulativeFeesUsd - initialCapitalUsd) / initialCapitalUsd * 100 */
  lpReturnPct?: number;
  /** HODL return %: (hodlValueUsd - initialCapitalUsd) / initialCapitalUsd * 100 */
  hodlReturnPct?: number;
  /** LP vs HODL advantage: lpReturnPct - hodlReturnPct */
  lpVsHodlPct?: number;

  // Running cost totals (aggregated from rebalance history at snapshot time)
  /** Cumulative gas costs in USD for this position */
  cumulativeGasCostUsd?: number;
  /** Cumulative Type-B costs (slippage + price impact) in USD */
  cumulativeTypeBCostUsd?: number;
  /** Total cumulative costs: cumulativeGasCostUsd + cumulativeTypeBCostUsd */
  cumulativeTotalCostUsd?: number;
  /** Cost as % of total fees earned: cumulativeTotalCostUsd / cumulativeFeesUsd * 100 */
  costAsPctOfFees?: number;
  /** Net P&L: positionValueUsd + cumulativeFeesUsd - initialCapitalUsd - cumulativeTotalCostUsd */
  netPnlUsd?: number;

  // Pool context (from DexScreener at snapshot time)
  /** Total value locked in the pool in USD */
  poolTvlUsd?: number;
  /** 24-hour trading volume for the pool in USD */
  poolVolume24hUsd?: number;
  /** Pool fee rate (annualized): volume_24h * fee_tier * 365 / tvl */
  poolFeeRate?: number;
  /** Volume-to-TVL ratio: poolVolume24hUsd / poolTvlUsd */
  volumeToTvlRatio?: number;

  // Volatility — annualized log-return price volatility (σ)
  /** Annualized price volatility over trailing 7 days (std dev of log returns × √samples_per_year) */
  sigma7d?: number;
  /** Annualized price volatility over trailing 30 days */
  sigma30d?: number;
  /** Volatility ratio: sigma7d / sigma30d — >1 means vol is increasing */
  volatilityRatio?: number;
  /** Quality of volatility estimate based on price history gap coverage */
  sigmaConfidence?: 'high' | 'medium' | 'low';

  // Derived viability fields (Doc A §4 — computed at capture time)
  /** Minimum predictable loss rate: sigma30d² / 8 */
  minPlRate?: number;
  /** How much fee rate exceeds the PL floor: poolFeeRate - minPlRate */
  profitabilityMargin?: number;
  /** Is the non-negotiable profitability condition met: poolFeeRate > minPlRate */
  profitabilityViable?: boolean;
  /** Concentrated APR estimate: poolFeeRate × concentrationFactor (100 / widthPct) */
  effectiveAprPct?: number;
  /** Cumulative time-in-range since position entry */
  timeInRangePct?: number;

  // Snapshot metadata
  /** True if any data source returned stale/cached data for this snapshot */
  dataStale?: boolean;
  /** Why this snapshot was taken */
  snapshotTrigger?: 'scheduled' | 'pre_rebalance' | 'post_rebalance' | 'manual';

  /** Source of the price data (e.g. 'dexscreener', 'geckoterminal') */
  priceSource?: string;
  /**
   * Status of the price data:
   * 'live'                — fetched from a real API at event time
   * 'backfilled'          — filled by background task after initial failure
   * 'pending'             — all sources failed, awaiting backfill
   * 'permanently_missing' — backfill window expired (48h), no price available
   */
  priceStatus?: 'live' | 'backfilled' | 'pending' | 'permanently_missing';
  /** High precision timestamp (milliseconds) */
  timestampMs?: number;
}

// ============================================================
// REBALANCE ANALYTICS — full record captured at rebalance time
// ============================================================

export interface GasUsageData {
  collectFees: bigint;
  decreaseLiquidity: bigint;
  collectTokens: bigint;
  burn: bigint;
  swap: bigint;
  approvals: bigint;
  mint: bigint;
  total: bigint;
  /** Actual gas price paid per unit (from TransactionReceipt, post-EIP-1559) */
  effectiveGasPrice?: bigint;
  /** L1 data fee on L2 chains (Base, Arbitrum) — absent on L1 chains */
  l1Fee?: bigint;
  /** Total cost in wei: (gasUsed.total * effectiveGasPrice) + l1Fee */
  totalCostWei?: bigint;
}

export interface RebalanceTxHashes {
  collectFees: string;
  decreaseLiquidity: string;
  collectTokens: string;
  burn: string;
  swap?: string;
  mint: string;
}

export interface RebalanceAnalytics {
  timestamp: number;
  rebalanceId: string;
  chainId?: number;
  dex?: string;
  blockNumber?: number;

  // Position transition
  oldTokenId: number;
  newTokenId: number;
  strategy: StrategyType;

  // Pre/post snapshots
  preSnapshot: PositionSnapshot;
  postSnapshot: PositionSnapshot;

  // Transaction data
  txHashes: RebalanceTxHashes;

  // Fees collected during rebalance
  feesCollected0: bigint;
  feesCollected1: bigint;

  // Liquidity removed
  liquidityRemoved0: bigint;
  liquidityRemoved1: bigint;

  // Swap details
  swap?: {
    tokenIn: 'token0' | 'token1';
    amountIn: bigint;
    amountOut: bigint;
    configuredSlippageBps?: number;
    realizedExecutionDeltaBps?: number;
    slippageBps: number;
    /** Pool TWAP tick at the time the swap was decided — compares actual price to manipulation-resistant reference */
    twapTick?: number;
  };

  // New position
  newLiquidity: bigint;
  newAmount0: bigint;
  newAmount1: bigint;
  newTickLower: number;
  newTickUpper: number;

  // Gas costs (from actual receipts, not estimates)
  gasUsed: GasUsageData;
  gasPrice: bigint;
  totalGasCostPLS: number;

  /** Native token price in USD at the moment of rebalance (e.g., PLS, ETH, S) */
  nativeTokenPriceUsd?: number;
  /** Token prices in USD at the moment of rebalance — establishes entry cost basis for the new position */
  priceUsd0?: number;
  priceUsd1?: number;

  // Pre-computed USD values at time of rebalance (historically-priced, not recalculated later)
  /** Fees collected in USD at rebalance-time prices */
  feesCollectedUsd?: number;
  /** Gas cost in USD at rebalance-time native token price */
  gasCostUsd?: number;
  /** Swap friction in USD: value lost during token swap (pool fees + price impact + routing) */
  swapFrictionUsd?: number;

  // Capital reconciliation (Dust tracking)
  /** Exact difference between intended token0 deposit and actual minted amount */
  dust0?: bigint;
  /** Exact difference between intended token1 deposit and actual minted amount */
  dust1?: bigint;
  /** USD value of uninvested dust at rebalance time */
  dustUsd?: number;

  /** Source of the price data (e.g. 'dexscreener', 'geckoterminal') */
  priceSource?: string;
  /**
   * Status of the price data:
   * 'live'                — fetched from a real API at event time
   * 'backfilled'          — filled by background task after initial failure
   * 'pending'             — all sources failed, awaiting backfill
   * 'permanently_missing' — backfill window expired (48h), no price available
   */
  priceStatus?: 'live' | 'backfilled' | 'pending' | 'permanently_missing';
  /** High precision timestamp */
  timestampMs?: number;

  // Pre/post range metadata — range widths and center prices as % of market price
  /** Old range width as % of entry price: ((upper - lower) / entry_price) * 100 */
  oldWidthPct?: number;
  /** Old range midpoint price (decimal-adjusted token1/token0) */
  oldCenterPrice?: number;
  /** New range width as % of post-rebalance price */
  newWidthPct?: number;
  /** New range midpoint price (decimal-adjusted token1/token0) */
  newCenterPrice?: number;

  // Swap cost decomposition — split into Type A (explicit) and Type B (hidden)
  /** Type A: pool swap fee paid during the swap (swapAmount * feeTier) in USD */
  swapFeeCostUsd?: number;
  /** Type B: price impact cost (market movement from our trade) in USD */
  priceImpactCostUsd?: number;
  /** Type A total: gasCostUsd + swapFeeCostUsd */
  totalTypeACostUsd?: number;
  /** Type B total: slippage + priceImpactCostUsd (swapFrictionUsd is slippage only) */
  totalTypeBCostUsd?: number;

  /**
   * Realized LP-vs-HODL disadvantage crystallized when this interval is closed.
   * This captures the passive AMM effect where inventory was sold along the move
   * and must be bought back higher or sold back lower during rebalance.
   */
  priceDisadvantageUsd?: number;
  /** priceDisadvantageUsd / pre-rebalance position value * 100 */
  priceDisadvantagePct?: number;

  // IL crystallization — explicit USD fields
  /** Crystallized IL in USD: impermanentLossPercent * positionValueBefore / 100 */
  crystallizedIlUsd?: number;
  /** Total loss: crystallizedIlUsd + total_rebalance_cost_usd */
  totalLossUsd?: number;
  /** Total loss %: totalLossUsd / position_value_before * 100 */
  totalLossPct?: number;

  // Break-even estimates
  /** Estimated APR of the new position range (at new width + current pool conditions) */
  estimatedNewAprPct?: number;
  /** Days to recover total_loss_usd from estimated APR: 365 * totalLossPct / estimatedNewAprPct */
  estimatedBreakEvenDays?: number;
  /** Calendar days (accounts for time-in-range): estimatedBreakEvenDays / estimatedTimeInRange */
  estimatedBreakEvenCalendarDays?: number;

  // Retrospective outcome tracking — backfilled after sufficient time has passed
  /** Fees earned in first 24 hours after rebalance (backfilled) */
  feesEarned1dUsd?: number;
  /** Fees earned in first 3 days after rebalance (backfilled) */
  feesEarned3dUsd?: number;
  /** Fees earned in first 7 days after rebalance (backfilled) */
  feesEarned7dUsd?: number;
  /** Days until cumulative post-rebalance fees >= totalLossUsd (backfilled) */
  actualDaysToRecovery?: number;
  /** Whether fees covered totalLossUsd before the next rebalance (backfilled) */
  recoveredBeforeNextRebalance?: boolean;
  /** ID of the next rebalance for this position (backfilled) */
  nextRebalanceId?: string;
  /** When retrospective fields were last populated (ms timestamp) */
  retrospectiveUpdatedAt?: number;

  // Calculated metrics
  metrics: RebalanceMetrics;
}

// ============================================================
// CALCULATED METRICS — derived from analytics data
// ============================================================

export interface RebalanceMetrics {
  // Duration since last rebalance (or position creation)
  durationSeconds: number;
  durationDays: number;

  // Fee performance (annualized — returns 0 for sub-24h periods)
  feeAPR: number;

  // Raw fee yield (non-annualized) — useful for any period length
  rawFeeYieldPercent: number;

  // Capital efficiency
  capitalEfficiencyRatio: number;

  // Time in range (estimated from snapshots)
  timeInRangePercent: number;

  // Rebalance cost efficiency
  // Uses USD fees / USD full execution cost when those values are available.
  // Falls back to legacy behavior only for incomplete historical records.
  feesToCostRatio: number;

  // Impermanent loss vs HODL
  impermanentLossPercent: number;

  // Net ROI (fees - gas) / capital — excludes IL
  netROIPercent: number;

  // True Net ROI (fees - gas - IL) / capital — includes IL impact
  trueNetROIPercent: number;

  // Rebalance execution cost — total value lost during the rebalance process
  // Includes: swap pool fees, price impact, routing inefficiency, token dust
  // Calculated at post-rebalance price to isolate from IL
  rebalanceCostPercent: number;    // % of pre-rebalance value lost
  rebalanceCostToken0: number;     // cost in token0-equivalent units
}

// ============================================================
// AGGREGATE METRICS — lifetime and strategy comparisons
// ============================================================

export interface PositionLifecycleMetrics {
  tokenId: number;
  strategy: StrategyType;
  firstSeen: number;
  lastSeen: number;

  totalRebalances: number;
  totalFeesCollected0: bigint;
  totalFeesCollected1: bigint;
  totalGasCostPLS: number;

  avgFeeAPR: number;
  avgTimeInRange: number;
  avgRebalanceFrequencyDays: number;
}

export interface StrategyComparisonMetrics {
  strategy: StrategyType;
  period: { start: number; end: number };
  positionsTracked: number;
  totalRebalances: number;

  avgAPR: number;
  avgIL: number;
  avgTimeInRange: number;
  avgGasCostPerRebalance: number;
  avgFeesToCostRatio: number;

  totalFeesCollected0: bigint;
  totalFeesCollected1: bigint;
  totalGasCostPLS: number;
}

// ============================================================
// FEE COLLECTION — recorded when fees are manually collected
// ============================================================

export interface FeeCollectionRecord {
  timestamp: number;
  tokenId: number;
  chainId?: number;
  dex?: string;
  blockNumber?: number;
  txHash: string;
  amount0: bigint;
  amount1: bigint;
  gasUsed: bigint;
  gasPrice: bigint;
  gasCostPLS: number;
  priceUsd0: number;
  priceUsd1: number;
  valueUsd0: number;
  valueUsd1: number;
  totalValueUsd: number;
  token0Symbol: string;
  token1Symbol: string;
  token0Decimals: number;
  token1Decimals: number;
}

// ============================================================
// LIFECYCLE EVENT LOG — granular per-step event tracking
// ============================================================

export type RebalanceEventType =
  | 'rebalance_triggered'   // Strategy decided to rebalance (pre-checks passed)
  | 'fees_collected'        // Step 2: fees claimed from old position
  | 'position_exited'       // Step 3: liquidity removed + NFT burned
  | 'swap_executed'         // Step 5: token swap completed
  | 'position_opened'       // Step 6: new position minted
  | 'rebalance_completed'   // Full rebalance succeeded (links to RebalanceAnalytics)
  | 'rebalance_failed';     // Error at some step

export interface RebalanceLifecycleEvent {
  timestamp: number;
  rebalanceId: string;       // UUID shared across all events in one rebalance
  tokenId: number;
  chainId?: number;
  dex?: string;
  blockNumber?: number;
  eventType: RebalanceEventType;

  // Common optional fields
  txHash?: string;
  gasUsed?: bigint;
  amount0?: bigint;
  amount1?: bigint;

  // For swap_executed
  swap?: { tokenIn: 'token0' | 'token1'; amountIn: bigint; amountOut: bigint };

  // For position_opened
  newTokenId?: number;
  newTickLower?: number;
  newTickUpper?: number;
  liquidity?: bigint;

  // For rebalance_triggered
  strategy?: string;
  reason?: string;
  oldTickLower?: number;
  oldTickUpper?: number;
  currentTick?: number;

  // For rebalance_failed
  failedAtStep?: string;
  error?: string;
  enteredSafeMode?: boolean;

  // On-chain price data at event time — enables accurate historical price reconstruction
  // without relying on external APIs. sqrtPriceX96 is the pool's native price oracle.
  sqrtPriceX96?: bigint;
  poolCurrentTick?: number;

  // USD prices at event time (from DexScreener, GeckoTerminal, or backfill)
  priceUsd0?: number;
  priceUsd1?: number;
  nativePriceUsd?: number;
  priceSource?: string;
  /** Price status: 'live' | 'backfilled' | 'pending' | 'permanently_missing' */
  priceStatus?: 'live' | 'backfilled' | 'pending' | 'permanently_missing';

  // Token metadata (for display and backfill)
  token0Symbol?: string;
  token1Symbol?: string;
  token0Decimals?: number;
  token1Decimals?: number;
  /** Token0 contract address — stored for price backfill when priceStatus='pending' */
  token0Address?: string;
  /** Token1 contract address — stored for price backfill when priceStatus='pending' */
  token1Address?: string;
  /** Wrapped native token address — stored for price backfill */
  nativeWrappedAddress?: string;
}

// ============================================================
// PRICE HISTORY — rolling per-pool price store for σ computation
// ============================================================

/**
 * Persistent price observation for a pool.
 * Stored in price-history-{poolAddress}.jsonl, 30-day rolling retention.
 * Used to compute sigma_7d and sigma_30d annualized volatility.
 */
export interface PriceHistoryRecord {
  /** Unique identifier */
  priceHistoryId: string;
  /** Pool contract address (lowercase) */
  poolAddress: string;
  /** Chain ID */
  chainId: number;
  /** When this price was observed (ms timestamp) */
  timestamp: number;
  /** Token1 per token0, decimal-adjusted (human-readable ratio) */
  priceRatio: number;
  /** Token0 USD price */
  priceUsd0: number;
  /** Token1 USD price */
  priceUsd1: number;
  /** Data source */
  source: string;
}

// ============================================================
// TRIGGER EVENTS — every monitoring-cycle check, regardless of action
// ============================================================

export type TriggerType =
  | 'price_exit'              // Price moved outside range bounds
  | 'near_edge_warning'       // Price within threshold of range edge
  | 'volatility_regime_shift' // sigma7d/sigma30d ratio crossed threshold
  | 'fee_rate_deterioration'  // Pool fee rate dropped significantly
  | 'profitability_breach'    // poolFeeRate < minPlRate (sigma²/8)
  | 'manual_override'         // Operator forced action via /rebalance
  | 'scheduled_review';       // Periodic scheduled check (in-range, hold)

export type TriggerAction =
  | 'rebalance'
  | 'hold'
  | 'widen'
  | 'narrow'
  | 'pause'
  | 'close'
  | 'manual_override';

/**
 * Structured record for every monitoring-cycle check — whether action was taken or not.
 * Enables retrospective analysis: "when the bot held, was that the right decision?"
 */
export interface TriggerEvent {
  triggerEventId: string;      // UUID
  tokenId: number;
  chainId: number;
  timestamp: number;
  triggerType: TriggerType;

  // Position state at trigger time
  priceRatio?: number;         // Current token0/token1 ratio (decimal-adjusted)
  tickLower: number;
  tickUpper: number;
  currentTick: number;
  widthPct?: number;           // Range width as % of price
  distanceToNearestEdgePct?: number;
  inRange: boolean;

  // Context from latest snapshot
  timeInRangePct?: number;
  cumulativeFeesUsd?: number;
  unrealizedIlPct?: number;

  // Volatility at trigger time
  sigma7d?: number;
  sigma30d?: number;
  volatilityRatio?: number;

  // Pool economics at trigger time
  poolFeeRate?: number;
  profitabilityMargin?: number;

  // Forward-looking estimates
  estimatedRebalanceCostUsd?: number;
  estimatedBreakEvenDays?: number;

  // What happened
  actionTaken: TriggerAction;
  actionReason: string;
  linkedRebalanceId?: string;  // FK to RebalanceAnalytics.rebalanceId if action was rebalance
}

// ============================================================
// STRATEGY RULE SET — versioned parameter snapshots
// ============================================================

/**
 * Immutable snapshot of strategy parameters at a point in time.
 * Written when a position is deployed or when /config changes a parameter.
 * Enables retrospective comparison of performance across parameter regimes.
 */
export interface StrategyRuleSetSnapshot {
  ruleSetId: string;           // UUID
  tokenId: number;
  chainId: number;
  version: number;             // Incrementing integer
  createdAt: number;           // ms timestamp
  strategy: string;

  // Core parameters (all in ticks — canonical form after config loading)
  widthTicks: number;
  triggerDistanceTicks: number;
  confirmMinutes: number;
  criticalDistanceTicks?: number;

  // Derived % values for readability
  widthPct?: number;
  triggerDistancePct?: number;

  // Anti-churn safeguards
  maxRebalancesPerWindow?: number;
  churnWindowHours?: number;
  escalationWidthTicks?: number;

  // Cost-benefit gate
  costBenefitEnabled?: boolean;
  minFeeToCostRatio?: number;

  // Kill switch (serialized from KillSwitchParams)
  killSwitchMaxLossPct?: number;
  killSwitchMaxConsecutiveLosses?: number;
  killSwitchLossWindowHours?: number;
  killSwitchMinHodlRatio?: number;

  // Free-text description of what changed in this version
  notes?: string;
}

// ============================================================
// MANUAL CHAIN LINKS — user-created position linkages
// ============================================================

export interface ManualLink {
  oldTokenId: number;
  newTokenId: number;
  chainId?: number;
  dex?: string;
  createdAt: number;      // timestamp when user created the link
  note?: string;          // optional user note
}

// ============================================================
// POSITION ENTRY — cost basis record at mint time
// ============================================================

export interface PositionEntryRecord {
  timestamp: number;
  tokenId: number;
  dex?: string;
  blockNumber?: number;
  txHash: string;

  // Amounts deposited into the position
  amount0: bigint;
  amount1: bigint;

  // USD prices at time of entry — anchors cost basis
  priceUsd0: number;
  priceUsd1: number;
  nativePriceUsd: number;

  // Computed entry cost in USD: amount0 * priceUsd0 + amount1 * priceUsd1
  entryCostUsd: number;
  // Gas cost to mint in USD
  gasCostUsd: number;

  // Where did this position come from?
  source: 'manual' | 'rebalance';
  fromTokenId?: number;  // if source === 'rebalance', the old tokenId

  // Token metadata
  token0Symbol: string;
  token1Symbol: string;
  token0Decimals: number;
  token1Decimals: number;

  // Position range
  tickLower: number;
  tickUpper: number;

  chainId?: number;

  // Position close metadata — set when the position is burned/closed
  /** When the position was closed (burned), if applicable */
  closeTimestamp?: number;
  /**
   * Why the position was closed.
   * Examples: 'rebalance', 'manual', 'kill_switch', 'profitability_breach'
   */
  closeReason?: string;
  /** Status of this position */
  status?: 'active' | 'closed';

  // Strategy rule set at entry time — links to the StrategyRuleSetSnapshot
  ruleSetId?: string;

  // Pool address — enables retrospective pool-level analysis
  poolAddress?: string;

  /**
   * Accuracy of the USD price used for entryCostUsd.
   * 'live'      — fetched at the moment of entry (most accurate)
   * 'stored'    — taken from an analytics snapshot near the entry time
   * 'estimated' — current DexScreener price used (backfilled; accuracy depends on price change since entry)
   */
  priceSource?: 'live' | 'stored' | 'estimated' | string;
  /** Price status: 'live' | 'backfilled' | 'pending' | 'permanently_missing' */
  priceStatus?: 'live' | 'backfilled' | 'pending' | 'permanently_missing';
  /** High precision timestamp */
  timestampMs?: number;
}

// ============================================================
// STORAGE TYPES — JSON Lines records
// ============================================================

export interface PositionIncreaseRecord {
  tokenId: number;
  chainId?: number;
  dex?: string;
  blockNumber?: number;
  txHash: string;
  amount0: string;
  amount1: string;
  liquidity: string;
  gasUsed: string;
  valueUsd0: number;
  valueUsd1: number;
  swap?: {
    tokenIn: string;
    amountIn: string;
    amountOut: string;
    txHash: string;
  } | null;
}

export interface PositionDecreaseRecord {
  tokenId: number;
  chainId?: number;
  dex?: string;
  blockNumber?: number;
  percentageBps: number;
  decreaseTxHash: string;
  collectTxHash: string;
  amount0: string;
  amount1: string;
  gasUsed: string;
  valueUsd0: number;
  valueUsd1: number;
}

export type AnalyticsRecordType = 'snapshot' | 'rebalance' | 'fee_collection' | 'lifecycle_event' | 'position_increase' | 'position_decrease' | 'position_entry' | 'trigger_event' | 'price_history' | 'strategy_rule_set';

export interface AnalyticsRecord {
  type: AnalyticsRecordType;
  timestamp: number;
  data: PositionSnapshot | RebalanceAnalytics | FeeCollectionRecord | RebalanceLifecycleEvent | PositionIncreaseRecord | PositionDecreaseRecord | PositionEntryRecord | TriggerEvent | PriceHistoryRecord | StrategyRuleSetSnapshot;
}

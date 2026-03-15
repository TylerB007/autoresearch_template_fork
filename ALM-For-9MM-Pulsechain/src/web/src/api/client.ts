let authToken: string | null = null;
let onUnauthorized: (() => void) | null = null;

export function setAuthToken(token: string | null) {
  authToken = token;
}

export function setOnUnauthorized(callback: () => void) {
  onUnauthorized = callback;
}

/** Fetch an authenticated endpoint and trigger a browser file download. */
export async function downloadFile(path: string, fallbackFilename = 'export.csv'): Promise<void> {
  const headers: Record<string, string> = {};
  if (authToken) {
    headers['Authorization'] = `Bearer ${authToken}`;
  }
  const res = await fetch(path, { headers });
  if (res.status === 401) {
    if (onUnauthorized) onUnauthorized();
    throw new Error('Unauthorized');
  }
  if (!res.ok) {
    throw new Error(`Download failed: ${res.status}`);
  }
  const blob = await res.blob();
  const disposition = res.headers.get('Content-Disposition');
  const match = disposition?.match(/filename="?([^"]+)"?/);
  const filename = match?.[1] ?? fallbackFilename;
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(options.headers as Record<string, string>),
  };

  if (authToken) {
    headers['Authorization'] = `Bearer ${authToken}`;
  }

  const res = await fetch(path, { ...options, headers });

  if (res.status === 401) {
    if (onUnauthorized) onUnauthorized();
    throw new Error('Unauthorized');
  }

  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(body.error || `Request failed: ${res.status}`);
  }

  return res.json();
}

// Auth
export async function login(password: string): Promise<{ token: string }> {
  return request('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ password }),
  });
}

// Dashboard
export interface ChainBalance {
  chainId: number;
  chainName: string;
  nativeSymbol: string;
  balance: string;
}

export interface PositionBotState {
  tokenId: number;
  chainId: number;
  inSafeMode: boolean;
  killSwitch: {
    triggered: boolean;
    reason?: string;
    disabledAt?: number;
    consecutiveLosses: number;
  };
  rebalanceLockAgeMs: number | null;
}

export interface BotState {
  rebalancingEnabled: boolean;
  safeModePositions: string[];
  positionStates: PositionBotState[];
}

export interface DashboardData {
  wallet: {
    address: string;
    plsBalance: string;
  };
  chainBalances?: ChainBalance[];
  positions: {
    total: number;
    inRange: number;
    outOfRange: number;
  };
  botMode: string;
  positionList: PositionSummary[];
  totalUnclaimedFeesUsd?: number;
  totalClaimableUsd?: number;
  walletTokens?: WalletToken[];
  botState?: BotState;
}

export interface WalletToken {
  symbol: string;
  address: string;
  balance: string;
  decimals: number;
  balanceFormatted: number;
  valueUsd: number;
  chainId?: number;
  chainName?: string;
}

export interface PositionSummary {
  tokenId: number;
  chainId?: number;
  chainName?: string;
  pair: string;
  strategy: string;
  inRange: boolean;
  currentTick: number;
  tickLower: number;
  tickUpper: number;
  token0Decimals: number;
  token1Decimals: number;
  priceUsd0?: number;
  priceUsd1?: number;
  positionValueUsd?: number;
  lifetimeAPR?: number;
  totalFeesUsd?: number;
  totalEarningsUsd?: number;
  unclaimedFeesUsd?: number;
  claimableRewardsUsd?: number;
  claimableYieldUsd?: number;
  claimedFeesUsd?: number;
  ageMs?: number;
  rebalanceCount?: number;
  outOfRangeSinceMs?: number | null;
  gaugeAddress?: string;
  rewardSymbols?: string[];
  inSafeMode?: boolean;
  killSwitchTriggered?: boolean;
  rebalanceLocked?: boolean;
}

export async function getDashboard(): Promise<DashboardData> {
  return request('/api/dashboard');
}

// Bot Control
export async function enableBot(): Promise<{ success: boolean; safeModeCleared: number[]; recoveryStateWarning: string | null }> {
  return request('/api/bot/enable', { method: 'POST' });
}

export async function disableBot(): Promise<{ success: boolean; rebalancingEnabled: boolean }> {
  return request('/api/bot/disable', { method: 'POST' });
}

export async function clearPositionSafeMode(tokenId: number): Promise<{ success: boolean; wasInSafeMode: boolean; recoveryStateWarning: string | null }> {
  return request(`/api/bot/positions/${tokenId}/clear-safe-mode`, { method: 'POST' });
}

// Positions
export interface Position {
  token_id: number;
  chainId?: number;
  pair: string;
  strategy: string;
  width_ticks: number;
  trigger_distance_ticks: number;
  width_percentage?: number;
  trigger_percentage?: number;
  status: string;
  inRange: boolean;
  currentTick: number;
  tickLower: number;
  tickUpper: number;
  amount0: string;
  amount1: string;
  token0Symbol: string;
  token1Symbol: string;
  token0Decimals: number;
  token1Decimals: number;
  feesOwed0?: string;
  feesOwed1?: string;
  priceUsd0?: number;
  priceUsd1?: number;
  mintTimestamp?: number | null;
  age?: string | null;
  positionValueUsd?: number;
  claimedFeesUsd?: number;
  unclaimedFeesUsd?: number;
  totalFeesUsd?: number;
  lifetimeAPR?: number;
  gauge_address?: string;
  inSafeMode?: boolean;
  killSwitchTriggered?: boolean;
  rebalanceLocked?: boolean;
  rebalanceCosts?: {
    gasCostUsd: number;
    gasCostPLS: number;
    totalGasUnits: number;
    slippageBps: number;
    hourlyIncomeUsd: number;
    lower: {
      swapAmountUsd: number;
      swapTokenIn: 'token0' | 'token1';
      swapTokenInSymbol: string;
      swapPct: number;
      slippageCostUsd: number;
      totalCostUsd: number;
      breakEvenHours: number;
    };
    upper: {
      swapAmountUsd: number;
      swapTokenIn: 'token0' | 'token1';
      swapTokenInSymbol: string;
      swapPct: number;
      slippageCostUsd: number;
      totalCostUsd: number;
      breakEvenHours: number;
    };
    critical?: {
      lowerBreakEvenHours: number;
      upperBreakEvenHours: number;
      distanceTicks: number;
    };
  };
}

/**
 * Convert a V3 tick to a human-readable price (token1 per token0).
 * price = 1.0001^tick * 10^(token0Decimals - token1Decimals)
 */
export function tickToPrice(
  tick: number,
  token0Decimals: number,
  token1Decimals: number,
): number {
  return Math.pow(1.0001, tick) * Math.pow(10, token0Decimals - token1Decimals);
}

/** Format a raw token amount by its decimals (e.g. "495154209390" with 8 decimals → "4,951.54") */
export function formatTokenAmount(rawAmount: string, decimals: number): string {
  if (!rawAmount || rawAmount === '0') return '0';

  // Pad with leading zeros if needed
  const padded = rawAmount.padStart(decimals + 1, '0');
  const intPart = padded.slice(0, padded.length - decimals) || '0';
  const fracPart = padded.slice(padded.length - decimals);

  // Parse to number for formatting (safe for display purposes)
  const value = parseFloat(`${intPart}.${fracPart}`);

  if (value >= 1_000_000) return value.toLocaleString(undefined, { maximumFractionDigits: 0 });
  if (value >= 1) return value.toLocaleString(undefined, { maximumFractionDigits: 2 });
  if (value >= 0.0001) return value.toLocaleString(undefined, { maximumFractionDigits: 6 });
  if (value === 0) return '0';
  return value.toExponential(3);
}

/** Format a price for display with appropriate precision */
export function formatPrice(price: number): string {
  if (price >= 1000) return price.toLocaleString(undefined, { maximumFractionDigits: 0 });
  if (price >= 1) return price.toLocaleString(undefined, { maximumFractionDigits: 2 });
  if (price >= 0.001) return price.toLocaleString(undefined, { maximumFractionDigits: 6 });
  return price.toExponential(3);
}

/**
 * Format a USD value for display.
 * Pass null/undefined to indicate price data was unavailable (shows 'N/A' instead of '$0.00').
 */
export function formatUsd(value: number | null | undefined): string {
  if (value === null || value === undefined) return 'N/A';
  if (value >= 1) return `$${value.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  if (value >= 0.01) return `$${value.toFixed(4)}`;
  if (value > 0) return `$${value.toFixed(6)}`;
  return '$0.00';
}

/** Calculate USD value from a raw token amount string, decimals, and price */
export function tokenAmountToUsd(rawAmount: string, decimals: number, priceUsd: number): number {
  if (!rawAmount || rawAmount === '0' || priceUsd === 0) return 0;
  const padded = rawAmount.padStart(decimals + 1, '0');
  const intPart = padded.slice(0, padded.length - decimals) || '0';
  const fracPart = padded.slice(padded.length - decimals);
  return parseFloat(`${intPart}.${fracPart}`) * priceUsd;
}

export async function getPositions(): Promise<Position[]> {
  return request('/api/positions');
}

export async function getPositionStatus(tokenId: number): Promise<Position> {
  return request(`/api/positions/${tokenId}/status`);
}

export interface PositionInput {
  token_id: number;
  strategy: string;
  width_ticks: number;
  trigger_distance_ticks: number;
}

export async function addPosition(data: PositionInput): Promise<Position> {
  return request('/api/positions', {
    method: 'POST',
    body: JSON.stringify({
      token_id: data.token_id,
      strategy: data.strategy,
      params: {
        width_ticks: data.width_ticks,
        trigger_distance_ticks: data.trigger_distance_ticks,
      },
    }),
  });
}

export async function updatePosition(tokenId: number, data: Partial<PositionInput>): Promise<Position> {
  const body: Record<string, unknown> = {};
  if (data.strategy !== undefined) body.strategy = data.strategy;
  if (data.width_ticks !== undefined || data.trigger_distance_ticks !== undefined) {
    const params: Record<string, number> = {};
    if (data.width_ticks !== undefined) params.width_ticks = data.width_ticks;
    if (data.trigger_distance_ticks !== undefined) params.trigger_distance_ticks = data.trigger_distance_ticks;
    body.params = params;
  }
  return request(`/api/positions/${tokenId}`, {
    method: 'PUT',
    body: JSON.stringify(body),
  });
}

export async function deletePosition(tokenId: number): Promise<void> {
  return request(`/api/positions/${tokenId}`, {
    method: 'DELETE',
  });
}

// Rebalance History
export interface RebalanceSwap {
  tokenIn: 'token0' | 'token1';
  amountIn: string;
  amountOut: string;
  slippageBps: number;
  configuredSlippageBps?: number;
  realizedExecutionDeltaBps?: number;
}

export interface RebalanceMetrics {
  durationSeconds: number;
  durationDays: number;
  feeAPR: number;
  rawFeeYieldPercent?: number;
  capitalEfficiencyRatio: number;
  timeInRangePercent: number;
  feesToCostRatio: number;
  feesToExecutionCostRatio?: number | null;
  feesToExecutionCostQuality?: 'exact' | 'partial' | 'estimated' | 'unavailable';
  executionCostUsd?: number | null;
  impermanentLossPercent: number;
  netROIPercent: number;
  trueNetROIPercent?: number;
  rebalanceCostPercent?: number;
}

export interface RebalanceEvent {
  timestamp: number;
  rebalanceId: string;
  oldTokenId: number;
  newTokenId: number;
  strategy: string;
  preSnapshot: {
    tickLower: number;
    tickUpper: number;
    currentTick: number;
    amount0: string;
    amount1: string;
    token0Symbol: string;
    token1Symbol: string;
    token0Decimals: number;
    token1Decimals: number;
  };
  postSnapshot: {
    tickLower: number;
    tickUpper: number;
    currentTick: number;
    amount0: string;
    amount1: string;
  };
  txHashes: {
    collectFees: string;
    decreaseLiquidity: string;
    collectTokens: string;
    burn: string;
    swap?: string;
    mint: string;
  };
  feesCollected0: string;
  feesCollected1: string;
  liquidityRemoved0: string;
  liquidityRemoved1: string;
  swap?: RebalanceSwap;
  newTickLower: number;
  newTickUpper: number;
  newAmount0: string;
  newAmount1: string;
  totalGasCostPLS: number;
  gasCostSource?: 'receipt_exact' | 'estimated_aggregate';
  feesCollectedUsd?: number;
  gasCostUsd?: number;
  swapFrictionUsd?: number;
  dust0?: string;
  dust1?: string;
  dustUsd?: number;
  priceSource?: string;
  timestampMs?: number;
  priceUsd0?: number;
  priceUsd1?: number;
  nativeTokenPriceUsd?: number;
  gasPrice?: string;
  gasUsed?: {
    collectFees: string;
    decreaseLiquidity: string;
    collectTokens: string;
    burn: string;
    swap: string;
    mint: string;
    total: string;
    totalCostWei?: string;
    l1Fee?: string;
  };
  recordQuality?: {
    executionCostQuality: 'exact' | 'partial' | 'estimated' | 'unavailable';
    isPartial: boolean;
    missingFields: string[];
  };
  metrics: RebalanceMetrics;
}

export interface RebalanceHistoryResponse {
  days: number;
  count: number;
  rebalances: RebalanceEvent[];
}

export async function getRebalanceHistory(days: number = 7): Promise<RebalanceHistoryResponse> {
  return request(`/api/rebalances?days=${days}`);
}

// Lifecycle Events
export type RebalanceEventType =
  | 'rebalance_triggered' | 'fees_collected' | 'position_exited'
  | 'swap_executed' | 'position_opened' | 'rebalance_completed' | 'rebalance_failed';

export interface LifecycleEvent {
  timestamp: number;
  rebalanceId: string;
  tokenId: number;
  eventType: RebalanceEventType;
  txHash?: string;
  gasUsed?: string;
  amount0?: string;
  amount1?: string;
  swap?: { tokenIn: 'token0' | 'token1'; amountIn: string; amountOut: string };
  newTokenId?: number;
  newTickLower?: number;
  newTickUpper?: number;
  liquidity?: string;
  strategy?: string;
  reason?: string;
  failedAtStep?: string;
  error?: string;
  enteredSafeMode?: boolean;
  token0Symbol?: string;
  token1Symbol?: string;
  token0Decimals?: number;
  token1Decimals?: number;
}

export interface EventLogResponse {
  days: number;
  count: number;
  events: LifecycleEvent[];
}

export async function getEventLog(days: number = 30, tokenId?: number): Promise<EventLogResponse> {
  const params = new URLSearchParams({ days: days.toString() });
  if (tokenId) params.set('tokenId', tokenId.toString());
  return request(`/api/events?${params}`);
}

// Collect Fees
export interface CollectFeesResult {
  success: boolean;
  txHash: string;
  gasUsed: string;
  collected0: string;
  collected1: string;
}

export async function collectFees(tokenId: number): Promise<CollectFeesResult> {
  return request(`/api/positions/${tokenId}/collect`, {
    method: 'POST',
  });
}

// Rebalance Preview + Execute
export interface RebalancePreview {
  tokenId: number;
  currentTick: number;
  inRange: boolean;
  pair: string;
  token0Symbol: string;
  token1Symbol: string;
  positionValueUsd: number;
  feesUsd: number;
  currentRange: { tickLower: number; tickUpper: number };
  newRange: { tickLower: number; tickUpper: number };
  strategy: string;
  shouldRebalance: boolean;
  reason: string;
  swapEstimate: {
    tokenIn: 'token0' | 'token1';
    symbol: string;
    amountUsd: number;
    pct: number;
  };
  dryRun: boolean;
}

export async function getRebalancePreview(tokenId: number): Promise<RebalancePreview> {
  return request(`/api/positions/${tokenId}/rebalance-preview`);
}

export interface RebalanceNowResult {
  success: boolean;
  oldTokenId: number;
  newTokenId: number;
  feesCollected: { amount0: string; amount1: string };
  liquidityRemoved: { amount0: string; amount1: string };
  swap: {
    tokenIn: string;
    tokenOut: string;
    amountIn: string;
    amountOut: string;
    txHash: string;
  } | null;
  newPosition: {
    tokenId: number;
    liquidity: string;
    txHash: string;
  } | null;
}

export async function rebalanceNow(tokenId: number): Promise<RebalanceNowResult> {
  return request(`/api/positions/${tokenId}/rebalance`, {
    method: 'POST',
  });
}

// Increase Liquidity
export interface IncreasePreview {
  swap: {
    tokenIn: 'token0' | 'token1';
    amountIn: string;
    tokenInSymbol: string;
    tokenOutSymbol: string;
  } | null;
  expectedLiquidity: string;
  currentLiquidity: string;
  estimatedGasCostWei: string;
  token0Symbol: string;
  token1Symbol: string;
  token0Decimals: number;
  token1Decimals: number;
  priceUsd0: number;
  priceUsd1: number;
}

export interface IncreaseLiquidityResult {
  success: boolean;
  txHash: string;
  gasUsed: string;
  liquidity: string;
  amount0: string;
  amount1: string;
  swap: {
    tokenIn: string;
    tokenOut: string;
    amountIn: string;
    amountOut: string;
    txHash: string;
  } | null;
}

export async function getIncreasePreview(tokenId: number, amount0: string, amount1: string): Promise<IncreasePreview> {
  return request(`/api/positions/${tokenId}/increase-preview?amount0=${amount0}&amount1=${amount1}`);
}

export async function increaseLiquidityApi(tokenId: number, amount0: string, amount1: string, swapIfNeeded: boolean): Promise<IncreaseLiquidityResult> {
  return request(`/api/positions/${tokenId}/increase`, {
    method: 'POST',
    body: JSON.stringify({ amount0, amount1, swapIfNeeded }),
  });
}

// Decrease Liquidity
export interface DecreaseLiquidityResult {
  success: boolean;
  decreaseTxHash: string;
  collectTxHash: string;
  gasUsed: string;
  amount0: string;
  amount1: string;
  percentageBps: number;
}

export async function decreaseLiquidityApi(tokenId: number, percentageBps: number): Promise<DecreaseLiquidityResult> {
  return request(`/api/positions/${tokenId}/decrease`, {
    method: 'POST',
    body: JSON.stringify({ percentageBps }),
  });
}

// Position Analytics
export interface PositionAnalytics {
  tokenId: number;
  totalRebalances: number;
  totalFeesClaimedUsd: number;
  totalFeesClaimed0: string;
  totalFeesClaimed1: string;
  totalManualCollections: number;
  totalManualFeesUsd: number;
  totalGasCostPLS: number;
  totalGasCostUsd: number;
  currentUnclaimedFeesUsd: number;
  combinedFeesUsd: number;
  currentILPercent: number;
  netPnlUsd: number;
  // True P&L metrics (null when entry data unavailable)
  currentPositionValueUsd: number;
  entryCostUsd: number | null;
  hodlValueUsd: number | null;
  unrealizedILUsd: number | null;
  totalSwapFrictionUsd: number;
  totalPnlUsd: number | null;
  totalPnlPercent: number | null;
  lpVsHodlUsd: number | null;
  lpVsHodlPercent: number | null;
  hasEntryData: boolean;
  firstSeen: number;
  daysSinceStart: number;
  daysSinceLastRebalance: number;
  timeInRangePercent: number;
  avgRebalanceFrequencyDays: number;
  avgFeeAPR: number;
  healthScore: number;
  healthLabel: 'excellent' | 'good' | 'fair' | 'poor';
  rebalanceCosts: Array<{
    timestamp: number;
    rebalanceId: string;
    gasCostPLS: number;
    feesCollectedUsd: number;
    configuredSlippageToleranceBps?: number;
    realizedExecutionDeltaBps: number;
    executionCostUsd: number | null;
    executionCostQuality: 'exact' | 'partial' | 'estimated' | 'unavailable';
    gasCostSource: 'receipt_exact' | 'estimated_aggregate';
    feesToExecutionCostRatio: number | null;
    rebalanceCostPercent?: number;
    netRoi: number;
  }>;
  feeCollections: Array<{
    timestamp: number;
    txHash: string;
    amount0: string;
    amount1: string;
    totalValueUsd: number;
  }>;
  feeTimeSeries: Array<{ t: number; cumulativeUsd: number }>;
  ilTimeSeries: Array<{ t: number; ilPercent: number }>;
  currentInterval?: {
    tokenId: number;
    startTimestamp: number | null;
    endTimestamp: number | null;
    durationDays: number | null;
    claimedFeesUsd: number;
    unclaimedFeesUsd: number;
    totalFeesUsd: number;
    currentPositionValueUsd: number;
    totalGasCostUsd: number;
    totalSwapFrictionUsd: number;
    totalPriceDisadvantageUsd: number;
    totalCostsUsd: number;
    netIncomeUsd: number;
    entryCostUsd: number | null;
    hodlValueUsd: number | null;
    truePnlUsd: number | null;
    truePnlPercent: number | null;
    lpVsHodlUsd: number | null;
    lpVsHodlPercent: number | null;
    hasEntryData: boolean;
    trust: {
      basis: 'exact' | 'event_time_exact' | 'backfilled' | 'estimated' | 'approximate' | 'missing';
      currentValue: 'exact' | 'event_time_exact' | 'backfilled' | 'estimated' | 'approximate' | 'missing';
      fees: 'exact' | 'event_time_exact' | 'backfilled' | 'estimated' | 'approximate' | 'missing';
      costs: 'exact' | 'event_time_exact' | 'backfilled' | 'estimated' | 'approximate' | 'missing';
      hodl: 'exact' | 'event_time_exact' | 'backfilled' | 'estimated' | 'approximate' | 'missing';
      overall: 'exact' | 'event_time_exact' | 'backfilled' | 'estimated' | 'approximate' | 'missing';
    };
  };
  lifetimeChain?: {
    requestedTokenId: number;
    rootTokenId: number;
    currentTokenId: number;
    lineageTokenIds: number[];
    firstSeen: number | null;
    lastSeen: number | null;
    totalRebalances: number;
    totalManualCollections: number;
    claimedFeesUsd: number;
    unclaimedFeesUsd: number;
    totalFeesUsd: number;
    currentPositionValueUsd: number;
    totalGasCostUsd: number;
    totalSwapFrictionUsd: number;
    totalPriceDisadvantageUsd: number;
    totalCostsUsd: number;
    netIncomeUsd: number;
    entryCostUsd: number | null;
    hodlValueUsd: number | null;
    truePnlUsd: number | null;
    truePnlPercent: number | null;
    lpVsHodlUsd: number | null;
    lpVsHodlPercent: number | null;
    hasEntryData: boolean;
    trust: {
      basis: 'exact' | 'event_time_exact' | 'backfilled' | 'estimated' | 'approximate' | 'missing';
      currentValue: 'exact' | 'event_time_exact' | 'backfilled' | 'estimated' | 'approximate' | 'missing';
      fees: 'exact' | 'event_time_exact' | 'backfilled' | 'estimated' | 'approximate' | 'missing';
      costs: 'exact' | 'event_time_exact' | 'backfilled' | 'estimated' | 'approximate' | 'missing';
      hodl: 'exact' | 'event_time_exact' | 'backfilled' | 'estimated' | 'approximate' | 'missing';
      overall: 'exact' | 'event_time_exact' | 'backfilled' | 'estimated' | 'approximate' | 'missing';
    };
  };
}

export async function getPositionAnalytics(tokenId: number): Promise<PositionAnalytics> {
  return request(`/api/analytics/positions/${tokenId}/analytics`);
}

// Portfolio Summary
export interface PortfolioSummary {
  totalPositions: number;
  totalValueUsd: number;
  totalFeesEarnedUsd: number;
  totalGasCostUsd: number;
  netPnlUsd: number;
  // True P&L (null when no entry data exists)
  portfolioEntryCostUsd: number | null;
  portfolioTotalPnlUsd: number | null;
  portfolioTotalPnlPercent: number | null;
  portfolioLpVsHodlPercent: number | null;
  portfolioSwapFrictionUsd: number;
  positions: Array<{
    tokenId: number;
    pair: string;
    strategy: string;
    valueUsd: number;
    feesEarnedUsd: number;
    gasCostUsd: number;
    netPnlUsd: number;
    healthScore: number;
    healthLabel: string;
    totalPnlUsd: number | null;
    totalPnlPercent: number | null;
  }>;
}

export async function getPortfolioSummary(): Promise<PortfolioSummary> {
  return request('/api/analytics/summary');
}

// Daily Earnings
export interface DailyEarning {
  date: string;
  feesUsd: number;
}

export async function getDailyEarnings(tokenId?: number): Promise<DailyEarning[]> {
  const path = tokenId != null
    ? `/api/analytics/earnings?tokenId=${tokenId}`
    : '/api/analytics/earnings';
  return request<DailyEarning[]>(path);
}

// Recovery
export interface RecoveryReport {
  oldTokenId: number;
  token0Symbol: string;
  token1Symbol: string;
  fee: number;
  strategy: string;
  widthTicks: number;
  balance0: string;
  balance1: string;
  timestamp: number;
}

export interface RecoveryStatus {
  hasAlert: boolean;
  report?: RecoveryReport;
}

export interface RecoveryResult {
  success: boolean;
  newTokenId: number;
  liquidity: string;
  amount0: string;
  amount1: string;
  txHash: string;
  gasUsed: string;
}

export async function getRecoveryStatus(): Promise<RecoveryStatus> {
  return request('/api/recovery/status');
}

export async function dismissRecovery(): Promise<{ message: string }> {
  return request('/api/recovery/dismiss', { method: 'POST' });
}

export async function executeRecovery(): Promise<RecoveryResult> {
  return request('/api/recovery/recover', { method: 'POST' });
}

// Chain Info (from /api/config)
export interface ChainInfo {
  chainId: number;
  chainName: string;
  protocolName: string;
  blockExplorerUrl: string;
  nativeCurrencySymbol: string;
}

/** Fetch chain metadata from the config endpoint */
export async function getChainInfo(): Promise<ChainInfo> {
  const config = await request<{ chain: ChainInfo }>('/api/config');
  return config.chain;
}

/** Build a block explorer transaction URL */
export function getTxUrl(txHash: string, blockExplorerUrl: string): string {
  return `${blockExplorerUrl}/tx/${txHash}`;
}

// Calculator
export interface CalculatorPair {
  label: string;
  token0: string;
  token1: string;
  fee: number;
}

export interface PoolState {
  poolAddress: string;
  currentTick: number;
  sqrtPriceX96: string;
  tickSpacing: number;
  fee: number;
  feeFormatted: string;
  price: number;
  priceFormatted: string;
  token0: { address: string; symbol: string; decimals: number; priceUsd: number };
  token1: { address: string; symbol: string; decimals: number; priceUsd: number };
  walletBalance0: number;
  walletBalance1: number;
}

export interface CalculatorResult {
  pool: {
    address: string;
    currentTick: number;
    price: number;
    priceFormatted: string;
    fee: number;
    feeFormatted: string;
  };
  range: {
    tickLower: number;
    tickUpper: number;
    priceLower: number;
    priceUpper: number;
    priceLowerFormatted: string;
    priceUpperFormatted: string;
    widthTicks: number;
  };
  targetSplit: {
    token0Pct: number;
    token1Pct: number;
    token0Symbol: string;
    token1Symbol: string;
  };
  wallet: {
    balance0: string;
    balance1: string;
    balance0Formatted: string;
    balance1Formatted: string;
    value0Usd: number;
    value1Usd: number;
    totalValueUsd: number;
  };
  swap: {
    direction: string;
    tokenIn: 'token0' | 'token1';
    tokenInSymbol: string;
    amountIn: string;
    amountInFormatted: string;
    amountInUsd: number;
    swapPct: number;
    estimatedFeePct: number;
  };
  tokens: {
    token0: { address: string; symbol: string; decimals: number };
    token1: { address: string; symbol: string; decimals: number };
  };
}

export async function getCalculatorPairs(): Promise<CalculatorPair[]> {
  return request('/api/calculator/pairs');
}

export async function getPoolState(token0: string, token1: string, fee: number): Promise<PoolState> {
  const qs = new URLSearchParams({ token0, token1, fee: fee.toString() });
  return request(`/api/calculator/pool-state?${qs.toString()}`);
}

export async function getCalculatorSplit(params: {
  token0: string;
  token1: string;
  fee: number;
  priceLower: number;
  priceUpper: number;
  balance0: number;
  balance1: number;
}): Promise<CalculatorResult> {
  const qs = new URLSearchParams({
    token0: params.token0,
    token1: params.token1,
    fee: params.fee.toString(),
    priceLower: params.priceLower.toString(),
    priceUpper: params.priceUpper.toString(),
    balance0: params.balance0.toString(),
    balance1: params.balance1.toString(),
  });
  return request(`/api/calculator/split?${qs.toString()}`);
}

// Position Chain
export interface ChainLink {
  tokenId: number;
  strategy: string;
  tickLower: number;
  tickUpper: number;
  widthTicks: number;
  mintTimestamp: number;
  burnTimestamp: number | null;
  durationMs: number;
  feesCollected0: string;
  feesCollected1: string;
  gasCostPLS: number;
  swapExecDeltaBps: number;
  rebalanceCostPercent: number;
  timeInRangePercent: number;
  feeAPR: number;
  netROIPercent: number;
  rebalanceId: string | null;
  isManualLink?: boolean;
}

export interface ChainAggregate {
  totalRebalances: number;
  totalFeesCollected0: string;
  totalFeesCollected1: string;
  totalGasCostPLS: number;
  avgExecDeltaBps: number;
  totalDurationMs: number;
  avgTimeInRangePercent: number;
  avgFeeAPR: number;
  cumulativeNetROIPercent: number;
  firstSeen: number;
  lastSeen: number;
}

export interface PositionChainData {
  rootTokenId: number;
  currentTokenId: number;
  links: ChainLink[];
  aggregate: ChainAggregate;
}

export async function getPositionChain(tokenId: number): Promise<PositionChainData> {
  return request(`/api/analytics/positions/${tokenId}/chain`);
}

/** Generic authenticated GET — for pages that call one-off endpoints. */
export async function apiFetch<T>(path: string): Promise<T> {
  return request<T>(path);
}

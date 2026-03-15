import type {
  FeeCollectionRecord,
  ManualLink,
  PositionEntryRecord,
  PositionSnapshot,
  RebalanceAnalytics,
} from './types.js';
import { bigintToFloat } from '../bigintFloat.js';

export type ProfitabilityTrustLevel =
  | 'exact'
  | 'event_time_exact'
  | 'backfilled'
  | 'estimated'
  | 'approximate'
  | 'missing';

export interface ProfitabilityTrustBreakdown {
  basis: ProfitabilityTrustLevel;
  currentValue: ProfitabilityTrustLevel;
  fees: ProfitabilityTrustLevel;
  costs: ProfitabilityTrustLevel;
  hodl: ProfitabilityTrustLevel;
  overall: ProfitabilityTrustLevel;
}

export interface LivePositionAnalyticsState {
  tokenId: number;
  chainId?: number;
  dex?: string;
  timestamp: number;
  currentPositionValueUsd: number;
  currentUnclaimedFeesUsd: number;
  priceUsd0: number;
  priceUsd1: number;
  nativePriceUsd: number;
  token0Symbol: string;
  token1Symbol: string;
  token0Decimals: number;
  token1Decimals: number;
  source: 'live' | 'snapshot';
  priceStatus?: 'live' | 'backfilled' | 'pending' | 'permanently_missing';
}

export interface LineageContext {
  requestedTokenId: number;
  rootTokenId: number;
  currentTokenId: number;
  lineageTokenIds: number[];
  lineageRebalances: RebalanceAnalytics[];
}

export interface IntervalProfitabilitySummary {
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
  trust: ProfitabilityTrustBreakdown;
}

export interface LifetimeChainProfitabilitySummary {
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
  trust: ProfitabilityTrustBreakdown;
}

export interface LineageAnalyticsSummary {
  lineage: LineageContext;
  currentInterval: IntervalProfitabilitySummary;
  lifetimeChain: LifetimeChainProfitabilitySummary;
}

interface EntryBasis {
  tokenId: number;
  timestamp: number | null;
  entryCostUsd: number | null;
  gasCostUsd: number;
  amount0: bigint | null;
  amount1: bigint | null;
  token0Symbol: string | null;
  token1Symbol: string | null;
  token0Decimals: number | null;
  token1Decimals: number | null;
  hasEntryData: boolean;
  trust: ProfitabilityTrustLevel;
  source: 'position_entry' | 'snapshot_fallback' | 'missing';
}

const TRUST_RANK: Record<ProfitabilityTrustLevel, number> = {
  exact: 0,
  event_time_exact: 1,
  backfilled: 2,
  estimated: 3,
  approximate: 4,
  missing: 5,
};

function worstTrust(...levels: ProfitabilityTrustLevel[]): ProfitabilityTrustLevel {
  let selected: ProfitabilityTrustLevel = 'exact';
  for (const level of levels) {
    if (TRUST_RANK[level] > TRUST_RANK[selected]) {
      selected = level;
    }
  }
  return selected;
}

function derivePriceTrust(
  priceStatus?: 'live' | 'backfilled' | 'pending' | 'permanently_missing',
  source?: 'live' | 'snapshot',
): ProfitabilityTrustLevel {
  if (priceStatus === 'pending' || priceStatus === 'permanently_missing') {
    return 'missing';
  }
  if (priceStatus === 'backfilled') {
    return 'backfilled';
  }
  if (source === 'live' || priceStatus === 'live') {
    return 'exact';
  }
  return 'approximate';
}

function roundUsd(value: number): number {
  return Number.isFinite(value) ? Number(value.toFixed(8)) : 0;
}

function sumNumbers(values: number[]): number {
  return values.reduce((sum, value) => sum + value, 0);
}

function getLineageEdges(
  rebalances: RebalanceAnalytics[],
  manualLinks: ManualLink[],
  scope?: { chainId?: number; dex?: string },
): {
  byOldToken: Map<number, { oldTokenId: number; newTokenId: number; timestamp: number }>;
  byNewToken: Map<number, { oldTokenId: number; newTokenId: number; timestamp: number }>;
} {
  const byOldToken = new Map<number, { oldTokenId: number; newTokenId: number; timestamp: number }>();
  const byNewToken = new Map<number, { oldTokenId: number; newTokenId: number; timestamp: number }>();

  for (const rebalance of rebalances) {
    if (scope?.chainId !== undefined && rebalance.chainId !== undefined && rebalance.chainId !== scope.chainId) {
      continue;
    }
    if (scope?.dex !== undefined && rebalance.dex !== undefined && rebalance.dex !== scope.dex) {
      continue;
    }
    const edge = {
      oldTokenId: rebalance.oldTokenId,
      newTokenId: rebalance.newTokenId,
      timestamp: rebalance.timestamp,
    };
    byOldToken.set(rebalance.oldTokenId, edge);
    byNewToken.set(rebalance.newTokenId, edge);
  }

  for (const link of manualLinks) {
    if (scope?.chainId !== undefined && link.chainId !== undefined && link.chainId !== scope.chainId) {
      continue;
    }
    if (scope?.dex !== undefined && link.dex !== undefined && link.dex !== scope.dex) {
      continue;
    }
    if (byOldToken.has(link.oldTokenId)) {
      continue;
    }
    const edge = {
      oldTokenId: link.oldTokenId,
      newTokenId: link.newTokenId,
      timestamp: link.createdAt,
    };
    byOldToken.set(link.oldTokenId, edge);
    byNewToken.set(link.newTokenId, edge);
  }

  return { byOldToken, byNewToken };
}

export function resolveLineageContext(
  requestedTokenId: number,
  rebalances: RebalanceAnalytics[],
  manualLinks: ManualLink[],
  scope?: { chainId?: number; dex?: string },
): LineageContext {
  const { byOldToken, byNewToken } = getLineageEdges(rebalances, manualLinks, scope);

  let rootTokenId = requestedTokenId;
  const visitedBackward = new Set<number>();
  while (byNewToken.has(rootTokenId) && !visitedBackward.has(rootTokenId)) {
    visitedBackward.add(rootTokenId);
    rootTokenId = byNewToken.get(rootTokenId)!.oldTokenId;
  }

  const lineageTokenIds: number[] = [rootTokenId];
  let currentTokenId = rootTokenId;
  const visitedForward = new Set<number>();
  while (byOldToken.has(currentTokenId) && !visitedForward.has(currentTokenId)) {
    visitedForward.add(currentTokenId);
    const nextEdge = byOldToken.get(currentTokenId)!;
    currentTokenId = nextEdge.newTokenId;
    lineageTokenIds.push(currentTokenId);
  }

  const lineageTokenSet = new Set(lineageTokenIds);
  const lineageRebalances = rebalances
    .filter((rebalance) => lineageTokenSet.has(rebalance.oldTokenId) && lineageTokenSet.has(rebalance.newTokenId))
    .sort((left, right) => left.timestamp - right.timestamp);

  return {
    requestedTokenId,
    rootTokenId,
    currentTokenId,
    lineageTokenIds,
    lineageRebalances,
  };
}

function selectEntryBasis(
  tokenId: number,
  positionEntries: PositionEntryRecord[],
  snapshots: PositionSnapshot[],
): EntryBasis {
  const entries = positionEntries.filter((entry) => entry.tokenId === tokenId);
  if (entries.length > 0) {
    const latestEntry = entries[entries.length - 1];
    return {
      tokenId,
      timestamp: latestEntry.timestamp,
      entryCostUsd: latestEntry.entryCostUsd,
      gasCostUsd: latestEntry.source === 'manual' ? latestEntry.gasCostUsd : 0,
      amount0: latestEntry.amount0,
      amount1: latestEntry.amount1,
      token0Symbol: latestEntry.token0Symbol,
      token1Symbol: latestEntry.token1Symbol,
      token0Decimals: latestEntry.token0Decimals,
      token1Decimals: latestEntry.token1Decimals,
      hasEntryData: true,
      trust: derivePriceTrust(latestEntry.priceStatus),
      source: 'position_entry',
    };
  }

  const firstPricedSnapshot = snapshots
    .filter((snapshot) => snapshot.tokenId === tokenId && snapshot.positionValueUsd > 0)
    .sort((left, right) => left.timestamp - right.timestamp)[0];

  if (firstPricedSnapshot) {
    return {
      tokenId,
      timestamp: firstPricedSnapshot.timestamp,
      entryCostUsd: firstPricedSnapshot.positionValueUsd,
      gasCostUsd: 0,
      amount0: firstPricedSnapshot.amount0,
      amount1: firstPricedSnapshot.amount1,
      token0Symbol: firstPricedSnapshot.token0Symbol,
      token1Symbol: firstPricedSnapshot.token1Symbol,
      token0Decimals: firstPricedSnapshot.token0Decimals,
      token1Decimals: firstPricedSnapshot.token1Decimals,
      hasEntryData: true,
      trust: 'approximate',
      source: 'snapshot_fallback',
    };
  }

  return {
    tokenId,
    timestamp: null,
    entryCostUsd: null,
    gasCostUsd: 0,
    amount0: null,
    amount1: null,
    token0Symbol: null,
    token1Symbol: null,
    token0Decimals: null,
    token1Decimals: null,
    hasEntryData: false,
    trust: 'missing',
    source: 'missing',
  };
}

function selectCurrentState(
  currentTokenId: number,
  snapshots: PositionSnapshot[],
  liveState?: LivePositionAnalyticsState,
): { state: LivePositionAnalyticsState | null; trust: ProfitabilityTrustLevel } {
  if (liveState && liveState.tokenId === currentTokenId) {
    return {
      state: liveState,
      trust: derivePriceTrust(liveState.priceStatus, liveState.source),
    };
  }

  const latestSnapshot = snapshots
    .filter((snapshot) => snapshot.tokenId === currentTokenId)
    .sort((left, right) => left.timestamp - right.timestamp)
    .at(-1);

  if (!latestSnapshot) {
    return { state: null, trust: 'missing' };
  }

  return {
    state: {
      tokenId: currentTokenId,
      timestamp: latestSnapshot.timestamp,
      currentPositionValueUsd: latestSnapshot.positionValueUsd,
      currentUnclaimedFeesUsd: latestSnapshot.unclaimedFeesUsd,
      priceUsd0: latestSnapshot.priceUsd0,
      priceUsd1: latestSnapshot.priceUsd1,
      nativePriceUsd: latestSnapshot.nativePriceUsd,
      token0Symbol: latestSnapshot.token0Symbol,
      token1Symbol: latestSnapshot.token1Symbol,
      token0Decimals: latestSnapshot.token0Decimals,
      token1Decimals: latestSnapshot.token1Decimals,
      source: 'snapshot',
      priceStatus: latestSnapshot.priceStatus,
    },
    trust: derivePriceTrust(latestSnapshot.priceStatus, 'snapshot'),
  };
}

function estimateNativePriceUsd(
  tokenId: number,
  timestamp: number,
  snapshots: PositionSnapshot[],
  currentState: LivePositionAnalyticsState | null,
): { priceUsd: number; trust: ProfitabilityTrustLevel } {
  const tokenSnapshots = snapshots.filter((snapshot) => snapshot.tokenId === tokenId && snapshot.nativePriceUsd > 0);
  if (tokenSnapshots.length > 0) {
    const nearest = tokenSnapshots.reduce((best, snapshot) => {
      if (!best) return snapshot;
      return Math.abs(snapshot.timestamp - timestamp) < Math.abs(best.timestamp - timestamp) ? snapshot : best;
    }, tokenSnapshots[0]);

    return {
      priceUsd: nearest.nativePriceUsd,
      trust: derivePriceTrust(nearest.priceStatus, 'snapshot'),
    };
  }

  if (currentState && currentState.nativePriceUsd > 0) {
    return { priceUsd: currentState.nativePriceUsd, trust: 'estimated' };
  }

  return { priceUsd: 0, trust: 'missing' };
}

function computeRebalanceFeesUsd(rebalance: RebalanceAnalytics): { valueUsd: number; trust: ProfitabilityTrustLevel } {
  if (typeof rebalance.feesCollectedUsd === 'number') {
    return {
      valueUsd: rebalance.feesCollectedUsd,
      trust: derivePriceTrust(rebalance.priceStatus),
    };
  }

  const priceUsd0 = rebalance.priceUsd0 ?? rebalance.preSnapshot.priceUsd0;
  const priceUsd1 = rebalance.priceUsd1 ?? rebalance.preSnapshot.priceUsd1;
  const feesUsd =
    bigintToFloat(rebalance.feesCollected0, rebalance.preSnapshot.token0Decimals) * priceUsd0 +
    bigintToFloat(rebalance.feesCollected1, rebalance.preSnapshot.token1Decimals) * priceUsd1;

  return {
    valueUsd: feesUsd,
    trust: derivePriceTrust(rebalance.preSnapshot.priceStatus, 'snapshot'),
  };
}

function computeRebalanceGasUsd(
  rebalance: RebalanceAnalytics,
  currentState: LivePositionAnalyticsState | null,
): { valueUsd: number; trust: ProfitabilityTrustLevel } {
  if (typeof rebalance.gasCostUsd === 'number') {
    return {
      valueUsd: rebalance.gasCostUsd,
      trust: derivePriceTrust(rebalance.priceStatus),
    };
  }

  const nativePriceUsd = rebalance.nativeTokenPriceUsd ?? rebalance.preSnapshot.nativePriceUsd ?? currentState?.nativePriceUsd ?? 0;
  const trust = rebalance.nativeTokenPriceUsd || rebalance.preSnapshot.nativePriceUsd
    ? derivePriceTrust(rebalance.preSnapshot.priceStatus, 'snapshot')
    : currentState?.nativePriceUsd
      ? 'estimated'
      : 'missing';

  return {
    valueUsd: rebalance.totalGasCostPLS * nativePriceUsd,
    trust,
  };
}

function computeFeeCollectionGasUsd(
  feeCollection: FeeCollectionRecord,
  snapshots: PositionSnapshot[],
  currentState: LivePositionAnalyticsState | null,
): { valueUsd: number; trust: ProfitabilityTrustLevel } {
  const nativePrice = estimateNativePriceUsd(feeCollection.tokenId, feeCollection.timestamp, snapshots, currentState);
  return {
    valueUsd: feeCollection.gasCostPLS * nativePrice.priceUsd,
    trust: nativePrice.trust,
  };
}

function computeHodlValueUsd(
  basis: EntryBasis,
  currentState: LivePositionAnalyticsState | null,
): { valueUsd: number | null; trust: ProfitabilityTrustLevel } {
  if (!basis.hasEntryData || !currentState || basis.amount0 === null || basis.amount1 === null) {
    return { valueUsd: null, trust: 'missing' };
  }

  if (
    basis.token0Symbol !== currentState.token0Symbol ||
    basis.token1Symbol !== currentState.token1Symbol ||
    basis.token0Decimals !== currentState.token0Decimals ||
    basis.token1Decimals !== currentState.token1Decimals
  ) {
    return { valueUsd: null, trust: 'missing' };
  }

  const hodlValueUsd =
    bigintToFloat(basis.amount0, currentState.token0Decimals) * currentState.priceUsd0 +
    bigintToFloat(basis.amount1, currentState.token1Decimals) * currentState.priceUsd1;

  return {
    valueUsd: hodlValueUsd,
    trust: worstTrust(basis.trust, derivePriceTrust(currentState.priceStatus, currentState.source)),
  };
}

function buildTrustBreakdown(
  basis: ProfitabilityTrustLevel,
  currentValue: ProfitabilityTrustLevel,
  fees: ProfitabilityTrustLevel,
  costs: ProfitabilityTrustLevel,
  hodl: ProfitabilityTrustLevel,
): ProfitabilityTrustBreakdown {
  return {
    basis,
    currentValue,
    fees,
    costs,
    hodl,
    overall: worstTrust(basis, currentValue, fees, costs, hodl),
  };
}

export function buildLineageAnalyticsSummary(params: {
  requestedTokenId: number;
  requestedChainId?: number;
  requestedDex?: string;
  rebalances: RebalanceAnalytics[];
  feeCollections: FeeCollectionRecord[];
  snapshots: PositionSnapshot[];
  positionEntries: PositionEntryRecord[];
  manualLinks: ManualLink[];
  liveState?: LivePositionAnalyticsState;
}): LineageAnalyticsSummary {
  const scope = { chainId: params.requestedChainId, dex: params.requestedDex };
  const lineage = resolveLineageContext(params.requestedTokenId, params.rebalances, params.manualLinks, scope);
  const lineageTokenSet = new Set(lineage.lineageTokenIds);
  const lineageSnapshots = params.snapshots
    .filter((snapshot) => lineageTokenSet.has(snapshot.tokenId) && (!scope.chainId || snapshot.chainId === undefined || snapshot.chainId === scope.chainId) && (!scope.dex || snapshot.dex === undefined || snapshot.dex === scope.dex))
    .sort((left, right) => left.timestamp - right.timestamp);
  const lineageFeeCollections = params.feeCollections
    .filter((feeCollection) => lineageTokenSet.has(feeCollection.tokenId) && (!scope.chainId || feeCollection.chainId === undefined || feeCollection.chainId === scope.chainId) && (!scope.dex || feeCollection.dex === undefined || feeCollection.dex === scope.dex))
    .sort((left, right) => left.timestamp - right.timestamp);
  const lineageEntries = params.positionEntries
    .filter((entry) => lineageTokenSet.has(entry.tokenId) && (!scope.chainId || entry.chainId === undefined || entry.chainId === scope.chainId) && (!scope.dex || entry.dex === undefined || entry.dex === scope.dex))
    .sort((left, right) => left.timestamp - right.timestamp);
  const { state: currentState, trust: currentValueTrust } = selectCurrentState(
    lineage.currentTokenId,
    lineageSnapshots,
    params.liveState,
  );

  const currentBasis = selectEntryBasis(lineage.currentTokenId, lineageEntries, lineageSnapshots);
  const rootBasis = selectEntryBasis(lineage.rootTokenId, lineageEntries, lineageSnapshots);

  const currentIntervalFeeCollections = lineageFeeCollections.filter((feeCollection) => feeCollection.tokenId === lineage.currentTokenId);
  const currentIntervalClaimedFeesUsd = sumNumbers(currentIntervalFeeCollections.map((feeCollection) => feeCollection.totalValueUsd));
  const currentIntervalGasEntries = currentIntervalFeeCollections.map((feeCollection) =>
    computeFeeCollectionGasUsd(feeCollection, lineageSnapshots, currentState),
  );
  const currentIntervalGasCostUsd = sumNumbers(currentIntervalGasEntries.map((entry) => entry.valueUsd)) + currentBasis.gasCostUsd;
  const currentIntervalGasTrust = currentBasis.gasCostUsd > 0
    ? worstTrust(currentBasis.trust, ...currentIntervalGasEntries.map((entry) => entry.trust))
    : currentIntervalGasEntries.length > 0
      ? worstTrust(...currentIntervalGasEntries.map((entry) => entry.trust))
      : 'event_time_exact';
  const currentIntervalHodl = computeHodlValueUsd(currentBasis, currentState);
  const currentIntervalUnclaimedFeesUsd = currentState?.currentUnclaimedFeesUsd ?? 0;
  const currentIntervalCurrentPositionValueUsd = currentState?.currentPositionValueUsd ?? 0;
  const currentIntervalTotalFeesUsd = currentIntervalClaimedFeesUsd + currentIntervalUnclaimedFeesUsd;
  const currentIntervalTotalCostsUsd = currentIntervalGasCostUsd;
  const currentIntervalNetIncomeUsd = currentIntervalTotalFeesUsd - currentIntervalTotalCostsUsd;
  const currentIntervalTruePnlUsd = currentBasis.entryCostUsd !== null
    ? currentIntervalCurrentPositionValueUsd + currentIntervalTotalFeesUsd - currentBasis.entryCostUsd - currentIntervalTotalCostsUsd
    : null;
  const currentIntervalTruePnlPercent = currentIntervalTruePnlUsd !== null && currentBasis.entryCostUsd && currentBasis.entryCostUsd > 0
    ? (currentIntervalTruePnlUsd / currentBasis.entryCostUsd) * 100
    : null;
  const currentIntervalLpVsHodlUsd = currentIntervalHodl.valueUsd !== null
    ? currentIntervalCurrentPositionValueUsd + currentIntervalTotalFeesUsd - currentIntervalTotalCostsUsd - currentIntervalHodl.valueUsd
    : null;
  const currentIntervalLpVsHodlPercent = currentIntervalLpVsHodlUsd !== null && currentIntervalHodl.valueUsd && currentIntervalHodl.valueUsd > 0
    ? (currentIntervalLpVsHodlUsd / currentIntervalHodl.valueUsd) * 100
    : null;
  const currentIntervalStartTimestamp = currentBasis.timestamp;
  const currentIntervalEndTimestamp = currentState?.timestamp ?? null;
  const currentIntervalDurationDays = currentIntervalStartTimestamp !== null && currentIntervalEndTimestamp !== null
    ? (currentIntervalEndTimestamp - currentIntervalStartTimestamp) / (1000 * 86400)
    : null;
  const currentIntervalFeesTrust = currentState
    ? derivePriceTrust(currentState.priceStatus, currentState.source)
    : currentIntervalFeeCollections.length > 0
      ? 'event_time_exact'
      : 'exact';

  const lifetimeClaimedFeeEntries = lineage.lineageRebalances.map((rebalance) => computeRebalanceFeesUsd(rebalance));
  const lifetimeManualFeeUsd = sumNumbers(lineageFeeCollections.map((feeCollection) => feeCollection.totalValueUsd));
  const lifetimeClaimedFeesUsd = sumNumbers(lifetimeClaimedFeeEntries.map((entry) => entry.valueUsd)) + lifetimeManualFeeUsd;
  const lifetimeGasEntries = lineage.lineageRebalances.map((rebalance) => computeRebalanceGasUsd(rebalance, currentState));
  const lifetimeManualGasEntries = lineageFeeCollections.map((feeCollection) =>
    computeFeeCollectionGasUsd(feeCollection, lineageSnapshots, currentState),
  );
  const lifetimeGasCostUsd =
    sumNumbers(lifetimeGasEntries.map((entry) => entry.valueUsd)) +
    sumNumbers(lifetimeManualGasEntries.map((entry) => entry.valueUsd)) +
    rootBasis.gasCostUsd;
  const lifetimeSwapFrictionUsd = sumNumbers(lineage.lineageRebalances.map((rebalance) => rebalance.swapFrictionUsd ?? 0));
  const lifetimePriceDisadvantageUsd = sumNumbers(
    lineage.lineageRebalances.map((rebalance) => rebalance.priceDisadvantageUsd ?? rebalance.crystallizedIlUsd ?? 0),
  );
  const lifetimeTotalCostsUsd = lifetimeGasCostUsd + lifetimeSwapFrictionUsd;
  const lifetimeUnclaimedFeesUsd = currentState?.currentUnclaimedFeesUsd ?? 0;
  const lifetimeCurrentPositionValueUsd = currentState?.currentPositionValueUsd ?? 0;
  const lifetimeTotalFeesUsd = lifetimeClaimedFeesUsd + lifetimeUnclaimedFeesUsd;
  const lifetimeNetIncomeUsd = lifetimeTotalFeesUsd - lifetimeTotalCostsUsd;
  const lifetimeHodl = computeHodlValueUsd(rootBasis, currentState);
  const lifetimeTruePnlUsd = rootBasis.entryCostUsd !== null
    ? lifetimeCurrentPositionValueUsd + lifetimeTotalFeesUsd - rootBasis.entryCostUsd - lifetimeTotalCostsUsd
    : null;
  const lifetimeTruePnlPercent = lifetimeTruePnlUsd !== null && rootBasis.entryCostUsd && rootBasis.entryCostUsd > 0
    ? (lifetimeTruePnlUsd / rootBasis.entryCostUsd) * 100
    : null;
  const lifetimeLpVsHodlUsd = lifetimeHodl.valueUsd !== null
    ? lifetimeCurrentPositionValueUsd + lifetimeTotalFeesUsd - lifetimeTotalCostsUsd - lifetimeHodl.valueUsd
    : null;
  const lifetimeLpVsHodlPercent = lifetimeLpVsHodlUsd !== null && lifetimeHodl.valueUsd && lifetimeHodl.valueUsd > 0
    ? (lifetimeLpVsHodlUsd / lifetimeHodl.valueUsd) * 100
    : null;

  const firstSeenCandidates = [
    rootBasis.timestamp,
    lineageSnapshots[0]?.timestamp,
    lineage.lineageRebalances[0]?.timestamp,
  ].filter((value): value is number => typeof value === 'number');
  const lastSeenCandidates = [
    currentState?.timestamp,
    lineageSnapshots.at(-1)?.timestamp,
    lineage.lineageRebalances.at(-1)?.timestamp,
  ].filter((value): value is number => typeof value === 'number');

  const currentIntervalTrust = buildTrustBreakdown(
    currentBasis.trust,
    currentValueTrust,
    currentIntervalFeesTrust,
    currentIntervalGasTrust,
    currentIntervalHodl.trust,
  );
  const lifetimeFeesTrust = lifetimeClaimedFeeEntries.length > 0
    ? worstTrust(...lifetimeClaimedFeeEntries.map((entry) => entry.trust), currentValueTrust)
    : currentValueTrust;
  const lifetimeCostsTrust = worstTrust(
    ...lifetimeGasEntries.map((entry) => entry.trust),
    ...lifetimeManualGasEntries.map((entry) => entry.trust),
    lifetimeSwapFrictionUsd > 0 ? lifetimeFeesTrust : 'event_time_exact',
    rootBasis.gasCostUsd > 0 ? rootBasis.trust : 'event_time_exact',
  );
  const lifetimeTrust = buildTrustBreakdown(
    rootBasis.trust,
    currentValueTrust,
    lifetimeFeesTrust,
    lifetimeCostsTrust,
    lifetimeHodl.trust,
  );

  return {
    lineage,
    currentInterval: {
      tokenId: lineage.currentTokenId,
      startTimestamp: currentIntervalStartTimestamp,
      endTimestamp: currentIntervalEndTimestamp,
      durationDays: currentIntervalDurationDays !== null ? roundUsd(currentIntervalDurationDays) : null,
      claimedFeesUsd: roundUsd(currentIntervalClaimedFeesUsd),
      unclaimedFeesUsd: roundUsd(currentIntervalUnclaimedFeesUsd),
      totalFeesUsd: roundUsd(currentIntervalTotalFeesUsd),
      currentPositionValueUsd: roundUsd(currentIntervalCurrentPositionValueUsd),
      totalGasCostUsd: roundUsd(currentIntervalGasCostUsd),
      totalSwapFrictionUsd: 0,
      totalPriceDisadvantageUsd: 0,
      totalCostsUsd: roundUsd(currentIntervalTotalCostsUsd),
      netIncomeUsd: roundUsd(currentIntervalNetIncomeUsd),
      entryCostUsd: currentBasis.entryCostUsd !== null ? roundUsd(currentBasis.entryCostUsd) : null,
      hodlValueUsd: currentIntervalHodl.valueUsd !== null ? roundUsd(currentIntervalHodl.valueUsd) : null,
      truePnlUsd: currentIntervalTruePnlUsd !== null ? roundUsd(currentIntervalTruePnlUsd) : null,
      truePnlPercent: currentIntervalTruePnlPercent !== null ? roundUsd(currentIntervalTruePnlPercent) : null,
      lpVsHodlUsd: currentIntervalLpVsHodlUsd !== null ? roundUsd(currentIntervalLpVsHodlUsd) : null,
      lpVsHodlPercent: currentIntervalLpVsHodlPercent !== null ? roundUsd(currentIntervalLpVsHodlPercent) : null,
      hasEntryData: currentBasis.hasEntryData,
      trust: currentIntervalTrust,
    },
    lifetimeChain: {
      requestedTokenId: lineage.requestedTokenId,
      rootTokenId: lineage.rootTokenId,
      currentTokenId: lineage.currentTokenId,
      lineageTokenIds: lineage.lineageTokenIds,
      firstSeen: firstSeenCandidates.length > 0 ? Math.min(...firstSeenCandidates) : null,
      lastSeen: lastSeenCandidates.length > 0 ? Math.max(...lastSeenCandidates) : null,
      totalRebalances: lineage.lineageRebalances.length,
      totalManualCollections: lineageFeeCollections.length,
      claimedFeesUsd: roundUsd(lifetimeClaimedFeesUsd),
      unclaimedFeesUsd: roundUsd(lifetimeUnclaimedFeesUsd),
      totalFeesUsd: roundUsd(lifetimeTotalFeesUsd),
      currentPositionValueUsd: roundUsd(lifetimeCurrentPositionValueUsd),
      totalGasCostUsd: roundUsd(lifetimeGasCostUsd),
      totalSwapFrictionUsd: roundUsd(lifetimeSwapFrictionUsd),
      totalPriceDisadvantageUsd: roundUsd(lifetimePriceDisadvantageUsd),
      totalCostsUsd: roundUsd(lifetimeTotalCostsUsd),
      netIncomeUsd: roundUsd(lifetimeNetIncomeUsd),
      entryCostUsd: rootBasis.entryCostUsd !== null ? roundUsd(rootBasis.entryCostUsd) : null,
      hodlValueUsd: lifetimeHodl.valueUsd !== null ? roundUsd(lifetimeHodl.valueUsd) : null,
      truePnlUsd: lifetimeTruePnlUsd !== null ? roundUsd(lifetimeTruePnlUsd) : null,
      truePnlPercent: lifetimeTruePnlPercent !== null ? roundUsd(lifetimeTruePnlPercent) : null,
      lpVsHodlUsd: lifetimeLpVsHodlUsd !== null ? roundUsd(lifetimeLpVsHodlUsd) : null,
      lpVsHodlPercent: lifetimeLpVsHodlPercent !== null ? roundUsd(lifetimeLpVsHodlPercent) : null,
      hasEntryData: rootBasis.hasEntryData,
      trust: lifetimeTrust,
    },
  };
}
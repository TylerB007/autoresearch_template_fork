/**
 * In-memory cache for fast CLI queries and recent analytics data.
 * Stores latest snapshot per position and last N rebalances.
 * No disk I/O — populated from collector at runtime.
 */

import type { PositionSnapshot, RebalanceAnalytics, RebalanceLifecycleEvent } from './types.js';

const MAX_REBALANCE_RECORDS = 100;
const MAX_EVENT_RECORDS = 500;

interface CacheState {
  latestSnapshots: Map<number, PositionSnapshot>;
  recentRebalances: RebalanceAnalytics[];
  recentEvents: RebalanceLifecycleEvent[];
  botStartTime: number;
}

const cache: CacheState = {
  latestSnapshots: new Map(),
  recentRebalances: [],
  recentEvents: [],
  botStartTime: Date.now(),
};

export function updateSnapshotCache(snapshot: PositionSnapshot): void {
  cache.latestSnapshots.set(snapshot.tokenId, snapshot);
}

export function updateEventCache(event: RebalanceLifecycleEvent): void {
  cache.recentEvents.push(event);
  if (cache.recentEvents.length > MAX_EVENT_RECORDS) {
    cache.recentEvents.shift();
  }
}

export function getRecentEvents(limit: number = 50): RebalanceLifecycleEvent[] {
  return cache.recentEvents.slice(-limit);
}

export function getEventsForRebalance(rebalanceId: string): RebalanceLifecycleEvent[] {
  return cache.recentEvents.filter(e => e.rebalanceId === rebalanceId);
}

export function updateRebalanceCache(analytics: RebalanceAnalytics): void {
  cache.recentRebalances.push(analytics);
  if (cache.recentRebalances.length > MAX_REBALANCE_RECORDS) {
    cache.recentRebalances.shift();
  }
  // Also update snapshot cache with post-rebalance snapshot
  cache.latestSnapshots.set(analytics.newTokenId, analytics.postSnapshot);
}

export function getLatestSnapshot(tokenId: number): PositionSnapshot | undefined {
  return cache.latestSnapshots.get(tokenId);
}

export function getAllLatestSnapshots(): PositionSnapshot[] {
  return Array.from(cache.latestSnapshots.values());
}

export function getRecentRebalances(limit: number = 10): RebalanceAnalytics[] {
  return cache.recentRebalances.slice(-limit);
}

export function getRebalancesForPosition(tokenId: number): RebalanceAnalytics[] {
  return cache.recentRebalances.filter(
    (r) => r.oldTokenId === tokenId || r.newTokenId === tokenId,
  );
}

export function getTotalGasSpent(): number {
  return cache.recentRebalances.reduce((sum, r) => sum + r.totalGasCostPLS, 0);
}

export function getTotalRebalanceCount(): number {
  return cache.recentRebalances.length;
}

export function getBotUptime(): number {
  return (Date.now() - cache.botStartTime) / 1000;
}

export function resetCache(): void {
  cache.latestSnapshots.clear();
  cache.recentRebalances.length = 0;
  cache.recentEvents.length = 0;
  cache.botStartTime = Date.now();
}

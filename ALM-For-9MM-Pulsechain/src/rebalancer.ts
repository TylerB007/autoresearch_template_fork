/**
 * Rebalancer — orchestrates the full rebalance flow:
 * pre-checks → collect fees → remove liquidity → swap → mint new position
 *
 * Includes error recovery with safe mode and config.yaml token ID update
 */

import { readFileSync, writeFileSync, existsSync, unlinkSync, renameSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { ethers } from 'ethers';
import type { ContractInstances } from './contracts.js';
import type { ChainContext } from './chain.js';
import type {
  AppConfig,
  PositionConfig,
  StrategyType,
  RebalanceResult,
  CollectResult,
  RemoveLiquidityResult,
  MintResult,
  RecoveryState,
  IncreaseLiquidityResult,
  DecreaseLiquidityResult,
} from './types.js';
import type { GasUsageData, RebalanceTxHashes, TriggerEvent, TriggerType, TriggerAction } from './analytics/types.js';
import type { AnalyticsCollector } from './analytics/collector.js';
import { MAX_UINT128, GAS_LIMITS, DEFAULT_DEADLINE_MINUTES } from './config/index.js';
import { verifyOwnership, getPositionStatus } from './position.js';
import { getPoolState } from './pool.js';
import { evaluateStrategy, parseStrategy } from './strategy.js';
import { calculateSwapAmount, getAmountsForLiquidity, getLiquidityForAmounts, tickToSqrtPriceX96, ticksToPercentage } from './math.js';
import { executeSwap, ensureApproval } from './swap.js';
import { getChainConfig } from './config/chains.js';
import { sendNotification } from './notifications.js';
import { queryRebalances } from './analytics/storage.js';
import { getTokenPrices } from './server/services/priceService.js';
import { resolveEventPrices } from './pricing/index.js';
import { isKillSwitchTriggered, evaluateKillSwitch } from './killSwitch.js';
import { evaluateCostBenefit } from './costBenefit.js';
import { isPositionStaked, withdrawFromGauge, depositToGauge } from './gauges.js';
import { bigintToFloat, bigintWeiToFloat } from './bigintFloat.js';
import logger from './logger.js';

/**
 * Build a human-readable position label for notifications.
 * Includes token pair and chain name when available.
 */
function posLabel(tokenId: number, t0?: string, t1?: string, chainName?: string): string {
  if (t0 && t1 && chainName) return `#${tokenId} (${t0}/${t1} on ${chainName})`;
  if (t0 && t1) return `#${tokenId} (${t0}/${t1})`;
  if (chainName) return `#${tokenId} on ${chainName}`;
  return `#${tokenId}`;
}

/**
 * Emit a structured TriggerEvent for every monitoring-cycle decision.
 * Includes both "rebalance" outcomes and "hold" / "skip" outcomes.
 * Fire-and-forget: never throws.
 */
async function emitTriggerEvent(
  analyticsCollector: import('./analytics/collector.js').AnalyticsCollector | null | undefined,
  tokenId: number,
  chainId: number,
  triggerType: TriggerType,
  actionTaken: TriggerAction,
  actionReason: string,
  status: import('./types.js').PositionStatus,
  linkedRebalanceId?: string,
): Promise<void> {
  if (!analyticsCollector) return;
  try {
    const d0 = status.token0Info.decimals;
    const d1 = status.token1Info.decimals;
    const currentTick = status.pool.currentTick;

    // Compute human-readable price ratio from sqrtPriceX96
    let priceRatio: number | undefined;
    try {
      const { sqrtPriceX96ToPrice } = await import('./bigintFloat.js');
      const rawRatio = sqrtPriceX96ToPrice(status.pool.sqrtPriceX96);
      if (rawRatio > 0) {
        priceRatio = rawRatio * (10 ** (d0 - d1));
      }
    } catch { /* non-critical */ }

    // Distance to nearest edge as % of price
    let distanceToNearestEdgePct: number | undefined;
    if (priceRatio !== undefined && priceRatio > 0) {
      const lowerPrice = Math.pow(1.0001, status.position.tickLower) * (10 ** d0) / (10 ** d1);
      const upperPrice = Math.pow(1.0001, status.position.tickUpper) * (10 ** d0) / (10 ** d1);
      const distToLower = Math.abs((priceRatio - lowerPrice) / priceRatio) * 100;
      const distToUpper = Math.abs((upperPrice - priceRatio) / priceRatio) * 100;
      distanceToNearestEdgePct = Math.min(distToLower, distToUpper);
    }

    // Range width %
    let widthPct: number | undefined;
    if (priceRatio !== undefined && priceRatio > 0) {
      const lowerPrice = Math.pow(1.0001, status.position.tickLower) * (10 ** d0) / (10 ** d1);
      const upperPrice = Math.pow(1.0001, status.position.tickUpper) * (10 ** d0) / (10 ** d1);
      widthPct = ((upperPrice - lowerPrice) / priceRatio) * 100;
    }

    const { randomUUID } = await import('node:crypto');
    const event: TriggerEvent = {
      triggerEventId: randomUUID(),
      tokenId,
      chainId,
      timestamp: Date.now(),
      triggerType,
      priceRatio,
      tickLower: status.position.tickLower,
      tickUpper: status.position.tickUpper,
      currentTick,
      widthPct,
      distanceToNearestEdgePct,
      inRange: status.isInRange,
      actionTaken,
      actionReason,
      linkedRebalanceId,
    };

    await analyticsCollector.emitTriggerEvent(event, chainId);
  } catch {
    // Non-critical — never let trigger event emission break rebalance flow
  }
}

/**
 * Validate that sqrtPriceX96 is consistent with currentTick.
 * Prevents corrupted RPC data from producing impossible slippage parameters.
 */
function validateSqrtPrice(sqrtPriceX96: bigint, currentTick: number, label: string): void {
  const lower = tickToSqrtPriceX96(currentTick - 1);
  const upper = tickToSqrtPriceX96(currentTick + 1);
  if (sqrtPriceX96 < lower || sqrtPriceX96 > upper) {
    const expected = tickToSqrtPriceX96(currentTick);
    throw new Error(
      `${label}: sqrtPriceX96 ${sqrtPriceX96} inconsistent with tick ${currentTick} ` +
      `(expected ~${expected}, range ${lower}–${upper}). Aborting to prevent bad slippage calculation.`,
    );
  }
}

// ── Composite key for multi-chain state maps ────────────────────────────────
// Token IDs are only unique within a chain, so all state maps use
// a composite "chainId-tokenId" string key.
export function posKey(chainId: number, tokenId: number): string {
  return `${chainId}-${tokenId}`;
}

// Recovery state file — per-chain, written before liquidity removal, deleted after successful mint
export function recoveryStatePath(chainId: number): string {
  return resolve(process.cwd(), `.recovery-state-${chainId}.json`);
}
/** @deprecated Use recoveryStatePath(chainId) — kept for backward compat migration */
export const RECOVERY_STATE_PATH = resolve(process.cwd(), '.recovery-state.json');

function writeRecoveryState(state: RecoveryState, chainId: number): void {
  // Recovery state MUST be written before burn — if this fails, we must NOT proceed
  // because stranded funds would be undetectable after a crash.
  writeFileSync(recoveryStatePath(chainId), JSON.stringify(state, null, 2));
  logger.info(`Recovery state saved for position ${state.oldTokenId} on chain ${chainId}`);
}

export function clearRecoveryState(chainId: number): void {
  try {
    const path = recoveryStatePath(chainId);
    if (existsSync(path)) {
      unlinkSync(path);
      logger.info(`Recovery state cleared for chain ${chainId} (rebalance completed successfully)`);
    }
    // Also clean up legacy file if it exists
    if (existsSync(RECOVERY_STATE_PATH)) {
      unlinkSync(RECOVERY_STATE_PATH);
    }
  } catch (error) {
    logger.warn(`Failed to clear recovery state: ${error}`);
  }
}

// Track cooldowns, safe mode, and active rebalances per position (composite keys)
const lastRebalanceTime = new Map<string, number>();
const safeModePositions = new Set<string>();
export const rebalancingPositions = new Set<string>();
const transientFailureCount = new Map<string, number>();

// ── Auto-disable: stop polling burned/unowned positions after N failures ─────
// Prevents wasting RPC calls every cycle on positions that no longer exist.
const ownershipFailureCount = new Map<string, number>();
const autoDisabledPositions = new Set<string>();
const MAX_OWNERSHIP_FAILURES = 5; // disable after 5 consecutive failures
let ownershipDisableNotified = new Set<string>(); // one Telegram alert per position

/** Check if a position has been auto-disabled due to repeated ownership failures. */
export function isAutoDisabled(pk: string): boolean {
  return autoDisabledPositions.has(pk);
}

/** Re-enable an auto-disabled position (e.g. after config fix via /removestale or /enable). */
export function clearAutoDisabled(pk: string): boolean {
  ownershipFailureCount.delete(pk);
  ownershipDisableNotified.delete(pk);
  return autoDisabledPositions.delete(pk);
}

// ── Cross-process rebalance lock files ───────────────────────────────────────
// The bot (9mm-rebalancer) and dashboard (9mm-dashboard) run as separate PM2
// processes with independent in-memory state. The lock file lets the dashboard
// detect when the bot has an active rebalance before issuing on-chain txs that
// would race on nonce assignment.
const LOCK_DIR = resolve(process.cwd());
function rebalanceLockPath(chainId: number, tokenId: number): string {
  return resolve(LOCK_DIR, `.rebalance-lock-${chainId}-${tokenId}`);
}
export function acquireRebalanceLock(chainId: number, tokenId: number): void {
  writeFileSync(rebalanceLockPath(chainId, tokenId), Date.now().toString());
}
export function releaseRebalanceLock(chainId: number, tokenId: number): void {
  try { unlinkSync(rebalanceLockPath(chainId, tokenId)); } catch { /* already gone */ }
}
export function isRebalanceLocked(chainId: number, tokenId: number): boolean {
  const lockPath = rebalanceLockPath(chainId, tokenId);
  if (!existsSync(lockPath)) return false;
  // Treat a lock older than 10 minutes as stale (bot crash mid-rebalance)
  try {
    const ts = parseInt(readFileSync(lockPath, 'utf8'), 10);
    if (Date.now() - ts > 10 * 60 * 1000) {
      unlinkSync(lockPath);
      return false;
    }
  } catch { /* unreadable — treat as stale */ return false; }
  return true;
}
const MAX_TRANSIENT_RETRIES = 5; // Enter safe mode after 5 consecutive transient failures

// Track when a position was first seen out of range (for confirm_minutes delay)
// Exported so Telegram /status can show time-out-of-range (uses composite keys)
export const outOfRangeSince = new Map<string, number>();

// ── Anti-churn: rebalance history for escalating cooldowns ──────────────────
interface RebalanceHistoryEntry {
  timestamp: number;
  widthTicks: number;
}
export const rebalanceHistory = new Map<string, RebalanceHistoryEntry[]>();

// ── Gas warning deduplication: 1 grouped notification per chain per 24h ─────
// PulseChain uses a 1-PLS reserve (gas is extremely cheap); all other chains
// use 0.005 native units so Ethereum doesn't require an absurd 1-ETH buffer.
const GAS_RESERVE_BY_CHAIN: Record<number, string> = {
  369: '1',       // PulseChain — 1 PLS is negligible
  1: '0.005',     // Ethereum
  8453: '0.005',  // Base
  42161: '0.005', // Arbitrum One
  146: '0.005',   // Sonic
};
interface GasWarning { tokenId: number | string; have: string; need: string; symbol: string; chainName: string; }
const gasWarningQueue = new Map<number, GasWarning[]>();
const lastGasNotifTime = new Map<number, number>();
const GAS_NOTIF_COOLDOWN_MS = 24 * 60 * 60 * 1000;

/**
 * Send grouped gas-insufficiency notifications — at most once per chain per 24h.
 * Must be called after the monitoring cycle processes all positions.
 */
export async function flushGasWarnings(config: AppConfig): Promise<void> {
  for (const [chainId, warnings] of gasWarningQueue) {
    if (warnings.length === 0) continue;
    const last = lastGasNotifTime.get(chainId) ?? 0;
    if (Date.now() - last < GAS_NOTIF_COOLDOWN_MS) continue;

    const { chainName, symbol } = warnings[0];
    let msg: string;
    if (warnings.length === 1) {
      const w = warnings[0];
      msg = `⚠️ Insufficient gas on ${chainName}: wallet has ${w.have} ${symbol} but rebalance for #${w.tokenId} needs ${w.need}. Please top up.`;
    } else {
      const lines = warnings.map(w => `  • #${w.tokenId}: have ${w.have} ${symbol}, need ${w.need} ${symbol}`).join('\n');
      msg = `⚠️ Insufficient gas on ${chainName} for ${warnings.length} positions:\n${lines}\nPlease top up.`;
    }
    await sendNotification(msg, config, 'critical').catch(() => {});
    lastGasNotifTime.set(chainId, Date.now());
  }
  gasWarningQueue.clear();
}

// ── Safe mode control — exported for Telegram commands ───────────────────────

/**
 * Clear safe mode for a specific position composite key ("chainId-tokenId").
 * Only call this when the operator has reviewed the situation and confirmed
 * it is safe to resume. Does NOT clear recovery state files — those require
 * the /recover flow to mint a new position first.
 * Returns true if the position was actually in safe mode.
 */
export function clearSafeMode(pk: string): boolean {
  const existed = safeModePositions.has(pk);
  safeModePositions.delete(pk);
  if (existed) logger.info(`Safe mode cleared for position key ${pk}`);
  return existed;
}

/** Check if a position is currently in safe mode. */
export function isSafeMode(pk: string): boolean {
  return safeModePositions.has(pk);
}

/** Return all composite keys currently in safe mode. Used by /status and /enable. */
export function getSafeModePositions(): string[] {
  return Array.from(safeModePositions);
}

/**
 * Returns the lock age in ms if a rebalance lock is active, or null if unlocked.
 * Mirrors the stale-lock logic in isRebalanceLocked() (>10 min = stale = null).
 * Used by the dashboard to show "REBALANCING..." status on position cards.
 */
export function getRebalanceLockAgeMs(chainId: number, tokenId: number): number | null {
  const lockPath = rebalanceLockPath(chainId, tokenId);
  if (!existsSync(lockPath)) return null;
  try {
    const age = Date.now() - parseInt(readFileSync(lockPath, 'utf8'), 10);
    if (age > 10 * 60 * 1000) return null; // Stale — treated as released
    return age;
  } catch { return null; }
}

/** Write a file recording when a position first went out of range (cross-process IPC). */
export function writeOorSince(chainId: number, tokenId: number, sinceMs: number): void {
  try { writeFileSync(resolve(LOCK_DIR, `.oor-since-${chainId}-${tokenId}`), sinceMs.toString()); } catch { /* ignore */ }
}
/** Delete the OOR-since file when a position comes back in range or rebalances. */
export function deleteOorSince(chainId: number, tokenId: number): void {
  try { unlinkSync(resolve(LOCK_DIR, `.oor-since-${chainId}-${tokenId}`)); } catch { /* ignore */ }
}

/**
 * Get the number of recent rebalances within the churn window.
 */
function getRecentRebalanceCount(key: string, windowHours: number): number {
  const history = rebalanceHistory.get(key) ?? [];
  const windowMs = windowHours * 3600 * 1000;
  const cutoff = Date.now() - windowMs;
  return history.filter((h) => h.timestamp > cutoff).length;
}

/**
 * Calculate an escalated cooldown based on how many recent rebalances occurred.
 * Returns Infinity when auto-widen should trigger instead.
 */
function getEscalatedCooldown(
  key: string,
  baseCooldown: number,
  windowHours: number,
  maxRebalancesPerWindow: number,
): number {
  const recentCount = getRecentRebalanceCount(key, windowHours);
  if (recentCount === 0) return baseCooldown;
  if (recentCount === 1) return Math.max(baseCooldown, 3600);   // 60 min
  if (recentCount === 2) return Math.max(baseCooldown, 7200);   // 120 min
  if (recentCount >= maxRebalancesPerWindow) return Infinity;    // signal auto-widen
  return Math.max(baseCooldown, 7200);
}

/**
 * Prune old entries from rebalance history beyond the churn window.
 */
function pruneRebalanceHistory(key: string, windowHours: number): void {
  const history = rebalanceHistory.get(key);
  if (!history) return;
  const cutoff = Date.now() - windowHours * 3600 * 1000;
  const pruned = history.filter((h) => h.timestamp > cutoff);
  if (pruned.length === 0) rebalanceHistory.delete(key);
  else rebalanceHistory.set(key, pruned);
}

/**
 * Determine if auto-width escalation should occur and compute the new strategy.
 */
function computeAutoWiden(
  posConfig: PositionConfig,
  defaultChainId: number,
): { newStrategy: string; newWidth: number } | null {
  const maxRebalances = posConfig.params.max_rebalances_per_window ?? 3;
  const windowHours = posConfig.params.churn_window_hours ?? 6;
  const key = posKey(posConfig.chain_id ?? defaultChainId, posConfig.token_id);
  const recentCount = getRecentRebalanceCount(key, windowHours);

  if (recentCount < maxRebalances) return null;

  const { base, presetWidth } = parseStrategy(posConfig.strategy);
  const currentWidth = presetWidth ?? posConfig.params.width_ticks;
  const newWidth = posConfig.params.escalation_width ?? currentWidth * 2;

  if (newWidth <= currentWidth) return null; // No point widening to same or smaller

  // Generate percentage-based name (e.g., center_12pct) instead of tick-based (pulse_1200)
  const pct = Math.round(ticksToPercentage(newWidth));
  return { newStrategy: `${base}_${pct}pct`, newWidth };
}

/**
 * Persist a strategy change to config.yaml atomically.
 */
function updateConfigStrategy(
  tokenId: number,
  newStrategy: string,
  posConfig: PositionConfig,
): void {
  const configPath = resolve(process.cwd(), 'config.yaml');
  const yamlContent = readFileSync(configPath, 'utf-8');
  const parsed = parseYaml(yamlContent) as Record<string, unknown>;
  const positions = parsed.positions as Array<Record<string, unknown>>;
  if (positions) {
    for (const pos of positions) {
      if (pos.token_id === tokenId) {
        pos.strategy = newStrategy;
        break;
      }
    }
  }
  const header =
    '# 9mm V3 LP Auto-Rebalancer Configuration\n' +
    '# Contract addresses VERIFIED from main-liquidity-dashboard\n' +
    `# Auto-widen update: ${new Date().toISOString()}\n\n`;
  const tmpPath = configPath + '.tmp';
  writeFileSync(tmpPath, header + stringifyYaml(parsed));
  renameSync(tmpPath, configPath);
  posConfig.strategy = newStrategy as StrategyType;
  logger.info(`Auto-widened position ${tokenId}: strategy changed to ${newStrategy}`);
}

/**
 * Hydrate rebalance history from analytics storage on startup.
 * Prevents restart from resetting churn counter mid-spike.
 */
export async function hydrateRebalanceHistory(storagePath: string, chainId: number): Promise<void> {
  try {
    const { queryRebalances } = await import('./analytics/storage.js');
    const windowMs = 12 * 3600 * 1000; // Look back 12h (covers any churn_window_hours setting)
    const rebalances = await queryRebalances(storagePath, Date.now() - windowMs);
    for (const rb of rebalances) {
      const width = rb.newTickUpper - rb.newTickLower;
      const entry: RebalanceHistoryEntry = { timestamp: rb.timestamp, widthTicks: width };
      // Record under the newTokenId (the position that still exists)
      const key = posKey(chainId, rb.newTokenId);
      const existing = rebalanceHistory.get(key) ?? [];
      existing.push(entry);
      rebalanceHistory.set(key, existing);
    }
    if (rebalances.length > 0) {
      logger.info(`Hydrated rebalance history for chain ${chainId}: ${rebalances.length} entries across ${rebalanceHistory.size} positions`);
    }
  } catch {
    // Non-fatal — fresh start without history
  }
}

/**
 * Classify whether an error is a transient RPC/network failure (504, timeout,
 * connection reset) vs a permanent error (contract revert, logic error).
 *
 * Transient errors are safe to retry on the next monitoring cycle as long as
 * no irreversible on-chain action has been taken (checked via recovery state file).
 */
export function isTransientRpcError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const code = (error as { code?: string }).code;
  // Contract reverts are valid responses, NOT transient
  if (code === 'CALL_EXCEPTION') return false;
  // ethers v6 server errors (502, 503, 504)
  if (code === 'SERVER_ERROR') return true;
  // ethers v6 network-level errors
  if (code === 'NETWORK_ERROR' || code === 'TIMEOUT') return true;
  // Fallback: check message for common transient patterns
  const msg = error.message.toLowerCase();
  return msg.includes('gateway time-out') ||
    msg.includes('econnreset') ||
    msg.includes('socket hang up') ||
    msg.includes('econnrefused') ||
    msg.includes('etimedout');
}

/**
 * Check a position and rebalance if strategy conditions are met
 */
export async function checkAndRebalance(
  posConfig: PositionConfig,
  config: AppConfig,
  contracts: ContractInstances,
  chain: ChainContext,
  analyticsCollector?: AnalyticsCollector | null,
  force?: boolean,
): Promise<RebalanceResult | null> {
  const tokenId = posConfig.token_id;
  const chainId = posConfig.chain_id ?? config.chain.chainId;
  const posChainConfig = getChainConfig(chainId);
  const pk = posKey(chainId, tokenId);

  // Check safe mode
  if (!force && safeModePositions.has(pk)) {
    logger.warn(`Position ${tokenId} is in SAFE MODE. Skipping. Manual review required.`);
    return null;
  }

  // Check auto-disabled (burned/unowned positions after N consecutive failures)
  if (!force && autoDisabledPositions.has(pk)) {
    // Completely silent — no log noise. Use /removestale or /enable to clear.
    return null;
  }

  // Check kill switch (per-position automated disable)
  if (!force && isKillSwitchTriggered(pk)) {
    logger.warn(`Position ${tokenId}: kill switch triggered. Skipping. Use /enable to re-enable.`);
    return null;
  }

  // Check cooldown (with escalation based on recent rebalance frequency)
  if (!force) {
    const lastTime = lastRebalanceTime.get(pk) ?? 0;
    const windowHours = posConfig.params.churn_window_hours ?? 6;
    const maxRebalances = posConfig.params.max_rebalances_per_window ?? 3;
    const effectiveCooldown = getEscalatedCooldown(
      pk, config.rebalance_cooldown_seconds, windowHours, maxRebalances,
    );

    if (effectiveCooldown === Infinity) {
      // Too many rebalances in window — attempt auto-widen
      const widenResult = computeAutoWiden(posConfig, chainId);
      if (widenResult) {
        const recentCount = getRecentRebalanceCount(pk, windowHours);
        logger.warn(
          `Position ${tokenId}: ${recentCount} rebalances in ${windowHours}h. ` +
          `Auto-widening from ${posConfig.strategy} to ${widenResult.newStrategy}.`,
        );
        updateConfigStrategy(tokenId, widenResult.newStrategy, posConfig);
        rebalanceHistory.delete(pk); // Reset history for fresh start
        await sendNotification(
          `ANTI-CHURN: Position ${posLabel(tokenId, undefined, undefined, posChainConfig.chainName)} auto-widened.\n` +
          `Previous: ${posConfig.strategy}\nNew: ${widenResult.newStrategy}\n` +
          `Reason: ${recentCount} rebalances in ${windowHours}h window.`,
          config,
          'info',
        );
        // Fall through to re-evaluate with new wider strategy
      } else {
        logger.warn(`Position ${tokenId}: churn limit reached but cannot auto-widen. Skipping.`);
        return null;
      }
    } else {
      const elapsed = (Date.now() - lastTime) / 1000;
      if (elapsed < effectiveCooldown) {
        const recentCount = getRecentRebalanceCount(pk, windowHours);
        logger.debug(
          `Position ${tokenId}: escalated cooldown active (${Math.round(effectiveCooldown - elapsed)}s remaining, ` +
          `${recentCount} rebalances in ${windowHours}h window)`,
        );
        return null;
      }
    }
  }

  // ================================================================
  // STEP 1: PRE-CHECKS
  // ================================================================
  logger.info(`Checking position ${tokenId}...`);

  // 1a. Verify ownership (pass gauge_address so staked positions pass the check).
  // An ownership failure means wrong token_id in config.yaml — a config error,
  // not a rebalance catastrophe. Log clearly and skip this cycle. The bot
  // self-heals when config.yaml is corrected, no PM2 restart required.
  // Safe mode is reserved for: (a) rebalance failures with recovery state on disk,
  // (b) kill switch triggers. Never for config errors.
  const isOwner = await verifyOwnership(tokenId, chain.wallet.address, contracts, chain, posConfig.gauge_address);
  if (!isOwner) {
    // Track consecutive ownership failures and auto-disable after threshold
    const failCount = (ownershipFailureCount.get(pk) ?? 0) + 1;
    ownershipFailureCount.set(pk, failCount);

    if (failCount >= MAX_OWNERSHIP_FAILURES && !autoDisabledPositions.has(pk)) {
      autoDisabledPositions.add(pk);
      logger.warn(
        `Position ${tokenId}: auto-disabled after ${failCount} consecutive ownership failures. ` +
        `Use /removestale or /enable to clear. No further RPC calls will be made for this position.`,
      );
      // One-time Telegram notification
      if (!ownershipDisableNotified.has(pk)) {
        ownershipDisableNotified.add(pk);
        sendNotification(
          `Position #${tokenId} auto-disabled — ${failCount} consecutive ownership failures.\n` +
          `Likely burned or wrong token_id in config.yaml.\n` +
          `Send /removestale to clean up.`,
          config,
          'info',
        ).catch(() => {});
      }
    } else {
      logger.error(
        `Ownership check failed for position ${tokenId} ` +
        `(wallet: ${chain.wallet.address}). ` +
        `Likely wrong token_id in config.yaml. ` +
        `Skipping this cycle (${failCount}/${MAX_OWNERSHIP_FAILURES} before auto-disable).`,
      );
    }
    return null;
  }

  // Ownership verified — reset failure counter
  ownershipFailureCount.delete(pk);

  // 1b. Get position status
  const status = await getPositionStatus(tokenId, contracts, chain);

  if (status.position.liquidity === 0n) {
    logger.info(`Position ${tokenId} has zero liquidity. Skipping.`);
    return null;
  }

  // 1c. Evaluate strategy
  const decision = evaluateStrategy(status, posConfig);
  logger.info(`Position ${tokenId}: ${decision.reason}`);

  if (!force && !decision.shouldRebalance) {
    // Position is in range or below trigger — clear confirmation timer and prune churn history
    outOfRangeSince.delete(pk);
    deleteOorSince(chainId, tokenId);
    pruneRebalanceHistory(pk, posConfig.params.churn_window_hours ?? 6);

    // For static strategy, send alert if out of range
    if (posConfig.strategy === 'static' && !status.isInRange) {
      await sendNotification(
        `Position ${posLabel(tokenId, status.token0Info.symbol, status.token1Info.symbol, posChainConfig.chainName)} is OUT OF RANGE.\n` +
          `Current tick: ${status.pool.currentTick}\n` +
          `Range: [${status.position.tickLower}, ${status.position.tickUpper}]`,
        config,
        'info',
      );
    }

    // Emit structured trigger event for this hold decision
    emitTriggerEvent(
      analyticsCollector, tokenId, chainId,
      'scheduled_review', 'hold', decision.reason, status,
    ).catch(() => {});

    return null;
  }

  // 1d. Confirmation delay — position must stay out of range for confirm_minutes
  //     Critical distance bypass: if tickDistance >= critical_distance_ticks, skip the timer
  if (!force) {
    const confirmMinutes = posConfig.params.confirm_minutes ?? 0;
    if (confirmMinutes > 0) {
      // Check critical distance bypass before timer logic
      const criticalDistanceTicks = posConfig.params.critical_distance_ticks;
      const isCritical = criticalDistanceTicks !== undefined &&
                         criticalDistanceTicks > 0 &&
                         status.tickDistance >= criticalDistanceTicks;

      if (isCritical) {
        // Position is critically far from range — bypass confirmation timer
        logger.info(
          `Position ${tokenId}: CRITICAL distance ${status.tickDistance} >= ${criticalDistanceTicks} ticks. ` +
            `Bypassing ${confirmMinutes}-minute confirmation timer.`,
        );
        outOfRangeSince.delete(pk);
        deleteOorSince(chainId, tokenId);
        await sendNotification(
          `CRITICAL: Position ${posLabel(tokenId, status.token0Info.symbol, status.token1Info.symbol, posChainConfig.chainName)} is ${status.tickDistance} ticks out of range ` +
            `(critical threshold: ${criticalDistanceTicks}). Rebalancing immediately — bypassing confirmation timer.`,
          config,
          'info',
        );
      } else {
        // Normal confirmation delay path
        const now = Date.now();
        const firstSeen = outOfRangeSince.get(pk);
        if (!firstSeen) {
          // First time seeing this position out of range — start timer
          outOfRangeSince.set(pk, now);
          writeOorSince(chainId, tokenId, now);
          logger.info(
            `Position ${tokenId}: out of range, starting ${confirmMinutes}-minute confirmation timer.`,
          );
          emitTriggerEvent(
            analyticsCollector, tokenId, chainId,
            'price_exit', 'hold',
            `Out of range — starting ${confirmMinutes}-minute confirmation timer`, status,
          ).catch(() => {});
          return null;
        }
        const elapsedMinutes = (now - firstSeen) / 60_000;
        if (elapsedMinutes < confirmMinutes) {
          logger.info(
            `Position ${tokenId}: out of range for ${elapsedMinutes.toFixed(1)}/${confirmMinutes} minutes. Waiting for confirmation.`,
          );
          emitTriggerEvent(
            analyticsCollector, tokenId, chainId,
            'price_exit', 'hold',
            `Out of range ${elapsedMinutes.toFixed(1)}/${confirmMinutes} min — awaiting confirmation`, status,
          ).catch(() => {});
          return null;
        }
        // Confirmed — position has been out of range long enough
        logger.info(
          `Position ${tokenId}: confirmed out of range for ${elapsedMinutes.toFixed(1)} minutes (threshold: ${confirmMinutes}). Proceeding with rebalance.`,
        );
        outOfRangeSince.delete(pk);
        deleteOorSince(chainId, tokenId);
      }
    }
  }


  // 1f. Check gas cost in native currency
  const nativeSymbol = posChainConfig.nativeCurrencySymbol;
  const feeData = await chain.provider.getFeeData();
  if (feeData.gasPrice) {
    // Estimate max gas for full rebalance: collect + decrease + collect + burn + swap + mint + approvals
    const estimatedGasUnits = 1_000_000n; // ~1M gas for worst case (very conservative)
    const maxCostWei = feeData.gasPrice * estimatedGasUnits;
    const maxCostNative = bigintWeiToFloat(maxCostWei);

    // Check if estimated cost exceeds max (default 500 from config, repurposed)
    if (maxCostNative > config.max_gas_price_gwei) {
      logger.warn(
        `Estimated gas cost ${maxCostNative.toFixed(2)} ${nativeSymbol} exceeds max ${config.max_gas_price_gwei} ${nativeSymbol}. Skipping.`,
      );
      return null;
    }
    // 1f-i. Verify wallet has enough native balance to cover gas + a safety reserve.
    // Reserve is chain-specific: PulseChain keeps 1 PLS (gas is negligible); all other
    // chains use 0.005 native units so Ethereum doesn't require an absurd 1-ETH buffer.
    const nativeBalance = await chain.provider.getBalance(chain.wallet.address);
    const gasReserveWei = ethers.parseEther(GAS_RESERVE_BY_CHAIN[chainId] ?? '0.01');
    const requiredWei = maxCostWei + gasReserveWei;
    if (nativeBalance < requiredWei) {
      const balFmt = parseFloat(ethers.formatEther(nativeBalance)).toFixed(4);
      const reqFmt = parseFloat(ethers.formatEther(requiredWei)).toFixed(4);
      logger.warn(
        `Insufficient gas balance for position ${tokenId}: have ${balFmt} ${nativeSymbol}, need ${reqFmt} ${nativeSymbol}. Skipping rebalance.`,
      );
      // Queue the warning — flushed as a single grouped message per chain per 24h
      if (!gasWarningQueue.has(chainId)) gasWarningQueue.set(chainId, []);
      gasWarningQueue.get(chainId)!.push({ tokenId, have: balFmt, need: reqFmt, symbol: nativeSymbol, chainName: posChainConfig.chainName });
      return null;
    }
    logger.debug(`Estimated rebalance cost: ${maxCostNative.toFixed(4)} ${nativeSymbol}`);

    // 1f-ii. Cost-benefit gate (opt-in via cost_benefit_enabled: true in config.yaml)
    if (posConfig.params.cost_benefit_enabled === true) {
      const minRatio = posConfig.params.min_fee_to_cost_ratio ?? 1.5;
      try {
        const tokenAddresses = [status.token0Info.address, status.token1Info.address];
        const nativeAddress = posChainConfig.wrappedNativeAddress;
        const allAddresses = [...new Set([...tokenAddresses, nativeAddress])];
        const prices = await getTokenPrices(allAddresses);
        const priceUsd0 = prices.get(status.token0Info.address.toLowerCase()) ?? 0;
        const priceUsd1 = prices.get(status.token1Info.address.toLowerCase()) ?? 0;
        const nativePriceUsd = prices.get(nativeAddress.toLowerCase()) ?? 0;

        const cbResult = evaluateCostBenefit({
          gasPrice: feeData.gasPrice,
          unclaimedFees0: status.unclaimedFees0,
          unclaimedFees1: status.unclaimedFees1,
          decimals0: status.token0Info.decimals,
          decimals1: status.token1Info.decimals,
          priceUsd0,
          priceUsd1,
          nativePriceUsd,
          minFeeToCostRatio: minRatio,
        });

        logger.debug(`Cost-benefit check for position ${tokenId}: ${cbResult.reason}`);

        if (!cbResult.shouldProceed) {
          logger.info(`Position ${tokenId}: skipping rebalance — ${cbResult.reason}`);
          return null;
        }
      } catch (cbErr) {
        // Fail open: if price fetch fails, do not block the rebalance
        logger.warn(`Cost-benefit check failed for position ${tokenId} (failing open): ${cbErr}`);
      }
    }
  }

  // 1g. Re-verify trigger condition (price may have moved back during checks)
  const freshStatus = await getPositionStatus(tokenId, contracts, chain);
  const freshDecision = evaluateStrategy(freshStatus, posConfig);
  if (!freshDecision.shouldRebalance) {
    logger.info(`Position ${tokenId}: trigger no longer valid after re-check.`);
    return null;
  }

  logger.info(`REBALANCING position ${tokenId}: ${decision.reason}`);
  const freshT0 = freshStatus.token0Info.symbol;
  const freshT1 = freshStatus.token1Info.symbol;
  await sendNotification(
    `Starting rebalance for ${posLabel(tokenId, freshT0, freshT1, posChainConfig.chainName)}:\n${decision.reason}`,
    config,
  );

  // Generate rebalance ID and track step for event logging
  const rebalanceId = randomUUID();
  let currentStep = 'pre_checks';

  // Emit structured trigger event: rebalance is proceeding
  emitTriggerEvent(
    analyticsCollector, tokenId, chainId,
    status.isInRange ? 'scheduled_review' : 'price_exit',
    force ? 'manual_override' : 'rebalance',
    decision.reason, status, rebalanceId,
  ).catch(() => {});
  const tokenMeta = {
    token0Symbol: freshStatus.token0Info.symbol,
    token1Symbol: freshStatus.token1Info.symbol,
    token0Decimals: freshStatus.token0Info.decimals,
    token1Decimals: freshStatus.token1Info.decimals,
    // Token addresses for price backfill (needed when priceStatus='pending')
    token0Address: freshStatus.pool.token0,
    token1Address: freshStatus.pool.token1,
    nativeWrappedAddress: posChainConfig.wrappedNativeAddress,
  };

  // Fetch USD prices once at rebalance start — shared across all lifecycle events.
  // Uses resilient multi-source resolver: DexScreener → GeckoTerminal with retry.
  // On-chain sqrtPriceX96 is always available; USD prices are critical for analytics.
  const nativeAddr = posChainConfig.wrappedNativeAddress;
  const eventPriceResolved = await resolveEventPrices({
    addresses: [freshStatus.pool.token0, freshStatus.pool.token1, nativeAddr],
    chainSlug: posChainConfig.dexScreenerSlug,
    context: `rebalance_start:${tokenId}`,
  });
  const eventPriceUsd = {
    priceUsd0: eventPriceResolved.priceUsd0,
    priceUsd1: eventPriceResolved.priceUsd1,
    nativePriceUsd: eventPriceResolved.nativePriceUsd,
    priceSource: eventPriceResolved.priceSource,
    priceStatus: eventPriceResolved.priceStatus,
  };

  // Emit rebalance triggered event
  if (analyticsCollector) {
    await analyticsCollector.emitEvent({
      timestamp: Date.now(), rebalanceId, tokenId,
      eventType: 'rebalance_triggered',
      strategy: posConfig.strategy,
      reason: decision.reason,
      oldTickLower: status.position.tickLower,
      oldTickUpper: status.position.tickUpper,
      currentTick: status.pool.currentTick,
      sqrtPriceX96: freshStatus.pool.sqrtPriceX96,
      poolCurrentTick: freshStatus.pool.currentTick,
      ...eventPriceUsd,
      ...tokenMeta,
    }, chainId);
  }

  // ================================================================
  // DRY RUN: log what would happen without executing
  // ================================================================
  if (config.dry_run) {
    const swapCalc = calculateSwapAmount(
      status.amount0,
      status.amount1,
      freshStatus.pool.currentTick,
      decision.newTickLower!,
      decision.newTickUpper!,
      freshStatus.pool.fee,
    );
    logger.info(`[DRY RUN] Would rebalance position ${tokenId}`);
    logger.info(
      `[DRY RUN] New tick range: [${decision.newTickLower}, ${decision.newTickUpper}]`,
    );
    logger.info(
      `[DRY RUN] Current amounts: token0=${status.amount0.toString()}, token1=${status.amount1.toString()}`,
    );
    logger.info(
      `[DRY RUN] Would swap ${swapCalc.amountIn.toString()} of ${swapCalc.tokenIn}`,
    );
    return {
      success: true,
      oldTokenId: tokenId,
      feesCollected: { amount0: 0n, amount1: 0n },
      liquidityRemoved: { amount0: status.amount0, amount1: status.amount1 },
    };
  }

  // ================================================================
  // EXECUTE REBALANCE
  // ================================================================
  rebalancingPositions.add(pk);
  acquireRebalanceLock(chainId, tokenId);
  try {
    // Reset nonce before the first on-chain tx — prevents stale nonce after bot
    // restarts or crash loops that may have left orphaned pending txs on the chain.
    await chain.nonceManager.resetNonce();

    // STEP 2: Collect fees
    currentStep = 'collect_fees';
    const fees = await collectFees(tokenId, contracts, chain);
    logger.info(
      `Collected fees: token0=${fees.amount0.toString()}, token1=${fees.amount1.toString()}`,
    );

    if (analyticsCollector) {
      await analyticsCollector.emitEvent({
        timestamp: Date.now(), rebalanceId, tokenId,
        blockNumber: fees.blockNumber,
        eventType: 'fees_collected',
        txHash: fees.txHash, gasUsed: fees.gasUsed,
        amount0: fees.amount0, amount1: fees.amount1,
        sqrtPriceX96: freshStatus.pool.sqrtPriceX96,
        poolCurrentTick: freshStatus.pool.currentTick,
        ...eventPriceUsd,
        ...tokenMeta,
      }, chainId);
    }

    // Save recovery state before removing liquidity — if we crash between
    // step 3 (burn) and step 6 (mint), this file tells us how to recover
    writeRecoveryState({
      oldTokenId: tokenId,
      chainId,
      dex: posConfig.dex,
      token0: freshStatus.pool.token0,
      token1: freshStatus.pool.token1,
      token0Symbol: freshStatus.token0Info.symbol,
      token1Symbol: freshStatus.token1Info.symbol,
      fee: freshStatus.pool.fee,
      tickSpacing: freshStatus.pool.tickSpacing,
      strategy: posConfig.strategy,
      params: posConfig.params,
      timestamp: Date.now(),
      gauge_address: posConfig.gauge_address,
    }, chainId);

    // STEP 2.5: Unstake from gauge if position is staked
    let wasStaked = false;
    if (posConfig.gauge_address) {
      const staked = await isPositionStaked(tokenId, posConfig.gauge_address, chain);
      if (staked) {
        currentStep = 'gauge_withdraw';
        if (!config.dry_run) {
          logger.info(`Position ${tokenId} is staked in gauge — withdrawing before rebalance`);
          await withdrawFromGauge(tokenId, posConfig.gauge_address, chain, chainId);
          wasStaked = true;
          logger.info(`Gauge withdrawal complete for position ${tokenId}`);
        } else {
          logger.info(`[DRY RUN] Would withdraw position ${tokenId} from gauge before rebalance`);
          wasStaked = true;
        }
      }
    }

    // Use freshStatus for slippage calculation — status (from initial fetch) may be
    // 60+ seconds stale after pre-checks, TWAP, gas estimation, and re-verification.
    validateSqrtPrice(freshStatus.pool.sqrtPriceX96, freshStatus.pool.currentTick, 'pre-removeLiquidity');

    // STEP 3: Remove liquidity (with slippage protection)
    currentStep = 'remove_liquidity';
    const removed = await removeLiquidity(
      tokenId,
      freshStatus.position.liquidity,
      freshStatus.pool.sqrtPriceX96,
      freshStatus.position.tickLower,
      freshStatus.position.tickUpper,
      config.slippage_tolerance_bps,
      contracts,
      chain,
    );
    logger.info(
      `Removed liquidity: token0=${removed.amount0.toString()}, token1=${removed.amount1.toString()}`,
    );

    if (analyticsCollector) {
      await analyticsCollector.emitEvent({
        timestamp: Date.now(), rebalanceId, tokenId,
        blockNumber: removed.burnBlockNumber,
        eventType: 'position_exited',
        txHash: removed.burnTxHash,
        gasUsed: removed.decreaseGasUsed + removed.collectGasUsed + removed.burnGasUsed,
        amount0: removed.amount0, amount1: removed.amount1,
        sqrtPriceX96: freshStatus.pool.sqrtPriceX96,
        poolCurrentTick: freshStatus.pool.currentTick,
        ...eventPriceUsd,
        ...tokenMeta,
      }, chainId);
    }

    // Total tokens available
    const totalAmount0 = fees.amount0 + removed.amount0;
    const totalAmount1 = fees.amount1 + removed.amount1;

    // STEP 4: Calculate swap for new position ratio
    const swapCalc = calculateSwapAmount(
      totalAmount0,
      totalAmount1,
      freshStatus.pool.currentTick,
      decision.newTickLower!,
      decision.newTickUpper!,
      freshStatus.pool.fee,
    );

    // STEP 5: Swap if needed — re-fetch pool price for accurate slippage calc
    currentStep = 'swap';
    let swapResult = undefined;
    if (swapCalc.amountIn > 0n) {
      // Fresh pool state for swap slippage — do NOT reuse freshStatus which may be stale
      const swapPool = await getPoolState(freshStatus.pool.address, contracts, chain);
      validateSqrtPrice(swapPool.sqrtPriceX96, swapPool.currentTick, 'pre-swap');

      const tokenInAddr =
        swapCalc.tokenIn === 'token0'
          ? freshStatus.pool.token0
          : freshStatus.pool.token1;
      const tokenOutAddr =
        swapCalc.tokenIn === 'token0'
          ? freshStatus.pool.token1
          : freshStatus.pool.token0;
      const zeroForOne = swapCalc.tokenIn === 'token0';
      swapResult = await executeSwap(
        tokenInAddr,
        tokenOutAddr,
        freshStatus.pool.fee,
        swapCalc.amountIn,
        swapPool.sqrtPriceX96,
        zeroForOne,
        config,
        contracts,
        chain,
      );
      logger.info(
        `Swap complete: ${swapResult.amountIn.toString()} ${swapCalc.tokenIn} -> ${swapResult.amountOut.toString()} ${swapCalc.tokenIn === 'token0' ? 'token1' : 'token0'}`,
      );

      // Post-swap sanity check: abort if swap produced zero output
      if (swapResult.amountOut === 0n) {
        throw new Error(
          `Swap returned amountOut=0 (sent ${swapResult.amountIn.toString()} ${swapCalc.tokenIn}). ` +
          `NFT already burned — funds are stranded in wallet. Use /recover to re-mint.`,
        );
      }

      if (analyticsCollector) {
        await analyticsCollector.emitEvent({
          timestamp: Date.now(), rebalanceId, tokenId,
          blockNumber: swapResult.blockNumber,
          eventType: 'swap_executed',
          txHash: swapResult.txHash, gasUsed: swapResult.gasUsed,
          swap: {
            tokenIn: swapCalc.tokenIn === 'token0' ? 'token0' : 'token1',
            amountIn: swapResult.amountIn,
            amountOut: swapResult.amountOut,
          },
          sqrtPriceX96: freshStatus.pool.sqrtPriceX96,
          poolCurrentTick: freshStatus.pool.currentTick,
          ...eventPriceUsd,
          ...tokenMeta,
        }, chainId);
      }
    }

    // STEP 6: Get final token balances and mint new position
    currentStep = 'mint';

    // Defensive: if either pool token is the wrapped native token, check for unwrapped native in wallet.
    // DEX aggregators may output native currency instead of the wrapped version.
    // If found, auto-wrap before minting.
    const wrappedNativeAddr = posChainConfig.wrappedNativeAddress.toLowerCase();
    const wrappedSymbol = `W${posChainConfig.nativeCurrencySymbol}`;
    const isToken0Native = freshStatus.pool.token0.toLowerCase() === wrappedNativeAddr;
    const isToken1Native = freshStatus.pool.token1.toLowerCase() === wrappedNativeAddr;
    if (isToken0Native || isToken1Native) {
      const nativeBalance = await chain.provider.getBalance(chain.wallet.address);
      // Dynamic gas reserve: 2× estimated rebalance cost so future cycles can run.
      // Floor at 0.5 native units to protect cheap-gas chains (PulseChain, Sonic).
      // feeData was fetched in step 1f above; fall back to a safe default if missing.
      const dynamicReserve = feeData.gasPrice
        ? feeData.gasPrice * 2_000_000n
        : ethers.parseEther('0.5');
      const reserveFloor = ethers.parseEther('0.5');
      const gasReserve = dynamicReserve > reserveFloor ? dynamicReserve : reserveFloor;
      const wrappableAmount = nativeBalance - gasReserve;
      if (wrappableAmount > ethers.parseEther('0.01')) {
        logger.info(
          `Found ${ethers.formatEther(nativeBalance)} native ${nativeSymbol} in wallet. ` +
          `Auto-wrapping ${ethers.formatEther(wrappableAmount)} to ${wrappedSymbol} (keeping ${ethers.formatEther(gasReserve)} for gas).`,
        );
        const wrappedNativeContract = contracts.getWrappedNative();
        const wrapNonce = await chain.nonceManager.getNextNonce();
        try {
          const wrapTx = await wrappedNativeContract.deposit({ value: wrappableAmount, gasLimit: 50000, nonce: wrapNonce });
          await wrapTx.wait();
          chain.nonceManager.confirmNonce(wrapNonce);
          logger.info(`Wrap complete: ${ethers.formatEther(wrappableAmount)} ${nativeSymbol} → ${wrappedSymbol}`);
        } catch (wrapError) {
          await chain.nonceManager.resetNonce();
          logger.warn(`Failed to auto-wrap native ${nativeSymbol} to ${wrappedSymbol}: ${wrapError}. Continuing with available ${wrappedSymbol} balance.`);
        }
      }
    }

    const token0Contract = contracts.getERC20(freshStatus.pool.token0);
    const token1Contract = contracts.getERC20(freshStatus.pool.token1);
    const finalAmount0 = BigInt(
      await token0Contract.balanceOf(chain.wallet.address),
    );
    const finalAmount1 = BigInt(
      await token1Contract.balanceOf(chain.wallet.address),
    );

    // Warn if wallet balance significantly exceeds expected amounts from this rebalance.
    // This could mean the wallet holds tokens from external sources (manual transfers,
    // airdrops, other positions with the same token pair). All of it will be deposited.
    const expectedAmount0 = totalAmount0 - (swapCalc.tokenIn === 'token0' ? swapCalc.amountIn : 0n)
      + (swapResult && swapCalc.tokenIn === 'token1' ? swapResult.amountOut : 0n);
    const expectedAmount1 = totalAmount1 - (swapCalc.tokenIn === 'token1' ? swapCalc.amountIn : 0n)
      + (swapResult && swapCalc.tokenIn === 'token0' ? swapResult.amountOut : 0n);
    // Allow 5% tolerance for rounding, fees, and price impact
    const tolerance0 = expectedAmount0 > 0n ? expectedAmount0 / 20n : 0n;
    const tolerance1 = expectedAmount1 > 0n ? expectedAmount1 / 20n : 0n;
    if (finalAmount0 > expectedAmount0 + tolerance0 && expectedAmount0 > 0n) {
      logger.warn(
        `Wallet token0 balance (${finalAmount0.toString()}) significantly exceeds expected ` +
        `(${expectedAmount0.toString()}). External tokens may be deposited into the new position.`,
      );
    }
    if (finalAmount1 > expectedAmount1 + tolerance1 && expectedAmount1 > 0n) {
      logger.warn(
        `Wallet token1 balance (${finalAmount1.toString()}) significantly exceeds expected ` +
        `(${expectedAmount1.toString()}). External tokens may be deposited into the new position.`,
      );
    }

    // Pre-mint sanity check: if tick is inside the target range, both tokens are required.
    // A zero balance here means the swap over-calculated (or failed silently).
    const tickInNewRange = freshStatus.pool.currentTick >= decision.newTickLower!
      && freshStatus.pool.currentTick < decision.newTickUpper!;
    if (tickInNewRange && (finalAmount0 === 0n || finalAmount1 === 0n)) {
      throw new Error(
        `Cannot mint: tick ${freshStatus.pool.currentTick} is inside range ` +
        `[${decision.newTickLower}, ${decision.newTickUpper}] but ` +
        `amount0=${finalAmount0.toString()}, amount1=${finalAmount1.toString()}. ` +
        `Both tokens required. NFT already burned — funds are stranded. Use /recover.`,
      );
    }

    // Pre-mint sanity check: if a swap was executed, the output token must be non-zero.
    // One-sided mints (entirely out-of-range) are valid with one token at zero,
    // but if we just swapped to get that token and still have zero, something went wrong.
    if (swapResult) {
      const swappedToToken0 = swapCalc.tokenIn === 'token1';
      if ((swappedToToken0 && finalAmount0 === 0n) || (!swappedToToken0 && finalAmount1 === 0n)) {
        throw new Error(
          `Cannot mint: swapped for ${swappedToToken0 ? 'token0' : 'token1'} but balance is still zero ` +
          `(amount0=${finalAmount0.toString()}, amount1=${finalAmount1.toString()}). ` +
          `NFT already burned — funds are stranded in wallet. Use /recover to re-mint.`,
        );
      }
    }

    const mintResult = await mintPosition(
      freshStatus.pool.token0,
      freshStatus.pool.token1,
      freshStatus.pool.fee,
      decision.newTickLower!,
      decision.newTickUpper!,
      finalAmount0,
      finalAmount1,
      config,
      contracts,
      chain,
    );

    if (analyticsCollector) {
      await analyticsCollector.emitEvent({
        timestamp: Date.now(), rebalanceId, tokenId,
        blockNumber: mintResult.blockNumber,
        eventType: 'position_opened',
        txHash: mintResult.txHash, gasUsed: mintResult.gasUsed,
        newTokenId: mintResult.newTokenId,
        newTickLower: decision.newTickLower,
        newTickUpper: decision.newTickUpper,
        liquidity: mintResult.liquidity,
        amount0: mintResult.amount0, amount1: mintResult.amount1,
        sqrtPriceX96: freshStatus.pool.sqrtPriceX96,
        poolCurrentTick: freshStatus.pool.currentTick,
        ...eventPriceUsd,
        ...tokenMeta,
      }, chainId);
    }

    // Update config.yaml with new token ID
    updateConfigTokenId(tokenId, mintResult.newTokenId, posConfig);

    // Clear recovery state — rebalance completed successfully
    clearRecoveryState(chainId);

    // Re-stake new position in gauge if the old one was staked
    if (posConfig.gauge_address && wasStaked) {
      currentStep = 'gauge_deposit';
      if (!config.dry_run) {
        const npmAddress = contracts.positionManager.target as string;
        logger.info(`Re-staking new position ${mintResult.newTokenId} into gauge ${posConfig.gauge_address}`);
        try {
          await depositToGauge(mintResult.newTokenId, posConfig.gauge_address, npmAddress, chain, chainId);
          logger.info(`New position ${mintResult.newTokenId} staked in gauge`);
        } catch (gaugeErr) {
          // Don't fail the rebalance if re-stake fails — position is safe, just not earning gauge rewards
          logger.warn(`Failed to re-stake position ${mintResult.newTokenId} in gauge: ${gaugeErr}. ` +
            `Position is safe but not staked. Will be re-staked on next rebalance or manually.`);
        }
      } else {
        logger.info(`[DRY RUN] Would re-stake new position ${mintResult.newTokenId} into gauge`);
      }
    }

    // Update cooldown for new position (composite key with new tokenId)
    const newPk = posKey(chainId, mintResult.newTokenId);
    lastRebalanceTime.set(newPk, Date.now());

    // Record rebalance in anti-churn history and transfer history to new tokenId
    const widthTicks = (freshDecision.newTickUpper ?? 0) - (freshDecision.newTickLower ?? 0);
    const oldHistory = rebalanceHistory.get(pk) ?? [];
    oldHistory.push({ timestamp: Date.now(), widthTicks });
    rebalanceHistory.set(newPk, oldHistory);
    rebalanceHistory.delete(pk); // Old NFT is burned

    const result: RebalanceResult = {
      success: true,
      oldTokenId: tokenId,
      newTokenId: mintResult.newTokenId,
      feesCollected: { amount0: fees.amount0, amount1: fees.amount1 },
      liquidityRemoved: { amount0: removed.amount0, amount1: removed.amount1 },
      swapExecuted: swapResult,
      newPosition: mintResult,
    };

    // Capture analytics if enabled
    if (analyticsCollector) {
      try {
        const postStatus = await getPositionStatus(mintResult.newTokenId, contracts, chain);
        const gasPrice = feeData.gasPrice ?? 0n;
        const swapGas = swapResult?.gasUsed ?? 0n;

        const txHashes: RebalanceTxHashes = {
          collectFees: fees.txHash,
          decreaseLiquidity: removed.decreaseTxHash,
          collectTokens: removed.collectTxHash,
          burn: removed.burnTxHash,
          swap: swapResult?.txHash,
          mint: mintResult.txHash,
        };

        const gasUsed: GasUsageData = {
          collectFees: fees.gasUsed,
          decreaseLiquidity: removed.decreaseGasUsed,
          collectTokens: removed.collectGasUsed,
          burn: removed.burnGasUsed,
          swap: swapGas,
          approvals: 0n, // Tracked as part of mint overhead
          mint: mintResult.gasUsed,
          total: fees.gasUsed + removed.decreaseGasUsed + removed.collectGasUsed +
            removed.burnGasUsed + swapGas + mintResult.gasUsed,
        };

        // Fetch transaction receipts to calculate precise per-receipt gas cost.
        // Uses sequential fetches with per-receipt error handling instead of Promise.all,
        // so a single failed receipt doesn't discard costs from all other successful receipts.
        {
          const hashArray = Object.values(txHashes).filter(Boolean) as string[];
          let totalCostWei = 0n;
          let successCount = 0;
          for (const hash of hashArray) {
            try {
              const receipt = await chain.provider.getTransactionReceipt(hash);
              if (receipt) {
                totalCostWei += receipt.fee ?? (receipt.gasUsed * (receipt.gasPrice || gasPrice));
                successCount++;
              } else {
                logger.warn(`Receipt for ${hash} returned null — tx may still be pending`);
              }
            } catch (err) {
              logger.warn(`Failed to fetch receipt for ${hash}: ${err}`);
            }
          }
          if (totalCostWei > 0n) {
            gasUsed.totalCostWei = totalCostWei;
          }
          if (successCount < hashArray.length) {
            logger.warn(`Gas cost calculated from ${successCount}/${hashArray.length} receipts — some may be estimated`);
          }
        }

        // Fetch USD prices before analytics capture — establishes entry cost basis for the
        // new position and converts gas cost to USD. Uses resilient multi-source resolver
        // with retry. If all sources fail, priceStatus='pending' triggers background backfill.
        const rebalancePriceResolved = await resolveEventPrices({
          addresses: [freshStatus.pool.token0, freshStatus.pool.token1, nativeAddr],
          chainSlug: posChainConfig.dexScreenerSlug,
          context: `rebalance_analytics:${tokenId}→${mintResult.newTokenId}`,
        });
        const rebalancePrices = rebalancePriceResolved.priceStatus === 'live'
          ? {
              priceUsd0: rebalancePriceResolved.priceUsd0,
              priceUsd1: rebalancePriceResolved.priceUsd1,
              nativePriceUsd: rebalancePriceResolved.nativePriceUsd,
              source: rebalancePriceResolved.priceSource,
              priceStatus: rebalancePriceResolved.priceStatus as 'live' | 'backfilled' | 'pending' | 'permanently_missing',
              nativeWrappedAddress: nativeAddr,
              chainSlug: posChainConfig.dexScreenerSlug,
            }
          : {
              priceUsd0: 0,
              priceUsd1: 0,
              nativePriceUsd: 0,
              source: 'unavailable',
              priceStatus: 'pending' as const,
              nativeWrappedAddress: nativeAddr,
              chainSlug: posChainConfig.dexScreenerSlug,
            };

        // Dust is the remaining intended funds that were not pulled by the pool during minting
        const dust = {
          amount0: finalAmount0 - mintResult.amount0,
          amount1: finalAmount1 - mintResult.amount1,
        };

        const rebalanceAnalytics = await analyticsCollector.captureRebalance(
          freshStatus,
          postStatus,
          result,
          txHashes,
          gasUsed,
          gasPrice,
          dust,
          posConfig.strategy,
          rebalanceId,
          chainId,
          posConfig.dex,
          rebalancePrices,
        );

        await analyticsCollector.emitEvent({
          timestamp: Date.now(), rebalanceId, tokenId,
          blockNumber: mintResult.blockNumber,
          eventType: 'rebalance_completed',
          newTokenId: mintResult.newTokenId,
          sqrtPriceX96: freshStatus.pool.sqrtPriceX96,
          poolCurrentTick: freshStatus.pool.currentTick,
          ...eventPriceUsd,
          ...tokenMeta,
        }, chainId);

        // Build detailed PnL summary notification
        try {
          const label = posLabel(tokenId, tokenMeta.token0Symbol, tokenMeta.token1Symbol, posChainConfig.chainName);
          const m = rebalanceAnalytics.metrics;
          const nativeSymbol = posChainConfig.nativeCurrencySymbol;

          // Use prices already fetched for analytics (rebalancePrices).
          // The resilient resolver already exhausted all sources with retries,
          // so no additional fetch is needed here.
          let feesUsd = 0;
          const p0 = rebalancePrices?.priceUsd0 ?? 0;
          const p1 = rebalancePrices?.priceUsd1 ?? 0;
          if (p0 > 0 || p1 > 0) {
            feesUsd = bigintToFloat(rebalanceAnalytics.feesCollected0, freshStatus.token0Info.decimals) * p0 +
                      bigintToFloat(rebalanceAnalytics.feesCollected1, freshStatus.token1Info.decimals) * p1;
          }

          const pnlLines = [
            `Rebalance complete for ${label}!`,
            `Old #${tokenId} -> New #${mintResult.newTokenId}`,
            `New range: [${decision.newTickLower}, ${decision.newTickUpper}]`,
            ...(posConfig.gauge_address && wasStaked ? ['Unstaked → rebalanced → re-staked in gauge'] : []),
            ``,
            `Performance:`,
            `  Fees collected: ${feesUsd > 0 ? '$' + feesUsd.toFixed(4) : 'N/A'}`,
            `  Gas cost: ${rebalanceAnalytics.totalGasCostPLS.toFixed(4)} ${nativeSymbol}`,
            `  IL: ${m.impermanentLossPercent.toFixed(2)}%`,
            `  Net ROI: ${m.netROIPercent.toFixed(2)}%`,
            ...(m.durationSeconds > 3600 ? [`  Time in range: ${m.timeInRangePercent.toFixed(0)}%`] : []),
            `  Execution cost: ${m.rebalanceCostPercent.toFixed(2)}%`,
          ];

          await sendNotification(pnlLines.join('\n'), config, 'info', 'rebalance_success');
        } catch (pnlError) {
          logger.debug(`PnL summary notification failed (non-fatal): ${pnlError}`);
          await sendNotification(
            `Rebalance complete for ${posLabel(tokenId, tokenMeta.token0Symbol, tokenMeta.token1Symbol, posChainConfig.chainName)}!\n` +
              `Old #${tokenId} -> New #${mintResult.newTokenId}\n` +
              `New range: [${decision.newTickLower}, ${decision.newTickUpper}]`,
            config,
          );
        }

        // Evaluate kill switch after rebalance
        if (posConfig.params.kill_switch) {
          try {
            // Estimate pre-rebalance USD value for HODL ratio check
            let preValueUsd = 0;
            try {
              const prices = await getTokenPrices(
                [freshStatus.pool.token0, freshStatus.pool.token1],
                posChainConfig.dexScreenerSlug,
              );
              const p0 = prices.get(freshStatus.pool.token0.toLowerCase()) ?? 0;
              const p1 = prices.get(freshStatus.pool.token1.toLowerCase()) ?? 0;
              preValueUsd =
                bigintToFloat(freshStatus.amount0, freshStatus.token0Info.decimals) * p0 +
                bigintToFloat(freshStatus.amount1, freshStatus.token1Info.decimals) * p1;
            } catch { /* price fetch failed — skip HODL ratio check */ }

            const killResult = evaluateKillSwitch(pk, rebalanceAnalytics, posConfig.params.kill_switch, preValueUsd);
            if (killResult.triggered) {
              safeModePositions.add(pk);
              await sendNotification(
                `KILL SWITCH: Position ${posLabel(tokenId, tokenMeta.token0Symbol, tokenMeta.token1Symbol, posChainConfig.chainName)} automatically disabled.\n` +
                  `Reason: ${killResult.reason}\n` +
                  `Use /enable command to re-enable after manual review.`,
                config,
                'critical',
              );
            }
          } catch (ksError) {
            logger.debug(`Kill switch evaluation failed (non-fatal): ${ksError}`);
          }
        }
      } catch (analyticsError) {
        logger.warn(`Analytics capture failed (non-fatal): ${analyticsError}`);
      }
    } else {
      // No analytics collector — send simple completion message
      await sendNotification(
        `Rebalance complete for ${posLabel(tokenId, tokenMeta.token0Symbol, tokenMeta.token1Symbol, posChainConfig.chainName)}!\n` +
          `Old #${tokenId} -> New #${mintResult.newTokenId}\n` +
          `New range: [${decision.newTickLower}, ${decision.newTickUpper}]\n` +
          `Liquidity: ${mintResult.liquidity.toString()}`,
        config,
      );
    }

    logger.info(
      `Rebalance successful: position ${tokenId} -> ${mintResult.newTokenId}`,
    );

    // Reset transient failure counter on success
    transientFailureCount.delete(pk);

    return result;
  } catch (error) {
    // ================================================================
    // STEP 7: ERROR HANDLING — classify error before deciding on safe mode
    // ================================================================
    logger.error(`REBALANCE FAILED for position ${tokenId}: ${error}`);

    // If we have a recovery state file, an irreversible action (burn) may have
    // occurred — we MUST enter safe mode regardless of error type.
    const hasRecoveryState = existsSync(recoveryStatePath(chainId)) || existsSync(RECOVERY_STATE_PATH);

    const consecutiveFailures = (transientFailureCount.get(pk) ?? 0) + 1;

    if (isTransientRpcError(error) && !hasRecoveryState && consecutiveFailures <= MAX_TRANSIENT_RETRIES) {
      // Transient RPC failure (504, timeout, connection reset) BEFORE any
      // irreversible on-chain action. Safe to retry on next monitoring cycle.
      transientFailureCount.set(pk, consecutiveFailures);
      logger.warn(
        `Transient RPC error during rebalance of position ${tokenId} ` +
        `(attempt ${consecutiveFailures}/${MAX_TRANSIENT_RETRIES}). ` +
        `Will retry on next cycle.`,
      );
      await sendNotification(
        `Rebalance for ${posLabel(tokenId, freshStatus?.token0Info?.symbol, freshStatus?.token1Info?.symbol, posChainConfig.chainName)} failed due to RPC error ` +
          `(attempt ${consecutiveFailures}/${MAX_TRANSIENT_RETRIES}).\n` +
          `Will retry automatically on next cycle.`,
        config,
        'info',
      );
      await chain.nonceManager.resetNonce();
    } else {
      // Permanent error, partial completion, or exhausted transient retries
      // — enter safe mode for manual review.
      transientFailureCount.delete(pk);
      safeModePositions.add(pk);

      // Log wallet balances for manual recovery
      try {
        const token0Contract = contracts.getERC20(freshStatus.pool.token0);
        const token1Contract = contracts.getERC20(freshStatus.pool.token1);
        const bal0 = await token0Contract.balanceOf(chain.wallet.address);
        const bal1 = await token1Contract.balanceOf(chain.wallet.address);
        logger.error(
          `SAFE MODE: Wallet balances — ${freshStatus.token0Info.symbol}: ${bal0}, ${freshStatus.token1Info.symbol}: ${bal1}`,
        );
      } catch (e) {
        logger.error(`Could not fetch wallet balances: ${e}`);
      }

      logger.error(
        `SAFE MODE: Position ${tokenId} paused. Review state and restart bot after manual recovery.`,
      );

      await sendNotification(
        `CRITICAL: Rebalance FAILED for ${posLabel(tokenId, freshStatus?.token0Info?.symbol, freshStatus?.token1Info?.symbol, posChainConfig.chainName)}!\n` +
          `Position entered SAFE MODE. Manual review required.\n` +
          `Check VPS logs for details.`,
        config,
        'critical',
        'rebalance_failure',
      );
    }

    // Emit failure event
    if (analyticsCollector) {
      const didEnterSafeMode = !(isTransientRpcError(error) && !hasRecoveryState && consecutiveFailures <= MAX_TRANSIENT_RETRIES);
      try {
        await analyticsCollector.emitEvent({
          timestamp: Date.now(), rebalanceId, tokenId,
          eventType: 'rebalance_failed',
          failedAtStep: currentStep,
          error: error instanceof Error ? error.message : String(error),
          enteredSafeMode: didEnterSafeMode,
          sqrtPriceX96: freshStatus?.pool?.sqrtPriceX96,
          poolCurrentTick: freshStatus?.pool?.currentTick,
          ...eventPriceUsd,
          token0Symbol: freshStatus?.token0Info?.symbol,
          token1Symbol: freshStatus?.token1Info?.symbol,
        }, chainId);
      } catch { /* never let event logging break error handling */ }
    }

    return {
      success: false,
      oldTokenId: tokenId,
      feesCollected: { amount0: 0n, amount1: 0n },
      liquidityRemoved: { amount0: 0n, amount1: 0n },
      error: String(error),
    };
  } finally {
    rebalancingPositions.delete(pk);
    releaseRebalanceLock(chainId, tokenId);
  }
}

// ============================================================
// STEP 2: Collect Fees
// ============================================================

export async function collectFees(
  tokenId: number,
  contracts: ContractInstances,
  chain: ChainContext,
): Promise<CollectResult> {
  const nonce = await chain.nonceManager.getNextNonce();
  try {
    const tx = await contracts.positionManager.collect(
      {
        tokenId,
        recipient: chain.wallet.address,
        amount0Max: MAX_UINT128,
        amount1Max: MAX_UINT128,
      },
      { gasLimit: GAS_LIMITS.COLLECT, nonce },
    );
    const receipt = await tx.wait();
    if (!receipt) throw new Error('collectFees tx dropped from mempool (receipt is null)');
    chain.nonceManager.confirmNonce(nonce);

    // Parse Collect event to get actual amounts
    let amount0 = 0n;
    let amount1 = 0n;
    const iface = contracts.positionManager.interface;
    for (const log of receipt.logs) {
      try {
        const parsed = iface.parseLog({
          topics: log.topics as string[],
          data: log.data,
        });
        if (parsed && parsed.name === 'Collect') {
          amount0 = BigInt(parsed.args.amount0);
          amount1 = BigInt(parsed.args.amount1);
        }
      } catch {
        // Not our event
      }
    }

    return { amount0, amount1, txHash: receipt.hash, gasUsed: receipt.gasUsed, blockNumber: receipt.blockNumber };
  } catch (error) {
    await chain.nonceManager.resetNonce();
    throw error;
  }
}

// ============================================================
// STEP 3: Remove Liquidity (decreaseLiquidity + collect + burn)
// ============================================================

export async function removeLiquidity(
  tokenId: number,
  liquidity: bigint,
  sqrtPriceX96: bigint,
  tickLower: number,
  tickUpper: number,
  slippageBps: number,
  contracts: ContractInstances,
  chain: ChainContext,
): Promise<RemoveLiquidityResult> {
  const deadline = BigInt(
    Math.floor(Date.now() / 1000) + DEFAULT_DEADLINE_MINUTES * 60,
  );

  // Calculate expected amounts and apply slippage tolerance
  const sqrtPriceAX96 = tickToSqrtPriceX96(tickLower);
  const sqrtPriceBX96 = tickToSqrtPriceX96(tickUpper);
  const expected = getAmountsForLiquidity(sqrtPriceX96, sqrtPriceAX96, sqrtPriceBX96, liquidity);
  const slippageMultiplier = BigInt(10000 - slippageBps);
  const amount0Min = (expected.amount0 * slippageMultiplier) / 10000n;
  const amount1Min = (expected.amount1 * slippageMultiplier) / 10000n;
  logger.info(`decreaseLiquidity slippage protection: amount0Min=${amount0Min}, amount1Min=${amount1Min}`);

  // 3a. Decrease liquidity
  let nonce = await chain.nonceManager.getNextNonce();
  let decreaseTxHash: string;
  let decreaseGasUsed: bigint;
  let decreaseBlockNumber: number;
  try {
    const tx = await contracts.positionManager.decreaseLiquidity(
      {
        tokenId,
        liquidity,
        amount0Min,
        amount1Min,
        deadline,
      },
      { gasLimit: GAS_LIMITS.BURN, nonce },
    );
    const receipt = await tx.wait();
    if (!receipt) throw new Error('decreaseLiquidity tx dropped from mempool (receipt is null)');
    chain.nonceManager.confirmNonce(nonce);
    decreaseTxHash = receipt.hash;
    decreaseGasUsed = receipt.gasUsed;
    decreaseBlockNumber = receipt.blockNumber;
  } catch (error) {
    await chain.nonceManager.resetNonce();
    throw error;
  }

  // 3b. Collect the withdrawn tokens
  nonce = await chain.nonceManager.getNextNonce();
  let collectTxHash: string;
  let collectGasUsed: bigint;
  let collectBlockNumber: number;
  let amount0 = 0n;
  let amount1 = 0n;
  try {
    const tx = await contracts.positionManager.collect(
      {
        tokenId,
        recipient: chain.wallet.address,
        amount0Max: MAX_UINT128,
        amount1Max: MAX_UINT128,
      },
      { gasLimit: GAS_LIMITS.COLLECT, nonce },
    );
    const receipt = await tx.wait();
    if (!receipt) throw new Error('collect tx dropped from mempool (receipt is null)');
    chain.nonceManager.confirmNonce(nonce);
    collectTxHash = receipt.hash;
    collectGasUsed = receipt.gasUsed;
    collectBlockNumber = receipt.blockNumber;

    // Parse Collect event
    const iface = contracts.positionManager.interface;
    for (const log of receipt.logs) {
      try {
        const parsed = iface.parseLog({
          topics: log.topics as string[],
          data: log.data,
        });
        if (parsed && parsed.name === 'Collect') {
          amount0 = BigInt(parsed.args.amount0);
          amount1 = BigInt(parsed.args.amount1);
        }
      } catch {
        // Not our event
      }
    }
  } catch (error) {
    await chain.nonceManager.resetNonce();
    throw error;
  }

  // 3c. Burn empty NFT
  nonce = await chain.nonceManager.getNextNonce();
  let burnTxHash: string;
  let burnGasUsed: bigint;
  let burnBlockNumber: number;
  try {
    const tx = await contracts.positionManager.burn(tokenId, {
      gasLimit: GAS_LIMITS.BURN,
      nonce,
    });
    const receipt = await tx.wait();
    if (!receipt) throw new Error('burn tx dropped from mempool (receipt is null)');
    chain.nonceManager.confirmNonce(nonce);
    burnTxHash = receipt.hash;
    burnGasUsed = receipt.gasUsed;
    burnBlockNumber = receipt.blockNumber;
  } catch (error) {
    await chain.nonceManager.resetNonce();
    throw error;
  }

  return {
    amount0, amount1,
    decreaseTxHash, collectTxHash, burnTxHash,
    decreaseGasUsed, collectGasUsed, burnGasUsed,
    decreaseBlockNumber, collectBlockNumber, burnBlockNumber,
  };
}

// ============================================================
// STEP 6: Mint New Position
// ============================================================

export async function mintPosition(
  token0: string,
  token1: string,
  fee: number,
  tickLower: number,
  tickUpper: number,
  amount0Desired: bigint,
  amount1Desired: bigint,
  config: AppConfig,
  contracts: ContractInstances,
  chain: ChainContext,
  overrideSlippageBps?: number,
): Promise<MintResult> {
  const deadline = BigInt(
    Math.floor(Date.now() / 1000) + DEFAULT_DEADLINE_MINUTES * 60,
  );
  // Derive NPM address from the contract instance (supports per-DEX contracts)
  const npmAddress = (contracts.positionManager as ethers.Contract).target as string;

  // Approve both tokens to PositionManager (exact amounts)
  await ensureApproval(token0, npmAddress, amount0Desired, contracts, chain);
  await ensureApproval(token1, npmAddress, amount1Desired, contracts, chain);

  // Compute slippage-protected minimums from what the pool will ACTUALLY accept,
  // not from amount0Desired/amount1Desired (which may be the full wallet balance).
  // The pool only deposits the ratio it needs at the current tick — any excess
  // stays in the wallet. Setting amount0Min = 99% of wallet balance would revert
  // if the pool only needs a fraction of it.
  const slippageBps = BigInt(overrideSlippageBps ?? config.slippage_tolerance_bps);
  const sqrtPriceAX96 = tickToSqrtPriceX96(tickLower);
  const sqrtPriceBX96 = tickToSqrtPriceX96(tickUpper);
  const poolState = await getPoolState(
    await contracts.factory.getPool(token0, token1, fee),
    contracts,
    chain,
  );
  const expectedLiquidity = getLiquidityForAmounts(
    poolState.sqrtPriceX96, sqrtPriceAX96, sqrtPriceBX96, amount0Desired, amount1Desired,
  );
  const expectedAmounts = getAmountsForLiquidity(
    poolState.sqrtPriceX96, sqrtPriceAX96, sqrtPriceBX96, expectedLiquidity,
  );
  const amount0Min = expectedAmounts.amount0 * (10_000n - slippageBps) / 10_000n;
  const amount1Min = expectedAmounts.amount1 * (10_000n - slippageBps) / 10_000n;
  logger.info(`Mint slippage: expected0=${expectedAmounts.amount0}, expected1=${expectedAmounts.amount1}, min0=${amount0Min}, min1=${amount1Min}`);

  const nonce = await chain.nonceManager.getNextNonce();
  try {
    // Aerodrome CL MintParams uses `tickSpacing` instead of `fee` and includes `sqrtPriceX96`
    // (pass 0 since the pool already exists — we never create pools here).
    // Shadow V3 (algebra-v3) also uses `tickSpacing` but does NOT have `sqrtPriceX96` in its
    // mint() signature — its selector is 0x6d70c415 (11-field struct), not 0xb5007d1f (12-field).
    const mintParams = contracts.swapRouterType === 'aerodrome-cl'
      ? {
          token0,
          token1,
          tickSpacing: fee,
          tickLower,
          tickUpper,
          amount0Desired,
          amount1Desired,
          amount0Min,
          amount1Min,
          recipient: chain.wallet.address,
          deadline,
          sqrtPriceX96: 0n, // pool already exists
        }
      : contracts.swapRouterType === 'algebra-v3'
      ? {
          token0,
          token1,
          tickSpacing: fee, // fee field holds tickSpacing for Shadow V3 positions
          tickLower,
          tickUpper,
          amount0Desired,
          amount1Desired,
          amount0Min,
          amount1Min,
          recipient: chain.wallet.address,
          deadline,
          // NO sqrtPriceX96 — Shadow V3 mint() is an 11-field struct
        }
      : {
          token0,
          token1,
          fee,
          tickLower,
          tickUpper,
          amount0Desired,
          amount1Desired,
          amount0Min,
          amount1Min,
          recipient: chain.wallet.address,
          deadline,
        };

    const tx = await contracts.positionManager.mint(
      mintParams,
      { gasLimit: GAS_LIMITS.MINT, nonce },
    );

    const receipt = await tx.wait();
    if (!receipt) {
      throw new Error(`Mint tx ${tx.hash} was dropped from mempool (receipt is null). NFT may or may not exist on-chain.`);
    }
    chain.nonceManager.confirmNonce(nonce);

    // Parse events to get new tokenId and minted amounts
    const iface = contracts.positionManager.interface;
    let newTokenId = 0;
    let mintedLiquidity = 0n;
    let mintedAmount0 = 0n;
    let mintedAmount1 = 0n;

    for (const log of receipt.logs) {
      try {
        const parsed = iface.parseLog({
          topics: log.topics as string[],
          data: log.data,
        });
        if (!parsed) continue;

        // Transfer event from minting NFT (from ZeroAddress)
        if (parsed.name === 'Transfer' && parsed.args.from === ethers.ZeroAddress) {
          newTokenId = Number(parsed.args.tokenId);
        }
        // IncreaseLiquidity event contains the minted amounts
        if (parsed.name === 'IncreaseLiquidity') {
          newTokenId = Number(parsed.args.tokenId);
          mintedLiquidity = BigInt(parsed.args.liquidity);
          mintedAmount0 = BigInt(parsed.args.amount0);
          mintedAmount1 = BigInt(parsed.args.amount1);
        }
      } catch {
        // Not our event
      }
    }

    // Guard: if event parsing failed, newTokenId is still 0 — the NFT exists on-chain
    // but we don't know its ID. Throw to prevent config corruption with token_id=0.
    if (newTokenId === 0) {
      throw new Error(
        `Mint tx succeeded (${receipt.hash}) but could not parse newTokenId from events. ` +
        `The NFT exists on-chain — scan wallet NFTs to find it. ` +
        `DO NOT re-mint. Check tx receipt manually.`,
      );
    }

    logger.info(`Minted new position #${newTokenId}`, {
      liquidity: mintedLiquidity.toString(),
      amount0: mintedAmount0.toString(),
      amount1: mintedAmount1.toString(),
    });

    return {
      newTokenId,
      liquidity: mintedLiquidity,
      amount0: mintedAmount0,
      amount1: mintedAmount1,
      txHash: receipt.hash,
      gasUsed: receipt.gasUsed,
      blockNumber: receipt.blockNumber,
    };
  } catch (error) {
    await chain.nonceManager.resetNonce();
    throw error;
  }
}

// ============================================================
// Increase Liquidity — add tokens to an existing position
// ============================================================

export async function increaseLiquidity(
  tokenId: number,
  amount0Desired: bigint,
  amount1Desired: bigint,
  slippageBps: number,
  contracts: ContractInstances,
  chain: ChainContext,
): Promise<IncreaseLiquidityResult> {
  const deadline = BigInt(
    Math.floor(Date.now() / 1000) + DEFAULT_DEADLINE_MINUTES * 60,
  );

  // Derive NPM address from the contract instance
  const npmAddress = (contracts.positionManager as ethers.Contract).target as string;

  // Approve both tokens to PositionManager (exact amounts)
  const posData = await contracts.positionManager.positions(tokenId);
  const token0 = posData.token0 as string;
  const token1 = posData.token1 as string;
  const tickLower = Number(posData.tickLower);
  const tickUpper = Number(posData.tickUpper);
  // Aerodrome CL / Algebra V3 return tickSpacing, not fee — both serve as pool key
  const fee = posData.tickSpacing !== undefined ? Number(posData.tickSpacing) : Number(posData.fee);

  await ensureApproval(token0, npmAddress, amount0Desired, contracts, chain);
  await ensureApproval(token1, npmAddress, amount1Desired, contracts, chain);

  // Calculate slippage-protected minimums using pool state
  const sqrtPriceAX96 = tickToSqrtPriceX96(tickLower);
  const sqrtPriceBX96 = tickToSqrtPriceX96(tickUpper);
  const poolAddress = await contracts.factory.getPool(token0, token1, fee);
  const poolState = await getPoolState(poolAddress, contracts, chain);

  const expectedLiquidity = getLiquidityForAmounts(
    poolState.sqrtPriceX96, sqrtPriceAX96, sqrtPriceBX96, amount0Desired, amount1Desired,
  );
  const expectedAmounts = getAmountsForLiquidity(
    poolState.sqrtPriceX96, sqrtPriceAX96, sqrtPriceBX96, expectedLiquidity,
  );
  const slippageMul = BigInt(10000 - slippageBps);
  const amount0Min = (expectedAmounts.amount0 * slippageMul) / 10000n;
  const amount1Min = (expectedAmounts.amount1 * slippageMul) / 10000n;
  logger.info(`increaseLiquidity slippage: expected0=${expectedAmounts.amount0}, expected1=${expectedAmounts.amount1}, min0=${amount0Min}, min1=${amount1Min}`);

  const nonce = await chain.nonceManager.getNextNonce();
  try {
    const tx = await contracts.positionManager.increaseLiquidity(
      {
        tokenId,
        amount0Desired,
        amount1Desired,
        amount0Min,
        amount1Min,
        deadline,
      },
      { gasLimit: GAS_LIMITS.INCREASE_LIQUIDITY, nonce },
    );
    const receipt = await tx.wait();
    if (!receipt) throw new Error('increaseLiquidity tx dropped from mempool (receipt is null)');
    chain.nonceManager.confirmNonce(nonce);

    // Parse IncreaseLiquidity event
    let liquidity = 0n;
    let amount0 = 0n;
    let amount1 = 0n;
    const iface = contracts.positionManager.interface;
    for (const log of receipt.logs) {
      try {
        const parsed = iface.parseLog({ topics: log.topics as string[], data: log.data });
        if (parsed && parsed.name === 'IncreaseLiquidity') {
          liquidity = BigInt(parsed.args.liquidity);
          amount0 = BigInt(parsed.args.amount0);
          amount1 = BigInt(parsed.args.amount1);
        }
      } catch {
        // Not our event
      }
    }

    logger.info(`Increased liquidity on position #${tokenId}`, {
      liquidity: liquidity.toString(),
      amount0: amount0.toString(),
      amount1: amount1.toString(),
    });

    return { liquidity, amount0, amount1, txHash: receipt.hash, gasUsed: receipt.gasUsed, blockNumber: receipt.blockNumber };
  } catch (error) {
    await chain.nonceManager.resetNonce();
    throw error;
  }
}

// ============================================================
// Decrease Position Liquidity — partial removal without burn
// ============================================================

export async function decreasePositionLiquidity(
  tokenId: number,
  percentageBps: number,
  slippageBps: number,
  contracts: ContractInstances,
  chain: ChainContext,
): Promise<DecreaseLiquidityResult> {
  const deadline = BigInt(
    Math.floor(Date.now() / 1000) + DEFAULT_DEADLINE_MINUTES * 60,
  );

  // Fetch position data
  const posData = await contracts.positionManager.positions(tokenId);
  const liquidity = BigInt(posData.liquidity);
  const tickLower = Number(posData.tickLower);
  const tickUpper = Number(posData.tickUpper);

  if (liquidity === 0n) {
    throw new Error(`Position #${tokenId} has zero liquidity — nothing to decrease`);
  }

  // Calculate liquidity to remove
  const liquidityToRemove = (liquidity * BigInt(percentageBps)) / 10000n;
  if (liquidityToRemove === 0n) {
    throw new Error(`Percentage too small — would remove zero liquidity`);
  }

  // Fetch pool state for slippage calculations
  const token0 = posData.token0 as string;
  const token1 = posData.token1 as string;
  // Aerodrome CL / Algebra V3 return tickSpacing, not fee — both serve as pool key
  const fee = posData.tickSpacing !== undefined ? Number(posData.tickSpacing) : Number(posData.fee);
  const poolAddress = await contracts.factory.getPool(token0, token1, fee);
  const poolState = await getPoolState(poolAddress, contracts, chain);

  const sqrtPriceAX96 = tickToSqrtPriceX96(tickLower);
  const sqrtPriceBX96 = tickToSqrtPriceX96(tickUpper);
  const expected = getAmountsForLiquidity(poolState.sqrtPriceX96, sqrtPriceAX96, sqrtPriceBX96, liquidityToRemove);
  const slippageMul = BigInt(10000 - slippageBps);
  const amount0Min = (expected.amount0 * slippageMul) / 10000n;
  const amount1Min = (expected.amount1 * slippageMul) / 10000n;
  logger.info(`decreasePositionLiquidity: removing ${percentageBps}bps, liquidity=${liquidityToRemove}, amount0Min=${amount0Min}, amount1Min=${amount1Min}`);

  // Step 1: Decrease liquidity
  let nonce = await chain.nonceManager.getNextNonce();
  let decreaseTxHash: string;
  let decreaseGasUsed: bigint;
  let decreaseBlockNumber: number;
  try {
    const tx = await contracts.positionManager.decreaseLiquidity(
      {
        tokenId,
        liquidity: liquidityToRemove,
        amount0Min,
        amount1Min,
        deadline,
      },
      { gasLimit: GAS_LIMITS.BURN, nonce },
    );
    const receipt = await tx.wait();
    if (!receipt) throw new Error('decreaseLiquidity tx dropped from mempool (receipt is null)');
    chain.nonceManager.confirmNonce(nonce);
    decreaseTxHash = receipt.hash;
    decreaseGasUsed = receipt.gasUsed;
    decreaseBlockNumber = receipt.blockNumber;
  } catch (error) {
    await chain.nonceManager.resetNonce();
    throw error;
  }

  // Step 2: Collect the freed tokens
  nonce = await chain.nonceManager.getNextNonce();
  let collectTxHash: string;
  let collectGasUsed: bigint;
  let collectBlockNumber: number;
  let amount0 = 0n;
  let amount1 = 0n;
  try {
    const tx = await contracts.positionManager.collect(
      {
        tokenId,
        recipient: chain.wallet.address,
        amount0Max: MAX_UINT128,
        amount1Max: MAX_UINT128,
      },
      { gasLimit: GAS_LIMITS.COLLECT, nonce },
    );
    const receipt = await tx.wait();
    if (!receipt) throw new Error('collect tx dropped from mempool (receipt is null)');
    chain.nonceManager.confirmNonce(nonce);
    collectTxHash = receipt.hash;
    collectGasUsed = receipt.gasUsed;
    collectBlockNumber = receipt.blockNumber;

    // Parse Collect event
    const iface = contracts.positionManager.interface;
    for (const log of receipt.logs) {
      try {
        const parsed = iface.parseLog({ topics: log.topics as string[], data: log.data });
        if (parsed && parsed.name === 'Collect') {
          amount0 = BigInt(parsed.args.amount0);
          amount1 = BigInt(parsed.args.amount1);
        }
      } catch {
        // Not our event
      }
    }
  } catch (error) {
    await chain.nonceManager.resetNonce();
    throw error;
  }

  logger.info(`Decreased liquidity on position #${tokenId} by ${percentageBps / 100}%`, {
    amount0: amount0.toString(),
    amount1: amount1.toString(),
  });

  return {
    amount0,
    amount1,
    decreaseTxHash,
    collectTxHash,
    gasUsed: decreaseGasUsed + collectGasUsed,
    decreaseBlockNumber,
    collectBlockNumber,
  };
}

// ============================================================
// Config.yaml update — write new token ID after rebalance
// ============================================================

export function updateConfigTokenId(
  oldTokenId: number,
  newTokenId: number,
  posConfig: PositionConfig,
): void {
  try {
    const configPath = resolve(process.cwd(), 'config.yaml');
    const yamlContent = readFileSync(configPath, 'utf-8');
    const parsed = parseYaml(yamlContent) as Record<string, unknown>;

    const positions = parsed.positions as Array<Record<string, unknown>>;
    if (positions) {
      for (const pos of positions) {
        if (pos.token_id === oldTokenId) {
          pos.token_id = newTokenId;
          break;
        }
      }
    }

    const header =
      '# 9mm V3 LP Auto-Rebalancer Configuration\n' +
      '# Contract addresses VERIFIED from main-liquidity-dashboard\n' +
      `# Last rebalance update: ${new Date().toISOString()}\n\n`;
    // Atomic write: write to temp file first, then rename to prevent corruption on crash
    const tmpPath = configPath + '.tmp';
    writeFileSync(tmpPath, header + stringifyYaml(parsed));
    renameSync(tmpPath, configPath);

    // Update in-memory config
    posConfig.token_id = newTokenId;

    logger.info(`Updated config.yaml: position ${oldTokenId} -> ${newTokenId}`);
  } catch (error) {
    logger.error(`Failed to update config.yaml with new token ID: ${error}`);
    logger.error(
      `MANUAL ACTION REQUIRED: Update config.yaml positions token_id from ${oldTokenId} to ${newTokenId}`,
    );
    // Still update in-memory so the bot tracks the right position this session
    posConfig.token_id = newTokenId;
  }
}

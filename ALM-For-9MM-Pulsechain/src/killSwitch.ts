/**
 * Kill Switch — per-position automatic disable when losses exceed thresholds.
 *
 * Persists state to `.kill-switch-state.json` so it survives PM2 restarts.
 * Each position tracks consecutive losses and a rolling loss history window.
 *
 * Kill conditions:
 * 1. Consecutive losses: N rebalances in a row with ROI below max_loss_percent
 * 2. HODL ratio: position value drops below min_hodl_ratio of initial value
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import type { KillSwitchParams } from './types.js';
import type { RebalanceAnalytics } from './analytics/types.js';
import logger from './logger.js';

const KILL_SWITCH_STATE_PATH = resolve(process.cwd(), '.kill-switch-state.json');

interface PositionKillState {
  disabled: boolean;
  consecutiveLosses: number;
  lossHistory: Array<{ timestamp: number; netRoiPercent: number }>;
  initialValueUsd?: number;
  disabledAt?: number;
  reason?: string;
}

interface KillSwitchState {
  positions: Record<string, PositionKillState>;
}

let state: KillSwitchState = { positions: {} };

function getOrCreateEntry(posKey: string): PositionKillState {
  if (!state.positions[posKey]) {
    state.positions[posKey] = {
      disabled: false,
      consecutiveLosses: 0,
      lossHistory: [],
    };
  }
  return state.positions[posKey];
}

function persistState(): void {
  try {
    writeFileSync(KILL_SWITCH_STATE_PATH, JSON.stringify(state, null, 2));
  } catch (err) {
    logger.warn(`Failed to persist kill switch state: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * Load kill switch state from disk. Called once at startup.
 */
export function loadKillSwitchState(): void {
  if (!existsSync(KILL_SWITCH_STATE_PATH)) return;

  try {
    const raw = JSON.parse(readFileSync(KILL_SWITCH_STATE_PATH, 'utf-8'));

    // Schema validation — reject malformed state
    if (!raw || typeof raw !== 'object' || typeof raw.positions !== 'object') {
      logger.warn('Kill switch state file has invalid schema — starting fresh');
      state = { positions: {} };
      return;
    }

    // Validate each position entry
    const validated: Record<string, PositionKillState> = {};
    for (const [key, entry] of Object.entries(raw.positions)) {
      const e = entry as Record<string, unknown>;
      if (
        typeof e.disabled !== 'boolean' ||
        typeof e.consecutiveLosses !== 'number' ||
        !Array.isArray(e.lossHistory)
      ) {
        logger.warn(`Kill switch: invalid entry for ${key} — skipping`);
        continue;
      }
      validated[key] = {
        disabled: e.disabled,
        consecutiveLosses: e.consecutiveLosses,
        lossHistory: (e.lossHistory as Array<Record<string, unknown>>).filter(
          (l) => typeof l.timestamp === 'number' && typeof l.netRoiPercent === 'number',
        ) as PositionKillState['lossHistory'],
        ...(typeof e.initialValueUsd === 'number' && { initialValueUsd: e.initialValueUsd }),
        ...(typeof e.disabledAt === 'number' && { disabledAt: e.disabledAt }),
        ...(typeof e.reason === 'string' && { reason: e.reason }),
      };
    }

    state = { positions: validated };
    const disabledCount = Object.entries(validated).filter(([k, e]) => !k.startsWith('test-') && e.disabled).length;
    if (disabledCount > 0) {
      logger.warn(`Kill switch: ${disabledCount} position(s) are disabled`);
    }
  } catch (err) {
    logger.warn(`Failed to load kill switch state: ${err instanceof Error ? err.message : String(err)}`);
    state = { positions: {} };
  }
}

/**
 * Check if a position's kill switch has been triggered.
 */
export function isKillSwitchTriggered(posKey: string): boolean {
  return state.positions[posKey]?.disabled ?? false;
}

/**
 * Get kill switch status for a position (for display in /status command).
 */
export function getKillSwitchStatus(posKey: string): {
  disabled: boolean;
  consecutiveLosses: number;
  reason?: string;
  disabledAt?: number;
} | null {
  const entry = state.positions[posKey];
  if (!entry) return null;
  return {
    disabled: entry.disabled,
    consecutiveLosses: entry.consecutiveLosses,
    reason: entry.reason,
    disabledAt: entry.disabledAt,
  };
}

/**
 * Reset the kill switch for a position (called by /enable command).
 */
export function resetKillSwitch(posKey: string): void {
  const entry = state.positions[posKey];
  if (entry) {
    entry.disabled = false;
    entry.consecutiveLosses = 0;
    entry.lossHistory = [];
    delete entry.disabledAt;
    delete entry.reason;
    persistState();
    logger.info(`Kill switch reset for ${posKey}`);
  }
}

/**
 * Evaluate kill switch conditions after a rebalance.
 * Returns whether the kill switch was triggered and the reason.
 */
export function evaluateKillSwitch(
  posKey: string,
  analytics: RebalanceAnalytics,
  params: KillSwitchParams | undefined,
  prePositionValueUsd: number,
): { triggered: boolean; reason?: string } {
  if (!params) return { triggered: false };

  const entry = getOrCreateEntry(posKey);
  const now = Date.now();

  // Store initial value on first evaluation (for HODL ratio tracking)
  if (entry.initialValueUsd === undefined && prePositionValueUsd > 0) {
    entry.initialValueUsd = prePositionValueUsd;
  }

  // Prune loss history outside window
  const windowMs = (params.loss_window_hours ?? 24) * 3600 * 1000;
  entry.lossHistory = entry.lossHistory.filter((l) => now - l.timestamp < windowMs);

  // Check if this rebalance was a loss
  const netRoi = analytics.metrics.netROIPercent;
  const maxLossPct = params.max_loss_percent ?? -5;
  if (netRoi < maxLossPct) {
    entry.consecutiveLosses++;
    entry.lossHistory.push({ timestamp: now, netRoiPercent: netRoi });
  } else {
    entry.consecutiveLosses = 0; // Reset on non-loss rebalance
  }

  // Check consecutive loss threshold
  const maxConsecutive = params.max_consecutive_losses ?? 3;
  if (entry.consecutiveLosses >= maxConsecutive) {
    entry.disabled = true;
    entry.disabledAt = now;
    entry.reason = `${entry.consecutiveLosses} consecutive rebalances with ROI < ${maxLossPct}%`;
    persistState();
    return { triggered: true, reason: entry.reason };
  }

  // Check HODL ratio (if configured and initial value is known)
  if (
    params.min_hodl_ratio !== undefined &&
    entry.initialValueUsd !== undefined &&
    entry.initialValueUsd > 0 &&
    prePositionValueUsd > 0
  ) {
    const hodlRatio = prePositionValueUsd / entry.initialValueUsd;
    if (hodlRatio < params.min_hodl_ratio) {
      entry.disabled = true;
      entry.disabledAt = now;
      entry.reason = `Value vs HODL ratio ${hodlRatio.toFixed(3)} below minimum ${params.min_hodl_ratio}`;
      persistState();
      return { triggered: true, reason: entry.reason };
    }
  }

  persistState();
  return { triggered: false };
}

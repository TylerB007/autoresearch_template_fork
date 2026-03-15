/**
 * Strategy engine — evaluates whether a position should be rebalanced
 * and computes the new tick range based on the configured strategy type
 */

import type { PositionStatus, PositionConfig, RebalanceDecision } from './types.js';
import { nearestUsableTick, percentageToTicks } from './math.js';
import logger from './logger.js';

/** Map new base strategy names to canonical internal names used in the switch. */
const STRATEGY_ALIASES: Record<string, string> = {
  center: 'pulse',
  bullish: 'snuggle_up',
  bearish: 'snuggle_down',
  lazy_up: 'lazy_ascending',
  lazy_down: 'lazy_descending',
};

/** Check if a strategy name has a preset width suffix (e.g., pulse_300, center_6pct). */
export const PRESET_WIDTH_REGEX = /^.+_(\d+)(pct)?$/;

/**
 * Parse strategy name to extract base strategy and preset width (in ticks).
 * Supports both tick-based and percentage-based presets:
 *   "pulse_300"     → { base: "pulse",      presetWidth: 300 }
 *   "center_3pct"   → { base: "center",     presetWidth: ~300 }  (converted from 3%)
 *   "snuggle_up"    → { base: "snuggle_up",  presetWidth: null }
 *   "bullish_6pct"  → { base: "bullish",     presetWidth: ~583 }  (converted from 6%)
 */
export function parseStrategy(strategy: string): { base: string; presetWidth: number | null } {
  const match = strategy.match(/^(.+?)_(\d+)(pct)?$/);
  if (match) {
    const base = match[1];
    const num = parseInt(match[2]);
    const isPct = match[3] === 'pct';
    const presetWidth = isPct ? percentageToTicks(num) : num;
    return { base, presetWidth };
  }
  return { base: strategy, presetWidth: null };
}

/** Resolve strategy alias to canonical name for the switch statement. */
function resolveAlias(base: string): string {
  return STRATEGY_ALIASES[base] ?? base;
}

export function evaluateStrategy(
  status: PositionStatus,
  config: PositionConfig,
): RebalanceDecision {
  const { position, pool, isInRange, tickDistance } = status;
  const { strategy, params } = config;
  let { width_ticks, trigger_distance_ticks } = params;
  const { tickSpacing, currentTick } = pool;

  // Parse strategy to extract base and preset width, resolving aliases (center→pulse, etc.)
  const parsed = parseStrategy(strategy);
  const baseStrategy = resolveAlias(parsed.base);
  const presetWidth = parsed.presetWidth;

  // If strategy has preset width, override config width_ticks
  if (presetWidth !== null) {
    width_ticks = presetWidth;
  }

  if (position.liquidity === 0n) {
    return { shouldRebalance: false, reason: 'Position has zero liquidity' };
  }

  switch (baseStrategy) {
    /**
     * STATIC STRATEGY
     * Behavior: Passive monitoring only.
     * Action: Never executes a rebalance transaction.
     * Use Case: Logging/notifications without automated trading actions.
     */
    case 'static': {
      if (!isInRange) {
        logger.warn(
          `[STATIC] Position ${position.tokenId} is OUT OF RANGE ` +
            `(tick ${currentTick}, range [${position.tickLower}, ${position.tickUpper}])`,
        );
      }
      return {
        shouldRebalance: false,
        reason: isInRange
          ? 'Static: position in range'
          : `Static: position out of range (tick ${currentTick}, range [${position.tickLower}, ${position.tickUpper}]). Manual action required.`,
      };
    }

    /**
     * PULSE STRATEGY
     * Behavior: Standard "re-centering" strategy.
     * Action: If price moves out of range (+ trigger buffer), it recenters the position
     *         around the current price. Active in both directions (up and down).
     * Use Case: Maximizing time in range and fee collection.
     */
    case 'pulse': {
      if (isInRange || tickDistance < trigger_distance_ticks) {
        return {
          shouldRebalance: false,
          reason: isInRange
            ? `Pulse: in range (tick ${currentTick} in [${position.tickLower}, ${position.tickUpper}])`
            : `Pulse: ${tickDistance} ticks out of range (trigger: ${trigger_distance_ticks})`,
        };
      }
      const halfWidth = Math.floor(width_ticks / 2);
      const newTickLower = nearestUsableTick(currentTick - halfWidth, tickSpacing);
      const newTickUpper = nearestUsableTick(currentTick + halfWidth, tickSpacing);
      return {
    /**
     * LAZY ASCENDING STRATEGY
     * Behavior: Bullish/Upward-only rebalancing.
     * Action: Only rebalances if price moves ABOVE the upper bound.
     *         If price drops below range, it does nothing (holds the bag).
     * Use Case: Following a pump while avoiding selling low on a dump.
     */
        shouldRebalance: true,
        reason: `Pulse: tick ${currentTick} is ${tickDistance} ticks beyond range [${position.tickLower}, ${position.tickUpper}]. Recentering to [${newTickLower}, ${newTickUpper}]`,
        newTickLower,
        newTickUpper,
      };
    }

    case 'lazy_ascending': {
      const aboveUpper = currentTick >= position.tickUpper;
      if (!aboveUpper || tickDistance < trigger_distance_ticks) {
        return {
          shouldRebalance: false,
          reason: aboveUpper
            ? `Lazy Ascending: ${tickDistance} ticks above upper (trigger: ${trigger_distance_ticks})`
            : `Lazy Ascending: price not above upper bound (tick ${currentTick}, upper ${position.tickUpper})`,
        };
      }
      const halfWidth = Math.floor(width_ticks / 2);
      const newTickLower = nearestUsableTick(currentTick - halfWidth, tickSpacing);
      const newTickUpper = nearestUsableTick(currentTick + halfWidth, tickSpacing);
      return {
    /**
     * LAZY DESCENDING STRATEGY
     * Behavior: Bearish/Downward-only rebalancing.
     * Action: Only rebalances if price moves BELOW the lower bound.
     *         If price rises above range, it does nothing (holds/takes profit).
     * Use Case: Accumulating assets on the way down, stopping rebalance if price recovers.
     */
        shouldRebalance: true,
        reason: `Lazy Ascending: tick ${currentTick} is ${tickDistance} ticks above upper ${position.tickUpper}. New range [${newTickLower}, ${newTickUpper}]`,
        newTickLower,
        newTickUpper,
      };
    }

    case 'lazy_descending': {
      const belowLower = currentTick < position.tickLower;
      if (!belowLower || tickDistance < trigger_distance_ticks) {
        return {
          shouldRebalance: false,
          reason: belowLower
            ? `Lazy Descending: ${tickDistance} ticks below lower (trigger: ${trigger_distance_ticks})`
            : `Lazy Descending: price not below lower bound (tick ${currentTick}, lower ${position.tickLower})`,
        };
      }
      const halfWidth = Math.floor(width_ticks / 2);
      const newTickLower = nearestUsableTick(currentTick - halfWidth, tickSpacing);
      const newTickUpper = nearestUsableTick(currentTick + halfWidth, tickSpacing);
      return {
        shouldRebalance: true,
        reason: `Lazy Descending: tick ${currentTick} is ${tickDistance} ticks below lower ${position.tickLower}. New range [${newTickLower}, ${newTickUpper}]`,
        newTickLower,
        newTickUpper,
      };
    }

    /**
     * SNUGGLE UP STRATEGY
     * Behavior: Asymmetric re-balancing favoring UPSIDE.
     * Action: Like Pulse, but range is split 30% below, 70% above current price.
     * Use Case: Bullish sentiment. Gives price more room to run up before going out of range.
     */
    case 'snuggle_up': {
      if (isInRange || tickDistance < trigger_distance_ticks) {
        return {
          shouldRebalance: false,
          reason: isInRange
            ? `Snuggle Up: in range (tick ${currentTick} in [${position.tickLower}, ${position.tickUpper}])`
            : `Snuggle Up: ${tickDistance} ticks out of range (trigger: ${trigger_distance_ticks})`,
        };
      }
      
      // Use configurable ratio or default to 30% below
      const lowerRatio = params.lower_ratio_percent ?? 30;
      const lowerWidth = Math.floor((width_ticks * lowerRatio) / 100);
      const upperWidth = width_ticks - lowerWidth; // ensure sum is width_ticks
      const upperRatio = 100 - lowerRatio;

      const newTickLower = nearestUsableTick(currentTick - lowerWidth, tickSpacing);
      const newTickUpper = nearestUsableTick(currentTick + upperWidth, tickSpacing);

      return {
        shouldRebalance: true,
        reason: `Snuggle Up: tick ${currentTick} is ${tickDistance} ticks out of range. Rebalancing ${lowerRatio}/${upperRatio} [${newTickLower}, ${newTickUpper}]`,
        newTickLower,
        newTickUpper,
      };
    }

    /**
     * SNUGGLE DOWN STRATEGY
     * Behavior: Asymmetric re-balancing favoring DOWNSIDE.
     * Action: Like Pulse, but range is split 70% below, 30% above current price.
     * Use Case: Bearish sentiment. Gives price more room to drop before going out of range.
     */
    case 'snuggle_down': {
      if (isInRange || tickDistance < trigger_distance_ticks) {
        return {
          shouldRebalance: false,
          reason: isInRange
            ? `Snuggle Down: in range (tick ${currentTick} in [${position.tickLower}, ${position.tickUpper}])`
            : `Snuggle Down: ${tickDistance} ticks out of range (trigger: ${trigger_distance_ticks})`,
        };
      }
      
      // Use configurable ratio or default to 30% above
      const upperRatio = params.lower_ratio_percent ?? 30;
      const upperWidth = Math.floor((width_ticks * upperRatio) / 100);
      const lowerWidth = width_ticks - upperWidth; // ensure sum is width_ticks
      const lowerRatio = 100 - upperRatio;

      const newTickLower = nearestUsableTick(currentTick - lowerWidth, tickSpacing);
      const newTickUpper = nearestUsableTick(currentTick + upperWidth, tickSpacing);

      return {
        shouldRebalance: true,
        reason: `Snuggle Down: tick ${currentTick} is ${tickDistance} ticks out of range. Rebalancing ${lowerRatio}/${upperRatio} [${newTickLower}, ${newTickUpper}]`,
        newTickLower,
        newTickUpper,
      };
    }

    default:
      throw new Error(`Unknown strategy: ${strategy}`);
  }
}

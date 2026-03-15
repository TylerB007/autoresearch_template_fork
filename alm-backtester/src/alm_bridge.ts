/**
 * Bridge module — re-exports pure functions from the ALM project.
 *
 * The ALM strategy module imports a Winston logger. Since we don't want
 * to pull in Winston for the backtester, we register a mock logger module
 * before importing strategy. tsx supports loader hooks, but the simplest
 * approach is to re-implement the few pure functions we need directly
 * rather than fighting ESM module resolution across project boundaries.
 *
 * Instead: we copy the pure math functions we need. The ALM math is
 * stable (direct port of Solidity) and unlikely to change. If it does,
 * this bridge is the single place to update.
 */

// =============================================================
// Re-export from ALM math.ts (pure BigInt functions, no deps)
// =============================================================

// We import directly since math.ts has no external dependencies
export {
  tickToSqrtPriceX96,
  sqrtPriceX96ToTick,
  tickToPrice,
  priceToTick,
  nearestUsableTick,
  getAmountsForLiquidity,
  getLiquidityForAmounts,
  calculateSwapAmount,
  percentageToTicks,
  ticksToPercentage,
} from '../../ALM-For-9MM-Pulsechain/src/math.js';

// bigintFloat has no deps either
export {
  bigintToFloat,
  sqrtPriceX96ToPrice,
} from '../../ALM-For-9MM-Pulsechain/src/bigintFloat.js';

// =============================================================
// Strategy evaluation — reimplemented to avoid logger dependency
// =============================================================

// We reimplement evaluateStrategy locally to avoid the winston import
// chain. The logic is a direct copy of ALM's strategy.ts.

interface MinimalPositionStatus {
  position: { tokenId: number; tickLower: number; tickUpper: number; liquidity: bigint };
  pool: { tickSpacing: number; currentTick: number };
  isInRange: boolean;
  tickDistance: number;
}

interface MinimalPositionConfig {
  strategy: string;
  params: {
    width_ticks: number;
    trigger_distance_ticks: number;
    lower_ratio_percent?: number;
  };
}

interface RebalanceDecision {
  shouldRebalance: boolean;
  reason: string;
  newTickLower?: number;
  newTickUpper?: number;
}

import { nearestUsableTick, percentageToTicks } from '../../ALM-For-9MM-Pulsechain/src/math.js';

const STRATEGY_ALIASES: Record<string, string> = {
  center: 'pulse',
  bullish: 'snuggle_up',
  bearish: 'snuggle_down',
  lazy_up: 'lazy_ascending',
  lazy_down: 'lazy_descending',
};

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

function resolveAlias(base: string): string {
  return STRATEGY_ALIASES[base] ?? base;
}

export function evaluateStrategy(
  status: MinimalPositionStatus,
  config: MinimalPositionConfig,
): RebalanceDecision {
  const { position, pool, isInRange, tickDistance } = status;
  const { strategy, params } = config;
  let { width_ticks, trigger_distance_ticks } = params;
  const { tickSpacing, currentTick } = pool;

  const parsed = parseStrategy(strategy);
  const baseStrategy = resolveAlias(parsed.base);
  const presetWidth = parsed.presetWidth;

  if (presetWidth !== null) {
    width_ticks = presetWidth;
  }

  if (position.liquidity === 0n) {
    return { shouldRebalance: false, reason: 'Position has zero liquidity' };
  }

  switch (baseStrategy) {
    case 'static': {
      return { shouldRebalance: false, reason: 'Static strategy — no rebalance' };
    }

    case 'pulse': {
      if (isInRange || tickDistance < trigger_distance_ticks) {
        return { shouldRebalance: false, reason: `Pulse: in range or below trigger` };
      }
      const halfWidth = Math.floor(width_ticks / 2);
      return {
        shouldRebalance: true,
        reason: `Pulse: recentering`,
        newTickLower: nearestUsableTick(currentTick - halfWidth, tickSpacing),
        newTickUpper: nearestUsableTick(currentTick + halfWidth, tickSpacing),
      };
    }

    case 'lazy_ascending': {
      const aboveUpper = currentTick >= position.tickUpper;
      if (!aboveUpper || tickDistance < trigger_distance_ticks) {
        return { shouldRebalance: false, reason: `Lazy Ascending: not triggered` };
      }
      const halfWidth = Math.floor(width_ticks / 2);
      return {
        shouldRebalance: true,
        reason: `Lazy Ascending: recentering upward`,
        newTickLower: nearestUsableTick(currentTick - halfWidth, tickSpacing),
        newTickUpper: nearestUsableTick(currentTick + halfWidth, tickSpacing),
      };
    }

    case 'lazy_descending': {
      const belowLower = currentTick < position.tickLower;
      if (!belowLower || tickDistance < trigger_distance_ticks) {
        return { shouldRebalance: false, reason: `Lazy Descending: not triggered` };
      }
      const halfWidth = Math.floor(width_ticks / 2);
      return {
        shouldRebalance: true,
        reason: `Lazy Descending: recentering downward`,
        newTickLower: nearestUsableTick(currentTick - halfWidth, tickSpacing),
        newTickUpper: nearestUsableTick(currentTick + halfWidth, tickSpacing),
      };
    }

    case 'snuggle_up': {
      if (isInRange || tickDistance < trigger_distance_ticks) {
        return { shouldRebalance: false, reason: `Snuggle Up: in range or below trigger` };
      }
      const lowerRatio = params.lower_ratio_percent ?? 30;
      const lowerWidth = Math.floor((width_ticks * lowerRatio) / 100);
      const upperWidth = width_ticks - lowerWidth;
      return {
        shouldRebalance: true,
        reason: `Snuggle Up: rebalancing ${lowerRatio}/${100 - lowerRatio}`,
        newTickLower: nearestUsableTick(currentTick - lowerWidth, tickSpacing),
        newTickUpper: nearestUsableTick(currentTick + upperWidth, tickSpacing),
      };
    }

    case 'snuggle_down': {
      if (isInRange || tickDistance < trigger_distance_ticks) {
        return { shouldRebalance: false, reason: `Snuggle Down: in range or below trigger` };
      }
      const upperRatio = params.lower_ratio_percent ?? 30;
      const upperWidth = Math.floor((width_ticks * upperRatio) / 100);
      const lowerWidth = width_ticks - upperWidth;
      return {
        shouldRebalance: true,
        reason: `Snuggle Down: rebalancing ${100 - upperRatio}/${upperRatio}`,
        newTickLower: nearestUsableTick(currentTick - lowerWidth, tickSpacing),
        newTickUpper: nearestUsableTick(currentTick + upperWidth, tickSpacing),
      };
    }

    default:
      throw new Error(`Unknown strategy: ${strategy}`);
  }
}

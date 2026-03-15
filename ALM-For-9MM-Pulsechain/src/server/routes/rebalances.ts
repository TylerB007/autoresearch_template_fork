/**
 * Rebalance history routes — exposes analytics data via REST API
 */

import { Router, type Request, type Response } from 'express';
import type { AppConfig } from '../../types.js';
import { queryAllChainRebalances } from '../../analytics/storage.js';
import type { RebalanceAnalytics } from '../../analytics/types.js';
import logger from '../../logger.js';

const bigIntReplacer = (_key: string, value: unknown): unknown =>
  typeof value === 'bigint' ? value.toString() : value;

type ExecutionCostQuality = 'exact' | 'partial' | 'estimated' | 'unavailable';

function deriveExecutionCostQuality(rebalance: RebalanceAnalytics): ExecutionCostQuality {
  if (typeof rebalance.gasCostUsd !== 'number') return 'unavailable';
  if (!rebalance.gasUsed.totalCostWei) return 'estimated';
  if (rebalance.dustUsd === undefined) return 'partial';
  return 'exact';
}

function enrichRebalance(rebalance: RebalanceAnalytics): Record<string, unknown> {
  const executionCostQuality = deriveExecutionCostQuality(rebalance);
  const realizedExecutionDeltaBps = rebalance.swap?.realizedExecutionDeltaBps ?? rebalance.swap?.slippageBps;
  const executionCostUsd =
    typeof rebalance.gasCostUsd === 'number'
      ? rebalance.gasCostUsd + (rebalance.swapFrictionUsd ?? 0) + (rebalance.dustUsd ?? 0)
      : null;
  const feesToExecutionCostRatio =
    executionCostUsd !== null && typeof rebalance.feesCollectedUsd === 'number'
      ? executionCostUsd > 0
        ? rebalance.feesCollectedUsd / executionCostUsd
        : rebalance.feesCollectedUsd > 0 ? Infinity : 0
      : null;

  const missingFields: string[] = [];
  if (!rebalance.gasUsed.totalCostWei) missingFields.push('receipt_exact_gas');
  if (rebalance.dustUsd === undefined) missingFields.push('dust_accounting');
  if (rebalance.swap && rebalance.swap.configuredSlippageBps === undefined) {
    missingFields.push('configured_slippage_tolerance');
  }

  return {
    ...rebalance,
    gasCostSource: rebalance.gasUsed.totalCostWei ? 'receipt_exact' : 'estimated_aggregate',
    recordQuality: {
      executionCostQuality,
      isPartial: missingFields.length > 0,
      missingFields,
    },
    swap: rebalance.swap
      ? {
          ...rebalance.swap,
          realizedExecutionDeltaBps,
        }
      : undefined,
    metrics: {
      ...rebalance.metrics,
      executionCostUsd,
      feesToExecutionCostRatio,
      feesToExecutionCostQuality: executionCostQuality,
    },
  };
}

export function createRebalancesRouter(config: AppConfig): Router {
  const router = Router();

  // GET /api/rebalances?days=7
  router.get('/', async (req: Request, res: Response) => {
    try {
      const days = parseInt(req.query.days as string, 10) || 7;
      const clampedDays = Math.min(Math.max(days, 1), 365);

      const endTime = Date.now();
      const startTime = endTime - clampedDays * 24 * 60 * 60 * 1000;

      const storagePath = config.analytics?.storage_path ?? './analytics';
      const rebalances = await queryAllChainRebalances(storagePath, startTime, endTime);

      // Serialize for JSON (BigInt → string)
      const serialized = JSON.parse(JSON.stringify(rebalances.map(enrichRebalance), bigIntReplacer));

      res.json({
        days: clampedDays,
        count: rebalances.length,
        rebalances: serialized,
      });
    } catch (err) {
      logger.error('Rebalance history error', { error: err instanceof Error ? err.message : String(err) });
      res.status(500).json({ error: 'Failed to fetch rebalance history' });
    }
  });

  return router;
}

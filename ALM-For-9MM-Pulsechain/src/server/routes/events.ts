/**
 * Lifecycle event log routes — exposes granular rebalance step events via REST API
 */

import { Router, type Request, type Response } from 'express';
import type { AppConfig } from '../../types.js';
import { queryAllChainLifecycleEvents } from '../../analytics/storage.js';
import logger from '../../logger.js';

const bigIntReplacer = (_key: string, value: unknown): unknown =>
  typeof value === 'bigint' ? value.toString() : value;

export function createEventsRouter(config: AppConfig): Router {
  const router = Router();

  // GET /api/events?days=30&tokenId=155361&rebalanceId=xxx
  router.get('/', async (req: Request, res: Response) => {
    try {
      const days = Math.min(Math.max(parseInt(req.query.days as string, 10) || 30, 1), 365);
      const tokenId = req.query.tokenId ? parseInt(req.query.tokenId as string, 10) : undefined;
      const rebalanceId = req.query.rebalanceId as string | undefined;

      const endTime = Date.now();
      const startTime = endTime - days * 24 * 60 * 60 * 1000;
      const storagePath = config.analytics?.storage_path ?? './analytics';

      const events = await queryAllChainLifecycleEvents(storagePath, tokenId, rebalanceId, startTime, endTime);
      const serialized = JSON.parse(JSON.stringify(events, bigIntReplacer));

      res.json({ days, count: events.length, events: serialized });
    } catch (err) {
      logger.error('Event log query error', { error: err instanceof Error ? err.message : String(err) });
      res.status(500).json({ error: 'Failed to fetch event log' });
    }
  });

  return router;
}

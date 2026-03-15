/**
 * GET /api/integrity?days=30
 * Runs the analytics data integrity checks against the live JSONL dataset
 * and returns a structured report for the dashboard.
 */

import { Router, type Request, type Response } from 'express';
import type { AppConfig } from '../../types.js';
import { runIntegrityChecks } from '../../analytics/integrityChecks.js';
import logger from '../../logger.js';

export function createIntegrityRouter(config: AppConfig): Router {
  const router = Router();
  const storagePath = config.analytics?.storage_path ?? './analytics';

  // GET /api/integrity?days=30
  router.get('/', async (req: Request, res: Response) => {
    try {
      const days = Math.min(90, Math.max(1, parseInt(req.query.days as string, 10) || 30));
      const report = await runIntegrityChecks(storagePath, days);
      res.json(report);
    } catch (err) {
      logger.error('Integrity check error', { error: err instanceof Error ? err.message : String(err) });
      res.status(500).json({ error: 'Failed to run integrity checks' });
    }
  });

  return router;
}

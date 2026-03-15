/**
 * Bot control routes — enable/disable rebalancing, clear safe mode
 * These endpoints mirror the Telegram /enable and /disable commands,
 * making the dashboard a complete self-service control surface.
 */

import { Router, type Request, type Response } from 'express';
import { existsSync, writeFileSync, unlinkSync } from 'node:fs';
import { resolve } from 'node:path';
import type { AppConfig } from '../../types.js';
import { clearSafeMode, posKey, RECOVERY_STATE_PATH, recoveryStatePath } from '../../rebalancer.js';
import { resetKillSwitch } from '../../killSwitch.js';
import { reloadPositions } from '../../configLoader.js';
import logger from '../../logger.js';

const DISABLE_FLAG_PATH = resolve(process.cwd(), '.rebalancing-disabled');

export function createBotRouter(config: AppConfig): Router {
  const router = Router();

  /**
   * POST /api/bot/enable
   * Re-enables rebalancing, resets kill switches, and clears safe mode for all positions.
   * Mirrors the Telegram /enable command exactly.
   */
  router.post('/enable', (_req: Request, res: Response) => {
    try {
      try { unlinkSync(DISABLE_FLAG_PATH); } catch { /* file may not exist */ }

      // Re-read positions from config.yaml in case they changed since server start
      reloadPositions(config);

      const cleared: number[] = [];
      for (const pos of config.positions) {
        const chainId = pos.chain_id ?? config.chain.chainId;
        const pk = posKey(chainId, pos.token_id);
        resetKillSwitch(pk);
        if (clearSafeMode(pk)) cleared.push(pos.token_id);
      }

      const hasRecovery = config.positions.some((pos) => {
        const chainId = pos.chain_id ?? config.chain.chainId;
        return existsSync(recoveryStatePath(chainId)) || existsSync(RECOVERY_STATE_PATH);
      });

      logger.info(`Bot ENABLED via dashboard API. Safe mode cleared: [${cleared.join(', ')}]`);
      res.json({
        success: true,
        rebalancingEnabled: true,
        safeModeCleared: cleared,
        recoveryStateWarning: hasRecovery
          ? 'A recovery state file exists. Check /recover in Telegram or the Recovery section before rebalancing.'
          : null,
      });
    } catch (error) {
      logger.error('Failed to enable bot via API', { error: (error as Error).message });
      res.status(500).json({ error: 'Failed to enable bot' });
    }
  });

  /**
   * POST /api/bot/disable
   * Emergency stop: disables all rebalancing (persists across restarts).
   * Mirrors the Telegram /disable command exactly.
   */
  router.post('/disable', (_req: Request, res: Response) => {
    try {
      writeFileSync(DISABLE_FLAG_PATH, Date.now().toString());
      logger.info('Bot DISABLED via dashboard API (emergency stop)');
      res.json({ success: true, rebalancingEnabled: false });
    } catch (error) {
      logger.error('Failed to disable bot via API', { error: (error as Error).message });
      res.status(500).json({ error: 'Failed to disable bot' });
    }
  });

  /**
   * POST /api/bot/positions/:tokenId/clear-safe-mode
   * Clears safe mode for a single position without touching other positions or kill switches.
   * Useful when only one of several positions is stuck.
   */
  router.post('/positions/:tokenId/clear-safe-mode', (_req: Request, res: Response) => {
    const tokenId = parseInt(_req.params['tokenId'] as string, 10);
    if (isNaN(tokenId)) {
      return void res.status(400).json({ error: 'Invalid tokenId' });
    }

    reloadPositions(config);
    const pos = config.positions.find((p) => p.token_id === tokenId);
    if (!pos) {
      return void res.status(404).json({ error: 'Position not found in config' });
    }

    const chainId = pos.chain_id ?? config.chain.chainId;
    const pk = posKey(chainId, tokenId);
    const wasInSafeMode = clearSafeMode(pk);

    const hasRecovery = existsSync(recoveryStatePath(chainId)) || existsSync(RECOVERY_STATE_PATH);

    logger.info(`Safe mode cleared for position #${tokenId} via dashboard API`);
    res.json({
      success: true,
      tokenId,
      wasInSafeMode,
      recoveryStateWarning: hasRecovery
        ? 'A recovery state file exists on disk. Run /recover in Telegram or use the Recovery section before the bot rebalances.'
        : null,
    });
  });

  return router;
}

/**
 * Recovery routes — surface stranded funds alerts in the dashboard
 * and allow dismissal or recovery from the web UI.
 */

import { Router, type Request, type Response } from 'express';
import type { AppConfig } from '../../types.js';
import type { ContractInstances } from '../../contracts.js';
import type { ChainContext } from '../../chain.js';
import type { MultiChainContext } from '../../multiChain.js';
import { detectStrandedFunds, recoverStrandedFunds } from '../../recovery.js';
import { clearRecoveryState } from '../../rebalancer.js';
import { sendNotification } from '../../notifications.js';
import logger from '../../logger.js';

const bigIntReplacer = (_key: string, value: unknown): unknown =>
  typeof value === 'bigint' ? value.toString() : value;

export function createRecoveryRouter(
  config: AppConfig,
  chain: ChainContext,
  contracts: ContractInstances,
  multiChain?: MultiChainContext,
): Router {
  const router = Router();

  // GET /api/recovery/status — check for stranded funds
  // Checks all configured chains for per-chain recovery state files
  router.get('/status', async (_req: Request, res: Response) => {
    try {
      // Check all chains for stranded funds (per-chain recovery state files)
      const chainIds = multiChain ? multiChain.getChainIds() : [config.chain.chainId];
      let report: Awaited<ReturnType<typeof detectStrandedFunds>> = null;
      let reportChainId = config.chain.chainId;

      for (const cid of chainIds) {
        const cc = multiChain ? multiChain.getChainById(cid) : chain;
        const cContracts = multiChain ? multiChain.registries.get(cid)!.getForDex() : contracts;
        const r = await detectStrandedFunds(cContracts, cc, cid);
        if (r) {
          report = r;
          reportChainId = cid;
          break; // Return first found — UI handles one at a time
        }
      }
      // Also check legacy (no chainId) recovery state
      if (!report) {
        report = await detectStrandedFunds(contracts, chain);
      }

      if (!report) {
        res.json({ hasAlert: false });
        return;
      }

      const { recoveryState, balance0, balance1 } = report;
      res.json(JSON.parse(JSON.stringify({
        hasAlert: true,
        report: {
          oldTokenId: recoveryState.oldTokenId,
          token0Symbol: recoveryState.token0Symbol,
          token1Symbol: recoveryState.token1Symbol,
          fee: recoveryState.fee,
          strategy: recoveryState.strategy,
          widthTicks: recoveryState.params.width_ticks,
          balance0,
          balance1,
          timestamp: recoveryState.timestamp,
        },
      }, bigIntReplacer)));
    } catch (err) {
      logger.error('Recovery status check failed', { error: (err as Error).message });
      res.status(500).json({ error: 'Failed to check recovery status' });
    }
  });

  // POST /api/recovery/dismiss — clear the recovery state file
  // Accepts optional { chainId } in body; defaults to default chain
  router.post('/dismiss', async (req: Request, res: Response) => {
    try {
      const dismissChainId = (req.body as { chainId?: number })?.chainId ?? config.chain.chainId;
      clearRecoveryState(dismissChainId);
      logger.info('Recovery alert dismissed from dashboard', { chainId: dismissChainId });
      await sendNotification('Recovery alert dismissed from dashboard', config);
      res.json({ message: 'Recovery alert dismissed' });
    } catch (err) {
      logger.error('Failed to dismiss recovery alert', { error: (err as Error).message });
      res.status(500).json({ error: 'Failed to dismiss recovery alert' });
    }
  });

  // POST /api/recovery/recover — mint a new position from stranded funds
  // Scans all chains for recovery state; uses the correct chain's contracts
  router.post('/recover', async (_req: Request, res: Response) => {
    try {
      // Find stranded funds across all chains
      const chainIds = multiChain ? multiChain.getChainIds() : [config.chain.chainId];
      let report: Awaited<ReturnType<typeof detectStrandedFunds>> = null;
      let recoverChain = chain;
      let recoverContracts = contracts;

      for (const cid of chainIds) {
        const cc = multiChain ? multiChain.getChainById(cid) : chain;
        const cContracts = multiChain ? multiChain.registries.get(cid)!.getForDex() : contracts;
        const r = await detectStrandedFunds(cContracts, cc, cid);
        if (r) {
          report = r;
          recoverChain = cc;
          // Resolve correct DEX contracts from position config or recovery state (e.g. aerodrome-cl)
          const posConfig = config.positions.find(p => p.token_id === r.recoveryState.oldTokenId);
          const effectiveDex = posConfig?.dex ?? r.recoveryState.dex;
          recoverContracts = multiChain
            ? multiChain.registries.get(cid)!.getForDex(effectiveDex)
            : cContracts;
          break;
        }
      }
      // Also check legacy recovery state
      if (!report) {
        report = await detectStrandedFunds(contracts, chain);
      }

      if (!report) {
        res.status(404).json({ error: 'No stranded funds detected' });
        return;
      }

      if (config.dry_run) {
        res.status(403).json({ error: 'Cannot recover in dry run mode' });
        return;
      }

      const result = await recoverStrandedFunds(report, config, recoverContracts, recoverChain);

      res.json(JSON.parse(JSON.stringify({
        success: true,
        newTokenId: result.newTokenId,
        liquidity: result.liquidity,
        amount0: result.amount0,
        amount1: result.amount1,
        txHash: result.txHash,
        gasUsed: result.gasUsed,
      }, bigIntReplacer)));
    } catch (err) {
      logger.error('Recovery execution failed', { error: (err as Error).message });
      res.status(500).json({ error: 'Recovery failed' });
    }
  });

  return router;
}

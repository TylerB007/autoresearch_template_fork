/**
 * Config route — returns sanitized config (no secrets)
 */

import { Router, type Request, type Response } from 'express';
import type { AppConfig } from '../../types.js';
import { CHAIN_REGISTRY } from '../../config/chains.js';
import logger from '../../logger.js';

/** Redact RPC URL paths to hide embedded API keys — show only hostname */
function redactRpcUrl(url: string): string {
  try {
    const parsed = new URL(url);
    const hasPath = parsed.pathname.length > 1; // more than just "/"
    return `${parsed.protocol}//${parsed.host}${hasPath ? '/***' : ''}`;
  } catch {
    return '***';
  }
}

export function createConfigRouter(config: AppConfig): Router {
  const router = Router();

  // GET /api/config — return sanitized config
  router.get('/', (_req: Request, res: Response) => {
    try {
      const sanitized = {
        polling_interval_seconds: config.polling_interval_seconds,
        max_gas_price_gwei: config.max_gas_price_gwei,
        dry_run: config.dry_run,
        slippage_tolerance_bps: config.slippage_tolerance_bps,
        rebalance_cooldown_seconds: config.rebalance_cooldown_seconds,
        contracts: config.contracts,
        chain: {
          chainId: config.chain.chainId,
          chainName: config.chain.chainName,
          protocolName: config.chain.protocolName,
          blockExplorerUrl: config.chain.blockExplorerUrl,
          nativeCurrencySymbol: config.chain.nativeCurrencySymbol,
          rpcUrls: config.rpcUrls.map(redactRpcUrl),
        },
        notifications: {
          enabled: config.notifications.enabled,
          // Explicitly omit: telegram_bot_token, telegram_chat_id
          discord_webhook_url: config.notifications.discord_webhook_url ? '***' : undefined,
        },
        analytics: config.analytics,
        positions: config.positions,
      };

      res.json(sanitized);
    } catch (err) {
      logger.error('Config route error', { error: err instanceof Error ? err.message : String(err) });
      res.status(500).json({ error: 'Failed to fetch config' });
    }
  });

  // GET /api/config/chains — return all supported chains (sanitized — no RPC URLs)
  router.get('/chains', (_req: Request, res: Response) => {
    try {
      const chains = Object.values(CHAIN_REGISTRY).map(entry => ({
        chainId: entry.chainId,
        chainName: entry.chainName,
        protocolName: entry.protocolName,
        nativeCurrency: entry.nativeCurrencySymbol,
        blockExplorerUrl: entry.blockExplorerUrl,
        blockTimeSeconds: entry.blockTimeSeconds,
        feeTiers: Object.entries(entry.feeTiers).map(([fee, spacing]) => ({
          fee: parseInt(fee),
          tickSpacing: spacing,
          label: `${parseInt(fee) / 10000}%`,
        })),
        swapRouterType: entry.swapRouterType,
        dexes: entry.dexes ? Object.entries(entry.dexes).map(([key, dex]) => ({
          key,
          protocolName: dex.protocolName,
          swapRouterType: dex.swapRouterType,
        })) : undefined,
        aggregators: {
          piteas: !!entry.aggregators.piteas,
          oneinch: !!entry.aggregators.oneinch,
        },
      }));
      res.json(chains);
    } catch (err) {
      logger.error('Config chains route error', { error: err instanceof Error ? err.message : String(err) });
      res.status(500).json({ error: 'Failed to fetch chain registry' });
    }
  });

  return router;
}

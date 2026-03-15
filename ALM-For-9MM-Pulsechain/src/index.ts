/**
 * Entry point — loads config, sets up chains, starts the monitoring loop
 * Runs as a persistent process with graceful shutdown on SIGINT/SIGTERM
 *
 * Multi-chain: Creates per-chain wallet/provider/nonce contexts and iterates
 * all positions sequentially, resolving the correct chain per position.
 */

import { loadConfig, reloadPositions } from './configLoader.js';
import { setupAllChains } from './chain.js';
import { createAllContractRegistries } from './contracts.js';
import { createMultiChainContext } from './multiChain.js';
import { checkAndRebalance, rebalancingPositions, hydrateRebalanceHistory, outOfRangeSince, posKey, isAutoDisabled, flushGasWarnings } from './rebalancer.js';
import { checkProactiveNotifications, checkDailySummary, checkAllLowGasBalances } from './notifications/proactive.js';
import { loadKillSwitchState } from './killSwitch.js';
import { tickToPrice } from './math.js';
import { getPositionStatus, verifyOwnership } from './position.js';
import { TelegramCommandHandler } from './telegramCommands.js';
import { AnalyticsCollector, buildStrategyRuleSetSnapshot } from './analytics/collector.js';
import { resolveStoragePath } from './analytics/storage.js';
import { getTokenPrices, getPoolContext } from './server/services/priceService.js';
import { buildPriceHistoryRecord } from './analytics/priceHistory.js';
import { CHAIN_REGISTRY } from './config/chains.js';
import { detectStrandedFunds } from './recovery.js';
import { sendNotification } from './notifications.js';
import { startPriceBackfill, stopPriceBackfill } from './pricing/index.js';
import { startRetrospectiveBackfill, stopRetrospectiveBackfill } from './analytics/retrospective.js';
import { sqrtPriceX96ToPrice } from './bigintFloat.js';
import logger from './logger.js';

async function main(): Promise<void> {
  logger.info('===========================================');
  logger.info('  V3 LP Auto-Rebalancer starting...');
  logger.info('===========================================');

  // Load config
  const config = loadConfig();
  logger.info(
    `Config: ${config.positions.length} position(s), dry_run=${config.dry_run}, ` +
      `poll=${config.polling_interval_seconds}s, slippage=${config.slippage_tolerance_bps}bps`,
  );

  // Setup all chain connections (multi-chain: one wallet/provider/nonce per chain)
  const chainContexts = setupAllChains(config);
  const registries = createAllContractRegistries(config, chainContexts);
  const mctx = createMultiChainContext(config, chainContexts, registries);

  // Log per-chain startup info — failures on individual chains are non-fatal
  // so that (e.g.) an Ethereum RPC outage doesn't prevent PulseChain monitoring.
  const degradedChains = new Set<number>();
  for (const [chainId, chainCtx] of chainContexts) {
    const chainConfig = config.chains.get(chainId)!;
    const addr = chainCtx.wallet.address;
    logger.info(`[${chainConfig.chainName}] Connected (chain ID ${chainId}) — ${chainConfig.protocolName}`);
    logger.info(`[${chainConfig.chainName}] Wallet: ${addr.slice(0, 6)}...${addr.slice(-4)}`);

    try {
      const balance = await chainCtx.withRetry(
        (provider) => provider.getBalance(chainCtx.wallet.address),
      );
      const nativeSymbol = chainConfig.nativeCurrencySymbol;
      const nativeBalance = Number(balance) / 1e18;
      logger.info(`[${chainConfig.chainName}] ${nativeSymbol} balance: ${nativeBalance.toFixed(4)} ${nativeSymbol}`);
      if (balance === 0n) {
        logger.error(
          `[${chainConfig.chainName}] Wallet has zero ${nativeSymbol}! Cannot pay for gas. Fund the wallet and restart.`,
        );
        degradedChains.add(chainId);
      }
    } catch (error) {
      logger.error(
        `[${chainConfig.chainName}] Failed to connect at startup (RPC error). ` +
        `Positions on this chain will retry each monitoring cycle. Error: ${error instanceof Error ? error.message : error}`,
      );
      degradedChains.add(chainId);
    }
  }

  logger.info(`Contract instances created for ${chainContexts.size} chain(s)`);

  // Check for stranded funds on ALL chains
  for (const [chainId, chainCtx] of chainContexts) {
    try {
      const contracts = registries.get(chainId)!.default;
      const strandedReport = await detectStrandedFunds(contracts, chainCtx, chainId);
      if (strandedReport) {
        const { recoveryState, balance0, balance1 } = strandedReport;
        const chainName = config.chains.get(chainId)!.chainName;
        const msg =
          `[${chainName}] STRANDED FUNDS DETECTED from failed rebalance of position #${recoveryState.oldTokenId}\n` +
          `${recoveryState.token0Symbol}: ${balance0.toString()}\n` +
          `${recoveryState.token1Symbol}: ${balance1.toString()}\n` +
          `Use /recover in Telegram to view details, then /recover confirm to mint a new position.`;
        await sendNotification(msg, config, 'critical');
      }
    } catch (error) {
      logger.warn(`Stranded funds check failed on chain ${chainId} (non-fatal): ${error}`);
    }
  }

  // Initialize analytics collector (if enabled)
  const analyticsCollector = config.analytics.enabled
    ? new AnalyticsCollector(config)
    : null;
  if (analyticsCollector) {
    logger.info(
      `Analytics enabled: snapshots every ${config.analytics.snapshot_interval_minutes}min, ` +
        `persist=${config.analytics.persist_to_disk}, storage=${config.analytics.storage_path}`,
    );
    // Start background price backfill for records with priceStatus='pending'
    startPriceBackfill();
    // Start retrospective outcome backfill (fees_earned_1d/3d/7d, recovery metrics)
    startRetrospectiveBackfill(config.analytics.storage_path);
  }

  // Hydrate anti-churn rebalance history from analytics storage (per chain)
  if (config.analytics.enabled) {
    for (const chainId of mctx.getChainIds()) {
      const chainPath = resolveStoragePath(config.analytics.storage_path, chainId);
      await hydrateRebalanceHistory(chainPath, chainId);
    }
  }

  // Capture strategy rule set snapshots for all positions at startup
  // Provides a versioned record of strategy params at the time the bot started
  if (analyticsCollector) {
    for (const pos of config.positions) {
      if (pos.token_id === 0) continue;
      try {
        const chainId = mctx.resolveChainId(pos);
        const snapshot = buildStrategyRuleSetSnapshot(pos, chainId, 'Captured at bot startup');
        await analyticsCollector.captureStrategyRuleSet(snapshot, chainId);
      } catch {
        // Non-fatal — never block startup
      }
    }
  }

  // Load kill switch state (per-position automated disable)
  loadKillSwitchState();

  // Initialize Telegram command handler (if enabled)
  let telegramHandler: TelegramCommandHandler | null = null;
  if (config.notifications?.enabled && config.notifications?.telegram_bot_token && config.notifications?.telegram_chat_id) {
    try {
      telegramHandler = new TelegramCommandHandler(
        config.notifications.telegram_bot_token,
        config.notifications.telegram_chat_id,
        {
          chain: mctx.getChainById(mctx.defaultChainId),
          contracts: registries.get(mctx.defaultChainId)!.default,
          contractRegistry: registries.get(mctx.defaultChainId)!,
          config,
          multiChain: mctx,
        },
      );
      logger.info('Telegram command handler started - you can now send commands via Telegram!');
    } catch (error) {
      logger.warn('Failed to initialize Telegram command handler', { error: (error as Error).message });
    }
  }

  // Log initial position status
  for (const pos of config.positions) {
    if (pos.token_id === 0) {
      logger.warn(
        `Position with token_id 0 — this is a placeholder. Update config.yaml with your real NFT token ID.`,
      );
      continue;
    }
    try {
      const chainId = mctx.resolveChainId(pos);
      const chainConfig = mctx.getChainConfig(chainId);
      const chainCtx = mctx.getChainById(chainId);
      const posContracts = mctx.getContracts(pos);
      const chainLabel = chainContexts.size > 1 ? `[${chainConfig.chainName}] ` : '';

      // Startup ownership check — catch wrong token IDs before the monitoring loop begins.
      // Does NOT enter safe mode; the bot self-heals when config.yaml is corrected.
      try {
        const isOwner = await verifyOwnership(
          pos.token_id,
          chainCtx.wallet.address,
          posContracts,
          chainCtx,
          pos.gauge_address,
        );
        if (!isOwner) {
          logger.warn(
            `${chainLabel}STARTUP WARNING: Wallet does not own position #${pos.token_id}. ` +
            `This is likely a wrong token_id in config.yaml. ` +
            `Bot will skip this position each cycle until ownership is verified.`,
          );
          continue; // Skip getPositionStatus — avoids misleading logs for unowned positions
        }
      } catch (ownerErr) {
        logger.warn(
          `${chainLabel}Could not verify ownership of position #${pos.token_id} at startup ` +
          `(RPC error: ${ownerErr instanceof Error ? ownerErr.message : ownerErr}). ` +
          `Will retry during monitoring loop.`,
        );
        // RPC error at startup — don't skip status fetch, don't enter safe mode
      }

      const status = await getPositionStatus(pos.token_id, posContracts, chainCtx);
      const price = tickToPrice(
        status.pool.currentTick,
        status.token0Info.decimals,
        status.token1Info.decimals,
      );
      const dexLabel = pos.dex ? ` | dex: ${pos.dex}` : '';
      logger.info(
        `${chainLabel}Position #${pos.token_id}: ${status.token0Info.symbol}/${status.token1Info.symbol} ` +
          `| ${status.isInRange ? 'IN RANGE' : 'OUT OF RANGE'} ` +
          `| tick ${status.pool.currentTick} [${status.position.tickLower}, ${status.position.tickUpper}] ` +
          `| price ~${price.toFixed(6)} ` +
          `| strategy: ${pos.strategy}${dexLabel}`,
      );
    } catch (error) {
      logger.error(`Failed to fetch status for position ${pos.token_id}: ${error}`);
    }
  }


  // Register graceful shutdown — waits for active rebalance before exiting
  let running = true;
  let activeRebalance: Promise<unknown> | null = null;
  const shutdown = async (signal: string) => {
    logger.info(`Received ${signal}. Shutting down gracefully...`);
    running = false;
    if (activeRebalance) {
      logger.info('Waiting for active rebalance to complete before exit...');
      try {
        await activeRebalance;
      } catch {
        // Rebalance error is already handled in the main loop
      }
      logger.info('Active rebalance finished — proceeding with shutdown.');
    }
    stopPriceBackfill();
    stopRetrospectiveBackfill();
    if (telegramHandler) {
      telegramHandler.stop();
    }
  };
  process.on('SIGINT', () => { shutdown('SIGINT'); });
  process.on('SIGTERM', () => { shutdown('SIGTERM'); });

  // Main monitoring loop
  logger.info(
    `Starting monitoring loop (interval: ${config.polling_interval_seconds}s)`,
  );
  logger.info('-------------------------------------------');

  while (running) {
    const cycleStart = Date.now();

    // Re-read positions from config.yaml so dashboard-added positions are picked up
    reloadPositions(config);

    for (const posConfig of config.positions) {
      if (!running) break;
      if (posConfig.token_id === 0) continue;

      try {
        // Resolve per-position chain context and contracts
        const chainId = mctx.resolveChainId(posConfig);
        const chain = mctx.getChainById(chainId);
        const posContracts = mctx.getContracts(posConfig);

        // Capture analytics snapshot (skip if position is mid-rebalance or auto-disabled to avoid querying burned NFTs)
        const pk = posKey(chainId, posConfig.token_id);
        if (analyticsCollector && !rebalancingPositions.has(pk) && !isAutoDisabled(pk)) {
          try {
            const status = await getPositionStatus(posConfig.token_id, posContracts, chain);

            const chainEntry = CHAIN_REGISTRY[chainId];
            const dexSlug = chainEntry?.dexScreenerSlug ?? config.chain.dexScreenerSlug;
            const nativeAddr = chainEntry?.wrappedNativeAddress;

            // Fetch USD prices for this snapshot — anchors historical value to real prices.
            // Failures are non-fatal: snapshot is still written with priceUsd* = 0.
            let snapshotPrices: { priceUsd0: number; priceUsd1: number; nativePriceUsd: number; source?: string } | undefined;
            try {
              const addrs = [
                status.token0Info.address,
                status.token1Info.address,
                ...(nativeAddr ? [nativeAddr] : []),
              ];
              const prices = await getTokenPrices(addrs, dexSlug);
              snapshotPrices = {
                priceUsd0: prices.get(status.token0Info.address.toLowerCase()) ?? 0,
                priceUsd1: prices.get(status.token1Info.address.toLowerCase()) ?? 0,
                nativePriceUsd: nativeAddr ? (prices.get(nativeAddr.toLowerCase()) ?? 0) : 0,
                source: 'dexscreener',
              };
            } catch {
              // Price fetch failed — snapshot proceeds with zero USD fields
            }

            // Fetch pool context (TVL, volume) — non-fatal if unavailable
            let poolContext: import('./server/services/priceService.js').PoolContext | undefined;
            try {
              if (status.pool.address) {
                const feeDecimal = status.pool.fee / 1_000_000;
                poolContext = await getPoolContext(status.pool.address, dexSlug, feeDecimal);
              }
            } catch {
              // Pool context unavailable — snapshot proceeds without it
            }

            // Compute sigma from stored price history (non-fatal)
            let sigmaFields: {
              sigma7d?: number; sigma30d?: number;
              volatilityRatio?: number; sigmaConfidence?: 'high' | 'medium' | 'low';
            } = {};
            try {
              if (status.pool.address) {
                sigmaFields = await analyticsCollector.getSigma(status.pool.address, chainId);
              }
            } catch {
              // Sigma unavailable
            }

            // Append price history observation for future sigma computation
            if (snapshotPrices && status.pool.address && snapshotPrices.priceUsd0 > 0 && snapshotPrices.priceUsd1 > 0) {
              const rawRatio = sqrtPriceX96ToPrice(status.pool.sqrtPriceX96);
              const decimalAdjust = 10 ** (status.token0Info.decimals - status.token1Info.decimals);
              const priceRatio = rawRatio > 0 ? rawRatio * decimalAdjust : snapshotPrices.priceUsd0 / snapshotPrices.priceUsd1;
              const phRecord = buildPriceHistoryRecord(
                status.pool.address,
                chainId,
                Date.now(),
                priceRatio,
                snapshotPrices.priceUsd0,
                snapshotPrices.priceUsd1,
                'dexscreener',
              );
              analyticsCollector.appendPriceObservation(phRecord, chainId).catch(() => {});
            }

            const snapshot = analyticsCollector.createSnapshot(status, snapshotPrices, {
              chainId,
              dex: posConfig.dex,
              poolContext,
              ...sigmaFields,
              snapshotTrigger: 'scheduled',
            });
            await analyticsCollector.processSnapshot(snapshot, chainId);

            // Proactive notifications (non-blocking)
            checkProactiveNotifications(posConfig, status, config, outOfRangeSince).catch(() => {});
          } catch (snapError) {
            logger.debug(`Analytics snapshot failed for ${posConfig.token_id}: ${snapError}`);
          }
        }

        // Check if rebalancing is disabled via Telegram command
        if (telegramHandler && !telegramHandler.isRebalancingEnabled()) {
          logger.info(`Rebalancing disabled via Telegram - skipping position ${posConfig.token_id}`);
          continue;
        }

        const rebalancePromise = checkAndRebalance(posConfig, config, posContracts, chain, analyticsCollector);
        activeRebalance = rebalancePromise;
        const result = await rebalancePromise;
        activeRebalance = null;
        if (result && result.success && result.newTokenId) {
          logger.info(
            `Rebalance complete: #${result.oldTokenId} -> #${result.newTokenId}`,
          );
        }
      } catch (error) {
        activeRebalance = null;
        logger.error(
          `Error checking position ${posConfig.token_id}: ${error instanceof Error ? error.message : error}`,
        );
      }
    }

    // Flush grouped gas-insufficiency warnings — at most 1 notification per chain per 24h
    await flushGasWarnings(config).catch(() => {});

    // Daily summary check (non-blocking)
    checkDailySummary(config).catch(() => {});

    // Low gas balance check — once per 24h across all chains, combined silent alert (non-blocking)
    checkAllLowGasBalances(chainContexts, config).catch(() => {});

    // Sleep for remainder of polling interval (interruptible)
    if (running) {
      const elapsed = Date.now() - cycleStart;
      const waitMs = Math.max(0, config.polling_interval_seconds * 1000 - elapsed);
      if (waitMs > 0) {
        await interruptibleSleep(waitMs, () => !running);
      }
    }
  }

  logger.info('Rebalancer shut down cleanly.');
}

/**
 * Sleep that can be interrupted by a condition function
 */
async function interruptibleSleep(
  ms: number,
  shouldWake: () => boolean,
): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    const check = setInterval(() => {
      if (shouldWake()) {
        clearTimeout(timer);
        clearInterval(check);
        resolve();
      }
    }, 500);

    // Clear interval when timer fires naturally
    setTimeout(() => clearInterval(check), ms + 100);
  });
}

main().catch((error) => {
  logger.error(`Fatal error: ${error}`);
  process.exit(1);
});

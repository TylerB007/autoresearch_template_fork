/**
 * Proactive notifications — forward-looking alerts before events happen,
 * plus a daily summary digest.
 *
 * Alert types:
 * A. Position approaching trigger — within 50% of trigger distance from edge
 * B. Confirmation timer updates — periodic updates during confirm_minutes countdown
 * C. Daily summary digest — configurable hour (default 23:00 UTC)
 */

import { ethers } from 'ethers';
import type { AppConfig, PositionConfig, PositionStatus } from '../types.js';
import type { ChainContext } from '../chain.js';
import { sendNotification } from '../notifications.js';
import { queryAllChainRebalances, queryFeeCollections, queryAllChainPositionEntries, queryRebalances, queryAllChainSnapshots } from '../analytics/storage.js';
import { getTokenPrices } from '../server/services/priceService.js';
import { getChainConfig } from '../config/chains.js';
import { TOKENS } from '../config/contracts.js';
import { bigintToFloat } from '../bigintFloat.js';
import logger from '../logger.js';

/** Build a human-readable position label for notifications. */
function posLabel(tokenId: number, status: PositionStatus, chainName: string): string {
  return `#${tokenId} (${status.token0Info.symbol}/${status.token1Info.symbol} on ${chainName})`;
}

// ============================================================
// RATE LIMITING STATE
// ============================================================

/** Last alert timestamp per position per alert type */
const lastAlertTime = new Map<string, number>();

function alertKey(tokenId: number, alertType: string): string {
  return `${tokenId}:${alertType}`;
}

function isRateLimited(tokenId: number, alertType: string, cooldownMs: number): boolean {
  const key = alertKey(tokenId, alertType);
  const last = lastAlertTime.get(key) ?? 0;
  return Date.now() - last < cooldownMs;
}

function recordAlert(tokenId: number, alertType: string): void {
  lastAlertTime.set(alertKey(tokenId, alertType), Date.now());
}

/** Last daily summary timestamp */
let lastDailySummaryTime = 0;

// ============================================================
// APPROACHING TRIGGER ALERT
// ============================================================

/**
 * Check if position is approaching its trigger distance.
 * Alerts when within 50% of trigger distance from range edge.
 * Rate-limited to once per 30 minutes per position.
 */
async function checkApproachingTrigger(
  posConfig: PositionConfig,
  status: PositionStatus,
  config: AppConfig,
): Promise<void> {
  if (!status.isInRange) return; // Only relevant for in-range positions

  const triggerTicks = posConfig.params.trigger_distance_ticks;
  const { currentTick } = status.pool;
  const { tickLower, tickUpper } = status.position;

  // Distance to nearest edge
  const distToLower = currentTick - tickLower;
  const distToUpper = tickUpper - currentTick;
  const minDist = Math.min(distToLower, distToUpper);

  // Alert threshold: 50% of trigger distance
  const threshold = triggerTicks * 0.5;
  if (minDist > threshold) return;

  // Rate limit: 30 minutes
  if (isRateLimited(posConfig.token_id, 'approaching', 30 * 60 * 1000)) return;

  const edge = distToLower < distToUpper ? 'lower' : 'upper';
  const pctOfTrigger = ((triggerTicks - minDist) / triggerTicks * 100).toFixed(0);
  const chainName = getChainConfig(posConfig.chain_id ?? config.chain.chainId).chainName;

  const gaugeNote = posConfig.gauge_address
    ? '\nGauge unstake will occur automatically before rebalance.'
    : '';

  await sendNotification(
    `Position ${posLabel(posConfig.token_id, status, chainName)} approaching ${edge} edge\n` +
    `${minDist} ticks from edge (trigger at +${triggerTicks} beyond edge)\n` +
    `${pctOfTrigger}% of the way to trigger${gaugeNote}`,
    config,
    'info',
    'approaching_range',
  );
  recordAlert(posConfig.token_id, 'approaching');
}

// ============================================================
// CONFIRMATION TIMER UPDATE
// ============================================================

/**
 * During confirm_minutes countdown, send periodic updates.
 * Rate-limited to once per 15 minutes.
 */
async function checkConfirmationTimer(
  posConfig: PositionConfig,
  status: PositionStatus,
  config: AppConfig,
  outOfRangeSince: Map<string, number>,
): Promise<void> {
  if (status.isInRange) return;

  const confirmMinutes = posConfig.params.confirm_minutes ?? 0;
  if (confirmMinutes === 0) return;

  const key = `${posConfig.chain_id ?? config.chain.chainId}-${posConfig.token_id}`;
  const firstSeen = outOfRangeSince.get(key);
  if (!firstSeen) return;

  const elapsedMinutes = (Date.now() - firstSeen) / 60_000;
  if (elapsedMinutes >= confirmMinutes) return; // Already past confirmation

  // Rate limit: 15 minutes
  if (isRateLimited(posConfig.token_id, 'confirm_timer', 15 * 60 * 1000)) return;

  const remaining = confirmMinutes - elapsedMinutes;
  const chainName = getChainConfig(posConfig.chain_id ?? config.chain.chainId).chainName;
  await sendNotification(
    `Position ${posLabel(posConfig.token_id, status, chainName)} out of range: ${elapsedMinutes.toFixed(0)}/${confirmMinutes} minutes\n` +
    `Rebalance in ~${remaining.toFixed(0)} minutes if price stays out of range`,
    config,
    'info',
    'confirm_timer',
  );
  recordAlert(posConfig.token_id, 'confirm_timer');
}

// ============================================================
// DAILY SUMMARY DIGEST
// ============================================================

/**
 * Send daily summary at configured hour (default 23:00 UTC).
 * Rate-limited to once per 20 hours.
 * Includes per-position breakdown with fees, gas, and net PnL.
 */
export async function checkDailySummary(config: AppConfig): Promise<void> {
  const summaryHour = 23; // UTC
  const now = new Date();
  const currentHour = now.getUTCHours();

  // Only trigger at the configured hour
  if (currentHour !== summaryHour) return;

  // Rate limit: 20 hours (ensures once per day)
  if (Date.now() - lastDailySummaryTime < 20 * 3600 * 1000) return;

  try {
    const storagePath = config.analytics?.storage_path ?? './analytics';
    const dayStart = Date.now() - 24 * 3600 * 1000;

    const [rebalances, feeCollections] = await Promise.all([
      queryAllChainRebalances(storagePath, dayStart),
      queryFeeCollections(storagePath),
    ]);

    // Filter to today's fee collections
    const todayCollections = feeCollections.filter((fc) => fc.timestamp >= dayStart);

    // Get native currency prices for gas conversion
    let plsPriceUsd = 0;
    try {
      const prices = await getTokenPrices([TOKENS.WPLS]);
      plsPriceUsd = prices.get(TOKENS.WPLS.toLowerCase()) ?? 0;
    } catch { /* non-fatal */ }

    // Portfolio totals
    const totalGasNative = rebalances.reduce((s, r) => s + r.totalGasCostPLS, 0);
    const totalGasUsd = totalGasNative * plsPriceUsd;
    const collectionsFeesUsd = todayCollections.reduce((s, fc) => s + fc.totalValueUsd, 0);

    // Build latest-snapshot map for pair names and range status
    const allSnapshots = await queryAllChainSnapshots(storagePath);
    const latestSnapshot = new Map<number, typeof allSnapshots[0]>();
    for (const snap of allSnapshots) {
      const existing = latestSnapshot.get(snap.tokenId);
      if (!existing || snap.timestamp > existing.timestamp) {
        latestSnapshot.set(snap.tokenId, snap);
      }
    }

    // Per-position breakdown
    const activeLines: string[] = [];
    const inactiveEntries: Array<{ label: string }> = [];

    for (const pos of config.positions) {
      const chainName = getChainConfig(pos.chain_id ?? config.chain.chainId).chainName;
      const nativeSymbol = getChainConfig(pos.chain_id ?? config.chain.chainId).nativeCurrencySymbol;

      // Find rebalances for this position (match by oldTokenId or newTokenId)
      const posRebalances = rebalances.filter(
        (r) => r.oldTokenId === pos.token_id || r.newTokenId === pos.token_id,
      );
      const posCollections = todayCollections.filter((fc) => fc.tokenId === pos.token_id);

      let posGasNative = 0;
      let posCollectionFeesUsd = 0;
      let avgNetRoi = 0;

      for (const rb of posRebalances) {
        posGasNative += rb.totalGasCostPLS;
        avgNetRoi += rb.metrics.netROIPercent;
      }
      if (posRebalances.length > 0) {
        avgNetRoi /= posRebalances.length;
      }

      for (const fc of posCollections) {
        posCollectionFeesUsd += fc.totalValueUsd;
        posGasNative += fc.gasCostPLS;
      }

      // Build pair name: prefer rebalance snapshot, fall back to position snapshot, then token ID
      const snap = latestSnapshot.get(pos.token_id);
      const pairName = posRebalances.length > 0
        ? `${posRebalances[0].preSnapshot.token0Symbol}/${posRebalances[0].preSnapshot.token1Symbol}`
        : snap
          ? `${snap.token0Symbol}/${snap.token1Symbol}`
          : `#${pos.token_id}`;

      // Range status tag from latest snapshot
      let rangeTag = '';
      if (snap) {
        if (snap.isInRange) {
          rangeTag = ' ✅';
        } else {
          const tickDist = snap.currentTick < snap.tickLower
            ? snap.tickLower - snap.currentTick
            : snap.currentTick - snap.tickUpper + 1;
          rangeTag = ` ⚠️ OOR +${tickDist}t`;
        }
      }

      const gaugeTag = pos.gauge_address ? ' 📌' : '';

      if (posRebalances.length === 0 && posCollections.length === 0) {
        inactiveEntries.push({ label: `${pairName}${rangeTag}${gaugeTag}` });
      } else {
        const parts = [`${pairName} (#${pos.token_id}, ${chainName})${rangeTag}${gaugeTag}:`];
        if (posRebalances.length > 0) {
          parts.push(`${posRebalances.length} rebal`);
          parts.push(`Avg ROI: ${avgNetRoi.toFixed(2)}%`);
        }
        if (posCollectionFeesUsd > 0) {
          parts.push(`Collected: $${posCollectionFeesUsd.toFixed(4)}`);
        }
        parts.push(`Gas: ${posGasNative.toFixed(4)} ${nativeSymbol}`);
        activeLines.push(parts.join(' | '));
      }
    }

    // Collapse inactive positions into one line to reduce noise
    const positionLines = [...activeLines];
    if (inactiveEntries.length === 1) {
      positionLines.push(`${inactiveEntries[0].label}: No activity today`);
    } else if (inactiveEntries.length > 1) {
      positionLines.push(`No activity (${inactiveEntries.length}): ${inactiveEntries.map(e => e.label).join(', ')}`);
    }

    const totalFeesUsd = collectionsFeesUsd;

    // Lifetime P&L summary (uses entry records when available)
    let pnlLine = '';
    try {
      const allRebalances = await queryRebalances(storagePath);
      const allEntries = await queryAllChainPositionEntries(storagePath);

      let totalFeesLifetime = 0;
      let totalGasCostLifetime = 0;
      let totalSwapFriction = 0;

      for (const rb of allRebalances) {
        const rbPrice0 = rb.priceUsd0 ?? 0;
        const rbPrice1 = rb.priceUsd1 ?? 0;
        totalFeesLifetime +=
          bigintToFloat(rb.feesCollected0, rb.preSnapshot.token0Decimals) * rbPrice0 +
          bigintToFloat(rb.feesCollected1, rb.preSnapshot.token1Decimals) * rbPrice1;
        totalGasCostLifetime += rb.totalGasCostPLS * (rb.nativeTokenPriceUsd ?? plsPriceUsd);
        totalSwapFriction += rb.swapFrictionUsd ?? 0;
      }

      if (allEntries.length > 0) {
        // Sum entry costs for all current positions
        let totalEntryCost = 0;
        for (const pos of config.positions) {
          const posEntries = allEntries.filter((e) => e.tokenId === pos.token_id);
          if (posEntries.length > 0) {
            totalEntryCost += posEntries[posEntries.length - 1].entryCostUsd;
          }
        }
        if (totalEntryCost > 0) {
          const netPnl = totalFeesLifetime - totalGasCostLifetime - totalSwapFriction;
          const pnlPct = (netPnl / totalEntryCost) * 100;
          pnlLine = `Lifetime P&L: $${netPnl.toFixed(4)} (${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(2)}%) | Fees: $${totalFeesLifetime.toFixed(4)} | Gas: -$${totalGasCostLifetime.toFixed(4)}`;
        }
      }
    } catch {
      // Non-fatal
    }

    const lines = [
      `Daily Summary (${now.toISOString().split('T')[0]})`,
      ``,
      `Portfolio: ${config.positions.length} positions | ${rebalances.length} rebalances | $${totalFeesUsd.toFixed(4)} fees | $${totalGasUsd.toFixed(4)} gas`,
      ...(pnlLine ? [``, pnlLine] : []),
      ``,
      ...positionLines,
    ];

    await sendNotification(lines.join('\n'), config, 'info', 'daily_summary');
    lastDailySummaryTime = Date.now();
    logger.info('Daily summary notification sent');
  } catch (err) {
    logger.debug(`Daily summary failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// ============================================================
// MAIN CHECK (called from monitoring loop)
// ============================================================

/**
 * Run all proactive notification checks for a single position.
 * Non-blocking — errors are caught and logged.
 */
export async function checkProactiveNotifications(
  posConfig: PositionConfig,
  status: PositionStatus,
  config: AppConfig,
  outOfRangeSince: Map<string, number>,
): Promise<void> {
  try {
    await Promise.all([
      checkApproachingTrigger(posConfig, status, config),
      checkConfirmationTimer(posConfig, status, config, outOfRangeSince),
    ]);
  } catch (err) {
    logger.debug(`Proactive notification check failed for ${posConfig.token_id}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// ============================================================
// LOW GAS BALANCE ALERT (called from monitoring loop per chain)
// ============================================================

/**
 * Minimum native token balances below which a low-gas alert is sent.
 * These are conservative thresholds that cover several rebalance cycles.
 */
const LOW_GAS_THRESHOLDS: Record<number, bigint> = {
  369: ethers.parseEther('500000'),    // PulseChain: 500k PLS (~$5)
  1: ethers.parseEther('0.008'),       // Ethereum: 0.008 ETH (~$20)
  8453: ethers.parseEther('0.002'),    // Base: 0.002 ETH (~$4)
  42161: ethers.parseEther('0.002'),   // Arbitrum One: 0.002 ETH (~$4)
  146: ethers.parseEther('10'),        // Sonic: 10 S (~$2-3)
};

/** Default threshold for chains not listed above */
const DEFAULT_LOW_GAS_THRESHOLD = ethers.parseEther('0.01');

/**
 * Check all active chains for low native gas balances and send a single combined
 * silent Telegram alert (max once per 24 hours across all chains combined).
 * Should be called once per monitoring cycle with the full chainContexts Map.
 */
export async function checkAllLowGasBalances(
  chainContexts: Map<number, ChainContext>,
  config: AppConfig,
): Promise<void> {
  // Global rate-limit: only one combined alert per 24 hours
  if (isRateLimited(0, 'low_gas_combined', 24 * 3600 * 1000)) return;

  interface LowChain {
    chainName: string;
    nativeSymbol: string;
    balFmt: string;
    threshFmt: string;
  }

  const lowChains: LowChain[] = [];

  await Promise.all(
    Array.from(chainContexts.entries()).map(async ([chainId, chainCtx]) => {
      const chainCfg = config.chains.get(chainId);
      if (!chainCfg) return;
      try {
        const threshold = LOW_GAS_THRESHOLDS[chainId] ?? DEFAULT_LOW_GAS_THRESHOLD;
        const balance = await chainCtx.provider.getBalance(chainCtx.wallet.address);
        if (balance >= threshold) return;

        const balFmt = parseFloat(ethers.formatEther(balance)).toFixed(4);
        const threshFmt = parseFloat(ethers.formatEther(threshold)).toFixed(4);
        logger.warn(
          `Low gas balance on ${chainCfg.chainName}: ${balFmt} ${chainCfg.nativeCurrencySymbol} (threshold: ${threshFmt})`,
        );
        lowChains.push({
          chainName: chainCfg.chainName,
          nativeSymbol: chainCfg.nativeCurrencySymbol,
          balFmt,
          threshFmt,
        });
      } catch (err) {
        logger.debug(
          `Low gas balance check failed for chain ${chainId}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }),
  );

  if (lowChains.length === 0) return;

  recordAlert(0, 'low_gas_combined');

  const lines = lowChains
    .map((c) => `• ${c.chainName}: ${c.balFmt} ${c.nativeSymbol} (min ${c.threshFmt} ${c.nativeSymbol})`)
    .join('\n');

  await sendNotification(
    `⚠️ Low Gas Alert\n\nThe following chains need gas top-up:\n\n${lines}\n\nPlease top up wallet to avoid rebalance failures.`,
    config,
    'critical',
    undefined,
    true, // silent — no ping/vibration
  );
}

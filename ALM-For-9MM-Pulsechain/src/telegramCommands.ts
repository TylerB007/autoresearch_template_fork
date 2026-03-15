import TelegramBot from 'node-telegram-bot-api';
import { ethers } from 'ethers';
import { existsSync, readFileSync, writeFileSync, renameSync, unlinkSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import type { ContractInstances, ContractRegistry } from './contracts.js';
import type { ChainContext } from './chain.js';
import type { AppConfig, StrategyType, StrandedFundsReport, PositionStatus, NotificationCategory } from './types.js';
import { getPositionStatus } from './position.js';
import { getPoolState } from './pool.js';
import { tickToPrice, tickToSqrtPriceX96, getAmountsForLiquidity, nearestUsableTick, ticksToPercentage, percentageToTicks, calculateSwapAmount, getLiquidityForAmounts } from './math.js';
import { getTickSpacing } from './config/fees.js';
import { getTokenPrices } from './server/services/priceService.js';
import { detectStrandedFunds, recoverStrandedFunds } from './recovery.js';
import { reloadPositions } from './configLoader.js';
import { collectFees, removeLiquidity, checkAndRebalance, outOfRangeSince, clearSafeMode, isSafeMode, getSafeModePositions, posKey, recoveryStatePath, RECOVERY_STATE_PATH, clearAutoDisabled, isAutoDisabled, increaseLiquidity, decreasePositionLiquidity } from './rebalancer.js';
import { executeSwap } from './swap.js';
import { isKillSwitchTriggered, getKillSwitchStatus } from './killSwitch.js';
import { evaluateStrategy, PRESET_WIDTH_REGEX } from './strategy.js';
import { sendNotification } from './notifications.js';
import { calculateTickVolatility } from './analytics/volatility.js';
import { calculateHealthScore } from './analytics/healthScore.js';
import { buildPositionChain } from './analytics/chain.js';
import { buildLineageAnalyticsSummary } from './analytics/lineageSummary.js';
import { querySnapshots, queryRebalances, queryAllChainFeeCollections, queryAllChainManualLinks, queryAllChainPositionEntries, queryAllChainRebalances, queryAllChainSnapshots, writeManualLink, readManualLinks, resolveStoragePath } from './analytics/storage.js';
import { bigintToFloat } from './bigintFloat.js';
import { TOKENS } from './config/contracts.js';
import { CHAIN_REGISTRY, getSupportedDexes, getDexConfig } from './config/chains.js';
import { discoverWalletPositions, type DiscoveredPosition, type DiscoverResult } from './positionDiscovery.js';
import logger from './logger.js';

/** Ordered strategy menu for interactive /new flow */
const STRATEGY_MENU: { strategy: StrategyType; label: string }[] = [
  { strategy: 'center_3pct',  label: 'center_3pct — Centered ±1.5%' },
  { strategy: 'center_6pct',  label: 'center_6pct — Centered ±3%' },
  { strategy: 'bullish_3pct', label: 'bullish_3pct — Bullish (30/70 split) ~3%' },
  { strategy: 'bullish_6pct', label: 'bullish_6pct — Bullish (30/70 split) ~6%' },
  { strategy: 'bearish_3pct', label: 'bearish_3pct — Bearish (70/30 split) ~3%' },
  { strategy: 'bearish_6pct', label: 'bearish_6pct — Bearish (70/30 split) ~6%' },
  { strategy: 'center',       label: 'center — Centered, custom width' },
  { strategy: 'bullish',      label: 'bullish — Bullish, custom width' },
  { strategy: 'bearish',      label: 'bearish — Bearish, custom width' },
  { strategy: 'lazy_up',      label: 'lazy_up — Only rebalance on pump' },
  { strategy: 'lazy_down',    label: 'lazy_down — Only rebalance on dump' },
  { strategy: 'static',       label: 'static — Monitor only, no rebalance' },
  { strategy: 'custom' as StrategyType, label: 'custom — Full wizard (style + width + trigger + advanced)' },
];

// ============================================================
// Generalized flow state machine
// ============================================================

type FlowType = 'new' | 'collect' | 'remove' | 'rebalance' | 'config' | 'scan' | 'increase' | 'decrease';

interface ActiveFlow {
  type: FlowType;
  step: string;
  data: Record<string, unknown>;
  startedAt: number;
}

const FLOW_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

/** Persistent disable flag file — survives PM2 restarts */
const DISABLE_FLAG_PATH = resolve(process.cwd(), '.rebalancing-disabled');

interface CommandContext {
  chain: ChainContext;
  contracts: ContractInstances;
  contractRegistry?: ContractRegistry;
  config: AppConfig;
  multiChain?: import('./multiChain.js').MultiChainContext;
}

/** Cached position info for the picker */
interface PositionPickerEntry {
  tokenId: number;
  posIndex: number;
  pair: string;
  strategy: string;
  isInRange: boolean;
  totalValueUsd: number;
  fee0: number;
  fee1: number;
  fee0Usd: number;
  fee1Usd: number;
  token0Symbol: string;
  token1Symbol: string;
  status: PositionStatus;
}

export class TelegramCommandHandler {
  private bot: TelegramBot;
  private context: CommandContext;
  private chatId: string;
  private rebalancingEnabled: boolean = true;
  private commandTimestamps: number[] = [];
  private pendingRecovery: StrandedFundsReport | null = null;
  private pendingRecoveryContracts: import('./contracts.js').ContractInstances | undefined;
  private pendingRecoveryChain: import('./chain.js').ChainContext | undefined;
  private activeFlow: ActiveFlow | null = null;
  private static readonly RATE_LIMIT_WINDOW_MS = 60_000;
  private static readonly RATE_LIMIT_MAX = 10;

  /** Resolve contracts for a specific position (uses multiChain or per-DEX registry) */
  private getContractsForPosition(tokenId: number): ContractInstances {
    const pos = this.context.config.positions.find(p => p.token_id === tokenId);
    if (pos && this.context.multiChain) return this.context.multiChain.getContracts(pos);
    if (!this.context.contractRegistry) return this.context.contracts;
    return this.context.contractRegistry.getForDex(pos?.dex);
  }

  /** Resolve chain context for a specific position (uses multiChain if available) */
  private getChainForPosition(tokenId: number): ChainContext {
    const pos = this.context.config.positions.find(p => p.token_id === tokenId);
    if (pos && this.context.multiChain) {
      return this.context.multiChain.getChainById(this.context.multiChain.resolveChainId(pos));
    }
    return this.context.chain;
  }

  constructor(botToken: string, chatId: string, context: CommandContext) {
    this.bot = new TelegramBot(botToken, { polling: { interval: 3000, autoStart: true } });
    this.chatId = chatId;
    this.context = context;

    // Restore persisted disable state from previous run
    if (existsSync(DISABLE_FLAG_PATH)) {
      this.rebalancingEnabled = false;
      logger.warn('Rebalancing is DISABLED (persisted from previous session). Send /enable to re-enable.');
    }

    this.setupCommands();
    logger.info('Telegram command handler initialized');
  }

  private setupCommands(): void {
    this.bot.onText(/\/status/, async (msg) => {
      if (!this.isAuthorized(msg)) return;
      await this.handleStatus(msg);
    });

    this.bot.onText(/\/balance/, async (msg) => {
      if (!this.isAuthorized(msg)) return;
      await this.handleBalance(msg);
    });

    this.bot.onText(/\/enable/, async (msg) => {
      if (!this.isAuthorized(msg)) return;
      await this.handleEnable(msg);
    });

    this.bot.onText(/\/disable/, async (msg) => {
      if (!this.isAuthorized(msg)) return;
      await this.handleDisable(msg);
    });

    this.bot.onText(/\/recover(?:\s+(confirm))?/, async (msg, match) => {
      if (!this.isAuthorized(msg)) return;
      const confirm = match?.[1] === 'confirm';
      await this.handleRecover(msg, confirm);
    });

    this.bot.onText(/\/new/, async (msg) => {
      if (!this.isAuthorized(msg)) return;
      await this.startFlow(msg, 'new', 'token_id');
    });

    this.bot.onText(/\/config/, async (msg) => {
      if (!this.isAuthorized(msg)) return;
      await this.startPositionFlow(msg, 'config');
    });

    this.bot.onText(/\/collect/, async (msg) => {
      if (!this.isAuthorized(msg)) return;
      await this.startPositionFlow(msg, 'collect');
    });

    this.bot.onText(/\/remove/, async (msg) => {
      if (!this.isAuthorized(msg)) return;
      await this.startPositionFlow(msg, 'remove');
    });

    this.bot.onText(/\/rebalance/, async (msg) => {
      if (!this.isAuthorized(msg)) return;
      await this.startPositionFlow(msg, 'rebalance');
    });

    this.bot.onText(/\/increase/, async (msg) => {
      if (!this.isAuthorized(msg)) return;
      await this.startPositionFlow(msg, 'increase');
    });

    this.bot.onText(/\/decrease/, async (msg) => {
      if (!this.isAuthorized(msg)) return;
      await this.startPositionFlow(msg, 'decrease');
    });

    this.bot.onText(/\/chain/, async (msg) => {
      if (!this.isAuthorized(msg)) return;
      await this.handleChain(msg);
    });

    this.bot.onText(/\/link (.+)/, async (msg, match) => {
      if (!this.isAuthorized(msg)) return;
      await this.handleLink(msg, match?.[1] ?? '');
    });

    this.bot.onText(/\/scan/, async (msg) => {
      if (!this.isAuthorized(msg)) return;
      await this.handleScan(msg);
    });

    this.bot.onText(/\/removestale/, async (msg) => {
      if (!this.isAuthorized(msg)) return;
      await this.handleRemoveStale(msg);
    });


    this.bot.onText(/\/alerts(?:\s+(.+))?/, async (msg, match) => {
      if (!this.isAuthorized(msg)) return;
      await this.handleAlerts(msg, match?.[1]?.trim());
    });

    this.bot.onText(/\/help/, async (msg) => {
      if (!this.isAuthorized(msg)) return;
      await this.handleHelp(msg);
    });

    this.bot.onText(/\/start/, async (msg) => {
      if (!this.isAuthorized(msg)) return;
      await this.handleHelp(msg);
    });

    this.bot.onText(/\/cancel/, async (msg) => {
      if (!this.isAuthorized(msg)) return;
      if (this.activeFlow) {
        this.activeFlow = null;
        await this.bot.sendMessage(msg.chat.id, '❌ Cancelled.');
      } else {
        await this.bot.sendMessage(msg.chat.id, 'Nothing to cancel.');
      }
    });

    // Generic message handler — route plain text to active flow
    this.bot.on('message', async (msg) => {
      if (!this.isAuthorized(msg)) return;
      if (!msg.text) return;
      if (msg.text.startsWith('/')) {
        // Any command other than /cancel while flow is active → cancel flow silently
        if (this.activeFlow && !msg.text.startsWith('/cancel')) {
          this.activeFlow = null;
        }
        return;
      }
      if (this.activeFlow) {
        await this.handleFlowStep(msg);
      }
    });

    // Error handler - stop polling on persistent auth failures
    let authFailCount = 0;
    this.bot.on('polling_error', (error) => {
      if (error.message.includes('401')) {
        authFailCount++;
        if (authFailCount === 1) {
          logger.warn('Telegram bot token rejected (401). Another instance may be polling this bot. Commands disabled.');
        }
        if (authFailCount >= 3) {
          logger.warn('Stopping Telegram polling due to repeated auth failures');
          this.bot.stopPolling();
        }
      } else {
        logger.error('Telegram polling error', { error: error.message });
      }
    });
  }

  private isAuthorized(msg: TelegramBot.Message): boolean {
    const chatId = msg.chat.id.toString();
    if (chatId !== this.chatId) {
      logger.warn('Unauthorized Telegram command attempt', { chatId, expected: this.chatId });
      return false;
    }

    const now = Date.now();
    this.commandTimestamps = this.commandTimestamps.filter(
      (t) => now - t < TelegramCommandHandler.RATE_LIMIT_WINDOW_MS,
    );
    if (this.commandTimestamps.length >= TelegramCommandHandler.RATE_LIMIT_MAX) {
      logger.warn('Telegram command rate limit exceeded');
      this.bot.sendMessage(msg.chat.id, 'Rate limit exceeded. Try again in a minute.');
      return false;
    }
    this.commandTimestamps.push(now);
    return true;
  }

  // ============================================================
  // Position Picker Helper
  // ============================================================

  private async buildPositionPicker(showFees = false): Promise<PositionPickerEntry[]> {
    const positions = this.context.config.positions;
    if (positions.length === 0) return [];

    const withTimeout = <T>(promise: Promise<T>, ms: number): Promise<T> =>
      Promise.race([
        promise,
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('RPC timeout')), ms),
        ),
      ]);

    const statusResults = await Promise.allSettled(
      positions.map((pos) =>
        withTimeout(
          getPositionStatus(pos.token_id, this.getContractsForPosition(pos.token_id), this.getChainForPosition(pos.token_id)),
          30_000,
        ),
      ),
    );

    // Collect token addresses for USD pricing
    const tokenAddresses = new Set<string>();
    for (const result of statusResults) {
      if (result.status === 'fulfilled') {
        tokenAddresses.add(result.value.token0Info.address);
        tokenAddresses.add(result.value.token1Info.address);
      }
    }

    let usdPrices = new Map<string, number>();
    if (tokenAddresses.size > 0) {
      try {
        usdPrices = await getTokenPrices([...tokenAddresses]);
      } catch { /* best effort */ }
    }

    const entries: PositionPickerEntry[] = [];
    for (let i = 0; i < positions.length; i++) {
      const posConfig = positions[i];
      const result = statusResults[i];
      if (result.status === 'rejected') continue;

      const status = result.value;
      const { token0Info, token1Info } = status;
      const d0 = token0Info.decimals;
      const d1 = token1Info.decimals;

      const amt0 = Number(status.amount0) / 10 ** d0;
      const amt1 = Number(status.amount1) / 10 ** d1;
      const fee0 = Number(status.unclaimedFees0) / 10 ** d0;
      const fee1 = Number(status.unclaimedFees1) / 10 ** d1;

      const price0Usd = usdPrices.get(token0Info.address.toLowerCase()) ?? 0;
      const price1Usd = usdPrices.get(token1Info.address.toLowerCase()) ?? 0;

      entries.push({
        tokenId: posConfig.token_id,
        posIndex: i,
        pair: `${token0Info.symbol}/${token1Info.symbol}`,
        strategy: posConfig.strategy,
        isInRange: status.isInRange,
        totalValueUsd: amt0 * price0Usd + amt1 * price1Usd,
        fee0,
        fee1,
        fee0Usd: fee0 * price0Usd,
        fee1Usd: fee1 * price1Usd,
        token0Symbol: token0Info.symbol,
        token1Symbol: token1Info.symbol,
        status,
      });
    }

    return entries;
  }

  private formatPickerLine(i: number, entry: PositionPickerEntry, showFees: boolean): string {
    const rangeEmoji = entry.isInRange ? '🟢' : '🔴';
    let line = `  <b>${i + 1}.</b> #${entry.tokenId} — ${entry.pair} (${entry.strategy}) ${rangeEmoji} — ${formatUsd(entry.totalValueUsd)}`;
    if (showFees) {
      const totalFeeUsd = entry.fee0Usd + entry.fee1Usd;
      line += `\n      Fees: ${formatToken(entry.fee0, 2)} ${entry.token0Symbol} (${formatUsd(entry.fee0Usd)}) + ${formatToken(entry.fee1, 2)} ${entry.token1Symbol} (${formatUsd(entry.fee1Usd)}) = ${formatUsd(totalFeeUsd)}`;
    }
    return line;
  }

  // ============================================================
  // Flow Management
  // ============================================================

  private async startFlow(msg: TelegramBot.Message, type: FlowType, firstStep: string): Promise<void> {
    this.activeFlow = { type, step: firstStep, data: {}, startedAt: Date.now() };

    if (type === 'new') {
      await this.bot.sendMessage(
        msg.chat.id,
        `➕ <b>Add New Position</b>\n\nPlease enter the NFT ID (exclude the '#' symbol):\n\n<i>Send /cancel to abort at any time</i>`,
        { parse_mode: 'HTML' },
      );
    }
  }

  /** Start a flow that requires a position picker first */
  private async startPositionFlow(msg: TelegramBot.Message, type: FlowType): Promise<void> {
    const positions = this.context.config.positions;
    if (positions.length === 0) {
      await this.bot.sendMessage(msg.chat.id, '⚠️ No positions configured. Use /new to add one.');
      return;
    }

    const showFees = type === 'collect';
    const titles: Record<string, string> = {
      config: '⚙️ <b>Configure Position</b>',
      collect: '💰 <b>Collect Fees</b>',
      remove: '🗑️ <b>Remove Liquidity</b>',
      rebalance: '🔄 <b>Force Rebalance</b>',
      increase: '📈 <b>Increase Liquidity</b>',
      decrease: '📉 <b>Decrease Liquidity</b>',
    };

    await this.bot.sendMessage(msg.chat.id, `${titles[type]}\n\n⏳ Fetching positions...`, { parse_mode: 'HTML' });

    try {
      const entries = await this.buildPositionPicker(showFees);
      if (entries.length === 0) {
        await this.bot.sendMessage(msg.chat.id, '❌ Could not fetch any position data. Try again.');
        return;
      }

      // Auto-select if only 1 position
      if (entries.length === 1) {
        this.activeFlow = { type, step: 'after_pick', data: { pickerEntries: entries, selectedIdx: 0 }, startedAt: Date.now() };
        await this.routeAfterPick(msg.chat.id);
        return;
      }

      const lines = entries.map((e, i) => this.formatPickerLine(i, e, showFees));
      const pickerMsg = [
        titles[type]!,
        '',
        'Select a position:',
        '',
        ...lines,
        '',
        `Reply with a number (1-${entries.length}):`,
        '<i>Send /cancel to abort</i>',
      ].join('\n');

      this.activeFlow = { type, step: 'pick_position', data: { pickerEntries: entries }, startedAt: Date.now() };
      await this.bot.sendMessage(msg.chat.id, pickerMsg, { parse_mode: 'HTML' });
    } catch (error) {
      logger.error(`Error starting ${type} flow`, { error: (error as Error).message });
      await this.bot.sendMessage(msg.chat.id, `❌ Error: ${(error as Error).message}`);
    }
  }

  // ============================================================
  // Flow Step Router
  // ============================================================

  private async handleFlowStep(msg: TelegramBot.Message): Promise<void> {
    const flow = this.activeFlow;
    if (!flow || !msg.text) return;

    const chatId = msg.chat.id;
    const text = msg.text.trim();

    // Check timeout
    if (Date.now() - flow.startedAt > FLOW_TIMEOUT_MS) {
      this.activeFlow = null;
      await this.bot.sendMessage(chatId, '⏰ Session timed out. Start again.');
      return;
    }

    try {
      // Common: position picker step
      if (flow.step === 'pick_position') {
        const entries = flow.data.pickerEntries as PositionPickerEntry[];
        const choice = parseInt(text);
        if (isNaN(choice) || choice < 1 || choice > entries.length) {
          await this.bot.sendMessage(chatId, `❌ Enter a number between 1 and ${entries.length}:`);
          return;
        }
        flow.data.selectedIdx = choice - 1;
        flow.step = 'after_pick';
        await this.routeAfterPick(chatId);
        return;
      }

      // Route to per-flow handler
      switch (flow.type) {
        case 'new': await this.handleNewFlowStep(msg); break;
        case 'scan': await this.handleScanFlowStep(msg); break;
        case 'config': await this.handleConfigFlowStep(msg); break;
        case 'collect': await this.handleCollectFlowStep(msg); break;
        case 'remove': await this.handleRemoveFlowStep(msg); break;
        case 'rebalance': await this.handleRebalanceFlowStep(msg); break;
        case 'increase': await this.handleIncreaseFlowStep(msg); break;
        case 'decrease': await this.handleDecreaseFlowStep(msg); break;
      }
    } catch (error) {
      logger.error(`Error in ${flow.type} flow step`, { step: flow.step, error: (error as Error).message });
      this.activeFlow = null;
      await this.bot.sendMessage(chatId, `❌ Error: ${(error as Error).message}`);
    }
  }

  /** After position is picked, route to the appropriate flow's next step */
  private async routeAfterPick(chatId: number): Promise<void> {
    const flow = this.activeFlow!;
    const entries = flow.data.pickerEntries as PositionPickerEntry[];
    const entry = entries[flow.data.selectedIdx as number];

    switch (flow.type) {
      case 'config':
        flow.step = 'show_config';
        await this.showConfigForPosition(chatId, entry);
        break;
      case 'collect':
        flow.step = 'confirm_collect';
        await this.showCollectConfirm(chatId, entry);
        break;
      case 'remove':
        flow.step = 'choose_percent';
        await this.showRemovePercentChoice(chatId, entry);
        break;
      case 'rebalance':
        flow.step = 'confirm_rebalance';
        await this.showRebalanceConfirm(chatId, entry);
        break;
      case 'increase':
        flow.step = 'choose_increase_mode';
        await this.showIncreaseOptions(chatId, entry);
        break;
      case 'decrease':
        flow.step = 'choose_decrease_percent';
        await this.showDecreasePercentChoice(chatId, entry);
        break;
    }
  }

  // ============================================================
  // /status
  // ============================================================

  private async handleStatus(msg: TelegramBot.Message): Promise<void> {
    try {
      const positions = this.context.config.positions;
      if (positions.length === 0) {
        await this.bot.sendMessage(msg.chat.id, '⚠️ No positions configured');
        return;
      }

      await this.bot.sendMessage(msg.chat.id, '⏳ Fetching status for all positions...');

      const withTimeout = <T>(promise: Promise<T>, ms: number): Promise<T> =>
        Promise.race([
          promise,
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error('RPC timeout — try again shortly')), ms),
          ),
        ]);

      const statusResults = await Promise.allSettled(
        positions.map((pos) =>
          withTimeout(
            getPositionStatus(pos.token_id, this.getContractsForPosition(pos.token_id), this.getChainForPosition(pos.token_id)),
            30_000,
          ),
        ),
      );

      const tokenAddresses = new Set<string>();
      for (const result of statusResults) {
        if (result.status === 'fulfilled') {
          tokenAddresses.add(result.value.token0Info.address);
          tokenAddresses.add(result.value.token1Info.address);
        }
      }

      let usdPrices = new Map<string, number>();
      if (tokenAddresses.size > 0) {
        try {
          usdPrices = await getTokenPrices([...tokenAddresses]);
        } catch {
          logger.warn('Failed to fetch USD prices for /status');
        }
      }

      for (let i = 0; i < positions.length; i++) {
        const posConfig = positions[i];
        const result = statusResults[i];

        if (result.status === 'rejected') {
          await this.bot.sendMessage(
            msg.chat.id,
            `❌ Position #${posConfig.token_id}: Error fetching status\n${(result.reason as Error).message}`,
          );
          continue;
        }

        const status = result.value;
        const { position, pool, token0Info, token1Info } = status;
        const d0 = token0Info.decimals;
        const d1 = token1Info.decimals;

        const currentPrice = tickToPrice(pool.currentTick, d0, d1);
        const lowerPrice = tickToPrice(position.tickLower, d0, d1);
        const upperPrice = tickToPrice(position.tickUpper, d0, d1);
        const widthPct = ((upperPrice - lowerPrice) / lowerPrice) * 100;

        const amt0 = Number(status.amount0) / 10 ** d0;
        const amt1 = Number(status.amount1) / 10 ** d1;
        const fee0 = Number(status.unclaimedFees0) / 10 ** d0;
        const fee1 = Number(status.unclaimedFees1) / 10 ** d1;

        const price0Usd = usdPrices.get(token0Info.address.toLowerCase()) ?? 0;
        const price1Usd = usdPrices.get(token1Info.address.toLowerCase()) ?? 0;
        const value0Usd = amt0 * price0Usd;
        const value1Usd = amt1 * price1Usd;
        const totalValueUsd = value0Usd + value1Usd;
        const fee0Usd = fee0 * price0Usd;
        const fee1Usd = fee1 * price1Usd;

        const statusEmoji = status.isInRange ? '🟢' : '🔴';
        const rangeText = status.isInRange ? 'IN RANGE' : 'OUT OF RANGE';

        const message = [
          `📊 <b>Position #${posConfig.token_id}</b>`,
          ``,
          `Pair: ${token0Info.symbol}/${token1Info.symbol}`,
          `Fee Tier: ${(position.fee / 10000).toFixed(2)}%`,
          ``,
          `<b>Price:</b>`,
          `• Current: ${formatNum(currentPrice)} ${token1Info.symbol} per ${token0Info.symbol}`,
          ``,
          `<b>Range:</b>`,
          `• Lower: ${formatNum(lowerPrice)} ${token1Info.symbol} per ${token0Info.symbol}`,
          `• Upper: ${formatNum(upperPrice)} ${token1Info.symbol} per ${token0Info.symbol}`,
          `• Status: ${statusEmoji} ${rangeText}`,
        ];

        // Show time-out-of-range for positions that are out of range
        if (!status.isInRange) {
          const pk = `${posConfig.chain_id ?? this.context.config.chain.chainId}-${posConfig.token_id}`;
          const firstSeen = outOfRangeSince.get(pk);
          const confirmMinutes = posConfig.params.confirm_minutes ?? 0;
          if (firstSeen) {
            const elapsedMs = Date.now() - firstSeen;
            const elapsedMin = elapsedMs / 60_000;
            message.push(`• Out of range for: <b>${formatDuration(elapsedMs)}</b>`);
            if (confirmMinutes > 0 && elapsedMin < confirmMinutes) {
              const remainingMs = (confirmMinutes - elapsedMin) * 60_000;
              message.push(`• Rebalance triggers in: <b>${formatDuration(remainingMs)}</b>`);
            } else if (confirmMinutes > 0) {
              message.push(`• ⏰ Rebalance threshold met — will execute on next cycle`);
            }
          } else if (confirmMinutes > 0) {
            message.push(`• Timer not started yet (first detection on next cycle)`);
          }
        }

        message.push(
          ``,
          `<b>Value:</b> ${formatUsd(totalValueUsd)}`,
          `• ${token0Info.symbol}: ${formatToken(amt0, d0)} (${formatUsd(value0Usd)})`,
          `• ${token1Info.symbol}: ${formatToken(amt1, d1)} (${formatUsd(value1Usd)})`,
          ``,
          `<b>Unclaimed Fees:</b>`,
          `• ${token0Info.symbol}: ${formatToken(fee0, d0)} (${formatUsd(fee0Usd)})`,
          `• ${token1Info.symbol}: ${formatToken(fee1, d1)} (${formatUsd(fee1Usd)})`,
          ``,
          `<b>Strategy:</b> ${posConfig.strategy}`,
          `• Width: ${posConfig.params.width_ticks} ticks (~${widthPct.toFixed(1)}%)`,
          `• Trigger: ${posConfig.params.trigger_distance_ticks} ticks (~${ticksToPercentage(posConfig.params.trigger_distance_ticks).toFixed(2)}%)`,
        );
        if (posConfig.params.critical_distance_ticks !== undefined && posConfig.params.critical_distance_ticks > 0) {
          message.push(
            `• Critical: ${posConfig.params.critical_distance_ticks} ticks (~${ticksToPercentage(posConfig.params.critical_distance_ticks).toFixed(2)}%) — bypasses timer`,
          );
        }
        if (posConfig.gauge_address) {
          message.push(
            `• Gauge: ${posConfig.gauge_address.slice(0, 6)}...${posConfig.gauge_address.slice(-4)} (auto-unstake/restake)`,
          );
        }

        // Volatility indicator (from recent snapshots)
        try {
          const storagePath = this.context.config.analytics?.storage_path ?? './analytics';
          const recentSnapshots = await querySnapshots(
            storagePath, posConfig.token_id,
            Date.now() - 60 * 60 * 1000, // Last 1 hour
          );
          if (recentSnapshots.length >= 2) {
            const vol = calculateTickVolatility(recentSnapshots, 60);
            const regimeEmoji = vol.regime === 'high' ? '🔴' : vol.regime === 'medium' ? '🟡' : '🟢';
            message.push(
              ``,
              `<b>Volatility:</b> ${regimeEmoji} ${vol.regime.toUpperCase()}`,
              `• StdDev: ${vol.stdDev.toFixed(1)} ticks | Avg: ${vol.avgTickChange.toFixed(1)} | Max: ${vol.maxTickChange}`,
            );
          }
        } catch {
          // Non-fatal: skip volatility display
        }

        // Health score
        try {
          const storagePath = this.context.config.analytics?.storage_path ?? './analytics';
          const requestedChainId = posConfig.chain_id ?? this.context.config.chain.chainId;
          const requestedDex = posConfig.dex;
          const [allRebalances, allFeeCollections, allSnapshots, allEntries, allManualLinks] = await Promise.all([
            queryAllChainRebalances(storagePath),
            queryAllChainFeeCollections(storagePath),
            queryAllChainSnapshots(storagePath),
            queryAllChainPositionEntries(storagePath),
            queryAllChainManualLinks(storagePath),
          ]);

          const matchesScope = (chainId?: number, dex?: string): boolean => (
            (requestedChainId === undefined || chainId === undefined || chainId === requestedChainId)
            && (requestedDex === undefined || dex === undefined || dex === requestedDex)
          );

          const posRebalances = allRebalances.filter(
            (r) => (r.oldTokenId === posConfig.token_id || r.newTokenId === posConfig.token_id)
              && matchesScope(r.chainId, r.dex),
          );
          const posSnapshots = allSnapshots.filter(
            (snapshot) => snapshot.tokenId === posConfig.token_id && matchesScope(snapshot.chainId, snapshot.dex),
          );

          const wrappedNativeAddress = this.context.config.chains.get(requestedChainId)?.wrappedNativeAddress
            ?? TOKENS.WPLS;
          const nativePrices = await getTokenPrices([wrappedNativeAddress]);
          const nativePriceUsd = nativePrices.get(wrappedNativeAddress.toLowerCase()) ?? 0;

          const posValueUsd =
            bigintToFloat(status.amount0, status.token0Info.decimals) * price0Usd +
            bigintToFloat(status.amount1, status.token1Info.decimals) * price1Usd;

          const lineageSummary = buildLineageAnalyticsSummary({
            requestedTokenId: posConfig.token_id,
            requestedChainId,
            requestedDex,
            rebalances: allRebalances,
            feeCollections: allFeeCollections,
            snapshots: allSnapshots,
            positionEntries: allEntries,
            manualLinks: allManualLinks,
            liveState: {
              tokenId: posConfig.token_id,
              chainId: requestedChainId,
              dex: requestedDex,
              timestamp: Date.now(),
              currentPositionValueUsd: posValueUsd,
              currentUnclaimedFeesUsd: fee0Usd + fee1Usd,
              priceUsd0: price0Usd,
              priceUsd1: price1Usd,
              nativePriceUsd,
              token0Symbol: status.token0Info.symbol,
              token1Symbol: status.token1Info.symbol,
              token0Decimals: status.token0Info.decimals,
              token1Decimals: status.token1Info.decimals,
              source: 'live',
              priceStatus: 'live',
            },
          });

          let avgAPR = 0;
          for (const rb of posRebalances) {
            avgAPR += rb.metrics.feeAPR;
          }
          if (posRebalances.length > 0) avgAPR /= posRebalances.length;

          const { estimateTimeInRange } = await import('./analytics/metrics.js');
          const timeInRange = estimateTimeInRange(posSnapshots);

          let avgRebalanceCostPercent = 0;
          if (posRebalances.length > 0) {
            let costSum = 0;
            for (const rb of posRebalances) {
              costSum += rb.metrics.rebalanceCostPercent ?? 0;
            }
            avgRebalanceCostPercent = costSum / posRebalances.length;
          }

          const health = calculateHealthScore({
            netPnlUsd: lineageSummary.lifetimeChain.truePnlUsd ?? lineageSummary.lifetimeChain.netIncomeUsd,
            avgFeeAPR: avgAPR,
            timeInRangePercent: timeInRange,
            distanceFromEdgeTicks: Math.abs(status.tickDistance),
            triggerDistanceTicks: posConfig.params.trigger_distance_ticks,
            avgRebalanceCostPercent,
          });

          const healthEmoji = health.score >= 75 ? '💚' : health.score >= 50 ? '💛' : health.score >= 25 ? '🧡' : '❤️';
          message.push(
            ``,
            `<b>Health:</b> ${healthEmoji} ${health.score}/100 (${health.label})`,
          );

          const profitability = lineageSummary.lifetimeChain ?? lineageSummary.currentInterval;
          if (profitability.truePnlUsd !== null) {
            const pnlEmoji = profitability.truePnlUsd >= 0 ? '📈' : '📉';
            const hodlValue = profitability.lpVsHodlPercent ?? 0;
            const hodlEmoji = hodlValue >= 0 ? '✅' : '⚠️';
            const basisLabel = lineageSummary.lifetimeChain ? 'Root Basis' : 'Interval Basis';
            const basisValue = profitability.entryCostUsd !== null ? `$${profitability.entryCostUsd.toFixed(4)}` : '—';
            const pnlPct = profitability.truePnlPercent ?? 0;
            const lpVsHodlPct = profitability.lpVsHodlPercent ?? 0;
            const lpVsHodlUsd = profitability.lpVsHodlUsd ?? 0;
            const priceDisadvantageUsd = profitability.totalPriceDisadvantageUsd ?? 0;
            message.push(
              ``,
              `${pnlEmoji} <b>${lineageSummary.lifetimeChain ? 'Chain True P&L' : 'Interval True P&L'}:</b> $${profitability.truePnlUsd.toFixed(4)} (${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(2)}%)`,
              `${hodlEmoji} <b>LP vs HODL:</b> ${lpVsHodlPct >= 0 ? '+' : ''}${lpVsHodlPct.toFixed(2)}% ($${lpVsHodlUsd.toFixed(4)})`,
              `💰 <b>${basisLabel}:</b> ${basisValue} → Now: $${profitability.currentPositionValueUsd.toFixed(4)} | Fees: $${profitability.totalFeesUsd.toFixed(4)}`,
              `⚙️ <b>Costs:</b> Gas -$${profitability.totalGasCostUsd.toFixed(4)} | Friction -$${profitability.totalSwapFrictionUsd.toFixed(4)} | Price Disadv. -$${priceDisadvantageUsd.toFixed(4)}`,
              `🧾 <b>Trust:</b> ${profitability.trust.overall.replace(/_/g, ' ')}`,
            );
          } else {
            message.push(
              ``,
              `💰 <b>Net Income:</b> $${lineageSummary.lifetimeChain.netIncomeUsd.toFixed(4)} | Fees: $${lineageSummary.lifetimeChain.totalFeesUsd.toFixed(4)} | Gas: -$${lineageSummary.lifetimeChain.totalGasCostUsd.toFixed(4)}`,
            );
          }
        } catch {
          // Non-fatal: skip health display
        }

        // Safe mode, auto-disabled, and kill switch status
        const statusPk = posKey(posConfig.chain_id ?? this.context.config.chain.chainId, posConfig.token_id);
        if (isAutoDisabled(statusPk)) {
          message.push(``, `⏸️ <b>AUTO-DISABLED</b> — burned/unowned, use /removestale or /enable to clear`);
        }
        if (isSafeMode(statusPk)) {
          message.push(``, `🔴 <b>SAFE MODE</b> — use /enable to resume monitoring`);
        }
        const ks = getKillSwitchStatus(statusPk);
        if (ks?.disabled) {
          const reason = ks.reason ? ` (${ks.reason})` : '';
          const losses = ks.consecutiveLosses > 0 ? `, ${ks.consecutiveLosses} consecutive losses` : '';
          message.push(``, `⛔ <b>KILL SWITCH TRIGGERED</b>${reason}${losses} — use /enable to reset`);
        }

        if (i < positions.length - 1) {
          message.push(``, `───────────────────`);
        }

        message.push(``, `<i>Report generated: ${new Date().toLocaleString()}</i>`);

        await this.bot.sendMessage(msg.chat.id, message.join('\n'), { parse_mode: 'HTML' });
      }

      logger.info('Telegram /status command executed', { positionCount: positions.length });
    } catch (error) {
      logger.error('Error handling /status command', { error: (error as Error).message });
      await this.bot.sendMessage(msg.chat.id, '❌ Error fetching status. Check logs.');
    }
  }

  // ============================================================
  // /balance — All Wallet Assets
  // ============================================================

  private async handleBalance(msg: TelegramBot.Message): Promise<void> {
    try {
      await this.bot.sendMessage(msg.chat.id, '⏳ Fetching wallet balances...');

      const addr = this.context.chain.wallet.address;
      const truncatedAddr = `${addr.slice(0, 6)}...${addr.slice(-4)}`;

      // Get native balances per chain
      const nativeBalances: string[] = [];
      if (this.context.multiChain) {
        for (const chainId of this.context.multiChain.getChainIds()) {
          const cc = this.context.multiChain.getChainById(chainId);
          const ccfg = this.context.multiChain.getChainConfig(chainId);
          try {
            const bal = await cc.provider.getBalance(addr);
            nativeBalances.push(`${ccfg.nativeCurrencySymbol}: ${parseFloat(ethers.formatEther(bal)).toFixed(2)} [${ccfg.chainName}]`);
          } catch { /* skip */ }
        }
      } else {
        const plsBalance = await this.context.chain.provider.getBalance(addr);
        nativeBalances.push(`PLS: ${parseFloat(ethers.formatEther(plsBalance)).toFixed(2)}`);
      }

      // Collect unique token addresses from all positions, tracking which chain they're on
      const tokenSet = new Map<string, { symbol: string; decimals: number; chainId: number }>();
      for (const pos of this.context.config.positions) {
        try {
          const posContracts = this.getContractsForPosition(pos.token_id);
          const posChain = this.getChainForPosition(pos.token_id);
          const posChainId = this.context.multiChain
            ? this.context.multiChain.resolveChainId(pos)
            : this.context.config.chain.chainId;
          const status = await getPositionStatus(pos.token_id, posContracts, posChain);
          const { token0Info, token1Info } = status;
          tokenSet.set(token0Info.address.toLowerCase(), { symbol: token0Info.symbol, decimals: token0Info.decimals, chainId: posChainId });
          tokenSet.set(token1Info.address.toLowerCase(), { symbol: token1Info.symbol, decimals: token1Info.decimals, chainId: posChainId });
        } catch {
          // Skip position if we can't fetch it
        }
      }

      // Fetch ERC-20 balances in parallel — use each token's chain contracts
      const tokenEntries = [...tokenSet.entries()];
      const balanceResults = await Promise.allSettled(
        tokenEntries.map(async ([address, info]) => {
          const tokenContracts = this.context.multiChain
            ? this.context.multiChain.registries.get(info.chainId)!.getForDex()
            : this.context.contracts;
          const erc20 = tokenContracts.getERC20(address);
          const bal: bigint = await erc20.balanceOf(addr);
          return bal;
        }),
      );


      // Fetch USD prices
      let usdPrices = new Map<string, number>();
      try {
        usdPrices = await getTokenPrices(tokenEntries.map(([a]) => a));
      } catch { /* best effort */ }

      // Build message
      const lines: string[] = [
        `💰 <b>Wallet Assets</b>`,
        `<code>${truncatedAddr}</code>`,
        ``,
        ...nativeBalances,
      ];

      let totalUsd = 0;

      for (let i = 0; i < tokenEntries.length; i++) {
        const [address, info] = tokenEntries[i];
        const result = balanceResults[i];
        if (result.status === 'rejected') continue;

        const balance = result.value;
        if (balance === 0n) continue;

        const human = Number(balance) / 10 ** info.decimals;
        const priceUsd = usdPrices.get(address) ?? 0;
        const valueUsd = human * priceUsd;
        totalUsd += valueUsd;

        const balStr = human >= 1 ? human.toLocaleString('en-US', { maximumFractionDigits: 2 }) : human.toFixed(6);
        lines.push(`${info.symbol}: ${balStr}${priceUsd > 0 ? ` (${formatUsd(valueUsd)})` : ''}`);
      }

      if (totalUsd > 0) {
        lines.push(``, `<b>Total (tokens):</b> ${formatUsd(totalUsd)}`);
      }

      lines.push(``, `<i>Updated: ${new Date().toLocaleString()}</i>`);

      await this.bot.sendMessage(msg.chat.id, lines.join('\n'), { parse_mode: 'HTML' });
      logger.info('Telegram /balance command executed');
    } catch (error) {
      logger.error('Error handling /balance command', { error: (error as Error).message });
      await this.bot.sendMessage(msg.chat.id, '❌ Error fetching balance. Check logs.');
    }
  }

  // ============================================================
  // /enable, /disable
  // ============================================================

  private async handleEnable(msg: TelegramBot.Message): Promise<void> {
    this.rebalancingEnabled = true;
    try { unlinkSync(DISABLE_FLAG_PATH); } catch { /* file may not exist */ }

    // Parse optional tokenId argument: /enable [tokenId]
    const text = msg.text?.trim() ?? '/enable';
    const tokenIdArg = text.split(/\s+/)[1];
    const targetTokenId = tokenIdArg ? parseInt(tokenIdArg, 10) : null;

    const { resetKillSwitch } = await import('./killSwitch.js');
    const clearedSafeMode: number[] = [];

    for (const pos of this.context.config.positions) {
      if (targetTokenId !== null && pos.token_id !== targetTokenId) continue;
      const chainId = pos.chain_id ?? this.context.config.chain.chainId;
      const pk = posKey(chainId, pos.token_id);

      resetKillSwitch(pk);

      // Clear safe mode — operator has explicitly reviewed and is re-enabling.
      // If a recovery state file exists for this position, warn the operator
      // but still clear: they may be clearing safe mode to run /recover.
      const hasRecovery = existsSync(recoveryStatePath(chainId)) || existsSync(RECOVERY_STATE_PATH);
      if (clearSafeMode(pk)) {
        clearedSafeMode.push(pos.token_id);
        if (hasRecovery) {
          logger.warn(
            `Safe mode cleared for position ${pos.token_id} via /enable, ` +
            `but a recovery state file exists — run /recover to check for stranded funds.`,
          );
          await this.bot.sendMessage(
            msg.chat.id,
            `⚠️ Position #${pos.token_id} has a recovery state file on disk.\nRun /recover to check for stranded funds before bot rebalances.`,
          );
        }
      }

      // Also clear auto-disabled state (burned/unowned positions)
      if (clearAutoDisabled(pk)) {
        clearedSafeMode.push(pos.token_id);
      }
    }

    const scopeMsg = targetTokenId !== null ? ` for position #${targetTokenId}` : ' for all positions';
    const safeModeMsg = clearedSafeMode.length > 0
      ? `\nSafe mode cleared: ${clearedSafeMode.map(id => `#${id}`).join(', ')}`
      : '';

    await this.bot.sendMessage(
      msg.chat.id,
      `✅ Rebalancing ENABLED (persistent).${scopeMsg}\nKill switches reset.${safeModeMsg}`,
    );
    logger.info(
      `Rebalancing enabled via Telegram. Scope: ${targetTokenId ?? 'all'}. ` +
      `Safe mode cleared: ${clearedSafeMode.join(', ') || 'none'}.`,
    );
  }

  private async handleDisable(msg: TelegramBot.Message): Promise<void> {
    this.rebalancingEnabled = false;
    try { writeFileSync(DISABLE_FLAG_PATH, new Date().toISOString(), 'utf-8'); } catch (e) {
      logger.error('Failed to persist disable flag', { error: (e as Error).message });
    }
    await this.bot.sendMessage(msg.chat.id, '⛔ Rebalancing DISABLED (emergency stop — persists across restarts)');
    logger.warn('Rebalancing disabled via Telegram command (flag persisted to disk)');
  }

  // ============================================================
  // /recover
  // ============================================================

  private async handleRecover(msg: TelegramBot.Message, confirm: boolean): Promise<void> {
    try {
      if (confirm) {
        if (!this.pendingRecovery) {
          await this.bot.sendMessage(msg.chat.id, '⚠️ No pending recovery. Run /recover first to detect stranded funds.');
          return;
        }

        await this.bot.sendMessage(msg.chat.id, '⏳ Executing recovery — minting new position...');

        const result = await recoverStrandedFunds(
          this.pendingRecovery,
          this.context.config,
          this.pendingRecoveryContracts ?? this.context.contracts,
          this.pendingRecoveryChain ?? this.context.chain,
        );

        this.pendingRecovery = null;
        this.pendingRecoveryContracts = undefined;
        this.pendingRecoveryChain = undefined;

        const message = [
          `✅ <b>Recovery Complete</b>`,
          ``,
          `New position: <b>#${result.newTokenId}</b>`,
          `Liquidity: ${result.liquidity.toString()}`,
          `Amounts used: ${result.amount0.toString()} / ${result.amount1.toString()}`,
          `Tx: <code>${result.txHash}</code>`,
        ].join('\n');

        await this.bot.sendMessage(msg.chat.id, message, { parse_mode: 'HTML' });
        logger.info('Recovery executed via Telegram /recover confirm');
        return;
      }

      await this.bot.sendMessage(msg.chat.id, '⏳ Scanning for stranded funds...');

      // Scan all configured chains for stranded funds
      let report: Awaited<ReturnType<typeof detectStrandedFunds>> = null;
      let recoverContracts = this.context.contracts;
      let recoverChain = this.context.chain;

      if (this.context.multiChain) {
        for (const cid of this.context.multiChain.getChainIds()) {
          const cc = this.context.multiChain.getChainById(cid);
          const cContracts = this.context.multiChain.registries.get(cid)!.getForDex();
          const r = await detectStrandedFunds(cContracts, cc, cid);
          if (r) {
            report = r;
            recoverChain = cc;
            // Resolve correct DEX contracts from position config or recovery state (e.g. aerodrome-cl)
            const posConfig = this.context.config.positions.find(
              p => p.token_id === r.recoveryState.oldTokenId,
            );
            const effectiveDex = posConfig?.dex ?? r.recoveryState.dex;
            recoverContracts = this.context.multiChain.registries.get(cid)!.getForDex(effectiveDex);
            break;
          }
        }
      }
      // Also check legacy (no chainId) recovery state file
      if (!report) {
        report = await detectStrandedFunds(this.context.contracts, this.context.chain);
      }

      if (!report) {
        this.pendingRecovery = null;
        this.pendingRecoveryContracts = undefined;
        this.pendingRecoveryChain = undefined;
        await this.bot.sendMessage(msg.chat.id, '✅ No stranded funds detected. All clear.');
        return;
      }

      this.pendingRecovery = report;
      this.pendingRecoveryContracts = recoverContracts;
      this.pendingRecoveryChain = recoverChain;
      const { recoveryState, balance0, balance1 } = report;

      const message = [
        `🚨 <b>Stranded Funds Detected</b>`,
        ``,
        `Failed rebalance of position <b>#${recoveryState.oldTokenId}</b>`,
        `Pair: ${recoveryState.token0Symbol}/${recoveryState.token1Symbol}`,
        `Fee: ${(recoveryState.fee / 10000).toFixed(2)}%`,
        ``,
        `<b>Wallet balances:</b>`,
        `• ${recoveryState.token0Symbol}: ${balance0.toString()}`,
        `• ${recoveryState.token1Symbol}: ${balance1.toString()}`,
        ``,
        `Strategy: ${recoveryState.strategy} (width: ${recoveryState.params.width_ticks} ticks)`,
        ``,
        `To recover, send: <code>/recover confirm</code>`,
        this.context.config.dry_run ? `\n⚠️ <i>Dry run mode — no real transaction will execute</i>` : '',
      ].join('\n');

      await this.bot.sendMessage(msg.chat.id, message, { parse_mode: 'HTML' });
      logger.info('Stranded funds detected via Telegram /recover command');
    } catch (error) {
      logger.error('Error handling /recover command', { error: (error as Error).message });
      await this.bot.sendMessage(msg.chat.id, `❌ Recovery error: ${(error as Error).message}`);
    }
  }

  // ============================================================
  // /new — Interactive New Position Flow
  // ============================================================

  /** Show the strategy selection menu and advance flow to 'strategy' step */
  private async showStrategyMenu(chatId: number, tokenId: number): Promise<void> {
    this.activeFlow!.step = 'strategy';
    const lines = STRATEGY_MENU.map((item, i) => `  <b>${i + 1}.</b> ${item.label}`);
    const menuMsg = [
      `✅ NFT ID: <b>#${tokenId}</b>`,
      ``,
      `What strategy would you like to use?`,
      ``,
      `<b>Preset (recommended):</b>`,
      ...lines.slice(0, 6),
      ``,
      `<b>Custom width:</b>`,
      ...lines.slice(6, 9),
      ``,
      `<b>Special:</b>`,
      ...lines.slice(9),
      ``,
      `Reply with a number (1-${STRATEGY_MENU.length}):`,
    ].join('\n');
    await this.bot.sendMessage(chatId, menuMsg, { parse_mode: 'HTML' });
  }

  private async handleNewFlowStep(msg: TelegramBot.Message): Promise<void> {
    const flow = this.activeFlow;
    if (!flow || !msg.text) return;

    const chatId = msg.chat.id;
    const text = msg.text.trim();

    switch (flow.step) {
      case 'token_id': {
        const tokenId = parseInt(text);
        if (isNaN(tokenId) || tokenId <= 0) {
          await this.bot.sendMessage(chatId, '❌ Please enter a valid positive number for the NFT ID:');
          return;
        }
        const existing = this.context.config.positions.find(p => p.token_id === tokenId);
        if (existing) {
          await this.bot.sendMessage(chatId, `❌ Position #${tokenId} already exists (strategy: ${existing.strategy}). Enter a different ID:`);
          return;
        }
        flow.data.tokenId = tokenId;

        // Multi-chain: ask which chain if more than one configured
        const chainIds = this.context.multiChain
          ? this.context.multiChain.getChainIds()
          : [this.context.config.chain.chainId];
        if (chainIds.length > 1) {
          flow.step = 'chain';
          const chainLines = chainIds.map((cid, i) => {
            const entry = CHAIN_REGISTRY[cid];
            return `  <b>${i + 1}.</b> ${entry?.chainName ?? `Chain ${cid}`} (${cid})`;
          });
          await this.bot.sendMessage(chatId, [
            `✅ NFT ID: <b>#${tokenId}</b>`,
            ``,
            `Which chain is this position on?`,
            ``,
            ...chainLines,
            ``,
            `Reply with a number (1-${chainIds.length}):`,
          ].join('\n'), { parse_mode: 'HTML' });
          return;
        }
        // Single chain — skip chain selection
        flow.data.chainId = chainIds[0];
        // Check if this chain has multiple DEXes
        const dexes = getSupportedDexes(chainIds[0]);
        if (dexes.length > 1) {
          flow.step = 'dex';
          const dexLines = dexes.map((name, i) => {
            const dc = getDexConfig(chainIds[0], name);
            return `  <b>${i + 1}.</b> ${dc.protocolName} (${name})`;
          });
          await this.bot.sendMessage(chatId, [
            `✅ NFT ID: <b>#${tokenId}</b>`,
            ``,
            `Which DEX is this position on?`,
            ``,
            ...dexLines,
            ``,
            `Reply with a number (1-${dexes.length}):`,
          ].join('\n'), { parse_mode: 'HTML' });
          return;
        }
        // Single DEX — proceed to strategy
        await this.showStrategyMenu(chatId, tokenId);
        return;
      }

      case 'chain': {
        const chainIds = this.context.multiChain
          ? this.context.multiChain.getChainIds()
          : [this.context.config.chain.chainId];
        const choice = parseInt(text);
        if (isNaN(choice) || choice < 1 || choice > chainIds.length) {
          await this.bot.sendMessage(chatId, `❌ Please enter a number between 1 and ${chainIds.length}:`);
          return;
        }
        const selectedChainId = chainIds[choice - 1];
        flow.data.chainId = selectedChainId;
        const chainEntry = CHAIN_REGISTRY[selectedChainId];
        const chainName = chainEntry?.chainName ?? `Chain ${selectedChainId}`;
        // Check if this chain has multiple DEXes
        const dexes = getSupportedDexes(selectedChainId);
        if (dexes.length > 1) {
          flow.step = 'dex';
          const dexLines = dexes.map((name, i) => {
            const dc = getDexConfig(selectedChainId, name);
            return `  <b>${i + 1}.</b> ${dc.protocolName} (${name})`;
          });
          await this.bot.sendMessage(chatId, [
            `✅ Chain: <b>${chainName}</b>`,
            ``,
            `Which DEX is this position on?`,
            ``,
            ...dexLines,
            ``,
            `Reply with a number (1-${dexes.length}):`,
          ].join('\n'), { parse_mode: 'HTML' });
          return;
        }
        // Single DEX — proceed to strategy
        await this.showStrategyMenu(chatId, flow.data.tokenId as number);
        return;
      }

      case 'dex': {
        const selectedChainId = flow.data.chainId as number;
        const dexes = getSupportedDexes(selectedChainId);
        const choice = parseInt(text);
        if (isNaN(choice) || choice < 1 || choice > dexes.length) {
          await this.bot.sendMessage(chatId, `❌ Please enter a number between 1 and ${dexes.length}:`);
          return;
        }
        flow.data.dex = dexes[choice - 1];
        const dc = getDexConfig(selectedChainId, flow.data.dex as string);
        await this.bot.sendMessage(chatId, `✅ DEX: <b>${dc.protocolName}</b>`, { parse_mode: 'HTML' });
        await this.showStrategyMenu(chatId, flow.data.tokenId as number);
        return;
      }

      case 'strategy': {
        const choice = parseInt(text);
        if (isNaN(choice) || choice < 1 || choice > STRATEGY_MENU.length) {
          await this.bot.sendMessage(chatId, `❌ Please enter a number between 1 and ${STRATEGY_MENU.length}:`);
          return;
        }
        const selected = STRATEGY_MENU[choice - 1];

        // Custom wizard: prompt for base style first, then width/trigger/advanced
        if (selected.strategy === ('custom' as StrategyType)) {
          flow.step = 'custom_style';
          await this.bot.sendMessage(chatId,
            `<b>Custom Strategy Wizard</b>\n\nChoose a base style:\n` +
            `1. center — Equal range above and below price\n` +
            `2. bullish — More range above price (30/70 default)\n` +
            `3. bearish — More range below price (70/30 default)\n\n` +
            `Enter 1-3:`,
            { parse_mode: 'HTML' },
          );
          return;
        }

        flow.data.strategy = selected.strategy;

        await this.bot.sendMessage(chatId, `✅ Strategy: <b>${selected.strategy}</b>`, { parse_mode: 'HTML' });

        const hasPresetWidth = PRESET_WIDTH_REGEX.test(selected.strategy);
        if (!hasPresetWidth && selected.strategy !== 'lazy_ascending' && selected.strategy !== 'lazy_descending' && selected.strategy !== 'lazy_up' && selected.strategy !== 'lazy_down' && selected.strategy !== 'static') {
          flow.step = 'width';
          await this.bot.sendMessage(chatId, `Enter range width in ticks or percentage (e.g. 300, 6%):`);

          return;
        }

        flow.step = 'trigger';
        await this.bot.sendMessage(chatId, `Enter trigger distance in ticks (default: <b>50</b>):`, { parse_mode: 'HTML' });
        return;
      }

      case 'custom_style': {
        const styleChoice = parseInt(text);
        const styles: StrategyType[] = ['center', 'bullish', 'bearish'];
        if (isNaN(styleChoice) || styleChoice < 1 || styleChoice > 3) {
          await this.bot.sendMessage(chatId, '❌ Enter 1, 2, or 3:');
          return;
        }
        flow.data.strategy = styles[styleChoice - 1];
        flow.data.isCustomWizard = true;
        flow.step = 'width';
        await this.bot.sendMessage(chatId,
          `✅ Style: <b>${styles[styleChoice - 1]}</b>\n\nEnter range width in ticks or percentage (e.g. 300, 6%):`,
          { parse_mode: 'HTML' },
        );
        return;
      }

      case 'width': {
        let widthTicks: number;
        if (text.endsWith('%')) {
          const pct = parseFloat(text.replace('%', ''));
          if (isNaN(pct) || pct <= 0) {
            await this.bot.sendMessage(chatId, '❌ Percentage must be positive (e.g. 6%). Try again:');
            return;
          }
          widthTicks = percentageToTicks(pct);
        } else {
          widthTicks = parseInt(text);
          if (isNaN(widthTicks) || widthTicks <= 0) {
            await this.bot.sendMessage(chatId, '❌ Width must be a positive number or percentage (e.g. 300, 6%). Try again:');
            return;
          }
        }
        flow.data.widthTicks = widthTicks;
        flow.step = 'trigger';
        await this.bot.sendMessage(chatId, `✅ Width: <b>${widthTicks} ticks (~${ticksToPercentage(widthTicks).toFixed(1)}%)</b>\n\nEnter trigger distance in ticks or percentage (default: <b>50 ticks</b>):`, { parse_mode: 'HTML' });
        return;
      }

      case 'trigger': {
        let trigger: number;
        if (text.endsWith('%')) {
          const pct = parseFloat(text.replace('%', ''));
          if (isNaN(pct) || pct < 0) {
            await this.bot.sendMessage(chatId, '❌ Trigger percentage must be non-negative. Try again:');
            return;
          }
          trigger = percentageToTicks(pct);
        } else {
          trigger = parseInt(text);
          if (isNaN(trigger) || trigger < 0) {
            await this.bot.sendMessage(chatId, '❌ Trigger distance must be non-negative (e.g. 50, 0.5%). Try again:');
            return;
          }
        }
        flow.data.triggerDistance = trigger;

        const strategy = flow.data.strategy as string;
        const isSnuggle = strategy.startsWith('snuggle_') || strategy === 'bullish' || strategy === 'bearish';
        if (isSnuggle) {
          flow.step = 'lower_ratio';
          const ratioLabel = strategy.startsWith('snuggle_up')
            ? '% of width below current price (default: <b>30</b> = 30% below / 70% above)'
            : '% of width above current price (default: <b>30</b> = 30% above / 70% below)';
          await this.bot.sendMessage(chatId, `✅ Trigger: <b>${trigger} ticks</b>\n\nEnter lower ratio — ${ratioLabel}:`, { parse_mode: 'HTML' });
          return;
        }

        flow.step = 'confirm_minutes';
        await this.bot.sendMessage(
          chatId,
          `✅ Trigger: <b>${trigger} ticks</b>\n\nEnter confirmation delay in minutes (default: <b>60</b>):\n<i>Position must stay out of range this long before rebalancing</i>`,
          { parse_mode: 'HTML' },
        );
        return;
      }

      case 'lower_ratio': {
        const ratio = parseInt(text);
        if (isNaN(ratio) || ratio < 0 || ratio > 100) {
          await this.bot.sendMessage(chatId, '❌ Lower ratio must be between 0 and 100. Try again:');
          return;
        }
        flow.data.lowerRatio = ratio;
        flow.step = 'confirm_minutes';
        await this.bot.sendMessage(
          chatId,
          `✅ Lower ratio: <b>${ratio}%</b>\n\nEnter confirmation delay in minutes (default: <b>60</b>):\n<i>Position must stay out of range this long before rebalancing</i>`,
          { parse_mode: 'HTML' },
        );
        return;
      }

      case 'confirm_minutes': {
        const minutes = parseInt(text);
        if (isNaN(minutes) || minutes < 0) {
          await this.bot.sendMessage(chatId, '❌ Confirm minutes must be a non-negative number. Try again:');
          return;
        }
        flow.data.confirmMinutes = minutes;

        // Custom wizard: prompt for cost-benefit gate before gauge/finalize
        if (flow.data.isCustomWizard) {
          flow.step = 'cost_benefit';
          await this.bot.sendMessage(
            chatId,
            `✅ Confirm: <b>${minutes} minutes</b>\n\nEnable cost-benefit gate? (skip rebalance if gas costs exceed fees)\nEnter <b>yes</b> or <b>no</b> (default: no):`,
            { parse_mode: 'HTML' },
          );
          return;
        }

        // For Aerodrome CL positions, offer optional gauge address
        const dexForGauge = flow.data.dex as string | undefined;
        if (dexForGauge === 'aerodrome-cl' || dexForGauge === 'aerodrome-cl-gc') {
          flow.step = 'gauge_address';
          await this.bot.sendMessage(
            chatId,
            `✅ Confirm: <b>${minutes} minutes</b>\n\nOptional: Enter CLGauge address for auto-stake (or type <b>skip</b>):\n<i>Find it on aerodrome.finance → pool page → gauge address</i>`,
            { parse_mode: 'HTML' },
          );
          return;
        }

        await this.finalizeNewPosition(chatId, flow, minutes);
        return;
      }

      case 'cost_benefit': {
        const answer = text.toLowerCase();
        const enabled = answer === 'yes' || answer === 'y' || answer === 'true' || answer === '1';
        flow.data.costBenefitEnabled = enabled;

        await this.bot.sendMessage(chatId, `✅ Cost-benefit gate: <b>${enabled ? 'enabled' : 'disabled'}</b>`, { parse_mode: 'HTML' });

        // Continue to gauge or finalize
        const dexForGauge2 = flow.data.dex as string | undefined;
        if (dexForGauge2 === 'aerodrome-cl' || dexForGauge2 === 'aerodrome-cl-gc') {
          flow.step = 'gauge_address';
          await this.bot.sendMessage(
            chatId,
            `Optional: Enter CLGauge address for auto-stake (or type <b>skip</b>):`,
            { parse_mode: 'HTML' },
          );
          return;
        }

        await this.finalizeNewPosition(chatId, flow, flow.data.confirmMinutes as number);
        return;
      }

      case 'gauge_address': {
        const confirmMinutes = flow.data.confirmMinutes as number;
        if (text.toLowerCase() === 'skip' || text === '-' || text === '0') {
          await this.finalizeNewPosition(chatId, flow, confirmMinutes);
          return;
        }
        if (!/^0x[0-9a-fA-F]{40}$/.test(text)) {
          await this.bot.sendMessage(chatId, '❌ Invalid address. Enter a 0x-prefixed 40-hex address, or type <b>skip</b>:', { parse_mode: 'HTML' });
          return;
        }
        flow.data.gaugeAddress = text;
        await this.finalizeNewPosition(chatId, flow, confirmMinutes);
        return;
      }
    }
  }

  private async finalizeNewPosition(chatId: number, flow: ActiveFlow, confirmMinutes: number): Promise<void> {
    const tokenId = flow.data.tokenId as number;
    const strategy = flow.data.strategy as StrategyType;
    const triggerDistance = flow.data.triggerDistance as number;

    const hasPresetWidth = PRESET_WIDTH_REGEX.test(strategy);

    const yamlParams: Record<string, unknown> = {
      trigger_distance_ticks: triggerDistance,
      confirm_minutes: confirmMinutes,
    };
    if (!hasPresetWidth && flow.data.widthTicks) {
      yamlParams.width_ticks = flow.data.widthTicks as number;
    }
    if (flow.data.lowerRatio !== undefined) {
      yamlParams.lower_ratio_percent = flow.data.lowerRatio as number;
    }
    if (flow.data.costBenefitEnabled) {
      yamlParams.cost_benefit_enabled = true;
      yamlParams.min_fee_to_cost_ratio = 1.5;
    }

    // Write to config.yaml atomically
    const yamlPath = resolve(process.cwd(), 'config.yaml');
    const yamlContent = readFileSync(yamlPath, 'utf-8');
    const parsed = parseYaml(yamlContent) as Record<string, unknown>;
    const positions = (parsed.positions as Record<string, unknown>[]) ?? [];

    // Build position entry for YAML — include chain_id/dex if set
    const yamlEntry: Record<string, unknown> = {
      token_id: tokenId,
      strategy,
      params: yamlParams,
    };
    const flowChainId = flow.data.chainId as number | undefined;
    const flowDex = flow.data.dex as string | undefined;
    if (flowChainId !== undefined) yamlEntry.chain_id = flowChainId;
    if (flowDex) yamlEntry.dex = flowDex;
    const flowGaugeAddress = flow.data.gaugeAddress as string | undefined;
    if (flowGaugeAddress) yamlEntry.gauge_address = flowGaugeAddress;

    positions.push(yamlEntry);
    parsed.positions = positions;

    const tempPath = resolve(process.cwd(), '.config.yaml.tmp');
    const yamlStr = stringifyYaml(parsed, { lineWidth: 120 });
    writeFileSync(tempPath, yamlStr, 'utf-8');
    renameSync(tempPath, yamlPath);

    // Build in-memory params
    const memParams: { width_ticks: number; trigger_distance_ticks: number; lower_ratio_percent?: number; confirm_minutes?: number; cost_benefit_enabled?: boolean; min_fee_to_cost_ratio?: number } = {
      width_ticks: hasPresetWidth ? 0 : ((flow.data.widthTicks as number) ?? 300),
      trigger_distance_ticks: triggerDistance,
    };
    if (flow.data.lowerRatio !== undefined) {
      memParams.lower_ratio_percent = flow.data.lowerRatio as number;
    }
    if (confirmMinutes > 0) {
      memParams.confirm_minutes = confirmMinutes;
    }
    if (flow.data.costBenefitEnabled) {
      memParams.cost_benefit_enabled = true;
      memParams.min_fee_to_cost_ratio = 1.5;
    }

    const posConfig: import('./types.js').PositionConfig = {
      token_id: tokenId,
      strategy: strategy as StrategyType,
      params: memParams,
    };
    if (flowChainId !== undefined) posConfig.chain_id = flowChainId;
    if (flowDex) posConfig.dex = flowDex;
    if (flowGaugeAddress) posConfig.gauge_address = flowGaugeAddress;

    this.context.config.positions.push(posConfig);

    this.activeFlow = null;

    logger.info('Position added via Telegram /new flow', {
      token_id: tokenId,
      strategy,
      triggerDistance,
      confirmMinutes,
      widthTicks: flow.data.widthTicks,
      lowerRatio: flow.data.lowerRatio,
      chain_id: flowChainId,
      dex: flowDex,
    });

    const widthInfo = hasPresetWidth
      ? (() => {
          const m = strategy.match(/_(\d+)(pct)?$/);
          return m?.[2] === 'pct' ? `preset width: ~${m[1]}%` : `preset width: ${m?.[1]} ticks`;
        })()
      : `width: ${(flow.data.widthTicks as number) ?? 300} ticks (~${ticksToPercentage((flow.data.widthTicks as number) ?? 300).toFixed(1)}%)`;

    // Resolve chain/DEX names for display
    const chainName = flowChainId !== undefined
      ? (CHAIN_REGISTRY[flowChainId]?.chainName ?? `Chain ${flowChainId}`)
      : undefined;
    const dexName = flowDex && flowChainId !== undefined
      ? getDexConfig(flowChainId, flowDex).protocolName
      : undefined;

    const lines = [
      `✅ <b>Position Added</b>`,
      ``,
      `• Token ID: <b>#${tokenId}</b>`,
    ];
    if (chainName) lines.push(`• Chain: <b>${chainName}</b>`);
    if (dexName) lines.push(`• DEX: <b>${dexName}</b>`);
    lines.push(
      `• Strategy: <b>${strategy}</b>`,
      `• ${widthInfo}`,
      `• Trigger distance: ${triggerDistance} ticks`,
      `• Confirm delay: ${confirmMinutes} min`,
    );
    if (flow.data.lowerRatio !== undefined) {
      lines.push(`• Lower ratio: ${flow.data.lowerRatio}%`);
    }
    lines.push(``, `<i>Position will be monitored on next cycle</i>`);

    await this.bot.sendMessage(chatId, lines.join('\n'), { parse_mode: 'HTML' });

    const notifLines = [
      `✅ *Position Added via Telegram*\n`,
      `• Token ID: #${tokenId}`,
    ];
    if (chainName) notifLines.push(`• Chain: ${chainName}`);
    if (dexName) notifLines.push(`• DEX: ${dexName}`);
    notifLines.push(
      `• Strategy: ${strategy}`,
      `• ${widthInfo}`,
      `• Trigger distance: ${triggerDistance} ticks`,
      `• Confirm delay: ${confirmMinutes} min`,
      ``,
      `_Position will be monitored on next cycle_`,
    );

    sendNotification(notifLines.join('\n'), this.context.config, 'info').catch(() => {});
  }

  // ============================================================
  // /config — Interactive Flow
  // ============================================================

  private async showConfigForPosition(chatId: number, entry: PositionPickerEntry): Promise<void> {
    const posConfig = this.context.config.positions[entry.posIndex];
    const lines = [
      `⚙️ <b>Position #${entry.tokenId} Configuration</b>`,
      '',
      `Strategy: <b>${posConfig.strategy}</b>`,
      `width_ticks: ${posConfig.params.width_ticks} (~${ticksToPercentage(posConfig.params.width_ticks).toFixed(1)}%)`,
      `trigger_distance_ticks: ${posConfig.params.trigger_distance_ticks} (~${ticksToPercentage(posConfig.params.trigger_distance_ticks).toFixed(2)}%)`,
    ];
    if (posConfig.params.lower_ratio_percent !== undefined) {
      const upper = 100 - posConfig.params.lower_ratio_percent;
      lines.push(`lower_ratio_percent: ${posConfig.params.lower_ratio_percent}% (${posConfig.params.lower_ratio_percent}% below / ${upper}% above)`);
    }
    if (posConfig.params.confirm_minutes !== undefined) {
      lines.push(`confirm_minutes: ${posConfig.params.confirm_minutes}`);
    }
    if (posConfig.params.critical_distance_ticks !== undefined && posConfig.params.critical_distance_ticks > 0) {
      lines.push(`critical_distance_ticks: ${posConfig.params.critical_distance_ticks} (~${ticksToPercentage(posConfig.params.critical_distance_ticks).toFixed(2)}%) — bypasses timer`);
    }
    lines.push(
      '',
      '<i>Reply with param=value to update</i>',
      '<i>e.g. width_ticks=400, width_percentage=5, trigger_percentage=0.5</i>',
      '<i>Send /cancel when done</i>',
    );

    this.activeFlow!.step = 'await_config_update';
    await this.bot.sendMessage(chatId, lines.join('\n'), { parse_mode: 'HTML' });
  }

  private async handleConfigFlowStep(msg: TelegramBot.Message): Promise<void> {
    const flow = this.activeFlow;
    if (!flow || !msg.text) return;

    const chatId = msg.chat.id;
    const text = msg.text.trim();

    // Handle /removestale confirmation
    if (flow.step === 'confirm_removestale') {
      if (text.toLowerCase() !== 'yes' && text.toLowerCase() !== 'y') {
        await this.bot.sendMessage(chatId, '❌ Cancelled.');
        this.activeFlow = null;
        return;
      }

      const staleIds = flow.data.staleIds as number[];
      this.activeFlow = null;

      // Capture chain IDs before removing from in-memory config (needed for posKey + clearSafeMode)
      const removedWithChain = this.context.config.positions
        .filter(p => staleIds.includes(p.token_id))
        .map(p => ({
          tokenId: p.token_id,
          chainId: p.chain_id ?? this.context.config.chain.chainId,
        }));

      // Remove from in-memory config
      this.context.config.positions = this.context.config.positions.filter(
        p => !staleIds.includes(p.token_id),
      );

      // Clear safe mode and auto-disabled state for removed positions
      for (const { tokenId, chainId } of removedWithChain) {
        clearSafeMode(posKey(chainId, tokenId));
        clearAutoDisabled(posKey(chainId, tokenId));
      }

      // Remove from config.yaml
      const yamlPath = resolve(process.cwd(), 'config.yaml');
      const yamlContent = readFileSync(yamlPath, 'utf-8');
      const parsed = parseYaml(yamlContent) as Record<string, unknown>;
      const yamlPositions = parsed.positions as Array<Record<string, unknown>>;
      parsed.positions = yamlPositions.filter(
        p => !staleIds.includes(p.token_id as number),
      );
      const tempPath = resolve(process.cwd(), '.config.yaml.tmp');
      writeFileSync(tempPath, stringifyYaml(parsed, { lineWidth: 120 }), 'utf-8');
      renameSync(tempPath, yamlPath);

      const remaining = this.context.config.positions.length;
      const lines = [
        `✅ <b>Removed ${staleIds.length} stale position(s):</b>`,
        ...staleIds.map(id => `• #${id}`),
        ``,
        `${remaining} position(s) remaining in config.`,
      ];

      await this.bot.sendMessage(chatId, lines.join('\n'), { parse_mode: 'HTML' });
      logger.info('Removed stale positions via /removestale', { staleIds });
      return;
    }

    if (flow.step !== 'await_config_update') return;

    const entries = flow.data.pickerEntries as PositionPickerEntry[];
    const entry = entries[flow.data.selectedIdx as number];
    const posConfig = this.context.config.positions[entry.posIndex];

    // Parse "param=value"
    const match = text.match(/^(\w+)\s*=\s*(.+)$/);
    if (!match) {
      await this.bot.sendMessage(chatId, '❌ Format: <code>param=value</code> (e.g. width_ticks=400, width_percentage=5)', { parse_mode: 'HTML' });
      return;
    }

    let key = match[1];
    const valueStr = match[2];

    // Handle gauge_address separately (string value, not numeric)
    if (key === 'gauge_address') {
      if (!/^0x[0-9a-fA-F]{40}$/.test(valueStr)) {
        await this.bot.sendMessage(chatId, '❌ gauge_address must be a valid 0x-prefixed 40-hex address');
        return;
      }
      if (posConfig.dex !== 'aerodrome-cl' && posConfig.dex !== 'aerodrome-cl-gc') {
        await this.bot.sendMessage(chatId, `❌ gauge_address is only supported for aerodrome-cl and aerodrome-cl-gc positions (current dex: ${posConfig.dex ?? 'default'})`);
        return;
      }
      const yamlPath = resolve(process.cwd(), 'config.yaml');
      const yamlContent = readFileSync(yamlPath, 'utf-8');
      const parsed = parseYaml(yamlContent) as Record<string, unknown>;
      const positions = parsed.positions as Array<Record<string, unknown>>;
      const rawPos = positions?.find(p => (p as Record<string, unknown>).token_id === entry.tokenId);
      if (!rawPos) { await this.bot.sendMessage(chatId, `❌ Position ${entry.tokenId} not found in YAML`); return; }
      rawPos.gauge_address = valueStr;
      const tempPath = resolve(process.cwd(), '.config.yaml.tmp');
      writeFileSync(tempPath, stringifyYaml(parsed, { lineWidth: 120 }), 'utf-8');
      renameSync(tempPath, yamlPath);
      posConfig.gauge_address = valueStr;
      reloadPositions(this.context.config);
      await this.bot.sendMessage(chatId, `✅ gauge_address set to <code>${valueStr}</code> for position #${entry.tokenId}`, { parse_mode: 'HTML' });
      this.activeFlow = null;
      return;
    }

    const value = parseFloat(valueStr);
    if (isNaN(value)) {
      await this.bot.sendMessage(chatId, `❌ Invalid number: "${valueStr}"`);
      return;
    }

    // Normalize key names
    if (key === 'lower_ratio') key = 'lower_ratio_percent';

    // Handle percentage inputs — convert to ticks
    if (key === 'width_percentage') {
      if (value <= 0) {
        await this.bot.sendMessage(chatId, '❌ width_percentage must be positive');
        return;
      }
      const ticks = percentageToTicks(value);
      // Apply as width_ticks
      key = 'width_ticks';
      // Continue with converted value
      const valueConverted = ticks;
      await this.applyConfigUpdate(chatId, flow, entry, posConfig, key, valueConverted, `width_percentage ${value}% → ${valueConverted} ticks`);
      return;
    }
    if (key === 'trigger_percentage') {
      if (value < 0) {
        await this.bot.sendMessage(chatId, '❌ trigger_percentage must be non-negative');
        return;
      }
      const ticks = percentageToTicks(value);
      key = 'trigger_distance_ticks';
      const valueConverted = ticks;
      await this.applyConfigUpdate(chatId, flow, entry, posConfig, key, valueConverted, `trigger_percentage ${value}% → ${valueConverted} ticks`);
      return;
    }

    // Validate
    const validKeys = ['width_ticks', 'trigger_distance_ticks', 'lower_ratio_percent', 'confirm_minutes', 'width_percentage', 'trigger_percentage', 'critical_distance_ticks', 'critical_percentage'];
    if (!validKeys.includes(key)) {
      await this.bot.sendMessage(chatId, `❌ Unknown param: "${key}"\nValid: ${validKeys.join(', ')}, gauge_address`);
      return;
    }
    if (key === 'width_ticks' && value <= 0) {
      await this.bot.sendMessage(chatId, '❌ width_ticks must be positive');
      return;
    }
    if (key === 'trigger_distance_ticks' && value < 0) {
      await this.bot.sendMessage(chatId, '❌ trigger_distance_ticks must be non-negative');
      return;
    }
    if (key === 'lower_ratio_percent' && (value < 0 || value > 100)) {
      await this.bot.sendMessage(chatId, '❌ lower_ratio_percent must be 0-100');
      return;
    }
    if (key === 'confirm_minutes' && value < 0) {
      await this.bot.sendMessage(chatId, '❌ confirm_minutes must be non-negative');
      return;
    }
    if (key === 'critical_distance_ticks' && value < 0) {
      await this.bot.sendMessage(chatId, '❌ critical_distance_ticks must be non-negative');
      return;
    }
    if (key === 'critical_percentage' && value < 0) {
      await this.bot.sendMessage(chatId, '❌ critical_percentage must be non-negative');
      return;
    }

    await this.applyConfigUpdate(chatId, flow, entry, posConfig, key, value);
  }

  private async applyConfigUpdate(
    chatId: number,
    _flow: ActiveFlow,
    entry: PositionPickerEntry,
    posConfig: import('./types.js').PositionConfig,
    key: string,
    value: number,
    displayLabel?: string,
  ): Promise<void> {
    // Apply to YAML
    const yamlPath = resolve(process.cwd(), 'config.yaml');
    const yamlContent = readFileSync(yamlPath, 'utf-8');
    const parsed = parseYaml(yamlContent) as Record<string, unknown>;
    const positions = parsed.positions as Array<Record<string, unknown>>;
    const rawPos = positions?.find(p => (p as Record<string, unknown>).token_id === entry.tokenId);
    if (!rawPos) throw new Error(`Position ${entry.tokenId} not found in YAML`);

    const rawParams = (rawPos.params as Record<string, unknown>) ?? {};
    const oldValue = (rawParams[key] as number) ?? 0;
    rawParams[key] = value;
    rawPos.params = rawParams;

    // Update in-memory config
    if (key === 'width_ticks') posConfig.params.width_ticks = value;
    else if (key === 'trigger_distance_ticks') posConfig.params.trigger_distance_ticks = value;
    else if (key === 'lower_ratio_percent') posConfig.params.lower_ratio_percent = value;
    else if (key === 'confirm_minutes') posConfig.params.confirm_minutes = value;
    else if (key === 'critical_distance_ticks') posConfig.params.critical_distance_ticks = value;
    else if (key === 'critical_percentage') {
      posConfig.params.critical_percentage = value;
      posConfig.params.critical_distance_ticks = percentageToTicks(value);
    }

    // Atomic write
    const tempPath = resolve(process.cwd(), '.config.yaml.tmp');
    const yamlStr = stringifyYaml(parsed, { lineWidth: 120 });
    writeFileSync(tempPath, yamlStr, 'utf-8');
    renameSync(tempPath, yamlPath);

    const label = displayLabel ?? `${key} ${oldValue} → ${value}`;
    await this.bot.sendMessage(
      chatId,
      `✅ <b>#${entry.tokenId}</b>: ${label}\n\n<i>Send another param=value or /cancel when done</i>`,
      { parse_mode: 'HTML' },
    );
    logger.info('Config updated via Telegram', { tokenId: entry.tokenId, key, oldValue, value });
  }

  // ============================================================
  // /collect — Collect Fees Flow
  // ============================================================

  private async showCollectConfirm(chatId: number, entry: PositionPickerEntry): Promise<void> {
    const totalFeeUsd = entry.fee0Usd + entry.fee1Usd;

    if (totalFeeUsd < 0.01 && entry.fee0 === 0 && entry.fee1 === 0) {
      this.activeFlow = null;
      await this.bot.sendMessage(chatId, `✅ Position #${entry.tokenId} has no unclaimed fees to collect.`);
      return;
    }

    const lines = [
      `💰 <b>Collect Fees — #${entry.tokenId}</b>`,
      `${entry.pair}`,
      ``,
      `<b>Unclaimed fees:</b>`,
      `• ${formatToken(entry.fee0, 2)} ${entry.token0Symbol} (${formatUsd(entry.fee0Usd)})`,
      `• ${formatToken(entry.fee1, 2)} ${entry.token1Symbol} (${formatUsd(entry.fee1Usd)})`,
      `• Total: ${formatUsd(totalFeeUsd)}`,
    ];

    if (this.context.config.dry_run) {
      lines.push(``, `⚠️ <i>Dry run mode — no transaction will execute</i>`);
    }

    lines.push(``, `Reply <b>yes</b> to confirm or /cancel to abort.`);

    await this.bot.sendMessage(chatId, lines.join('\n'), { parse_mode: 'HTML' });
  }

  private async handleCollectFlowStep(msg: TelegramBot.Message): Promise<void> {
    const flow = this.activeFlow;
    if (!flow || !msg.text) return;

    const chatId = msg.chat.id;
    const text = msg.text.trim().toLowerCase();

    if (flow.step !== 'confirm_collect') return;

    if (text !== 'yes' && text !== 'y') {
      await this.bot.sendMessage(chatId, '❌ Cancelled. Send /collect to start again.');
      this.activeFlow = null;
      return;
    }

    if (this.context.config.dry_run) {
      this.activeFlow = null;
      await this.bot.sendMessage(chatId, '🧪 <b>Dry run</b> — would have collected fees. Disable dry_run to execute.', { parse_mode: 'HTML' });
      return;
    }

    const entries = flow.data.pickerEntries as PositionPickerEntry[];
    const entry = entries[flow.data.selectedIdx as number];

    await this.bot.sendMessage(chatId, '⏳ Collecting fees on-chain...');
    this.activeFlow = null;

    try {
      const result = await collectFees(entry.tokenId, this.getContractsForPosition(entry.tokenId), this.getChainForPosition(entry.tokenId));

      const d0 = entry.status.token0Info.decimals;
      const d1 = entry.status.token1Info.decimals;
      const amt0 = Number(result.amount0) / 10 ** d0;
      const amt1 = Number(result.amount1) / 10 ** d1;

      const message = [
        `✅ <b>Fees Collected — #${entry.tokenId}</b>`,
        ``,
        `• ${formatToken(amt0, d0)} ${entry.token0Symbol}`,
        `• ${formatToken(amt1, d1)} ${entry.token1Symbol}`,
        ``,
        `Tx: <code>${result.txHash}</code>`,
      ].join('\n');

      await this.bot.sendMessage(chatId, message, { parse_mode: 'HTML' });
      logger.info('Fees collected via Telegram /collect', { tokenId: entry.tokenId, txHash: result.txHash });
    } catch (error) {
      const errMsg = (error as Error).message;
      logger.error('Error collecting fees via Telegram', { tokenId: entry.tokenId, error: errMsg });
      await this.bot.sendMessage(chatId, `❌ Fee collection failed: ${errMsg}`);
    }
  }

  // ============================================================
  // /remove — Remove Liquidity Flow
  // ============================================================

  private async showRemovePercentChoice(chatId: number, entry: PositionPickerEntry): Promise<void> {
    const lines = [
      `🗑️ <b>Remove Liquidity — #${entry.tokenId}</b>`,
      `${entry.pair} — ${formatUsd(entry.totalValueUsd)}`,
      ``,
      `How much liquidity to remove?`,
      ``,
      `  <b>1.</b> 25%`,
      `  <b>2.</b> 50%`,
      `  <b>3.</b> 100% (full removal + burn NFT)`,
      ``,
      `Reply with a number (1-3) or enter a custom % (e.g. 75):`,
    ];

    if (this.context.config.dry_run) {
      lines.push(``, `⚠️ <i>Dry run mode — no transaction will execute</i>`);
    }

    await this.bot.sendMessage(chatId, lines.join('\n'), { parse_mode: 'HTML' });
  }

  private async handleRemoveFlowStep(msg: TelegramBot.Message): Promise<void> {
    const flow = this.activeFlow;
    if (!flow || !msg.text) return;

    const chatId = msg.chat.id;
    const text = msg.text.trim().toLowerCase();
    const entries = flow.data.pickerEntries as PositionPickerEntry[];
    const entry = entries[flow.data.selectedIdx as number];

    if (flow.step === 'choose_percent') {
      let pct: number;
      const presets: Record<string, number> = { '1': 25, '2': 50, '3': 100 };
      if (presets[text]) {
        pct = presets[text];
      } else {
        pct = parseFloat(text);
        if (isNaN(pct) || pct <= 0 || pct > 100) {
          await this.bot.sendMessage(chatId, '❌ Enter a number between 1 and 100:');
          return;
        }
      }

      flow.data.removePct = pct;

      // Preview
      const status = entry.status;
      const liquidity = status.position.liquidity;
      const liquidityToRemove = pct === 100 ? liquidity : (liquidity * BigInt(Math.round(pct * 100))) / 10000n;

      const sqrtPriceAX96 = tickToSqrtPriceX96(status.position.tickLower);
      const sqrtPriceBX96 = tickToSqrtPriceX96(status.position.tickUpper);
      const expected = getAmountsForLiquidity(status.pool.sqrtPriceX96, sqrtPriceAX96, sqrtPriceBX96, liquidityToRemove);

      const d0 = status.token0Info.decimals;
      const d1 = status.token1Info.decimals;
      const exp0 = Number(expected.amount0) / 10 ** d0;
      const exp1 = Number(expected.amount1) / 10 ** d1;

      const lines = [
        `🗑️ <b>Remove ${pct}% — #${entry.tokenId}</b>`,
        ``,
        `<b>Expected withdrawal:</b>`,
        `• ~${formatToken(exp0, d0)} ${entry.token0Symbol}`,
        `• ~${formatToken(exp1, d1)} ${entry.token1Symbol}`,
      ];

      if (pct === 100) {
        lines.push(``, `⚠️ Full removal will <b>burn the NFT</b> and remove the position from config.`);
      }

      lines.push(``, `Reply <b>yes</b> to confirm or /cancel to abort.`);

      flow.step = 'confirm_remove';
      await this.bot.sendMessage(chatId, lines.join('\n'), { parse_mode: 'HTML' });
      return;
    }

    if (flow.step === 'confirm_remove') {
      if (text !== 'yes' && text !== 'y') {
        await this.bot.sendMessage(chatId, '❌ Cancelled. Send /remove to start again.');
        this.activeFlow = null;
        return;
      }

      if (this.context.config.dry_run) {
        this.activeFlow = null;
        await this.bot.sendMessage(chatId, '🧪 <b>Dry run</b> — would have removed liquidity. Disable dry_run to execute.', { parse_mode: 'HTML' });
        return;
      }

      const pct = flow.data.removePct as number;
      const status = entry.status;
      const liquidity = status.position.liquidity;
      const liquidityToRemove = pct === 100 ? liquidity : (liquidity * BigInt(Math.round(pct * 100))) / 10000n;

      await this.bot.sendMessage(chatId, `⏳ Removing ${pct}% liquidity on-chain...`);
      this.activeFlow = null;

      try {
        const result = await removeLiquidity(
          entry.tokenId,
          liquidityToRemove,
          status.pool.sqrtPriceX96,
          status.position.tickLower,
          status.position.tickUpper,
          this.context.config.slippage_tolerance_bps,
          this.getContractsForPosition(entry.tokenId),
          this.getChainForPosition(entry.tokenId),
        );

        const d0 = status.token0Info.decimals;
        const d1 = status.token1Info.decimals;
        const amt0 = Number(result.amount0) / 10 ** d0;
        const amt1 = Number(result.amount1) / 10 ** d1;

        const lines = [
          `✅ <b>Liquidity Removed — #${entry.tokenId} (${pct}%)</b>`,
          ``,
          `• ${formatToken(amt0, d0)} ${entry.token0Symbol}`,
          `• ${formatToken(amt1, d1)} ${entry.token1Symbol}`,
          ``,
          `Decrease tx: <code>${result.decreaseTxHash}</code>`,
          `Collect tx: <code>${result.collectTxHash}</code>`,
        ];

        if (pct === 100) {
          lines.push(`Burn tx: <code>${result.burnTxHash}</code>`);

          // Remove from config
          const posIndex = this.context.config.positions.findIndex(p => p.token_id === entry.tokenId);
          if (posIndex !== -1) {
            this.context.config.positions.splice(posIndex, 1);

            // Update YAML
            const yamlPath = resolve(process.cwd(), 'config.yaml');
            const yamlContent = readFileSync(yamlPath, 'utf-8');
            const parsed = parseYaml(yamlContent) as Record<string, unknown>;
            const yamlPositions = parsed.positions as Array<Record<string, unknown>>;
            parsed.positions = yamlPositions.filter(p => (p as Record<string, unknown>).token_id !== entry.tokenId);
            const tempPath = resolve(process.cwd(), '.config.yaml.tmp');
            writeFileSync(tempPath, stringifyYaml(parsed, { lineWidth: 120 }), 'utf-8');
            renameSync(tempPath, yamlPath);

            lines.push(``, `🗑️ Position removed from config. NFT burned.`);
          }
        }

        await this.bot.sendMessage(chatId, lines.join('\n'), { parse_mode: 'HTML' });
        logger.info('Liquidity removed via Telegram /remove', { tokenId: entry.tokenId, pct });
      } catch (error) {
        const errMsg = (error as Error).message;
        logger.error('Error removing liquidity via Telegram', { tokenId: entry.tokenId, error: errMsg });
        await this.bot.sendMessage(chatId, `❌ Remove failed: ${errMsg}`);
      }
    }
  }

  // ============================================================
  // /rebalance — Force Manual Rebalance Flow
  // ============================================================

  private async showRebalanceConfirm(chatId: number, entry: PositionPickerEntry): Promise<void> {
    const status = entry.status;
    const { pool, token0Info, token1Info } = status;
    const currentPrice = tickToPrice(pool.currentTick, token0Info.decimals, token1Info.decimals);
    const posConfig = this.context.config.positions[entry.posIndex];

    // Compute new range using strategy
    const decision = evaluateStrategy(status, posConfig);
    const tickSpacing = getTickSpacing(status.position.fee);
    const widthTicks = posConfig.params.width_ticks ?? 300;
    let newTickLower: number;
    let newTickUpper: number;
    if (decision.newTickLower !== undefined && decision.newTickUpper !== undefined) {
      newTickLower = decision.newTickLower;
      newTickUpper = decision.newTickUpper;
    } else {
      // Centered on current tick
      const halfWidth = Math.floor(widthTicks / 2);
      newTickLower = nearestUsableTick(pool.currentTick - halfWidth, tickSpacing);
      newTickUpper = nearestUsableTick(pool.currentTick + halfWidth, tickSpacing);
    }

    const newPriceLower = tickToPrice(newTickLower, token0Info.decimals, token1Info.decimals);
    const newPriceUpper = tickToPrice(newTickUpper, token0Info.decimals, token1Info.decimals);

    // Estimate swap needed
    let swapLine = '';
    try {
      const tokenAddresses = [status.position.token0, status.position.token1];
      const priceMap = await getTokenPrices(tokenAddresses).catch(() => new Map<string, number>());
      const price0 = priceMap.get(status.position.token0.toLowerCase()) ?? 0;
      const price1 = priceMap.get(status.position.token1.toLowerCase()) ?? 0;
      if (price0 > 0 || price1 > 0) {
        const sqrtCurrent = tickToSqrtPriceX96(pool.currentTick);
        const sqrtA = tickToSqrtPriceX96(newTickLower);
        const sqrtB = tickToSqrtPriceX96(newTickUpper);
        const refLiq = 1n << 96n;
        const target = getAmountsForLiquidity(sqrtCurrent, sqrtA, sqrtB, refLiq);
        const targetVal0 = (Number(target.amount0) / 10 ** token0Info.decimals) * price0;
        const targetVal1 = (Number(target.amount1) / 10 ** token1Info.decimals) * price1;
        const targetTotal = targetVal0 + targetVal1;
        const val0 = (Number(status.amount0) / 10 ** token0Info.decimals) * price0;
        const val1 = (Number(status.amount1) / 10 ** token1Info.decimals) * price1;
        const totalVal = val0 + val1;
        if (totalVal > 0 && targetTotal > 0) {
          const targetFrac0 = targetVal0 / targetTotal;
          const currentFrac0 = val0 / totalVal;
          const diff = Math.abs(currentFrac0 - targetFrac0) * totalVal;
          const swapSymbol = currentFrac0 > targetFrac0 ? token0Info.symbol : token1Info.symbol;
          const swapPct = (diff / totalVal) * 100;
          swapLine = `• Est. swap: ~${formatUsd(diff)} of ${swapSymbol} (${swapPct.toFixed(1)}%)`;
        }
      }
    } catch { /* swap estimate optional */ }

    const lines = [
      `🔄 <b>Force Rebalance — #${entry.tokenId}</b>`,
      `${entry.pair} — ${formatUsd(entry.totalValueUsd)}`,
      ``,
      `<b>Current:</b>`,
      `• Price: ${formatNum(currentPrice)} ${token1Info.symbol}/${token0Info.symbol}`,
      `• Status: ${entry.isInRange ? '🟢 IN RANGE' : '🔴 OUT OF RANGE'}`,
      `• Range: [${status.position.tickLower} → ${status.position.tickUpper}]`,
      ``,
      `<b>New Range:</b>`,
      `• Ticks: [${newTickLower} → ${newTickUpper}]`,
      `• Price: ${formatNum(newPriceLower)} – ${formatNum(newPriceUpper)} ${token1Info.symbol}/${token0Info.symbol}`,
      ...(swapLine ? [swapLine] : []),
      ``,
      `Steps: collect fees → remove liquidity → swap → mint`,
      ``,
      `⚠️ Bypasses cooldown and confirmation timer.`,
    ];

    if (this.context.config.dry_run) {
      lines.push(``, `⚠️ <i>Dry run mode — no transaction will execute</i>`);
    }

    lines.push(``, `Reply <b>yes</b> to confirm or /cancel to abort.`);

    await this.bot.sendMessage(chatId, lines.join('\n'), { parse_mode: 'HTML' });
  }

  private async handleRebalanceFlowStep(msg: TelegramBot.Message): Promise<void> {
    const flow = this.activeFlow;
    if (!flow || !msg.text) return;

    const chatId = msg.chat.id;
    const text = msg.text.trim().toLowerCase();

    if (flow.step !== 'confirm_rebalance') return;

    if (text !== 'yes' && text !== 'y') {
      await this.bot.sendMessage(chatId, '❌ Cancelled. Send /rebalance to start again.');
      this.activeFlow = null;
      return;
    }

    if (this.context.config.dry_run) {
      this.activeFlow = null;
      await this.bot.sendMessage(chatId, '🧪 <b>Dry run</b> — would have rebalanced. Disable dry_run to execute.', { parse_mode: 'HTML' });
      return;
    }

    const entries = flow.data.pickerEntries as PositionPickerEntry[];
    const entry = entries[flow.data.selectedIdx as number];
    const posConfig = this.context.config.positions[entry.posIndex];

    await this.bot.sendMessage(chatId, '⏳ Executing force rebalance... This may take 30-60 seconds.');
    this.activeFlow = null;

    try {
      const result = await checkAndRebalance(
        posConfig,
        this.context.config,
        this.getContractsForPosition(posConfig.token_id),
        this.getChainForPosition(posConfig.token_id),
        null, // analyticsCollector
        true, // force
      );

      if (!result) {
        await this.bot.sendMessage(chatId, '⚠️ Rebalance did not execute. This may be due to zero liquidity or ownership issue. Check logs.');
        return;
      }

      if (!result.success) {
        await this.bot.sendMessage(chatId, `❌ Rebalance failed: ${result.error ?? 'Unknown error'}\n\nCheck server logs for details.`);
        return;
      }

      const lines = [
        `✅ <b>Rebalance Complete — #${result.oldTokenId} → #${result.newTokenId}</b>`,
        ``,
      ];

      if (result.newPosition) {
        lines.push(`New position: <b>#${result.newTokenId}</b>`);
        lines.push(`Liquidity: ${result.newPosition.liquidity.toString()}`);
        lines.push(`Tx: <code>${result.newPosition.txHash}</code>`);
      }

      if (result.swapExecuted) {
        const swapAmt = ethers.formatUnits(result.swapExecuted.amountIn, 18);
        lines.push(``, `Swap: ${parseFloat(swapAmt).toFixed(4)} (${result.swapExecuted.txHash.slice(0, 10)}...)`);
      }

      await this.bot.sendMessage(chatId, lines.join('\n'), { parse_mode: 'HTML' });
      logger.info('Force rebalance via Telegram /rebalance', { tokenId: entry.tokenId, newTokenId: result.newTokenId });
    } catch (error) {
      const errMsg = (error as Error).message;
      logger.error('Error in force rebalance via Telegram', { tokenId: entry.tokenId, error: errMsg });
      await this.bot.sendMessage(chatId, `❌ Rebalance error: ${errMsg}\n\nCheck server logs for full details.`);
    }
  }

  // ============================================================
  // /removestale — Remove stale (burned/invalid) positions from config
  // ============================================================

  private async handleRemoveStale(msg: TelegramBot.Message): Promise<void> {
    const chatId = msg.chat.id;
    const positions = this.context.config.positions;

    if (positions.length === 0) {
      await this.bot.sendMessage(chatId, 'No positions configured.');
      return;
    }

    await this.bot.sendMessage(chatId, `🔍 Checking ${positions.length} position(s) on-chain...`);

    const staleIds: number[] = [];
    const aliveIds: number[] = [];

    for (const pos of positions) {
      try {
        await getPositionStatus(pos.token_id, this.getContractsForPosition(pos.token_id), this.getChainForPosition(pos.token_id));
        aliveIds.push(pos.token_id);
      } catch (error: unknown) {
        const err = error as { code?: string; message?: string };
        if (err.code === 'CALL_EXCEPTION') {
          staleIds.push(pos.token_id);
        } else {
          // RPC error — don't mark as stale, could be transient
          aliveIds.push(pos.token_id);
          logger.warn('RPC error checking position, not marking as stale', { tokenId: pos.token_id, error: err.message });
        }
      }
    }

    if (staleIds.length === 0) {
      await this.bot.sendMessage(chatId, `✅ All ${positions.length} position(s) are valid on-chain. Nothing to remove.`);
      return;
    }

    const lines = [
      `⚠️ <b>Found ${staleIds.length} stale position(s):</b>`,
      ``,
      ...staleIds.map(id => `• #${id} — NFT no longer exists on-chain`),
      ``,
      `Healthy: ${aliveIds.map(id => `#${id}`).join(', ') || 'none'}`,
      ``,
      `Reply <b>yes</b> to remove stale positions from config, or /cancel.`,
    ];

    this.activeFlow = {
      type: 'config', // reuse config flow type since we don't need a new FlowType
      step: 'confirm_removestale',
      data: { staleIds },
      startedAt: Date.now(),
    };

    await this.bot.sendMessage(chatId, lines.join('\n'), { parse_mode: 'HTML' });
  }

  // ============================================================
  // /chain — Position lineage chain view
  // ============================================================

  private async handleChain(msg: TelegramBot.Message): Promise<void> {
    try {
      const positions = this.context.config.positions;
      if (positions.length === 0) {
        await this.bot.sendMessage(msg.chat.id, '⚠️ No positions configured');
        return;
      }

      await this.bot.sendMessage(msg.chat.id, '⏳ Building position chain...');

      const storagePath = this.context.config.analytics?.storage_path ?? './analytics';

      for (const posConfig of positions) {
        const chain = await buildPositionChain(posConfig.token_id, storagePath);
        if (!chain) {
          await this.bot.sendMessage(
            msg.chat.id,
            `⚠️ Position #${posConfig.token_id}: No chain data found`,
          );
          continue;
        }

        const agg = chain.aggregate;
        const durationDays = agg.totalDurationMs / (1000 * 86400);

        const lines: string[] = [
          `🔗 <b>Position Chain #${chain.currentTokenId}</b>`,
          `Root: #${chain.rootTokenId} → Current: #${chain.currentTokenId}`,
          ``,
          `<b>Lifetime Summary:</b>`,
          `• Rebalances: ${agg.totalRebalances}`,
          `• Duration: ${durationDays.toFixed(1)} days`,
          `• Avg Time in Range: ${agg.avgTimeInRangePercent.toFixed(1)}%`,
          `• Avg Fee APR: ${agg.avgFeeAPR.toFixed(1)}%`,
          `• Cumulative Net ROI: ${agg.cumulativeNetROIPercent.toFixed(3)}%`,
          `• Total Gas: ${agg.totalGasCostPLS.toFixed(2)} PLS`,
          `• Avg Exec Delta: ${agg.avgExecDeltaBps.toFixed(0)} bps`,
          ``,
          `<b>Chain Links:</b>`,
        ];

        for (const link of chain.links) {
          const isActive = link.burnTimestamp === null;
          const linkDuration = link.durationMs / (1000 * 3600);
          const icon = isActive ? '🟢' : '⬜';
          if (link.isManualLink) {
            lines.push(
              `${icon} <b>#${link.tokenId}</b> [MANUAL LINK]`,
              `  Linked manually — no execution data`,
            );
          } else {
            lines.push(
              `${icon} <b>#${link.tokenId}</b> (${link.strategy})`,
              `  Range: [${link.tickLower}, ${link.tickUpper}] (${link.widthTicks} ticks)`,
              `  Duration: ${linkDuration.toFixed(1)}h | In Range: ${link.timeInRangePercent.toFixed(0)}%`,
              `  APR: ${link.feeAPR.toFixed(1)}% | Gas: ${link.gasCostPLS.toFixed(2)} PLS${link.rebalanceCostPercent > 0 ? ` | Exec: ${link.rebalanceCostPercent.toFixed(2)}%` : ''}`,
            );
          }
        }

        await this.bot.sendMessage(msg.chat.id, lines.join('\n'), { parse_mode: 'HTML' });
      }

      logger.info('Telegram /chain command executed');
    } catch (error) {
      logger.error('Error handling /chain command', { error: (error as Error).message });
      await this.bot.sendMessage(msg.chat.id, '❌ Error building chain. Check logs.');
    }
  }

  // ============================================================
  // /link — manually link two positions in a chain
  // ============================================================

  private async handleLink(msg: TelegramBot.Message, args: string): Promise<void> {
    try {
      const parts = args.trim().split(/\s+/);
      if (parts.length < 2) {
        await this.bot.sendMessage(
          msg.chat.id,
          '⚠️ Usage: /link &lt;oldTokenId&gt; &lt;newTokenId&gt; [note]\n\nExample: /link 155290 155806 manual redeploy',
          { parse_mode: 'HTML' },
        );
        return;
      }

      const oldTokenId = parseInt(parts[0], 10);
      const newTokenId = parseInt(parts[1], 10);
      const note = parts.slice(2).join(' ') || undefined;

      if (isNaN(oldTokenId) || oldTokenId <= 0 || isNaN(newTokenId) || newTokenId <= 0) {
        await this.bot.sendMessage(msg.chat.id, '❌ Both token IDs must be positive numbers');
        return;
      }
      if (oldTokenId === newTokenId) {
        await this.bot.sendMessage(msg.chat.id, '❌ Token IDs must be different');
        return;
      }

      const storagePath = this.context.config.analytics?.storage_path ?? './analytics';
      const oldPos = this.context.config.positions.find((position) => position.token_id === oldTokenId);
      const newPos = this.context.config.positions.find((position) => position.token_id === newTokenId);
      const chainId = oldPos && this.context.multiChain
        ? this.context.multiChain.resolveChainId(oldPos)
        : newPos && this.context.multiChain
          ? this.context.multiChain.resolveChainId(newPos)
          : this.context.config.chain.chainId;
      const oldDex = oldPos?.dex;
      const newDex = newPos?.dex;
      if (oldDex !== undefined && newDex !== undefined && oldDex !== newDex) {
        await this.bot.sendMessage(msg.chat.id, '❌ Manual links cannot span different DEX contexts');
        return;
      }
      await writeManualLink(resolveStoragePath(storagePath, chainId), {
        oldTokenId,
        newTokenId,
        chainId,
        dex: oldDex ?? newDex,
        createdAt: Date.now(),
        note,
      });

      await this.bot.sendMessage(
        msg.chat.id,
        `✅ Linked <b>#${oldTokenId}</b> → <b>#${newTokenId}</b> (manual link)${note ? `\n📝 ${note}` : ''}`,
        { parse_mode: 'HTML' },
      );
      logger.info('Telegram /link command executed', { oldTokenId, newTokenId, note });
    } catch (error) {
      const errMsg = (error as Error).message;
      if (errMsg.includes('already exists')) {
        await this.bot.sendMessage(msg.chat.id, `⚠️ ${errMsg}`);
      } else {
        logger.error('Error handling /link command', { error: errMsg });
        await this.bot.sendMessage(msg.chat.id, '❌ Error creating link. Check logs.');
      }
    }
  }

  // ============================================================
  // /scan — discover wallet positions across all chains
  // ============================================================

  private async handleScan(msg: TelegramBot.Message): Promise<void> {
    const chatId = msg.chat.id;

    if (!this.context.multiChain) {
      await this.bot.sendMessage(chatId, '⚠️ Multi-chain context not available. Cannot scan.');
      return;
    }

    const chainIds = this.context.multiChain.getChainIds();
    const chainCount = chainIds.length;
    let dexCount = 0;
    for (const cid of chainIds) {
      dexCount += Math.max(1, getSupportedDexes(cid).length);
    }

    await this.bot.sendMessage(
      chatId,
      `⏳ Scanning wallet across ${chainCount} chain(s) (${dexCount} DEXes)...`,
    );

    try {
      const { positions: discovered, failedChainIds }: DiscoverResult = await discoverWalletPositions(this.context.multiChain);

      // Filter out positions already in config
      const configuredIds = new Set(
        this.context.config.positions.map(p => `${p.chain_id ?? this.context.multiChain!.defaultChainId}-${p.token_id}`),
      );
      const unconfigured = discovered.filter(
        d => !configuredIds.has(`${d.chainId}-${d.tokenId}`),
      );

      // Surface any chain-level scan failures to the user
      if (failedChainIds.length > 0) {
        const failedNames = failedChainIds.map(id => CHAIN_REGISTRY[id]?.chainName ?? `Chain ${id}`).join(', ');
        await this.bot.sendMessage(chatId, `⚠️ Scan failed for: ${failedNames}. Results may be incomplete.`);
      }

      if (unconfigured.length === 0) {
        const totalMsg = discovered.length > 0
          ? `Found ${discovered.length} position(s), all already configured.`
          : 'No positions found in wallet on any chain.';
        await this.bot.sendMessage(chatId, `✅ ${totalMsg}`);
        return;
      }

      // Display unconfigured positions
      const lines = [
        `🔍 <b>Found ${unconfigured.length} unconfigured position(s):</b>`,
        ``,
      ];
      for (let i = 0; i < unconfigured.length; i++) {
        const p = unconfigured[i];
        const chainName = CHAIN_REGISTRY[p.chainId]?.chainName ?? `Chain ${p.chainId}`;
        const usesTickSpacing = p.dexName.startsWith('aerodrome') || p.dexName.startsWith('algebra');
        const feeLabel = usesTickSpacing ? `tick spacing ${p.fee}` : `fee ${p.fee}`;
        lines.push(
          `  <b>${i + 1}.</b> #${p.tokenId} — ${p.token0Symbol}/${p.token1Symbol} (${feeLabel})`,
          `     ${chainName} • ${p.protocolName}`,
          ``,
        );
      }
      lines.push(`Reply with a number to add, or /cancel:`);

      // Start scan flow
      this.activeFlow = {
        type: 'scan',
        step: 'pick',
        data: { discovered: unconfigured },
        startedAt: Date.now(),
      };

      await this.bot.sendMessage(chatId, lines.join('\n'), { parse_mode: 'HTML' });
      logger.info('Telegram /scan found unconfigured positions', { count: unconfigured.length });
    } catch (error) {
      logger.error('Error during /scan', { error: (error as Error).message });
      await this.bot.sendMessage(chatId, `❌ Scan failed: ${(error as Error).message}`);
    }
  }

  private async handleScanFlowStep(msg: TelegramBot.Message): Promise<void> {
    const flow = this.activeFlow;
    if (!flow || !msg.text) return;

    const chatId = msg.chat.id;
    const text = msg.text.trim();

    if (flow.step === 'pick') {
      const discovered = flow.data.discovered as DiscoveredPosition[];
      const choice = parseInt(text);
      if (isNaN(choice) || choice < 1 || choice > discovered.length) {
        await this.bot.sendMessage(chatId, `❌ Enter a number between 1 and ${discovered.length}:`);
        return;
      }

      const selected = discovered[choice - 1];
      const chainName = CHAIN_REGISTRY[selected.chainId]?.chainName ?? `Chain ${selected.chainId}`;

      // Pre-populate flow data and offer default vs custom setup
      flow.data.tokenId = selected.tokenId;
      flow.data.chainId = selected.chainId;
      flow.data.dex = selected.dexName;
      flow.step = 'setup_mode';

      await this.bot.sendMessage(chatId, [
        `✅ Selected: <b>#${selected.tokenId}</b> — ${selected.token0Symbol}/${selected.token1Symbol}`,
        `   Chain: <b>${chainName}</b>`,
        `   DEX: <b>${selected.protocolName}</b>`,
        ``,
        `How would you like to configure this position?`,
        ``,
        `  <b>1.</b> Default Settings`,
        `       center_3pct • trigger: 50 ticks • confirm: 60 min`,
        ``,
        `  <b>2.</b> Custom Setup`,
        `       Choose strategy, width, trigger, and more`,
      ].join('\n'), { parse_mode: 'HTML' });
      return;
    }

    if (flow.step === 'setup_mode') {
      const choice = parseInt(text);
      if (choice !== 1 && choice !== 2) {
        await this.bot.sendMessage(chatId, `❌ Please enter <b>1</b> for Default Settings or <b>2</b> for Custom Setup:`, { parse_mode: 'HTML' });
        return;
      }

      if (choice === 1) {
        // Apply defaults and finalize immediately
        flow.data.strategy = 'center_3pct';
        flow.data.triggerDistance = 50;
        flow.step = 'strategy'; // mark as past strategy so finalizeNewPosition context is correct
        await this.finalizeNewPosition(chatId, flow, 60);
        return;
      }

      // choice === 2: proceed to full strategy menu
      flow.step = 'strategy';
      await this.showStrategyMenu(chatId, flow.data.tokenId as number);
      return;
    }

    // After 'setup_mode' → 'strategy', reuse the /new flow steps
    await this.handleNewFlowStep(msg);
  }


  // ============================================================
  // /help
  // ============================================================

  // ============================================================
  // /alerts — view and toggle notification preferences
  // ============================================================

  private static readonly ALERT_CATEGORIES: { key: NotificationCategory; label: string }[] = [
    { key: 'rebalance_success', label: 'Rebalance Success' },
    { key: 'rebalance_failure', label: 'Rebalance Failure' },
    { key: 'approaching_range', label: 'Approaching Range Edge' },
    { key: 'confirm_timer', label: 'Confirm Timer Updates' },
    { key: 'daily_summary', label: 'Daily Summary' },
    { key: 'fee_collection', label: 'Fee Collection' },
  ];

  private async handleAlerts(msg: TelegramBot.Message, arg?: string): Promise<void> {
    const prefs = this.context.config.notifications.preferences ?? {};

    // If an argument was provided, toggle that category
    if (arg) {
      const category = arg.toLowerCase().replace(/ /g, '_') as NotificationCategory;
      const validKeys = TelegramCommandHandler.ALERT_CATEGORIES.map(c => c.key);
      if (!validKeys.includes(category)) {
        await this.bot.sendMessage(msg.chat.id,
          `Unknown alert category: ${arg}\n\nValid categories:\n${validKeys.map(k => `  ${k}`).join('\n')}`,
        );
        return;
      }

      // Toggle: if currently true/undefined → false, if false → true
      const currentValue = prefs[category] ?? true;
      const newValue = !currentValue;

      // Update in-memory config
      if (!this.context.config.notifications.preferences) {
        this.context.config.notifications.preferences = {};
      }
      this.context.config.notifications.preferences[category] = newValue;

      // Persist to config.yaml
      try {
        const yamlPath = resolve(process.cwd(), 'config.yaml');
        const yamlContent = readFileSync(yamlPath, 'utf-8');
        const parsed = parseYaml(yamlContent) as Record<string, unknown>;
        const notifications = (parsed.notifications ?? {}) as Record<string, unknown>;
        const yamlPrefs = (notifications.preferences ?? {}) as Record<string, boolean>;
        yamlPrefs[category] = newValue;
        notifications.preferences = yamlPrefs;
        parsed.notifications = notifications;

        const tempPath = resolve(process.cwd(), '.config.yaml.tmp');
        writeFileSync(tempPath, stringifyYaml(parsed, { lineWidth: 120 }), 'utf-8');
        renameSync(tempPath, yamlPath);
      } catch (err) {
        logger.warn(`Failed to persist alert preferences: ${err instanceof Error ? err.message : String(err)}`);
      }

      const label = TelegramCommandHandler.ALERT_CATEGORIES.find(c => c.key === category)?.label ?? category;
      await this.bot.sendMessage(msg.chat.id,
        `${newValue ? '✅' : '🔇'} ${label}: ${newValue ? 'enabled' : 'disabled'}`,
      );
      logger.info(`Alert preference toggled: ${category} = ${newValue}`);
      return;
    }

    // No argument — show current preferences
    const lines = ['<b>Notification Preferences</b>\n'];
    for (const { key, label } of TelegramCommandHandler.ALERT_CATEGORIES) {
      const enabled = prefs[key] ?? true; // Default to true
      lines.push(`${enabled ? '✅' : '🔇'} ${label} (<code>${key}</code>)`);
    }
    lines.push('\nToggle: <code>/alerts category_name</code>');
    lines.push('Example: <code>/alerts daily_summary</code>');

    await this.bot.sendMessage(msg.chat.id, lines.join('\n'), { parse_mode: 'HTML' });
    logger.info('Telegram /alerts command executed');
  }

  private async handleHelp(msg: TelegramBot.Message): Promise<void> {
    const message = `
🤖 <b>9mm V3 Rebalancer Bot</b>

<b>Info:</b>
/status — Detailed status for all positions
/balance — Wallet assets &amp; values
/chain — Position lineage chain view
/link — Manually link two positions in a chain

<b>Position Management:</b>
/scan — Scan wallet for unconfigured positions
/new — Add position to monitoring (guided)
/config — View/update strategy params
/collect — Collect unclaimed fees
/increase — Add liquidity to position (auto-swap)
/decrease — Remove partial liquidity (keep NFT)
/remove — Remove liquidity (partial or full + burn)
/rebalance — Force manual rebalance

<b>System:</b>
/enable [tokenId] — Enable rebalancing, clear kill switch + safe mode
/disable — Emergency stop
/recover — Detect &amp; recover stranded funds
/removestale — Remove burned/invalid positions
/alerts — View/toggle notification preferences
/cancel — Cancel active flow
/help — Show this message

<b>Current Status:</b>
• Rebalancing: ${this.rebalancingEnabled ? '✅ ENABLED' : '⛔ DISABLED'}
• Mode: ${this.context.config.dry_run ? '🧪 DRY RUN' : '🚀 LIVE'}
    `.trim();

    await this.bot.sendMessage(msg.chat.id, message, { parse_mode: 'HTML' });
    logger.info('Telegram /help command executed');
  }

  // ============================================================
  // /increase — Increase Liquidity Flow
  // ============================================================

  private async showIncreaseOptions(chatId: number, entry: PositionPickerEntry): Promise<void> {
    const status = entry.status;
    const d0 = status.token0Info.decimals;
    const d1 = status.token1Info.decimals;

    // Get wallet balances for the position's tokens
    const posChain = this.getChainForPosition(entry.tokenId);
    const posContracts = this.getContractsForPosition(entry.tokenId);
    const erc20_0 = posContracts.getERC20(status.position.token0);
    const erc20_1 = posContracts.getERC20(status.position.token1);
    const [bal0, bal1] = await Promise.all([
      erc20_0.balanceOf(posChain.wallet.address) as Promise<bigint>,
      erc20_1.balanceOf(posChain.wallet.address) as Promise<bigint>,
    ]);

    const bal0Fmt = Number(bal0) / 10 ** d0;
    const bal1Fmt = Number(bal1) / 10 ** d1;

    let priceMap = new Map<string, number>();
    try {
      priceMap = await getTokenPrices([status.position.token0, status.position.token1]);
    } catch { /* unavailable */ }
    const p0 = priceMap.get(status.position.token0.toLowerCase()) ?? 0;
    const p1 = priceMap.get(status.position.token1.toLowerCase()) ?? 0;

    const flow = this.activeFlow!;
    flow.data.walletBal0 = bal0.toString();
    flow.data.walletBal1 = bal1.toString();
    flow.data.token0Addr = status.position.token0;
    flow.data.token1Addr = status.position.token1;

    const lines = [
      `📈 <b>Increase Liquidity — #${entry.tokenId}</b>`,
      `${entry.pair} — Current value: ${formatUsd(entry.totalValueUsd)}`,
      ``,
      `<b>Your wallet balances:</b>`,
      `• ${formatToken(bal0Fmt, d0)} ${status.token0Info.symbol}${p0 > 0 ? ` (${formatUsd(bal0Fmt * p0)})` : ''}`,
      `• ${formatToken(bal1Fmt, d1)} ${status.token1Info.symbol}${p1 > 0 ? ` (${formatUsd(bal1Fmt * p1)})` : ''}`,
      ``,
      `How much to add?`,
      `  <b>1.</b> Use all available ${status.token0Info.symbol} + ${status.token1Info.symbol} (auto-swap)`,
      `  <b>2.</b> Specify amounts manually`,
      ``,
      `Reply with a number (1-2):`,
    ];

    if (bal0 === 0n && bal1 === 0n) {
      lines.push(``, `⚠️ Both wallet balances are zero — nothing to add.`);
    }

    await this.bot.sendMessage(chatId, lines.join('\n'), { parse_mode: 'HTML' });
  }

  private async handleIncreaseFlowStep(msg: TelegramBot.Message): Promise<void> {
    const flow = this.activeFlow;
    if (!flow || !msg.text) return;

    const chatId = msg.chat.id;
    const text = msg.text.trim();
    const entries = flow.data.pickerEntries as PositionPickerEntry[];
    const entry = entries[flow.data.selectedIdx as number];
    const status = entry.status;
    const d0 = status.token0Info.decimals;
    const d1 = status.token1Info.decimals;

    if (flow.step === 'choose_increase_mode') {
      if (text === '1') {
        // Use all wallet balances
        flow.data.amount0 = flow.data.walletBal0;
        flow.data.amount1 = flow.data.walletBal1;
        flow.data.swapIfNeeded = true;
        flow.step = 'confirm_increase';
        await this.showIncreaseConfirm(chatId, entry);
        return;
      } else if (text === '2') {
        flow.step = 'enter_amounts';
        await this.bot.sendMessage(chatId, [
          `Enter amounts in format: <code>AMOUNT0 AMOUNT1</code>`,
          ``,
          `Examples:`,
          `• <code>100 5000</code> — 100 ${status.token0Info.symbol} and 5000 ${status.token1Info.symbol}`,
          `• <code>0 10000</code> — only ${status.token1Info.symbol}`,
          `• <code>500 0</code> — only ${status.token0Info.symbol}`,
        ].join('\n'), { parse_mode: 'HTML' });
        return;
      } else {
        await this.bot.sendMessage(chatId, '❌ Enter 1 or 2:');
        return;
      }
    }

    if (flow.step === 'enter_amounts') {
      const parts = text.split(/\s+/);
      if (parts.length !== 2) {
        await this.bot.sendMessage(chatId, '❌ Enter two numbers separated by space (e.g. <code>100 5000</code>):', { parse_mode: 'HTML' });
        return;
      }
      const amt0 = parseFloat(parts[0]);
      const amt1 = parseFloat(parts[1]);
      if (isNaN(amt0) || isNaN(amt1) || (amt0 <= 0 && amt1 <= 0)) {
        await this.bot.sendMessage(chatId, '❌ Enter valid positive numbers. At least one must be > 0.');
        return;
      }

      // Convert human amounts to raw BigInt (string-based to avoid float precision loss)
      const toRawBigInt = (s: string, decimals: number): bigint => {
        const [intPart, fracPart = ''] = s.split('.');
        const padded = fracPart.padEnd(decimals, '0').slice(0, decimals);
        return BigInt(intPart || '0') * BigInt(10 ** decimals) + BigInt(padded);
      };
      const raw0 = toRawBigInt(parts[0], d0);
      const raw1 = toRawBigInt(parts[1], d1);

      // Validate against wallet balances
      const walBal0 = BigInt(flow.data.walletBal0 as string);
      const walBal1 = BigInt(flow.data.walletBal1 as string);
      if (raw0 > walBal0 || raw1 > walBal1) {
        const maxFmt0 = Number(walBal0) / 10 ** d0;
        const maxFmt1 = Number(walBal1) / 10 ** d1;
        await this.bot.sendMessage(chatId, `❌ Exceeds wallet balance.\nMax: ${formatToken(maxFmt0, d0)} ${status.token0Info.symbol}, ${formatToken(maxFmt1, d1)} ${status.token1Info.symbol}`);
        return;
      }

      flow.data.amount0 = raw0.toString();
      flow.data.amount1 = raw1.toString();
      flow.data.swapIfNeeded = true;
      flow.step = 'confirm_increase';
      await this.showIncreaseConfirm(chatId, entry);
      return;
    }

    if (flow.step === 'confirm_increase') {
      if (text.toLowerCase() !== 'yes' && text.toLowerCase() !== 'y') {
        await this.bot.sendMessage(chatId, '❌ Cancelled. Send /increase to start again.');
        this.activeFlow = null;
        return;
      }

      if (this.context.config.dry_run) {
        this.activeFlow = null;
        await this.bot.sendMessage(chatId, '🧪 <b>Dry run</b> — would have increased liquidity. Disable dry_run to execute.', { parse_mode: 'HTML' });
        return;
      }

      let amt0 = BigInt(flow.data.amount0 as string);
      let amt1 = BigInt(flow.data.amount1 as string);
      const doSwap = flow.data.swapIfNeeded as boolean;

      await this.bot.sendMessage(chatId, '⏳ Increasing liquidity on-chain...');
      this.activeFlow = null;

      try {
        const posContracts = this.getContractsForPosition(entry.tokenId);
        const posChain = this.getChainForPosition(entry.tokenId);

        // Swap if needed to balance ratio
        let swapMsg = '';
        if (doSwap && (amt0 > 0n || amt1 > 0n)) {
          const swapCalc = calculateSwapAmount(
            amt0, amt1,
            status.pool.currentTick,
            status.position.tickLower, status.position.tickUpper,
            status.pool.fee,
          );

          if (swapCalc.amountIn > 0n) {

            const tokenInAddr = swapCalc.tokenIn === 'token0' ? status.position.token0 : status.position.token1;
            const tokenOutAddr = swapCalc.tokenIn === 'token0' ? status.position.token1 : status.position.token0;
            const zeroForOne = swapCalc.tokenIn === 'token0';

            const swapResult = await executeSwap(
              tokenInAddr, tokenOutAddr,
              status.pool.fee, swapCalc.amountIn,
              status.pool.sqrtPriceX96, zeroForOne,
              this.context.config, posContracts, posChain,
            );

            if (zeroForOne) {
              amt0 -= swapResult.amountIn;
              amt1 += swapResult.amountOut;
            } else {
              amt1 -= swapResult.amountIn;
              amt0 += swapResult.amountOut;
            }
            const symIn = swapCalc.tokenIn === 'token0' ? status.token0Info.symbol : status.token1Info.symbol;
            const symOut = swapCalc.tokenIn === 'token0' ? status.token1Info.symbol : status.token0Info.symbol;
            const dIn = swapCalc.tokenIn === 'token0' ? d0 : d1;
            const dOut = swapCalc.tokenIn === 'token0' ? d1 : d0;
            swapMsg = `\n• Swap: ${formatToken(Number(swapResult.amountIn) / 10 ** dIn, dIn)} ${symIn} → ${formatToken(Number(swapResult.amountOut) / 10 ** dOut, dOut)} ${symOut}`;
          }
        }

        const result = await increaseLiquidity(
          entry.tokenId, amt0, amt1,
          this.context.config.slippage_tolerance_bps,
          posContracts, posChain,
        );

        const added0 = Number(result.amount0) / 10 ** d0;
        const added1 = Number(result.amount1) / 10 ** d1;

        const message = [
          `✅ <b>Liquidity Increased — #${entry.tokenId}</b>`,
          ``,
          `• Added: ${formatToken(added0, d0)} ${status.token0Info.symbol} + ${formatToken(added1, d1)} ${status.token1Info.symbol}`,
          swapMsg,
          ``,
          `Tx: <code>${result.txHash}</code>`,
        ].filter(Boolean).join('\n');

        await this.bot.sendMessage(chatId, message, { parse_mode: 'HTML' });
        logger.info('Liquidity increased via Telegram /increase', { tokenId: entry.tokenId, txHash: result.txHash });
      } catch (error) {
        const errMsg = (error as Error).message;
        logger.error('Error increasing liquidity via Telegram', { tokenId: entry.tokenId, error: errMsg });
        await this.bot.sendMessage(chatId, '❌ Increase failed. Check logs for details.');
      }
    }
  }

  private async showIncreaseConfirm(chatId: number, entry: PositionPickerEntry): Promise<void> {
    const flow = this.activeFlow!;
    const status = entry.status;
    const d0 = status.token0Info.decimals;
    const d1 = status.token1Info.decimals;
    const amt0 = BigInt(flow.data.amount0 as string);
    const amt1 = BigInt(flow.data.amount1 as string);

    const fmt0 = Number(amt0) / 10 ** d0;
    const fmt1 = Number(amt1) / 10 ** d1;

    // Calculate swap preview
    const swapCalc = calculateSwapAmount(
      amt0, amt1,
      status.pool.currentTick,
      status.position.tickLower, status.position.tickUpper,
      status.pool.fee,
    );

    const lines = [
      `📈 <b>Increase Preview — #${entry.tokenId}</b>`,
      ``,
      `<b>Adding:</b>`,
      `• ${formatToken(fmt0, d0)} ${status.token0Info.symbol}`,
      `• ${formatToken(fmt1, d1)} ${status.token1Info.symbol}`,
    ];

    if (swapCalc.amountIn > 0n) {
      const symIn = swapCalc.tokenIn === 'token0' ? status.token0Info.symbol : status.token1Info.symbol;
      const dIn = swapCalc.tokenIn === 'token0' ? d0 : d1;
      lines.push(``, `⚡ Will swap ~${formatToken(Number(swapCalc.amountIn) / 10 ** dIn, dIn)} ${symIn} to balance ratio`);
    }

    lines.push(``, `Reply <b>yes</b> to confirm or /cancel to abort.`);

    if (this.context.config.dry_run) {
      lines.push(``, `⚠️ <i>Dry run mode — no transaction will execute</i>`);
    }

    await this.bot.sendMessage(chatId, lines.join('\n'), { parse_mode: 'HTML' });
  }

  // ============================================================
  // /decrease — Decrease Liquidity Flow
  // ============================================================

  private async showDecreasePercentChoice(chatId: number, entry: PositionPickerEntry): Promise<void> {
    const lines = [
      `📉 <b>Decrease Liquidity — #${entry.tokenId}</b>`,
      `${entry.pair} — ${formatUsd(entry.totalValueUsd)}`,
      ``,
      `How much liquidity to remove?`,
      ``,
      `  <b>1.</b> 25%`,
      `  <b>2.</b> 50%`,
      `  <b>3.</b> 75%`,
      `  <b>4.</b> 100% (use /remove instead for full removal + burn)`,
      ``,
      `Reply with a number (1-3) or enter a custom % (e.g. 35):`,
    ];

    if (this.context.config.dry_run) {
      lines.push(``, `⚠️ <i>Dry run mode — no transaction will execute</i>`);
    }

    await this.bot.sendMessage(chatId, lines.join('\n'), { parse_mode: 'HTML' });
  }

  private async handleDecreaseFlowStep(msg: TelegramBot.Message): Promise<void> {
    const flow = this.activeFlow;
    if (!flow || !msg.text) return;

    const chatId = msg.chat.id;
    const text = msg.text.trim().toLowerCase();
    const entries = flow.data.pickerEntries as PositionPickerEntry[];
    const entry = entries[flow.data.selectedIdx as number];

    if (flow.step === 'choose_decrease_percent') {
      let pct: number;
      const presets: Record<string, number> = { '1': 25, '2': 50, '3': 75 };
      if (text === '4') {
        await this.bot.sendMessage(chatId, '💡 For 100% removal + NFT burn, use /remove instead.\nEnter a percentage (1-99) or /cancel:');
        return;
      }
      if (presets[text]) {
        pct = presets[text];
      } else {
        pct = parseFloat(text);
        if (isNaN(pct) || pct <= 0 || pct >= 100) {
          await this.bot.sendMessage(chatId, '❌ Enter a percentage between 1 and 99 (use /remove for 100%):');
          return;
        }
      }

      flow.data.decreasePct = pct;
      const percentageBps = Math.round(pct * 100);

      // Preview
      const status = entry.status;
      const liquidity = status.position.liquidity;
      const liquidityToRemove = (liquidity * BigInt(percentageBps)) / 10000n;
      const sqrtPriceAX96 = tickToSqrtPriceX96(status.position.tickLower);
      const sqrtPriceBX96 = tickToSqrtPriceX96(status.position.tickUpper);
      const expected = getAmountsForLiquidity(status.pool.sqrtPriceX96, sqrtPriceAX96, sqrtPriceBX96, liquidityToRemove);

      const d0 = status.token0Info.decimals;
      const d1 = status.token1Info.decimals;
      const exp0 = Number(expected.amount0) / 10 ** d0;
      const exp1 = Number(expected.amount1) / 10 ** d1;

      let priceMap = new Map<string, number>();
      try {
        priceMap = await getTokenPrices([status.position.token0, status.position.token1]);
      } catch { /* unavailable */ }
      const p0 = priceMap.get(status.position.token0.toLowerCase()) ?? 0;
      const p1 = priceMap.get(status.position.token1.toLowerCase()) ?? 0;
      const valueUsd = exp0 * p0 + exp1 * p1;

      const lines = [
        `📉 <b>Decrease ${pct}% — #${entry.tokenId}</b>`,
        ``,
        `<b>Expected withdrawal:</b>`,
        `• ~${formatToken(exp0, d0)} ${entry.token0Symbol}${p0 > 0 ? ` (${formatUsd(exp0 * p0)})` : ''}`,
        `• ~${formatToken(exp1, d1)} ${entry.token1Symbol}${p1 > 0 ? ` (${formatUsd(exp1 * p1)})` : ''}`,
      ];

      if (valueUsd > 0) {
        lines.push(`• Total: ${formatUsd(valueUsd)}`);
      }

      lines.push(
        ``,
        `ℹ️ Position NFT is <b>not</b> burned — remaining liquidity stays active.`,
        ``,
        `Reply <b>yes</b> to confirm or /cancel to abort.`,
      );

      flow.step = 'confirm_decrease';
      await this.bot.sendMessage(chatId, lines.join('\n'), { parse_mode: 'HTML' });
      return;
    }

    if (flow.step === 'confirm_decrease') {
      if (text !== 'yes' && text !== 'y') {
        await this.bot.sendMessage(chatId, '❌ Cancelled. Send /decrease to start again.');
        this.activeFlow = null;
        return;
      }

      if (this.context.config.dry_run) {
        this.activeFlow = null;
        await this.bot.sendMessage(chatId, '🧪 <b>Dry run</b> — would have decreased liquidity. Disable dry_run to execute.', { parse_mode: 'HTML' });
        return;
      }

      const pct = flow.data.decreasePct as number;
      const percentageBps = Math.round(pct * 100);

      await this.bot.sendMessage(chatId, `⏳ Decreasing ${pct}% liquidity on-chain...`);
      this.activeFlow = null;

      try {
        const posContracts = this.getContractsForPosition(entry.tokenId);
        const posChain = this.getChainForPosition(entry.tokenId);
        const status = entry.status;

        const result = await decreasePositionLiquidity(
          entry.tokenId,
          percentageBps,
          this.context.config.slippage_tolerance_bps,
          posContracts,
          posChain,
        );

        const d0 = status.token0Info.decimals;
        const d1 = status.token1Info.decimals;
        const amt0 = Number(result.amount0) / 10 ** d0;
        const amt1 = Number(result.amount1) / 10 ** d1;

        const message = [
          `✅ <b>Liquidity Decreased — #${entry.tokenId} (${pct}%)</b>`,
          ``,
          `• Received: ${formatToken(amt0, d0)} ${entry.token0Symbol} + ${formatToken(amt1, d1)} ${entry.token1Symbol}`,
          ``,
          `Decrease tx: <code>${result.decreaseTxHash}</code>`,
          `Collect tx: <code>${result.collectTxHash}</code>`,
        ].join('\n');

        await this.bot.sendMessage(chatId, message, { parse_mode: 'HTML' });
        logger.info('Liquidity decreased via Telegram /decrease', { tokenId: entry.tokenId, pct, txHash: result.decreaseTxHash });
      } catch (error) {
        const errMsg = (error as Error).message;
        logger.error('Error decreasing liquidity via Telegram', { tokenId: entry.tokenId, error: errMsg });
        await this.bot.sendMessage(chatId, '❌ Decrease failed. Check logs for details.');
      }
    }
  }

  // ============================================================
  // Public API
  // ============================================================

  public isRebalancingEnabled(): boolean {
    return this.rebalancingEnabled;
  }

  public stop(): void {
    this.bot.stopPolling();
    logger.info('Telegram command handler stopped');
  }
}

// ============================================================
// Formatting Helpers
// ============================================================

/** Format a number for price display with appropriate precision */
function formatNum(n: number): string {
  if (n === 0) return '0';
  if (n >= 1000) return n.toLocaleString('en-US', { maximumFractionDigits: 2 });
  if (n >= 1) return n.toFixed(6);
  return n.toFixed(8);
}

/** Format a token amount with commas and appropriate decimals */
function formatToken(amount: number, decimals: number): string {
  if (amount === 0) return '0';
  const displayDecimals = decimals >= 18 ? 2 : decimals >= 8 ? 4 : 2;
  return amount.toLocaleString('en-US', {
    minimumFractionDigits: displayDecimals,
    maximumFractionDigits: displayDecimals,
  });
}

/** Format a USD value */
function formatUsd(value: number): string {
  if (value === 0) return '$0.00';
  return '$' + value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/** Format a duration in milliseconds to a human-readable string */
function formatDuration(ms: number): string {
  const totalMinutes = Math.floor(ms / 60_000);
  if (totalMinutes < 60) return `${totalMinutes}m`;
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
}

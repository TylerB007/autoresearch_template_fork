/**
 * Runtime config loader — merges .env, config.yaml, and hardcoded defaults
 * Named configLoader.ts to avoid collision with existing src/config/ directory
 *
 * Multi-chain support: Resolves chain from config.yaml chain.chainId using the
 * chain registry. Contract addresses and fee tiers are chain-specific.
 */

import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import dotenv from 'dotenv';
import { parse as parseYaml } from 'yaml';
import { getChainConfig, getSupportedDexes } from './config/chains.js';
import { PULSECHAIN_CONFIG } from './config/index.js';
import type { AppConfig, KillSwitchParams, PositionConfig, StrategyType, SwapProvider } from './types.js';
import { percentageToTicks } from './math.js';
import { PRESET_WIDTH_REGEX } from './strategy.js';
import logger from './logger.js';

/** Base strategy names (without preset width suffix). Includes new + legacy names. */
const VALID_BASE_STRATEGIES: string[] = [
  // New descriptive names
  'center', 'bullish', 'bearish', 'lazy_up', 'lazy_down',
  // Legacy names (backward compat)
  'pulse', 'snuggle_up', 'snuggle_down', 'lazy_ascending', 'lazy_descending',
  // Passive
  'static',
];

/** Validate a strategy string: must be a known base name, optionally with a preset suffix (_300, _3pct, etc.). */
function isValidStrategy(strategy: string): boolean {
  // Check for preset suffix (e.g., pulse_300, center_3pct, bullish_6pct)
  const match = strategy.match(PRESET_WIDTH_REGEX);
  if (match) {
    const base = strategy.replace(/_\d+(pct)?$/, '');
    return VALID_BASE_STRATEGIES.includes(base);
  }
  // Plain base strategy
  return VALID_BASE_STRATEGIES.includes(strategy);
}
const VALID_SWAP_PROVIDERS: SwapProvider[] = ['direct', 'piteas', 'oneinch'];

/**
 * Load private key from file (.secret) or fall back to PRIVATE_KEY env var.
 * File-based loading is preferred because env vars are exposed in /proc/PID/environ.
 */
function loadPrivateKey(): string {
  const secretPath = resolve(process.cwd(), '.secret');
  if (existsSync(secretPath)) {
    const key = readFileSync(secretPath, 'utf-8').trim();
    if (key && key !== '0xYOUR_PRIVATE_KEY_HERE') {
      logger.info('Private key loaded from .secret file (not exposed in /proc/environ)');
      return key;
    }
  }

  // Fallback: env var (backward compatible)
  const key = process.env.PRIVATE_KEY;
  if (!key || key === '0xYOUR_PRIVATE_KEY_HERE') {
    throw new Error(
      'Private key not found. Create a .secret file with your private key (recommended), ' +
        'or set PRIVATE_KEY in .env (less secure — visible in /proc/environ).',
    );
  }
  logger.warn(
    'Private key loaded from PRIVATE_KEY env var. For better security, move it to a .secret file ' +
      'and remove PRIVATE_KEY from .env. Env vars are visible in /proc/PID/environ.',
  );
  return key;
}

/**
 * Re-read the positions array from config.yaml and update the in-memory config.
 * Called before each dashboard API request and each rebalancer monitoring cycle
 * so both processes stay in sync with config changes made by the other.
 */
export function reloadPositions(config: AppConfig): void {
  const yamlPath = resolve(process.cwd(), 'config.yaml');
  const raw = parseYaml(readFileSync(yamlPath, 'utf-8')) as Record<string, unknown>;
  const rawPositions = (raw.positions as Record<string, unknown>[] | undefined) ?? [];

  const defaultChainId = config.chain.chainId;
  const seen = new Set<string>();
  const validated: PositionConfig[] = [];

  for (const pos of rawPositions) {
    const tokenId = pos.token_id as number;
    const posChainId = (pos.chain_id as number | undefined) ?? defaultChainId;
    const strategy = pos.strategy as string;
    const params = pos.params as Record<string, unknown> | undefined;
    const dex = pos.dex as string | undefined;

    // Validate chain_id exists in configured chains
    if (!config.chains.has(posChainId)) {
      logger.error(
        `reloadPositions: position ${tokenId} references unknown chain_id ${posChainId} — skipping. ` +
          `Configured chains: ${[...config.chains.keys()].join(', ')}`,
      );
      continue;
    }

    // Validate strategy
    if (!isValidStrategy(strategy)) {
      logger.error(
        `reloadPositions: position ${tokenId} has invalid strategy "${strategy}" — skipping. ` +
          `Valid base strategies: ${VALID_BASE_STRATEGIES.join(', ')} (with optional _N or _Npct suffix)`,
      );
      continue;
    }

    // Validate width_ticks for non-preset strategies
    const hasPresetWidth = PRESET_WIDTH_REGEX.test(strategy);
    let widthTicks = (params?.width_ticks as number | undefined) ?? 0;
    const widthPercentage = params?.width_percentage as number | undefined;

    // Convert percentage to ticks if provided and width_ticks is missing
    if (widthTicks <= 0 && widthPercentage && widthPercentage > 0) {
      widthTicks = percentageToTicks(widthPercentage);
    }

    if (!hasPresetWidth && widthTicks <= 0) {
      logger.error(
        `reloadPositions: position ${tokenId} (strategy: ${strategy}) requires width_ticks or width_percentage > 0 — skipping`,
      );
      continue;
    }

    // Convert trigger_percentage to ticks if provided
    let triggerDistanceTicks = (params?.trigger_distance_ticks as number | undefined) ?? 0;
    const triggerPercentage = params?.trigger_percentage as number | undefined;

    if (triggerDistanceTicks <= 0 && triggerPercentage && triggerPercentage > 0) {
      triggerDistanceTicks = percentageToTicks(triggerPercentage);
    }

    // Convert critical_percentage to ticks if provided
    let criticalDistanceTicks = params?.critical_distance_ticks as number | undefined;
    const criticalPercentage = params?.critical_percentage as number | undefined;

    if ((criticalDistanceTicks === undefined || criticalDistanceTicks <= 0) && criticalPercentage && criticalPercentage > 0) {
      criticalDistanceTicks = percentageToTicks(criticalPercentage);
    }

    // Warn if critical_distance_ticks <= trigger_distance_ticks (doesn't make sense)
    if (criticalDistanceTicks !== undefined && criticalDistanceTicks > 0 && criticalDistanceTicks <= triggerDistanceTicks) {
      logger.warn(
        `reloadPositions: position ${tokenId} has critical_distance_ticks (${criticalDistanceTicks}) <= trigger_distance_ticks (${triggerDistanceTicks}). ` +
          `Critical distance should be larger than trigger distance.`,
      );
    }

    // Parse kill_switch params
    const killSwitch = params?.kill_switch as KillSwitchParams | undefined;

    // Reject duplicate token_id + chain_id pairs
    const key = `${posChainId}-${tokenId}`;
    if (seen.has(key)) {
      logger.error(
        `reloadPositions: duplicate position ${tokenId} on chain ${posChainId} — skipping duplicate`,
      );
      continue;
    }
    seen.add(key);

    // Validate gauge_address if provided
    const gaugeAddress = pos.gauge_address as string | undefined;
    if (gaugeAddress !== undefined) {
      if (!/^0x[0-9a-fA-F]{40}$/.test(gaugeAddress)) {
        logger.error(
          `reloadPositions: position ${tokenId} has invalid gauge_address "${gaugeAddress}" — ignoring gauge`,
        );
      } else if (dex !== 'aerodrome-cl' && dex !== 'aerodrome-cl-gc') {
        logger.warn(
          `reloadPositions: position ${tokenId} has gauge_address but dex is "${dex ?? 'default'}" ` +
          `(only aerodrome-cl and aerodrome-cl-gc support gauges) — ignoring gauge`,
        );
      }
    }

    const validGauge = gaugeAddress !== undefined
      && /^0x[0-9a-fA-F]{40}$/.test(gaugeAddress)
      && (dex === 'aerodrome-cl' || dex === 'aerodrome-cl-gc');

    validated.push({
      token_id: tokenId,
      chain_id: posChainId,
      strategy: strategy as StrategyType,
      params: {
        width_ticks: widthTicks,  // This will now hold calculated ticks if percentage was used
        trigger_distance_ticks: triggerDistanceTicks,
        width_percentage: widthPercentage,
        trigger_percentage: triggerPercentage,
        ...(params?.lower_ratio_percent !== undefined && {
          lower_ratio_percent: params.lower_ratio_percent as number,
        }),
        ...(params?.confirm_minutes !== undefined && {
          confirm_minutes: params.confirm_minutes as number,
        }),
        // Critical distance params
        ...(criticalDistanceTicks !== undefined && criticalDistanceTicks > 0 && {
          critical_distance_ticks: criticalDistanceTicks,
        }),
        ...(criticalPercentage !== undefined && { critical_percentage: criticalPercentage }),
        // Anti-churn params
        ...(params?.max_rebalances_per_window !== undefined && {
          max_rebalances_per_window: params.max_rebalances_per_window as number,
        }),
        ...(params?.churn_window_hours !== undefined && {
          churn_window_hours: params.churn_window_hours as number,
        }),
        ...(params?.escalation_width !== undefined && {
          escalation_width: params.escalation_width as number,
        }),
        // Kill switch params
        ...(killSwitch !== undefined && { kill_switch: killSwitch }),
        // Cost-benefit gate params
        ...(params?.cost_benefit_enabled !== undefined && {
          cost_benefit_enabled: params.cost_benefit_enabled as boolean,
        }),
        ...(params?.min_fee_to_cost_ratio !== undefined && {
          min_fee_to_cost_ratio: params.min_fee_to_cost_ratio as number,
        }),
      },
      ...(dex !== undefined && { dex }),
      ...(validGauge && { gauge_address: gaugeAddress }),
    });
  }

  config.positions = validated;
}

/**
 * Build RPC URL list for a specific chain.
 * Priority: .env per-chain overrides > .env generic overrides > yaml > chain registry defaults.
 * Per-chain env vars: RPC_URL_{chainId}_PRIMARY, RPC_URL_{chainId}_FALLBACK_1, etc.
 * Generic env vars (default chain only): RPC_URL_PRIMARY, RPC_URL_FALLBACK_1, etc.
 */
function buildRpcUrlsForChain(chainId: number, yamlRpcs: string[] | undefined, registryRpcs: string[], isDefaultChain: boolean): string[] {
  const urls: string[] = [];

  // Per-chain .env overrides (e.g., RPC_URL_42161_PRIMARY)
  const p = process.env[`RPC_URL_${chainId}_PRIMARY`];
  const f1 = process.env[`RPC_URL_${chainId}_FALLBACK_1`];
  const f2 = process.env[`RPC_URL_${chainId}_FALLBACK_2`];
  if (p) urls.push(p);
  if (f1) urls.push(f1);
  if (f2) urls.push(f2);
  if (urls.length > 0) return urls;

  // Generic .env overrides — ONLY for the default chain to prevent cross-chain RPC leakage
  if (isDefaultChain) {
    if (process.env.RPC_URL_PRIMARY) urls.push(process.env.RPC_URL_PRIMARY);
    if (process.env.RPC_URL_FALLBACK_1) urls.push(process.env.RPC_URL_FALLBACK_1);
    if (process.env.RPC_URL_FALLBACK_2) urls.push(process.env.RPC_URL_FALLBACK_2);
    if (urls.length > 0) return urls;
  }

  // YAML-defined RPC URLs
  if (yamlRpcs && yamlRpcs.length > 0) return [...yamlRpcs];

  // Chain registry defaults
  return [...registryRpcs];
}

export function loadConfig(configPath?: string): AppConfig {
  // 1. Load .env
  dotenv.config();

  const privateKey = loadPrivateKey();

  // 2. Load config.yaml
  const yamlPath = configPath ?? resolve(process.cwd(), 'config.yaml');
  let yamlContent: string;
  try {
    yamlContent = readFileSync(yamlPath, 'utf-8');
  } catch (err) {
    throw new Error(`Cannot read config file at ${yamlPath}: ${err}`);
  }

  const raw = parseYaml(yamlContent) as Record<string, unknown>;
  if (!raw || typeof raw !== 'object') {
    throw new Error(`Invalid config.yaml: expected an object, got ${typeof raw}`);
  }

  // 3. Resolve chain(s) from registry
  //    Multi-chain: `chains:` array in config.yaml
  //    Legacy: `chain:` block (defaults to PulseChain 369)
  const rawChains = raw.chains as Record<string, unknown>[] | undefined;
  const rawChain = raw.chain as Record<string, unknown> | undefined;

  const chains = new Map<number, import('./types.js').ChainConfig>();
  const rpcUrlsByChain = new Map<number, string[]>();

  if (rawChains && rawChains.length > 0) {
    // Multi-chain mode — first chain is the default (receives generic RPC env vars)
    const firstChainId = rawChains[0].chain_id as number;
    for (const rc of rawChains) {
      const cid = rc.chain_id as number;
      if (!cid) throw new Error('Each entry in chains[] must have a chain_id');
      const entry = getChainConfig(cid);
      const rpcUrls = buildRpcUrlsForChain(cid, rc.rpc_urls as string[] | undefined, entry.rpcUrls, cid === firstChainId);
      rpcUrlsByChain.set(cid, rpcUrls);
      chains.set(cid, {
        chainId: cid,
        chainName: entry.chainName,
        protocolName: entry.protocolName,
        rpcUrls,
        blockExplorerUrl: entry.blockExplorerUrl,
        nativeCurrencySymbol: entry.nativeCurrencySymbol,
        dexScreenerSlug: entry.dexScreenerSlug,
        wrappedNativeAddress: entry.wrappedNativeAddress,
        swapRouterType: entry.swapRouterType,
      });
      logger.info(`Chain: ${entry.chainName} (ID ${cid}) — ${entry.protocolName}`);
    }
  } else {
    // Legacy single-chain mode
    const chainId = (rawChain?.chainId as number) ?? PULSECHAIN_CONFIG.chainId;
    const entry = getChainConfig(chainId);
    const rpcUrls = buildRpcUrlsForChain(chainId, rawChain?.rpcUrls as string[] | undefined, entry.rpcUrls, true);
    rpcUrlsByChain.set(chainId, rpcUrls);
    chains.set(chainId, {
      chainId,
      chainName: entry.chainName,
      protocolName: entry.protocolName,
      rpcUrls,
      blockExplorerUrl: entry.blockExplorerUrl,
      nativeCurrencySymbol: entry.nativeCurrencySymbol,
      dexScreenerSlug: entry.dexScreenerSlug,
      wrappedNativeAddress: entry.wrappedNativeAddress,
      swapRouterType: entry.swapRouterType,
    });
    logger.info(`Chain: ${entry.chainName} (ID ${chainId}) — ${entry.protocolName}`);
  }

  // Default chain = first configured chain
  const defaultChainId = chains.keys().next().value!;
  const defaultChainConfig = chains.get(defaultChainId)!;
  const defaultChainEntry = getChainConfig(defaultChainId);
  const rpcUrls = rpcUrlsByChain.get(defaultChainId)!;

  // 4. Validate positions
  const rawPositions = (raw.positions as Record<string, unknown>[] | undefined) ?? [];
  const positions: PositionConfig[] = [];

  for (const pos of rawPositions) {
    const tokenId = pos.token_id as number;
    const posChainId = (pos.chain_id as number | undefined) ?? defaultChainId;
    const strategy = pos.strategy as string;
    const params = pos.params as Record<string, unknown> | undefined;
    const dex = pos.dex as string | undefined;

    // Validate chain_id exists in configured chains
    if (!chains.has(posChainId)) {
      throw new Error(
        `Position ${tokenId} references chain_id ${posChainId} which is not configured. ` +
          `Configured chains: ${[...chains.keys()].join(', ')}`,
      );
    }

    // Validate dex field if provided (against the position's chain)
    const posChainEntry = getChainConfig(posChainId);
    const supportedDexes = getSupportedDexes(posChainId);
    if (dex !== undefined) {
      if (supportedDexes.length === 0) {
        logger.warn(
          `Position ${tokenId} specifies dex "${dex}" but ${posChainEntry.chainName} has no multi-DEX config. Using chain defaults.`,
        );
      } else if (!supportedDexes.includes(dex)) {
        throw new Error(
          `Invalid dex "${dex}" for token_id ${tokenId} on ${posChainEntry.chainName}. Supported: ${supportedDexes.join(', ')}`,
        );
      }
    }

    if (tokenId === 0) {
      logger.warn(
        'Position with token_id 0 found — this is a placeholder. Update config.yaml with real token IDs.',
      );
    }

    if (!isValidStrategy(strategy)) {
      throw new Error(
        `Invalid strategy "${strategy}" for token_id ${tokenId}. Valid base strategies: ${VALID_BASE_STRATEGIES.join(', ')} (with optional _N or _Npct suffix)`,
      );
    }

    let widthTicks = params?.width_ticks as number | undefined;
    const widthPercentage = params?.width_percentage as number | undefined;
    let triggerDistanceTicks = params?.trigger_distance_ticks as number | undefined;
    const triggerPercentage = params?.trigger_percentage as number | undefined;
    const lowerRatioPercent = params?.lower_ratio_percent as number | undefined;

    // Check if strategy has preset width (e.g., pulse_300, center_3pct, bullish_6pct)
    const hasPresetWidth = PRESET_WIDTH_REGEX.test(strategy);

    // If width_ticks is missing but width_percentage is provided, convert it
    if ((!widthTicks || widthTicks <= 0) && widthPercentage && widthPercentage > 0) {
      widthTicks = percentageToTicks(widthPercentage);
    }

    // width_ticks is required for base strategies, optional for preset strategies
    if (!hasPresetWidth && (!widthTicks || widthTicks <= 0)) {
      throw new Error(`width_ticks or width_percentage must be a positive number for token_id ${tokenId} (strategy: ${strategy})`);
    }

    // If trigger_distance_ticks is missing but trigger_percentage is provided, convert it
    if ((triggerDistanceTicks === undefined || triggerDistanceTicks <= 0) && triggerPercentage && triggerPercentage > 0) {
      triggerDistanceTicks = percentageToTicks(triggerPercentage);
    }

    // Default trigger distance to 0 if still undefined
    triggerDistanceTicks = triggerDistanceTicks ?? 0;

    if (triggerDistanceTicks < 0) {
      throw new Error(`trigger_distance_ticks or trigger_percentage must be non-negative for token_id ${tokenId}`);
    }

    // Validate optional lower_ratio_percent if provided
    if (lowerRatioPercent !== undefined) {
      if (lowerRatioPercent < 0 || lowerRatioPercent > 100) {
        throw new Error(
          `lower_ratio_percent must be between 0 and 100 for token_id ${tokenId}, got ${lowerRatioPercent}`
        );
      }
    }

    // Convert critical_percentage to ticks if provided
    let criticalDistanceTicks = params?.critical_distance_ticks as number | undefined;
    const criticalPercentage = params?.critical_percentage as number | undefined;

    if ((criticalDistanceTicks === undefined || criticalDistanceTicks <= 0) && criticalPercentage && criticalPercentage > 0) {
      criticalDistanceTicks = percentageToTicks(criticalPercentage);
    }

    // Warn if critical_distance_ticks <= trigger_distance_ticks
    if (criticalDistanceTicks !== undefined && criticalDistanceTicks > 0 && criticalDistanceTicks <= triggerDistanceTicks) {
      logger.warn(
        `Position ${tokenId}: critical_distance_ticks (${criticalDistanceTicks}) <= trigger_distance_ticks (${triggerDistanceTicks}). ` +
          `Critical distance should be larger than trigger distance.`,
      );
    }

    const confirmMinutes = params?.confirm_minutes as number | undefined;
    const maxRebalancesPerWindow = params?.max_rebalances_per_window as number | undefined;
    const churnWindowHours = params?.churn_window_hours as number | undefined;
    const escalationWidth = params?.escalation_width as number | undefined;
    const killSwitch = params?.kill_switch as KillSwitchParams | undefined;

    // Validate gauge_address if provided
    const gaugeAddress = pos.gauge_address as string | undefined;
    if (gaugeAddress !== undefined) {
      if (!/^0x[0-9a-fA-F]{40}$/.test(gaugeAddress)) {
        throw new Error(`Invalid gauge_address "${gaugeAddress}" for token_id ${tokenId}. Must be a 0x-prefixed 40-hex address.`);
      }
      if (dex !== 'aerodrome-cl' && dex !== 'aerodrome-cl-gc') {
        logger.warn(
          `Position ${tokenId}: gauge_address is only supported for aerodrome-cl and aerodrome-cl-gc DEXes ` +
          `(dex="${dex ?? 'default'}") — gauge will be ignored`,
        );
      }
    }

    const validGauge = gaugeAddress !== undefined
      && /^0x[0-9a-fA-F]{40}$/.test(gaugeAddress)
      && (dex === 'aerodrome-cl' || dex === 'aerodrome-cl-gc');

    positions.push({
      token_id: tokenId,
      chain_id: posChainId,
      strategy: strategy as StrategyType,
      params: {
        width_ticks: widthTicks ?? 0,
        trigger_distance_ticks: triggerDistanceTicks,
        width_percentage: widthPercentage,
        trigger_percentage: triggerPercentage,
        ...(lowerRatioPercent !== undefined && { lower_ratio_percent: lowerRatioPercent }),
        ...(confirmMinutes !== undefined && { confirm_minutes: confirmMinutes }),
        // Critical distance params
        ...(criticalDistanceTicks !== undefined && criticalDistanceTicks > 0 && {
          critical_distance_ticks: criticalDistanceTicks,
        }),
        ...(criticalPercentage !== undefined && { critical_percentage: criticalPercentage }),
        // Anti-churn params
        ...(maxRebalancesPerWindow !== undefined && { max_rebalances_per_window: maxRebalancesPerWindow }),
        ...(churnWindowHours !== undefined && { churn_window_hours: churnWindowHours }),
        ...(escalationWidth !== undefined && { escalation_width: escalationWidth }),
        // Kill switch params
        ...(killSwitch !== undefined && { kill_switch: killSwitch }),
        // Cost-benefit gate params
        ...(params?.cost_benefit_enabled !== undefined && {
          cost_benefit_enabled: params.cost_benefit_enabled as boolean,
        }),
        ...(params?.min_fee_to_cost_ratio !== undefined && {
          min_fee_to_cost_ratio: params.min_fee_to_cost_ratio as number,
        }),
      },
      ...(dex !== undefined && { dex }),
      ...(validGauge && { gauge_address: gaugeAddress }),
    });
  }

  // 5. Use verified contract addresses from default chain's registry (not overridable via config.yaml for security)
  const contractsConfig = {
    nonfungiblePositionManager: defaultChainEntry.contracts.nonfungiblePositionManager,
    swapRouter: defaultChainEntry.contracts.swapRouter,
    factory: defaultChainEntry.contracts.factory,
    quoter: defaultChainEntry.contracts.quoter,
  };

  // 8. Build notifications config — Telegram secrets from .env (fallback to yaml for backwards compat)
  const rawNotifications = raw.notifications as Record<string, unknown> | undefined;
  const rawPrefs = rawNotifications?.preferences as Record<string, boolean> | undefined;
  const notificationsConfig = {
    enabled: (rawNotifications?.enabled as boolean) ?? false,
    telegram_bot_token: process.env.TELEGRAM_BOT_TOKEN ?? (rawNotifications?.telegram_bot_token as string | undefined),
    telegram_chat_id: process.env.TELEGRAM_CHAT_ID ?? (rawNotifications?.telegram_chat_id as string | undefined),
    discord_webhook_url: rawNotifications?.discord_webhook_url as string | undefined,
    preferences: rawPrefs ? {
      rebalance_success: rawPrefs.rebalance_success,
      rebalance_failure: rawPrefs.rebalance_failure,
      approaching_range: rawPrefs.approaching_range,
      confirm_timer: rawPrefs.confirm_timer,
      daily_summary: rawPrefs.daily_summary,
      fee_collection: rawPrefs.fee_collection,
    } : undefined,
  };

  // 9. Build analytics config (disabled by default)
  const rawAnalytics = raw.analytics as Record<string, unknown> | undefined;
  const analyticsConfig = {
    enabled: (rawAnalytics?.enabled as boolean) ?? false,
    snapshot_interval_minutes: (rawAnalytics?.snapshot_interval_minutes as number) ?? 10,
    persist_to_disk: (rawAnalytics?.persist_to_disk as boolean) ?? true,
    storage_path: (rawAnalytics?.storage_path as string) ?? './analytics',
  };

  // 7. Validate swap provider (based on default chain's aggregator support)
  const oneinchApiKey = process.env.ONEINCH_API_KEY;
  const defaultSwapProvider: SwapProvider = defaultChainEntry.aggregators.piteas
    ? 'piteas'
    : (defaultChainEntry.aggregators.oneinch && oneinchApiKey) ? 'oneinch' : 'direct';
  const swapProvider = (raw.swap_provider as string | undefined) ?? defaultSwapProvider;
  if (!VALID_SWAP_PROVIDERS.includes(swapProvider as SwapProvider)) {
    throw new Error(
      `Invalid swap_provider "${swapProvider}". Valid options: ${VALID_SWAP_PROVIDERS.join(', ')}`,
    );
  }

  if (swapProvider === 'piteas' && !defaultChainEntry.aggregators.piteas) {
    logger.warn(
      `Piteas aggregator is not available on ${defaultChainEntry.chainName}. Falling back to direct swaps.`,
    );
  }
  if (swapProvider === 'oneinch' && !defaultChainEntry.aggregators.oneinch) {
    logger.warn(
      `1inch aggregator is not available on ${defaultChainEntry.chainName}. Falling back to direct swaps.`,
    );
  }
  if (swapProvider === 'oneinch' && !oneinchApiKey) {
    logger.warn(
      '1inch aggregator requires ONEINCH_API_KEY in .env. Falling back to direct swaps.',
    );
  }

  // 8. Assemble final config
  const config: AppConfig = {
    polling_interval_seconds: (raw.polling_interval_seconds as number) ?? 30,
    max_gas_price_gwei: (raw.max_gas_price_gwei as number) ?? 500,
    dry_run: (raw.dry_run as boolean) ?? true,
    slippage_tolerance_bps: (() => {
      const bps = (raw.slippage_tolerance_bps as number) ?? 100;
      if (typeof bps !== 'number' || bps < 1 || bps > 200) {
        throw new Error(`slippage_tolerance_bps must be between 1 and 200 (max 2%), got ${bps}`);
      }
      return bps;
    })(),
    rebalance_cooldown_seconds: (raw.rebalance_cooldown_seconds as number) ?? 300,
    swap_provider: (() => {
      if (swapProvider === 'piteas' && !defaultChainEntry.aggregators.piteas) return 'direct' as SwapProvider;
      if (swapProvider === 'oneinch' && (!defaultChainEntry.aggregators.oneinch || !oneinchApiKey)) return 'direct' as SwapProvider;
      return swapProvider as SwapProvider;
    })(),
    contracts: contractsConfig,
    chain: defaultChainConfig,
    chains,
    rpcUrlsByChain,
    notifications: notificationsConfig,
    positions,
    privateKey,
    rpcUrls,
    analytics: analyticsConfig,
    ...(oneinchApiKey && { oneinchApiKey }),
  };

  if (config.dry_run) {
    logger.info('DRY RUN MODE ENABLED — no transactions will be executed');
  }

  logger.info(`Loaded ${positions.length} position(s) from config`);
  return config;
}

import { ethers } from 'ethers';
import type { ChainContext } from '../../chain.js';
import type { ContractInstances } from '../../contracts.js';
import type { MultiChainContext } from '../../multiChain.js';
import type { AppConfig, PositionConfig } from '../../types.js';
import { CHAIN_REGISTRY } from '../../config/chains.js';
import { getTokenPrices } from './priceService.js';
import logger from '../../logger.js';

const SHADOW_MIXED_PAIRS_URL = 'https://shadow-api-v2-production.up.railway.app/mixed-pairs?includeTokens=False';
const SHADOW_REWARD_GAUGE_ABI = [
  'function getRewardTokens() view returns (address[])',
  'function earned(address token, uint256 tokenId) view returns (uint256)',
] as const;
const CACHE_TTL_MS = 5 * 60 * 1000;

interface ShadowRewardPositionInput {
  tokenId: number;
  chainId: number;
  poolAddress?: string;
  gaugeAddress?: string;
}

export interface ShadowRewardTokenSummary {
  tokenAddress: string;
  symbol: string;
  amount: string;
  valueUsd: number;
}

export interface ShadowRewardSummary {
  gaugeAddress: string;
  claimableRewardsUsd: number;
  rewardTokens: ShadowRewardTokenSummary[];
}

let cachedPoolGaugeMap: { expiresAt: number; value: Map<string, string> } | null = null;

function extractAddress(value: unknown): string | undefined {
  if (typeof value === 'string' && ethers.isAddress(value)) return value;
  if (!value || typeof value !== 'object') return undefined;

  const record = value as Record<string, unknown>;
  for (const key of ['address', 'id', 'poolAddress', 'gaugeAddress']) {
    const candidate = record[key];
    if (typeof candidate === 'string' && ethers.isAddress(candidate)) return candidate;
  }

  return undefined;
}

function getPairsFromPayload(payload: unknown): unknown[] {
  if (Array.isArray(payload)) return payload;
  if (!payload || typeof payload !== 'object') return [];

  const record = payload as Record<string, unknown>;
  for (const key of ['pairs', 'data', 'results']) {
    const candidate = record[key];
    if (Array.isArray(candidate)) return candidate;
  }

  return [];
}

async function getShadowPoolGaugeMap(): Promise<Map<string, string>> {
  if (cachedPoolGaugeMap && cachedPoolGaugeMap.expiresAt > Date.now()) {
    return cachedPoolGaugeMap.value;
  }

  const response = await fetch(SHADOW_MIXED_PAIRS_URL, {
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(10_000),
  });

  if (!response.ok) {
    throw new Error(`Shadow mixed-pairs request failed: ${response.status}`);
  }

  const payload = await response.json();
  const pairs = getPairsFromPayload(payload);
  const poolGaugeMap = new Map<string, string>();

  for (const pair of pairs) {
    if (!pair || typeof pair !== 'object') continue;
    const record = pair as Record<string, unknown>;
    const poolAddress = extractAddress(record.address) ?? extractAddress(record.pool) ?? extractAddress(record.id);
    const gaugeAddress = extractAddress(record.gaugeV2) ?? extractAddress(record.gauge) ?? extractAddress(record.gaugeAddress);
    if (!poolAddress || !gaugeAddress) continue;
    poolGaugeMap.set(poolAddress.toLowerCase(), gaugeAddress);
  }

  cachedPoolGaugeMap = {
    expiresAt: Date.now() + CACHE_TTL_MS,
    value: poolGaugeMap,
  };

  return poolGaugeMap;
}

function resolvePositionConfig(
  config: AppConfig,
  multiChain: MultiChainContext | undefined,
  chainId: number,
  tokenId: number,
): PositionConfig | undefined {
  return config.positions.find((position) => {
    const resolvedChainId = multiChain ? multiChain.resolveChainId(position) : (position.chain_id ?? config.chain.chainId);
    return resolvedChainId === chainId && position.token_id === tokenId;
  });
}

export async function getShadowRewardSummaries(
  positions: ShadowRewardPositionInput[],
  config: AppConfig,
  chain: ChainContext,
  contracts: ContractInstances,
  multiChain?: MultiChainContext,
): Promise<Map<number, ShadowRewardSummary>> {
  const sonicPositions = positions.filter((position) => position.chainId === 146);
  if (sonicPositions.length === 0) {
    return new Map();
  }

  const unresolvedPoolAddresses = sonicPositions
    .filter((position) => !position.gaugeAddress && position.poolAddress)
    .map((position) => position.poolAddress!.toLowerCase());

  let poolGaugeMap = new Map<string, string>();
  if (unresolvedPoolAddresses.length > 0) {
    try {
      poolGaugeMap = await getShadowPoolGaugeMap();
    } catch (error) {
      logger.warn('Failed to resolve Shadow gauge addresses from mixed-pairs API', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const summaries = await Promise.all(
    sonicPositions.map(async (position) => {
      const gaugeAddress = position.gaugeAddress ?? (position.poolAddress ? poolGaugeMap.get(position.poolAddress.toLowerCase()) : undefined);
      if (!gaugeAddress) return null;

      const positionConfig = resolvePositionConfig(config, multiChain, position.chainId, position.tokenId);
      const positionChain = multiChain ? multiChain.getChainById(position.chainId) : chain;
      const positionContracts = positionConfig && multiChain ? multiChain.getContracts(positionConfig) : contracts;
      const gauge = new ethers.Contract(gaugeAddress, SHADOW_REWARD_GAUGE_ABI, positionChain.provider);

      try {
        const rewardTokenAddressesRaw = await gauge.getRewardTokens();
        const rewardTokenAddresses = [...new Set(
          (rewardTokenAddressesRaw as string[])
            .filter((address) => ethers.isAddress(address))
            .map((address) => address.toLowerCase()),
        )];

        if (rewardTokenAddresses.length === 0) {
          return {
            tokenId: position.tokenId,
            summary: {
              gaugeAddress,
              claimableRewardsUsd: 0,
              rewardTokens: [],
            },
          };
        }

        const rewardTokenPrices = await getTokenPrices(
          rewardTokenAddresses,
          CHAIN_REGISTRY[position.chainId]?.dexScreenerSlug ?? 'sonic',
        );

        const rewardTokens = await Promise.all(
          rewardTokenAddresses.map(async (rewardTokenAddress) => {
            const erc20 = positionContracts.getERC20(rewardTokenAddress);
            const [earnedRaw, decimalsRaw, symbolRaw] = await Promise.all([
              gauge.earned(rewardTokenAddress, BigInt(position.tokenId)) as Promise<bigint>,
              erc20.decimals().catch(() => 18),
              erc20.symbol().catch(() => 'UNKNOWN'),
            ]);

            if (earnedRaw === 0n) return null;

            const decimals = Number(decimalsRaw);
            const amountFormatted = Number(ethers.formatUnits(earnedRaw, decimals));
            const valueUsd = amountFormatted * (rewardTokenPrices.get(rewardTokenAddress) ?? 0);

            return {
              tokenAddress: rewardTokenAddress,
              symbol: typeof symbolRaw === 'string' ? symbolRaw : 'UNKNOWN',
              amount: earnedRaw.toString(),
              valueUsd,
            } satisfies ShadowRewardTokenSummary;
          }),
        );

        const nonZeroRewards = rewardTokens.filter((reward): reward is ShadowRewardTokenSummary => reward !== null);
        return {
          tokenId: position.tokenId,
          summary: {
            gaugeAddress,
            claimableRewardsUsd: nonZeroRewards.reduce((sum, reward) => sum + reward.valueUsd, 0),
            rewardTokens: nonZeroRewards,
          },
        };
      } catch (error) {
        logger.warn('Failed to fetch Shadow reward summary', {
          tokenId: position.tokenId,
          chainId: position.chainId,
          gaugeAddress,
          error: error instanceof Error ? error.message : String(error),
        });
        return null;
      }
    }),
  );

  return new Map(
    summaries
      .filter((entry): entry is { tokenId: number; summary: ShadowRewardSummary } => entry !== null)
      .map((entry) => [entry.tokenId, entry.summary]),
  );
}
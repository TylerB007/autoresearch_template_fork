/**
 * Dashboard route — aggregated overview of wallet, positions, and bot status
 */

import { Router, type Request, type Response } from 'express';
import { ethers } from 'ethers';
import type { ContractInstances } from '../../contracts.js';
import type { ChainContext } from '../../chain.js';
import type { AppConfig } from '../../types.js';
import type { MultiChainContext } from '../../multiChain.js';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { reloadPositions } from '../../configLoader.js';
import { getPositionStatus } from '../../position.js';
import { getTokenPrices } from '../services/priceService.js';
import { getMintTimestamp, calculateLifetimeAPR } from '../../mintDate.js';
import { queryAllChainFeeCollections, queryAllChainRebalances } from '../../analytics/storage.js';
import { CHAIN_REGISTRY } from '../../config/chains.js';
import { isSafeMode, getSafeModePositions, posKey, getRebalanceLockAgeMs } from '../../rebalancer.js';
import { isKillSwitchTriggered, getKillSwitchStatus } from '../../killSwitch.js';
import { getShadowRewardSummaries } from '../services/shadowRewards.js';
import logger from '../../logger.js';

const router = Router();
const DISABLE_FLAG_PATH = resolve(process.cwd(), '.rebalancing-disabled');

/** Read when a position first went OOR from the bot's cross-process file. */
function readOorSinceMs(chainId: number, tokenId: number): number | null {
  const p = resolve(process.cwd(), `.oor-since-${chainId}-${tokenId}`);
  if (!existsSync(p)) return null;
  try {
    const ms = parseInt(readFileSync(p, 'utf8').trim(), 10);
    return isNaN(ms) ? null : ms;
  } catch { return null; }
}

const startTime = Date.now();

const bigIntReplacer = (_key: string, value: unknown): unknown =>
  typeof value === 'bigint' ? value.toString() : value;

export function createDashboardRouter(
  config: AppConfig,
  chain: ChainContext,
  contracts: ContractInstances,
  multiChain?: MultiChainContext,
): Router {
  // GET /api/dashboard
  router.get('/', async (_req: Request, res: Response) => {
    try {
      // Re-read positions from config.yaml so dashboard stays in sync with Telegram/rebalancer changes
      reloadPositions(config);

      // Wallet native balances (per-chain)
      const balanceWei = await chain.provider.getBalance(chain.wallet.address);
      const balancePLS = ethers.formatEther(balanceWei);

      // Per-chain balances for multi-chain
      const chainBalances: Array<{ chainId: number; chainName: string; nativeSymbol: string; balance: string }> = [];
      if (multiChain) {
        for (const chainId of multiChain.getChainIds()) {
          const cc = multiChain.getChainById(chainId);
          const ccfg = multiChain.getChainConfig(chainId);
          try {
            const bal = await cc.provider.getBalance(cc.wallet.address);
            chainBalances.push({
              chainId,
              chainName: ccfg.chainName,
              nativeSymbol: ccfg.nativeCurrencySymbol,
              balance: ethers.formatEther(bal),
            });
          } catch { /* skip failed chains */ }
        }
      }

      // Position statuses
      const positionStatuses = [];
      for (const pos of config.positions) {
        try {
          const posChain = multiChain ? multiChain.getChainById(multiChain.resolveChainId(pos)) : chain;
          const posContracts = multiChain ? multiChain.getContracts(pos) : contracts;
          const status = await getPositionStatus(pos.token_id, posContracts, posChain);
          const posChainId = multiChain ? multiChain.resolveChainId(pos) : config.chain.chainId;
          const posChainName = multiChain ? multiChain.getChainConfig(posChainId).chainName : config.chain.chainName;
          positionStatuses.push({
            token_id: pos.token_id,
            chain_id: posChainId,
            chain_name: posChainName,
            dex: pos.dex,
            strategy: pos.strategy,
            is_in_range: status.isInRange,
            tick_distance: status.tickDistance,
            pool_address: status.pool.address,
            token0_symbol: status.token0Info.symbol,
            token1_symbol: status.token1Info.symbol,
            token0_address: status.token0Info.address,
            token1_address: status.token1Info.address,
            token0_decimals: status.token0Info.decimals,
            token1_decimals: status.token1Info.decimals,
            amount0: status.amount0.toString(),
            amount1: status.amount1.toString(),
            current_tick: status.pool.currentTick,
            tick_lower: status.position.tickLower,
            tick_upper: status.position.tickUpper,
            liquidity: status.position.liquidity.toString(),
            unclaimed_fees0: status.unclaimedFees0.toString(),
            unclaimed_fees1: status.unclaimedFees1.toString(),
            gauge_address: pos.gauge_address,
          });
        } catch (err) {
          logger.error('Failed to fetch position status', {
            token_id: pos.token_id,
            chain_id: pos.chain_id ?? config.chain.chainId,
            error: err instanceof Error ? err.message : String(err),
          });
          const errChainId = pos.chain_id ?? config.chain.chainId;
          positionStatuses.push({
            token_id: pos.token_id,
            strategy: pos.strategy,
            chain_id: errChainId,
            chain_name: CHAIN_REGISTRY[errChainId]?.chainName ?? config.chain.chainName,
            dex: pos.dex,
            error: 'Failed to fetch position status',
          });
        }
      }

      // Collect unique token addresses grouped by DexScreener slug for price lookup
      const tokensBySlug = new Map<string, Set<string>>();
      for (const p of positionStatuses) {
        if (!('token0_address' in p) || !p.token0_address) continue;
        const chainId = 'chain_id' in p ? (p.chain_id as number) : config.chain.chainId;
        const slug = CHAIN_REGISTRY[chainId]?.dexScreenerSlug ?? config.chain.dexScreenerSlug;
        if (!tokensBySlug.has(slug)) tokensBySlug.set(slug, new Set());
        const slugAddrs = tokensBySlug.get(slug)!;
        slugAddrs.add(p.token0_address as string);
        if ('token1_address' in p && p.token1_address) slugAddrs.add(p.token1_address as string);
      }

      // Fetch USD prices per chain slug in parallel
      const prices = new Map<string, number>();
      await Promise.all(
        [...tokensBySlug.entries()].map(async ([slug, addrs]) => {
          const result = await getTokenPrices([...addrs], slug);
          for (const [addr, price] of result) prices.set(addr, price);
        }),
      );

      const shadowRewardSummaries = await getShadowRewardSummaries(
        positionStatuses.map((position) => ({
          tokenId: position.token_id,
          chainId: 'chain_id' in position ? position.chain_id as number : config.chain.chainId,
          poolAddress: 'pool_address' in position ? position.pool_address as string | undefined : undefined,
          gaugeAddress: 'gauge_address' in position ? position.gauge_address as string | undefined : undefined,
        })),
        config,
        chain,
        contracts,
        multiChain,
      );

      const uptimeMs = Date.now() - startTime;
      const uptimeSeconds = Math.floor(uptimeMs / 1000);

      const inRange = positionStatuses.filter((p) => 'is_in_range' in p && p.is_in_range).length;
      const outOfRange = positionStatuses.filter((p) => 'is_in_range' in p && !p.is_in_range).length;

      // Compute per-position USD value and lifetime APR
      const storagePath = config.analytics?.storage_path ?? './analytics';
      let allRebalances: Awaited<ReturnType<typeof queryAllChainRebalances>> = [];
      try {
        allRebalances = await queryAllChainRebalances(storagePath);
      } catch { /* analytics unavailable */ }

      const positionListWithMetrics = await Promise.all(
        positionStatuses.map(async (p) => {
          const priceUsd0 = 'token0_address' in p ? (prices.get((p.token0_address as string).toLowerCase()) ?? 0) : 0;
          const priceUsd1 = 'token1_address' in p ? (prices.get((p.token1_address as string).toLowerCase()) ?? 0) : 0;

          let positionValueUsd = 0;
          let lifetimeAPR = 0;
          let unclaimedFeesUsd = 0;
          let claimedFeesUsd = 0;
          let totalFeesUsd = 0;
          let claimableRewardsUsd = 0;
          let claimableYieldUsd = 0;
          let totalEarningsUsd = 0;
          let ageMs = 0;
          let rebalanceCount = 0;

          if ('amount0' in p && 'token0_decimals' in p) {
            const d0 = p.token0_decimals as number;
            const d1 = p.token1_decimals as number;
            const amount0 = BigInt(p.amount0 as string);
            const amount1 = BigInt(p.amount1 as string);
            positionValueUsd =
              (Number(amount0) / 10 ** d0) * priceUsd0 +
              (Number(amount1) / 10 ** d1) * priceUsd1;

            // Unclaimed fees
            if ('unclaimed_fees0' in p) {
              unclaimedFeesUsd =
                (Number(BigInt(p.unclaimed_fees0 as string)) / 10 ** d0) * priceUsd0 +
                (Number(BigInt(p.unclaimed_fees1 as string)) / 10 ** d1) * priceUsd1;
            }

            // Rebalance count and claimed fees from analytics
            const posRebalances = allRebalances.filter(r => r.oldTokenId === p.token_id || r.newTokenId === p.token_id);
            rebalanceCount = posRebalances.length;
            for (const rb of posRebalances) {
              const rd0 = rb.preSnapshot.token0Decimals;
              const rd1 = rb.preSnapshot.token1Decimals;
              claimedFeesUsd +=
                (Number(rb.feesCollected0) / 10 ** rd0) * priceUsd0 +
                (Number(rb.feesCollected1) / 10 ** rd1) * priceUsd1;
            }
            try {
              const feeCollections = await queryAllChainFeeCollections(storagePath, p.token_id);
              for (const fc of feeCollections) {
                claimedFeesUsd += fc.totalValueUsd;
              }
            } catch { /* ignore */ }

            totalFeesUsd = claimedFeesUsd + unclaimedFeesUsd;
            claimableRewardsUsd = shadowRewardSummaries.get(p.token_id)?.claimableRewardsUsd ?? 0;
            claimableYieldUsd = unclaimedFeesUsd + claimableRewardsUsd;
            totalEarningsUsd = claimedFeesUsd + claimableYieldUsd;

            // Calculate lifetime APR from fees and age
            try {
              // Resolve per-position chain for mint timestamp query
              const posRef = config.positions.find(pp => pp.token_id === p.token_id);
              const mintChain = posRef && multiChain ? multiChain.getChainById(multiChain.resolveChainId(posRef)) : chain;
              const mintContracts = posRef && multiChain ? multiChain.getContracts(posRef) : contracts;
              const mintTimestamp = await getMintTimestamp(p.token_id, mintContracts, mintChain);
              ageMs = mintTimestamp ? Date.now() - mintTimestamp : 0;

              if (ageMs > 0 && positionValueUsd > 0) {
                lifetimeAPR = calculateLifetimeAPR(totalEarningsUsd || totalFeesUsd, positionValueUsd, ageMs);
              }
            } catch { /* mint date unavailable */ }
          }

          const resolvedChainId = 'chain_id' in p ? p.chain_id : config.chain.chainId;
          const posInRange = 'is_in_range' in p ? p.is_in_range : false;
          return {
            tokenId: p.token_id,
            chainId: resolvedChainId,
            chainName: 'chain_name' in p ? p.chain_name : config.chain.chainName,
            pair: 'token0_symbol' in p ? `${p.token0_symbol}/${p.token1_symbol}` : 'Unknown',
            strategy: p.strategy,
            inRange: posInRange,
            currentTick: 'current_tick' in p ? p.current_tick : 0,
            tickLower: 'tick_lower' in p ? p.tick_lower : 0,
            tickUpper: 'tick_upper' in p ? p.tick_upper : 0,
            token0Decimals: 'token0_decimals' in p ? p.token0_decimals : 18,
            token1Decimals: 'token1_decimals' in p ? p.token1_decimals : 18,
            priceUsd0,
            priceUsd1,
            positionValueUsd,
            lifetimeAPR,
            totalFeesUsd,
            totalEarningsUsd,
            unclaimedFeesUsd,
            claimableRewardsUsd,
            claimableYieldUsd,
            claimedFeesUsd,
            ageMs,
            rebalanceCount,
            outOfRangeSinceMs: posInRange ? null : readOorSinceMs(resolvedChainId, p.token_id),
            rewardSymbols: shadowRewardSummaries.get(p.token_id)?.rewardTokens.map((reward) => reward.symbol) ?? [],
            gaugeAddress: shadowRewardSummaries.get(p.token_id)?.gaugeAddress ?? ('gauge_address' in p ? p.gauge_address : undefined),
          };
        }),
      );

      // Aggregate total unclaimed fees across all positions
      const totalUnclaimedFeesUsd = positionListWithMetrics.reduce(
        (sum, p) => sum + (p.unclaimedFeesUsd ?? 0), 0,
      );
      const totalClaimableUsd = positionListWithMetrics.reduce(
        (sum, p) => sum + (p.claimableYieldUsd ?? p.unclaimedFeesUsd ?? 0), 0,
      );

      // Wallet token balances (undeployed holdings) — query all configured chains
      const walletTokens: Array<{
        symbol: string;
        address: string;
        balance: string;
        decimals: number;
        balanceFormatted: number;
        valueUsd: number;
        chainId: number;
        chainName: string;
      }> = [];
      try {
        // Build per-chain token lists and query balances
        const chainIds = multiChain ? multiChain.getChainIds() : [config.chain.chainId];
        for (const cid of chainIds) {
          const chainEntry = CHAIN_REGISTRY[cid];
          if (!chainEntry) continue;
          const cc = multiChain ? multiChain.getChainById(cid) : chain;
          const cContracts = multiChain ? multiChain.registries.get(cid)!.getForDex() : contracts;

          // Gather token entries for this chain from registry
          const tokenEntries = Object.entries(chainEntry.tokens) as [string, string][];
          // Also include position token addresses on this chain
          for (const pos of config.positions) {
            const posChainId = pos.chain_id ?? config.chain.chainId;
            if (posChainId !== cid) continue;
            const ps = positionStatuses.find(p => p.token_id === pos.token_id);
            if (ps && 'token0_address' in ps) {
              const t0 = ps.token0_address as string;
              const t1 = ps.token1_address as string;
              if (!tokenEntries.some(([, a]) => a.toLowerCase() === t0.toLowerCase())) {
                tokenEntries.push([('token0_symbol' in ps ? ps.token0_symbol as string : 'Unknown'), t0]);
              }
              if (!tokenEntries.some(([, a]) => a.toLowerCase() === t1.toLowerCase())) {
                tokenEntries.push([('token1_symbol' in ps ? ps.token1_symbol as string : 'Unknown'), t1]);
              }
            }
          }

          // Fetch prices for this chain's tokens using the correct DexScreener slug
          const allAddrs = tokenEntries.map(([, a]) => a);
          const chainPrices = allAddrs.length > 0
            ? await getTokenPrices(allAddrs, chainEntry.dexScreenerSlug)
            : new Map<string, number>();

          await Promise.all(
            tokenEntries.map(async ([symbol, address]) => {
              try {
                const erc20 = cContracts.getERC20(address);
                const [bal, decs]: [bigint, number] = await Promise.all([
                  erc20.balanceOf(cc.wallet.address),
                  erc20.decimals().then(Number).catch(() => 18),
                ]);
                if (bal === 0n) return;
                const balFormatted = Number(bal) / 10 ** decs;
                const priceUsd = chainPrices.get(address.toLowerCase()) ?? 0;
                walletTokens.push({
                  symbol,
                  address,
                  balance: bal.toString(),
                  decimals: decs,
                  balanceFormatted: balFormatted,
                  valueUsd: balFormatted * priceUsd,
                  chainId: cid,
                  chainName: chainEntry.chainName,
                });
              } catch { /* skip tokens that fail */ }
            }),
          );
        }
        // Sort by USD value descending
        walletTokens.sort((a, b) => b.valueUsd - a.valueUsd);
      } catch { /* wallet token query failed */ }

      const response = {
        wallet: {
          address: chain.wallet.address,
          plsBalance: balancePLS,
        },
        chainBalances,
        positions: {
          total: positionStatuses.length,
          inRange,
          outOfRange,
        },
        botMode: config.dry_run ? 'DRY_RUN' : 'LIVE',
        positionList: positionListWithMetrics,
        totalUnclaimedFeesUsd,
        totalClaimableUsd,
        walletTokens,
        bot: {
          uptime_seconds: uptimeSeconds,
          dry_run: config.dry_run,
          polling_interval_seconds: config.polling_interval_seconds,
        },
        botState: {
          rebalancingEnabled: !existsSync(DISABLE_FLAG_PATH),
          safeModePositions: getSafeModePositions(),
          positionStates: config.positions.map((pos) => {
            const cid = pos.chain_id ?? config.chain.chainId;
            const pk = posKey(cid, pos.token_id);
            const ks = getKillSwitchStatus(pk);
            return {
              tokenId: pos.token_id,
              chainId: cid,
              inSafeMode: isSafeMode(pk),
              killSwitch: {
                triggered: isKillSwitchTriggered(pk),
                reason: ks?.reason,
                disabledAt: ks?.disabledAt,
                consecutiveLosses: ks?.consecutiveLosses ?? 0,
              },
              rebalanceLockAgeMs: getRebalanceLockAgeMs(cid, pos.token_id),
            };
          }),
        },
      };

      res.json(JSON.parse(JSON.stringify(response, bigIntReplacer)));
    } catch (err) {
      logger.error('Dashboard error', { error: err instanceof Error ? err.message : String(err) });
      res.status(500).json({ error: 'Failed to fetch dashboard data' });
    }
  });

  return router;
}

export default router;

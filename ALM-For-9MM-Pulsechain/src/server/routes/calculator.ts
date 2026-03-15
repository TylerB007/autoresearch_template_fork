/**
 * Calculator routes — LP split calculator for new positions
 *
 * Flow:
 * 1. GET /pairs — returns known token pairs for dropdown
 * 2. GET /pool-state — returns live pool state (price, tick, tickSpacing, token info)
 * 3. GET /split — given tickLower, tickUpper, and user balances, compute target split + swap
 */

import { Router, type Request, type Response } from 'express';
import type { ContractInstances } from '../../contracts.js';
import type { ChainContext } from '../../chain.js';
import type { AppConfig } from '../../types.js';
import type { MultiChainContext } from '../../multiChain.js';
import { getPoolAddress, getPoolState, getTokenInfo } from '../../pool.js';
import { getTokenPrices } from '../services/priceService.js';
import {
  tickToSqrtPriceX96,
  getAmountsForLiquidity,
  tickToPrice,
  priceToTick,
  nearestUsableTick,
} from '../../math.js';
import { getTickSpacing, feeToPercent } from '../../config/fees.js';
import { TOKENS } from '../../config/contracts.js';
import { CHAIN_REGISTRY } from '../../config/chains.js';
import logger from '../../logger.js';

const bigIntReplacer = (_key: string, value: unknown): unknown =>
  typeof value === 'bigint' ? value.toString() : value;

/** Known token pairs for the dropdown — add more as needed */
const KNOWN_PAIRS = [
  { label: 'HEX / WPLS', token0: TOKENS.HEX, token1: TOKENS.WPLS, fee: 2500 },
  { label: 'PLSX / WPLS', token0: TOKENS.PLSX, token1: TOKENS.WPLS, fee: 2500 },
  { label: 'HEX / PLSX', token0: TOKENS.HEX, token1: TOKENS.PLSX, fee: 2500 },
  { label: 'WETH / WPLS', token0: TOKENS.WETH, token1: TOKENS.WPLS, fee: 2500 },
];

function formatTokenAmount(raw: bigint, decimals: number): string {
  const whole = raw / 10n ** BigInt(decimals);
  const frac = raw % 10n ** BigInt(decimals);
  const fracStr = frac.toString().padStart(decimals, '0').slice(0, 2);
  const wholeStr = whole.toLocaleString('en-US');
  return `${wholeStr}.${fracStr}`;
}

function formatPriceNum(price: number): string {
  if (price >= 1000) return price.toLocaleString('en-US', { maximumFractionDigits: 2 });
  if (price >= 1) return price.toFixed(4);
  if (price >= 0.0001) return price.toFixed(6);
  return price.toExponential(4);
}

export function createCalculatorRouter(
  config: AppConfig,
  chain: ChainContext,
  contracts: ContractInstances,
  multiChain?: MultiChainContext,
): Router {
  const router = Router();

  /** Resolve chain context and contracts from optional chainId + dex query params */
  function resolveChain(chainIdStr?: string, dex?: string): { reqChain: ChainContext; reqContracts: ContractInstances; chainSlug: string } {
    if (chainIdStr && multiChain) {
      const chainId = parseInt(chainIdStr, 10);
      if (!isNaN(chainId) && CHAIN_REGISTRY[chainId]) {
        // Build a minimal PositionConfig to resolve contracts via the standard path
        const posStub = { token_id: 0, strategy: 'center' as const, params: { width_ticks: 0, trigger_distance_ticks: 0 }, chain_id: chainId, dex };
        return {
          reqChain: multiChain.getChainById(chainId),
          reqContracts: multiChain.getContracts(posStub),
          chainSlug: CHAIN_REGISTRY[chainId].dexScreenerSlug,
        };
      }
    }
    return { reqChain: chain, reqContracts: contracts, chainSlug: config.chain.dexScreenerSlug };
  }

  /**
   * GET /api/calculator/chains
   * Returns all configured chains for the chain selector dropdown
   */
  router.get('/chains', (_req: Request, res: Response) => {
    const chainIds = multiChain ? multiChain.getChainIds() : [config.chain.chainId];
    const chains = chainIds.map(id => {
      const entry = CHAIN_REGISTRY[id];
      return entry ? {
        chainId: id,
        chainName: entry.chainName,
        protocolName: entry.protocolName,
        nativeCurrency: entry.nativeCurrencySymbol,
        dexes: entry.dexes ? Object.keys(entry.dexes) : undefined,
      } : null;
    }).filter(Boolean);
    res.json(chains);
  });

  /**
   * GET /api/calculator/pairs?chainId=<optional>
   * Returns known token pairs for the dropdown.
   * When chainId is specified, returns active positions on that chain instead of hardcoded pairs.
   */
  router.get('/pairs', (req: Request, res: Response) => {
    const chainIdStr = req.query.chainId as string | undefined;
    if (chainIdStr) {
      const chainId = parseInt(chainIdStr, 10);
      const chainEntry = CHAIN_REGISTRY[chainId];
      if (!chainEntry) {
        res.status(400).json({ error: `Unknown chain ID: ${chainId}` });
        return;
      }
      // Return positions on that chain as pair options
      const chainPositions = config.positions
        .filter(p => (p.chain_id ?? config.chain.chainId) === chainId)
        .map(p => ({
          label: `#${p.token_id} (${p.strategy})`,
          token_id: p.token_id,
        }));
      res.json({ chainId, chainName: chainEntry.chainName, positions: chainPositions });
      return;
    }
    res.json(KNOWN_PAIRS.map((p) => ({
      label: p.label,
      token0: p.token0,
      token1: p.token1,
      fee: p.fee,
    })));
  });

  /**
   * GET /api/calculator/pool-state
   * Fetches live pool state for a given pair.
   * Query: token0, token1, fee
   * Returns: currentTick, tickSpacing, price, token info, pool address
   */
  router.get('/pool-state', async (req: Request, res: Response) => {
    try {
      const { token0, token1, fee: feeStr, chainId: chainIdStr } = req.query;

      if (!token0 || !token1 || !feeStr) {
        res.status(400).json({ error: 'Required params: token0, token1, fee' });
        return;
      }

      const fee = parseInt(feeStr as string);
      if (isNaN(fee)) {
        res.status(400).json({ error: 'fee must be a number' });
        return;
      }

      let tickSpacing: number;
      try {
        tickSpacing = getTickSpacing(fee);
      } catch {
        res.status(400).json({ error: `Unsupported fee tier: ${fee}` });
        return;
      }

      const { reqChain, reqContracts, chainSlug } = resolveChain(chainIdStr as string | undefined);

      const poolAddress = await getPoolAddress(
        reqContracts,
        token0 as string,
        token1 as string,
        fee,
        reqChain,
      );

      const token0Contract = reqContracts.getERC20(token0 as string);
      const token1Contract = reqContracts.getERC20(token1 as string);

      const [poolState, token0Info, token1Info, prices, balance0Raw, balance1Raw] = await Promise.all([
        getPoolState(poolAddress, reqContracts, reqChain),
        getTokenInfo(token0 as string, reqContracts, reqChain),
        getTokenInfo(token1 as string, reqContracts, reqChain),
        getTokenPrices([token0 as string, token1 as string], chainSlug),
        reqChain.withRetry(async () => token0Contract.balanceOf(reqChain.wallet.address)),
        reqChain.withRetry(async () => token1Contract.balanceOf(reqChain.wallet.address)),
      ]);

      const d0 = token0Info.decimals;
      const d1 = token1Info.decimals;
      const currentPrice = tickToPrice(poolState.currentTick, d0, d1);
      const priceUsd0 = prices.get((token0 as string).toLowerCase()) ?? 0;
      const priceUsd1 = prices.get((token1 as string).toLowerCase()) ?? 0;

      // Format wallet balances as human-readable numbers
      const bal0 = BigInt(balance0Raw);
      const bal1 = BigInt(balance1Raw);
      const walletBalance0 = Number(bal0) / 10 ** d0;
      const walletBalance1 = Number(bal1) / 10 ** d1;

      const response = {
        poolAddress,
        currentTick: poolState.currentTick,
        sqrtPriceX96: poolState.sqrtPriceX96.toString(),
        tickSpacing,
        fee,
        feeFormatted: feeToPercent(fee),
        price: currentPrice,
        priceFormatted: `${formatPriceNum(currentPrice)} ${token1Info.symbol}/${token0Info.symbol}`,
        token0: {
          address: token0 as string,
          symbol: token0Info.symbol,
          decimals: d0,
          priceUsd: priceUsd0,
        },
        token1: {
          address: token1 as string,
          symbol: token1Info.symbol,
          decimals: d1,
          priceUsd: priceUsd1,
        },
        walletBalance0,
        walletBalance1,
      };

      res.json(JSON.parse(JSON.stringify(response, bigIntReplacer)));
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      logger.error('Calculator pool-state error', { error: msg });
      res.status(500).json({ error: 'Failed to fetch pool state' });
    }
  });

  /**
   * GET /api/calculator/split
   * Calculate the target token split for a given range and user balances.
   * Query: token0, token1, fee, priceLower, priceUpper, balance0, balance1
   * Prices are human-readable ratio prices (e.g. "150" for 150 WPLS/HEX)
   * balance0/balance1 are human-readable amounts (e.g. "50000", "100000.5")
   */
  router.get('/split', async (req: Request, res: Response) => {
    try {
      const {
        token0, token1, fee: feeStr,
        priceLower: priceLowerStr, priceUpper: priceUpperStr,
        balance0: balance0Str, balance1: balance1Str,
        chainId: chainIdStr,
      } = req.query;

      if (!token0 || !token1 || !feeStr || !priceLowerStr || !priceUpperStr || !balance0Str || !balance1Str) {
        res.status(400).json({ error: 'Required params: token0, token1, fee, priceLower, priceUpper, balance0, balance1' });
        return;
      }

      const fee = parseInt(feeStr as string);
      const priceLowerInput = parseFloat(priceLowerStr as string);
      const priceUpperInput = parseFloat(priceUpperStr as string);
      if (isNaN(fee) || isNaN(priceLowerInput) || isNaN(priceUpperInput)) {
        res.status(400).json({ error: 'fee, priceLower, priceUpper must be numbers' });
        return;
      }

      if (priceLowerInput >= priceUpperInput) {
        res.status(400).json({ error: 'Lower price must be less than upper price' });
        return;
      }

      if (priceLowerInput <= 0) {
        res.status(400).json({ error: 'Prices must be positive' });
        return;
      }

      const balance0Input = parseFloat(balance0Str as string);
      const balance1Input = parseFloat(balance1Str as string);
      if (isNaN(balance0Input) || isNaN(balance1Input) || balance0Input < 0 || balance1Input < 0) {
        res.status(400).json({ error: 'balance0 and balance1 must be non-negative numbers' });
        return;
      }

      const { reqChain, reqContracts, chainSlug } = resolveChain(chainIdStr as string | undefined);

      // Fetch pool state and token info
      const poolAddress = await getPoolAddress(
        reqContracts,
        token0 as string,
        token1 as string,
        fee,
        reqChain,
      );

      const [poolState, token0Info, token1Info, prices] = await Promise.all([
        getPoolState(poolAddress, reqContracts, reqChain),
        getTokenInfo(token0 as string, reqContracts, reqChain),
        getTokenInfo(token1 as string, reqContracts, reqChain),
        getTokenPrices([token0 as string, token1 as string], chainSlug),
      ]);

      const d0 = token0Info.decimals;
      const d1 = token1Info.decimals;

      // Convert prices to ticks, snapped to tick spacing
      let tickSpacing: number;
      try {
        tickSpacing = getTickSpacing(fee);
      } catch {
        res.status(400).json({ error: `Unsupported fee tier: ${fee}` });
        return;
      }

      const tickLower = nearestUsableTick(priceToTick(priceLowerInput, d0, d1), tickSpacing);
      const tickUpper = nearestUsableTick(priceToTick(priceUpperInput, d0, d1), tickSpacing);

      if (tickLower >= tickUpper) {
        res.status(400).json({ error: 'Price range too narrow — ticks snap to the same value' });
        return;
      }
      const priceUsd0 = prices.get((token0 as string).toLowerCase()) ?? 0;
      const priceUsd1 = prices.get((token1 as string).toLowerCase()) ?? 0;

      // Convert human-readable balances to raw BigInt
      const balance0 = BigInt(Math.floor(balance0Input * 10 ** d0));
      const balance1 = BigInt(Math.floor(balance1Input * 10 ** d1));

      // Calculate target token ratio using reference liquidity
      const sqrtPriceX96 = tickToSqrtPriceX96(poolState.currentTick);
      const sqrtPriceAX96 = tickToSqrtPriceX96(tickLower);
      const sqrtPriceBX96 = tickToSqrtPriceX96(tickUpper);
      const refLiquidity = 1n << 96n;
      const target = getAmountsForLiquidity(sqrtPriceX96, sqrtPriceAX96, sqrtPriceBX96, refLiquidity);

      // Calculate target split percentages (USD-weighted)
      const targetValue0 = (Number(target.amount0) / 10 ** d0) * priceUsd0;
      const targetValue1 = (Number(target.amount1) / 10 ** d1) * priceUsd1;
      const targetTotal = targetValue0 + targetValue1;

      let token0Pct = 50;
      let token1Pct = 50;
      if (targetTotal > 0) {
        token0Pct = Math.round((targetValue0 / targetTotal) * 1000) / 10;
        token1Pct = Math.round((targetValue1 / targetTotal) * 1000) / 10;
      } else if (target.amount0 === 0n) {
        token0Pct = 0;
        token1Pct = 100;
      } else if (target.amount1 === 0n) {
        token0Pct = 100;
        token1Pct = 0;
      }

      // Calculate wallet values
      const value0Usd = (Number(balance0) / 10 ** d0) * priceUsd0;
      const value1Usd = (Number(balance1) / 10 ** d1) * priceUsd1;
      const totalValueUsd = value0Usd + value1Usd;

      // Determine swap needed
      let swapDirection = '';
      let swapTokenIn: 'token0' | 'token1' = 'token0';
      let swapAmountIn = 0n;
      let swapAmountUsd = 0;
      let swapPct = 0;

      if (totalValueUsd > 0 && targetTotal > 0) {
        const targetFrac0 = targetValue0 / targetTotal;
        const f = fee / 1_000_000; // fee fraction, e.g. 2500 -> 0.0025

        // Solve for exact swap amount accounting for fee and post-swap totals.
        //
        // When selling s USD of token0 for token1:
        //   post_value0 = value0 - s
        //   post_value1 = value1 + s*(1-f)
        //   post_total  = totalValue - s*f
        //
        // We want: post_value0 / post_total = targetFrac0
        //   (value0 - s) / (totalValue - s*f) = targetFrac0
        //   value0 - s = targetFrac0 * (totalValue - s*f)
        //   value0 - s = targetFrac0*totalValue - targetFrac0*s*f
        //   s*(targetFrac0*f - 1) = targetFrac0*totalValue - value0
        //   s = (value0 - targetFrac0*totalValue) / (1 - targetFrac0*f)

        if (value0Usd > targetFrac0 * totalValueUsd) {
          // Too much token0 — sell token0 for token1
          swapTokenIn = 'token0';
          swapAmountUsd = (value0Usd - targetFrac0 * totalValueUsd) / (1 - targetFrac0 * f);
          swapPct = (swapAmountUsd / totalValueUsd) * 100;
          if (priceUsd0 > 0) {
            const tokenAmount = swapAmountUsd / priceUsd0;
            swapAmountIn = BigInt(Math.floor(tokenAmount * 10 ** d0));
          }
          swapDirection = `Sell ${token0Info.symbol} for ${token1Info.symbol}`;
        } else {
          // Too much token1 — sell token1 for token0
          // Symmetric: s = (value1 - targetFrac1*totalValue) / (1 - targetFrac1*f)
          const targetFrac1 = 1 - targetFrac0;
          swapTokenIn = 'token1';
          swapAmountUsd = (value1Usd - targetFrac1 * totalValueUsd) / (1 - targetFrac1 * f);
          swapPct = (swapAmountUsd / totalValueUsd) * 100;
          if (priceUsd1 > 0) {
            const tokenAmount = swapAmountUsd / priceUsd1;
            swapAmountIn = BigInt(Math.floor(tokenAmount * 10 ** d1));
          }
          swapDirection = `Sell ${token1Info.symbol} for ${token0Info.symbol}`;
        }
      }

      const currentPrice = tickToPrice(poolState.currentTick, d0, d1);
      const priceLower = tickToPrice(tickLower, d0, d1);
      const priceUpper = tickToPrice(tickUpper, d0, d1);

      const response = {
        pool: {
          address: poolAddress,
          currentTick: poolState.currentTick,
          price: currentPrice,
          priceFormatted: `${formatPriceNum(currentPrice)} ${token1Info.symbol}/${token0Info.symbol}`,
          fee,
          feeFormatted: feeToPercent(fee),
        },
        range: {
          tickLower,
          tickUpper,
          priceLower,
          priceUpper,
          priceLowerFormatted: formatPriceNum(priceLower),
          priceUpperFormatted: formatPriceNum(priceUpper),
          widthTicks: tickUpper - tickLower,
        },
        targetSplit: {
          token0Pct,
          token1Pct,
          token0Symbol: token0Info.symbol,
          token1Symbol: token1Info.symbol,
        },
        wallet: {
          balance0: balance0.toString(),
          balance1: balance1.toString(),
          balance0Formatted: formatTokenAmount(balance0, d0),
          balance1Formatted: formatTokenAmount(balance1, d1),
          value0Usd: Math.round(value0Usd * 100) / 100,
          value1Usd: Math.round(value1Usd * 100) / 100,
          totalValueUsd: Math.round(totalValueUsd * 100) / 100,
        },
        swap: {
          direction: swapDirection,
          tokenIn: swapTokenIn,
          tokenInSymbol: swapTokenIn === 'token0' ? token0Info.symbol : token1Info.symbol,
          amountIn: swapAmountIn.toString(),
          amountInFormatted: formatTokenAmount(
            swapAmountIn,
            swapTokenIn === 'token0' ? d0 : d1,
          ),
          amountInUsd: Math.round(swapAmountUsd * 100) / 100,
          swapPct: Math.round(swapPct * 10) / 10,
          estimatedFeePct: fee / 10000,
        },
        tokens: {
          token0: { address: token0 as string, symbol: token0Info.symbol, decimals: d0 },
          token1: { address: token1 as string, symbol: token1Info.symbol, decimals: d1 },
        },
      };

      res.json(JSON.parse(JSON.stringify(response, bigIntReplacer)));
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      logger.error('Calculator split error', { error: msg });
      res.status(500).json({ error: 'Failed to calculate split' });
    }
  });

  return router;
}

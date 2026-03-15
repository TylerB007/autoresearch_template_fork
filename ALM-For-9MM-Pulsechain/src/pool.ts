/**
 * Pool state queries — reads slot0, liquidity, token info from on-chain
 */

import { ethers } from 'ethers';
import type { ContractInstances } from './contracts.js';
import type { PoolState, TokenInfo } from './types.js';
import type { ChainContext } from './chain.js';
import logger from './logger.js';

export async function getPoolAddress(
  contracts: ContractInstances,
  token0: string,
  token1: string,
  fee: number,
  chain: ChainContext,
): Promise<string> {
  return chain.withRetry(async () => {
    const poolAddress: string = await contracts.factory.getPool(token0, token1, fee);
    if (poolAddress === ethers.ZeroAddress) {
      throw new Error(`No pool found for ${token0}/${token1} at fee ${fee}`);
    }
    return poolAddress;
  });
}

export async function getPoolState(
  poolAddress: string,
  contracts: ContractInstances,
  chain: ChainContext,
): Promise<PoolState> {
  return chain.withRetry(async () => {
    const pool = contracts.getPool(poolAddress);
    const isAerodromeStyle = contracts.swapRouterType === 'aerodrome-cl' || contracts.swapRouterType === 'algebra-v3';

    if (isAerodromeStyle) {
      // Aerodrome CL / Algebra V3 pools use EIP-1167 minimal proxies that fail with batched
      // RPC calls (Promise.all). Query sequentially to avoid CALL_EXCEPTION.
      // These pools also have no fee() function — tickSpacing IS the pool key.
      const slot0 = await pool.slot0();
      const liquidity = await pool.liquidity();
      const token0 = await pool.token0();
      const token1 = await pool.token1();
      const tickSpacing = await pool.tickSpacing();
      return {
        address: poolAddress,
        token0,
        token1,
        fee: Number(tickSpacing),
        tickSpacing: Number(tickSpacing),
        sqrtPriceX96: BigInt(slot0.sqrtPriceX96),
        currentTick: Number(slot0.tick),
        liquidity: BigInt(liquidity),
      };
    }

    const [slot0, liquidity, token0, token1, tickSpacing, fee] = await Promise.all([
      pool.slot0(),
      pool.liquidity(),
      pool.token0(),
      pool.token1(),
      pool.tickSpacing(),
      pool.fee(),
    ]);

    return {
      address: poolAddress,
      token0,
      token1,
      fee: Number(fee),
      tickSpacing: Number(tickSpacing),
      sqrtPriceX96: BigInt(slot0.sqrtPriceX96),
      currentTick: Number(slot0.tick),
      liquidity: BigInt(liquidity),
    };
  });
}


export async function getTokenInfo(
  tokenAddress: string,
  contracts: ContractInstances,
  chain: ChainContext,
): Promise<TokenInfo> {
  return chain.withRetry(async () => {
    const token = contracts.getERC20(tokenAddress);
    // Sequential calls: some tokens (e.g. proxies on Base) fail with batched RPC
    const symbol = await token.symbol();
    const name = await token.name();
    const decimals = await token.decimals();
    return {
      address: tokenAddress,
      symbol,
      name,
      decimals: Number(decimals),
    };
  });
}

/**
 * Position data fetching and in-range/out-of-range status calculation
 */

import { createRequire } from 'node:module';
import { ethers } from 'ethers';
import type { ContractInstances } from './contracts.js';
import type { ChainContext } from './chain.js';
import type { PositionData, PositionStatus } from './types.js';
import { getPoolAddress, getPoolState, getTokenInfo } from './pool.js';
import { getAmountsForLiquidity, tickToSqrtPriceX96 } from './math.js';
import logger from './logger.js';

const require = createRequire(import.meta.url);
const CLGaugeABI = require('../abis/AerodromeCLGauge.json');

/**
 * Compute unclaimed fees using feeGrowthInside math.
 * Used as fallback for Algebra V3 (Sonic) where collect.staticCall reverts.
 */
async function computeFeesFromFeeGrowth(
  position: PositionData,
  poolAddress: string,
  currentTick: number,
  contracts: ContractInstances,
  chain: ChainContext,
): Promise<{ fees0: bigint; fees1: bigint }> {
  const pool = contracts.getPool(poolAddress);
  const Q128 = 1n << 128n;
  const MAX_UINT256 = (1n << 256n) - 1n;

  // Sequential RPC calls (EIP-1167 proxy compatibility on Sonic)
  const feeGrowthGlobal0 = BigInt(await chain.withRetry(() => pool.feeGrowthGlobal0X128()));
  const feeGrowthGlobal1 = BigInt(await chain.withRetry(() => pool.feeGrowthGlobal1X128()));
  const tickLowerData = await chain.withRetry(() => pool.ticks(position.tickLower));
  const tickUpperData = await chain.withRetry(() => pool.ticks(position.tickUpper));

  const fgOutsideLower0 = BigInt(tickLowerData.feeGrowthOutside0X128);
  const fgOutsideLower1 = BigInt(tickLowerData.feeGrowthOutside1X128);
  const fgOutsideUpper0 = BigInt(tickUpperData.feeGrowthOutside0X128);
  const fgOutsideUpper1 = BigInt(tickUpperData.feeGrowthOutside1X128);

  function feeGrowthInside(global: bigint, outsideLower: bigint, outsideUpper: bigint): bigint {
    const below = currentTick >= position.tickLower
      ? outsideLower
      : (global - outsideLower) & MAX_UINT256;
    const above = currentTick < position.tickUpper
      ? outsideUpper
      : (global - outsideUpper) & MAX_UINT256;
    return (global - below - above) & MAX_UINT256;
  }

  const fgi0 = feeGrowthInside(feeGrowthGlobal0, fgOutsideLower0, fgOutsideUpper0);
  const fgi1 = feeGrowthInside(feeGrowthGlobal1, fgOutsideLower1, fgOutsideUpper1);

  const fees0 = ((fgi0 - position.feeGrowthInside0LastX128) & MAX_UINT256)
    * position.liquidity / Q128 + position.tokensOwed0;
  const fees1 = ((fgi1 - position.feeGrowthInside1LastX128) & MAX_UINT256)
    * position.liquidity / Q128 + position.tokensOwed1;

  return { fees0, fees1 };
}

export async function getPositionData(
  tokenId: number,
  contracts: ContractInstances,
  chain: ChainContext,
): Promise<PositionData> {
  return chain.withRetry(async () => {
    const pos = await contracts.positionManager.positions(tokenId);
    // Aerodrome CL / Algebra V3 positions() returns `tickSpacing` where Uniswap V3 returns `fee`.
    // We store whichever is present in the `fee` field — both are used as the pool key.
    const feeOrTickSpacing = pos.tickSpacing !== undefined ? Number(pos.tickSpacing) : Number(pos.fee);
    // Algebra V3 NPMs (Shadow V3) return 10 fields — no nonce/operator.
    // Uniswap V3 and Aerodrome CL return 12 fields with nonce + operator.
    const hasNonce = pos.nonce !== undefined;
    return {
      tokenId,
      nonce: hasNonce ? BigInt(pos.nonce) : 0n,
      operator: hasNonce ? pos.operator : ethers.ZeroAddress,
      token0: pos.token0,
      token1: pos.token1,
      fee: feeOrTickSpacing,
      tickLower: Number(pos.tickLower),
      tickUpper: Number(pos.tickUpper),
      liquidity: BigInt(pos.liquidity),
      feeGrowthInside0LastX128: BigInt(pos.feeGrowthInside0LastX128),
      feeGrowthInside1LastX128: BigInt(pos.feeGrowthInside1LastX128),
      tokensOwed0: BigInt(pos.tokensOwed0),
      tokensOwed1: BigInt(pos.tokensOwed1),
    };
  });
}

export async function verifyOwnership(
  tokenId: number,
  walletAddress: string,
  contracts: ContractInstances,
  chain: ChainContext,
  gaugeAddress?: string,
): Promise<boolean> {
  return chain.withRetry(async () => {
    try {
      // If gaugeAddress is provided, check the gauge's ownerOf first.
      // When a position is staked in a gauge, the NPM's ownerOf returns the gauge
      // address (not the wallet), so we ask the gauge who deposited the NFT.
      if (gaugeAddress) {
        const gauge = new ethers.Contract(gaugeAddress, CLGaugeABI, chain.provider);
        try {
          const stakedOwner: string = await gauge.ownerOf(tokenId);
          if (stakedOwner.toLowerCase() === walletAddress.toLowerCase()) {
            return true; // Position is staked by our wallet
          }
        } catch {
          // gauge.ownerOf reverted — token not in this gauge, fall through to NPM check
        }
      }

      const owner: string = await contracts.positionManager.ownerOf(tokenId);
      const isOwner = owner.toLowerCase() === walletAddress.toLowerCase();

      if (!isOwner) {
        logger.error(
          `Ownership mismatch! Position ${tokenId} is owned by ${owner}, expected ${walletAddress}`,
        );
      }

      return isOwner;
    } catch (err: any) {
      // Genuine ERC-721 reverts (burned/non-existent token) have non-null revert data.
      // Sonic RPC flakiness produces CALL_EXCEPTION with data=null — must throw to retry,
      // otherwise `withRetry` sees a return value and never retries, leading to auto-disable.
      const hasRevertData = err.data != null || err.revert != null;
      if ((err.code === 'CALL_EXCEPTION' || err.message?.includes('ERC721')) && hasRevertData) {
        logger.error(`Position ${tokenId} does not exist or was burned`);
        return false;
      }

      // For RPC errors (including null-data CALL_EXCEPTION), throw to trigger retry
      logger.warn(`RPC error checking ownership for ${tokenId}: ${err.message}`);
      throw err; // withRetry() will catch and retry
    }
  });
}

export async function getPositionStatus(
  tokenId: number,
  contracts: ContractInstances,
  chain: ChainContext,
): Promise<PositionStatus> {
  const position = await getPositionData(tokenId, contracts, chain);

  const poolAddress = await getPoolAddress(
    contracts,
    position.token0,
    position.token1,
    position.fee,
    chain,
  );
  const pool = await getPoolState(poolAddress, contracts, chain);

  // Sequential: some tokens (proxies on Base) fail with batched RPC calls
  const token0Info = await getTokenInfo(position.token0, contracts, chain);
  const token1Info = await getTokenInfo(position.token1, contracts, chain);

  // In-range check: currentTick is in [tickLower, tickUpper)
  const isInRange =
    pool.currentTick >= position.tickLower && pool.currentTick < position.tickUpper;

  // tickDistance: positive = how far out of range; negative = how far inside range
  let tickDistance: number;
  if (pool.currentTick < position.tickLower) {
    tickDistance = position.tickLower - pool.currentTick;
  } else if (pool.currentTick >= position.tickUpper) {
    tickDistance = pool.currentTick - position.tickUpper;
  } else {
    tickDistance = -Math.min(
      pool.currentTick - position.tickLower,
      position.tickUpper - 1 - pool.currentTick,
    );
  }

  // Calculate current token amounts in the position
  const sqrtPriceAX96 = tickToSqrtPriceX96(position.tickLower);
  const sqrtPriceBX96 = tickToSqrtPriceX96(position.tickUpper);
  const { amount0, amount1 } = getAmountsForLiquidity(
    pool.sqrtPriceX96,
    sqrtPriceAX96,
    sqrtPriceBX96,
    position.liquidity,
  );

  // Get true uncollected fees via collect.staticCall (simulates collection without executing)
  const MAX_UINT128 = 2n ** 128n - 1n;
  let unclaimedFees0 = position.tokensOwed0;
  let unclaimedFees1 = position.tokensOwed1;
  try {
    const result = await chain.withRetry(async () => {
      return contracts.positionManager.collect.staticCall({
        tokenId,
        recipient: chain.wallet.address,
        amount0Max: MAX_UINT128,
        amount1Max: MAX_UINT128,
      });
    });
    unclaimedFees0 = BigInt(result.amount0);
    unclaimedFees1 = BigInt(result.amount1);
  } catch (err) {
    // For Algebra V3 (Sonic): collect.staticCall reverts — compute from feeGrowthInside math
    if (contracts.swapRouterType === 'algebra-v3') {
      try {
        const feeResult = await computeFeesFromFeeGrowth(
          position, poolAddress, pool.currentTick, contracts, chain,
        );
        unclaimedFees0 = feeResult.fees0;
        unclaimedFees1 = feeResult.fees1;
      } catch (feeErr) {
        logger.warn('Algebra V3 feeGrowthInside fallback failed, using tokensOwed', {
          tokenId,
          error: feeErr instanceof Error ? feeErr.message : String(feeErr),
        });
      }
    } else {
      logger.warn('Failed to fetch unclaimed fees via staticCall, falling back to tokensOwed', {
        tokenId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return {
    position,
    pool,
    token0Info,
    token1Info,
    isInRange,
    tickDistance,
    amount0,
    amount1,
    unclaimedFees0,
    unclaimedFees1,
  };
}

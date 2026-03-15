/**
 * Swap execution via SwapRouter or DEX aggregator with slippage protection
 *
 * Supports three routing modes:
 * - 'direct': Uses the chain's SwapRouter directly (good for deep liquidity)
 * - 'piteas': Routes through Piteas aggregator (PulseChain only)
 * - 'oneinch': Routes through 1inch aggregator (Ethereum, Base)
 */

import type { ContractInstances } from './contracts.js';
import type { ChainContext } from './chain.js';
import type { AppConfig, SwapResult } from './types.js';
import { GAS_LIMITS } from './config/index.js';
import { executeSwapViaPiteas } from './aggregators/piteas.js';
import { executeSwapViaOneInch } from './aggregators/oneinch.js';
import logger from './logger.js';

const Q192 = 1n << 192n;

/**
 * Calculate price-aware amountOutMinimum using the pool's current sqrtPriceX96.
 *
 * For token0→token1: expectedOut = amountIn * price = amountIn * sqrtPriceX96^2 / 2^192
 * For token1→token0: expectedOut = amountIn / price = amountIn * 2^192 / sqrtPriceX96^2
 *
 * Then applies fee deduction and slippage tolerance.
 */
function calculateAmountOutMinimum(
  amountIn: bigint,
  sqrtPriceX96: bigint,
  fee: number,
  slippageBps: number,
  zeroForOne: boolean,
): bigint {
  // Expected output based on current pool price (before fees)
  const sqrtPriceSq = sqrtPriceX96 * sqrtPriceX96;
  let expectedOut: bigint;
  if (zeroForOne) {
    // Selling token0 for token1
    expectedOut = (amountIn * sqrtPriceSq) / Q192;
  } else {
    // Selling token1 for token0
    expectedOut = (amountIn * Q192) / sqrtPriceSq;
  }

  // Deduct pool fee
  const feeReduction = (expectedOut * BigInt(fee)) / 1_000_000n;
  const afterFee = expectedOut - feeReduction;

  // Apply slippage tolerance
  const slippageReduction = (afterFee * BigInt(slippageBps)) / 10_000n;
  const result = afterFee - slippageReduction;
  return result > 0n ? result : 0n; // Floor at 0 — BigInt can go negative unlike Solidity uint256
}

/**
 * Execute a swap using the configured provider (direct 9mm or Piteas aggregator)
 *
 * @param sqrtPriceX96 Current pool price — required for price-aware slippage protection (direct mode only)
 * @param zeroForOne   Whether swapping token0→token1 (direct mode only)
 */
export async function executeSwap(
  tokenIn: string,
  tokenOut: string,
  fee: number,
  amountIn: bigint,
  sqrtPriceX96: bigint,
  zeroForOne: boolean,
  config: AppConfig,
  contracts: ContractInstances,
  chain: ChainContext,
): Promise<SwapResult> {
  if (amountIn === 0n) {
    return {
      tokenIn,
      tokenOut,
      amountIn: 0n,
      amountOut: 0n,
      configuredSlippageBps: config.slippage_tolerance_bps,
      txHash: '',
      gasUsed: 0n,
    };
  }

  // Route through the configured swap provider
  if (config.swap_provider === 'piteas') {
    logger.info('Routing swap through Piteas aggregator for better execution');
    
    if (config.dry_run) {
      logger.info('[DRY RUN] Would execute swap via Piteas', {
        tokenIn,
        tokenOut,
        amountIn: amountIn.toString(),
        slippageBps: config.slippage_tolerance_bps,
      });
      // Return conservative estimate for dry run
      const estimatedOut = amountIn / 2n; // Placeholder estimate
      return {
        tokenIn,
        tokenOut,
        amountIn,
        amountOut: estimatedOut,
        configuredSlippageBps: config.slippage_tolerance_bps,
        txHash: '0x_DRY_RUN_PITEAS',
        gasUsed: 0n,
      };
    }

    return await executeSwapViaPiteas(
      tokenIn,
      tokenOut,
      amountIn,
      config.slippage_tolerance_bps,
      config.chain.chainId,
      chain,
    );
  }

  // 1inch aggregator routing (Ethereum, Base)
  if (config.swap_provider === 'oneinch') {
    logger.info('Routing swap through 1inch aggregator for better execution');

    if (config.dry_run) {
      logger.info('[DRY RUN] Would execute swap via 1inch', {
        tokenIn,
        tokenOut,
        amountIn: amountIn.toString(),
        slippageBps: config.slippage_tolerance_bps,
      });
      const estimatedOut = amountIn / 2n; // Placeholder estimate
      return {
        tokenIn,
        tokenOut,
        amountIn,
        amountOut: estimatedOut,
        configuredSlippageBps: config.slippage_tolerance_bps,
        txHash: '0x_DRY_RUN_ONEINCH',
        gasUsed: 0n,
      };
    }

    return await executeSwapViaOneInch(
      tokenIn,
      tokenOut,
      amountIn,
      config.slippage_tolerance_bps,
      config.chain.chainId,
      chain,
      config.oneinchApiKey!,
    );
  }

  // Default: Direct routing through SwapRouter
  return await executeSwapDirect(
    tokenIn,
    tokenOut,
    fee,
    amountIn,
    sqrtPriceX96,
    zeroForOne,
    config,
    contracts,
    chain,
  );
}

/**
 * Execute a swap directly through the chain's SwapRouter
 *
 * @param sqrtPriceX96 Current pool price — required for price-aware slippage protection
 * @param zeroForOne   Whether swapping token0→token1 (true) or token1→token0 (false)
 */
async function executeSwapDirect(
  tokenIn: string,
  tokenOut: string,
  fee: number,
  amountIn: bigint,
  sqrtPriceX96: bigint,
  zeroForOne: boolean,
  config: AppConfig,
  contracts: ContractInstances,
  chain: ChainContext,
): Promise<SwapResult> {

  const amountOutMinimum = calculateAmountOutMinimum(
    amountIn,
    sqrtPriceX96,
    fee,
    config.slippage_tolerance_bps,
    zeroForOne,
  );

  // Sanity check: catch corrupted sqrtPriceX96 (e.g. zero, or tick-0 default).
  // We check the price itself rather than comparing raw output vs input,
  // because token pairs can have vastly different decimals (e.g. HEX 8 / WPLS 18).
  if (sqrtPriceX96 === 0n) {
    throw new Error('sqrtPriceX96 is zero — pool price is corrupted. Aborting swap.');
  }
  if (amountOutMinimum === 0n && amountIn > 0n) {
    throw new Error(
      `amountOutMinimum is zero for non-zero input ${amountIn}. ` +
      `sqrtPriceX96=${sqrtPriceX96} may be corrupted. Aborting swap.`,
    );
  }

  // Calculate sqrtPriceLimitX96: cap price impact at ~5% beyond current price.
  // For zeroForOne (selling token0), price decreases → limit is below current.
  // For oneForZero (selling token1), price increases → limit is above current.
  // MIN/MAX from Uniswap V3 TickMath: sqrtPriceX96 must be within [4295128739, 1461446703485210103287273052203988822378723970342]
  const MIN_SQRT_RATIO = 4295128739n;
  const MAX_SQRT_RATIO = 1461446703485210103287273052203988822378723970342n;
  let sqrtPriceLimitX96: bigint;
  if (zeroForOne) {
    // Price going down: allow up to 5% decrease
    sqrtPriceLimitX96 = sqrtPriceX96 * 975n / 1000n; // ~5% lower (sqrt of 5% ≈ 2.5%)
    if (sqrtPriceLimitX96 < MIN_SQRT_RATIO) sqrtPriceLimitX96 = MIN_SQRT_RATIO;
  } else {
    // Price going up: allow up to 5% increase
    sqrtPriceLimitX96 = sqrtPriceX96 * 1025n / 1000n; // ~5% higher
    if (sqrtPriceLimitX96 > MAX_SQRT_RATIO) sqrtPriceLimitX96 = MAX_SQRT_RATIO;
  }

  // Build swap params — field name and deadline depend on router type:
  // - uniswap-v3:     fee (uint24), has deadline
  // - pancakeswap-v3: fee (uint24), no deadline
  // - aerodrome-cl:   tickSpacing (int24), has deadline
  // - algebra-v3:     tickSpacing (int24), has deadline (same swap interface as aerodrome-cl)
  const isAerodromeStyle = contracts.swapRouterType === 'aerodrome-cl' || contracts.swapRouterType === 'algebra-v3';
  const swapParams: Record<string, unknown> = {
    tokenIn,
    tokenOut,
    // Aerodrome/Algebra uses tickSpacing as pool key; Uniswap/PancakeSwap use fee
    ...(isAerodromeStyle ? { tickSpacing: fee } : { fee }),
    recipient: chain.wallet.address,
    amountIn,
    amountOutMinimum,
    sqrtPriceLimitX96,
  };
  if (contracts.swapRouterType === 'uniswap-v3' || isAerodromeStyle) {
    swapParams.deadline = BigInt(Math.floor(Date.now() / 1000) + 1800); // 30 minutes
  }

  logger.info(`Executing direct swap via ${config.chain.protocolName} SwapRouter`, {
    tokenIn,
    tokenOut,
    fee,
    amountIn: amountIn.toString(),
    amountOutMinimum: amountOutMinimum.toString(),
    zeroForOne,
  });

  if (config.dry_run) {
    logger.info('[DRY RUN] Would execute swap', {
      params: serializeForLog(swapParams),
    });
    return {
      tokenIn,
      tokenOut,
      amountIn,
      amountOut: amountOutMinimum, // conservative estimate for dry run
      configuredSlippageBps: config.slippage_tolerance_bps,
      txHash: '0x_DRY_RUN',
      gasUsed: 0n,
    };
  }

  // Approve tokenIn to SwapRouter
  await ensureApproval(
    tokenIn,
    contracts.swapRouter.target as string,
    amountIn,
    contracts,
    chain,
  );

  // Capture pre-swap balance of output token for accurate delta calculation.
  // If Swap event parsing fails later, we compute amountOut = postBalance - preBalance
  // instead of reporting the entire wallet balance (which overstates the swap output).
  let preSwapOutputBalance = 0n;
  try {
    const tokenOutContract = contracts.getERC20(tokenOut);
    preSwapOutputBalance = BigInt(await tokenOutContract.balanceOf(chain.wallet.address));
  } catch {
    // Non-fatal — fallback will still work but may overstate if event parsing also fails
  }

  const nonce = await chain.nonceManager.getNextNonce();
  try {
    const tx = await contracts.swapRouter.exactInputSingle(swapParams, {
      gasLimit: GAS_LIMITS.SWAP,
      nonce,
    });
    logger.info(`Swap tx submitted: ${tx.hash}`);

    const receipt = await tx.wait();
    if (!receipt) {
      throw new Error(`Swap tx ${tx.hash} was dropped from mempool (receipt is null). Nonce may be stuck.`);
    }
    chain.nonceManager.confirmNonce(nonce);

    // Parse amountOut from the swap receipt by looking for the Swap event
    // The pool (not the router) emits the Swap event, so we need to look up
    // the actual pool address — NOT use tokenIn (which is an ERC20 address).
    let amountOut = 0n;
    let poolAddress: string | undefined;
    try {
      poolAddress = await contracts.factory.getPool(tokenIn, tokenOut, fee);
    } catch {
      logger.warn('Could not resolve pool address from factory for Swap event parsing');
    }
    if (poolAddress && poolAddress !== '0x0000000000000000000000000000000000000000') {
      const poolIface = contracts.getPool(poolAddress).interface;
      for (const log of receipt.logs) {
        try {
          const parsed = poolIface.parseLog({ topics: log.topics as string[], data: log.data });
          if (parsed && parsed.name === 'Swap') {
            // Swap event contains amount0 and amount1 — one will be negative (out)
            const a0 = BigInt(parsed.args.amount0);
            const a1 = BigInt(parsed.args.amount1);
            amountOut = a0 < 0n ? -a0 : -a1;
          }
        } catch {
          // Not our event
        }
      }
    }

    // Fallback: if Swap event parsing failed, compute the balance delta of the output token.
    // The swap may have succeeded — we just couldn't parse the event (ABI mismatch, etc).
    if (amountOut === 0n && amountIn > 0n) {
      logger.warn('Could not parse Swap event — computing output token balance delta as fallback');
      const tokenOutContract = contracts.getERC20(tokenOut);
      const postSwapBalance = BigInt(await tokenOutContract.balanceOf(chain.wallet.address));
      const balanceDelta = postSwapBalance - preSwapOutputBalance;
      if (balanceDelta > 0n) {
        logger.warn(`Output token balance delta is ${balanceDelta.toString()} (pre=${preSwapOutputBalance.toString()}, post=${postSwapBalance.toString()}) — swap likely succeeded despite event parse failure`);
        amountOut = balanceDelta;
      } else if (postSwapBalance > 0n) {
        // Pre-swap balance read failed or concurrent tx — use total as last resort but log clearly
        logger.warn(`Output token balance delta is non-positive (pre=${preSwapOutputBalance.toString()}, post=${postSwapBalance.toString()}) — using total balance as last resort`);
        amountOut = postSwapBalance;
      }
    }

    logger.info(`Swap confirmed: ${receipt.hash}`, {
      amountOut: amountOut.toString(),
    });

    return {
      tokenIn,
      tokenOut,
      amountIn,
      amountOut,
      configuredSlippageBps: config.slippage_tolerance_bps,
      txHash: receipt.hash,
      gasUsed: receipt.gasUsed,
      blockNumber: receipt.blockNumber,
    };
  } catch (error) {
    await chain.nonceManager.resetNonce();
    throw error;
  }
}

/**
 * Ensure sufficient token approval for a spender.
 * Uses exact approval amounts (not MaxUint256) for safety.
 * Handles tokens that require zero-first approval (e.g. USDT, KTA)
 * by resetting allowance to 0 before setting the new amount.
 */
export async function ensureApproval(
  tokenAddress: string,
  spender: string,
  amount: bigint,
  contracts: ContractInstances,
  chain: ChainContext,
): Promise<void> {
  const token = contracts.getERC20(tokenAddress);
  const currentAllowance = BigInt(
    await token.allowance(chain.wallet.address, spender),
  );

  if (currentAllowance >= amount) {
    logger.debug(`Sufficient allowance for ${tokenAddress}: ${currentAllowance}`);
    return;
  }

  // Some tokens (USDT, KTA, etc.) revert with "Unsafe allowance change" if you
  // try to change a non-zero allowance to another non-zero value. Reset to 0 first.
  // If the zero-reset itself fails (e.g., token doesn't require it), proceed to the
  // main approval — many tokens (USDC, WETH) work fine without zero-first.
  if (currentAllowance > 0n) {
    logger.info(`Resetting allowance to 0 for ${tokenAddress} (current: ${currentAllowance})`);
    const resetNonce = await chain.nonceManager.getNextNonce();
    try {
      const resetTx = await token.approve(spender, 0n, {
        gasLimit: GAS_LIMITS.APPROVE,
        nonce: resetNonce,
      });
      const resetReceipt = await resetTx.wait();
      if (resetReceipt && resetReceipt.status === 0) {
        // Zero-reset reverted on-chain — token likely doesn't require it.
        // Proceed to main approval; it will either work or fail with a clear error.
        logger.warn(`Zero-reset approval reverted on-chain for ${tokenAddress} — proceeding to direct approval`);
        chain.nonceManager.confirmNonce(resetNonce);
      } else {
        chain.nonceManager.confirmNonce(resetNonce);
        logger.info(`Allowance reset confirmed: ${resetTx.hash}`);
      }
    } catch (error) {
      await chain.nonceManager.resetNonce();
      // Non-fatal: proceed to the main approval anyway
      logger.warn(`Zero-reset approval failed for ${tokenAddress} (non-fatal, proceeding): ${error instanceof Error ? error.message : error}`);
    }
  }

  logger.info(
    `Approving ${amount} of ${tokenAddress} to ${spender}`,
  );

  const nonce = await chain.nonceManager.getNextNonce();
  try {
    const tx = await token.approve(spender, amount, {
      gasLimit: GAS_LIMITS.APPROVE,
      nonce,
    });
    const receipt = await tx.wait();
    // Check for on-chain revert (status=0) — some tokens revert approval silently
    if (receipt && receipt.status === 0) {
      throw Object.assign(
        new Error(`Approval tx ${tx.hash} reverted on-chain (status=0). Token may require special handling.`),
        { code: 'APPROVAL_REVERTED', txHash: tx.hash },
      );
    }
    chain.nonceManager.confirmNonce(nonce);
    logger.info(`Approval confirmed: ${tx.hash}`);
  } catch (error) {
    await chain.nonceManager.resetNonce();

    // One retry with fresh nonce — covers cases where a prior crash loop left
    // a pending tx that caused a nonce collision or the approval reverted due
    // to transient state (e.g., paused token contract that recovered).
    const code = (error as { code?: string })?.code;
    if (code === 'APPROVAL_REVERTED' || code === 'NONCE_EXPIRED' || code === 'REPLACEMENT_UNDERPRICED') {
      logger.warn(`Approval failed (${code}), retrying once with fresh nonce...`);
      const retryNonce = await chain.nonceManager.getNextNonce();
      try {
        const retryTx = await token.approve(spender, amount, {
          gasLimit: GAS_LIMITS.APPROVE,
          nonce: retryNonce,
        });
        const retryReceipt = await retryTx.wait();
        if (retryReceipt && retryReceipt.status === 0) {
          await chain.nonceManager.resetNonce();
          throw new Error(`Approval retry also reverted on-chain (${retryTx.hash}). Token may be incompatible.`);
        }
        chain.nonceManager.confirmNonce(retryNonce);
        logger.info(`Approval confirmed on retry: ${retryTx.hash}`);
        return;
      } catch (retryError) {
        await chain.nonceManager.resetNonce();
        throw retryError;
      }
    }

    throw error;
  }
}

function serializeForLog(obj: Record<string, unknown>): string {
  return JSON.stringify(obj, (_key, value) =>
    typeof value === 'bigint' ? value.toString() : value,
  );
}

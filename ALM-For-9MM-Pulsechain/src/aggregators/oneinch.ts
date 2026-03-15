/**
 * 1inch DEX Aggregator Integration
 *
 * 1inch aggregates liquidity across multiple DEXes on Ethereum, Base, and other
 * EVM chains to provide better swap execution than single-DEX routing.
 *
 * API Documentation: https://portal.1inch.dev/documentation/swap/introduction
 * Uses Swap API v6.0
 */

import { ethers } from 'ethers';
import type { ChainContext } from '../chain.js';
import type { SwapResult } from '../types.js';
import { GAS_LIMITS } from '../config/index.js';
import { getChainConfig } from '../config/chains.js';
import logger from '../logger.js';

interface OneInchQuoteResponse {
  dstAmount: string;
  srcToken: { address: string; symbol: string; decimals: number };
  dstToken: { address: string; symbol: string; decimals: number };
  protocols: unknown[];
  gas: number;
}

interface OneInchSwapResponse {
  dstAmount: string;
  tx: {
    from: string;
    to: string;
    data: string;
    value: string;
    gas: number;
    gasPrice: string;
  };
}

/**
 * Get the 1inch router address for a given chain from the registry.
 * Throws if 1inch is not configured for the chain.
 */
function getOneInchConfig(chainId: number): { routerAddress: string; apiBase: string } {
  const chainEntry = getChainConfig(chainId);
  if (!chainEntry.aggregators.oneinch) {
    throw new Error(`1inch aggregator is not configured for ${chainEntry.chainName} (chain ${chainId})`);
  }
  return chainEntry.aggregators.oneinch;
}

/**
 * Get a swap quote from 1inch aggregator
 */
async function getOneInchQuote(
  tokenIn: string,
  tokenOut: string,
  amountIn: bigint,
  chainId: number,
  apiKey: string,
): Promise<OneInchQuoteResponse> {
  const { apiBase } = getOneInchConfig(chainId);
  const params = new URLSearchParams({
    src: tokenIn,
    dst: tokenOut,
    amount: amountIn.toString(),
  });

  const url = `${apiBase}/quote?${params}`;
  logger.info(`Fetching 1inch quote: ${apiBase}/quote`);

  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${apiKey}`,
      Accept: 'application/json',
    },
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`1inch API error (${response.status}): ${errorText}`);
  }

  const quote = await response.json() as OneInchQuoteResponse;

  logger.info('1inch quote received', {
    dstAmount: quote.dstAmount,
    gas: quote.gas,
  });

  return quote;
}

/**
 * Get swap transaction data from 1inch
 */
async function getOneInchSwapData(
  tokenIn: string,
  tokenOut: string,
  amountIn: bigint,
  slippageBps: number,
  recipient: string,
  chainId: number,
  apiKey: string,
): Promise<OneInchSwapResponse> {
  const { apiBase } = getOneInchConfig(chainId);
  const params = new URLSearchParams({
    src: tokenIn,
    dst: tokenOut,
    amount: amountIn.toString(),
    from: recipient,
    slippage: (slippageBps / 100).toString(), // Convert bps to percentage
    disableEstimate: 'true', // We handle gas estimation ourselves
  });

  const url = `${apiBase}/swap?${params}`;
  logger.info(`Fetching 1inch swap data: ${apiBase}/swap`);

  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${apiKey}`,
      Accept: 'application/json',
    },
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`1inch swap API error (${response.status}): ${errorText}`);
  }

  return await response.json() as OneInchSwapResponse;
}

/**
 * Execute a swap through 1inch aggregator
 */
export async function executeSwapViaOneInch(
  tokenIn: string,
  tokenOut: string,
  amountIn: bigint,
  slippageBps: number,
  chainId: number,
  chain: ChainContext,
  apiKey: string,
): Promise<SwapResult> {
  const { routerAddress } = getOneInchConfig(chainId);

  logger.info('Executing swap via 1inch aggregator', {
    tokenIn,
    tokenOut,
    amountIn: amountIn.toString(),
    slippageBps,
    chainId,
  });

  // Step 1: Get swap transaction data (includes quote)
  const swapResponse = await getOneInchSwapData(
    tokenIn,
    tokenOut,
    amountIn,
    slippageBps,
    chain.wallet.address,
    chainId,
    apiKey,
  );

  // Step 2: Approve token to 1inch router if needed
  await ensureOneInchApproval(tokenIn, amountIn, routerAddress, chain);

  // Step 3: Validate swap transaction data before sending
  // SECURITY: swapData comes from an external API — validate all fields to prevent
  // a compromised or MitM'd API from redirecting funds or draining native currency.
  if (swapResponse.tx.to.toLowerCase() !== routerAddress.toLowerCase()) {
    throw new Error(
      `1inch API returned unexpected router address: ${swapResponse.tx.to} — expected ${routerAddress}. Aborting swap.`,
    );
  }
  const swapValue = BigInt(swapResponse.tx.value);
  if (swapValue !== 0n) {
    // ERC-20 to ERC-20 swaps should always have value 0.
    // A non-zero value would drain native currency to the router.
    throw new Error(
      `1inch API returned non-zero value (${swapValue}) for ERC-20 swap — aborting to prevent native currency drain.`,
    );
  }

  // Step 4: Execute the swap transaction
  const nonce = await chain.nonceManager.getNextNonce();

  try {
    const tx = await chain.wallet.sendTransaction({
      to: swapResponse.tx.to,
      data: swapResponse.tx.data,
      value: 0n, // Explicitly 0 — validated above; never trust the API value directly
      gasLimit: BigInt(GAS_LIMITS.SWAP) * 2n, // Aggregator swaps may use more gas
      nonce,
    });

    logger.info(`1inch swap tx submitted: ${tx.hash}`);

    const receipt = await tx.wait();
    chain.nonceManager.confirmNonce(nonce);

    if (!receipt) {
      throw new Error('Transaction receipt is null');
    }

    // Parse Transfer events to get actual amountOut
    let amountOut = 0n;
    const erc20Interface = new ethers.Interface([
      'event Transfer(address indexed from, address indexed to, uint256 value)',
    ]);

    for (const log of receipt.logs) {
      try {
        const parsed = erc20Interface.parseLog({
          topics: log.topics as string[],
          data: log.data,
        });

        if (parsed && parsed.name === 'Transfer' && log.address.toLowerCase() === tokenOut.toLowerCase()) {
          if (parsed.args.to.toLowerCase() === chain.wallet.address.toLowerCase()) {
            amountOut = BigInt(parsed.args.value);
            break;
          }
        }
      } catch {
        // Not our event
      }
    }

    if (amountOut === 0n) {
      throw new Error(
        `1inch swap tx succeeded (${receipt.hash}) but could not parse Transfer event for output token. ` +
        `Expected ${swapResponse.dstAmount} of ${tokenOut}. ` +
        `Check tx receipt manually — tokens may be in wallet or lost to unexpected routing.`,
      );
    }

    logger.info(`1inch swap confirmed: ${receipt.hash}`, {
      amountIn: amountIn.toString(),
      amountOut: amountOut.toString(),
      gasUsed: receipt.gasUsed.toString(),
    });

    return {
      tokenIn,
      tokenOut,
      amountIn,
      amountOut,
      configuredSlippageBps: slippageBps,
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
 * Ensure sufficient token approval for 1inch router
 */
async function ensureOneInchApproval(
  tokenAddress: string,
  amount: bigint,
  routerAddress: string,
  chain: ChainContext,
): Promise<void> {
  const tokenContract = new ethers.Contract(
    tokenAddress,
    ['function allowance(address owner, address spender) view returns (uint256)',
     'function approve(address spender, uint256 amount) returns (bool)'],
    chain.wallet,
  );

  const currentAllowance = BigInt(
    await tokenContract.allowance(chain.wallet.address, routerAddress),
  );

  if (currentAllowance >= amount) {
    logger.debug(`Sufficient 1inch allowance for ${tokenAddress}: ${currentAllowance}`);
    return;
  }

  logger.info(`Approving ${amount} of ${tokenAddress} to 1inch router ${routerAddress}`);

  const nonce = await chain.nonceManager.getNextNonce();

  try {
    const tx = await tokenContract.approve(routerAddress, amount, {
      gasLimit: GAS_LIMITS.APPROVE,
      nonce,
    });
    await tx.wait();
    chain.nonceManager.confirmNonce(nonce);
    logger.info(`1inch approval confirmed: ${tx.hash}`);
  } catch (error) {
    await chain.nonceManager.resetNonce();
    throw error;
  }
}

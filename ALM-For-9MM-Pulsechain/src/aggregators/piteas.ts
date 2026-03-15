/**
 * Piteas DEX Aggregator Integration
 * 
 * Piteas (app.piteas.io) aggregates liquidity across multiple DEXes on PulseChain
 * to provide better swap execution than single-DEX routing.
 * 
 * API Documentation: https://docs.piteas.io
 */

import { ethers } from 'ethers';
import type { ChainContext } from '../chain.js';
import type { SwapResult } from '../types.js';
import { GAS_LIMITS } from '../config/index.js';
import logger from '../logger.js';

const PITEAS_API_BASE = 'https://api.piteas.io';
const PITEAS_ROUTER_ADDRESS = '0x3334F2A75ab4F8C70c3F8c0e9d8b4571a2fB4a4A'; // Piteas Router V2 on PulseChain

interface PiteasQuoteResponse {
  inputAmount: string;
  outputAmount: string;
  route: PiteasRoute[];
  gasEstimate: string;
  priceImpact: string;
  executionPrice: string;
}

interface PiteasRoute {
  protocol: string;
  poolAddress: string;
  tokenIn: string;
  tokenOut: string;
  amountIn: string;
  amountOut: string;
}

interface PiteasSwapData {
  to: string;
  data: string;
  value: string;
}

/**
 * Get a swap quote from Piteas aggregator
 */
export async function getPiteasQuote(
  tokenIn: string,
  tokenOut: string,
  amountIn: bigint,
  slippageBps: number,
  chainId: number,
): Promise<PiteasQuoteResponse> {
  const params = new URLSearchParams({
    chainId: chainId.toString(),
    tokenIn,
    tokenOut,
    amount: amountIn.toString(),
    slippage: (slippageBps / 100).toString(), // Convert bps to percentage
  });

  const url = `${PITEAS_API_BASE}/v1/quote?${params}`;
  
  logger.info(`Fetching Piteas quote: ${url}`);

  const response = await fetch(url);
  
  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Piteas API error (${response.status}): ${errorText}`);
  }

  const quote = await response.json() as PiteasQuoteResponse;
  
  logger.info('Piteas quote received', {
    inputAmount: quote.inputAmount,
    outputAmount: quote.outputAmount,
    priceImpact: quote.priceImpact,
    routes: quote.route.length,
  });

  return quote;
}

/**
 * Get swap transaction data from Piteas
 */
export async function getPiteasSwapData(
  tokenIn: string,
  tokenOut: string,
  amountIn: bigint,
  amountOutMin: bigint,
  recipient: string,
  slippageBps: number,
  chainId: number,
): Promise<PiteasSwapData> {
  const params = new URLSearchParams({
    chainId: chainId.toString(),
    tokenIn,
    tokenOut,
    amount: amountIn.toString(),
    minAmountOut: amountOutMin.toString(),
    recipient,
    slippage: (slippageBps / 100).toString(),
  });

  const url = `${PITEAS_API_BASE}/v1/swap?${params}`;
  
  logger.info(`Fetching Piteas swap data: ${url}`);

  const response = await fetch(url);
  
  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Piteas swap API error (${response.status}): ${errorText}`);
  }

  return await response.json() as PiteasSwapData;
}

/**
 * Execute a swap through Piteas aggregator
 */
export async function executeSwapViaPiteas(
  tokenIn: string,
  tokenOut: string,
  amountIn: bigint,
  slippageBps: number,
  chainId: number,
  chain: ChainContext,
): Promise<SwapResult> {
  logger.info('Executing swap via Piteas aggregator', {
    tokenIn,
    tokenOut,
    amountIn: amountIn.toString(),
    slippageBps,
  });

  // Step 1: Get quote to calculate expected output
  const quote = await getPiteasQuote(
    tokenIn,
    tokenOut,
    amountIn,
    slippageBps,
    chainId,
  );

  const expectedOutput = BigInt(quote.outputAmount);
  const amountOutMin = expectedOutput - (expectedOutput * BigInt(slippageBps)) / 10_000n;

  // Step 2: Get swap transaction data
  const swapData = await getPiteasSwapData(
    tokenIn,
    tokenOut,
    amountIn,
    amountOutMin,
    chain.wallet.address,
    slippageBps,
    chainId,
  );

  // Step 3: Approve token to Piteas router if needed
  await ensurePiteasApproval(tokenIn, amountIn, chain);

  // Step 4: Validate swap transaction data before sending
  // SECURITY: swapData comes from an external API — validate all fields to prevent
  // a compromised or MitM'd API from redirecting funds or draining native PLS.
  if (swapData.to.toLowerCase() !== PITEAS_ROUTER_ADDRESS.toLowerCase()) {
    throw new Error(
      `Piteas API returned unexpected router address: ${swapData.to} — expected ${PITEAS_ROUTER_ADDRESS}. Aborting swap.`,
    );
  }
  const swapValue = BigInt(swapData.value);
  if (swapValue !== 0n) {
    // Both HEX and WPLS are ERC-20 tokens — value should always be 0 for ERC-20 swaps.
    // A non-zero value would drain native PLS to the router.
    throw new Error(
      `Piteas API returned non-zero value (${swapValue}) for ERC-20 swap — aborting to prevent PLS drain.`,
    );
  }

  // Step 5: Execute the swap transaction
  const nonce = await chain.nonceManager.getNextNonce();

  try {
    const tx = await chain.wallet.sendTransaction({
      to: swapData.to,
      data: swapData.data,
      value: 0n, // Explicitly 0 — validated above; never trust the API value directly
      gasLimit: BigInt(GAS_LIMITS.SWAP) * 2n, // Aggregator swaps may use more gas
      nonce,
    });

    logger.info(`Piteas swap tx submitted: ${tx.hash}`);

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
        `Piteas swap tx succeeded (${receipt.hash}) but could not parse Transfer event for output token. ` +
        `Expected ${expectedOutput.toString()} of ${tokenOut}. ` +
        `Check tx receipt manually — tokens may be in wallet or lost to unexpected routing.`,
      );
    }

    logger.info(`Piteas swap confirmed: ${receipt.hash}`, {
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
 * Ensure sufficient token approval for Piteas router
 */
async function ensurePiteasApproval(
  tokenAddress: string,
  amount: bigint,
  chain: ChainContext,
): Promise<void> {
  const tokenContract = new ethers.Contract(
    tokenAddress,
    ['function allowance(address owner, address spender) view returns (uint256)', 
     'function approve(address spender, uint256 amount) returns (bool)'],
    chain.wallet,
  );

  const currentAllowance = BigInt(
    await tokenContract.allowance(chain.wallet.address, PITEAS_ROUTER_ADDRESS),
  );

  if (currentAllowance >= amount) {
    logger.debug(`Sufficient Piteas allowance for ${tokenAddress}: ${currentAllowance}`);
    return;
  }

  logger.info(`Approving ${amount} of ${tokenAddress} to Piteas router ${PITEAS_ROUTER_ADDRESS}`);

  const nonce = await chain.nonceManager.getNextNonce();
  
  try {
    const tx = await tokenContract.approve(PITEAS_ROUTER_ADDRESS, amount, {
      gasLimit: GAS_LIMITS.APPROVE,
      nonce,
    });
    await tx.wait();
    chain.nonceManager.confirmNonce(nonce);
    logger.info(`Piteas approval confirmed: ${tx.hash}`);
  } catch (error) {
    await chain.nonceManager.resetNonce();
    throw error;
  }
}

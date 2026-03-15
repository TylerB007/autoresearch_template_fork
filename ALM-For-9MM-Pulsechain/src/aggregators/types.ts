/**
 * Common interface for DEX swap aggregators (Piteas, 1inch, etc.)
 *
 * Each aggregator implementation handles its own:
 * - API communication (quotes, swap data)
 * - Security validation (router address, value assertions)
 * - Token approvals
 * - Transaction submission and receipt parsing
 */

import type { ChainContext } from '../chain.js';
import type { SwapResult } from '../types.js';

export interface AggregatorQuote {
  /** Expected output amount (before slippage) */
  outputAmount: bigint;
  /** Estimated price impact as a percentage string, e.g. "0.12" */
  priceImpact?: string;
}

export interface SwapAggregator {
  /** Human-readable name for logging (e.g. 'Piteas', '1inch') */
  readonly name: string;

  /**
   * Execute a swap through the aggregator.
   * Implementations must handle: approval, security validation,
   * tx submission, nonce management, and receipt parsing.
   */
  executeSwap(
    tokenIn: string,
    tokenOut: string,
    amountIn: bigint,
    slippageBps: number,
    chainId: number,
    chain: ChainContext,
  ): Promise<SwapResult>;
}

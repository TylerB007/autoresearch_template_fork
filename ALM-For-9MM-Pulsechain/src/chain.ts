/**
 * Chain infrastructure — RPC fallback provider, wallet signer, nonce management
 */

import { ethers } from 'ethers';
import type { AppConfig, ChainConfig, NonceManager as INonceManager, FallbackProviderState } from './types.js';
import logger from './logger.js';

/** Redact RPC URL to hostname only — prevents API key leakage in logs */
function redactUrl(url: string): string {
  try {
    const u = new URL(url);
    return u.hostname;
  } catch {
    return '<invalid-url>';
  }
}

// ============================================================
// RPC FALLBACK PROVIDER
// ============================================================

class FallbackRpcProvider {
  private state: FallbackProviderState;
  private providers: ethers.JsonRpcProvider[];
  private readonly MAX_FAILURES = 3;
  private readonly RECOVERY_MS = 60_000;

  constructor(rpcUrls: string[], chainId: number, chainName: string) {
    this.state = {
      currentIndex: 0,
      providers: rpcUrls.map((url) => ({ url, failureCount: 0, lastFailure: 0 })),
    };
    const network = new ethers.Network(chainName.toLowerCase(), chainId);
    this.providers = rpcUrls.map(
      (url) => new ethers.JsonRpcProvider(url, network, { staticNetwork: network }),
    );
  }

  getProvider(): ethers.JsonRpcProvider {
    return this.providers[this.state.currentIndex];
  }

  getCurrentUrl(): string {
    return this.state.providers[this.state.currentIndex].url;
  }

  reportFailure(): ethers.JsonRpcProvider {
    const current = this.state.providers[this.state.currentIndex];
    current.failureCount++;
    current.lastFailure = Date.now();
    logger.warn(`RPC failure on ${redactUrl(current.url)} (count: ${current.failureCount})`);

    if (current.failureCount >= this.MAX_FAILURES) {
      const nextIndex = this.findNextHealthy();
      if (nextIndex === -1) {
        logger.error('All RPC providers have exceeded failure threshold. Resetting all.');
        for (const p of this.state.providers) {
          p.failureCount = 0;
        }
        this.state.currentIndex = 0;
      } else {
        this.state.currentIndex = nextIndex;
        logger.info(`Rotated to RPC: ${redactUrl(this.state.providers[nextIndex].url)}`);
      }
    }
    return this.providers[this.state.currentIndex];
  }

  reportSuccess(): void {
    this.state.providers[this.state.currentIndex].failureCount = 0;
  }

  private findNextHealthy(): number {
    const now = Date.now();
    for (let i = 0; i < this.state.providers.length; i++) {
      const idx = (this.state.currentIndex + 1 + i) % this.state.providers.length;
      const p = this.state.providers[idx];
      if (p.failureCount < this.MAX_FAILURES || now - p.lastFailure > this.RECOVERY_MS) {
        return idx;
      }
    }
    return -1;
  }
}

// ============================================================
// NONCE TRACKER
// ============================================================

class NonceTracker implements INonceManager {
  private currentNonce: number | null = null;
  private lastConfirmedNonce: number = -1;
  private pendingNonces: Set<number> = new Set();
  private wallet: ethers.Wallet;

  constructor(wallet: ethers.Wallet) {
    this.wallet = wallet;
  }

  updateWallet(wallet: ethers.Wallet): void {
    this.wallet = wallet;
  }

  async getNextNonce(): Promise<number> {
    if (this.currentNonce === null) {
      this.currentNonce = await this.wallet.getNonce('pending');
      logger.debug(`Initialized nonce from chain: ${this.currentNonce}`);
    }
    const nonce = this.currentNonce;
    this.pendingNonces.add(nonce);
    this.currentNonce++;
    return nonce;
  }

  confirmNonce(nonce: number): void {
    this.pendingNonces.delete(nonce);
    if (nonce > this.lastConfirmedNonce) {
      this.lastConfirmedNonce = nonce;
    }
  }

  async resetNonce(): Promise<void> {
    // Query chain nonce twice with a delay to handle RPC propagation lag
    // after provider rotation (new provider may have stale mempool state)
    const chainNonce1 = await this.wallet.getNonce('pending');
    await new Promise(resolve => setTimeout(resolve, 2000));
    const chainNonce2 = await this.wallet.getNonce('pending');
    const chainNonce = Math.max(chainNonce1, chainNonce2);

    // Never go below the highest confirmed nonce + 1 — even if the RPC
    // returns a stale value, we know these nonces were already used
    const safeNonce = Math.max(chainNonce, this.lastConfirmedNonce + 1);
    this.currentNonce = safeNonce;
    this.pendingNonces.clear();
    logger.info(`Nonce reset: chain=${chainNonce} (queries: ${chainNonce1}, ${chainNonce2}), lastConfirmed=${this.lastConfirmedNonce}, using=${safeNonce}`);
  }
}

// ============================================================
// CHAIN CONTEXT
// ============================================================

export interface ChainContext {
  provider: ethers.JsonRpcProvider;
  wallet: ethers.Wallet;
  nonceManager: INonceManager;
  withRetry<T>(fn: (provider: ethers.JsonRpcProvider) => Promise<T>, maxRetries?: number): Promise<T>;
}

export function setupChain(config: AppConfig): ChainContext {
  const fallback = new FallbackRpcProvider(config.rpcUrls, config.chain.chainId, config.chain.chainName);

  // Capture private key in this closure only — it is NOT retained on config after setup
  const privateKey = config.privateKey;
  let wallet = new ethers.Wallet(privateKey, fallback.getProvider());
  const nonceManager = new NonceTracker(wallet);

  // Remove privateKey from config so it can't be accidentally serialized
  delete (config as unknown as Record<string, unknown>).privateKey;

  logger.info(`Using RPC: ${redactUrl(fallback.getCurrentUrl())}`);

  async function withRetry<T>(
    fn: (provider: ethers.JsonRpcProvider) => Promise<T>,
    maxRetries: number = 3,
  ): Promise<T> {
    let lastError: unknown;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const result = await fn(fallback.getProvider());
        fallback.reportSuccess();
        return result;
      } catch (error) {
        lastError = error;
        logger.warn(
          `RPC call failed (attempt ${attempt + 1}/${maxRetries + 1}): ${error instanceof Error ? error.message : error}`,
        );
        // CALL_EXCEPTION with data=null means the RPC failed to execute the call
        // (common with EIP-1167 proxy contracts on some RPCs). Retry with fallback RPC.
        // A real contract revert has non-null data — throw immediately.
        if ((error as { code?: string })?.code === 'CALL_EXCEPTION') {
          const errData = (error as { data?: unknown })?.data;
          if (errData !== null && errData !== undefined) {
            throw error; // Real revert — don't retry
          }
          // data=null: RPC issue, fall through to retry
        }
        if (attempt < maxRetries) {
          const newProvider = fallback.reportFailure();
          wallet = new ethers.Wallet(privateKey, newProvider);
          nonceManager.updateWallet(wallet);
        }
      }
    }
    throw lastError;
  }

  return {
    get provider() {
      return fallback.getProvider();
    },
    get wallet() {
      return wallet;
    },
    nonceManager,
    withRetry,
  };
}

/**
 * Create a ChainContext for a specific chain configuration.
 * Used by setupAllChains for multi-chain operation.
 */
export function setupChainForConfig(
  chainConfig: ChainConfig,
  rpcUrls: string[],
  privateKey: string,
): ChainContext {
  const fallback = new FallbackRpcProvider(rpcUrls, chainConfig.chainId, chainConfig.chainName);
  let wallet = new ethers.Wallet(privateKey, fallback.getProvider());
  const nonceManager = new NonceTracker(wallet);

  logger.info(`[${chainConfig.chainName}] Using RPC: ${redactUrl(fallback.getCurrentUrl())}`);

  async function withRetry<T>(
    fn: (provider: ethers.JsonRpcProvider) => Promise<T>,
    maxRetries: number = 3,
  ): Promise<T> {
    let lastError: unknown;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const result = await fn(fallback.getProvider());
        fallback.reportSuccess();
        return result;
      } catch (error) {
        lastError = error;
        logger.warn(
          `[${chainConfig.chainName}] RPC call failed (attempt ${attempt + 1}/${maxRetries + 1}): ${error instanceof Error ? error.message : error}`,
        );
        // CALL_EXCEPTION with data=null means the RPC failed to execute the call
        // (common with EIP-1167 proxy contracts on some RPCs). Retry with fallback RPC.
        if ((error as { code?: string })?.code === 'CALL_EXCEPTION') {
          const errData = (error as { data?: unknown })?.data;
          if (errData !== null && errData !== undefined) {
            throw error; // Real revert — don't retry
          }
        }
        if (attempt < maxRetries) {
          const newProvider = fallback.reportFailure();
          wallet = new ethers.Wallet(privateKey, newProvider);
          nonceManager.updateWallet(wallet);
        }
      }
    }
    throw lastError;
  }

  return {
    get provider() {
      return fallback.getProvider();
    },
    get wallet() {
      return wallet;
    },
    nonceManager,
    withRetry,
  };
}

/**
 * Create ChainContext instances for all configured chains.
 * The private key is the same across all chains (same EOA address on every EVM chain).
 * Removes privateKey from config after all chains are initialized.
 */
export function setupAllChains(config: AppConfig): Map<number, ChainContext> {
  const privateKey = config.privateKey;
  const chainContexts = new Map<number, ChainContext>();

  for (const [chainId, chainConfig] of config.chains) {
    const rpcUrls = config.rpcUrlsByChain.get(chainId) ?? chainConfig.rpcUrls;
    chainContexts.set(chainId, setupChainForConfig(chainConfig, rpcUrls, privateKey));
  }

  // Remove privateKey from config so it can't be accidentally serialized
  delete (config as unknown as Record<string, unknown>).privateKey;

  return chainContexts;
}

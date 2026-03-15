/**
 * Multi-chain context — central resolver for per-position chain + contracts.
 *
 * Given a PositionConfig, resolves the correct ChainContext and ContractInstances
 * based on the position's chain_id and dex fields.
 */

import type { ChainContext } from './chain.js';
import type { ContractInstances, ContractRegistry } from './contracts.js';
import type { AppConfig, ChainConfig, PositionConfig } from './types.js';

export interface MultiChainContext {
  /** All chain contexts keyed by chainId */
  chains: Map<number, ChainContext>;
  /** All contract registries keyed by chainId */
  registries: Map<number, ContractRegistry>;
  /** The default chain ID (first configured chain) */
  defaultChainId: number;

  /** Get chain context by ID (throws if not configured) */
  getChainById(chainId: number): ChainContext;
  /** Get chain config by ID (throws if not configured) */
  getChainConfig(chainId: number): ChainConfig;
  /** Get contract registry for a position (resolves chain_id) */
  getRegistry(pos: PositionConfig): ContractRegistry;
  /** Get contracts for a position (resolves chain_id + dex) */
  getContracts(pos: PositionConfig): ContractInstances;
  /** Resolve the effective chain ID for a position */
  resolveChainId(pos: PositionConfig): number;
  /** Get all configured chain IDs */
  getChainIds(): number[];
}

export function createMultiChainContext(
  config: AppConfig,
  chains: Map<number, ChainContext>,
  registries: Map<number, ContractRegistry>,
): MultiChainContext {
  const defaultChainId = config.chain.chainId;

  function resolveChainId(pos: PositionConfig): number {
    return pos.chain_id ?? defaultChainId;
  }

  return {
    chains,
    registries,
    defaultChainId,

    resolveChainId,

    getChainById(chainId: number): ChainContext {
      const ctx = chains.get(chainId);
      if (!ctx) throw new Error(`No chain context for chainId ${chainId}. Configured: ${[...chains.keys()].join(', ')}`);
      return ctx;
    },

    getChainConfig(chainId: number): ChainConfig {
      const cfg = config.chains.get(chainId);
      if (!cfg) throw new Error(`No chain config for chainId ${chainId}. Configured: ${[...config.chains.keys()].join(', ')}`);
      return cfg;
    },

    getRegistry(pos: PositionConfig): ContractRegistry {
      const chainId = resolveChainId(pos);
      const reg = registries.get(chainId);
      if (!reg) throw new Error(`No contract registry for chainId ${chainId}`);
      return reg;
    },

    getContracts(pos: PositionConfig): ContractInstances {
      const registry = this.getRegistry(pos);
      return registry.getForDex(pos.dex);
    },

    getChainIds(): number[] {
      return [...chains.keys()];
    },
  };
}

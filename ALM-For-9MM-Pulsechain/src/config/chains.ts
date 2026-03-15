/**
 * Chain Registry — multi-chain, multi-DEX configuration
 *
 * Each chain entry defines its network metadata, V3 contract addresses, fee tier mappings,
 * token addresses, aggregator support, and DexScreener slug for price lookups.
 *
 * Multi-DEX: Chains with multiple V3 DEXes (e.g. Arbitrum with both Uniswap V3 and
 * PancakeSwap V3) use the optional `dexes` map. Positions specify which DEX via the
 * `dex` field in config.yaml. The top-level `contracts`/`swapRouterType`/`feeTiers` serve
 * as the default DEX when no `dex` is specified.
 *
 * To add a new chain:
 * 1. Create a chain config file in src/config/ (e.g. arbitrum.ts)
 * 2. Create a new entry in CHAIN_REGISTRY keyed by chain ID
 * 3. If the chain has multiple DEXes, populate the `dexes` map
 * 4. The configLoader will automatically resolve the chain from config.yaml chain.chainId
 */

import { PULSECHAIN_CONFIG } from './pulsechain.js';
import { CONTRACTS, TOKENS } from './contracts.js';
import { ETHEREUM_CONFIG, ETHEREUM_CONTRACTS, ETHEREUM_TOKENS } from './ethereum.js';
import { BASE_CONFIG, BASE_CONTRACTS, BASE_TOKENS } from './base.js';
import { ARBITRUM_CONFIG, ARBITRUM_CONTRACTS_UNISWAP, ARBITRUM_CONTRACTS_PANCAKESWAP, ARBITRUM_TOKENS } from './arbitrum.js';
import { SONIC_CHAIN_CONFIG, SONIC_CONTRACTS, SONIC_TOKENS } from './sonic.js';

// ============================================================
// Chain Registry Types
// ============================================================

/** DEX-specific config for chains that host multiple V3 protocols */
export interface DexConfig {
  protocolName: string;
  contracts: {
    nonfungiblePositionManager: string;
    swapRouter: string;
    factory: string;
    quoter: string;
  };
  swapRouterType: 'pancakeswap-v3' | 'uniswap-v3' | 'aerodrome-cl' | 'algebra-v3';
  feeTiers: Record<number, number>;
}

export interface ChainRegistryEntry {
  /** Numeric EVM chain ID */
  chainId: number;
  /** Human-readable chain name */
  chainName: string;
  /** V3 DEX protocol name (e.g. "9mm V3", "Uniswap V3") */
  protocolName: string;
  /** Default RPC URLs (can be overridden via .env or config.yaml) */
  rpcUrls: string[];
  /** Block explorer base URL (first entry used for tx links) */
  blockExplorerUrl: string;
  /** Native currency symbol (PLS, ETH, etc.) */
  nativeCurrencySymbol: string;
  /** Block time in seconds */
  blockTimeSeconds: number;

  /** V3 core contract addresses */
  contracts: {
    nonfungiblePositionManager: string;
    swapRouter: string;
    factory: string;
    quoter: string;
  };

  /**
   * Fee tier → tick spacing mapping
   * CRITICAL: 9mm uses 2500 (tick spacing 50) while Uniswap uses 3000 (tick spacing 60)
   */
  feeTiers: Record<number, number>;

  /** Well-known token addresses on this chain */
  tokens: Record<string, string>;

  /** DexScreener chain slug for price API (e.g. "pulsechain", "ethereum") */
  dexScreenerSlug: string;

  /** Optional indexed pricing endpoints for historical block-scoped token valuation */
  graphQLEndpoints?: Record<string, string>;

  /** Wrapped native token address (WPLS on PulseChain, WETH on Ethereum/Base) */
  wrappedNativeAddress: string;

  /** SwapRouter ABI variant — determines struct fields (e.g. deadline presence) */
  swapRouterType: 'pancakeswap-v3' | 'uniswap-v3' | 'aerodrome-cl' | 'algebra-v3';

  /** Optional multi-DEX support — positions can specify which DEX via `dex` field */
  dexes?: Record<string, DexConfig>;

  /** Supported DEX aggregators on this chain */
  aggregators: {
    piteas?: {
      routerAddress: string;
      apiBase: string;
    };
    oneinch?: {
      routerAddress: string;
      apiBase: string;
    };
  };
}

// ============================================================
// Chain Registry
// ============================================================

export const CHAIN_REGISTRY: Record<number, ChainRegistryEntry> = {
  // PulseChain — 9mm V3
  369: {
    chainId: 369,
    chainName: PULSECHAIN_CONFIG.chainName,
    protocolName: '9mm V3',
    rpcUrls: [...PULSECHAIN_CONFIG.rpcUrls],
    blockExplorerUrl: PULSECHAIN_CONFIG.blockExplorerUrls[0],
    nativeCurrencySymbol: PULSECHAIN_CONFIG.nativeCurrency.symbol,
    blockTimeSeconds: PULSECHAIN_CONFIG.blockTimeSeconds,
    contracts: {
      nonfungiblePositionManager: CONTRACTS.NONFUNGIBLE_POSITION_MANAGER,
      swapRouter: CONTRACTS.SWAP_ROUTER,
      factory: CONTRACTS.FACTORY,
      quoter: CONTRACTS.QUOTER,
    },
    feeTiers: {
      100: 1,
      500: 10,
      2500: 50,    // 9mm MEDIUM: 0.25%, tick spacing 50 (NOT Uniswap's 3000/60!)
      10000: 200,
    },
    tokens: { ...TOKENS },
    dexScreenerSlug: 'pulsechain',
    graphQLEndpoints: { ...PULSECHAIN_CONFIG.graphQLEndpoints },
    wrappedNativeAddress: TOKENS.WPLS,
    swapRouterType: 'pancakeswap-v3',
    aggregators: {
      piteas: {
        routerAddress: '0x3334F2A75ab4F8C70c3F8c0e9d8b4571a2fB4a4A',
        apiBase: 'https://api.piteas.io',
      },
    },
  },

  // Ethereum Mainnet — Uniswap V3
  1: {
    chainId: 1,
    chainName: ETHEREUM_CONFIG.chainName,
    protocolName: 'Uniswap V3',
    rpcUrls: [...ETHEREUM_CONFIG.rpcUrls],
    blockExplorerUrl: ETHEREUM_CONFIG.blockExplorerUrls[0],
    nativeCurrencySymbol: ETHEREUM_CONFIG.nativeCurrency.symbol,
    blockTimeSeconds: ETHEREUM_CONFIG.blockTimeSeconds,
    contracts: {
      nonfungiblePositionManager: ETHEREUM_CONTRACTS.NONFUNGIBLE_POSITION_MANAGER,
      swapRouter: ETHEREUM_CONTRACTS.SWAP_ROUTER,
      factory: ETHEREUM_CONTRACTS.FACTORY,
      quoter: ETHEREUM_CONTRACTS.QUOTER,
    },
    feeTiers: {
      100: 1,
      500: 10,
      3000: 60,    // Uniswap MEDIUM: 0.30%, tick spacing 60 (NOT 9mm's 2500/50!)
      10000: 200,
    },
    tokens: { ...ETHEREUM_TOKENS },
    dexScreenerSlug: 'ethereum',
    graphQLEndpoints: { ...ETHEREUM_CONFIG.graphQLEndpoints },
    wrappedNativeAddress: ETHEREUM_TOKENS.WETH,
    swapRouterType: 'uniswap-v3',
    aggregators: {
      oneinch: {
        routerAddress: '0x111111125421cA6dc452d289314280a0f8842A65',
        apiBase: 'https://api.1inch.dev/swap/v6.0/1',
      },
    },
  },

  // Base Mainnet — Uniswap V3 (default) + Aerodrome CL (Slipstream)
  8453: {
    chainId: 8453,
    chainName: BASE_CONFIG.chainName,
    protocolName: 'Uniswap V3', // default DEX
    rpcUrls: [...BASE_CONFIG.rpcUrls],
    blockExplorerUrl: BASE_CONFIG.blockExplorerUrls[0],
    nativeCurrencySymbol: BASE_CONFIG.nativeCurrency.symbol,
    blockTimeSeconds: BASE_CONFIG.blockTimeSeconds,
    contracts: {
      // Default: Uniswap V3
      nonfungiblePositionManager: BASE_CONTRACTS.NONFUNGIBLE_POSITION_MANAGER,
      swapRouter: BASE_CONTRACTS.SWAP_ROUTER,
      factory: BASE_CONTRACTS.FACTORY,
      quoter: BASE_CONTRACTS.QUOTER,
    },
    feeTiers: {
      100: 1,
      500: 10,
      3000: 60,    // Uniswap MEDIUM: 0.30%, tick spacing 60 (same as Ethereum)
      10000: 200,
    },
    tokens: { ...BASE_TOKENS },
    dexScreenerSlug: 'base',
    graphQLEndpoints: { ...BASE_CONFIG.graphQLEndpoints },
    wrappedNativeAddress: BASE_TOKENS.WETH,
    swapRouterType: 'uniswap-v3',
    dexes: {
      'uniswap-v3': {
        protocolName: 'Uniswap V3',
        contracts: {
          nonfungiblePositionManager: BASE_CONTRACTS.NONFUNGIBLE_POSITION_MANAGER,
          swapRouter: BASE_CONTRACTS.SWAP_ROUTER,
          factory: BASE_CONTRACTS.FACTORY,
          quoter: BASE_CONTRACTS.QUOTER,
        },
        swapRouterType: 'uniswap-v3',
        feeTiers: { 100: 1, 500: 10, 3000: 60, 10000: 200 },
      },
      'aerodrome-cl': {
        protocolName: 'Aerodrome CL',
        contracts: {
          // Original Slipstream v1 deployment
          nonfungiblePositionManager: '0x827922686190790b37229fd06084350E74485b72',
          swapRouter: '0xBE6D8f0d05cC4be24d5167a3eF062215bE6D18a5',
          factory: '0x5e7BB104d84c7CB9B682AaC2F3d509f5F406809A',
          quoter: '0x254cF9E1E6e233aa1AC962CB9B05b2cfeAaE15b0',
        },
        // CRITICAL: Aerodrome CL uses tickSpacing as pool identifier everywhere fee is used in Uniswap V3
        // feeTiers map: tickSpacing → tickSpacing (identity — tickSpacing IS the pool key)
        swapRouterType: 'aerodrome-cl',
        feeTiers: {
          1: 1,      // 0.01%
          50: 50,    // 0.05%
          100: 100,  // 0.05% (alternate spacing)
          200: 200,  // 0.30%
          2000: 2000, // 1.00%
        },
      },
      'aerodrome-cl-gc': {
        protocolName: 'Aerodrome CL (Gauge Caps)',
        contracts: {
          // Gauge Caps deployment (newer positions minted here)
          nonfungiblePositionManager: '0xa990C6a764b73BF43cee5Bb40339c3322FB9D55F',
          swapRouter: '0xcbBb8035cAc7D4B3Ca7aBb74cF7BdF900215Ce0D',
          factory: '0xaDe65c38CD4849aDBA595a4323a8C7DdfE89716a',
          quoter: '0x3d4C22254F86f64B7eC90ab8F7aeC1FBFD271c6C',
        },
        swapRouterType: 'aerodrome-cl',
        feeTiers: {
          1: 1,
          50: 50,
          100: 100,
          200: 200,
          2000: 2000,
        },
      },
    },
    aggregators: {
      oneinch: {
        routerAddress: '0x111111125421cA6dc452d289314280a0f8842A65',
        apiBase: 'https://api.1inch.dev/swap/v6.0/8453',
      },
    },
  },

  // Arbitrum One — Uniswap V3 (default) + PancakeSwap V3
  42161: {
    chainId: 42161,
    chainName: ARBITRUM_CONFIG.chainName,
    protocolName: 'Uniswap V3', // default DEX
    rpcUrls: [...ARBITRUM_CONFIG.rpcUrls],
    blockExplorerUrl: ARBITRUM_CONFIG.blockExplorerUrls[0],
    nativeCurrencySymbol: ARBITRUM_CONFIG.nativeCurrency.symbol,
    blockTimeSeconds: ARBITRUM_CONFIG.blockTimeSeconds,
    contracts: {
      // Default: Uniswap V3
      nonfungiblePositionManager: ARBITRUM_CONTRACTS_UNISWAP.NONFUNGIBLE_POSITION_MANAGER,
      swapRouter: ARBITRUM_CONTRACTS_UNISWAP.SWAP_ROUTER,
      factory: ARBITRUM_CONTRACTS_UNISWAP.FACTORY,
      quoter: ARBITRUM_CONTRACTS_UNISWAP.QUOTER,
    },
    feeTiers: {
      100: 1,
      500: 10,
      3000: 60,    // Uniswap MEDIUM: 0.30%, tick spacing 60
      10000: 200,
    },
    tokens: { ...ARBITRUM_TOKENS },
    dexScreenerSlug: 'arbitrum',
    graphQLEndpoints: { ...ARBITRUM_CONFIG.graphQLEndpoints },
    wrappedNativeAddress: ARBITRUM_TOKENS.WETH,
    swapRouterType: 'uniswap-v3',
    dexes: {
      'uniswap-v3': {
        protocolName: 'Uniswap V3',
        contracts: {
          nonfungiblePositionManager: ARBITRUM_CONTRACTS_UNISWAP.NONFUNGIBLE_POSITION_MANAGER,
          swapRouter: ARBITRUM_CONTRACTS_UNISWAP.SWAP_ROUTER,
          factory: ARBITRUM_CONTRACTS_UNISWAP.FACTORY,
          quoter: ARBITRUM_CONTRACTS_UNISWAP.QUOTER,
        },
        swapRouterType: 'uniswap-v3',
        feeTiers: { 100: 1, 500: 10, 3000: 60, 10000: 200 },
      },
      'pancakeswap-v3': {
        protocolName: 'PancakeSwap V3',
        contracts: {
          nonfungiblePositionManager: ARBITRUM_CONTRACTS_PANCAKESWAP.NONFUNGIBLE_POSITION_MANAGER,
          swapRouter: ARBITRUM_CONTRACTS_PANCAKESWAP.SWAP_ROUTER,
          factory: ARBITRUM_CONTRACTS_PANCAKESWAP.FACTORY,
          quoter: ARBITRUM_CONTRACTS_PANCAKESWAP.QUOTER,
        },
        swapRouterType: 'pancakeswap-v3',
        feeTiers: { 100: 1, 500: 10, 2500: 50, 10000: 200 },
      },
    },
    aggregators: {
      oneinch: {
        routerAddress: '0x111111125421cA6dc452d289314280a0f8842A65',
        apiBase: 'https://api.1inch.dev/swap/v6.0/42161',
      },
    },
  },

  // Sonic Mainnet — Shadow V3 (Aerodrome CL / Slipstream fork)
  146: {
    chainId: 146,
    chainName: SONIC_CHAIN_CONFIG.chainName,
    protocolName: 'Shadow V3',
    rpcUrls: [...SONIC_CHAIN_CONFIG.rpcUrls],
    blockExplorerUrl: SONIC_CHAIN_CONFIG.blockExplorerUrls[0],
    nativeCurrencySymbol: SONIC_CHAIN_CONFIG.nativeCurrency.symbol,
    blockTimeSeconds: SONIC_CHAIN_CONFIG.blockTimeSeconds,
    contracts: {
      nonfungiblePositionManager: SONIC_CONTRACTS.NONFUNGIBLE_POSITION_MANAGER,
      swapRouter: SONIC_CONTRACTS.SWAP_ROUTER,
      factory: SONIC_CONTRACTS.FACTORY,
      quoter: SONIC_CONTRACTS.QUOTER,
    },
    // Shadow.so uses tickSpacing as the pool identifier (Aerodrome CL pattern):
    // feeTiers map is identity (tickSpacing → tickSpacing)
    feeTiers: {
      1: 1,       // stable pairs
      50: 50,     // standard pairs
      100: 100,   // standard pairs (alternate spacing)
      200: 200,   // volatile pairs
      2000: 2000, // exotic pairs
    },
    tokens: { ...SONIC_TOKENS },
    dexScreenerSlug: 'sonic',
    wrappedNativeAddress: SONIC_TOKENS.WS,
    // Shadow V3 uses Algebra V3-style NPM (positions() returns 10 fields, no nonce/operator).
    // Swap router and pool interfaces match Aerodrome CL: tickSpacing in swap params, deadline,
    // pools are EIP-1167 minimal proxies (sequential RPC queries required — no Promise.all)
    swapRouterType: 'algebra-v3',
    // No multi-DEX support — Shadow.so is the only registered DEX on Sonic
    aggregators: {},
  },
};

// ============================================================
// Helper Functions
// ============================================================

/** Get a chain's registry entry by chain ID. Throws if chain is not supported. */
export function getChainConfig(chainId: number): ChainRegistryEntry {
  const entry = CHAIN_REGISTRY[chainId];
  if (!entry) {
    const supported = Object.keys(CHAIN_REGISTRY).join(', ');
    throw new Error(
      `Unsupported chain ID: ${chainId}. Supported chains: ${supported}`,
    );
  }
  return entry;
}

/** Get the tick spacing for a fee tier on a specific chain */
export function getTickSpacingForChain(fee: number, chainId: number): number {
  const chain = getChainConfig(chainId);
  const spacing = chain.feeTiers[fee];
  if (spacing === undefined) {
    const supported = Object.keys(chain.feeTiers).join(', ');
    throw new Error(
      `Unsupported fee tier ${fee} on ${chain.chainName}. Supported: ${supported}`,
    );
  }
  return spacing;
}

/** Get the block explorer transaction URL for a given chain */
export function getTxExplorerUrl(txHash: string, chainId: number): string {
  const chain = getChainConfig(chainId);
  return `${chain.blockExplorerUrl}/tx/${txHash}`;
}

/** Get DEX-specific config for a chain. Falls back to chain-level defaults if no dex specified. */
export function getDexConfig(chainId: number, dexName?: string): DexConfig {
  const chain = getChainConfig(chainId);
  if (dexName && chain.dexes?.[dexName]) {
    return chain.dexes[dexName];
  }
  // Fall back to chain-level defaults (backward compat for single-DEX chains)
  return {
    protocolName: chain.protocolName,
    contracts: chain.contracts,
    swapRouterType: chain.swapRouterType,
    feeTiers: chain.feeTiers,
  };
}

/** Get supported DEX names for a chain (empty array if single-DEX chain) */
export function getSupportedDexes(chainId: number): string[] {
  const chain = getChainConfig(chainId);
  return chain.dexes ? Object.keys(chain.dexes) : [];
}

/** Get all supported chain IDs */
export function getSupportedChainIds(): number[] {
  return Object.keys(CHAIN_REGISTRY).map(Number);
}

/** Resolve the configured historical pricing subgraph for a chain and optional DEX. */
export function getHistoricalPricingSubgraph(
  chainId: number,
  dexName?: string,
): { key: string; url: string } | null {
  const chain = getChainConfig(chainId);
  const endpoints = chain.graphQLEndpoints;
  if (!endpoints) return null;

  if (chainId === 369) {
    return endpoints['9mmV3'] ? { key: '9mmV3', url: endpoints['9mmV3'] } : null;
  }

  if (!dexName || dexName === 'uniswap-v3') {
    return endpoints.uniswapV3 ? { key: 'uniswapV3', url: endpoints.uniswapV3 } : null;
  }

  return null;
}

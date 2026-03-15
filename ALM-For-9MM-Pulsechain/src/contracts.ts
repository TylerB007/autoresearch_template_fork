/**
 * Contract instances — creates ethers.Contract objects for V3 DEX contracts
 * Uses existing ABIs from abis/ and addresses from config
 *
 * Contract instances use chain.wallet/chain.provider getters so they always
 * resolve to the current RPC provider after fallback rotation.
 *
 * ABI selection: PancakeSwap V3 forks (9mm) use SwapRouter.json (no deadline),
 * Uniswap V3 uses UniswapV3SwapRouter.json (has deadline in ExactInputSingleParams).
 *
 * Multi-DEX: ContractRegistry wraps multiple ContractInstances keyed by DEX name.
 * Chains with a single DEX use `registry.default`. Multi-DEX chains (e.g. Arbitrum)
 * resolve per-position via `registry.getForDex(posConfig.dex)`.
 */

import { ethers } from 'ethers';
import { createRequire } from 'node:module';
import type { AppConfig } from './types.js';
import type { ChainContext } from './chain.js';
import type { DexConfig } from './config/chains.js';
import { getDexConfig } from './config/chains.js';

const require = createRequire(import.meta.url);
const NonfungiblePositionManagerABI = require('../abis/NonfungiblePositionManager.json');
const PancakeSwapV3RouterABI = require('../abis/SwapRouter.json');
const UniswapV3SwapRouterABI = require('../abis/UniswapV3SwapRouter.json');
const UniswapV3PoolABI = require('../abis/UniswapV3Pool.json');
const UniswapV3FactoryABI = require('../abis/UniswapV3Factory.json');
const AerodromeNPMABI = require('../abis/AerodromeNonfungiblePositionManager.json');
const AerodromeCLFactoryABI = require('../abis/AerodromeCLFactory.json');
const AerodromeCLSwapRouterABI = require('../abis/AerodromeCLSwapRouter.json');
const AerodromeCLPoolABI = require('../abis/AerodromeCLPool.json');
const AlgebraV3NPMABI = require('../abis/AlgebraV3NonfungiblePositionManager.json');
const ERC20ABI = require('../abis/ERC20.json');
const WETH9ABI = require('../abis/WETH9.json');

export interface ContractInstances {
  positionManager: ethers.Contract;
  swapRouter: ethers.Contract;
  factory: ethers.Contract;
  /** SwapRouter ABI variant for this DEX — determines struct fields (fee vs tickSpacing, deadline) */
  readonly swapRouterType: 'pancakeswap-v3' | 'uniswap-v3' | 'aerodrome-cl' | 'algebra-v3';
  getPool(poolAddress: string): ethers.Contract;
  getERC20(tokenAddress: string): ethers.Contract;
  getWrappedNative(): ethers.Contract;
  /** @deprecated Use getWrappedNative() — kept for backward compatibility */
  getWPLS(): ethers.Contract;
}

/** Registry of contract instances, supporting multi-DEX chains */
export interface ContractRegistry {
  /** Get contracts for a specific DEX (or the chain default if no name given) */
  getForDex(dexName?: string): ContractInstances;
  /** The default (chain-level) contracts — backward compat */
  default: ContractInstances;
}

/**
 * Build a ContractInstances object for a specific DEX configuration.
 */
function buildContractsForDex(
  dexConfig: DexConfig,
  wrappedNativeAddress: string,
  chain: ChainContext,
): ContractInstances {
  const npmAddress = dexConfig.contracts.nonfungiblePositionManager;
  const swapRouterAddress = dexConfig.contracts.swapRouter;
  const factoryAddress = dexConfig.contracts.factory;
  const routerType = dexConfig.swapRouterType;

  // Algebra V3 (Shadow V3) uses same pool/factory/router ABIs as Aerodrome CL,
  // but its NPM has a different positions() return (10 fields, no nonce/operator).
  const isAerodromeStyle = routerType === 'aerodrome-cl' || routerType === 'algebra-v3';
  const npmABI = routerType === 'algebra-v3'
    ? AlgebraV3NPMABI
    : isAerodromeStyle
      ? AerodromeNPMABI
      : NonfungiblePositionManagerABI;
  const factoryABI = isAerodromeStyle ? AerodromeCLFactoryABI : UniswapV3FactoryABI;
  const swapRouterABI = routerType === 'uniswap-v3'
    ? UniswapV3SwapRouterABI
    : isAerodromeStyle
      ? AerodromeCLSwapRouterABI
      : PancakeSwapV3RouterABI;

  return {
    get positionManager() {
      return new ethers.Contract(npmAddress, npmABI, chain.wallet);
    },
    get swapRouter() {
      return new ethers.Contract(swapRouterAddress, swapRouterABI, chain.wallet);
    },
    get factory() {
      return new ethers.Contract(factoryAddress, factoryABI, chain.provider);
    },
    swapRouterType: routerType,
    getPool(poolAddress: string): ethers.Contract {
      const poolABI = isAerodromeStyle ? AerodromeCLPoolABI : UniswapV3PoolABI;
      return new ethers.Contract(poolAddress, poolABI, chain.provider);
    },
    getERC20(tokenAddress: string): ethers.Contract {
      return new ethers.Contract(tokenAddress, ERC20ABI, chain.wallet);
    },
    getWrappedNative(): ethers.Contract {
      return new ethers.Contract(wrappedNativeAddress, WETH9ABI, chain.wallet);
    },
    getWPLS(): ethers.Contract {
      return this.getWrappedNative();
    },
  };
}

/**
 * Create contract instances for the chain's default DEX.
 * Use this for single-DEX chains or when you don't need per-position DEX resolution.
 */
export function createContracts(config: AppConfig, chain: ChainContext): ContractInstances {
  const defaultDex = getDexConfig(config.chain.chainId);
  return buildContractsForDex(defaultDex, config.chain.wrappedNativeAddress, chain);
}

/**
 * Create a ContractRegistry that supports per-position DEX resolution.
 * Use this when the chain supports multiple DEXes (e.g. Arbitrum with Uniswap V3 + PancakeSwap V3).
 * Falls back to chain defaults for positions without a `dex` field.
 */
export function createContractRegistry(config: AppConfig, chain: ChainContext): ContractRegistry {
  const cache = new Map<string, ContractInstances>();
  const wrappedNativeAddress = config.chain.wrappedNativeAddress;
  const chainId = config.chain.chainId;

  const defaultContracts = createContracts(config, chain);

  return {
    default: defaultContracts,
    getForDex(dexName?: string): ContractInstances {
      if (!dexName) return defaultContracts;
      const cached = cache.get(dexName);
      if (cached) return cached;
      const dexConfig = getDexConfig(chainId, dexName);
      const contracts = buildContractsForDex(dexConfig, wrappedNativeAddress, chain);
      cache.set(dexName, contracts);
      return contracts;
    },
  };
}

/**
 * Create a ContractRegistry for a specific chain config.
 * Used by createAllContractRegistries for multi-chain operation.
 */
export function createContractRegistryForChain(
  chainConfig: import('./types.js').ChainConfig,
  chain: ChainContext,
): ContractRegistry {
  const cache = new Map<string, ContractInstances>();
  const wrappedNativeAddress = chainConfig.wrappedNativeAddress;
  const chainId = chainConfig.chainId;

  const defaultDex = getDexConfig(chainId);
  const defaultContracts = buildContractsForDex(defaultDex, wrappedNativeAddress, chain);

  return {
    default: defaultContracts,
    getForDex(dexName?: string): ContractInstances {
      if (!dexName) return defaultContracts;
      const cached = cache.get(dexName);
      if (cached) return cached;
      const dexConfig = getDexConfig(chainId, dexName);
      const contracts = buildContractsForDex(dexConfig, wrappedNativeAddress, chain);
      cache.set(dexName, contracts);
      return contracts;
    },
  };
}

/**
 * Create ContractRegistry instances for all configured chains.
 */
export function createAllContractRegistries(
  config: AppConfig,
  chainContexts: Map<number, ChainContext>,
): Map<number, ContractRegistry> {
  const registries = new Map<number, ContractRegistry>();
  for (const [chainId, chainCtx] of chainContexts) {
    const chainConfig = config.chains.get(chainId)!;
    registries.set(chainId, createContractRegistryForChain(chainConfig, chainCtx));
  }
  return registries;
}

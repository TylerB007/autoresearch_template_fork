/**
 * Wallet position discovery — scans all configured NPMs across all chains
 * to find LP positions owned by the wallet.
 *
 * Uses ERC721Enumerable: balanceOf() + tokenOfOwnerByIndex() + positions()
 */

import { ethers } from 'ethers';
import { createRequire } from 'node:module';
import type { MultiChainContext } from './multiChain.js';
import type { ChainContext } from './chain.js';
import type { ContractInstances } from './contracts.js';
import { getSupportedDexes, getDexConfig } from './config/chains.js';
import { getTokenInfo } from './pool.js';
import logger from './logger.js';

const _require = createRequire(import.meta.url);
const AlgebraV3NPMABI = _require('../abis/AlgebraV3NonfungiblePositionManager.json');

// Shadow V3 on Sonic had two NPM deployments. The legacy address predates the current one.
// Both use the same Algebra V3-style ABI (10-field positions() return).
const SONIC_LEGACY_NPM_ADDRESS = '0xA57FA38b3fd45922394e9E1077748A2383F1542E';
const SONIC_CHAIN_ID = 146;

const SCAN_CHAIN_TIMEOUT_MS = 30_000;

export interface DiscoveredPosition {
  tokenId: number;
  chainId: number;
  dexName: string;
  protocolName: string;
  token0: string;
  token1: string;
  token0Symbol: string;
  token1Symbol: string;
  fee: number;
  tickLower: number;
  tickUpper: number;
  liquidity: bigint;
}

export interface DiscoverResult {
  positions: DiscoveredPosition[];
  /** Chain IDs that failed to scan (RPC or contract error) */
  failedChainIds: number[];
}

/**
 * Scan all configured chains and DEXes for positions owned by the wallet.
 * Chains are scanned in parallel; within each chain, DEXes and positions
 * are queried sequentially (Aerodrome EIP-1167 proxy compatibility).
 */
export async function discoverWalletPositions(
  multiChain: MultiChainContext,
): Promise<DiscoverResult> {
  const chainIds = multiChain.getChainIds();

  const perChainResults = await Promise.allSettled(
    chainIds.map(chainId => Promise.race([
      scanChain(chainId, multiChain),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`scan timed out after ${SCAN_CHAIN_TIMEOUT_MS / 1000}s`)), SCAN_CHAIN_TIMEOUT_MS),
      ),
    ])),
  );

  const positions: DiscoveredPosition[] = [];
  const failedChainIds: number[] = [];

  for (let i = 0; i < chainIds.length; i++) {
    const result = perChainResults[i];
    if (result.status === 'fulfilled') {
      positions.push(...result.value);
    } else {
      failedChainIds.push(chainIds[i]);
      logger.warn(`Position scan failed for chain ${chainIds[i]}`, {
        error: (result.reason as Error).message,
      });
    }
  }

  return { positions, failedChainIds };
}

async function scanChain(
  chainId: number,
  multiChain: MultiChainContext,
): Promise<DiscoveredPosition[]> {
  const chain = multiChain.getChainById(chainId);
  const registry = multiChain.registries.get(chainId);
  if (!registry) return [];

  const walletAddress = chain.wallet.address;
  const dexNames = getSupportedDexes(chainId);
  const results: DiscoveredPosition[] = [];

  // Build the list of DEXes to scan. Single-DEX chains (PulseChain, Ethereum, Sonic)
  // have no `dexes` map in CHAIN_REGISTRY, so getSupportedDexes() returns [].
  // Fall back to the chain-level default contracts so those chains are not skipped.
  type ScanEntry = { dexName: string; contracts: ContractInstances; protocolName: string };
  const scanList: ScanEntry[] = [];

  if (dexNames.length > 0) {
    for (const dexName of dexNames) {
      const dexConfig = getDexConfig(chainId, dexName);
      scanList.push({ dexName, contracts: registry.getForDex(dexName), protocolName: dexConfig.protocolName });
    }
  } else {
    // Single-DEX chain: use chain-level defaults
    const dexConfig = getDexConfig(chainId);
    const defaultDexName = dexConfig.protocolName.toLowerCase().replace(/\s+/g, '-');
    scanList.push({ dexName: defaultDexName, contracts: registry.default, protocolName: dexConfig.protocolName });
  }

  for (const { dexName, contracts, protocolName } of scanList) {
    try {
      const positions = await scanNpm(walletAddress, chainId, dexName, protocolName, contracts, chain);
      results.push(...positions);
    } catch (err) {
      logger.warn(`Position scan failed for ${dexName} on chain ${chainId}`, {
        error: (err as Error).message,
      });
    }
  }

  // Sonic: also scan the legacy NPM for positions minted before the current deployment.
  // The legacy address uses the same Algebra V3-style ABI as the current NPM.
  if (chainId === SONIC_CHAIN_ID) {
    try {
      const legacyNpm = new ethers.Contract(SONIC_LEGACY_NPM_ADDRESS, AlgebraV3NPMABI, chain.wallet);
      const legacyBalance = Number(await chain.withRetry(() => legacyNpm.balanceOf(walletAddress)));
      if (legacyBalance > 0) {
        logger.info(`Found ${legacyBalance} position(s) on Shadow legacy NPM (${SONIC_LEGACY_NPM_ADDRESS})`);
        const legacyPositions = await scanNpmContract(
          walletAddress,
          chainId,
          'shadow-v3-legacy',
          'Shadow V3 (legacy NPM)',
          legacyNpm,
          chain,
        );
        results.push(...legacyPositions);
      }
    } catch (err) {
      logger.warn('Legacy Shadow NPM scan failed', { error: (err as Error).message });
    }
  }

  return results;
}

async function scanNpm(
  walletAddress: string,
  chainId: number,
  dexName: string,
  protocolName: string,
  contracts: ContractInstances,
  chain: ChainContext,
): Promise<DiscoveredPosition[]> {
  return scanNpmContract(walletAddress, chainId, dexName, protocolName, contracts.positionManager, chain, contracts);
}

/**
 * Enumerate positions from any NPM contract that supports ERC721Enumerable.
 * `contractsForTokenInfo` is optional — used to resolve token symbols. If omitted, symbols
 * fall back to 'UNKNOWN'.
 */
async function scanNpmContract(
  walletAddress: string,
  chainId: number,
  dexName: string,
  protocolName: string,
  npm: ethers.Contract,
  chain: ChainContext,
  contractsForTokenInfo?: ContractInstances,
): Promise<DiscoveredPosition[]> {
  const balance = Number(await chain.withRetry(() => npm.balanceOf(walletAddress)));
  if (balance === 0) return [];

  logger.debug(`Found ${balance} position(s) on ${dexName} (chain ${chainId})`);

  const results: DiscoveredPosition[] = [];

  // Sequential enumeration (Aerodrome EIP-1167 proxy compatibility)
  for (let i = 0; i < balance; i++) {
    try {
      const tokenId = Number(await chain.withRetry(() => npm.tokenOfOwnerByIndex(walletAddress, i)));
      const pos = await chain.withRetry(() => npm.positions(tokenId));

      const liquidity = BigInt(pos.liquidity);
      if (liquidity === 0n) continue; // Skip burned/empty positions

      const feeOrTickSpacing = pos.tickSpacing !== undefined ? Number(pos.tickSpacing) : Number(pos.fee);

      // Resolve token symbols (sequential for proxy compatibility)
      let token0Symbol = 'UNKNOWN';
      let token1Symbol = 'UNKNOWN';
      if (contractsForTokenInfo) {
        try {
          const info0 = await getTokenInfo(pos.token0, contractsForTokenInfo, chain);
          token0Symbol = info0.symbol;
        } catch { /* use fallback */ }
        try {
          const info1 = await getTokenInfo(pos.token1, contractsForTokenInfo, chain);
          token1Symbol = info1.symbol;
        } catch { /* use fallback */ }
      }

      results.push({
        tokenId,
        chainId,
        dexName,
        protocolName,
        token0: pos.token0,
        token1: pos.token1,
        token0Symbol,
        token1Symbol,
        fee: feeOrTickSpacing,
        tickLower: Number(pos.tickLower),
        tickUpper: Number(pos.tickUpper),
        liquidity,
      });
    } catch (err) {
      logger.warn(`Failed to read position index ${i} on ${dexName} (chain ${chainId})`, {
        error: (err as Error).message,
      });
    }
  }

  return results;
}

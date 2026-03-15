/**
 * backfill-history.ts — Historical position backfill from on-chain events
 *
 * Scans on-chain events for the configured wallet address and writes
 * PositionEntryRecord and FeeCollectionRecord analytics entries for
 * positions that predate the bot's analytics system.
 *
 * Usage:
 *   npx tsx src/scripts/backfill-history.ts [--chain 369] [--dry-run]
 *
 * Options:
 *   --chain <id>   Only process this chain ID (default: all configured chains)
 *   --dry-run      Print what would be written without creating any files
 *
 * Price sources (best → worst):
 *   1. Historical subgraph USD prices at the event block — event-time indexed valuation.
 *   2. On-chain sqrtPriceX96 from pool slot0 at the event block — exact pool ratio at that moment.
 *      Requires the RPC to support archive/historical state calls.
 *   3. DexScreener current prices — ESTIMATED, accuracy depends on price movement since event.
 *   4. No price — records written with priceSource:'unavailable', USD fields = 0.
 *
 * IMPORTANT: This script is a MANUAL tool. It must be explicitly invoked by the operator.
 *            It is NOT called automatically by the bot or any monitoring loop.
 */

import { ethers } from 'ethers';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { loadConfig } from '../configLoader.js';
import { getChainConfig } from '../config/chains.js';
import {
  chainStoragePath,
  ensureStorageDir,
  queryPositionEntries,
  queryFeeCollections,
  queryRebalances,
  writeAnalyticsRecord,
} from '../analytics/storage.js';
import { getPoolPriceAtBlock, sqrtPriceToHumanPrice } from '../analytics/historicalPrice.js';
import type { FeeCollectionRecord, PositionEntryRecord } from '../analytics/types.js';
import { resolveHistoricalUsdPrices } from '../pricing/historicalUsd.js';

const require = createRequire(import.meta.url);
const NonfungiblePositionManagerABI = require('../../abis/NonfungiblePositionManager.json');
const UniswapV3FactoryABI = require('../../abis/UniswapV3Factory.json');
const ERC20ABI = require('../../abis/ERC20.json');

// ============================================================
// CLI args
// ============================================================

const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const CHAIN_FILTER = (() => {
  const idx = args.indexOf('--chain');
  if (idx !== -1 && args[idx + 1]) return parseInt(args[idx + 1], 10);
  return undefined;
})();

// ============================================================
// Helpers
// ============================================================

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';
const CHUNK_SIZE = 9_999;

/**
 * Query filter events, chunking the block range if the RPC rejects a full scan.
 * Returns events sorted by block number ascending.
 */
async function queryFilterChunked(
  contract: ethers.Contract,
  filter: ethers.DeferredTopicFilter,
  fromBlock: number,
  toBlock: number,
): Promise<ethers.EventLog[]> {
  try {
    const events = await contract.queryFilter(filter, fromBlock, toBlock);
    return events as ethers.EventLog[];
  } catch {
    // Full range rejected — scan in CHUNK_SIZE windows from start to end
    const results: ethers.EventLog[] = [];
    for (let start = fromBlock; start <= toBlock; start += CHUNK_SIZE) {
      const end = Math.min(start + CHUNK_SIZE - 1, toBlock);
      try {
        const chunk = await contract.queryFilter(filter, start, end);
        results.push(...(chunk as ethers.EventLog[]));
      } catch {
        // Skip failed chunk — continue
      }
    }
    return results.sort((a, b) => a.blockNumber - b.blockNumber);
  }
}

/** Token metadata cache (address → symbol + decimals) */
const tokenMetaCache = new Map<string, { symbol: string; decimals: number }>();

async function getTokenMeta(
  address: string,
  provider: ethers.JsonRpcProvider,
): Promise<{ symbol: string; decimals: number }> {
  const key = address.toLowerCase();
  const cached = tokenMetaCache.get(key);
  if (cached) return cached;

  const token = new ethers.Contract(address, ERC20ABI, provider);
  try {
    const [symbol, decimals] = await Promise.all([token.symbol(), token.decimals()]);
    const meta = { symbol: String(symbol), decimals: Number(decimals) };
    tokenMetaCache.set(key, meta);
    return meta;
  } catch {
    const meta = { symbol: 'UNKNOWN', decimals: 18 };
    tokenMetaCache.set(key, meta);
    return meta;
  }
}

/** Fetch current USD prices from DexScreener for a set of token addresses */
async function fetchDexScreenerPrices(
  addresses: string[],
  chainSlug: string,
): Promise<Map<string, number>> {
  const result = new Map<string, number>();
  if (addresses.length === 0) return result;

  try {
    const addrList = addresses.join(',');
    const url = `https://api.dexscreener.com/tokens/v1/${chainSlug}/${addrList}`;
    const res = await fetch(url, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(12_000),
    });
    if (!res.ok) return result;

    const data = await res.json() as Array<{
      baseToken?: { address?: string };
      priceUsd?: string;
    }>;

    if (!Array.isArray(data)) return result;

    for (const pair of data) {
      const addr = pair.baseToken?.address?.toLowerCase();
      const price = pair.priceUsd ? parseFloat(pair.priceUsd) : 0;
      if (addr && price > 0 && !result.has(addr)) {
        result.set(addr, price);
      }
    }
  } catch {
    // Price fetch failed — USD values will be 0 for this chain
  }

  return result;
}

function classifyBackfillPriceSource(
  hasOnChainPoolPrice: boolean,
  historicalSource: string | null,
  usedEstimatedUsd: boolean,
): string {
  if (historicalSource) {
    return hasOnChainPoolPrice ? 'on-chain+historical_subgraph' : historicalSource;
  }
  if (usedEstimatedUsd) {
    return hasOnChainPoolPrice ? 'on-chain+estimated' : 'estimated';
  }
  return hasOnChainPoolPrice ? 'on-chain' : 'unavailable';
}

/** Format a bigint token amount as a human-readable decimal string */
function formatAmount(amount: bigint, decimals: number): string {
  return (Number(amount) / 10 ** decimals).toFixed(6);
}

// ============================================================
// Main
// ============================================================

async function main(): Promise<void> {
  if (DRY_RUN) {
    console.log('╔══════════════════════════════════════════╗');
    console.log('║         DRY RUN — no files written        ║');
    console.log('╚══════════════════════════════════════════╝\n');
  }

  const config = loadConfig();
  const wallet = new ethers.Wallet(config.privateKey);
  const walletAddress = wallet.address;
  const analyticsBase = resolve(process.cwd(), config.analytics.storage_path);

  console.log(`Wallet:         ${walletAddress}`);
  console.log(`Analytics path: ${analyticsBase}`);
  console.log(`Chains:         ${[...config.chains.keys()].join(', ')}\n`);

  for (const [chainId, chainCfg] of config.chains) {
    if (CHAIN_FILTER !== undefined && chainId !== CHAIN_FILTER) continue;

    console.log(`${'═'.repeat(64)}`);
    console.log(`Chain ${chainId} — ${chainCfg.chainName}`);
    console.log(`${'═'.repeat(64)}`);

    const storagePath = chainStoragePath(analyticsBase, chainId);
    const chainEntry = getChainConfig(chainId);
    const npmAddress = chainEntry.contracts.nonfungiblePositionManager;
    const chainSlug = chainEntry.dexScreenerSlug;

    // Connect to RPC — try each URL until one responds
    const network = new ethers.Network(chainCfg.chainName.toLowerCase().replace(/\s+/g, '-'), chainId);
    let provider: ethers.JsonRpcProvider | null = null;

    for (const rpcUrl of chainCfg.rpcUrls) {
      try {
        const p = new ethers.JsonRpcProvider(rpcUrl, network, { staticNetwork: network });
        await p.getBlockNumber();
        provider = p;
        console.log(`RPC: ${new URL(rpcUrl).hostname}`);
        break;
      } catch {
        console.warn(`  RPC unavailable: ${rpcUrl}`);
      }
    }

    if (!provider) {
      console.error(`ERROR: All RPCs failed for chain ${chainId}. Skipping.\n`);
      continue;
    }

    const npm = new ethers.Contract(npmAddress, NonfungiblePositionManagerABI, provider);
    const factory = new ethers.Contract(chainEntry.contracts.factory, UniswapV3FactoryABI, provider);

    // Cache: (token0:token1:fee) → poolAddress
    const poolAddressCache = new Map<string, string>();
    async function resolvePool(token0: string, token1: string, fee: number): Promise<string | null> {
      const key = `${token0.toLowerCase()}:${token1.toLowerCase()}:${fee}`;
      if (poolAddressCache.has(key)) return poolAddressCache.get(key)!;
      try {
        const addr: string = await factory.getPool(token0, token1, fee);
        if (addr && addr !== ethers.ZeroAddress) {
          poolAddressCache.set(key, addr);
          return addr;
        }
      } catch { /* factory call failed */ }
      return null;
    }

    // Test archive support: can this RPC serve historical slot0 queries?
    let archiveSupported = false;
    try {
      // Try reading a block from ~1000 blocks ago
      const testBlock = Math.max(1, (await provider.getBlockNumber()) - 1000);
      await provider.getBalance(ethers.ZeroAddress, testBlock);
      archiveSupported = true;
      console.log(`  Archive state: supported ✓ (on-chain prices available)`);
    } catch {
      console.log(`  Archive state: NOT supported ✗ (falling back to DexScreener estimates)`);
    }

    // ----------------------------------------------------------
    // Load existing records for deduplication
    // ----------------------------------------------------------

    const existingEntries = await queryPositionEntries(storagePath);
    const existingEntryKeys = new Set(existingEntries.map((e) => `${e.tokenId}:${e.txHash}`));

    const existingFees = await queryFeeCollections(storagePath);
    const existingFeeKeys = new Set(existingFees.map((f) => `${f.tokenId}:${f.txHash}`));

    // Collect all tx hashes captured in existing rebalance records so we can
    // skip Collect events that were already counted as part of a rebalance.
    const existingRebalances = await queryRebalances(storagePath);
    const rebalanceTxHashes = new Set<string>(
      existingRebalances.flatMap((r) =>
        [
          r.txHashes.collectFees,
          r.txHashes.collectTokens,
          r.txHashes.burn,
          r.txHashes.mint,
          r.txHashes.swap ?? '',
        ].filter(Boolean),
      ),
    );

    console.log(
      `Existing: ${existingEntries.length} entries, ${existingFees.length} fee records, ${existingRebalances.length} rebalances`,
    );

    // ----------------------------------------------------------
    // Discover all positions ever minted to this wallet
    // ----------------------------------------------------------

    const latestBlock = await provider.getBlockNumber();
    console.log(`Scanning ${latestBlock.toLocaleString()} blocks for mint events...`);

    const mintFilter = npm.filters.Transfer(ZERO_ADDRESS, walletAddress);
    const mintEvents = await queryFilterChunked(npm, mintFilter, 0, latestBlock);

    // Deduplicate tokenIds (a tokenId should only be minted once, but be safe)
    const tokenIdToMint = new Map<number, ethers.EventLog>();
    for (const ev of mintEvents) {
      const id = Number(ev.args[2]);
      if (!tokenIdToMint.has(id)) tokenIdToMint.set(id, ev);
    }

    const allTokenIds = [...tokenIdToMint.keys()].sort((a, b) => a - b);
    console.log(`Found ${allTokenIds.length} position(s): [${allTokenIds.join(', ')}]\n`);

    if (allTokenIds.length === 0) {
      console.log('No positions found on this chain. Skipping.\n');
      continue;
    }

    // ----------------------------------------------------------
    // Resolve token metadata and current prices
    // ----------------------------------------------------------

    // First pass: collect token addresses by calling positions() for each tokenId
    const positionMeta = new Map<
      number,
      {
        token0: string;
        token1: string;
        fee: number;
        tickLower: number;
        tickUpper: number;
        mintBlock: number;
        mintTxHash: string;
      }
    >();

    const tokenAddresses = new Set<string>();

    for (const tokenId of allTokenIds) {
      const mintEv = tokenIdToMint.get(tokenId)!;
      const mintBlock = mintEv.blockNumber;
      const mintTxHash = mintEv.transactionHash;

      try {
        const pos = await npm.positions(tokenId);
        const token0 = String(pos[2]);
        const token1 = String(pos[3]);
        tokenAddresses.add(token0.toLowerCase());
        tokenAddresses.add(token1.toLowerCase());
        positionMeta.set(tokenId, {
          token0,
          token1,
          fee: Number(pos[4]),
          tickLower: Number(pos[5]),
          tickUpper: Number(pos[6]),
          mintBlock,
          mintTxHash,
        });
      } catch {
        // Position burned — positions() reverts. We can still backfill events
        // using data from receipts + Transfer/Collect logs only.
        console.warn(`  #${tokenId}: positions() reverted (likely burned) — will use event data only`);
        positionMeta.set(tokenId, {
          token0: '',
          token1: '',
          fee: 0,
          tickLower: 0,
          tickUpper: 0,
          mintBlock,
          mintTxHash,
        });
      }
    }

    // Fetch current USD prices for all discovered tokens
    console.log('Fetching current token prices from DexScreener...');
    const prices = await fetchDexScreenerPrices([...tokenAddresses], chainSlug);
    const wrappedNative = chainEntry.wrappedNativeAddress.toLowerCase();
    const nativePriceUsd = prices.get(wrappedNative) ?? 0;
    console.log(
      `  Prices fetched for ${prices.size} tokens. Native: $${nativePriceUsd.toFixed(6)}\n`,
    );

    // ----------------------------------------------------------
    // Process each position
    // ----------------------------------------------------------

    let totalEntriesWritten = 0;
    let totalEntriesSkipped = 0;
    let totalFeesWritten = 0;
    let totalFeesSkipped = 0;

    for (const tokenId of allTokenIds) {
      const meta = positionMeta.get(tokenId)!;
      console.log(`  ── Position #${tokenId} (mint block ${meta.mintBlock.toLocaleString()}) ──`);

      // Resolve token metadata
      let token0Symbol = 'TOKEN0';
      let token0Decimals = 18;
      let token1Symbol = 'TOKEN1';
      let token1Decimals = 18;

      if (meta.token0) {
        const t = await getTokenMeta(meta.token0, provider);
        token0Symbol = t.symbol;
        token0Decimals = t.decimals;
      }
      if (meta.token1) {
        const t = await getTokenMeta(meta.token1, provider);
        token1Symbol = t.symbol;
        token1Decimals = t.decimals;
      }

      const fallbackPriceUsd0 = meta.token0 ? (prices.get(meta.token0.toLowerCase()) ?? 0) : 0;
      const fallbackPriceUsd1 = meta.token1 ? (prices.get(meta.token1.toLowerCase()) ?? 0) : 0;

      // Resolve pool address for on-chain price queries
      let poolAddress: string | null = null;
      if (meta.token0 && meta.token1 && meta.fee > 0 && archiveSupported) {
        poolAddress = await resolvePool(meta.token0, meta.token1, meta.fee);
        if (poolAddress) {
          console.log(`    Pool: ${poolAddress.slice(0, 10)}... (on-chain price queries enabled)`);
        }
      }

      // Query on-chain events for this position
      const increaseFilter = npm.filters.IncreaseLiquidity(tokenId);
      const collectFilter = npm.filters.Collect(tokenId);

      const [increaseEvents, collectEvents] = await Promise.all([
        queryFilterChunked(npm, increaseFilter, meta.mintBlock, latestBlock),
        queryFilterChunked(npm, collectFilter, meta.mintBlock, latestBlock),
      ]);

      console.log(
        `    IncreaseLiquidity: ${increaseEvents.length}  |  Collect: ${collectEvents.length}`,
      );

      // ── PositionEntryRecords from IncreaseLiquidity ────────

      for (const ev of increaseEvents) {
        const txHash = ev.transactionHash;
        const key = `${tokenId}:${txHash}`;

        if (existingEntryKeys.has(key)) {
          totalEntriesSkipped++;
          continue;
        }

        let timestamp = Date.now();
        try {
          const block = await ev.getBlock();
          timestamp = block.timestamp * 1000;
        } catch { /* use current time */ }

        const amount0 = BigInt(ev.args[2].toString());
        const amount1 = BigInt(ev.args[3].toString());

        // Try on-chain price at event block (most accurate historical price)
        let onChainPrice: Awaited<ReturnType<typeof getPoolPriceAtBlock>> = null;
        if (poolAddress) {
          onChainPrice = await getPoolPriceAtBlock(poolAddress, ev.blockNumber, provider);
        }

        const historicalUsd = meta.token0 && meta.token1
          ? await resolveHistoricalUsdPrices({
              chainId,
              blockNumber: ev.blockNumber,
              token0Address: meta.token0,
              token1Address: meta.token1,
              nativeWrappedAddress: chainEntry.wrappedNativeAddress,
              context: `backfill-entry:${chainId}:${tokenId}:${txHash}`,
            })
          : null;

        const priceUsd0 = historicalUsd?.priceUsd0 ?? fallbackPriceUsd0;
        const priceUsd1 = historicalUsd?.priceUsd1 ?? fallbackPriceUsd1;
        const nativePriceUsd = historicalUsd?.nativePriceUsd ?? (prices.get(wrappedNative) ?? 0);
        const usedEstimatedUsd = !historicalUsd && (priceUsd0 > 0 || priceUsd1 > 0 || nativePriceUsd > 0);

        let gasCostUsd = 0;
        try {
          const receipt = await ev.getTransactionReceipt();
          if (receipt) {
            const gasCostNative = Number(receipt.gasUsed * (receipt.gasPrice ?? 0n)) / 1e18;
            gasCostUsd = gasCostNative * nativePriceUsd;
          }
        } catch { /* no gas data */ }

        const entryCostUsd =
          (Number(amount0) / 10 ** token0Decimals) * priceUsd0 +
          (Number(amount1) / 10 ** token1Decimals) * priceUsd1;

        const isInitialMint = txHash === meta.mintTxHash;
        const priceSourceLabel = classifyBackfillPriceSource(
          Boolean(onChainPrice),
          historicalUsd?.priceSource ?? null,
          usedEstimatedUsd,
        );

        const record: PositionEntryRecord & { sqrtPriceX96?: string; poolTick?: number; onChainPrice?: number } = {
          timestamp,
          tokenId,
          blockNumber: ev.blockNumber,
          txHash,
          amount0,
          amount1,
          priceUsd0,
          priceUsd1,
          nativePriceUsd,
          entryCostUsd,
          gasCostUsd,
          source: isInitialMint ? 'manual' : 'rebalance',
          token0Symbol,
          token1Symbol,
          token0Decimals,
          token1Decimals,
          tickLower: meta.tickLower,
          tickUpper: meta.tickUpper,
          chainId,
          priceSource: priceSourceLabel,
          priceStatus: historicalUsd ? 'backfilled' : (usedEstimatedUsd ? 'backfilled' : 'permanently_missing'),
          // On-chain price data (when available) — stored as strings for JSON serialization
          ...(onChainPrice ? {
            sqrtPriceX96: onChainPrice.sqrtPriceX96.toString(),
            poolTick: onChainPrice.tick,
            onChainPrice: sqrtPriceToHumanPrice(onChainPrice.sqrtPriceX96, token0Decimals, token1Decimals),
          } : {}),
        };

        if (!DRY_RUN) {
          await ensureStorageDir(storagePath);
          await writeAnalyticsRecord(
            { type: 'position_entry', timestamp, data: record },
            storagePath,
          );
          existingEntryKeys.add(key);
        }

        const priceNote = historicalUsd
          ? `${historicalUsd.priceSource}, token0=$${priceUsd0.toFixed(6)}, token1=$${priceUsd1.toFixed(6)}`
          : onChainPrice
            ? `on-chain tick=${onChainPrice.tick}, usd=estimated`
            : usedEstimatedUsd
              ? 'estimated'
              : 'unavailable';
        console.log(
          `    [${DRY_RUN ? 'DRY' : 'WROTE'}] Entry #${tokenId}` +
          ` ${new Date(timestamp).toISOString().split('T')[0]}` +
          `  ${formatAmount(amount0, token0Decimals)} ${token0Symbol}` +
          ` + ${formatAmount(amount1, token1Decimals)} ${token1Symbol}` +
          `  ≈ $${entryCostUsd.toFixed(2)} (${priceNote})`,
        );
        totalEntriesWritten++;
      }

      // ── FeeCollectionRecords from Collect ─────────────────

      for (const ev of collectEvents) {
        const txHash = ev.transactionHash;

        // Skip if already captured inside a rebalance record
        if (rebalanceTxHashes.has(txHash)) {
          totalFeesSkipped++;
          continue;
        }

        const key = `${tokenId}:${txHash}`;
        if (existingFeeKeys.has(key)) {
          totalFeesSkipped++;
          continue;
        }

        const amount0 = BigInt(ev.args[2].toString());
        const amount1 = BigInt(ev.args[3].toString());

        // Skip zero-amount internal accounting collects
        if (amount0 === 0n && amount1 === 0n) continue;

        let timestamp = Date.now();
        try {
          const block = await ev.getBlock();
          timestamp = block.timestamp * 1000;
        } catch { /* use current time */ }

        let gasUsed = 0n;
        let gasPrice = 0n;
        let gasCostPLS = 0;
        try {
          const receipt = await ev.getTransactionReceipt();
          if (receipt) {
            gasUsed = receipt.gasUsed;
            gasPrice = receipt.gasPrice ?? 0n;
            gasCostPLS = Number(gasUsed * gasPrice) / 1e18;
          }
        } catch { /* no gas data */ }

        // Try on-chain price at event block
        let onChainPriceFee: Awaited<ReturnType<typeof getPoolPriceAtBlock>> = null;
        if (poolAddress) {
          onChainPriceFee = await getPoolPriceAtBlock(poolAddress, ev.blockNumber, provider);
        }

        const historicalUsd = meta.token0 && meta.token1
          ? await resolveHistoricalUsdPrices({
              chainId,
              blockNumber: ev.blockNumber,
              token0Address: meta.token0,
              token1Address: meta.token1,
              nativeWrappedAddress: chainEntry.wrappedNativeAddress,
              context: `backfill-fee:${chainId}:${tokenId}:${txHash}`,
            })
          : null;

        const priceUsd0 = historicalUsd?.priceUsd0 ?? fallbackPriceUsd0;
        const priceUsd1 = historicalUsd?.priceUsd1 ?? fallbackPriceUsd1;
        const usedEstimatedUsd = !historicalUsd && (priceUsd0 > 0 || priceUsd1 > 0);
        const valueUsd0 = (Number(amount0) / 10 ** token0Decimals) * priceUsd0;
        const valueUsd1 = (Number(amount1) / 10 ** token1Decimals) * priceUsd1;

        const feeRecord: FeeCollectionRecord & { sqrtPriceX96?: string; poolTick?: number; onChainPrice?: number; priceSource?: string; priceStatus?: 'live' | 'backfilled' | 'pending' | 'permanently_missing' } = {
          timestamp,
          tokenId,
          chainId,
          blockNumber: ev.blockNumber,
          txHash,
          amount0,
          amount1,
          gasUsed,
          gasPrice,
          gasCostPLS,
          priceUsd0,
          priceUsd1,
          valueUsd0,
          valueUsd1,
          totalValueUsd: valueUsd0 + valueUsd1,
          token0Symbol,
          token1Symbol,
          token0Decimals,
          token1Decimals,
          priceSource: classifyBackfillPriceSource(
            Boolean(onChainPriceFee),
            historicalUsd?.priceSource ?? null,
            usedEstimatedUsd,
          ),
          priceStatus: historicalUsd ? 'backfilled' : (usedEstimatedUsd ? 'backfilled' : 'permanently_missing'),
          ...(onChainPriceFee ? {
            sqrtPriceX96: onChainPriceFee.sqrtPriceX96.toString(),
            poolTick: onChainPriceFee.tick,
            onChainPrice: sqrtPriceToHumanPrice(onChainPriceFee.sqrtPriceX96, token0Decimals, token1Decimals),
          } : {}),
        };

        if (!DRY_RUN) {
          await ensureStorageDir(storagePath);
          await writeAnalyticsRecord(
            { type: 'fee_collection', timestamp, data: feeRecord },
            storagePath,
          );
          existingFeeKeys.add(key);
        }

        const priceNoteFee = historicalUsd
          ? historicalUsd.priceSource
          : onChainPriceFee
            ? 'on-chain+estimated'
            : usedEstimatedUsd
              ? 'estimated'
              : 'unavailable';
        console.log(
          `    [${DRY_RUN ? 'DRY' : 'WROTE'}] Fee   #${tokenId}` +
          ` ${new Date(timestamp).toISOString().split('T')[0]}` +
          `  ${formatAmount(amount0, token0Decimals)} ${token0Symbol}` +
          ` + ${formatAmount(amount1, token1Decimals)} ${token1Symbol}` +
          `  ≈ $${(valueUsd0 + valueUsd1).toFixed(2)} (${priceNoteFee})`,
        );
        totalFeesWritten++;
      }
    }

    // ----------------------------------------------------------
    // Chain summary
    // ----------------------------------------------------------

    console.log(`\n  ${'─'.repeat(56)}`);
    console.log(`  Chain ${chainId} complete:`);
    console.log(`    Positions scanned:      ${allTokenIds.length}`);
    console.log(`    Entry records written:  ${totalEntriesWritten}  (skipped: ${totalEntriesSkipped})`);
    console.log(`    Fee records written:    ${totalFeesWritten}  (skipped: ${totalFeesSkipped})`);
    if (DRY_RUN) console.log(`    (DRY RUN — nothing written to disk)`);
    if (archiveSupported) {
      console.log(`\n  ✓  On-chain prices (sqrtPriceX96) captured from pool at event blocks.`);
      console.log(`     USD values prefer historical subgraph pricing and only fall back to current estimates when needed.`);
    } else {
      console.log(`\n  ⚠  Archive pool state is unavailable on this RPC.`);
      console.log(`     USD values still prefer historical subgraph pricing and only fall back to today's token prices when indexed history is unavailable.`);
    }
    console.log();
  }

  console.log('Backfill complete.');
}

main().catch((err) => {
  console.error('Fatal error:', err instanceof Error ? err.message : String(err));
  process.exit(1);
});

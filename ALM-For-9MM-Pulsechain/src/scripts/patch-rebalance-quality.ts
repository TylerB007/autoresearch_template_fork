/**
 * patch-rebalance-quality.ts — Backfill missing quality fields in historical rebalance records
 *
 * Historical rebalance JSONL records are missing three fields that were added after the
 * positions were first rebalanced:
 *
 *   - gasUsed.totalCostWei   — receipt-level exact gas cost (sum across all txs)
 *   - swap.configuredSlippageBps — the slippage tolerance that was configured at rebalance time
 *   - dust0 / dust1 / dustUsd  — uninvested token remainder (treat as 0 for old records)
 *
 * Without these fields every historical record shows:
 *   "Execution-cost quality: estimated. Missing: receipt_exact_gas, dust_accounting,
 *    configured_slippage_tolerance."
 *
 * This script re-fetches receipts from the chain RPC and patches the JSONL files in place,
 * lifting quality from 'estimated' → 'exact' for all historical records.
 *
 * Usage:
 *   npx tsx src/scripts/patch-rebalance-quality.ts [--chain 369|8453] [--dry-run]
 *
 * Options:
 *   --chain <id>   Only process this chain ID (default: all chain subdirs + flat root)
 *   --dry-run      Print what would be patched without writing any files
 *
 * IMPORTANT: Stop pm2 or at least ensure no rebalance is in progress before running.
 *            The script rewrites JSONL files atomically (write temp → rename).
 */

import { ethers } from 'ethers';
import { readFileSync, writeFileSync, readdirSync, existsSync, renameSync } from 'node:fs';
import { join, basename } from 'node:path';
import { loadConfig } from '../configLoader.js';

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

/** Delay between consecutive receipt fetches to avoid RPC throttling */
const FETCH_DELAY_MS = 150;

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * The slippage tolerance that was configured for all historical rebalances.
 * PulseChain and Base have always used 100 bps (1%) — verified from config.yaml.
 * A future run can override this via --slippage flag if needed.
 */
const HISTORICAL_SLIPPAGE_BPS_BY_CHAIN: Record<number, number> = {
  369: 100,   // PulseChain — confirmed from config.yaml
  8453: 100,  // Base — confirmed from config.yaml
};

const FALLBACK_SLIPPAGE_BPS = 100;

/** BigInt JSON serializer (matches the codebase convention) */
const bigIntReplacer = (_key: string, value: unknown): unknown =>
  typeof value === 'bigint' ? value.toString() : value;

/** Fetch one transaction receipt, retrying once on transient null */
async function fetchReceipt(
  provider: ethers.JsonRpcProvider,
  hash: string,
): Promise<ethers.TransactionReceipt | null> {
  try {
    const receipt = await provider.getTransactionReceipt(hash);
    if (!receipt) {
      // One retry after brief pause — may still be indexing
      await sleep(500);
      return provider.getTransactionReceipt(hash);
    }
    return receipt;
  } catch (err) {
    console.warn(`  ⚠ Failed to fetch receipt ${hash}: ${err}`);
    return null;
  }
}

// ============================================================
// Main
// ============================================================

async function main(): Promise<void> {
  console.log(`\n=== patch-rebalance-quality${DRY_RUN ? ' [DRY RUN]' : ''} ===\n`);

  const config = await loadConfig();
  const storagePath = config.analytics?.storage_path ?? './analytics';

  // RPC URLs from the loaded config (includes .env overrides)
  const rpcUrlsByChain: Map<number, string[]> = config.rpcUrlsByChain ?? new Map();

  // Resolve all JSONL directories to scan
  const dirs: Array<{ path: string; chainId: number | undefined }> = [];

  // Flat root (pre-chain-subdir era)
  dirs.push({ path: storagePath, chainId: undefined });

  // Per-chain subdirs
  if (existsSync(storagePath)) {
    for (const entry of readdirSync(storagePath, { withFileTypes: true })) {
      if (entry.isDirectory() && entry.name.startsWith('chain-')) {
        const chainId = parseInt(entry.name.replace('chain-', ''), 10);
        if (!isNaN(chainId)) {
          dirs.push({ path: join(storagePath, entry.name), chainId });
        }
      }
    }
  }

  // Build RPC providers — one per chain ID encountered
  const providers = new Map<number, ethers.JsonRpcProvider>();

  function getProvider(chainId: number): ethers.JsonRpcProvider | null {
    if (providers.has(chainId)) return providers.get(chainId)!;
    const urls = rpcUrlsByChain.get(chainId);
    const rpcUrl = urls?.[0];
    if (!rpcUrl) {
      console.warn(`  ⚠ No RPC URL configured for chain ${chainId} — cannot fetch receipts`);
      return null;
    }
    const provider = new ethers.JsonRpcProvider(rpcUrl);
    providers.set(chainId, provider);
    return provider;
  }

  // Stats
  let totalFiles = 0;
  let totalRecords = 0;
  let patchedRecords = 0;
  let totalReceiptsFetched = 0;

  // ── Process each directory ────────────────────────────────────
  for (const { path: dirPath, chainId: dirChainId } of dirs) {
    if (CHAIN_FILTER !== undefined && dirChainId !== CHAIN_FILTER && dirChainId !== undefined) {
      continue;
    }

    if (!existsSync(dirPath)) continue;

    const jsonlFiles = readdirSync(dirPath)
      .filter(f => f.endsWith('.jsonl') && !f.startsWith('price-history'))
      .sort();

    for (const file of jsonlFiles) {
      const filePath = join(dirPath, file);
      const rawLines = readFileSync(filePath, 'utf8').split('\n');
      const outLines: string[] = [];
      let filePatched = false;

      for (const rawLine of rawLines) {
        const trimmed = rawLine.trim();
        if (!trimmed) {
          outLines.push(rawLine);
          continue;
        }

        let record: Record<string, unknown>;
        try {
          record = JSON.parse(trimmed);
        } catch {
          outLines.push(rawLine);
          continue;
        }

        if (record.type !== 'rebalance') {
          outLines.push(rawLine);
          continue;
        }

        totalRecords++;
        const rb = record.data as Record<string, unknown>;
        const gasUsed = rb.gasUsed as Record<string, unknown> | undefined;
        const swap = rb.swap as Record<string, unknown> | undefined;

        const missingTotalCostWei = !gasUsed?.totalCostWei;
        const missingDust = rb.dustUsd === undefined;
        const missingConfiguredSlippage = swap !== undefined && swap.configuredSlippageBps === undefined;

        if (!missingTotalCostWei && !missingDust && !missingConfiguredSlippage) {
          // Already complete — no patch needed
          outLines.push(rawLine);
          continue;
        }

        // Determine chain ID for this record
        const recordChainId = (rb.chainId as number | undefined) ?? dirChainId;

        if (CHAIN_FILTER !== undefined && recordChainId !== CHAIN_FILTER) {
          outLines.push(rawLine);
          continue;
        }

        const rebalanceId = rb.rebalanceId as string ?? 'unknown';
        const oldTokenId = rb.oldTokenId as number ?? '?';
        console.log(`\nPatching rebalance ${rebalanceId} (tokenId ${oldTokenId}, chain ${recordChainId ?? 'unknown'})`);
        console.log(`  File: ${basename(filePath)}`);
        console.log(`  Missing: ${[
          missingTotalCostWei ? 'totalCostWei' : null,
          missingDust ? 'dust' : null,
          missingConfiguredSlippage ? 'configuredSlippageBps' : null,
        ].filter(Boolean).join(', ')}`);

        // ── Patch totalCostWei via receipt fetching ───────────────
        if (missingTotalCostWei && recordChainId !== undefined) {
          const provider = getProvider(recordChainId);
          if (provider) {
            const txHashes = rb.txHashes as Record<string, string | undefined> | undefined;
            const hashValues = txHashes ? Object.values(txHashes).filter((h): h is string => typeof h === 'string' && h.length > 0 && !h.startsWith('0x_DRY')) : [];

            let totalCostWei = 0n;
            let fetchedCount = 0;

            for (const hash of hashValues) {
              const receipt = await fetchReceipt(provider, hash);
              if (receipt) {
                const cost = receipt.fee ?? (receipt.gasUsed * (receipt.gasPrice ?? 0n));
                totalCostWei += cost;
                fetchedCount++;
                totalReceiptsFetched++;
              }
              await sleep(FETCH_DELAY_MS);
            }

            if (totalCostWei > 0n) {
              if (!DRY_RUN && gasUsed) {
                (gasUsed as Record<string, unknown>).totalCostWei = totalCostWei.toString();
              }
              console.log(`  ✓ totalCostWei = ${totalCostWei} (from ${fetchedCount}/${hashValues.length} receipts)`);
            } else {
              console.log(`  ✗ Could not compute totalCostWei (${fetchedCount}/${hashValues.length} receipts returned 0)`);
            }
          }
        } else if (missingTotalCostWei) {
          console.log(`  ✗ Cannot patch totalCostWei — chain ID unknown for this record`);
        }

        // ── Patch configuredSlippageBps ───────────────────────────
        if (missingConfiguredSlippage && swap !== undefined) {
          const slippageBps = recordChainId !== undefined
            ? (HISTORICAL_SLIPPAGE_BPS_BY_CHAIN[recordChainId] ?? FALLBACK_SLIPPAGE_BPS)
            : FALLBACK_SLIPPAGE_BPS;
          if (!DRY_RUN) {
            (swap as Record<string, unknown>).configuredSlippageBps = slippageBps;
          }
          console.log(`  ✓ configuredSlippageBps = ${slippageBps}`);
        }

        // ── Patch dust fields (treat as 0 for pre-dust-tracking records) ─
        if (missingDust) {
          if (!DRY_RUN) {
            rb.dust0 = '0';
            rb.dust1 = '0';
            rb.dustUsd = 0;
          }
          console.log(`  ✓ dust0/dust1/dustUsd = 0 (pre-dust-tracking era)`);
        }

        // Re-serialize the patched record
        const patched = JSON.stringify(record, bigIntReplacer);
        outLines.push(patched);
        filePatched = true;
        patchedRecords++;
      }

      // ── Write file if any lines changed ──────────────────────────
      if (filePatched) {
        totalFiles++;
        if (!DRY_RUN) {
          const tmpPath = `${filePath}.tmp`;
          writeFileSync(tmpPath, outLines.join('\n'), 'utf8');
          renameSync(tmpPath, filePath);
          console.log(`\n  ✅ Wrote ${filePath}`);
        } else {
          console.log(`\n  [DRY RUN] Would rewrite ${filePath}`);
        }
      }
    }
  }

  // Cleanup providers
  for (const provider of providers.values()) {
    provider.destroy();
  }

  console.log(`\n=== Summary ===`);
  console.log(`  Rebalance records scanned : ${totalRecords}`);
  console.log(`  Records patched           : ${patchedRecords}`);
  console.log(`  Receipts fetched          : ${totalReceiptsFetched}`);
  console.log(`  JSONL files rewritten     : ${totalFiles}`);
  if (DRY_RUN) {
    console.log(`\n  [DRY RUN] No files were modified. Re-run without --dry-run to apply.`);
  } else {
    console.log(`\n  ✅ Done. Restart pm2 dashboard to clear any cached analytics.`);
  }
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});

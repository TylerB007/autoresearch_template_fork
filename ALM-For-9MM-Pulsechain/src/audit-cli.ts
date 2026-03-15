/**
 * Koinly Audit CLI
 *
 * Cross-references a Koinly CSV export against internal analytics records
 * to surface discrepancies in USD values, token amounts, swap directions,
 * and gas costs.
 *
 * Usage:
 *   npm run audit:koinly -- --csv path/to/koinly-export.csv
 *   npm run audit:koinly -- --csv path/to/koinly-export.csv --days=90
 *   npm run audit:koinly -- --csv path/to/koinly-export.csv --json
 *   npm run audit:koinly -- --csv path/to/koinly-export.csv --pulsechain-only
 */

import { loadConfig } from './configLoader.js';
import {
  queryAllChainRebalances,
  queryAllChainFeeCollections,
  queryAllChainLifecycleEvents,
  queryAllChainPositionEntries,
} from './analytics/storage.js';
import { parseKoinlyCsv } from './audit/koinly.js';
import { buildInternalEventIndex, matchEvents } from './audit/matcher.js';
import { printReport } from './audit/report.js';
import {
  filterChainRecords,
  filterKoinlyRowsByWalletSubstring,
  filterKoinlyRowsForPulsechain,
  resolveAuditScope,
} from './audit/scope.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parseArg(args: string[], name: string): string | undefined {
  const prefix = `--${name}=`;
  const flag = args.find((a) => a.startsWith(prefix));
  if (flag) return flag.slice(prefix.length);
  // Also support --name value (space-separated)
  const idx = args.indexOf(`--${name}`);
  if (idx >= 0 && args[idx + 1] && !args[idx + 1].startsWith('--')) {
    return args[idx + 1];
  }
  return undefined;
}

function hasFlag(args: string[], name: string): boolean {
  return args.includes(`--${name}`);
}

// ---------------------------------------------------------------------------
// Main command
// ---------------------------------------------------------------------------

async function commandAuditKoinly(args: string[]): Promise<void> {
  const csvPath = parseArg(args, 'csv');
  const daysStr = parseArg(args, 'days');
  const jsonOutput = hasFlag(args, 'json');
  const pulsechainOnly = hasFlag(args, 'pulsechain-only');
  const walletSubstring = parseArg(args, 'wallet');
  const chainIdStr = parseArg(args, 'chain-id');

  if (!csvPath) {
    console.error('Error: --csv <path> is required.');
    console.error('  Usage: npm run audit:koinly -- --csv path/to/koinly-export.csv');
    process.exit(1);
  }

  const days = daysStr ? parseInt(daysStr, 10) : 90;
  if (isNaN(days) || days <= 0) {
    console.error(`Error: --days must be a positive integer (got "${daysStr}")`);
    process.exit(1);
  }

  const chainId = chainIdStr ? parseInt(chainIdStr, 10) : undefined;
  if (chainIdStr && (chainId === undefined || isNaN(chainId) || chainId <= 0)) {
    console.error(`Error: --chain-id must be a positive integer (got "${chainIdStr}")`);
    process.exit(1);
  }

  const scope = resolveAuditScope({ pulsechainOnly, chainId, walletSubstring });

  // 1. Parse Koinly CSV
  let koinlyRows;
  try {
    koinlyRows = parseKoinlyCsv(csvPath);
  } catch (err) {
    console.error(`Error parsing CSV: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  }

  if (koinlyRows.length === 0) {
    console.error('No rows found in CSV. Is the file empty or incorrectly formatted?');
    process.exit(1);
  }

  if (scope.effectiveWalletSubstring) {
    koinlyRows = filterKoinlyRowsByWalletSubstring(koinlyRows, scope.effectiveWalletSubstring);
  } else if (pulsechainOnly) {
    koinlyRows = filterKoinlyRowsForPulsechain(koinlyRows);
  }

  if ((scope.effectiveWalletSubstring || pulsechainOnly) && koinlyRows.length === 0) {
    const reason = scope.effectiveWalletSubstring
      ? `wallet filter "${scope.effectiveWalletSubstring}"`
      : 'PulseChain wallet label detection';
    console.error(`No Koinly rows matched the requested scope (${reason}).`);
    process.exit(1);
  }

  // 2. Load internal analytics data
  const config = loadConfig();
  const storagePath = config.analytics.storage_path;

  const now = Date.now();
  const startTime = now - days * 86_400_000;

  // Determine date range from Koinly data for focused query
  const koinlyMinMs = Math.min(...koinlyRows.map((r) => r.dateMs).filter((d) => d > 0));
  const koinlyMaxMs = Math.max(...koinlyRows.map((r) => r.dateMs).filter((d) => d > 0));
  // Use whichever window is wider: --days limit or CSV date range (±1h buffer)
  const queryStart = Math.min(startTime, koinlyMinMs - 3_600_000);
  const queryEnd = Math.max(now, koinlyMaxMs + 3_600_000);

  let [rebalances, feeCollections, lifecycleEvents, positionEntries] = await Promise.all([
    queryAllChainRebalances(storagePath, queryStart, queryEnd),
    queryAllChainFeeCollections(storagePath, undefined, queryStart, queryEnd),
    queryAllChainLifecycleEvents(storagePath, undefined, undefined, queryStart, queryEnd),
    queryAllChainPositionEntries(storagePath),
  ]);

  if (scope.effectiveChainId !== undefined) {
    rebalances = filterChainRecords(rebalances, scope.effectiveChainId);
    feeCollections = filterChainRecords(feeCollections, scope.effectiveChainId);
    lifecycleEvents = filterChainRecords(lifecycleEvents, scope.effectiveChainId);
    positionEntries = filterChainRecords(positionEntries, scope.effectiveChainId);
  }

  // 3. Build internal event index
  const internalEvents = buildInternalEventIndex(rebalances, feeCollections, positionEntries, lifecycleEvents);

  // 4. Match
  const result = matchEvents(koinlyRows, internalEvents);

  // 5. Print report
  printReport(result, {
    csvPath,
    storagePath,
    internalEventCount: internalEvents.length,
    koinlyRowCount: koinlyRows.length,
    dateRangeMs: koinlyMinMs && koinlyMaxMs ? [koinlyMinMs, koinlyMaxMs] : null,
    scopeLabel: scope.scopeLabel,
    sourceCounts: {
      rebalances: rebalances.length,
      feeCollections: feeCollections.length,
      lifecycleEvents: lifecycleEvents.length,
      positionEntries: positionEntries.length,
    },
    jsonOutput,
  });
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const command = args[0];

  if (!command || command === '--help' || command === '-h') {
    console.log('Usage:');
    console.log('  npm run audit:koinly -- --csv <path> [--days=90] [--json] [--pulsechain-only] [--wallet=<name>] [--chain-id=<id>]');
    console.log();
    console.log('Options:');
    console.log('  --csv <path>   Path to Koinly CSV export file (required)');
    console.log('  --days=<N>     Number of days of internal history to load (default: 90)');
    console.log('  --json         Output raw JSON instead of formatted report');
    console.log('  --pulsechain-only  Restrict both Koinly rows and internal analytics to PulseChain');
    console.log('  --wallet=<text>   Restrict Koinly rows to wallet labels containing the given text');
    console.log('  --chain-id=<id>   Restrict internal analytics to a specific chain ID');
    return;
  }

  // Support both: `npm run audit:koinly -- --csv file.csv`
  // and:          `tsx src/audit-cli.ts --csv file.csv`
  await commandAuditKoinly(args);
}

main().catch((err) => {
  console.error('Fatal error:', err instanceof Error ? err.message : err);
  process.exit(1);
});

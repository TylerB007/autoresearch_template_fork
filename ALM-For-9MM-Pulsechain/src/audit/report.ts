/**
 * Discrepancy reporter — formats the audit match result as a terminal report.
 * Uses ANSI color codes (green = OK, yellow = warning, red = error/mismatch).
 */

import type { MatchResult, MatchPair, Discrepancy, InternalEvent } from './matcher.js';
import type { KoinlyRow } from './koinly.js';

// ---------------------------------------------------------------------------
// ANSI color helpers
// ---------------------------------------------------------------------------

const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const RED = '\x1b[31m';
const CYAN = '\x1b[36m';
const DIM = '\x1b[2m';

function green(s: string): string { return `${GREEN}${s}${RESET}`; }
function yellow(s: string): string { return `${YELLOW}${s}${RESET}`; }
function red(s: string): string { return `${RED}${s}${RESET}`; }
function bold(s: string): string { return `${BOLD}${s}${RESET}`; }
function cyan(s: string): string { return `${CYAN}${s}${RESET}`; }
function dim(s: string): string { return `${DIM}${s}${RESET}`; }

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

const DIVIDER = '='.repeat(72);
const THIN = '-'.repeat(72);

function formatDate(ms: number): string {
  if (!ms) return 'unknown';
  return new Date(ms).toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
}

function formatUsd(n: number | null): string {
  if (n === null) return 'N/A';
  return `$${n.toFixed(4)}`;
}

function formatAmount(amount: number | null, symbol: string | null): string {
  if (amount === null) return 'N/A';
  const sym = symbol ?? '';
  if (Math.abs(amount) >= 1_000_000) return `${(amount / 1_000_000).toFixed(3)}m ${sym}`.trim();
  if (Math.abs(amount) >= 1_000) return `${(amount / 1_000).toFixed(3)}k ${sym}`.trim();
  return `${amount.toFixed(6)} ${sym}`.trim();
}

function formatKoinlyAsset(row: KoinlyRow): string {
  if (!row.asset) return row.type;
  const a = row.asset;
  const sign = a.amount < 0 ? '' : '+';
  return `${sign}${a.amount >= 1_000_000 ? (a.amount / 1_000_000).toFixed(3) + 'm' : a.amount.toFixed(6)} ${a.symbol}`;
}

function formatKoinlyReceived(row: KoinlyRow): string {
  if (!row.received) return '';
  const r = row.received;
  const sign = r.amount > 0 ? '+' : '';
  return `${sign}${r.amount >= 1_000_000 ? (r.amount / 1_000_000).toFixed(3) + 'm' : r.amount.toFixed(6)} ${r.symbol}`;
}

function formatTxHash(hash: string | null, maxLen = 20): string {
  if (!hash) return 'N/A';
  if (hash.length <= maxLen + 4) return hash;
  return hash.slice(0, maxLen) + '…' + hash.slice(-4);
}

// ---------------------------------------------------------------------------
// Severity helpers
// ---------------------------------------------------------------------------

function worstSeverity(discrepancies: Discrepancy[]): 'ok' | 'warning' | 'error' {
  if (discrepancies.some((d) => d.severity === 'error')) return 'error';
  if (discrepancies.some((d) => d.severity === 'warning')) return 'warning';
  return 'ok';
}

function severityLabel(s: 'ok' | 'warning' | 'error'): string {
  if (s === 'error') return red('MISMATCH');
  if (s === 'warning') return yellow('WARNING');
  return green('OK');
}

function colorDiscrepancy(d: Discrepancy): string {
  const pct = d.diffPct !== null ? ` (${d.diffPct.toFixed(1)}%)` : '';
  const line = `    ${d.field}: koinly=${d.koinlyValue} internal=${d.internalValue}${pct}`;
  if (d.severity === 'error') return red(line);
  if (d.severity === 'warning') return yellow(line);
  return dim(line);
}

// ---------------------------------------------------------------------------
// Section printers
// ---------------------------------------------------------------------------

function printMatchPair(pair: MatchPair, idx: number): void {
  const { koinly: k, internal: i } = pair;
  const severity = worstSeverity(pair.discrepancies);

  const header = `[ROW ${k.rowNum}] ${k.type.toUpperCase()} ${formatDate(k.dateMs)}`;
  const matchInfo = pair.matchMethod === 'tx_hash'
    ? cyan(`TX_HASH`)
    : cyan(`TIMESTAMP (delta: ${(pair.timestampDeltaMs / 1000).toFixed(0)}s)`);

  console.log(`  ${bold(header)}`);
  console.log(`  Koinly:   ${formatKoinlyAsset(k)}${k.received ? ' → ' + formatKoinlyReceived(k) : ''}   USD: ${formatUsd(k.usdValue)}${k.tag ? '  tag=' + k.tag : ''}`);
  console.log(`  Internal: ${i.label}${i.usdValue !== null ? '   USD: ' + formatUsd(i.usdValue) : ''}${i.swapInSymbol ? `   swap: ${formatAmount(i.swapInAmount, i.swapInSymbol)} → ${formatAmount(i.swapOutAmount, i.swapOutSymbol)}` : ''}`);
  console.log(`  Match:    ${matchInfo}   ${severityLabel(severity)}`);

  // Show non-ok discrepancies
  const notable = pair.discrepancies.filter((d) => d.severity !== 'ok');
  for (const d of notable) {
    console.log(colorDiscrepancy(d));
  }
  console.log();
}

function printUnmatchedKoinlyRow(row: KoinlyRow): void {
  const type = row.type.toLowerCase();
  let suggestion = '';

  if (type === 'deposit' && row.tag === 'mint') {
    const tokenIdMatch = (row.received?.symbol ?? row.notes).match(/#(\d+)/);
    const tokenId = tokenIdMatch?.[1];
    suggestion = tokenId
      ? `check lifecycle event at ${formatDate(row.dateMs)} for tokenId ${tokenId}`
      : `check position_opened lifecycle event near ${formatDate(row.dateMs)}`;
  } else if (type === 'cost') {
    suggestion = `check gas-only step near ${formatDate(row.dateMs)} — may be an approval tx`;
  } else if (type === 'exchange') {
    suggestion = `check swap_executed lifecycle event near ${formatDate(row.dateMs)}`;
  }

  console.log(`  ${bold(`[ROW ${row.rowNum}]`)} ${row.type.toUpperCase()} ${formatDate(row.dateMs)}`);
  console.log(`  Koinly:   ${formatKoinlyAsset(row)}${row.received ? ' → ' + formatKoinlyReceived(row) : ''}   USD: ${formatUsd(row.usdValue)}${row.tag ? '  tag=' + row.tag : ''}`);
  if (row.rawTxHash) console.log(`  TxHash:   ${row.rawTxHash}`);
  if (suggestion) console.log(`  ${yellow('SUGGESTION:')} ${suggestion}`);
  console.log();
}

function printUnmatchedInternal(event: InternalEvent): void {
  console.log(`  ${dim(`[${event.kind}]`)} ${formatDate(event.timestamp)}  tokenId=${event.tokenId ?? 'N/A'}`);
  if (event.usdValue !== null) console.log(`    USD: ${formatUsd(event.usdValue)}`);
  if (event.txHash) console.log(`    TxHash: ${formatTxHash(event.txHash)}`);
  console.log();
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface ReportOptions {
  csvPath: string;
  storagePath: string;
  internalEventCount: number;
  koinlyRowCount: number;
  dateRangeMs: [number, number] | null;
  scopeLabel?: string;
  sourceCounts?: {
    rebalances: number;
    feeCollections: number;
    lifecycleEvents: number;
    positionEntries: number;
  };
  /** If true, emit JSON instead of formatted text */
  jsonOutput?: boolean;
}

export interface ReportSummary {
  matchableKoinlyRows: number;
  walletVisibleInternalEvents: number;
  matchedRows: number;
  unmatchedKoinlyRows: number;
  unmatchedInternalEvents: number;
  koinlyCoveragePct: number;
  internalCoveragePct: number;
  discrepancyPairs: number;
  errorPairs: number;
  warningPairs: number;
  overallStatus: 'PASS' | 'WARN' | 'FAIL';
}

export function summarizeResult(result: MatchResult): ReportSummary {
  const { matched, unmatchedKoinly, unmatchedInternal } = result;
  const discrepancyPairs = matched.filter((p) => worstSeverity(p.discrepancies) !== 'ok');
  const errorPairs = discrepancyPairs.filter((p) => worstSeverity(p.discrepancies) === 'error').length;
  const warningPairs = discrepancyPairs.filter((p) => worstSeverity(p.discrepancies) === 'warning').length;
  const matchableKoinlyRows = matched.length + unmatchedKoinly.length;
  const walletVisibleInternalEvents = matched.length + unmatchedInternal.length;
  const koinlyCoveragePct = matchableKoinlyRows > 0
    ? (matched.length / matchableKoinlyRows) * 100
    : 100;
  const internalCoveragePct = walletVisibleInternalEvents > 0
    ? (matched.length / walletVisibleInternalEvents) * 100
    : 100;

  let overallStatus: 'PASS' | 'WARN' | 'FAIL' = 'PASS';
  if (errorPairs > 0 || unmatchedKoinly.length > 0) {
    overallStatus = 'FAIL';
  } else if (warningPairs > 0 || unmatchedInternal.length > 0) {
    overallStatus = 'WARN';
  }

  return {
    matchableKoinlyRows,
    walletVisibleInternalEvents,
    matchedRows: matched.length,
    unmatchedKoinlyRows: unmatchedKoinly.length,
    unmatchedInternalEvents: unmatchedInternal.length,
    koinlyCoveragePct,
    internalCoveragePct,
    discrepancyPairs: discrepancyPairs.length,
    errorPairs,
    warningPairs,
    overallStatus,
  };
}

export function printReport(result: MatchResult, options: ReportOptions): void {
  const summary = summarizeResult(result);

  if (options.jsonOutput) {
    const bigIntReplacer = (_: string, v: unknown) =>
      typeof v === 'bigint' ? v.toString() : v;
    console.log(JSON.stringify({ result, options, summary }, bigIntReplacer, 2));
    return;
  }

  const { matched, unmatchedKoinly, unmatchedInternal } = result;

  console.log();
  console.log(bold(DIVIDER));
  console.log(bold('  KOINLY AUDIT REPORT'));
  console.log(DIVIDER);
  console.log(`  CSV:            ${options.csvPath}`);
  console.log(`  Analytics path: ${options.storagePath}`);
  if (options.scopeLabel) {
    console.log(`  Scope:          ${options.scopeLabel}`);
  }
  if (options.dateRangeMs) {
    const [from, to] = options.dateRangeMs;
    console.log(`  Date range:     ${formatDate(from)} → ${formatDate(to)}`);
  }
  console.log(`  Koinly rows:    ${options.koinlyRowCount}`);
  console.log(`  Internal events:${options.internalEventCount}`);
  if (options.sourceCounts) {
    console.log(
      `  Sources:        rebalances=${options.sourceCounts.rebalances}, ` +
      `fees=${options.sourceCounts.feeCollections}, ` +
      `entries=${options.sourceCounts.positionEntries}, ` +
      `lifecycle=${options.sourceCounts.lifecycleEvents}`,
    );
  }
  console.log();

  // --- MATCHED ---
  const matchCount = matched.length;
  console.log(bold(THIN));
  console.log(bold(`  MATCHED (${matchCount} rows)`));
  console.log(THIN);
  console.log();

  if (matchCount === 0) {
    console.log(dim('  No matched rows.'));
    console.log();
  } else {
    // Show clean matches first, then discrepancies
    const clean = matched.filter((p) => worstSeverity(p.discrepancies) === 'ok');
    const problematic = matched.filter((p) => worstSeverity(p.discrepancies) !== 'ok');

    for (const pair of clean) {
      printMatchPair(pair, 0);
    }

    if (problematic.length > 0) {
      console.log(bold(`  --- Matches with discrepancies ---`));
      console.log();
      for (const pair of problematic) {
        printMatchPair(pair, 0);
      }
    }
  }

  // --- UNMATCHED KOINLY ---
  const unmatchedK = unmatchedKoinly.length;
  console.log(bold(THIN));
  console.log(bold(`  UNMATCHED KOINLY ROWS (${unmatchedK})`));
  console.log(THIN);
  console.log();

  if (unmatchedK === 0) {
    console.log(green('  All Koinly rows matched.'));
    console.log();
  } else {
    for (const row of unmatchedKoinly) {
      printUnmatchedKoinlyRow(row);
    }
  }

  // --- UNMATCHED INTERNAL ---
  const unmatchedI = unmatchedInternal.length;
  console.log(bold(THIN));
  console.log(bold(`  INTERNAL EVENTS NOT IN KOINLY (${unmatchedI})`));
  console.log(THIN);
  console.log();

  if (unmatchedI === 0) {
    console.log(green('  All internal events matched.'));
    console.log();
  } else {
    for (const event of unmatchedInternal) {
      printUnmatchedInternal(event);
    }
  }

  // --- SUMMARY ---
  const overallStatus = summary.overallStatus === 'FAIL'
    ? red('FAIL — Koinly coverage gaps or hard discrepancies found')
    : summary.overallStatus === 'WARN'
      ? yellow('WARN — internal coverage gaps or minor issues found')
      : green('PASS');

  console.log(bold(DIVIDER));
  console.log(bold('  SUMMARY'));
  console.log(DIVIDER);
  console.log(`  Matched:          ${summary.matchedRows} / ${summary.matchableKoinlyRows} rows (${summary.koinlyCoveragePct.toFixed(1)}%)`);
  console.log(`  Koinly coverage:  ${summary.koinlyCoveragePct.toFixed(1)}% (${summary.unmatchedKoinlyRows} unmatched row(s))`);
  console.log(`  Internal coverage:${summary.internalCoveragePct.toFixed(1)}% (${summary.unmatchedInternalEvents} unmatched event(s))`);
  console.log(`  Discrepancies:    ${summary.discrepancyPairs} (${summary.errorPairs} errors, ${summary.warningPairs} warnings)`);
  console.log(`  Unmatched Koinly: ${unmatchedK}`);
  console.log(`  Internal orphans: ${unmatchedI}`);
  console.log(`  Overall status:   ${overallStatus}`);
  console.log(DIVIDER);
  console.log();
}

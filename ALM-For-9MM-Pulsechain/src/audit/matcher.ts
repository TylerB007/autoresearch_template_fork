/**
 * Matching engine that pairs Koinly rows against internal analytics events.
 *
 * Pass 1: tx hash match — prefix+suffix fuzzy match (supports Koinly truncation).
 * Pass 2: timestamp ± 5 min + compatible event type for unmatched rows.
 * Pass 3: anything unmatched is reported separately.
 */

import type { KoinlyRow } from './koinly.js';
import { extractTxHashParts } from './koinly.js';
import type {
  RebalanceAnalytics,
  FeeCollectionRecord,
  RebalanceLifecycleEvent,
  PositionEntryRecord,
} from '../analytics/types.js';

// ---------------------------------------------------------------------------
// Internal event index types
// ---------------------------------------------------------------------------

export type InternalEventKind =
  | 'rebalance_collectFees'
  | 'rebalance_decreaseLiquidity'
  | 'rebalance_collectTokens'
  | 'rebalance_burn'
  | 'rebalance_swap'
  | 'rebalance_mint'
  | 'rebalance_mint_token0'
  | 'rebalance_mint_token1'
  | 'position_entry'
  | 'position_entry_token0'
  | 'position_entry_token1'
  | 'fee_collection'
  | 'lifecycle_event';

export interface InternalEvent {
  kind: InternalEventKind;
  timestamp: number;
  txHash: string | null;
  tokenId: number | null;
  chainId: number | null;
  /** USD value associated with this step, if known */
  usdValue: number | null;
  /** Token0 amount (human-readable, decimal-adjusted) */
  amount0Human: number | null;
  /** Token1 amount (human-readable, decimal-adjusted) */
  amount1Human: number | null;
  /** Token symbols */
  token0Symbol: string | null;
  token1Symbol: string | null;
  /** Gas cost in USD */
  gasCostUsd: number | null;
  /** Swap-specific: in symbol */
  swapInSymbol: string | null;
  /** Swap-specific: out symbol */
  swapOutSymbol: string | null;
  /** Swap-specific: in amount (human-readable) */
  swapInAmount: number | null;
  /** Swap-specific: out amount (human-readable) */
  swapOutAmount: number | null;
  /** Lifecycle event type (only for lifecycle_event kind) */
  lifecycleEventType: string | null;
  /** Source record for display */
  source: RebalanceAnalytics | FeeCollectionRecord | RebalanceLifecycleEvent | PositionEntryRecord;
  /** Human-readable label for report */
  label: string;
}

export interface MatchPair {
  koinly: KoinlyRow;
  internal: InternalEvent;
  matchMethod: 'tx_hash' | 'timestamp_type';
  /** Delta between koinly timestamp and internal timestamp in ms */
  timestampDeltaMs: number;
  discrepancies: Discrepancy[];
}

export interface Discrepancy {
  field: string;
  koinlyValue: string;
  internalValue: string;
  diffPct: number | null;
  severity: 'ok' | 'warning' | 'error';
}

export interface MatchResult {
  matched: MatchPair[];
  unmatchedKoinly: KoinlyRow[];
  unmatchedInternal: InternalEvent[];
}

// ---------------------------------------------------------------------------
// Tolerances
// ---------------------------------------------------------------------------

const TIMESTAMP_TOLERANCE_MS = 5 * 60 * 1000; // 5 minutes
const USD_TOLERANCE_PCT = 5;       // ±5% for general USD values
const GAS_USD_TOLERANCE_PCT = 10;  // ±10% for gas costs (gas price volatility)
const AMOUNT_TOLERANCE_PCT = 0.1;  // ±0.1% for token amounts (Koinly abbreviates: 11.05m → 11050000 vs actual 11047880)

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function humanAmount(raw: bigint, decimals: number): number {
  const divisor = 10 ** decimals;
  return Number(raw) / divisor;
}

/**
 * Minimum prefix length required for a truncated hash to be considered
 * reliable enough for standalone matching. Short prefixes (2-3 chars) produce
 * too many false positives when the same truncated pattern appears on dozens
 * of different transactions.
 */
const MIN_RELIABLE_PREFIX_LEN = 6;

/**
 * Returns true if a full internal tx hash matches a (possibly truncated) Koinly hash.
 * Match requires: prefix AND suffix both match (case-insensitive).
 * For short prefixes (< 6 hex chars), returns false — these are too ambiguous.
 */
function txHashMatches(koinlyRaw: string, internalFull: string): boolean {
  const parts = extractTxHashParts(koinlyRaw);
  if (!parts) return false;
  // Short truncations like '0x8c...976b' (2+4 chars) are not reliable
  // — they match dozens of different on-chain hashes
  if (!parts.noTruncation && parts.prefix.length < MIN_RELIABLE_PREFIX_LEN) return false;
  const full = internalFull.toLowerCase();
  if (!full.startsWith('0x')) return false;
  const body = full.slice(2);
  return body.startsWith(parts.prefix) && body.endsWith(parts.suffix);
}

/**
 * Koinly row type → compatible InternalEventKind list.
 */
function compatibleKinds(row: KoinlyRow): InternalEventKind[] {
  const type = row.type.toLowerCase();
  const tag = row.tag.toLowerCase();

  // Exchange rows where received asset is an NFT (e.g., '9MM-V3-POS #155895')
  // are actually mint deposits, not swaps — Koinly categorizes them as Exchange
  // because the wallet exchanged tokens for an NFT.
  const receivedIsNft = row.received?.symbol ? /#\d+/.test(row.received.symbol) : false;
  if ((type === 'exchange' || tag === 'token swap') && receivedIsNft) {
    return ['position_entry', 'position_entry_token0', 'position_entry_token1', 'rebalance_mint', 'rebalance_mint_token0', 'rebalance_mint_token1', 'lifecycle_event'];
  }

  // Exchange / token swap rows — match to swap step
  if (type === 'exchange' || tag === 'token swap') {
    return ['rebalance_swap', 'lifecycle_event'];
  }

  // Deposit with 'mint' tag — NFT minted (position_opened)
  if (type === 'deposit' && tag === 'mint') {
    return ['position_entry', 'position_entry_token0', 'position_entry_token1', 'rebalance_mint', 'rebalance_mint_token0', 'rebalance_mint_token1', 'lifecycle_event'];
  }

  // Deposit with 'token receive' tag — tokens returned from decreaseLiquidity/collect
  if (type === 'deposit' && (tag === 'token receive' || tag === 'receive')) {
    return [
      'rebalance_collectFees',
      'rebalance_collectTokens',
      'rebalance_decreaseLiquidity',
      'fee_collection',
      'lifecycle_event',
    ];
  }

  // Send with 'mint' tag — tokens sent to new position (mint deposit)
  if (type === 'send' && tag === 'mint') {
    return ['position_entry_token0', 'position_entry_token1', 'rebalance_mint_token0', 'rebalance_mint_token1', 'position_entry', 'rebalance_mint', 'lifecycle_event'];
  }

  // Send with 'burn' tag — NFT burned (position_exited)
  if (type === 'send' && tag === 'burn') {
    return ['rebalance_burn', 'lifecycle_event'];
  }

  // Send with 'token swap' / 'token send' — tokens sent as part of swap or manual transfer
  if (type === 'send' && (tag === 'token swap' || tag === 'token send')) {
    return ['rebalance_swap', 'lifecycle_event'];
  }

  // Send (generic) — could be mint deposit, position exit, or token transfer
  if (type === 'send') {
    return [
      'rebalance_mint_token0',
      'rebalance_mint_token1',
      'rebalance_mint',
      'rebalance_burn',
      'rebalance_decreaseLiquidity',
      'lifecycle_event',
    ];
  }

  // Withdrawal — position exit
  if (type === 'withdrawal' || tag === 'remove liquidity') {
    return ['rebalance_decreaseLiquidity', 'rebalance_burn', 'rebalance_collectTokens', 'lifecycle_event'];
  }

  // Income — fee collection
  if (type === 'income') {
    return ['fee_collection', 'rebalance_collectFees', 'lifecycle_event'];
  }

  // Deposit (generic) — receiving tokens from LP or external source
  if (type === 'deposit') {
    return [
      'rebalance_collectFees',
      'rebalance_collectTokens',
      'rebalance_decreaseLiquidity',
      'fee_collection',
      'lifecycle_event',
    ];
  }

  // Cost / approve / burn / contract action / revoke — gas-only rows
  if (
    type === 'cost' ||
    tag === 'approve' ||
    tag === 'revoke' ||
    tag === 'burn' ||
    tag.includes('contra') ||
    tag === 'contract action'
  ) {
    return [
      'rebalance_collectFees',
      'rebalance_decreaseLiquidity',
      'rebalance_collectTokens',
      'rebalance_burn',
      'rebalance_swap',
      'rebalance_mint',
      'fee_collection',
      'lifecycle_event',
    ];
  }

  // Transfer — wallet-to-wallet move, unlikely to match internal events
  if (type === 'transfer') {
    return [];
  }

  // Fallback — match against anything
  return [
    'rebalance_collectFees',
    'rebalance_decreaseLiquidity',
    'rebalance_collectTokens',
    'rebalance_burn',
    'rebalance_swap',
    'rebalance_mint',
    'fee_collection',
    'lifecycle_event',
  ];
}

// ---------------------------------------------------------------------------
// Discrepancy checker
// ---------------------------------------------------------------------------

function pctDiff(a: number, b: number): number | null {
  if (b === 0) return a === 0 ? 0 : null;
  return Math.abs((a - b) / b) * 100;
}

function checkDiscrepancies(koinly: KoinlyRow, internal: InternalEvent): Discrepancy[] {
  const discrepancies: Discrepancy[] = [];

  const addCheck = (
    field: string,
    kVal: number | null,
    iVal: number | null,
    tolerance: number,
    /** Override severity — forces this severity regardless of tolerance check */
    forceSeverity?: 'ok' | 'warning' | 'error',
  ) => {
    if (kVal === null || iVal === null || (kVal === 0 && iVal === 0)) return;
    // When internal value is 0 but koinly is not, it's missing data — not a real discrepancy
    if (iVal === 0 && kVal !== 0) {
      discrepancies.push({
        field,
        koinlyValue: kVal.toFixed(6),
        internalValue: '0 (not recorded)',
        diffPct: null,
        severity: forceSeverity ?? 'ok',
      });
      return;
    }
    const diff = pctDiff(kVal, iVal);
    if (diff === null) {
      discrepancies.push({
        field,
        koinlyValue: kVal.toFixed(6),
        internalValue: String(iVal),
        diffPct: null,
        severity: forceSeverity ?? 'ok',
      });
      return;
    }
    const severity = forceSeverity ?? (diff > tolerance ? 'error' : diff > tolerance / 2 ? 'warning' : 'ok');
    discrepancies.push({
      field,
      koinlyValue: kVal.toFixed(6),
      internalValue: iVal.toFixed(6),
      diffPct: diff,
      severity,
    });
  };

  const type = koinly.type.toLowerCase();
  const kind = internal.kind;

  // USD value check — skip for mint steps (internal=gas cost, Koinly=position value — not comparable)
  const kUsd = koinly.usdValue;
  const isMintLikeEvent = kind === 'rebalance_mint' || kind === 'position_entry'
    || kind === 'rebalance_mint_token0' || kind === 'rebalance_mint_token1'
    || kind === 'position_entry_token0' || kind === 'position_entry_token1';
  if (kUsd !== 0) {
    const iUsd =
      type === 'cost'
        ? internal.gasCostUsd
        : internal.usdValue ?? (isMintLikeEvent ? null : internal.gasCostUsd);

    const tolerance = type === 'cost' ? GAS_USD_TOLERANCE_PCT : USD_TOLERANCE_PCT;
    addCheck('usd_value', kUsd, iUsd, tolerance);
  }

  // Swap-specific checks — skip when received is an NFT (Exchange used for mint deposits)
  const receivedIsNft = koinly.received?.symbol ? /#\d+/.test(koinly.received.symbol) : false;
  if (
    (type === 'exchange' || koinly.tag.toLowerCase() === 'token swap') &&
    !receivedIsNft &&
    internal.swapInSymbol &&
    koinly.asset
  ) {
    const kSymbol = koinly.asset.symbol.toUpperCase();
    const iSymbol = (internal.swapInSymbol ?? '').toUpperCase();

    // Symbol check — wrapped variants (WPLS/PLS, WETH/ETH) are OK
    if (!symbolsMatch(kSymbol, iSymbol)) {
      discrepancies.push({
        field: 'swap_in_symbol',
        koinlyValue: kSymbol,
        internalValue: iSymbol,
        diffPct: null,
        severity: 'error',
      });
    }

    // Swap in amount — the reliable ground-truth comparison
    if (koinly.asset.amount !== 0) {
      addCheck('swap_in_amount', Math.abs(koinly.asset.amount), internal.swapInAmount, AMOUNT_TOLERANCE_PCT);
    }

    // Swap out amount — for rebalance events (both rebalance_swap and lifecycle
    // swap_executed), internal stores raw DEX output while Koinly stores net
    // wallet change (after mint consumes most tokens). These are architecturally
    // different values, so flag as informational only.
    if (koinly.received?.amount && internal.swapOutAmount) {
      const isRebalanceSwap = kind === 'rebalance_swap' ||
        (kind === 'lifecycle_event' && internal.lifecycleEventType === 'swap_executed');
      if (isRebalanceSwap) {
        addCheck('swap_out_amount', Math.abs(koinly.received.amount), internal.swapOutAmount, AMOUNT_TOLERANCE_PCT, 'ok');
      } else {
        addCheck('swap_out_amount', Math.abs(koinly.received.amount), internal.swapOutAmount, AMOUNT_TOLERANCE_PCT);
      }
    }
  }

  return discrepancies;
}

// ---------------------------------------------------------------------------
// Index builder: flatten all internal records into InternalEvent[]
// ---------------------------------------------------------------------------

export function buildInternalEventIndex(
  rebalances: RebalanceAnalytics[],
  feeCollections: FeeCollectionRecord[],
  positionEntries: PositionEntryRecord[],
  lifecycleEvents: RebalanceLifecycleEvent[],
): InternalEvent[] {
  const events: InternalEvent[] = [];
  const coveredTxHashes = new Set<string>();

  // Expand each RebalanceAnalytics into per-tx-hash events
  for (const r of rebalances) {
    const decimals0 = r.preSnapshot.token0Decimals;
    const decimals1 = r.preSnapshot.token1Decimals;
    const sym0 = r.preSnapshot.token0Symbol;
    const sym1 = r.preSnapshot.token1Symbol;

    const base = {
      tokenId: r.oldTokenId,
      chainId: r.chainId ?? null,
      token0Symbol: sym0,
      token1Symbol: sym1,
      amount0Human: null,
      amount1Human: null,
      usdValue: null,
      gasCostUsd: null,
      swapInSymbol: null,
      swapOutSymbol: null,
      swapInAmount: null,
      swapOutAmount: null,
      lifecycleEventType: null,
      source: r as RebalanceAnalytics,
    };

    // Gas cost per step (approximate: allocate proportionally)
    const totalGasUnits = Number(r.gasUsed.total || 1n);
    const perStepGasFraction = (units: bigint) =>
      r.gasCostUsd != null
        ? (r.gasCostUsd * Number(units)) / totalGasUnits
        : null;

    // collectFees step
    if (r.txHashes.collectFees) {
      coveredTxHashes.add(r.txHashes.collectFees.toLowerCase());
      events.push({
        ...base,
        kind: 'rebalance_collectFees',
        timestamp: r.timestamp,
        txHash: r.txHashes.collectFees,
        amount0Human: humanAmount(r.feesCollected0, decimals0),
        amount1Human: humanAmount(r.feesCollected1, decimals1),
        usdValue: r.feesCollectedUsd ?? null,
        gasCostUsd: perStepGasFraction(r.gasUsed.collectFees),
        label: `rebalance collectFees tokenId=${r.oldTokenId}`,
      });
    }

    // decreaseLiquidity step
    if (r.txHashes.decreaseLiquidity) {
      coveredTxHashes.add(r.txHashes.decreaseLiquidity.toLowerCase());
      events.push({
        ...base,
        kind: 'rebalance_decreaseLiquidity',
        timestamp: r.timestamp,
        txHash: r.txHashes.decreaseLiquidity,
        amount0Human: humanAmount(r.liquidityRemoved0, decimals0),
        amount1Human: humanAmount(r.liquidityRemoved1, decimals1),
        gasCostUsd: perStepGasFraction(r.gasUsed.decreaseLiquidity),
        label: `rebalance decreaseLiquidity tokenId=${r.oldTokenId}`,
      });
    }

    // collectTokens step
    if (r.txHashes.collectTokens) {
      coveredTxHashes.add(r.txHashes.collectTokens.toLowerCase());
      events.push({
        ...base,
        kind: 'rebalance_collectTokens',
        timestamp: r.timestamp,
        txHash: r.txHashes.collectTokens,
        gasCostUsd: perStepGasFraction(r.gasUsed.collectTokens),
        label: `rebalance collectTokens tokenId=${r.oldTokenId}`,
      });
    }

    // burn step
    if (r.txHashes.burn) {
      coveredTxHashes.add(r.txHashes.burn.toLowerCase());
      events.push({
        ...base,
        kind: 'rebalance_burn',
        timestamp: r.timestamp,
        txHash: r.txHashes.burn,
        gasCostUsd: perStepGasFraction(r.gasUsed.burn),
        label: `rebalance burn tokenId=${r.oldTokenId}`,
      });
    }

    // swap step
    if (r.txHashes.swap && r.swap) {
      const isToken0In = r.swap.tokenIn === 'token0';
      coveredTxHashes.add(r.txHashes.swap.toLowerCase());
      events.push({
        ...base,
        kind: 'rebalance_swap',
        timestamp: r.timestamp,
        txHash: r.txHashes.swap,
        swapInSymbol: isToken0In ? sym0 : sym1,
        swapOutSymbol: isToken0In ? sym1 : sym0,
        swapInAmount: humanAmount(r.swap.amountIn, isToken0In ? decimals0 : decimals1),
        swapOutAmount: humanAmount(r.swap.amountOut, isToken0In ? decimals1 : decimals0),
        usdValue: r.swapFrictionUsd != null && r.priceUsd0 != null
          ? humanAmount(r.swap.amountIn, isToken0In ? decimals0 : decimals1) *
            (isToken0In ? (r.priceUsd0 ?? 0) : (r.priceUsd1 ?? 0))
          : null,
        gasCostUsd: perStepGasFraction(r.gasUsed.swap),
        label: `rebalance swap tokenId=${r.oldTokenId}`,
      });
    }

    // mint step — emit per-token leg events so Koinly's per-token SEND rows
    // can match individually with correct single-token USD values.
    if (r.txHashes.mint) {
      coveredTxHashes.add(r.txHashes.mint.toLowerCase());
      const amt0 = humanAmount(r.newAmount0, decimals0);
      const amt1 = humanAmount(r.newAmount1, decimals1);
      const usd0 = r.priceUsd0 != null ? amt0 * r.priceUsd0 : null;
      const usd1 = r.priceUsd1 != null ? amt1 * r.priceUsd1 : null;
      const mintGas = perStepGasFraction(r.gasUsed.mint);

      // Token0 leg
      if (amt0 !== 0 || usd0 !== null) {
        events.push({
          ...base,
          kind: 'rebalance_mint_token0',
          timestamp: r.timestamp,
          txHash: r.txHashes.mint,
          tokenId: r.newTokenId,
          amount0Human: amt0,
          amount1Human: null,
          usdValue: usd0,
          gasCostUsd: mintGas,
          label: `rebalance mint token0 (${sym0}) newTokenId=${r.newTokenId}`,
        });
      }

      // Token1 leg
      if (amt1 !== 0 || usd1 !== null) {
        events.push({
          ...base,
          kind: 'rebalance_mint_token1',
          timestamp: r.timestamp,
          txHash: r.txHashes.mint,
          tokenId: r.newTokenId,
          amount0Human: null,
          amount1Human: amt1,
          usdValue: usd1,
          gasCostUsd: mintGas,
          label: `rebalance mint token1 (${sym1}) newTokenId=${r.newTokenId}`,
        });
      }

      // Combined event kept as fallback for Koinly rows that don't split
      // (e.g., Exchange rows receiving an NFT)
      events.push({
        ...base,
        kind: 'rebalance_mint',
        timestamp: r.timestamp,
        txHash: r.txHashes.mint,
        tokenId: r.newTokenId,
        amount0Human: amt0,
        amount1Human: amt1,
        usdValue: usd0 != null && usd1 != null ? usd0 + usd1 : null,
        gasCostUsd: mintGas,
        label: `rebalance mint newTokenId=${r.newTokenId}`,
      });
    }
  }

  // FeeCollectionRecord entries
  for (const f of feeCollections) {
    coveredTxHashes.add(f.txHash.toLowerCase());
    events.push({
      kind: 'fee_collection',
      timestamp: f.timestamp,
      txHash: f.txHash,
      tokenId: f.tokenId,
      chainId: f.chainId ?? null,
      token0Symbol: f.token0Symbol,
      token1Symbol: f.token1Symbol,
      amount0Human: humanAmount(f.amount0, f.token0Decimals),
      amount1Human: humanAmount(f.amount1, f.token1Decimals),
      usdValue: f.totalValueUsd,
      gasCostUsd: null,
      swapInSymbol: null,
      swapOutSymbol: null,
      swapInAmount: null,
      swapOutAmount: null,
      lifecycleEventType: null,
      source: f,
      label: `fee_collection tokenId=${f.tokenId}`,
    });
  }

  // PositionEntryRecord entries that are not already represented by a rebalance step.
  // These preserve mint-side valuation for manual or historical entries without duplicating
  // the standard rebalance mint transaction already present in RebalanceAnalytics.
  // Each entry is split into per-token legs so Koinly's per-token SEND rows can match.
  for (const entry of positionEntries) {
    const lower = entry.txHash.toLowerCase();
    if (coveredTxHashes.has(lower)) continue;
    coveredTxHashes.add(lower);

    const amt0 = humanAmount(entry.amount0, entry.token0Decimals);
    const amt1 = humanAmount(entry.amount1, entry.token1Decimals);
    const usd0 = entry.priceUsd0 != null ? amt0 * entry.priceUsd0 : null;
    const usd1 = entry.priceUsd1 != null ? amt1 * entry.priceUsd1 : null;

    const entryBase = {
      timestamp: entry.timestamp,
      txHash: entry.txHash,
      tokenId: entry.tokenId,
      chainId: entry.chainId ?? null,
      token0Symbol: entry.token0Symbol,
      token1Symbol: entry.token1Symbol,
      gasCostUsd: entry.gasCostUsd,
      swapInSymbol: null,
      swapOutSymbol: null,
      swapInAmount: null,
      swapOutAmount: null,
      lifecycleEventType: null,
      source: entry,
    };

    // Token0 leg
    if (amt0 !== 0 || usd0 !== null) {
      events.push({
        ...entryBase,
        kind: 'position_entry_token0',
        amount0Human: amt0,
        amount1Human: null,
        usdValue: usd0,
        label: `position entry token0 (${entry.token0Symbol}) tokenId=${entry.tokenId}`,
      });
    }

    // Token1 leg
    if (amt1 !== 0 || usd1 !== null) {
      events.push({
        ...entryBase,
        kind: 'position_entry_token1',
        amount0Human: null,
        amount1Human: amt1,
        usdValue: usd1,
        label: `position entry token1 (${entry.token1Symbol}) tokenId=${entry.tokenId}`,
      });
    }

    // Combined event kept as fallback
    events.push({
      ...entryBase,
      kind: 'position_entry',
      amount0Human: amt0,
      amount1Human: amt1,
      usdValue: entry.entryCostUsd,
      label: `position entry tokenId=${entry.tokenId}`,
    });
  }

  // RebalanceLifecycleEvent entries (only those with a txHash and NOT already covered above)
  // We include lifecycle events to catch events that may not appear in a completed RebalanceAnalytics
  // (e.g., a failed rebalance that only has lifecycle events).
  for (const e of lifecycleEvents) {
    if (!e.txHash) continue;
    const lower = e.txHash.toLowerCase();
    // Skip if already covered by a richer rebalance, fee collection, or position entry event.
    if (coveredTxHashes.has(lower)) continue;
    coveredTxHashes.add(lower);

    events.push({
      kind: 'lifecycle_event',
      timestamp: e.timestamp,
      txHash: e.txHash,
      tokenId: e.tokenId,
      chainId: e.chainId ?? null,
      lifecycleEventType: e.eventType,
      token0Symbol: e.token0Symbol ?? null,
      token1Symbol: e.token1Symbol ?? null,
      amount0Human: e.amount0 != null && e.token0Decimals != null
        ? humanAmount(e.amount0, e.token0Decimals)
        : null,
      amount1Human: e.amount1 != null && e.token1Decimals != null
        ? humanAmount(e.amount1, e.token1Decimals)
        : null,
      usdValue: null,
      gasCostUsd: null,
      swapInSymbol: e.swap?.tokenIn === 'token0' ? (e.token0Symbol ?? null) : (e.token1Symbol ?? null),
      swapOutSymbol: e.swap?.tokenIn === 'token0' ? (e.token1Symbol ?? null) : (e.token0Symbol ?? null),
      swapInAmount: e.swap != null && e.token0Decimals != null && e.token1Decimals != null
        ? humanAmount(
            e.swap.amountIn,
            e.swap.tokenIn === 'token0' ? e.token0Decimals : e.token1Decimals,
          )
        : null,
      swapOutAmount: e.swap != null && e.token0Decimals != null && e.token1Decimals != null
        ? humanAmount(
            e.swap.amountOut,
            e.swap.tokenIn === 'token0' ? e.token1Decimals : e.token0Decimals,
          )
        : null,
      source: e,
      label: `lifecycle ${e.eventType} tokenId=${e.tokenId}`,
    });
  }

  return events.sort((a, b) => a.timestamp - b.timestamp);
}

// ---------------------------------------------------------------------------
// Matching engine
// ---------------------------------------------------------------------------

/**
 * Determines whether a Koinly row is "wallet-visible" — i.e., represents an
 * on-chain transaction that should have a counterpart in our internal records.
 * Filters out informational-only row types.
 */
function isMatchableKoinlyRow(row: KoinlyRow): boolean {
  const type = row.type.toLowerCase();
  // 'ignore' or 'transfer' between own wallets with no USD value are typically internal moves
  if (type === 'transfer' && row.usdValue === 0 && !row.rawTxHash) return false;
  return true;
}

/**
 * Determines whether an InternalEvent is expected to appear in Koinly.
 * Non-wallet events (snapshots, triggers, price history) should not appear.
 * Combined mint/entry events are excluded — per-token legs are the primary
 * matchable events, and the combined fallback only matters when matched.
 */
function isWalletVisibleInternal(event: InternalEvent): boolean {
  // Combined mint/entry events are fallbacks — don't list as orphans since
  // the per-token legs represent the same on-chain action more granularly.
  if (event.kind === 'rebalance_mint' || event.kind === 'position_entry') return false;
  return true;
}

// ---------------------------------------------------------------------------
// Match scoring — higher is better
// ---------------------------------------------------------------------------

/**
 * Normalizes a Koinly symbol for comparison.
 * PLS and WPLS are treated as equivalent (wrapped/unwrapped).
 */
function normalizeSymbol(sym: string): string {
  const upper = sym.toUpperCase().trim();
  // Treat wrapped and unwrapped as equivalent
  if (upper === 'WPLS') return 'PLS';
  if (upper === 'WETH') return 'ETH';
  return upper;
}

/**
 * Checks if a Koinly symbol matches an internal token symbol.
 */
function symbolsMatch(koinly: string, internal: string): boolean {
  return normalizeSymbol(koinly) === normalizeSymbol(internal);
}

/**
 * Computes how well a Koinly amount matches an internal event amount.
 * Returns a score component:
 *   +100  exact amount match (within 0.01%)
 *   +50   close amount match (within 1%)
 *   +25   same symbol, different amount
 *   +10   amount matches but different symbol (could be wrapped variant)
 *   0     no amount info to compare
 *   -10   symbol mismatch with amount mismatch
 */
function amountMatchScore(koinlyAmount: number | null, koinlySymbol: string | null,
  internalAmounts: { amount: number | null; symbol: string | null }[]): number {
  if (koinlyAmount === null || koinlyAmount === 0 || !koinlySymbol) return 0;

  const kAbs = Math.abs(koinlyAmount);
  let bestScore = 0;

  for (const { amount: iAmt, symbol: iSym } of internalAmounts) {
    if (iAmt === null || iAmt === 0 || !iSym) continue;
    const iAbs = Math.abs(iAmt);

    const symMatch = symbolsMatch(koinlySymbol, iSym);
    const amtDiffPct = iAbs > 0 ? Math.abs(kAbs - iAbs) / iAbs * 100 : 100;

    let score = 0;
    if (symMatch && amtDiffPct <= 0.01) score = 100;      // exact match
    else if (symMatch && amtDiffPct <= 1) score = 50;      // close match
    else if (symMatch) score = 25;                          // right symbol, wrong amount
    else if (amtDiffPct <= 1) score = 10;                   // right amount, maybe wrapped variant
    else score = -10;

    if (score > bestScore) bestScore = score;
  }

  return bestScore;
}

/**
 * Computes a composite match score for a Koinly row vs an internal event.
 * Higher is better. Components:
 *   - Time proximity: 0-100 (closer = higher)
 *   - Asset amount/symbol match: -10 to +100
 *   - Received amount/symbol match: -10 to +100
 *   - NFT tokenId match from Koinly 'Deposit 9MM-V3-POS #156468': +200
 */
function computeMatchScore(kRow: KoinlyRow, iEvent: InternalEvent, deltaMs: number): number {
  // Time score: 100 at 0 delta, linearly decreasing to 0 at TIMESTAMP_TOLERANCE_MS
  const timeScore = 100 * (1 - deltaMs / TIMESTAMP_TOLERANCE_MS);

  const isExchange = kRow.type.toLowerCase() === 'exchange' || kRow.tag.toLowerCase() === 'token swap';

  // For Exchange rows with swap data, verify symbol compatibility first.
  // If the sent symbol doesn't match any internal swap/token symbol, this is
  // almost certainly a wrong match — apply a heavy penalty.
  if (isExchange && kRow.asset?.symbol && iEvent.swapInSymbol) {
    const kSentSym = normalizeSymbol(kRow.asset.symbol);
    const iInSym = normalizeSymbol(iEvent.swapInSymbol);
    const iOutSym = normalizeSymbol(iEvent.swapOutSymbol ?? '');
    if (kSentSym !== iInSym && kSentSym !== iOutSym) {
      return -500; // Hard reject — symbol conflict
    }
  }

  // Lifecycle event type compatibility bonus/penalty.
  // If the internal event has a specific eventType, reward compatible matches
  // and penalize incompatible ones.
  let lifecycleScore = 0;
  if (iEvent.lifecycleEventType) {
    const et = iEvent.lifecycleEventType;
    const tag = kRow.tag.toLowerCase();
    const kType = kRow.type.toLowerCase();

    if (et === 'swap_executed') {
      lifecycleScore = isExchange ? 50 : -100;
    } else if (et === 'position_opened') {
      lifecycleScore = (kType === 'deposit' && tag === 'mint') || (kType === 'send' && tag === 'mint') ? 50 : -100;
    } else if (et === 'position_exited') {
      lifecycleScore = (kType === 'send' && tag === 'burn') || kType === 'withdrawal' ? 50 : -100;
    } else if (et === 'fees_collected') {
      lifecycleScore = (kType === 'deposit' || kType === 'income') ? 50 : -100;
    } else if (et === 'rebalance_triggered' || et === 'rebalance_completed') {
      lifecycleScore = kType === 'cost' ? 20 : -50;
    }
  }

  let kindPreferenceScore = 0;
  const tag = kRow.tag.toLowerCase();
  const receivedIsNft = kRow.received?.symbol ? /#\d+/.test(kRow.received.symbol) : false;
  const kType = kRow.type.toLowerCase();

  // SEND + mint tag = single token leg → prefer per-token events
  const isSendMint = kType === 'send' && tag === 'mint';
  // Deposit + mint or Exchange + NFT = combined position → prefer combined events
  const isCombinedMint =
    (kType === 'deposit' && tag === 'mint') ||
    ((kType === 'exchange' || tag === 'token swap') && receivedIsNft);

  if (isSendMint) {
    // Per-token legs are the best match for single-token SEND rows
    if (iEvent.kind === 'position_entry_token0' || iEvent.kind === 'position_entry_token1') kindPreferenceScore += 100;
    if (iEvent.kind === 'rebalance_mint_token0' || iEvent.kind === 'rebalance_mint_token1') kindPreferenceScore += 80;
    // Demote combined events — they'd cause USD mismatch (total vs single leg)
    if (iEvent.kind === 'position_entry') kindPreferenceScore -= 50;
    if (iEvent.kind === 'rebalance_mint') kindPreferenceScore -= 50;
  } else if (isCombinedMint) {
    // Combined events are the best match for NFT deposits / combined position rows
    if (iEvent.kind === 'position_entry') kindPreferenceScore += 75;
    if (iEvent.kind === 'rebalance_mint') kindPreferenceScore += 40;
    // Per-token legs would be wrong for combined rows
    if (iEvent.kind === 'position_entry_token0' || iEvent.kind === 'position_entry_token1') kindPreferenceScore -= 50;
    if (iEvent.kind === 'rebalance_mint_token0' || iEvent.kind === 'rebalance_mint_token1') kindPreferenceScore -= 50;
  }

  // Asset (sent) amount scoring
  const assetScore = amountMatchScore(
    kRow.asset?.amount ?? null,
    kRow.asset?.symbol ?? null,
    [
      { amount: iEvent.amount0Human, symbol: iEvent.token0Symbol },
      { amount: iEvent.amount1Human, symbol: iEvent.token1Symbol },
      { amount: iEvent.swapInAmount, symbol: iEvent.swapInSymbol },
    ],
  );

  // Received amount scoring
  const receivedScore = amountMatchScore(
    kRow.received?.amount ?? null,
    kRow.received?.symbol ?? null,
    [
      { amount: iEvent.amount0Human, symbol: iEvent.token0Symbol },
      { amount: iEvent.amount1Human, symbol: iEvent.token1Symbol },
      { amount: iEvent.swapOutAmount, symbol: iEvent.swapOutSymbol },
    ],
  );

  // NFT tokenId match: if Koinly row references a specific position (e.g., '9MM-V3-POS #156468')
  let nftScore = 0;
  const nftMatch = (kRow.asset?.symbol ?? '').match(/#(\d+)/) ??
                   (kRow.received?.symbol ?? '').match(/#(\d+)/);
  if (nftMatch && iEvent.tokenId !== null) {
    const koinlyTokenId = parseInt(nftMatch[1], 10);
    nftScore = koinlyTokenId === iEvent.tokenId ? 200 : -50;
  }

  return timeScore + assetScore + receivedScore + nftScore + lifecycleScore + kindPreferenceScore;
}

export function matchEvents(
  koinlyRows: KoinlyRow[],
  internalEvents: InternalEvent[],
): MatchResult {
  const matchedKoinlyIndices = new Set<number>();
  const matchedInternalIndices = new Set<number>();
  const matched: MatchPair[] = [];

  // Pass 1: tx hash match
  for (let ki = 0; ki < koinlyRows.length; ki++) {
    const kRow = koinlyRows[ki];
    if (!isMatchableKoinlyRow(kRow)) continue;
    if (!kRow.rawTxHash) continue;

    const compatible = compatibleKinds(kRow);
    let bestIdx = -1;
    let bestScore = -Infinity;

    for (let ii = 0; ii < internalEvents.length; ii++) {
      if (matchedInternalIndices.has(ii)) continue;
      const iEvent = internalEvents[ii];
      if (!iEvent.txHash) continue;

      if (txHashMatches(kRow.rawTxHash, iEvent.txHash)) {
        const compatibilityBoost = compatible.includes(iEvent.kind)
          ? (compatible.length - compatible.indexOf(iEvent.kind)) * 1000
          : 0;
        const score = compatibilityBoost + computeMatchScore(
          kRow,
          iEvent,
          Math.abs(kRow.dateMs - iEvent.timestamp),
        );
        if (score > bestScore) {
          bestScore = score;
          bestIdx = ii;
        }
      }
    }

    if (bestIdx >= 0) {
      matchedKoinlyIndices.add(ki);
      matchedInternalIndices.add(bestIdx);
      matched.push({
        koinly: kRow,
        internal: internalEvents[bestIdx],
        matchMethod: 'tx_hash',
        timestampDeltaMs: Math.abs(kRow.dateMs - internalEvents[bestIdx].timestamp),
        discrepancies: checkDiscrepancies(kRow, internalEvents[bestIdx]),
      });
    }
  }

  // Pass 2: timestamp ± 5 min + compatible type + amount/symbol scoring
  for (let ki = 0; ki < koinlyRows.length; ki++) {
    if (matchedKoinlyIndices.has(ki)) continue;
    const kRow = koinlyRows[ki];
    if (!isMatchableKoinlyRow(kRow)) continue;

    const compatible = compatibleKinds(kRow);

    // Collect all candidates within the time window, then pick the best by score
    let bestIdx = -1;
    let bestScore = -Infinity;

    for (let ii = 0; ii < internalEvents.length; ii++) {
      if (matchedInternalIndices.has(ii)) continue;
      const iEvent = internalEvents[ii];

      if (!compatible.includes(iEvent.kind)) continue;

      const delta = Math.abs(kRow.dateMs - iEvent.timestamp);
      if (delta > TIMESTAMP_TOLERANCE_MS) continue;

      const score = computeMatchScore(kRow, iEvent, delta);
      if (score > bestScore) {
        bestScore = score;
        bestIdx = ii;
      }
    }

    // Require a minimum score to accept a match — prevents low-confidence pairings
    if (bestIdx >= 0 && bestScore > 0) {
      matchedKoinlyIndices.add(ki);
      matchedInternalIndices.add(bestIdx);
      matched.push({
        koinly: kRow,
        internal: internalEvents[bestIdx],
        matchMethod: 'timestamp_type',
        timestampDeltaMs: Math.abs(kRow.dateMs - internalEvents[bestIdx].timestamp),
        discrepancies: checkDiscrepancies(kRow, internalEvents[bestIdx]),
      });
    }
  }

  const unmatchedKoinly = koinlyRows.filter((_, i) => !matchedKoinlyIndices.has(i));
  const unmatchedInternal = internalEvents.filter(
    (e, i) => !matchedInternalIndices.has(i) && isWalletVisibleInternal(e),
  );

  return { matched, unmatchedKoinly, unmatchedInternal };
}

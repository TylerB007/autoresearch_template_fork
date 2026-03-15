/**
 * Analytics data integrity checks — shared logic used by:
 *   - src/analytics/integrity.test.ts  (Vitest assertions)
 *   - src/server/routes/integrity.ts   (API endpoint / dashboard)
 *
 * Each check returns an IntegrityCheck result with pass/fail status,
 * a count of violations, and up to 10 example violation strings.
 */

import { queryAllChainSnapshots, queryAllChainRebalances } from './storage.js';
import type { PositionSnapshot, RebalanceAnalytics } from './types.js';

// ── Types ─────────────────────────────────────────────────────────────────────

export type CheckStatus = 'pass' | 'fail' | 'warn' | 'skip';

export interface IntegrityCheck {
  name: string;
  category: 'snapshot' | 'rebalance';
  status: CheckStatus;
  violations: number;
  /** Up to 10 example violation descriptions */
  examples: string[];
  /** Human-readable description of what this check validates */
  description: string;
}

export interface IntegrityReport {
  ranAt: number;
  analyticsPath: string;
  lookbackDays: number;
  snapshotsChecked: number;
  rebalancesChecked: number;
  durationMs: number;
  summary: {
    passed: number;
    failed: number;
    warned: number;
    skipped: number;
  };
  checks: IntegrityCheck[];
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function sid(s: PositionSnapshot): string {
  return `tokenId=${s.tokenId} @ ${new Date(s.timestamp).toISOString()}`;
}

function rid(r: RebalanceAnalytics): string {
  return `${r.rebalanceId.slice(0, 8)} oldToken=${r.oldTokenId} @ ${new Date(r.timestamp).toISOString()}`;
}

function isFiniteNum(v: unknown): boolean {
  if (v === undefined || v === null) return true;
  if (typeof v === 'number') return isFinite(v);
  return true;
}

function makeCheck(
  name: string,
  category: IntegrityCheck['category'],
  description: string,
  items: string[],
  warnOnly = false,
): IntegrityCheck {
  const status: CheckStatus =
    items.length === 0 ? 'pass' : warnOnly ? 'warn' : 'fail';
  return {
    name,
    category,
    description,
    status,
    violations: items.length,
    examples: items.slice(0, 10),
  };
}

// ── Snapshot Checks ───────────────────────────────────────────────────────────

// v2.8.0 deployment date — records written after this timestamp must have price fields.
// Pre-cutoff records are grandfathered: the old collector omitted price fields when
// DexScreener failed instead of writing 0 (the current convention).
const V2_8_CUTOFF_MS = new Date('2026-03-06T00:00:00Z').getTime();

function checkSnapshotRequiredFields(snapshots: PositionSnapshot[]): IntegrityCheck {
  const structural: (keyof PositionSnapshot)[] = [
    'timestamp', 'tokenId', 'liquidity', 'tickLower', 'tickUpper',
    'amount0', 'amount1', 'currentTick', 'sqrtPriceX96', 'poolLiquidity',
    'isInRange', 'tickDistance', 'tokensOwed0', 'tokensOwed1',
    'token0Symbol', 'token1Symbol', 'token0Decimals', 'token1Decimals', 'poolFee',
  ];
  // Price fields are foundational — without them, P&L, position value, and fee metrics
  // are all untrustworthy. Enforced as hard failures for all post-v2.8.0 records.
  const priceFields: (keyof PositionSnapshot)[] = [
    'priceUsd0', 'priceUsd1', 'nativePriceUsd', 'positionValueUsd', 'unclaimedFeesUsd',
  ];
  const items: string[] = [];
  for (const s of snapshots) {
    const missingStructural = structural.filter((f) => s[f] === undefined || s[f] === null);
    const missingPrice = s.timestamp >= V2_8_CUTOFF_MS
      ? priceFields.filter((f) => s[f] === undefined || s[f] === null)
      : [];
    const missing = [...missingStructural, ...missingPrice];
    if (missing.length > 0) items.push(`${sid(s)}: missing [${missing.join(', ')}]`);
  }
  return makeCheck(
    'Required fields present',
    'snapshot',
    'All required PositionSnapshot fields must be populated. Price fields (priceUsd0/1, nativePriceUsd, positionValueUsd, unclaimedFeesUsd) are enforced for records written after v2.8.0 (2026-03-06) — pre-cutoff records are grandfathered. Price data is foundational: without it, all USD analytics are untrustworthy.',
    items,
  );
}

function checkSnapshotNaN(snapshots: PositionSnapshot[]): IntegrityCheck {
  const numericFields: (keyof PositionSnapshot)[] = [
    'priceUsd0', 'priceUsd1', 'nativePriceUsd', 'positionValueUsd', 'unclaimedFeesUsd',
    'priceRatio', 'distanceToLowerPct', 'distanceToUpperPct',
    'poolTvlUsd', 'poolVolume24hUsd', 'poolFeeRate', 'volumeToTvlRatio',
    'sigma7d', 'sigma30d', 'volatilityRatio', 'minPlRate', 'profitabilityMargin',
    'effectiveAprPct', 'timeInRangePct', 'hodlValueUsd', 'unrealizedIlPct',
    'lpReturnPct', 'hodlReturnPct', 'lpVsHodlPct',
    'cumulativeFeesUsd', 'cumulativeGasCostUsd', 'cumulativeTotalCostUsd', 'netPnlUsd',
  ];
  const items: string[] = [];
  for (const s of snapshots) {
    for (const f of numericFields) {
      const v = s[f];
      if (!isFiniteNum(v)) items.push(`${sid(s)}: field "${f}" = ${v}`);
    }
  }
  return makeCheck(
    'No NaN / Infinity in numeric fields',
    'snapshot',
    'Floating-point overflow or 0/0 division leaves NaN or Infinity in stored records, corrupting downstream calculations.',
    items,
  );
}

function checkIsInRangeAlignment(snapshots: PositionSnapshot[]): IntegrityCheck {
  const items: string[] = [];
  for (const s of snapshots) {
    const expected = s.currentTick >= s.tickLower && s.currentTick < s.tickUpper;
    if (s.isInRange !== expected) {
      items.push(
        `${sid(s)}: isInRange=${s.isInRange} but tick=${s.currentTick} range=[${s.tickLower},${s.tickUpper})`,
      );
    }
  }
  return makeCheck(
    'isInRange matches tick position',
    'snapshot',
    'The isInRange flag must equal (tickLower <= currentTick < tickUpper). A mismatch means the flag was set incorrectly.',
    items,
  );
}

function checkTickOrdering(snapshots: PositionSnapshot[]): IntegrityCheck {
  const items: string[] = [];
  for (const s of snapshots) {
    if (s.tickLower >= s.tickUpper) {
      items.push(`${sid(s)}: tickLower=${s.tickLower} >= tickUpper=${s.tickUpper}`);
    }
  }
  return makeCheck(
    'tickLower < tickUpper',
    'snapshot',
    'V3 positions require tickLower strictly less than tickUpper. An inverted range indicates a storage or computation error.',
    items,
  );
}

function checkDataStaleFlag(snapshots: PositionSnapshot[]): IntegrityCheck {
  const items: string[] = [];
  for (const s of snapshots) {
    if (s.priceUsd0 === 0 && s.priceUsd1 === 0 && s.dataStale !== true) {
      items.push(`${sid(s)}: both prices=0 but dataStale=${s.dataStale}`);
    }
  }
  return makeCheck(
    'dataStale flag set when prices are 0',
    'snapshot',
    'When both token USD prices are 0 (DexScreener failure), dataStale must be true so consumers know not to trust the USD values.',
    items,
  );
}

function checkPriceStatus(snapshots: PositionSnapshot[]): IntegrityCheck {
  const items: string[] = [];
  for (const s of snapshots) {
    if (s.priceStatus === 'live' && s.priceUsd0 === 0 && s.priceUsd1 === 0) {
      items.push(`${sid(s)}: priceStatus='live' but both prices=0`);
    }
    if (s.priceStatus === 'permanently_missing' && (s.priceUsd0 !== 0 || s.priceUsd1 !== 0)) {
      items.push(`${sid(s)}: priceStatus='permanently_missing' but prices=${s.priceUsd0}/${s.priceUsd1}`);
    }
  }
  return makeCheck(
    'priceStatus consistent with price values',
    'snapshot',
    "A 'live' status with zero prices, or 'permanently_missing' with non-zero prices, indicates the status field was not updated correctly.",
    items,
  );
}

function checkPositionValueRange(snapshots: PositionSnapshot[]): IntegrityCheck {
  const items: string[] = [];
  for (const s of snapshots) {
    if (s.positionValueUsd < 0 || s.positionValueUsd > 10_000_000) {
      items.push(`${sid(s)}: positionValueUsd=${s.positionValueUsd.toFixed(2)}`);
    }
  }
  return makeCheck(
    'positionValueUsd in plausible range ($0–$10M)',
    'snapshot',
    'Values outside $0–$10M likely indicate a decimal scaling error (e.g., 8-decimal token treated as 18-decimal).',
    items,
  );
}

function checkFeesVsValue(snapshots: PositionSnapshot[]): IntegrityCheck {
  const items: string[] = [];
  for (const s of snapshots) {
    if (s.positionValueUsd > 0 && s.unclaimedFeesUsd > s.positionValueUsd * 1.01) {
      items.push(
        `${sid(s)}: unclaimedFeesUsd=${s.unclaimedFeesUsd.toFixed(2)} > positionValueUsd=${s.positionValueUsd.toFixed(2)}`,
      );
    }
  }
  return makeCheck(
    'unclaimedFeesUsd <= positionValueUsd',
    'snapshot',
    'Unclaimed fees should not exceed the total position value. If they do, the fee accrual or price calculation is wrong.',
    items,
  );
}

function checkTokenAmounts(snapshots: PositionSnapshot[]): IntegrityCheck {
  const items: string[] = [];
  for (const s of snapshots) {
    if (s.amount0 < 0n || s.amount1 < 0n || s.tokensOwed0 < 0n || s.tokensOwed1 < 0n) {
      items.push(
        `${sid(s)}: amount0=${s.amount0} amount1=${s.amount1} owed0=${s.tokensOwed0} owed1=${s.tokensOwed1}`,
      );
    }
  }
  return makeCheck(
    'Token amounts non-negative',
    'snapshot',
    'On-chain token amounts are always unsigned. Negative values indicate a BigInt deserialization or arithmetic error.',
    items,
  );
}

function checkTokenDecimals(snapshots: PositionSnapshot[]): IntegrityCheck {
  const items: string[] = [];
  for (const s of snapshots) {
    if (s.token0Decimals < 0 || s.token0Decimals > 18 || s.token1Decimals < 0 || s.token1Decimals > 18) {
      items.push(`${sid(s)}: token0Decimals=${s.token0Decimals} token1Decimals=${s.token1Decimals}`);
    }
  }
  return makeCheck(
    'Token decimals in valid ERC-20 range (0–18)',
    'snapshot',
    'ERC-20 decimals are always 0–18. Out-of-range values mean the token info RPC call failed or returned garbage.',
    items,
  );
}

function checkSigmaValues(snapshots: PositionSnapshot[]): IntegrityCheck {
  const items: string[] = [];
  for (const s of snapshots) {
    if (s.sigma7d !== undefined && s.sigma7d <= 0) items.push(`${sid(s)}: sigma7d=${s.sigma7d}`);
    if (s.sigma30d !== undefined && s.sigma30d <= 0) items.push(`${sid(s)}: sigma30d=${s.sigma30d}`);
    if (s.sigma7d !== undefined && s.sigma7d > 10) items.push(`${sid(s)}: sigma7d=${s.sigma7d.toFixed(3)} (>1000% annualized)`);
    if (s.sigma30d !== undefined && s.sigma30d > 10) items.push(`${sid(s)}: sigma30d=${s.sigma30d.toFixed(3)} (>1000% annualized)`);
  }
  return makeCheck(
    'Sigma values positive and plausible',
    'snapshot',
    'Annualized volatility (sigma) must be > 0. Values above 1000% (sigma > 10) are implausible and likely a computation error.',
    items,
  );
}

function checkVolatilityRatio(snapshots: PositionSnapshot[]): IntegrityCheck {
  const items: string[] = [];
  for (const s of snapshots) {
    if (s.volatilityRatio !== undefined && s.sigma7d !== undefined && s.sigma30d !== undefined && s.sigma30d > 0) {
      const expected = s.sigma7d / s.sigma30d;
      const error = Math.abs(s.volatilityRatio - expected) / expected;
      if (error > 0.01) {
        items.push(
          `${sid(s)}: volatilityRatio=${s.volatilityRatio.toFixed(4)} but sigma7d/sigma30d=${expected.toFixed(4)}`,
        );
      }
    }
  }
  return makeCheck(
    'volatilityRatio consistent with sigma7d/sigma30d',
    'snapshot',
    'volatilityRatio must equal sigma7d/sigma30d within 1%. A mismatch means the ratio was computed from stale or mismatched sigma values.',
    items,
  );
}

function checkProfitabilityViable(snapshots: PositionSnapshot[]): IntegrityCheck {
  const items: string[] = [];
  for (const s of snapshots) {
    if (s.profitabilityViable !== undefined && s.poolFeeRate !== undefined && s.minPlRate !== undefined) {
      const expected = s.poolFeeRate > s.minPlRate;
      if (s.profitabilityViable !== expected) {
        items.push(
          `${sid(s)}: profitabilityViable=${s.profitabilityViable} but feeRate=${s.poolFeeRate.toFixed(4)} vs minPlRate=${s.minPlRate.toFixed(4)}`,
        );
      }
    }
  }
  return makeCheck(
    'profitabilityViable flag consistent with fee/PL rates',
    'snapshot',
    'profitabilityViable must equal (poolFeeRate > minPlRate). Inconsistency means the flag was stored from a different snapshot than the rates.',
    items,
  );
}

// ── Rebalance Checks ──────────────────────────────────────────────────────────

function checkRebalanceRequiredFields(rebalances: RebalanceAnalytics[]): IntegrityCheck {
  const required: (keyof RebalanceAnalytics)[] = [
    'timestamp', 'rebalanceId', 'oldTokenId', 'newTokenId', 'strategy',
    'preSnapshot', 'postSnapshot', 'txHashes',
    'feesCollected0', 'feesCollected1',
    'liquidityRemoved0', 'liquidityRemoved1',
    'newLiquidity', 'newAmount0', 'newAmount1',
    'newTickLower', 'newTickUpper',
    'gasUsed', 'gasPrice', 'totalGasCostPLS',
    'metrics',
  ];
  const items: string[] = [];
  for (const r of rebalances) {
    const missing = required.filter((f) => r[f] === undefined || r[f] === null);
    if (missing.length > 0) items.push(`${rid(r)}: missing [${missing.join(', ')}]`);
  }
  return makeCheck(
    'Required fields present',
    'rebalance',
    'All non-optional RebalanceAnalytics fields must be populated on every record.',
    items,
  );
}

function checkRebalanceMetricsNaN(rebalances: RebalanceAnalytics[]): IntegrityCheck {
  const metricKeys = [
    'durationSeconds', 'durationDays', 'feeAPR', 'rawFeeYieldPercent',
    'capitalEfficiencyRatio', 'timeInRangePercent', 'feesToCostRatio',
    'impermanentLossPercent', 'netROIPercent', 'trueNetROIPercent',
    'rebalanceCostPercent', 'rebalanceCostToken0',
  ] as const;
  const items: string[] = [];
  for (const r of rebalances) {
    if (!r.metrics) continue;
    for (const f of metricKeys) {
      if (!isFiniteNum(r.metrics[f])) items.push(`${rid(r)}: metrics.${f} = ${r.metrics[f]}`);
    }
    for (const f of ['feesCollectedUsd', 'gasCostUsd', 'swapFrictionUsd', 'totalGasCostPLS'] as const) {
      if (!isFiniteNum(r[f])) items.push(`${rid(r)}: ${f} = ${r[f]}`);
    }
  }
  return makeCheck(
    'No NaN / Infinity in metrics',
    'rebalance',
    'NaN or Infinity in computed metrics corrupts CSV exports, portfolio summaries, and break-even calculations.',
    items,
  );
}

function checkNewTickOrdering(rebalances: RebalanceAnalytics[]): IntegrityCheck {
  const items: string[] = [];
  for (const r of rebalances) {
    if (r.newTickLower >= r.newTickUpper) {
      items.push(`${rid(r)}: newTickLower=${r.newTickLower} >= newTickUpper=${r.newTickUpper}`);
    }
  }
  return makeCheck(
    'newTickLower < newTickUpper',
    'rebalance',
    'The new position range must have tickLower strictly less than tickUpper.',
    items,
  );
}

function checkTokenTransition(rebalances: RebalanceAnalytics[]): IntegrityCheck {
  const items: string[] = [];
  for (const r of rebalances) {
    if (r.oldTokenId === r.newTokenId) {
      items.push(`${rid(r)}: oldTokenId === newTokenId = ${r.oldTokenId}`);
    }
  }
  return makeCheck(
    'oldTokenId != newTokenId',
    'rebalance',
    'A rebalance burns the old NFT and mints a new one. Equal IDs mean no mint occurred — the record is incomplete.',
    items,
  );
}

function checkFeesCollectedUsd(rebalances: RebalanceAnalytics[]): IntegrityCheck {
  const items: string[] = [];
  for (const r of rebalances) {
    const hasPrices = (r.priceUsd0 ?? 0) > 0 && (r.priceUsd1 ?? 0) > 0;
    const hasNonZeroFees = r.feesCollected0 > 0n || r.feesCollected1 > 0n;
    if (hasPrices && hasNonZeroFees && r.feesCollectedUsd === undefined) {
      items.push(`${rid(r)}: prices available (${r.priceUsd0}/${r.priceUsd1}) but feesCollectedUsd=undefined`);
    }
  }
  return makeCheck(
    'feesCollectedUsd populated when prices available',
    'rebalance',
    'When both token prices are available and fees were collected, feesCollectedUsd must be computed. Missing values create gaps in earnings tracking.',
    items,
  );
}

function checkGasCostUsd(rebalances: RebalanceAnalytics[]): IntegrityCheck {
  const items: string[] = [];
  for (const r of rebalances) {
    if ((r.nativeTokenPriceUsd ?? 0) > 0 && r.gasCostUsd === undefined) {
      items.push(`${rid(r)}: nativeTokenPriceUsd=${r.nativeTokenPriceUsd} but gasCostUsd=undefined`);
    }
  }
  return makeCheck(
    'gasCostUsd populated when native price available',
    'rebalance',
    'When the native token price is known, gas cost must be converted to USD. Missing values make cost-benefit analysis inaccurate.',
    items,
  );
}

function checkFeeAPR(rebalances: RebalanceAnalytics[]): IntegrityCheck {
  const items: string[] = [];
  for (const r of rebalances) {
    const apr = r.metrics?.feeAPR ?? 0;
    if (apr < 0 || apr > 10_000) items.push(`${rid(r)}: metrics.feeAPR=${apr.toFixed(2)}`);
  }
  return makeCheck(
    'metrics.feeAPR in sane range (0–10,000%)',
    'rebalance',
    'Fee APR above 10,000% or below 0% indicates a computation error in the metrics calculator.',
    items,
  );
}

function checkDurationDays(rebalances: RebalanceAnalytics[]): IntegrityCheck {
  const items: string[] = [];
  for (const r of rebalances) {
    const days = r.metrics?.durationDays ?? 0;
    if (days <= 0) items.push(`${rid(r)}: metrics.durationDays=${days}`);
  }
  return makeCheck(
    'metrics.durationDays > 0',
    'rebalance',
    'Every rebalance epoch must have a positive duration. Zero duration means two rebalances were recorded at the same timestamp.',
    items,
  );
}

function checkPreSnapshotTokenId(rebalances: RebalanceAnalytics[]): IntegrityCheck {
  const items: string[] = [];
  for (const r of rebalances) {
    if (r.preSnapshot?.tokenId !== r.oldTokenId) {
      items.push(
        `${rid(r)}: preSnapshot.tokenId=${r.preSnapshot?.tokenId} !== oldTokenId=${r.oldTokenId}`,
      );
    }
  }
  return makeCheck(
    'preSnapshot.tokenId matches oldTokenId',
    'rebalance',
    "The pre-rebalance snapshot must belong to the position being rebalanced. A mismatch means a snapshot from the wrong position was attached.",
    items,
  );
}

function checkTxHashes(rebalances: RebalanceAnalytics[]): IntegrityCheck {
  const hexRe = /^0x[0-9a-fA-F]{64}$/;
  const items: string[] = [];
  for (const r of rebalances) {
    if (!r.txHashes) continue;
    for (const [key, value] of Object.entries(r.txHashes)) {
      if (key === 'swap' && value === undefined) continue;
      if (typeof value === 'string' && !hexRe.test(value)) {
        items.push(`${rid(r)}: txHashes.${key}="${value}"`);
      }
    }
  }
  return makeCheck(
    'Transaction hashes are valid 32-byte hex',
    'rebalance',
    'All transaction hashes must be 0x-prefixed 64-character hex strings. Invalid hashes prevent block explorer lookups.',
    items,
  );
}

function checkRetrospectiveBackfill(rebalances: RebalanceAnalytics[]): IntegrityCheck {
  const sevenDaysAgo = Date.now() - 7 * 86400 * 1000;
  const old = rebalances.filter((r) => r.timestamp < sevenDaysAgo);
  if (old.length === 0) {
    return { name: 'Retrospective backfill coverage', category: 'rebalance', status: 'skip', violations: 0, examples: [], description: 'No rebalances older than 7 days in the lookback window.' };
  }
  const items: string[] = [];
  for (const r of old) {
    if (r.feesEarned7dUsd === undefined && r.retrospectiveUpdatedAt === undefined) {
      items.push(`${rid(r)}: no retrospective backfill`);
    }
  }
  const pct = Math.round((items.length / old.length) * 100);
  const warnOnly = items.length <= Math.ceil(old.length * 0.5);
  const check = makeCheck(
    'Retrospective backfill coverage',
    'rebalance',
    'Rebalances older than 7 days must have feesEarned7dUsd and retrospectiveUpdatedAt populated by the background backfill job.',
    items,
    warnOnly,
  );
  if (items.length > 0) {
    check.examples = [`${items.length}/${old.length} (${pct}%) old rebalances missing backfill`, ...check.examples.slice(0, 9)];
  }
  return check;
}

// ── Runner ────────────────────────────────────────────────────────────────────

export async function runIntegrityChecks(
  analyticsPath: string,
  lookbackDays = 30,
): Promise<IntegrityReport> {
  const start = Date.now();
  const startTime = start - lookbackDays * 86400 * 1000;

  let snapshots: PositionSnapshot[] = [];
  let rebalances: RebalanceAnalytics[] = [];

  try {
    [snapshots, rebalances] = await Promise.all([
      queryAllChainSnapshots(analyticsPath, undefined, startTime),
      queryAllChainRebalances(analyticsPath, startTime),
    ]);
  } catch {
    // Storage path may not exist — return empty report
  }

  const checks: IntegrityCheck[] = [];

  if (snapshots.length > 0) {
    checks.push(
      checkSnapshotRequiredFields(snapshots),
      checkSnapshotNaN(snapshots),
      checkIsInRangeAlignment(snapshots),
      checkTickOrdering(snapshots),
      checkDataStaleFlag(snapshots),
      checkPriceStatus(snapshots),
      checkPositionValueRange(snapshots),
      checkFeesVsValue(snapshots),
      checkTokenAmounts(snapshots),
      checkTokenDecimals(snapshots),
      checkSigmaValues(snapshots),
      checkVolatilityRatio(snapshots),
      checkProfitabilityViable(snapshots),
    );
  }

  if (rebalances.length > 0) {
    checks.push(
      checkRebalanceRequiredFields(rebalances),
      checkRebalanceMetricsNaN(rebalances),
      checkNewTickOrdering(rebalances),
      checkTokenTransition(rebalances),
      checkFeesCollectedUsd(rebalances),
      checkGasCostUsd(rebalances),
      checkFeeAPR(rebalances),
      checkDurationDays(rebalances),
      checkPreSnapshotTokenId(rebalances),
      checkTxHashes(rebalances),
      checkRetrospectiveBackfill(rebalances),
    );
  }

  const summary = {
    passed: checks.filter((c) => c.status === 'pass').length,
    failed: checks.filter((c) => c.status === 'fail').length,
    warned: checks.filter((c) => c.status === 'warn').length,
    skipped: checks.filter((c) => c.status === 'skip').length,
  };

  return {
    ranAt: start,
    analyticsPath,
    lookbackDays,
    snapshotsChecked: snapshots.length,
    rebalancesChecked: rebalances.length,
    durationMs: Date.now() - start,
    summary,
    checks,
  };
}

/**
 * Analytics Data Integrity Test Suite
 *
 * Mode 1 — Structural Audit (always runs):
 *   Reads real stored JSONL files and validates every field for presence,
 *   type, plausible range, and internal self-consistency. Zero RPC calls.
 *
 * Mode 2 — On-Chain Spot-Check (opt-in):
 *   Fetches live state from the RPC for each active position and cross-validates
 *   it against the most recent stored snapshot.
 *   Enable with:  RUN_ONCHAIN=1 npx vitest run src/analytics/integrity.test.ts
 *
 * Run structural audit:  npx vitest run src/analytics/integrity.test.ts
 * Run both modes:        RUN_ONCHAIN=1 npx vitest run src/analytics/integrity.test.ts
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { existsSync } from 'node:fs';
import { ethers } from 'ethers';
import { queryAllChainSnapshots, queryAllChainRebalances } from './storage.js';
import type { PositionSnapshot, RebalanceAnalytics } from './types.js';

// ── Configuration ─────────────────────────────────────────────────────────────

const ANALYTICS_PATH = process.env.ANALYTICS_PATH ?? './analytics';
const LOOKBACK_DAYS = parseInt(process.env.INTEGRITY_LOOKBACK_DAYS ?? '30', 10);
const START_TIME = Date.now() - LOOKBACK_DAYS * 86400 * 1000;
const SEVEN_DAYS_MS = 7 * 86400 * 1000;
const FIVE_MINUTES_MS = 5 * 60 * 1000;

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Format a list of violations into a readable assertion message. */
function fmt(label: string, items: string[]): string {
  if (items.length === 0) return '';
  const preview = items.slice(0, 10).join('\n  ');
  const overflow = items.length > 10 ? `\n  ...and ${items.length - 10} more` : '';
  return `${label} — ${items.length} violation(s):\n  ${preview}${overflow}`;
}

function snapshotId(s: PositionSnapshot): string {
  return `tokenId=${s.tokenId} @ ${new Date(s.timestamp).toISOString()}`;
}

function rebalanceId(r: RebalanceAnalytics): string {
  return `${r.rebalanceId} oldToken=${r.oldTokenId} @ ${new Date(r.timestamp).toISOString()}`;
}

function isFiniteOrUndefined(v: unknown): boolean {
  if (v === undefined || v === null) return true;
  if (typeof v === 'number') return isFinite(v);
  return true;
}

// ── Data Load ─────────────────────────────────────────────────────────────────

let snapshots: PositionSnapshot[] = [];
let rebalances: RebalanceAnalytics[] = [];
let analyticsFound = false;

async function loadData(): Promise<void> {
  analyticsFound = existsSync(ANALYTICS_PATH);
  if (!analyticsFound) return;
  [snapshots, rebalances] = await Promise.all([
    queryAllChainSnapshots(ANALYTICS_PATH, undefined, START_TIME),
    queryAllChainRebalances(ANALYTICS_PATH, START_TIME),
  ]);
}

// ── STRUCTURAL AUDIT — Snapshots ─────────────────────────────────────────────

describe('Structural Audit — Snapshots', () => {
  beforeAll(async () => {
    await loadData();
  });

  it('analytics directory exists and contains snapshots', () => {
    if (!analyticsFound) {
      console.warn(`SKIP: analytics directory not found at "${ANALYTICS_PATH}". Run on VPS or set ANALYTICS_PATH env var.`);
      return; // Soft skip — no analytics locally is expected
    }
    if (snapshots.length === 0) {
      console.warn(`WARN: analytics directory found but no snapshots in the last ${LOOKBACK_DAYS} days.`);
    }
    // Not a hard failure — directory may exist but bot may not have run recently
  });

  it('required fields present on every snapshot', () => {
    if (!analyticsFound || snapshots.length === 0) return;
    // v2.8.0 cutoff: price fields are enforced only for records written after deployment.
    // Pre-cutoff records are grandfathered — the old collector omitted price fields when
    // DexScreener failed instead of writing 0 (the current convention).
    const V2_8_CUTOFF_MS = new Date('2026-03-06T00:00:00Z').getTime();
    const structural: (keyof PositionSnapshot)[] = [
      'timestamp', 'tokenId', 'liquidity', 'tickLower', 'tickUpper',
      'amount0', 'amount1', 'currentTick', 'sqrtPriceX96', 'poolLiquidity',
      'isInRange', 'tickDistance', 'tokensOwed0', 'tokensOwed1',
      'token0Symbol', 'token1Symbol', 'token0Decimals', 'token1Decimals', 'poolFee',
    ];
    const priceFields: (keyof PositionSnapshot)[] = [
      'priceUsd0', 'priceUsd1', 'nativePriceUsd', 'positionValueUsd', 'unclaimedFeesUsd',
    ];
    const violations: string[] = [];
    for (const s of snapshots) {
      const missingStructural = structural.filter((f) => s[f] === undefined || s[f] === null);
      const missingPrice = s.timestamp >= V2_8_CUTOFF_MS
        ? priceFields.filter((f) => s[f] === undefined || s[f] === null)
        : [];
      const missing = [...missingStructural, ...missingPrice];
      if (missing.length > 0) {
        violations.push(`${snapshotId(s)}: missing [${missing.join(', ')}]`);
      }
    }
    expect(violations, fmt('Missing required snapshot fields', violations)).toHaveLength(0);
  });

  it('no NaN or Infinity in numeric fields', () => {
    if (!analyticsFound || snapshots.length === 0) return;
    const numericFields: (keyof PositionSnapshot)[] = [
      'priceUsd0', 'priceUsd1', 'nativePriceUsd', 'positionValueUsd', 'unclaimedFeesUsd',
      'priceRatio', 'distanceToLowerPct', 'distanceToUpperPct',
      'poolTvlUsd', 'poolVolume24hUsd', 'poolFeeRate', 'volumeToTvlRatio',
      'sigma7d', 'sigma30d', 'volatilityRatio', 'minPlRate', 'profitabilityMargin',
      'effectiveAprPct', 'timeInRangePct', 'hodlValueUsd', 'unrealizedIlPct',
      'lpReturnPct', 'hodlReturnPct', 'lpVsHodlPct',
      'cumulativeFeesUsd', 'cumulativeGasCostUsd', 'cumulativeTotalCostUsd', 'netPnlUsd',
    ];
    const violations: string[] = [];
    for (const s of snapshots) {
      for (const f of numericFields) {
        const v = s[f];
        if (!isFiniteOrUndefined(v)) {
          violations.push(`${snapshotId(s)}: field "${f}" = ${v}`);
        }
      }
    }
    expect(violations, fmt('NaN/Infinity in snapshot numeric fields', violations)).toHaveLength(0);
  });

  it('isInRange matches currentTick vs tickLower/tickUpper', () => {
    if (!analyticsFound || snapshots.length === 0) return;
    const violations: string[] = [];
    for (const s of snapshots) {
      const expectedInRange = s.currentTick >= s.tickLower && s.currentTick < s.tickUpper;
      if (s.isInRange !== expectedInRange) {
        violations.push(
          `${snapshotId(s)}: isInRange=${s.isInRange} but tick=${s.currentTick} range=[${s.tickLower},${s.tickUpper})`,
        );
      }
    }
    expect(violations, fmt('isInRange flag mismatch', violations)).toHaveLength(0);
  });

  it('tickLower < tickUpper on every snapshot', () => {
    if (!analyticsFound || snapshots.length === 0) return;
    const violations: string[] = [];
    for (const s of snapshots) {
      if (s.tickLower >= s.tickUpper) {
        violations.push(`${snapshotId(s)}: tickLower=${s.tickLower} >= tickUpper=${s.tickUpper}`);
      }
    }
    expect(violations, fmt('Inverted tick range in snapshot', violations)).toHaveLength(0);
  });

  it('dataStale flag set when both USD prices are 0', () => {
    if (!analyticsFound || snapshots.length === 0) return;
    const violations: string[] = [];
    for (const s of snapshots) {
      if (s.priceUsd0 === 0 && s.priceUsd1 === 0 && s.dataStale !== true) {
        violations.push(`${snapshotId(s)}: both prices=0 but dataStale=${s.dataStale}`);
      }
    }
    expect(violations, fmt('dataStale not set when prices are 0', violations)).toHaveLength(0);
  });

  it('priceStatus consistent with actual price values', () => {
    if (!analyticsFound || snapshots.length === 0) return;
    const violations: string[] = [];
    for (const s of snapshots) {
      // 'live' status implies prices were actually fetched — should not be 0
      if (s.priceStatus === 'live' && s.priceUsd0 === 0 && s.priceUsd1 === 0) {
        violations.push(`${snapshotId(s)}: priceStatus='live' but both prices=0`);
      }
      // 'permanently_missing' implies we gave up — should be 0
      if (s.priceStatus === 'permanently_missing' && (s.priceUsd0 !== 0 || s.priceUsd1 !== 0)) {
        violations.push(`${snapshotId(s)}: priceStatus='permanently_missing' but prices=${s.priceUsd0}/${s.priceUsd1}`);
      }
    }
    expect(violations, fmt('priceStatus/price value mismatch', violations)).toHaveLength(0);
  });

  it('positionValueUsd in plausible range ($0 – $10M)', () => {
    if (!analyticsFound || snapshots.length === 0) return;
    const violations: string[] = [];
    for (const s of snapshots) {
      if (s.positionValueUsd < 0 || s.positionValueUsd > 10_000_000) {
        violations.push(`${snapshotId(s)}: positionValueUsd=${s.positionValueUsd}`);
      }
    }
    expect(violations, fmt('positionValueUsd out of plausible range', violations)).toHaveLength(0);
  });

  it('unclaimedFeesUsd <= positionValueUsd (fees cannot exceed position value)', () => {
    if (!analyticsFound || snapshots.length === 0) return;
    const violations: string[] = [];
    for (const s of snapshots) {
      // Only check when prices are non-zero (otherwise both values are meaningfully 0)
      if (s.positionValueUsd > 0 && s.unclaimedFeesUsd > s.positionValueUsd * 1.01) {
        violations.push(
          `${snapshotId(s)}: unclaimedFeesUsd=${s.unclaimedFeesUsd} > positionValueUsd=${s.positionValueUsd}`,
        );
      }
    }
    expect(violations, fmt('Unclaimed fees exceed position value', violations)).toHaveLength(0);
  });

  it('token amounts are non-negative', () => {
    if (!analyticsFound || snapshots.length === 0) return;
    const violations: string[] = [];
    for (const s of snapshots) {
      if (s.amount0 < 0n || s.amount1 < 0n || s.tokensOwed0 < 0n || s.tokensOwed1 < 0n) {
        violations.push(
          `${snapshotId(s)}: amount0=${s.amount0} amount1=${s.amount1} owed0=${s.tokensOwed0} owed1=${s.tokensOwed1}`,
        );
      }
    }
    expect(violations, fmt('Negative token amounts in snapshot', violations)).toHaveLength(0);
  });

  it('token decimals in valid ERC-20 range (0–18)', () => {
    if (!analyticsFound || snapshots.length === 0) return;
    const violations: string[] = [];
    for (const s of snapshots) {
      if (s.token0Decimals < 0 || s.token0Decimals > 18 || s.token1Decimals < 0 || s.token1Decimals > 18) {
        violations.push(
          `${snapshotId(s)}: token0Decimals=${s.token0Decimals} token1Decimals=${s.token1Decimals}`,
        );
      }
    }
    expect(violations, fmt('Token decimals out of ERC-20 range', violations)).toHaveLength(0);
  });

  it('sigma7d and sigma30d are positive when present', () => {
    if (!analyticsFound || snapshots.length === 0) return;
    const violations: string[] = [];
    for (const s of snapshots) {
      if (s.sigma7d !== undefined && s.sigma7d <= 0) {
        violations.push(`${snapshotId(s)}: sigma7d=${s.sigma7d}`);
      }
      if (s.sigma30d !== undefined && s.sigma30d <= 0) {
        violations.push(`${snapshotId(s)}: sigma30d=${s.sigma30d}`);
      }
      // Sanity cap — annualized volatility above 1000% is almost certainly wrong
      if (s.sigma7d !== undefined && s.sigma7d > 10) {
        violations.push(`${snapshotId(s)}: sigma7d=${s.sigma7d} suspiciously high (>1000% annualized)`);
      }
      if (s.sigma30d !== undefined && s.sigma30d > 10) {
        violations.push(`${snapshotId(s)}: sigma30d=${s.sigma30d} suspiciously high (>1000% annualized)`);
      }
    }
    expect(violations, fmt('Sigma values implausible', violations)).toHaveLength(0);
  });

  it('volatilityRatio consistent with sigma7d/sigma30d (within 1%)', () => {
    if (!analyticsFound || snapshots.length === 0) return;
    const violations: string[] = [];
    for (const s of snapshots) {
      if (s.volatilityRatio !== undefined && s.sigma7d !== undefined && s.sigma30d !== undefined && s.sigma30d > 0) {
        const expected = s.sigma7d / s.sigma30d;
        const error = Math.abs(s.volatilityRatio - expected) / expected;
        if (error > 0.01) {
          violations.push(
            `${snapshotId(s)}: volatilityRatio=${s.volatilityRatio} but sigma7d/sigma30d=${expected.toFixed(4)}`,
          );
        }
      }
    }
    expect(violations, fmt('volatilityRatio inconsistent with sigmas', violations)).toHaveLength(0);
  });

  it('profitabilityViable consistent with poolFeeRate vs minPlRate', () => {
    if (!analyticsFound || snapshots.length === 0) return;
    const violations: string[] = [];
    for (const s of snapshots) {
      if (s.profitabilityViable !== undefined && s.poolFeeRate !== undefined && s.minPlRate !== undefined) {
        const expectedViable = s.poolFeeRate > s.minPlRate;
        if (s.profitabilityViable !== expectedViable) {
          violations.push(
            `${snapshotId(s)}: profitabilityViable=${s.profitabilityViable} but feeRate=${s.poolFeeRate} vs minPlRate=${s.minPlRate}`,
          );
        }
      }
    }
    expect(violations, fmt('profitabilityViable flag inconsistent with fee/PL rates', violations)).toHaveLength(0);
  });
});

// ── STRUCTURAL AUDIT — Rebalances ────────────────────────────────────────────

describe('Structural Audit — Rebalances', () => {
  beforeAll(async () => {
    if (snapshots.length === 0 && rebalances.length === 0) await loadData();
  });

  it('required fields present on every rebalance', () => {
    if (!analyticsFound || rebalances.length === 0) return;
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
    const violations: string[] = [];
    for (const r of rebalances) {
      const missing = required.filter((f) => r[f] === undefined || r[f] === null);
      if (missing.length > 0) {
        violations.push(`${rebalanceId(r)}: missing [${missing.join(', ')}]`);
      }
    }
    expect(violations, fmt('Missing required rebalance fields', violations)).toHaveLength(0);
  });

  it('no NaN or Infinity in rebalance metrics', () => {
    if (!analyticsFound || rebalances.length === 0) return;
    const metricsFields = [
      'durationSeconds', 'durationDays', 'feeAPR', 'rawFeeYieldPercent',
      'capitalEfficiencyRatio', 'timeInRangePercent', 'feesToCostRatio',
      'impermanentLossPercent', 'netROIPercent', 'trueNetROIPercent',
      'rebalanceCostPercent', 'rebalanceCostToken0',
    ] as const;
    const violations: string[] = [];
    for (const r of rebalances) {
      if (!r.metrics) continue;
      for (const f of metricsFields) {
        const v = r.metrics[f];
        if (!isFiniteOrUndefined(v)) {
          violations.push(`${rebalanceId(r)}: metrics.${f} = ${v}`);
        }
      }
      // Top-level optional USD fields
      for (const f of ['feesCollectedUsd', 'gasCostUsd', 'swapFrictionUsd', 'totalGasCostPLS'] as const) {
        if (!isFiniteOrUndefined(r[f])) {
          violations.push(`${rebalanceId(r)}: ${f} = ${r[f]}`);
        }
      }
    }
    expect(violations, fmt('NaN/Infinity in rebalance metrics', violations)).toHaveLength(0);
  });

  it('newTickLower < newTickUpper', () => {
    if (!analyticsFound || rebalances.length === 0) return;
    const violations: string[] = [];
    for (const r of rebalances) {
      if (r.newTickLower >= r.newTickUpper) {
        violations.push(`${rebalanceId(r)}: newTickLower=${r.newTickLower} >= newTickUpper=${r.newTickUpper}`);
      }
    }
    expect(violations, fmt('Inverted new tick range in rebalance', violations)).toHaveLength(0);
  });

  it('oldTokenId != newTokenId (an actual mint occurred)', () => {
    if (!analyticsFound || rebalances.length === 0) return;
    const violations: string[] = [];
    for (const r of rebalances) {
      if (r.oldTokenId === r.newTokenId) {
        violations.push(`${rebalanceId(r)}: oldTokenId === newTokenId = ${r.oldTokenId}`);
      }
    }
    expect(violations, fmt('Rebalance with no token transition (same tokenId)', violations)).toHaveLength(0);
  });

  it('feesCollectedUsd populated when USD prices are available', () => {
    if (!analyticsFound || rebalances.length === 0) return;
    const violations: string[] = [];
    for (const r of rebalances) {
      const hasPrices = (r.priceUsd0 ?? 0) > 0 && (r.priceUsd1 ?? 0) > 0;
      const hasNonZeroFees = r.feesCollected0 > 0n || r.feesCollected1 > 0n;
      if (hasPrices && hasNonZeroFees && r.feesCollectedUsd === undefined) {
        violations.push(`${rebalanceId(r)}: prices available but feesCollectedUsd is undefined`);
      }
    }
    expect(violations, fmt('feesCollectedUsd missing despite prices being available', violations)).toHaveLength(0);
  });

  it('gasCostUsd populated when native token price is available', () => {
    if (!analyticsFound || rebalances.length === 0) return;
    const violations: string[] = [];
    for (const r of rebalances) {
      if ((r.nativeTokenPriceUsd ?? 0) > 0 && r.gasCostUsd === undefined) {
        violations.push(`${rebalanceId(r)}: nativeTokenPriceUsd=${r.nativeTokenPriceUsd} but gasCostUsd is undefined`);
      }
    }
    expect(violations, fmt('gasCostUsd missing despite native price available', violations)).toHaveLength(0);
  });

  it('metrics.feeAPR in sane range (0 – 10,000%)', () => {
    if (!analyticsFound || rebalances.length === 0) return;
    const violations: string[] = [];
    for (const r of rebalances) {
      const apr = r.metrics?.feeAPR ?? 0;
      if (apr < 0 || apr > 10_000) {
        violations.push(`${rebalanceId(r)}: metrics.feeAPR=${apr}`);
      }
    }
    expect(violations, fmt('feeAPR out of sane range', violations)).toHaveLength(0);
  });

  it('metrics.durationDays > 0', () => {
    if (!analyticsFound || rebalances.length === 0) return;
    const violations: string[] = [];
    for (const r of rebalances) {
      const days = r.metrics?.durationDays ?? 0;
      if (days <= 0) {
        violations.push(`${rebalanceId(r)}: metrics.durationDays=${days}`);
      }
    }
    expect(violations, fmt('Rebalance with zero or negative duration', violations)).toHaveLength(0);
  });

  it('preSnapshot.tokenId matches oldTokenId', () => {
    if (!analyticsFound || rebalances.length === 0) return;
    const violations: string[] = [];
    for (const r of rebalances) {
      if (r.preSnapshot?.tokenId !== r.oldTokenId) {
        violations.push(
          `${rebalanceId(r)}: preSnapshot.tokenId=${r.preSnapshot?.tokenId} !== oldTokenId=${r.oldTokenId}`,
        );
      }
    }
    expect(violations, fmt('preSnapshot attached to wrong tokenId', violations)).toHaveLength(0);
  });

  it('retrospective backfill populated for rebalances >7 days old', () => {
    if (!analyticsFound || rebalances.length === 0) return;
    const sevenDaysAgo = Date.now() - SEVEN_DAYS_MS;
    const old = rebalances.filter((r) => r.timestamp < sevenDaysAgo);
    if (old.length === 0) return; // no old rebalances to check

    const violations: string[] = [];
    for (const r of old) {
      if (r.feesEarned7dUsd === undefined && r.retrospectiveUpdatedAt === undefined) {
        violations.push(`${rebalanceId(r)}: no retrospective backfill (feesEarned7dUsd and retrospectiveUpdatedAt both absent)`);
      }
    }
    // Warn rather than hard-fail — background job may be genuinely behind
    if (violations.length > 0) {
      const pct = ((violations.length / old.length) * 100).toFixed(0);
      console.warn(fmt(`Retrospective backfill missing on ${pct}% of old rebalances`, violations));
    }
    // Fail only if >50% of old rebalances are missing backfill (suggests job is broken)
    const threshold = Math.ceil(old.length * 0.5);
    expect(violations.length).toBeLessThanOrEqual(threshold);
  });

  it('transaction hashes are valid hex strings', () => {
    if (!analyticsFound || rebalances.length === 0) return;
    const hexRe = /^0x[0-9a-fA-F]{64}$/;
    const violations: string[] = [];
    for (const r of rebalances) {
      const hashes = r.txHashes;
      if (!hashes) continue;
      for (const [key, value] of Object.entries(hashes)) {
        if (key === 'swap' && value === undefined) continue; // swap is optional
        if (typeof value === 'string' && !hexRe.test(value)) {
          violations.push(`${rebalanceId(r)}: txHashes.${key}="${value}" is not a valid 32-byte tx hash`);
        }
      }
    }
    expect(violations, fmt('Invalid transaction hashes', violations)).toHaveLength(0);
  });
});

// ── ON-CHAIN SPOT-CHECK ───────────────────────────────────────────────────────

const RUN_ONCHAIN = process.env.RUN_ONCHAIN === '1';

describe.runIf(RUN_ONCHAIN)('On-Chain Spot-Check', () => {
  // Minimal ABIs — only the selectors we need
  const POSITION_MANAGER_ABI = [
    'function positions(uint256 tokenId) external view returns (uint96 nonce, address operator, address token0, address token1, uint24 fee, int24 tickLower, int24 tickUpper, uint128 liquidity, uint256 feeGrowthInside0LastX128, uint256 feeGrowthInside1LastX128, uint128 tokensOwed0, uint128 tokensOwed1)',
    'function ownerOf(uint256 tokenId) external view returns (address)',
    'function collect(tuple(uint256 tokenId, address recipient, uint128 amount0Max, uint128 amount1Max) params) external payable returns (uint256 amount0, uint256 amount1)',
  ];

  const POOL_ABI = [
    'function slot0() external view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)',
  ];

  const FACTORY_ABI = [
    'function getPool(address tokenA, address tokenB, uint24 fee) external view returns (address pool)',
  ];

  // Load config + most-recent snapshots per tokenId
  let perPositionChecks: Array<{
    tokenId: number;
    rpcUrl: string;
    npmAddress: string;
    factoryAddress: string;
    recentSnapshot: PositionSnapshot;
    snapshotAgeMs: number;
  }> = [];

  beforeAll(async () => {
    // Ensure data is loaded
    if (snapshots.length === 0) await loadData();
    if (!analyticsFound || snapshots.length === 0) return;

    // Read config — fail gracefully if absent
    let config: { positions?: Array<{ token_id: number; rpc_url?: string; npm_address?: string; factory_address?: string; rpc_urls?: string[] }>; rpcUrls?: string[] };
    try {
      const { loadConfig } = await import('../configLoader.js');
      config = loadConfig() as typeof config;
    } catch {
      console.warn('On-chain spot-check: could not load config.yaml — skipping');
      return;
    }

    const positions = (config as any).positions as Array<{ token_id: number }>;
    if (!positions || positions.length === 0) {
      console.warn('On-chain spot-check: no positions in config — skipping');
      return;
    }

    // Find most recent snapshot per tokenId
    const latestByTokenId = new Map<number, PositionSnapshot>();
    for (const s of snapshots) {
      const existing = latestByTokenId.get(s.tokenId);
      if (!existing || s.timestamp > existing.timestamp) {
        latestByTokenId.set(s.tokenId, s);
      }
    }

    const fullConfig = config as any;
    const rpcUrl: string = fullConfig.rpcUrls?.[0] ?? fullConfig.rpc_url ?? '';
    const npmAddress: string = fullConfig.contracts?.positionManager ?? '';
    const factoryAddress: string = fullConfig.contracts?.factory ?? '';

    for (const pos of positions) {
      const tokenId = (pos as any).token_id as number;
      const snapshot = latestByTokenId.get(tokenId);
      if (!snapshot) continue;

      perPositionChecks.push({
        tokenId,
        rpcUrl,
        npmAddress,
        factoryAddress,
        recentSnapshot: snapshot,
        snapshotAgeMs: Date.now() - snapshot.timestamp,
      });
    }
  }, 30_000);

  it('tokenId still valid — ownerOf does not revert', async () => {
    if (perPositionChecks.length === 0) return;
    const violations: string[] = [];

    for (const { tokenId, rpcUrl, npmAddress, snapshotAgeMs } of perPositionChecks) {
      if (snapshotAgeMs > FIVE_MINUTES_MS) {
        console.warn(`tokenId=${tokenId}: snapshot is ${Math.round(snapshotAgeMs / 60000)}m old — comparison may differ`);
      }
      try {
        const provider = new ethers.JsonRpcProvider(rpcUrl);
        const npm = new ethers.Contract(npmAddress, POSITION_MANAGER_ABI, provider);
        await npm.ownerOf(tokenId);
      } catch (err: any) {
        violations.push(`tokenId=${tokenId}: ownerOf() reverted — position may be burned. Error: ${err.message}`);
      }
    }
    expect(violations, fmt('Positions that appear burned/invalid', violations)).toHaveLength(0);
  }, 30_000);

  it('stored liquidity matches live NFT liquidity exactly', async () => {
    if (perPositionChecks.length === 0) return;
    const violations: string[] = [];

    for (const { tokenId, rpcUrl, npmAddress, recentSnapshot, snapshotAgeMs } of perPositionChecks) {
      if (snapshotAgeMs > FIVE_MINUTES_MS) continue; // too old to compare
      try {
        const provider = new ethers.JsonRpcProvider(rpcUrl);
        const npm = new ethers.Contract(npmAddress, POSITION_MANAGER_ABI, provider);
        const pos = await npm.positions(tokenId);
        const liveLiquidity: bigint = pos.liquidity;
        if (liveLiquidity !== recentSnapshot.liquidity) {
          violations.push(
            `tokenId=${tokenId}: stored liquidity=${recentSnapshot.liquidity} live=${liveLiquidity} (position may have been modified)`,
          );
        }
      } catch (err: any) {
        violations.push(`tokenId=${tokenId}: RPC error fetching positions(): ${err.message}`);
      }
    }
    expect(violations, fmt('Liquidity mismatch vs live chain', violations)).toHaveLength(0);
  }, 30_000);

  it('stored currentTick within ±5 ticks of live pool tick', async () => {
    if (perPositionChecks.length === 0) return;
    const violations: string[] = [];

    for (const { tokenId, rpcUrl, npmAddress, factoryAddress, recentSnapshot, snapshotAgeMs } of perPositionChecks) {
      if (snapshotAgeMs > FIVE_MINUTES_MS) continue;
      try {
        const provider = new ethers.JsonRpcProvider(rpcUrl);
        const npm = new ethers.Contract(npmAddress, POSITION_MANAGER_ABI, provider);
        const factory = new ethers.Contract(factoryAddress, FACTORY_ABI, provider);

        const pos = await npm.positions(tokenId);
        const poolAddress: string = await factory.getPool(pos.token0, pos.token1, pos.fee);
        if (!poolAddress || poolAddress === ethers.ZeroAddress) {
          violations.push(`tokenId=${tokenId}: factory returned zero address for pool`);
          continue;
        }

        const pool = new ethers.Contract(poolAddress, POOL_ABI, provider);
        const slot0 = await pool.slot0();
        const liveTick: number = Number(slot0.tick);
        const diff = Math.abs(liveTick - recentSnapshot.currentTick);

        if (diff > 5) {
          violations.push(
            `tokenId=${tokenId}: stored tick=${recentSnapshot.currentTick} live tick=${liveTick} diff=${diff} (snapshot age: ${Math.round(snapshotAgeMs / 1000)}s)`,
          );
        }
      } catch (err: any) {
        violations.push(`tokenId=${tokenId}: RPC error during tick check: ${err.message}`);
      }
    }
    expect(violations, fmt('currentTick diverged from live pool', violations)).toHaveLength(0);
  }, 60_000);

  it('stored isInRange matches live tick position', async () => {
    if (perPositionChecks.length === 0) return;
    const violations: string[] = [];

    for (const { tokenId, rpcUrl, npmAddress, factoryAddress, recentSnapshot, snapshotAgeMs } of perPositionChecks) {
      if (snapshotAgeMs > FIVE_MINUTES_MS) continue;
      try {
        const provider = new ethers.JsonRpcProvider(rpcUrl);
        const npm = new ethers.Contract(npmAddress, POSITION_MANAGER_ABI, provider);
        const factory = new ethers.Contract(factoryAddress, FACTORY_ABI, provider);

        const pos = await npm.positions(tokenId);
        const poolAddress: string = await factory.getPool(pos.token0, pos.token1, pos.fee);
        const pool = new ethers.Contract(poolAddress, POOL_ABI, provider);
        const slot0 = await pool.slot0();
        const liveTick: number = Number(slot0.tick);
        const liveInRange = liveTick >= recentSnapshot.tickLower && liveTick < recentSnapshot.tickUpper;

        if (liveInRange !== recentSnapshot.isInRange) {
          violations.push(
            `tokenId=${tokenId}: stored isInRange=${recentSnapshot.isInRange} but live tick=${liveTick} range=[${recentSnapshot.tickLower},${recentSnapshot.tickUpper}) → isInRange=${liveInRange}`,
          );
        }
      } catch (err: any) {
        violations.push(`tokenId=${tokenId}: RPC error during isInRange check: ${err.message}`);
      }
    }
    expect(violations, fmt('isInRange mismatch vs live chain', violations)).toHaveLength(0);
  }, 60_000);

  it('stored sqrtPriceX96 implies price within 1% of live price', async () => {
    if (perPositionChecks.length === 0) return;
    const violations: string[] = [];
    const Q96 = 2n ** 96n;

    for (const { tokenId, rpcUrl, npmAddress, factoryAddress, recentSnapshot, snapshotAgeMs } of perPositionChecks) {
      if (snapshotAgeMs > FIVE_MINUTES_MS) continue;
      try {
        const provider = new ethers.JsonRpcProvider(rpcUrl);
        const npm = new ethers.Contract(npmAddress, POSITION_MANAGER_ABI, provider);
        const factory = new ethers.Contract(factoryAddress, FACTORY_ABI, provider);

        const pos = await npm.positions(tokenId);
        const poolAddress: string = await factory.getPool(pos.token0, pos.token1, pos.fee);
        const pool = new ethers.Contract(poolAddress, POOL_ABI, provider);
        const slot0 = await pool.slot0();

        const liveSqrt: bigint = slot0.sqrtPriceX96;
        const storedSqrt = recentSnapshot.sqrtPriceX96;

        // Price ∝ (sqrtPriceX96 / 2^96)^2 — compare price ratios
        const livePriceScaled = (liveSqrt * liveSqrt) / (Q96 * Q96 / 10_000n);
        const storedPriceScaled = (storedSqrt * storedSqrt) / (Q96 * Q96 / 10_000n);

        if (storedPriceScaled === 0n) {
          violations.push(`tokenId=${tokenId}: stored sqrtPriceX96=0`);
          continue;
        }

        const diffBps = Number(
          ((livePriceScaled > storedPriceScaled
            ? livePriceScaled - storedPriceScaled
            : storedPriceScaled - livePriceScaled) * 10_000n) / storedPriceScaled,
        );

        if (diffBps > 100) { // >1%
          violations.push(
            `tokenId=${tokenId}: price deviation ${(diffBps / 100).toFixed(2)}% (stored sqrtPriceX96=${storedSqrt} vs live=${liveSqrt})`,
          );
        }
      } catch (err: any) {
        violations.push(`tokenId=${tokenId}: RPC error during price check: ${err.message}`);
      }
    }
    expect(violations, fmt('sqrtPriceX96-derived price diverged >1% from live', violations)).toHaveLength(0);
  }, 60_000);

  it('stored tokensOwed same order of magnitude as live collect.staticCall', async () => {
    if (perPositionChecks.length === 0) return;
    const violations: string[] = [];
    const MAX128 = (2n ** 128n) - 1n;

    for (const { tokenId, rpcUrl, npmAddress, recentSnapshot } of perPositionChecks) {
      try {
        const provider = new ethers.JsonRpcProvider(rpcUrl);
        const npm = new ethers.Contract(npmAddress, POSITION_MANAGER_ABI, provider);

        // collect.staticCall with max values returns the true accrued fees
        const result = await npm.collect.staticCall({
          tokenId,
          recipient: ethers.ZeroAddress,
          amount0Max: MAX128,
          amount1Max: MAX128,
        });

        const liveOwed0: bigint = result.amount0;
        const liveOwed1: bigint = result.amount1;
        const stored0 = recentSnapshot.tokensOwed0;
        const stored1 = recentSnapshot.tokensOwed1;

        // Check order of magnitude: live and stored should agree within 20x
        // (fees accrue between snapshot and now, but shouldn't change order of magnitude)
        function orderOfMagnitudeMismatch(a: bigint, b: bigint): boolean {
          if (a === 0n || b === 0n) return false; // 0 is acceptable on either side
          const ratio = a > b ? a / b : b / a;
          return ratio > 20n;
        }

        if (orderOfMagnitudeMismatch(liveOwed0, stored0)) {
          violations.push(
            `tokenId=${tokenId}: tokensOwed0 stored=${stored0} live=${liveOwed0} — order of magnitude mismatch`,
          );
        }
        if (orderOfMagnitudeMismatch(liveOwed1, stored1)) {
          violations.push(
            `tokenId=${tokenId}: tokensOwed1 stored=${stored1} live=${liveOwed1} — order of magnitude mismatch`,
          );
        }
      } catch (err: any) {
        // staticCall may revert for staked positions — that's expected, skip
        if (!err.message?.includes('revert') && !err.message?.includes('CALL_EXCEPTION')) {
          violations.push(`tokenId=${tokenId}: RPC error during tokensOwed check: ${err.message}`);
        }
      }
    }
    expect(violations, fmt('tokensOwed order-of-magnitude mismatch vs live', violations)).toHaveLength(0);
  }, 60_000);
});

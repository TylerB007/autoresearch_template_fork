/**
 * Rolling price history store and annualized volatility (σ) engine.
 *
 * Maintains per-pool price observations in JSONL files with 30-day rolling retention.
 * Computes sigma_7d and sigma_30d as annualized log-return standard deviation
 * per Doc A §4.3: sigma_Nd = std_dev(log_returns over N days) × √(samples_per_year)
 *
 * Distinct from volatility.ts (which computes tick-stddev regime classification).
 */

import { appendFile, readFile, mkdir, writeFile, rename } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { PriceHistoryRecord } from './types.js';
import logger from '../logger.js';

// ============================================================
// CONSTANTS
// ============================================================

/** Retention window: keep 30 days of price history per pool */
const RETENTION_DAYS = 30;
const RETENTION_MS = RETENTION_DAYS * 24 * 60 * 60 * 1000;

/** Minimum observations needed to compute σ — fewer than this returns undefined */
const MIN_OBSERVATIONS_7D = 20;   // ~1 obs per 8 hours over 7 days
const MIN_OBSERVATIONS_30D = 50;  // ~1 obs per 14 hours over 30 days

/** Sample interval for sampling rate estimation (5 minutes = 288 obs/day) */
const EXPECTED_SAMPLE_INTERVAL_MINUTES = 5;
const SAMPLES_PER_DAY = 1440 / EXPECTED_SAMPLE_INTERVAL_MINUTES; // 288
const SAMPLES_PER_YEAR = SAMPLES_PER_DAY * 365; // 105120

// ============================================================
// STORAGE
// ============================================================

function priceHistoryFilePath(basePath: string, poolAddress: string): string {
  const safe = poolAddress.toLowerCase().replace(/[^a-z0-9]/g, '');
  return join(basePath, `price-history-${safe}.jsonl`);
}

/** Append a price observation to the per-pool JSONL file. */
export async function appendPriceHistory(
  basePath: string,
  record: PriceHistoryRecord,
): Promise<void> {
  try {
    if (!existsSync(basePath)) {
      await mkdir(basePath, { recursive: true });
    }
    const filePath = priceHistoryFilePath(basePath, record.poolAddress);
    const line = JSON.stringify(record) + '\n';
    await appendFile(filePath, line);
  } catch (err) {
    logger.warn(`Failed to append price history: ${err}`);
  }
}

/** Read all price observations for a pool. */
async function readPriceHistory(
  basePath: string,
  poolAddress: string,
): Promise<PriceHistoryRecord[]> {
  try {
    const filePath = priceHistoryFilePath(basePath, poolAddress);
    if (!existsSync(filePath)) return [];
    const content = await readFile(filePath, 'utf-8');
    const lines = content.trim().split('\n').filter(Boolean);
    return lines.map((l) => JSON.parse(l) as PriceHistoryRecord);
  } catch {
    return [];
  }
}

/**
 * Prune observations older than 30 days from a pool's price history file.
 * Uses atomic write (tmp + rename) to avoid partial-file corruption.
 */
export async function prunePriceHistory(
  basePath: string,
  poolAddress: string,
): Promise<void> {
  try {
    const records = await readPriceHistory(basePath, poolAddress);
    const cutoff = Date.now() - RETENTION_MS;
    const kept = records.filter((r) => r.timestamp >= cutoff);
    if (kept.length === records.length) return; // nothing to prune

    const filePath = priceHistoryFilePath(basePath, poolAddress);
    const tmpPath = filePath + '.tmp';
    const content = kept.map((r) => JSON.stringify(r)).join('\n') + (kept.length > 0 ? '\n' : '');
    await writeFile(tmpPath, content, 'utf-8');
    await rename(tmpPath, filePath);
    logger.debug(`Pruned price history for ${poolAddress}: kept ${kept.length}/${records.length} records`);
  } catch (err) {
    logger.warn(`Failed to prune price history for ${poolAddress}: ${err}`);
  }
}

// ============================================================
// VOLATILITY CALCULATION
// ============================================================

export interface SigmaResult {
  /** Annualized σ_7d: std dev of log returns over trailing 7 days × √samples_per_year */
  sigma7d?: number;
  /** Annualized σ_30d: std dev of log returns over trailing 30 days × √samples_per_year */
  sigma30d?: number;
  /** sigma7d / sigma30d — >1 means vol is increasing */
  volatilityRatio?: number;
  /** Quality of the estimate based on gap coverage in the price history */
  confidence: 'high' | 'medium' | 'low' | 'insufficient';
  /** Number of log-return observations used for sigma7d */
  sampleCount7d: number;
  /** Number of log-return observations used for sigma30d */
  sampleCount30d: number;
}

/**
 * Compute annualized price volatility (σ) from stored price history.
 *
 * Method (Doc A §4.3):
 *   log_returns[i] = ln(price_ratio[i] / price_ratio[i-1])
 *   sigma_Nd = std_dev(log_returns over N days) × √(samples_per_year)
 *
 * Where samples_per_year = 288 samples/day × 365 days = 105,120
 * (assuming 5-minute snapshot intervals).
 */
export async function computeSigma(
  basePath: string,
  poolAddress: string,
): Promise<SigmaResult> {
  const records = await readPriceHistory(basePath, poolAddress);
  if (records.length < 2) {
    return { confidence: 'insufficient', sampleCount7d: 0, sampleCount30d: 0 };
  }

  const now = Date.now();
  const cutoff7d = now - 7 * 24 * 60 * 60 * 1000;
  const cutoff30d = now - 30 * 24 * 60 * 60 * 1000;

  const sorted = [...records].sort((a, b) => a.timestamp - b.timestamp);

  // Build log-return series for 30d window (superset of 7d)
  const logReturns30d: number[] = [];
  const logReturns7d: number[] = [];
  let gapCount = 0;
  let totalIntervals = 0;

  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1];
    const curr = sorted[i];
    if (curr.timestamp < cutoff30d) continue;
    if (prev.priceRatio <= 0 || curr.priceRatio <= 0) continue;

    const intervalMs = curr.timestamp - prev.timestamp;
    const expectedIntervalMs = EXPECTED_SAMPLE_INTERVAL_MINUTES * 60 * 1000;

    // Count large gaps for confidence assessment
    if (intervalMs > expectedIntervalMs * 3) {
      gapCount++;
    }
    totalIntervals++;

    const logReturn = Math.log(curr.priceRatio / prev.priceRatio);
    logReturns30d.push(logReturn);

    if (curr.timestamp >= cutoff7d) {
      logReturns7d.push(logReturn);
    }
  }

  // Determine σ confidence based on gap coverage
  const gapFraction = totalIntervals > 0 ? gapCount / totalIntervals : 1;
  let confidence: SigmaResult['confidence'];
  if (totalIntervals < MIN_OBSERVATIONS_30D) {
    confidence = 'insufficient';
  } else if (gapFraction < 0.05) {
    confidence = 'high';
  } else if (gapFraction < 0.15) {
    confidence = 'medium';
  } else {
    confidence = 'low';
  }

  // Compute actual samples per year from observed sample rate
  // Use average interval of the 30d window to adjust annualization
  let samplesPerYear = SAMPLES_PER_YEAR;
  if (logReturns30d.length >= 2 && sorted.length >= 2) {
    const windowDuration = sorted[sorted.length - 1].timestamp - sorted.find((r) => r.timestamp >= cutoff30d)!.timestamp;
    const actualSamplesPerDay = logReturns30d.length / (windowDuration / (24 * 60 * 60 * 1000));
    if (actualSamplesPerDay > 0) {
      samplesPerYear = actualSamplesPerDay * 365;
    }
  }

  const sigma30d = logReturns30d.length >= MIN_OBSERVATIONS_30D
    ? stdDev(logReturns30d) * Math.sqrt(samplesPerYear)
    : undefined;

  const sigma7d = logReturns7d.length >= MIN_OBSERVATIONS_7D
    ? stdDev(logReturns7d) * Math.sqrt(samplesPerYear)
    : undefined;

  const volatilityRatio = sigma7d !== undefined && sigma30d !== undefined && sigma30d > 0
    ? sigma7d / sigma30d
    : undefined;

  return {
    sigma7d,
    sigma30d,
    volatilityRatio,
    confidence: confidence === 'insufficient' ? 'insufficient' : confidence,
    sampleCount7d: logReturns7d.length,
    sampleCount30d: logReturns30d.length,
  };
}

/** Compute standard deviation of an array of numbers. */
function stdDev(values: number[]): number {
  if (values.length === 0) return 0;
  const mean = values.reduce((s, v) => s + v, 0) / values.length;
  const variance = values.reduce((s, v) => s + (v - mean) ** 2, 0) / values.length;
  return Math.sqrt(variance);
}

// ============================================================
// CONVENIENCE: Build a PriceHistoryRecord from snapshot data
// ============================================================

export function buildPriceHistoryRecord(
  poolAddress: string,
  chainId: number,
  timestamp: number,
  priceRatio: number,
  priceUsd0: number,
  priceUsd1: number,
  source: string,
): PriceHistoryRecord {
  return {
    priceHistoryId: randomUUID(),
    poolAddress: poolAddress.toLowerCase(),
    chainId,
    timestamp,
    priceRatio,
    priceUsd0,
    priceUsd1,
    source,
  };
}

// ============================================================
// DERIVED VIABILITY FIELDS
// ============================================================

/**
 * Compute the profitability floor and related viability fields.
 *
 * Doc A §4 — Derived Viability Fields:
 *   min_pl_rate = sigma30d² / 8
 *   profitability_margin = pool_fee_rate - min_pl_rate
 *   profitability_viable = pool_fee_rate > min_pl_rate
 *
 * @param sigma30d     Annualized σ_30d (from computeSigma)
 * @param poolFeeRate  Annualized pool fee rate: (volume_24h × fee_tier × 365) / tvl
 * @param widthPct     Range width as % of current price (for effective APR)
 */
export function computeViabilityFields(
  sigma30d: number | undefined,
  poolFeeRate: number | undefined,
  widthPct: number | undefined,
): {
  minPlRate?: number;
  profitabilityMargin?: number;
  profitabilityViable?: boolean;
  effectiveAprPct?: number;
} {
  if (sigma30d === undefined || poolFeeRate === undefined) return {};

  const minPlRate = (sigma30d * sigma30d) / 8;
  const profitabilityMargin = poolFeeRate - minPlRate;
  const profitabilityViable = poolFeeRate > minPlRate;

  let effectiveAprPct: number | undefined;
  if (widthPct !== undefined && widthPct > 0) {
    const concentrationFactor = 100 / widthPct;
    effectiveAprPct = poolFeeRate * concentrationFactor;
  }

  return { minPlRate, profitabilityMargin, profitabilityViable, effectiveAprPct };
}

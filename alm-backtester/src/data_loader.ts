/**
 * Data loader — reads JSONL price data and normalizes to uniform intervals.
 */

import { readFileSync } from 'fs';
import { tickToSqrtPriceX96 } from './alm_bridge.js';
import type { PriceTick } from './types.js';

interface RawPriceRecord {
  timestamp: number;
  tick?: number;
  priceRatio?: number;
}

/**
 * Load price ticks from a JSONL file.
 * Each line: { timestamp, tick } or { timestamp, priceRatio }
 * If only priceRatio is provided, tick is derived via log formula.
 */
export function loadPriceData(filePath: string): PriceTick[] {
  const content = readFileSync(filePath, 'utf-8');
  const lines = content.trim().split('\n').filter(l => l.length > 0);
  const ticks: PriceTick[] = [];

  for (const line of lines) {
    const raw: RawPriceRecord = JSON.parse(line);
    let tick: number;

    if (raw.tick !== undefined) {
      tick = raw.tick;
    } else if (raw.priceRatio !== undefined && raw.priceRatio > 0) {
      // priceRatio = 1.0001^tick => tick = ln(priceRatio) / ln(1.0001)
      tick = Math.round(Math.log(raw.priceRatio) / Math.log(1.0001));
    } else {
      continue; // Skip invalid records
    }

    ticks.push({
      timestamp: raw.timestamp,
      tick,
      sqrtPriceX96: tickToSqrtPriceX96(tick),
    });
  }

  // Sort by timestamp
  ticks.sort((a, b) => a.timestamp - b.timestamp);
  return ticks;
}

/**
 * Interpolate price data to uniform intervals (default 60 seconds).
 * Fills gaps with the last known tick value.
 */
export function interpolateToUniform(
  data: PriceTick[],
  intervalMs: number = 60_000,
): PriceTick[] {
  if (data.length === 0) return [];

  const result: PriceTick[] = [];
  const start = data[0].timestamp;
  const end = data[data.length - 1].timestamp;

  let dataIdx = 0;
  for (let t = start; t <= end; t += intervalMs) {
    // Advance to the last data point at or before time t
    while (dataIdx + 1 < data.length && data[dataIdx + 1].timestamp <= t) {
      dataIdx++;
    }
    result.push({
      timestamp: t,
      tick: data[dataIdx].tick,
      sqrtPriceX96: data[dataIdx].sqrtPriceX96,
    });
  }

  return result;
}

/**
 * Generate synthetic price data using a geometric Brownian motion model.
 * Useful for testing and stress-testing strategies.
 */
export function generateSyntheticData(options: {
  startTick: number;
  durationDays: number;
  intervalSeconds?: number;
  /** Annualized volatility as a decimal (e.g., 0.5 for 50%) */
  volatility?: number;
  /** Annualized drift as a decimal (e.g., 0.1 for 10% upward) */
  drift?: number;
  /** Random seed for reproducibility (not cryptographic) */
  seed?: number;
}): PriceTick[] {
  const {
    startTick,
    durationDays,
    intervalSeconds = 60,
    volatility = 0.5,
    drift = 0,
    seed = 42,
  } = options;

  const intervalMs = intervalSeconds * 1000;
  const totalSteps = Math.floor((durationDays * 86400) / intervalSeconds);
  const dt = intervalSeconds / (365.25 * 86400); // Time step in years

  // Simple seeded PRNG (xorshift32)
  let state = seed >>> 0 || 1;
  function rand(): number {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 4294967296;
  }
  // Box-Muller for normal distribution
  function randn(): number {
    const u1 = rand();
    const u2 = rand();
    return Math.sqrt(-2 * Math.log(u1 || 1e-10)) * Math.cos(2 * Math.PI * u2);
  }

  const ticks: PriceTick[] = [];
  let currentTick = startTick;
  const startTime = Date.now();

  for (let i = 0; i <= totalSteps; i++) {
    const tick = Math.round(currentTick);
    ticks.push({
      timestamp: startTime + i * intervalMs,
      tick,
      sqrtPriceX96: tickToSqrtPriceX96(tick),
    });

    // GBM step in tick space:
    // tick represents log-price (tick = ln(price)/ln(1.0001))
    // So we add drift and diffusion in tick units
    const tickVolatility = volatility / Math.log(1.0001); // Convert price vol to tick vol
    const tickDrift = drift / Math.log(1.0001);
    currentTick += tickDrift * dt + tickVolatility * Math.sqrt(dt) * randn();
  }

  return ticks;
}

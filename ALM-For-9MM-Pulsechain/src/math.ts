/**
 * V3 Math Utilities — ALL BigInt for on-chain values, no floating point
 *
 * Direct port of Uniswap V3 TickMath.sol and LiquidityAmounts.sol
 * These are the exact same formulas used on-chain.
 */

const Q96 = 1n << 96n;
const Q192 = 1n << 192n;
const MAX_TICK = 887272;
const MIN_TICK = -887272;
const MAX_UINT256 = (1n << 256n) - 1n;

// ============================================================
// tickToSqrtPriceX96 — port of TickMath.getSqrtRatioAtTick()
// ============================================================

export function tickToSqrtPriceX96(tick: number): bigint {
  const absTick = Math.abs(tick);
  if (absTick > MAX_TICK) {
    throw new Error(`Tick ${tick} out of range (max absolute: ${MAX_TICK})`);
  }

  let ratio: bigint =
    (absTick & 0x1) !== 0
      ? 0xfffcb933bd6fad37aa2d162d1a594001n
      : 0x100000000000000000000000000000000n;

  if ((absTick & 0x2) !== 0)
    ratio = (ratio * 0xfff97272373d413259a46990580e213an) >> 128n;
  if ((absTick & 0x4) !== 0)
    ratio = (ratio * 0xfff2e50f5f656932ef12357cf3c7fdccn) >> 128n;
  if ((absTick & 0x8) !== 0)
    ratio = (ratio * 0xffe5caca7e10e4e61c3624eaa0941cd0n) >> 128n;
  if ((absTick & 0x10) !== 0)
    ratio = (ratio * 0xffcb9843d60f6159c9db58835c926644n) >> 128n;
  if ((absTick & 0x20) !== 0)
    ratio = (ratio * 0xff973b41fa98c081472e6896dfb254c0n) >> 128n;
  if ((absTick & 0x40) !== 0)
    ratio = (ratio * 0xff2ea16466c96a3843ec78b326b52861n) >> 128n;
  if ((absTick & 0x80) !== 0)
    ratio = (ratio * 0xfe5dee046a99a2a811c461f1969c3053n) >> 128n;
  if ((absTick & 0x100) !== 0)
    ratio = (ratio * 0xfcbe86c7900a88aedcffc83b479aa3a4n) >> 128n;
  if ((absTick & 0x200) !== 0)
    ratio = (ratio * 0xf987a7253ac413176f2b074cf7815e54n) >> 128n;
  if ((absTick & 0x400) !== 0)
    ratio = (ratio * 0xf3392b0822b70005940c7a398e4b70f3n) >> 128n;
  if ((absTick & 0x800) !== 0)
    ratio = (ratio * 0xe7159475a2c29b7443b29c7fa6e889d9n) >> 128n;
  if ((absTick & 0x1000) !== 0)
    ratio = (ratio * 0xd097f3bdfd2022b8845ad8f792aa5825n) >> 128n;
  if ((absTick & 0x2000) !== 0)
    ratio = (ratio * 0xa9f746462d870fdf8a65dc1f90e061e5n) >> 128n;
  if ((absTick & 0x4000) !== 0)
    ratio = (ratio * 0x70d869a156d2a1b890bb3df62baf32f7n) >> 128n;
  if ((absTick & 0x8000) !== 0)
    ratio = (ratio * 0x31be135f97d08fd981231505542fcfa6n) >> 128n;
  if ((absTick & 0x10000) !== 0)
    ratio = (ratio * 0x9aa508b5b7a84e1c677de54f3e99bc9n) >> 128n;
  if ((absTick & 0x20000) !== 0)
    ratio = (ratio * 0x5d6af8dedb81196699c329225ee604n) >> 128n;
  if ((absTick & 0x40000) !== 0)
    ratio = (ratio * 0x2216e584f5fa1ea926041bedfe98n) >> 128n;
  if ((absTick & 0x80000) !== 0)
    ratio = (ratio * 0x48a170391f7dc42444e8fa2n) >> 128n;

  if (tick > 0) {
    ratio = MAX_UINT256 / ratio;
  }

  // Convert from Q128 to Q96, rounding up
  return (ratio >> 32n) + (ratio % (1n << 32n) === 0n ? 0n : 1n);
}

// ============================================================
// sqrtPriceX96ToTick — port of TickMath.getTickAtSqrtRatio()
// ============================================================

export function sqrtPriceX96ToTick(sqrtPriceX96: bigint): number {
  const sqrtRatioX128 = sqrtPriceX96 << 32n;

  // Find MSB
  let msb = 0n;
  let r = sqrtRatioX128;

  let f: bigint;
  f = r > 0xffffffffffffffffffffffffffffffffn ? 1n : 0n;
  msb |= f << 7n;
  r >>= f * 128n;

  f = r > 0xffffffffffffffffn ? 1n : 0n;
  msb |= f << 6n;
  r >>= f * 64n;

  f = r > 0xffffffffn ? 1n : 0n;
  msb |= f << 5n;
  r >>= f * 32n;

  f = r > 0xffffn ? 1n : 0n;
  msb |= f << 4n;
  r >>= f * 16n;

  f = r > 0xffn ? 1n : 0n;
  msb |= f << 3n;
  r >>= f * 8n;

  f = r > 0xfn ? 1n : 0n;
  msb |= f << 2n;
  r >>= f * 4n;

  f = r > 0x3n ? 1n : 0n;
  msb |= f << 1n;
  r >>= f * 2n;

  f = r > 0x1n ? 1n : 0n;
  msb |= f;

  // Normalize to 128.128 fixed point
  if (msb >= 128n) {
    r = sqrtRatioX128 >> (msb - 127n);
  } else {
    r = sqrtRatioX128 << (127n - msb);
  }

  let log2 = (msb - 128n) << 64n;

  // 14 iterations of log2 refinement
  for (let i = 0; i < 14; i++) {
    r = (r * r) >> 127n;
    const f2 = r >> 128n;
    log2 |= f2 << BigInt(63 - i);
    r >>= f2;
  }

  // Convert log2 to log_sqrt(1.0001)
  const logSqrt10001 = log2 * 255738958999603826347141n;

  const tickLow = Number(
    (logSqrt10001 - 3402992956809132418596140100660247210n) >> 128n,
  );
  const tickHigh = Number(
    (logSqrt10001 + 291339464771989622907027621153398088495n) >> 128n,
  );

  if (tickLow === tickHigh) return tickLow;
  return tickToSqrtPriceX96(tickHigh) <= sqrtPriceX96 ? tickHigh : tickLow;
}

// ============================================================
// tickToPrice / priceToTick — ONLY for logging/display
// ============================================================

export function tickToPrice(tick: number, decimals0: number, decimals1: number): number {
  return Math.pow(1.0001, tick) * Math.pow(10, decimals0 - decimals1);
}

export function priceToTick(price: number, decimals0: number, decimals1: number): number {
  const adjustedPrice = price / Math.pow(10, decimals0 - decimals1);
  return Math.round(Math.log(adjustedPrice) / Math.log(1.0001));
}

// ============================================================
// nearestUsableTick — snap to tickSpacing grid
// ============================================================

export function nearestUsableTick(tick: number, tickSpacing: number): number {
  if (tickSpacing <= 0) throw new Error('tickSpacing must be positive');
  const rounded = Math.round(tick / tickSpacing) * tickSpacing;
  const snappedMin = Math.ceil(MIN_TICK / tickSpacing) * tickSpacing;
  const snappedMax = Math.floor(MAX_TICK / tickSpacing) * tickSpacing;
  return Math.max(snappedMin, Math.min(snappedMax, rounded));
}

// ============================================================
// getAmountsForLiquidity — from LiquidityAmounts.sol
// ============================================================

export function getAmountsForLiquidity(
  sqrtPriceX96: bigint,
  sqrtPriceAX96: bigint,
  sqrtPriceBX96: bigint,
  liquidity: bigint,
): { amount0: bigint; amount1: bigint } {
  if (sqrtPriceAX96 > sqrtPriceBX96) {
    [sqrtPriceAX96, sqrtPriceBX96] = [sqrtPriceBX96, sqrtPriceAX96];
  }

  if (sqrtPriceX96 <= sqrtPriceAX96) {
    // Current price below range — entirely token0
    return {
      amount0: getAmount0ForLiquidity(sqrtPriceAX96, sqrtPriceBX96, liquidity),
      amount1: 0n,
    };
  } else if (sqrtPriceX96 < sqrtPriceBX96) {
    // Current price inside range — both tokens
    return {
      amount0: getAmount0ForLiquidity(sqrtPriceX96, sqrtPriceBX96, liquidity),
      amount1: getAmount1ForLiquidity(sqrtPriceAX96, sqrtPriceX96, liquidity),
    };
  } else {
    // Current price above range — entirely token1
    return {
      amount0: 0n,
      amount1: getAmount1ForLiquidity(sqrtPriceAX96, sqrtPriceBX96, liquidity),
    };
  }
}

function getAmount0ForLiquidity(
  sqrtPriceAX96: bigint,
  sqrtPriceBX96: bigint,
  liquidity: bigint,
): bigint {
  if (sqrtPriceAX96 > sqrtPriceBX96) {
    [sqrtPriceAX96, sqrtPriceBX96] = [sqrtPriceBX96, sqrtPriceAX96];
  }
  return (liquidity * Q96 * (sqrtPriceBX96 - sqrtPriceAX96)) / (sqrtPriceBX96 * sqrtPriceAX96);
}

function getAmount1ForLiquidity(
  sqrtPriceAX96: bigint,
  sqrtPriceBX96: bigint,
  liquidity: bigint,
): bigint {
  if (sqrtPriceAX96 > sqrtPriceBX96) {
    [sqrtPriceAX96, sqrtPriceBX96] = [sqrtPriceBX96, sqrtPriceAX96];
  }
  return (liquidity * (sqrtPriceBX96 - sqrtPriceAX96)) / Q96;
}

// ============================================================
// getLiquidityForAmounts — inverse of getAmountsForLiquidity
// ============================================================

export function getLiquidityForAmounts(
  sqrtPriceX96: bigint,
  sqrtPriceAX96: bigint,
  sqrtPriceBX96: bigint,
  amount0: bigint,
  amount1: bigint,
): bigint {
  if (sqrtPriceAX96 > sqrtPriceBX96) {
    [sqrtPriceAX96, sqrtPriceBX96] = [sqrtPriceBX96, sqrtPriceAX96];
  }

  if (sqrtPriceX96 <= sqrtPriceAX96) {
    return getLiquidityForAmount0(sqrtPriceAX96, sqrtPriceBX96, amount0);
  } else if (sqrtPriceX96 < sqrtPriceBX96) {
    const liq0 = getLiquidityForAmount0(sqrtPriceX96, sqrtPriceBX96, amount0);
    const liq1 = getLiquidityForAmount1(sqrtPriceAX96, sqrtPriceX96, amount1);
    return liq0 < liq1 ? liq0 : liq1;
  } else {
    return getLiquidityForAmount1(sqrtPriceAX96, sqrtPriceBX96, amount1);
  }
}

function getLiquidityForAmount0(
  sqrtPriceAX96: bigint,
  sqrtPriceBX96: bigint,
  amount0: bigint,
): bigint {
  if (sqrtPriceAX96 > sqrtPriceBX96) {
    [sqrtPriceAX96, sqrtPriceBX96] = [sqrtPriceBX96, sqrtPriceAX96];
  }
  const intermediate = (sqrtPriceAX96 * sqrtPriceBX96) / Q96;
  return (amount0 * intermediate) / (sqrtPriceBX96 - sqrtPriceAX96);
}

function getLiquidityForAmount1(
  sqrtPriceAX96: bigint,
  sqrtPriceBX96: bigint,
  amount1: bigint,
): bigint {
  if (sqrtPriceAX96 > sqrtPriceBX96) {
    [sqrtPriceAX96, sqrtPriceBX96] = [sqrtPriceBX96, sqrtPriceAX96];
  }
  return (amount1 * Q96) / (sqrtPriceBX96 - sqrtPriceAX96);
}

// ============================================================
// calculateSwapAmount — determines what to swap for new position ratio
// ============================================================

export function calculateSwapAmount(
  amount0: bigint,
  amount1: bigint,
  currentTick: number,
  newTickLower: number,
  newTickUpper: number,
  fee: number,
): { tokenIn: 'token0' | 'token1'; amountIn: bigint } {
  const sqrtPriceX96 = tickToSqrtPriceX96(currentTick);
  const sqrtPriceAX96 = tickToSqrtPriceX96(newTickLower);
  const sqrtPriceBX96 = tickToSqrtPriceX96(newTickUpper);

  // Get target ratio using a large reference liquidity for precision
  const refLiquidity = 1n << 96n;
  const target = getAmountsForLiquidity(sqrtPriceX96, sqrtPriceAX96, sqrtPriceBX96, refLiquidity);

  if (target.amount0 === 0n && target.amount1 === 0n) {
    return { tokenIn: 'token0', amountIn: 0n };
  }

  // Edge cases: entirely one-sided ranges
  if (target.amount0 === 0n) {
    return { tokenIn: 'token0', amountIn: amount0 };
  }
  if (target.amount1 === 0n) {
    return { tokenIn: 'token1', amountIn: amount1 };
  }

  // Calculate using scaled values to maintain BigInt precision
  // price = (sqrtPriceX96)^2 / 2^192
  const sqrtPriceSq = sqrtPriceX96 * sqrtPriceX96;

  // Target value fraction of token0:
  //   targetFrac0 = target.amount0 * price / (target.amount0 * price + target.amount1)
  const targetValue0Scaled = target.amount0 * sqrtPriceSq;
  const targetTotalScaled = targetValue0Scaled + target.amount1 * Q192;

  // Current value of token0 holdings
  const currentValue0Scaled = amount0 * sqrtPriceSq;
  const currentTotalScaled = currentValue0Scaled + amount1 * Q192;

  // Target amount of token0 in value terms
  const targetAmount0InValue = (currentTotalScaled * targetValue0Scaled) / targetTotalScaled;

  // Fee accounting
  const FEE_DENOMINATOR = 1_000_000n;
  const feeMultiplier = FEE_DENOMINATOR - BigInt(fee);

  if (currentValue0Scaled > targetAmount0InValue) {
    // Sell token0 for token1
    const excessValueScaled = currentValue0Scaled - targetAmount0InValue;
    let amountIn =
      (excessValueScaled * FEE_DENOMINATOR) / (sqrtPriceSq * feeMultiplier);
    if (amountIn > amount0) amountIn = amount0;
    return { tokenIn: 'token0', amountIn };
  } else {
    // Sell token1 for token0
    const deficitValueScaled = targetAmount0InValue - currentValue0Scaled;
    let amountIn = (deficitValueScaled * FEE_DENOMINATOR) / (Q192 * feeMultiplier);
    if (amountIn > amount1) amountIn = amount1;
    return { tokenIn: 'token1', amountIn };
  }
}

// ============================================================
// Tick & Percentage Utilities
// ============================================================

/**
 * Converts a price percentage variance to the equivalent tick distance.
 * Based on the V3 formula: Price = 1.0001^tick
 * @param percentage The percentage change (e.g., 5 for 5%)
 * @returns The corresponding tick delta
 */
export function percentageToTicks(percentage: number): number {
  if (percentage <= 0) return 0;
  // If price increases by P%, the tick moves by: ln(1 + P/100) / ln(1.0001)
  return Math.round(Math.log(1 + (percentage / 100)) / Math.log(1.0001));
}

/**
 * Converts a tick difference back into a price percentage change.
 * @param ticks The tick delta
 * @returns The percentage change (e.g., 5 for 5%)
 */
export function ticksToPercentage(ticks: number): number {
  return (Math.pow(1.0001, Math.abs(ticks)) - 1) * 100;
}

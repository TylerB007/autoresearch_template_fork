/**
 * Safe BigInt-to-float conversion utilities.
 *
 * Native `Number(bigint)` silently loses precision for values exceeding
 * 2^53 (~9 quadrillion). Token amounts with 18 decimals routinely exceed
 * this, and sqrtPriceX96 values are always ~96 bits (their squares ~192 bits).
 *
 * These utilities perform division in BigInt-land first, reducing magnitude
 * below 2^53 before the Number() cast.
 */

/**
 * Convert a BigInt raw token amount to a floating-point number,
 * avoiding precision loss from premature Number() conversion.
 *
 * Strategy: divide in BigInt-land first, then convert the small quotient
 * and remainder separately.
 *
 * For tokens with decimals > 15 (e.g., 18-decimal ERC-20s), the remainder
 * itself could approach 10^18 (~2^60), so we split it into two halves
 * for extra precision.
 *
 * @param value   Raw on-chain amount (e.g., 1500000000000000000n for 1.5 ETH)
 * @param decimals  Token decimals (e.g., 18, 8, 6)
 * @returns Floating-point human-readable amount (e.g., 1.5)
 */
export function bigintToFloat(value: bigint, decimals: number): number {
  if (value === 0n) return 0;

  const negative = value < 0n;
  const abs = negative ? -value : value;
  const divisor = 10n ** BigInt(decimals);
  const integerPart = abs / divisor;
  const remainder = abs % divisor;

  let result: number;

  if (decimals > 15) {
    // Split remainder into two halves to keep each under 2^53.
    // remainder = upperRemainder * halfDivisor + lowerRemainder
    // remainder / divisor = upperRemainder / 10^(decimals - halfDecimals) + lowerRemainder / divisor
    const halfDecimals = BigInt(Math.floor(decimals / 2));
    const upperDivisor = 10n ** (BigInt(decimals) - halfDecimals);
    const halfDivisor = 10n ** halfDecimals;
    const upperRemainder = remainder / halfDivisor;
    const lowerRemainder = remainder % halfDivisor;
    result =
      Number(integerPart) +
      Number(upperRemainder) / Number(upperDivisor) +
      Number(lowerRemainder) / Number(divisor);
  } else {
    // For decimals <= 15, both integerPart and remainder fit safely in Number
    result = Number(integerPart) + Number(remainder) / Number(divisor);
  }

  return negative ? -result : result;
}

/**
 * Convenience wrapper for converting wei amounts (18 decimals) to native currency float.
 * Common pattern: gas cost in wei → human-readable PLS/ETH amount.
 */
export function bigintWeiToFloat(weiValue: bigint): number {
  return bigintToFloat(weiValue, 18);
}

/**
 * Convert sqrtPriceX96 to a floating-point price ratio (token1/token0 in raw units).
 *
 * price = (sqrtPriceX96 / 2^96)^2
 *
 * We CANNOT do `Number(sqrtPriceX96^2) / Number(Q96^2)` because both are ~192 bits
 * and overflow Number's 53-bit mantissa. `Number(2n**192n)` is literally `Infinity`.
 *
 * Instead: divide sqrtPriceX96 by Q96 in BigInt first to get integer + fractional parts,
 * then combine into a safe float before squaring.
 */
export function sqrtPriceX96ToPrice(sqrtPriceX96: bigint): number {
  if (sqrtPriceX96 === 0n) return 0;

  const Q96 = 1n << 96n;
  const intPart = sqrtPriceX96 / Q96;
  const fracPart = sqrtPriceX96 % Q96;

  // fracPart is up to ~96 bits (< Q96), which exceeds 2^53.
  // Scale down to 48 bits of precision (more than enough — gives ~14 decimal digits).
  const FRAC_BITS = 48n;
  const scaledFrac = (fracPart << FRAC_BITS) / Q96; // fits in 48 bits

  const sqrtPrice = Number(intPart) + Number(scaledFrac) / (2 ** Number(FRAC_BITS));

  return sqrtPrice * sqrtPrice;
}

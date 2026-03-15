/**
 * V3 Fee Configuration — supports both 9mm V3 (PulseChain) and Uniswap V3 (Ethereum)
 *
 * ⚠️ WARNING: 9mm uses non-standard fee tiers!
 * Uniswap V3 MEDIUM = 3000 (0.30%), tick spacing = 60
 * 9mm V3 MEDIUM     = 2500 (0.25%), tick spacing = 50
 *
 * For chain-aware fee lookups, prefer getTickSpacingForChain() from chains.ts.
 * The exports below are kept for backward compatibility (default to 9mm / PulseChain).
 */

// 9mm V3 fee tiers (PulseChain default — preserved for backward compatibility)
export const FEE_TIERS = {
  LOWEST: 100,    // 0.01%
  LOW: 500,       // 0.05%
  MEDIUM: 2500,   // 0.25% — DIFFERENT FROM UNISWAP (3000)
  HIGH: 10000,    // 1.00%
} as const;

// Uniswap V3 fee tiers (Ethereum)
export const UNISWAP_FEE_TIERS = {
  LOWEST: 100,    // 0.01%
  LOW: 500,       // 0.05%
  MEDIUM: 3000,   // 0.30% — DIFFERENT FROM 9MM (2500)
  HIGH: 10000,    // 1.00%
} as const;

// 9mm V3 tick spacings (PulseChain default — preserved for backward compatibility)
export const TICK_SPACINGS: Record<number, number> = {
  100: 1,
  500: 10,
  2500: 50,       // 9mm MEDIUM (NOT Uniswap's 3000 → 60)
  10000: 200,
};

// Uniswap V3 tick spacings (Ethereum)
export const UNISWAP_TICK_SPACINGS: Record<number, number> = {
  100: 1,
  500: 10,
  3000: 60,       // Uniswap MEDIUM (NOT 9mm's 2500 → 50)
  10000: 200,
};

// Aerodrome CL tick spacings (Base) — uses tickSpacing as pool key (identity mapping)
export const AERODROME_TICK_SPACINGS: Record<number, number> = {
  1: 1,      // 0.01%
  50: 50,    // 0.05%
  100: 100,  // 0.05% (alternate spacing)
  200: 200,  // 0.30%
  2000: 2000, // 1.00%
};

// Merged tick spacings — supports 9mm, Uniswap, and Aerodrome fee tiers for validation
const ALL_TICK_SPACINGS: Record<number, number> = {
  ...TICK_SPACINGS,
  ...UNISWAP_TICK_SPACINGS,
  ...AERODROME_TICK_SPACINGS,
};

/**
 * Get tick spacing for a fee tier.
 * Supports both 9mm (2500) and Uniswap (3000) fee tiers.
 * For chain-specific validation, use getTickSpacingForChain() from chains.ts.
 */
export function getTickSpacing(fee: number): number {
  const spacing = ALL_TICK_SPACINGS[fee];
  if (spacing === undefined) {
    throw new Error(`Unsupported fee tier: ${fee}. Supported: ${Object.keys(ALL_TICK_SPACINGS).join(', ')}`);
  }
  return spacing;
}

export function feeToPercent(fee: number): string {
  return `${(fee / 10000).toFixed(2)}%`;
}

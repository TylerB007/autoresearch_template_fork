/**
 * Operational Constants for 9mm V3 on PulseChain
 * Extracted from TylerB007/main-liquidity-dashboard
 * Sources: config/dexs/ninemm.js, utils/ninemill_constants.js
 */

export const MAX_UINT128 = BigInt('0xffffffffffffffffffffffffffffffff');
export const MAX_UINT256 = BigInt('0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff');
export const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

export const DEFAULT_DEADLINE_MINUTES = 20;
export const DEFAULT_SLIPPAGE_TOLERANCE_BPS = 50; // 0.5%

export const GAS_LIMITS = {
  MINT: 600000,
  BURN: 350000,
  COLLECT: 350000,
  SWAP: 350000,
  APPROVE: 100_000,
  INCREASE_LIQUIDITY: 400_000,
  GAUGE_DEPOSIT: 200_000,
  GAUGE_WITHDRAW: 150_000,
  GAUGE_APPROVE: 80_000,
} as const;

// Function selectors (from utils/ninemill_constants.js)
export const FUNCTION_SELECTORS = {
  COLLECT: '0xfc6f7865',
  MINT: '0x88316456',
  BURN: '0x0c49ccbe',
  APPROVE: '0x095ea7b3',
  TRANSFER: '0xa9059cbb',
  TRANSFER_FROM: '0x23b872dd',
  BALANCE_OF: '0x70a08231',
  ALLOWANCE: '0xdd62ed3e',
  CREATE_POOL: '0x13af4035',
  GET_POOL: '0x1698ee82',
  SLOT0: '0x3850c7bd',
  LIQUIDITY: '0x1a686502',
  SWAP: '0x128acb08',
} as const;

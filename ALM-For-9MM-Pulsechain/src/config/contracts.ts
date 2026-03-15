/**
 * 9mm V3 Contract Addresses on PulseChain — VERIFIED
 * Extracted from TylerB007/main-liquidity-dashboard
 * Sources: config/contracts.js, config/dexs/ninemm.js, utils/ninemill_constants.js
 */

// Core 9mm V3 Contracts
export const CONTRACTS = {
  NONFUNGIBLE_POSITION_MANAGER: '0xCC05bf158202b4F461Ede8843d76dcd7Bbad07f2',
  SWAP_ROUTER: '0xf6076d61A0C46C944852F65838E1b12A2910a717',
  FACTORY: '0xe50dbdc88e87a2c92984d794bcf3d1d76f619c68',
  QUOTER: '0x250D0399E3f363d98f8A27942712d59248C33007',
  POOL_DEPLOYER: '0x00f37661fa1b2b8a530cfb7b6d5a5a6aed74177b',
  TOKEN_DESCRIPTOR: '0xfc6d8b33211c1ace98d34b3b4b0df35f4e3186d1',
} as const;

// PulseChain Token Addresses
export const TOKENS = {
  // Wrapped native
  WPLS: '0xA1077a294dDE1B09bB078844df40758a5D0f9a27',

  // Major tokens
  PLSX: '0x95B303987A60C71504D99Aa1b13B4DA07b0790ab',
  HEX: '0x2b591e99afE9f32eAA6214f7B7629768c40Eeb39',
  INC: '0x2fa878Ab3F87CC1C9737Fc071108F904c0B0C95d',

  // Stablecoins
  DAI: '0xefD766cCb38EaF1dfd701853bFCe31359239F305',
  USDC: '0x15D38573d2feeb82e7ad5187aB8c1D52810B1f07',
  USDT: '0x0Cb6F5a34ad42ec934882A05265A7d5F59b51A2f',

  // Bridged assets
  WETH: '0x02DcdD04e3F455D838cd1249292C58f3B79e3C3C',
  WBTC: '0xb17D901469B9208B17d916112988A3FeD19b5cA1',
} as const;

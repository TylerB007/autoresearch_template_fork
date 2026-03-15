/**
 * Sonic Network Configuration
 * Shadow.so V3 (Ramses V3 Core fork) contract addresses and chain metadata
 *
 * Shadow.so is built on Ramses V3 Core (a Uniswap V3 derivative) but its NPM uses
 * an Algebra V3-style interface: positions() returns 10 fields (no nonce/operator),
 * with tickSpacing instead of fee. Pool and swap interfaces follow the Aerodrome CL pattern:
 * - tickSpacing (not fee) as the pool key in factory.getPool() and ExactInputSingleParams
 * - ExactInputSingleParams includes a deadline field
 * - Pools use CREATE2 via deployer 0x8BBDc15759a8eCf99A92E004E0C64ea9A5142d59 (NOT EIP-1167 proxies)
 * - Pool fee is dynamic (adjustable via governance setFee()) — not fixed at creation
 * - Use swapRouterType: 'algebra-v3' (mint ABI differs from aerodrome-cl: 11-field, no sqrtPriceX96)
 *
 * Sources: https://docs.shadow.so/pages/contract-addresses
 *          https://github.com/Shadow-Exchange/shadow-core
 */

export const SONIC_CHAIN_CONFIG = {
  chainId: 146,
  chainName: 'Sonic',
  rpcUrls: [
    'https://rpc.soniclabs.com',
    'https://rpc.ankr.com/sonic_mainnet',
    'https://sonic.drpc.org',
  ],
  nativeCurrency: {
    name: 'Sonic',
    symbol: 'S',
    decimals: 18,
  },
  blockExplorerUrls: [
    'https://sonicscan.org',
  ],
  blockTimeSeconds: 1, // Sonic produces blocks approximately every ~1 second
} as const;

// Shadow.so V3 Core Contracts on Sonic Mainnet
// Source: https://shadow.so / official Shadow documentation
export const SONIC_CONTRACTS = {
  // Shadow V3 NPM (Algebra V3-style: positions() returns 10 fields, no nonce/operator).
  // Verified on-chain: wallet owns position #1141460 on this contract.
  NONFUNGIBLE_POSITION_MANAGER: '0x12E66C8F215DdD5d48d150c8f46aD0c6fB0F4406',
  SWAP_ROUTER: '0x5543c6176feb9b4b179078205d7c29eea2e2d695',
  FACTORY: '0xcD2d0637c94fe77C2896BbCBB174cefFb08DE6d7',
  QUOTER: '0x219b7ADebc0935a3eC889a148c6924D51A07535A',
} as const;

// Common Sonic Token Addresses
export const SONIC_TOKENS = {
  // Wrapped native — Wrapped Sonic (wS)
  WS: '0x039e2fB66102314Ce7b64Ce5Ce3E5183bc94aD38',

  // Stablecoins
  USDC: '0x29219dd400f2Bf60E5a23d13Be72B486D4038894',

  // Bridged tokens
  WETH: '0x50c42dEAcD8Fc9773493ED674b675bE577f2634b',
} as const;

/**
 * Base Mainnet Network Configuration
 * Uniswap V3 contract addresses and chain metadata
 */

export const BASE_CONFIG = {
  chainId: 8453,
  chainName: 'Base',
  rpcUrls: [
    'https://base-rpc.publicnode.com',
    'https://base.meowrpc.com',
    'https://mainnet.base.org',
  ],
  wsUrls: ['wss://base-rpc.publicnode.com'],
  nativeCurrency: {
    name: 'Ether',
    symbol: 'ETH',
    decimals: 18,
  },
  blockExplorerUrls: [
    'https://basescan.org',
  ],
  blocksPerDay: 43200, // ~2s blocks
  blockTimeSeconds: 2,
  graphQLEndpoints: {
    uniswapV3: 'https://api.studio.thegraph.com/query/48211/uniswap-v3-base/version/latest',
  },
} as const;

// Core Uniswap V3 Contracts on Base Mainnet
export const BASE_CONTRACTS = {
  NONFUNGIBLE_POSITION_MANAGER: '0x03a520b32C04BF3bEEf7BEb72E919cf822Ed34f1',
  SWAP_ROUTER: '0x2626664c2603336E57B271c5C0b26F421741e481',
  FACTORY: '0x33128a8fC17869897dcE68Ed026d694621f6FDfD',
  QUOTER: '0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a',
} as const;

// Common Base Token Addresses
export const BASE_TOKENS = {
  // Wrapped native
  WETH: '0x4200000000000000000000000000000000000006',

  // Stablecoins
  USDC: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
  USDbC: '0xd9aAEc86B65D86f6A7B5B1b0c42FFA531710b6Ca', // Bridged USDC
  DAI: '0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb',

  // Major tokens
  cbETH: '0x2Ae3F1Ec7F1F5012CFEab0185bfc7aa3cf0DEc22',
  TOSHI: '0xAC1Bd2486aAf3B5C0fc3Fd868558b082a531B2B4',
} as const;

/**
 * Ethereum Mainnet Network Configuration
 * Uniswap V3 contract addresses and chain metadata
 */

export const ETHEREUM_CONFIG = {
  chainId: 1,
  chainName: 'Ethereum',
  rpcUrls: [
    'https://eth.llamarpc.com',
    'https://rpc.ankr.com/eth',
    'https://ethereum-rpc.publicnode.com',
  ],
  wsUrls: ['wss://ethereum-rpc.publicnode.com'],
  nativeCurrency: {
    name: 'Ether',
    symbol: 'ETH',
    decimals: 18,
  },
  blockExplorerUrls: [
    'https://etherscan.io',
  ],
  blocksPerDay: 7200, // ~12s blocks
  blockTimeSeconds: 12,
  graphQLEndpoints: {
    uniswapV3: 'https://api.thegraph.com/subgraphs/name/uniswap/uniswap-v3',
  },
} as const;

// Core Uniswap V3 Contracts on Ethereum Mainnet
export const ETHEREUM_CONTRACTS = {
  NONFUNGIBLE_POSITION_MANAGER: '0xC36442b4a4522E871399CD717aBDD847Ab11FE88',
  SWAP_ROUTER: '0xE592427A0AEce92De3Edee1F18E0157C05861564',
  FACTORY: '0x1F98431c8aD98523631AE4a59f267346ea31F984',
  QUOTER: '0xb27308f9F90D607463bb33eA1BeBb41C27CE5AB6',
} as const;

// Common Ethereum Token Addresses
export const ETHEREUM_TOKENS = {
  // Wrapped native
  WETH: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',

  // Stablecoins
  USDC: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
  USDT: '0xdAC17F958D2ee523a2206206994597C13D831ec7',
  DAI: '0x6B175474E89094C44Da98b954EedeAC495271d0F',

  // Major tokens
  WBTC: '0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599',
  UNI: '0x1f9840a85d5aF5bf1D1762F925BDADdC4201F984',
  LINK: '0x514910771AF9Ca656af840dff83E8264EcF986CA',
} as const;

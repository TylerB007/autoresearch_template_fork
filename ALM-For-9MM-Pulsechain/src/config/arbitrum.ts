/**
 * Arbitrum One Network Configuration
 * Supports both Uniswap V3 and PancakeSwap V3 contract addresses
 */

export const ARBITRUM_CONFIG = {
  chainId: 42161,
  chainName: 'Arbitrum One',
  rpcUrls: [
    'https://arb1.arbitrum.io/rpc',
    'https://arbitrum-one-rpc.publicnode.com',
    'https://rpc.ankr.com/arbitrum',
  ],
  wsUrls: ['wss://arbitrum-one-rpc.publicnode.com'],
  nativeCurrency: {
    name: 'Ether',
    symbol: 'ETH',
    decimals: 18,
  },
  blockExplorerUrls: [
    'https://arbiscan.io',
  ],
  blocksPerDay: 345600, // ~0.25s blocks
  blockTimeSeconds: 0.25,
  graphQLEndpoints: {
    uniswapV3: 'https://api.thegraph.com/subgraphs/name/ianlapham/arbitrum-minimal',
  },
} as const;

// Uniswap V3 Contracts on Arbitrum One
export const ARBITRUM_CONTRACTS_UNISWAP = {
  NONFUNGIBLE_POSITION_MANAGER: '0xC36442b4a4522E871399CD717aBDD847Ab11FE88',
  SWAP_ROUTER: '0xE592427A0AEce92De3Edee1F18E0157C05861564',
  FACTORY: '0x1F98431c8aD98523631AE4a59f267346ea31F984',
  QUOTER: '0xb27308f9F90D607463bb33eA1BeBb41C27CE5AB6',
} as const;

// PancakeSwap V3 Contracts on Arbitrum One
export const ARBITRUM_CONTRACTS_PANCAKESWAP = {
  NONFUNGIBLE_POSITION_MANAGER: '0x46A15B0b27311cedF172AB29E4f4766fbE7F4364',
  SWAP_ROUTER: '0x32226588378236Fd0c7c4053c5e94C3d7Bc264bC',
  FACTORY: '0x0BFbCF9fa4f9C56B0F40a671Ad40E0805A091865',
  QUOTER: '0xB048Bbc1Ee6b733FFfCFb9e9CeF7375518e25997',
} as const;

// Common Arbitrum Token Addresses
export const ARBITRUM_TOKENS = {
  // Wrapped native
  WETH: '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1',

  // Stablecoins
  USDC: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831', // Native USDC
  'USDC.e': '0xFF970A61A04b1cA14834A43f5dE4533eBDDB5CC8', // Bridged USDC
  USDT: '0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9',
  DAI: '0xDA10009cBd5D07dd0CeCc66161FC93D7c9000da1',

  // Major tokens
  WBTC: '0x2f2a2543B76A4166549F7aaB2e75Bef0aefC5B0f',
  ARB: '0x912CE59144191C1204E64559FE8253a0e49E6548',
  GMX: '0xfc5A1A6EB076a2C7aD06eD22C90d7E710E35ad0a',
  LINK: '0xf97f4df75117a78c1A5a0DBb814Af92458539FB4',
} as const;

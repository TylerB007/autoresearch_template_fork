/**
 * PulseChain Network Configuration
 * Extracted from TylerB007/main-liquidity-dashboard
 * Sources: config/networks/pulsechain.js, config/chains.js, config/viemChains.js
 */

export const PULSECHAIN_CONFIG = {
  chainId: 369,
  chainName: 'PulseChain',
  rpcUrls: [
    'https://rpc.pulsechain.com',
    'https://rpc-pulsechain.g4mm4.io',
    'https://pulsechain-rpc.publicnode.com'
  ],
  wsUrls: ['wss://rpc.pulsechain.com'],
  nativeCurrency: {
    name: 'Pulse',
    symbol: 'PLS',
    decimals: 18
  },
  blockExplorerUrls: [
    'https://scan.pulsechain.com',
    'https://ipfs.scan.pulsechain.com'
  ],
  ipfsExplorer: 'https://scan.mypinata.cloud/ipfs/bafybeienxyoyrhn5tswclvd3gdjy5mtkkwmu37aqtml6onbf7xnb3o22pe',
  blocksPerDay: 28800, // ~3s blocks
  blockTimeSeconds: 3,
  graphQLEndpoints: {
    '9mmV3': 'https://graph.9mm.pro/subgraphs/name/pulsechain/9mm-v3',
    '9mmV2': 'https://graph.9mm.pro/subgraphs/name/pulsechain/9mm',
    pulsex: 'https://graph.pulsechain.com/subgraphs/name/pulsechain/pulsex',
    blocks: 'https://graph.pulsechain.com/subgraphs/name/pulsechain/blocks'
  }
} as const;

// Token logo CDN URLs keyed by chainId and uppercase symbol.
// Sources:
//   - Trust Wallet GitHub CDN: Ethereum, Base, Arbitrum (checksummed addresses required)
//   - CoinGecko assets CDN: PulseChain, Sonic (Trust Wallet doesn't support these chains)
// Fallback: TokenLogo component renders an initials circle when no URL is found.

const TW = 'https://raw.githubusercontent.com/trustwallet/assets/master/blockchains';

const TOKEN_LOGOS: Record<number, Record<string, string>> = {
  // PulseChain (369) — CoinGecko small images
  369: {
    HEX:  'https://assets.coingecko.com/coins/images/10103/small/HEX-logo.png',
    WPLS: 'https://assets.coingecko.com/coins/images/30245/small/PLS.png',
    PLS:  'https://assets.coingecko.com/coins/images/30245/small/PLS.png',
    PLSX: 'https://assets.coingecko.com/coins/images/29926/small/plsx.png',
    INC:  'https://assets.coingecko.com/coins/images/30109/small/INC.png',
    WETH: `${TW}/ethereum/assets/0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2/logo.png`,
    WBTC: `${TW}/ethereum/assets/0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599/logo.png`,
    DAI:  `${TW}/ethereum/assets/0x6B175474E89094C44Da98b954EedeAC495271d0F/logo.png`,
    USDC: 'https://assets.coingecko.com/coins/images/6319/small/usdc.png',
    USDT: 'https://assets.coingecko.com/coins/images/325/small/Tether.png',
  },

  // Ethereum mainnet (1) — Trust Wallet CDN
  1: {
    WETH: `${TW}/ethereum/assets/0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2/logo.png`,
    USDC: `${TW}/ethereum/assets/0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48/logo.png`,
    USDT: `${TW}/ethereum/assets/0xdAC17F958D2ee523a2206206994597C13D831ec7/logo.png`,
    WBTC: `${TW}/ethereum/assets/0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599/logo.png`,
    DAI:  `${TW}/ethereum/assets/0x6B175474E89094C44Da98b954EedeAC495271d0F/logo.png`,
    LINK: `${TW}/ethereum/assets/0x514910771AF9Ca656af840dff83E8264EcF986CA/logo.png`,
    UNI:  `${TW}/ethereum/assets/0x1f9840a85d5aF5bf1D1762F925BDADdC4201F984/logo.png`,
  },

  // Base (8453) — Trust Wallet CDN
  8453: {
    WETH: `${TW}/base/assets/0x4200000000000000000000000000000000000006/logo.png`,
    USDC: `${TW}/base/assets/0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913/logo.png`,
    CBBTC: `${TW}/base/assets/0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf/logo.png`,
    AERO: `${TW}/base/assets/0x940181a94A35A4569E4529A3CDfB74e38FD98631/logo.png`,
  },

  // Arbitrum One (42161) — Trust Wallet CDN
  42161: {
    WETH: `${TW}/arbitrum/assets/0x82aF49447D8a07e3bd95BD0d56f35241523fBab1/logo.png`,
    USDC: `${TW}/arbitrum/assets/0xaf88d065e77c8cC2239327C5EDb3A432268e5831/logo.png`,
    'USDC.E': `${TW}/arbitrum/assets/0xFF970A61A04b1cA14834A43f5dE4533eBDDB5CC8/logo.png`,
    USDT: `${TW}/arbitrum/assets/0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9/logo.png`,
    ARB:  `${TW}/arbitrum/assets/0x912CE59144191C1204E64559FE8253a0e49E6548/logo.png`,
    WBTC: `${TW}/arbitrum/assets/0x2f2a2543B76A4166549F7aaB2e75Bef0aefC5B0f/logo.png`,
    LINK: `${TW}/arbitrum/assets/0xf97f4df75117a78c1A5a0DBb814Af92458539FB4/logo.png`,
  },

  // Sonic (146) — CoinGecko small images
  146: {
    WS:   'https://assets.coingecko.com/coins/images/38108/small/sonic_logo.png',
    USDC: 'https://assets.coingecko.com/coins/images/6319/small/usdc.png',
    WETH: `${TW}/ethereum/assets/0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2/logo.png`,
    WBTC: `${TW}/ethereum/assets/0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599/logo.png`,
  },
};

export function getTokenLogoUrl(chainId: number | undefined, symbol: string): string | undefined {
  if (chainId == null) return undefined;
  return TOKEN_LOGOS[chainId]?.[symbol.toUpperCase()];
}

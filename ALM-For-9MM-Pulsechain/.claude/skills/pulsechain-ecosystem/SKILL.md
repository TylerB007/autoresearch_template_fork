---
name: pulsechain-ecosystem
description: Reference skill for building read-only analytics, LP tracking, and DeFi dashboard applications on PulseChain (chain ID 369). Covers RPC setup, DEX contracts (PulseX V1/V2, 9mm V3), token addresses, price fetching, V3 fee math, and known pitfalls refined through production debugging. Load when working with PulseChain data, LP positions, or DeFi integrations on chain 369.
---

# PulseChain Ecosystem Skill

## Purpose

Load this skill when an agent needs to:

- Build or modify read-only analytics for PulseChain (chain ID 369)
- Track Uniswap V3-style concentrated liquidity positions on PulseChain DEXs
- Fetch token prices, pool data, or on-chain state from PulseChain
- Configure viem/ethers clients for PulseChain RPC
- Work with PulseX (V1/V2) or 9mm (V3) DEX contracts
- Calculate LP fees, impermanent loss, or position values on PulseChain
- Debug PulseChain-specific issues (price coverage gaps, RPC CORS, explorer API incompatibilities)

This skill encodes battle-tested patterns from a production multi-chain LP dashboard that has been live-debugged against real PulseChain positions.

---

## Tech Stack

| Layer | Technology | Notes |
|-------|-----------|-------|
| **Contract reads** | viem (preferred) | Use `createPublicClient` with rate-limited transport |
| **Fallback** | ethers.js v6 | Supported but viem is primary |
| **Frontend** | React 19 + Next.js 16 | All components require `'use client'` directive |
| **Styling** | Tailwind CSS | Theme-aware classes (`text-theme-*`, `bg-theme-*`) |
| **Data fetching** | TanStack Query | Cache and deduplicate RPC calls |
| **Prices** | DexScreener API (primary) | DefiLlama for historical, on-chain reserves as fallback |
| **Indexing** | The Graph subgraphs | Available for 9mm V3 and PulseX; unreliable — always have RPC fallback |
| **Financial math** | BigInt only | Never use native JS floats for token amounts or fee calculations |

---

## Chain Configuration

```
Chain ID:        369
Chain Name:      PulseChain
Native Token:    PLS (18 decimals)
DexScreener ID:  "pulsechain"
Default Chain:   Yes (this dashboard defaults to 369)
```

### RPC Endpoints

| Endpoint | Notes |
|----------|-------|
| `https://rpc-pulsechain.g4mm4.io` | **Primary** — CORS-friendly, works from browser |
| `https://rpc.pulsechain.com` | Official fallback — may have CORS issues from localhost |
| Custom via `NEXT_PUBLIC_PULSE_RPC_URL` | Environment variable override, takes highest priority |

**CORS Warning**: The official `rpc.pulsechain.com` can block browser-origin requests. Always use `rpc-pulsechain.g4mm4.io` as the primary RPC for client-side applications. The `NEXT_PUBLIC_PULSE_RPC_URL` env var overrides all defaults when set.

### Block Explorer

| Explorer | URL | API Support |
|----------|-----|-------------|
| PulseChain Scan | `https://scan.pulsechain.com` | **No Etherscan-style API** |
| IPFS Mirror | `https://ipfs.scan.pulsechain.com` | Same limitations |
| 9mm Explorer | `https://scan.mypinata.cloud/ipfs/bafybeienxyoyrhn5tswclvd3gdjy5mtkkwmu37aqtml6onbf7xnb3o22pe` | IPFS-hosted |

**Critical Pitfall**: PulseChain's BlockScout explorer does NOT support Etherscan-compatible API endpoints like `tokennfttx`, `tokentx`, or `txlistinternal`. Attempting these calls returns HTTP 400. Do not include PulseChain in any `BLOCK_EXPLORER_APIS` mapping. Use direct RPC log scanning instead.

---

## Key Protocol Contracts

### Wrapped Native Token (WPLS)

```
Address:  0xA1077a294dDE1B09bB078844df40758a5D0f9a27
Symbol:   WPLS
Decimals: 18
```

WPLS wrapping/unwrapping is required for native PLS in all DEX interactions. Standard WETH9 ABI applies.

### 9mm DEX (Uniswap V3 Fork) — Primary V3 Protocol

```
Factory:            0xe50dbdc88e87a2c92984d794bcf3d1d76f619c68
Router:             0xeB45a3c4aedd0F47F345fB4c8A1802BB5740d725
Position Manager:   0xCC05bf158202b4F461Ede8843d76dcd7Bbad07f2
Quoter V2:          0x250D0399E3f363d98f8A27942712d59248C33007
Deployer:           0x00f37661fa1b2b8a530cfb7b6d5a5a6aed74177b
```

**Fee Tiers** (differ from standard Uniswap V3):

| Fee (bps) | Percentage | Tick Spacing | Notes |
|-----------|-----------|--------------|-------|
| 100 | 0.01% | 1 | Stable pairs |
| 500 | 0.05% | 10 | Low volatility |
| 2500 | **0.25%** | **50** | **Different from Uniswap's 0.30% / tick spacing 60** |
| 10000 | 1.00% | 200 | Exotic pairs |

**9mm uses 2500 (0.25%) where Uniswap uses 3000 (0.30%)**. The tick spacing for this tier is 50, not 60. This affects pool address computation and tick alignment. Always verify fee tiers against the 9mm factory, not Uniswap defaults.

### PulseX V1 (Uniswap V2 Fork)

```
Factory:       0x1715a3E4A142d8b698131108995174F37aEBA10D
Router:        0x98bf93ebf5c380C0e6Ae8e192A7e2AE08edAcc02
Init Code Hash: 0x2ad889f82040abccb2649ea6a874796c1601fb67f91a747a80e08860c73ddf24
Fee:           0.29% (29 bps)
```

### PulseX V2 (Uniswap V2 Fork)

```
Factory:       0x29eA7545DEf87022BAdc76323F373EA1e707C523
Router:        0x165C3410fC91EF562C50559f7d2289fEbed552d9
Init Code Hash: 0x887bf2e98c2d4b43a648d75f8f991c28d3d5ebf8de9f55c45e01b8d86f130e49
Fee:           0.29% (29 bps)
```

**Important**: PulseX V1 and V2 have **different factory and router addresses**. Always confirm which version a pool belongs to. The init code hashes differ — pool address derivation will fail if you use the wrong hash.

### PHUX (Solidly/ve(3,3) Fork)

```
Factory:  0xE3700d99374b60e0Bf64e734D6Ad5eC636e37834
Router:   0x60ae616a2155Ee0d9A68541Ba4544862310933d4
```

PHUX supports both volatile (standard AMM) and stable (curve-style) pool types. Uses veNFT gauge voting for emissions.

### Multicall3

```
Address: 0xcA11bde05977b3631167028862bE2a173976CA11
```

Same address as Ethereum and most EVM chains. Batch multiple `readContract` calls into a single RPC request.

### Common Stablecoins

| Token | Address | Decimals | Notes |
|-------|---------|----------|-------|
| DAI | `0xefD766cCb38EaF1dfd701853bFCe31359239F305` | 18 | Bridged from Ethereum |
| USDC | `0x15D38573d2feeb82e7ad5187aB8c1D52810B1f07` | **6** | Bridged from Ethereum |
| USDT | `0x0Cb6F5a34ad42ec934882A05265A7d5F59b51A2f` | **6** | Bridged from Ethereum |

**Decimal Warning**: USDC and USDT are 6 decimals, not 18. Always call `decimals()` on-chain — never assume 18.

### Major PulseChain Tokens

| Token | Address | Decimals |
|-------|---------|----------|
| WPLS | `0xA1077a294dDE1B09bB078844df40758a5D0f9a27` | 18 |
| PLSX | `0x95B303987A60C71504D99Aa1b13B4DA07b0790ab` | 18 |
| HEX | `0x2b591e99afE9f32eAA6214f7B7629768c40Eeb39` | **8** |
| INC | `0x2fa878Ab3F87CC1C9737Fc071108F904c0B0C95d` | 18 |

**HEX is 8 decimals** — this is the most common source of math errors on PulseChain. Triple-check decimal handling when HEX is involved.

---

## LP Pool Patterns

### Reading Uniswap V2-Style Pool Reserves (PulseX)

```typescript
import { createPublicClient, http, parseAbi } from 'viem';

const PAIR_ABI = parseAbi([
  'function getReserves() view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)',
  'function token0() view returns (address)',
  'function token1() view returns (address)',
]);

async function getV2Reserves(client, pairAddress) {
  const [reserves, token0, token1] = await Promise.all([
    client.readContract({
      address: pairAddress,
      abi: PAIR_ABI,
      functionName: 'getReserves',
    }),
    client.readContract({
      address: pairAddress,
      abi: PAIR_ABI,
      functionName: 'token0',
    }),
    client.readContract({
      address: pairAddress,
      abi: PAIR_ABI,
      functionName: 'token1',
    }),
  ]);

  return {
    reserve0: reserves[0],  // BigInt
    reserve1: reserves[1],  // BigInt
    token0,
    token1,
  };
}
```

### Reading Uniswap V3-Style Positions (9mm)

```typescript
const POSITION_MANAGER_ABI = parseAbi([
  'function positions(uint256 tokenId) view returns (uint96 nonce, address operator, address token0, address token1, uint24 fee, int24 tickLower, int24 tickUpper, uint128 liquidity, uint256 feeGrowthInside0LastX128, uint256 feeGrowthInside1LastX128, uint128 tokensOwed0, uint128 tokensOwed1)',
  'function balanceOf(address owner) view returns (uint256)',
  'function tokenOfOwnerByIndex(address owner, uint256 index) view returns (uint256)',
]);

const POOL_ABI = parseAbi([
  'function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)',
  'function feeGrowthGlobal0X128() view returns (uint256)',
  'function feeGrowthGlobal1X128() view returns (uint256)',
  'function ticks(int24 tick) view returns (uint128 liquidityGross, int128 liquidityNet, uint256 feeGrowthOutside0X128, uint256 feeGrowthOutside1X128, int56 tickCumulativeOutside, uint160 secondsPerLiquidityOutsideX128, uint32 secondsOutside, bool initialized)',
  'function liquidity() view returns (uint128)',
]);

// Read position + pool data with multicall (1 RPC call instead of 6)
async function getV3PositionData(client, tokenId, positionManagerAddress) {
  // Step 1: Read position data
  const position = await client.readContract({
    address: positionManagerAddress,
    abi: POSITION_MANAGER_ABI,
    functionName: 'positions',
    args: [BigInt(tokenId)],
  });

  // Step 2: Derive pool address from factory
  // Step 3: Batch pool reads via multicall
  const poolData = await client.multicall({
    contracts: [
      { address: poolAddress, abi: POOL_ABI, functionName: 'slot0' },
      { address: poolAddress, abi: POOL_ABI, functionName: 'feeGrowthGlobal0X128' },
      { address: poolAddress, abi: POOL_ABI, functionName: 'feeGrowthGlobal1X128' },
      { address: poolAddress, abi: POOL_ABI, functionName: 'ticks', args: [position.tickLower] },
      { address: poolAddress, abi: POOL_ABI, functionName: 'ticks', args: [position.tickUpper] },
    ],
    allowFailure: false,
  });

  return { position, slot0: poolData[0], ...poolData };
}
```

### Calculating Token Prices from V2 Reserves

```typescript
function calculatePriceFromReserves(
  reserve0: bigint,
  reserve1: bigint,
  decimals0: number,
  decimals1: number
): number {
  // Price of token0 in terms of token1
  // Use BigInt math until final display conversion
  const scale0 = 10n ** BigInt(decimals0);
  const scale1 = 10n ** BigInt(decimals1);

  // Normalize to same decimal scale, then convert to float only at the end
  const price = (Number(reserve1) / Number(scale1)) / (Number(reserve0) / Number(scale0));
  return price;
}
```

### Handling Decimal Mismatches

```typescript
// CRITICAL: Never assume 18 decimals. Always fetch on-chain.
const ERC20_ABI = parseAbi([
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)',
  'function balanceOf(address) view returns (uint256)',
]);

// Common PulseChain decimal values:
// PLS/WPLS: 18, PLSX: 18, INC: 18, DAI: 18
// USDC: 6, USDT: 6
// HEX: 8 (frequently causes bugs!)

// Safe token amount formatting
function formatTokenAmount(rawAmount: bigint, decimals: number): string {
  const divisor = 10n ** BigInt(decimals);
  const whole = rawAmount / divisor;
  const fraction = rawAmount % divisor;
  const fractionStr = fraction.toString().padStart(decimals, '0');
  return `${whole}.${fractionStr}`;
}
```

### Micro-Priced Token Handling

PLS trades at ~$0.00007. Many PulseChain tokens are micro-priced. Rules:

1. **Always use BigInt** for contract calls and intermediate math
2. **Never use `Number()` or `parseFloat()`** until final display formatting
3. Use subscript notation for display (e.g., `0.0₅123` means `0.00000123`)
4. When calculating USD values, multiply price * amount using string-based decimal libraries
5. Guard against `NaN` propagation — micro-prices multiplied by large token amounts can overflow JS `Number`

```typescript
// BAD: loses precision for micro-priced tokens
const value = Number(rawAmount) * priceUSD;  // NaN or Infinity risk

// GOOD: use BigInt until display
import Decimal from 'decimal.js';
const amount = new Decimal(rawAmount.toString()).div(new Decimal(10).pow(decimals));
const value = amount.mul(new Decimal(priceUSD.toString()));
```

---

## V3 Fee Calculation (Critical)

Uniswap V3 unclaimed fees have **two components** — both must be included:

1. **`tokensOwed0/1`** — Fees already marked as collectable in the position NFT
2. **Uncollected fee growth** — Fees accrued since last collect, calculated from `feeGrowthInside` delta

**Using only `tokensOwed` will significantly underreport actual fees.** This is the #1 fee calculation bug.

```typescript
function calculateAccumulatedFees(params: {
  liquidity: bigint;
  tickLower: number;
  tickUpper: number;
  currentTick: number;
  feeGrowthGlobal0X128: bigint;
  feeGrowthGlobal1X128: bigint;
  feeGrowthOutsideLower0X128: bigint;
  feeGrowthOutsideLower1X128: bigint;
  feeGrowthOutsideUpper0X128: bigint;
  feeGrowthOutsideUpper1X128: bigint;
  feeGrowthInside0LastX128: bigint;
  feeGrowthInside1LastX128: bigint;
  tokensOwed0: bigint;
  tokensOwed1: bigint;
}) {
  const Q128 = 2n ** 128n;
  const MAX_UINT256 = 2n ** 256n;

  // Modular subtraction to handle uint256 underflow wrapping
  const wrapSub = (a: bigint, b: bigint) => ((a - b) % MAX_UINT256 + MAX_UINT256) % MAX_UINT256;

  // Fee growth below lower tick
  let feeGrowthBelow0: bigint, feeGrowthBelow1: bigint;
  if (params.currentTick >= params.tickLower) {
    feeGrowthBelow0 = params.feeGrowthOutsideLower0X128;
    feeGrowthBelow1 = params.feeGrowthOutsideLower1X128;
  } else {
    feeGrowthBelow0 = wrapSub(params.feeGrowthGlobal0X128, params.feeGrowthOutsideLower0X128);
    feeGrowthBelow1 = wrapSub(params.feeGrowthGlobal1X128, params.feeGrowthOutsideLower1X128);
  }

  // Fee growth above upper tick
  let feeGrowthAbove0: bigint, feeGrowthAbove1: bigint;
  if (params.currentTick < params.tickUpper) {
    feeGrowthAbove0 = params.feeGrowthOutsideUpper0X128;
    feeGrowthAbove1 = params.feeGrowthOutsideUpper1X128;
  } else {
    feeGrowthAbove0 = wrapSub(params.feeGrowthGlobal0X128, params.feeGrowthOutsideUpper0X128);
    feeGrowthAbove1 = wrapSub(params.feeGrowthGlobal1X128, params.feeGrowthOutsideUpper1X128);
  }

  // Fee growth inside position range
  const feeGrowthInside0 = wrapSub(wrapSub(params.feeGrowthGlobal0X128, feeGrowthBelow0), feeGrowthAbove0);
  const feeGrowthInside1 = wrapSub(wrapSub(params.feeGrowthGlobal1X128, feeGrowthBelow1), feeGrowthAbove1);

  // Delta since last interaction
  const delta0 = wrapSub(feeGrowthInside0, params.feeGrowthInside0LastX128);
  const delta1 = wrapSub(feeGrowthInside1, params.feeGrowthInside1LastX128);

  // Uncollected + already-owed = total accumulated fees
  const totalFees0 = (delta0 * params.liquidity) / Q128 + params.tokensOwed0;
  const totalFees1 = (delta1 * params.liquidity) / Q128 + params.tokensOwed1;

  return { accumulatedFees0: totalFees0, accumulatedFees1: totalFees1 };
}
```

### Price Denomination Warning

- `position.currentPrice` is the **pool tick price** = `token1/token0` ratio, NOT a USD value
- `minPrice`, `maxPrice`, `entryPrice` are also token ratio values
- **Never prefix ratio-based prices with `$`** — display as `{symbol1}/{symbol0}` (e.g., "0.00045 WPLS/HEX")
- USD values are separate fields: `price0USD`, `price1USD`, `feesUSD` — these can use `$`

---

## Price Data Patterns

### DexScreener API (Primary)

```
Endpoint: https://api.dexscreener.com/latest/dex/tokens/{address}
Rate Limit: ~300 requests/minute
Batch: Up to 30 token addresses comma-separated per request
```

```typescript
const CHAIN_NAME = 'pulsechain'; // DexScreener uses lowercase chain names

async function fetchPulseChainPrice(tokenAddress: string): Promise<number | null> {
  const url = `https://api.dexscreener.com/latest/dex/tokens/${tokenAddress}`;
  const response = await fetch(url, { signal: AbortSignal.timeout(5000) });
  const data = await response.json();

  if (!data.pairs) return null;

  // CRITICAL: Filter by chainId — DexScreener returns cross-chain results
  const pulseChainPair = data.pairs.find(
    (p) => p.chainId === 'pulsechain' && p.priceUsd
  );

  return pulseChainPair ? Number(pulseChainPair.priceUsd) : null;
}

// Batch fetching (production pattern)
async function fetchBatchPrices(tokenAddresses: string[]): Promise<Record<string, number>> {
  const prices: Record<string, number> = {};
  const batchSize = 30; // URL length safety limit

  const batches: string[][] = [];
  for (let i = 0; i < tokenAddresses.length; i += batchSize) {
    batches.push(tokenAddresses.slice(i, i + batchSize));
  }

  await Promise.all(batches.map(async (batch) => {
    try {
      const url = `https://api.dexscreener.com/latest/dex/tokens/${batch.join(',')}`;
      const response = await fetch(url, { signal: AbortSignal.timeout(5000) });
      const data = await response.json();

      data.pairs?.forEach((pair) => {
        if (pair.chainId === 'pulsechain' && pair.priceUsd) {
          const addr = pair.baseToken?.address?.toLowerCase();
          if (addr && !prices[addr]) {
            prices[addr] = Number(pair.priceUsd);
          }
        }
      });
    } catch {
      // Individual batch failure doesn't break other batches
    }
  }));

  return prices;
}
```

### DefiLlama (Historical Prices)

```
Endpoint: https://coins.llama.fi/prices/historical/{timestamp}/pulsechain:{address}
```

**Known Coverage Gap**: DefiLlama has limited PulseChain token coverage. The following tokens have NO historical price data:
- ICSA, iBurn, eHEX (no direct coverage)
- Many smaller PulseChain-native tokens

Tokens WITH coverage: HEX, WPLS, PLSX, DAI, USDC

**Fallback Strategy** (3-tier, refined through production debugging):
1. DefiLlama historical prices (preferred for accuracy)
2. DexScreener current prices (approximate — not historical)
3. Anchor token derivation: if one token in a pair is priced, derive the other from the pool's reserve ratio

### On-Chain Reserve Fallback

When both APIs fail, calculate price from V2 pool reserves:

```typescript
// If token0 is a known stablecoin (DAI, USDC), derive token1 price
if (isStablecoin(token0Address)) {
  const priceToken1InToken0 = calculatePriceFromReserves(reserve0, reserve1, decimals0, decimals1);
  const priceToken1USD = priceToken1InToken0; // token0 ≈ $1.00
}
```

---

## Viem Client Setup (Production Pattern)

```typescript
import { createPublicClient, http, defineChain } from 'viem';

// Define PulseChain (not in viem's default chain list)
export const pulsechain = defineChain({
  id: 369,
  name: 'PulseChain',
  nativeCurrency: { name: 'Pulse', symbol: 'PLS', decimals: 18 },
  rpcUrls: {
    default: { http: ['https://rpc-pulsechain.g4mm4.io'] },
    public: { http: ['https://rpc.pulsechain.com'] },
  },
  blockExplorers: {
    default: { name: 'PulseChain Scan', url: 'https://scan.pulsechain.com' },
  },
});

// Rate-limited client with batching (production pattern)
class RateLimiter {
  private tokens: number;
  private lastRefill: number;
  private queue: Promise<void> = Promise.resolve();

  constructor(private tokensPerSecond: number) {
    this.tokens = tokensPerSecond;
    this.lastRefill = Date.now();
  }

  acquire(): Promise<void> {
    this.queue = this.queue.then(() => this.acquireToken());
    return this.queue;
  }

  private async acquireToken(): Promise<void> {
    const now = Date.now();
    const elapsed = (now - this.lastRefill) / 1000;
    this.tokens = Math.min(this.tokensPerSecond, this.tokens + elapsed * this.tokensPerSecond);
    this.lastRefill = now;

    if (this.tokens < 1) {
      const waitMs = ((1 - this.tokens) / this.tokensPerSecond) * 1000;
      await new Promise((r) => setTimeout(r, waitMs));
      this.tokens = 1; // Refilled after wait
      this.lastRefill = Date.now();
    }
    this.tokens -= 1;
  }
}

// Singleton client factory
const clientCache = new Map<number, ReturnType<typeof createPublicClient>>();

export function getPulseChainClient() {
  if (clientCache.has(369)) return clientCache.get(369)!;

  const customRpc = process.env.NEXT_PUBLIC_PULSE_RPC_URL;
  const rpcUrl = customRpc || 'https://rpc-pulsechain.g4mm4.io';

  const client = createPublicClient({
    chain: pulsechain,
    transport: http(rpcUrl, {
      batch: { batchSize: 100, wait: 100 },  // Collect calls for 100ms, batch up to 100
      retryCount: 3,
      retryDelay: ({ count }) => Math.min(1000 * 2 ** count, 30000),  // Exponential backoff
      timeout: 30000,
    }),
  });

  clientCache.set(369, client);
  return client;
}
```

---

## Reusable Code Patterns

### 1. Reading ERC20 Token Balance

```typescript
const balance = await client.readContract({
  address: tokenAddress,
  abi: parseAbi(['function balanceOf(address) view returns (uint256)']),
  functionName: 'balanceOf',
  args: [walletAddress],
});
// balance is BigInt — format with token's decimals before display
```

### 2. Multicall Pattern for Batching Reads

```typescript
// Batch 3 token metadata reads into 1 RPC call
const results = await client.multicall({
  contracts: [
    { address: tokenAddr, abi: ERC20_ABI, functionName: 'symbol' },
    { address: tokenAddr, abi: ERC20_ABI, functionName: 'decimals' },
    { address: tokenAddr, abi: ERC20_ABI, functionName: 'balanceOf', args: [wallet] },
  ],
  allowFailure: true, // Individual call failures don't break the batch
});

// Each result: { status: 'success', result: value } or { status: 'failure', error }
const symbol = results[0].status === 'success' ? results[0].result : 'UNK';
const decimals = results[1].status === 'success' ? Number(results[1].result) : 18;
const balance = results[2].status === 'success' ? results[2].result : 0n;
```

### 3. Token Metadata with Multi-Tier Cache

```typescript
// Priority: hardcoded registry → localStorage cache → RPC call
async function getTokenMetadata(address: string, client: PublicClient) {
  // Tier 1: Known tokens (instant)
  const known = KNOWN_TOKENS[address.toLowerCase()];
  if (known) return known;

  // Tier 2: localStorage cache (fast, persistent)
  const cacheKey = `token-meta-369-${address.toLowerCase()}`;
  const cached = localStorage.getItem(cacheKey);
  if (cached) return JSON.parse(cached);

  // Tier 3: RPC call (slow but accurate)
  const [symbol, decimals, name] = await Promise.all([
    client.readContract({ address, abi: ERC20_ABI, functionName: 'symbol' }).catch(() => 'UNK'),
    client.readContract({ address, abi: ERC20_ABI, functionName: 'decimals' }).catch(() => 18),
    client.readContract({ address, abi: ERC20_ABI, functionName: 'name' }).catch(() => 'Unknown'),
  ]);

  const meta = { address, symbol, decimals: Number(decimals), name };
  localStorage.setItem(cacheKey, JSON.stringify(meta));
  return meta;
}
```

### 4. eth_getLogs Chunking for PulseChain

```typescript
// PulseChain supports up to 5,000 blocks per eth_getLogs request (vs 1,000 on Ethereum)
const CHUNK_SIZE = 5000n;

async function getLogsChunked(client, params, fromBlock, toBlock) {
  const logs = [];
  let current = fromBlock;

  while (current <= toBlock) {
    const end = current + CHUNK_SIZE > toBlock ? toBlock : current + CHUNK_SIZE;
    const chunk = await client.getLogs({
      ...params,
      fromBlock: current,
      toBlock: end,
    });
    logs.push(...chunk);
    current = end + 1n;
  }

  return logs;
}
```

---

## Subgraph / Indexer Endpoints

| Protocol | Endpoint | Type |
|----------|----------|------|
| 9mm V3 | `https://graph.9mm.pro/subgraphs/name/pulsechain/9mm-v3` | Uniswap V3 schema |
| 9mm V2 | `https://graph.9mm.pro/subgraphs/name/pulsechain/9mm` | Uniswap V2 schema |
| PulseX | `https://graph.pulsechain.com/subgraphs/name/pulsechain/pulsex` | Uniswap V2 schema |
| Blocks | `https://graph.pulsechain.com/subgraphs/name/pulsechain/blocks` | Block timestamps |

**Reliability Warning**: PulseChain subgraphs can be unreliable — they go down, lag behind chain head, or return stale data without warning. Always implement RPC fallback for critical paths. The production dashboard uses a hybrid model: subgraphs for discovery, RPC for accuracy.

**GraphQL is gated**: In this codebase, subgraph fetching requires `NEXT_PUBLIC_ENABLE_GRAPHQL=true` env var. It's off by default because direct RPC reads are more reliable.

---

## Common Pitfalls (Learned from Production)

### 1. PulseChain is an Ethereum Fork — But Not Identical

- Most Ethereum tooling works with `chainId: 369`
- Multicall3 is at the same address (`0xcA11...CA11`)
- Standard ERC20/V3 ABIs work unchanged
- **But**: Block explorer APIs are incompatible (BlockScout, not Etherscan)
- **But**: Some RPC endpoints block browser CORS
- **But**: Token price coverage is fragmented

### 2. Non-Standard Decimals

Always call `decimals()` on-contract. Common traps:
- HEX: **8 decimals** (looks like 18, math is wrong by 10^10)
- USDC/USDT: **6 decimals** (bridged from Ethereum, retain original decimals)
- Most other tokens: 18 decimals

### 3. 9mm Fee Tier Difference

9mm uses **2500 bps (0.25%)** where standard Uniswap V3 uses 3000 bps (0.30%). The tick spacing is 50 (not 60). This affects:
- Pool address derivation via CREATE2
- Tick alignment validation
- Fee calculations

### 4. Position ID Composite Format

When tracking positions in a database across multiple chains/DEXs, use composite IDs:
```
Format: {chainId}-{dex}-{tokenId}
Example: 369-9mm-155016
```
Bare numeric IDs (`155016`) collide across chains. This caused real bugs where fee history queries returned 0 results because the database stored composite IDs but the query used bare IDs.

### 5. DefiLlama Price Gaps

DefiLlama has poor coverage for many PulseChain tokens. In production:
- 19 closed PulseChain positions couldn't be backfilled (0% success rate for exit prices)
- ICSA tokens have zero coverage on any price API
- Workaround: anchor token derivation (price one token from a known token + pool ratio)

### 6. BlockScout API Incompatibility

PulseChain's explorer (scan.pulsechain.com) runs BlockScout, which does NOT support:
- `tokennfttx` (NFT transfer history)
- `tokentx` (ERC20 transfer history)
- Other Etherscan-compatible API module endpoints

These return HTTP 400. Use direct RPC `eth_getLogs` scanning instead.

### 7. RPC CORS from Browser

`rpc.pulsechain.com` sometimes blocks CORS from `localhost` origins. This causes infinite error loops in browser-based apps. Use `rpc-pulsechain.g4mm4.io` as the primary browser RPC.

### 8. Coinbase/CEX Integration

Coinbase API does not support PulseChain. Any CEX hedge tracking or API integration will return network errors for PulseChain positions. Silence these errors in the UI rather than displaying them.

### 9. Gas Limit Estimates

```
Mint (add liquidity):   350,000 gas
Burn (remove):          250,000 gas
Collect (claim fees):   200,000 gas
Swap:                   150,000 gas
ERC20 Approve:           50,000 gas
```

### 10. WPLS Wrapping

Native PLS must be wrapped to WPLS for all DEX interactions. The WPLS contract follows the standard WETH9 interface:
```typescript
// Wrap: send PLS value to WPLS contract
await walletClient.sendTransaction({
  to: '0xA1077a294dDE1B09bB078844df40758a5D0f9a27',
  value: parseEther('1000'),
});

// Unwrap: call withdraw()
await walletClient.writeContract({
  address: '0xA1077a294dDE1B09bB078844df40758a5D0f9a27',
  abi: parseAbi(['function withdraw(uint256 wad)']),
  functionName: 'withdraw',
  args: [parseEther('1000')],
});
```

---

## File Structure Convention

When building PulseChain analytics applications, follow this structure:

```
lib/
  pulsechain/
    client.ts          — Viem public client setup with rate limiting
    tokens.ts          — Token addresses, decimals, known metadata
    protocols.ts       — DEX contract addresses, ABIs, fee tiers
    prices.ts          — DexScreener + DefiLlama + on-chain price fetching
    pools.ts           — Pool reserve reading, position fetching, fee calculation
config/
  chains.js            — Chain metadata (ID, name, RPC, explorer)
  networks/
    pulsechain.js      — Extended PulseChain config (stablecoins, subgraphs)
  dexs/
    ninemm.js          — 9mm V3 contracts and fee tiers
    pulsex.js          — PulseX V1/V2 contracts and init code hashes
services/
  dexscreener.js       — Price API with batching and error isolation
  TokenService.js      — Multi-tier token metadata resolution
hooks/
  useLiquidityData.ts  — Primary data hook (positions + prices + fees)
  useTokenPrices.ts    — Price fetching with TanStack Query caching
components/
  PositionCard.tsx     — Position display with fee/value breakdown
  PoolTable.tsx        — Pool listing with reserves and TVL
utils/
  math.js              — V3 fee calculation, tick math, BigInt helpers
  formatters.js        — Number formatting for micro-prices and large values
```

---

## Environment Variables

```bash
# Required
NEXT_PUBLIC_SUPABASE_URL=            # If using Supabase for position tracking
NEXT_PUBLIC_SUPABASE_ANON_KEY=       # Supabase anonymous key

# PulseChain-specific (optional)
NEXT_PUBLIC_PULSE_RPC_URL=           # Custom RPC (overrides default public endpoints)
NEXT_PUBLIC_ENABLED_CHAINS=1,369     # Filter to Ethereum + PulseChain
NEXT_PUBLIC_ENABLE_GRAPHQL=false     # Enable subgraph fetching (off by default for reliability)

# General
NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID=  # WalletConnect (optional, has fallback)
NEXT_PUBLIC_LOG_LEVEL=INFO             # DEBUG for verbose RPC/price logging
```

---

## When to Combine with Other Skills

| Skill | Use When |
|-------|----------|
| `v3-math-verifier` | Editing fee calculation logic, IL math, or rendering fee data |
| `frontend-design` | Building dashboard UI components or data visualizations |
| `institutional-ui-enforcer` | Applying institutional design patterns (compact, data-dense layouts) |
| `supabase-backfill-runner` | Running historical data backfills or debugging database RPCs |
| `dashboard-memory-manager` | Dev server memory issues or orphaned process cleanup |
| `webapp-testing` | Testing PulseChain UI flows with Playwright |

---

## Quick Reference Card

```
Chain ID:           369
Native:             PLS (18 dec)
Wrapped:            0xA1077a294dDE1B09bB078844df40758a5D0f9a27 (WPLS)
Multicall3:         0xcA11bde05977b3631167028862bE2a173976CA11
RPC (browser):      https://rpc-pulsechain.g4mm4.io
RPC (server):       https://rpc.pulsechain.com
Explorer:           https://scan.pulsechain.com
DexScreener chain:  "pulsechain"

9mm V3 Factory:     0xe50dbdc88e87a2c92984d794bcf3d1d76f619c68
9mm V3 Router:      0xeB45a3c4aedd0F47F345fB4c8A1802BB5740d725
9mm V3 PosMgr:      0xCC05bf158202b4F461Ede8843d76dcd7Bbad07f2
9mm V3 Quoter:      0x250D0399E3f363d98f8A27942712d59248C33007
9mm Fee Tiers:      100, 500, 2500, 10000 (NOT 3000!)

PulseX V1 Factory:  0x1715a3E4A142d8b698131108995174F37aEBA10D
PulseX V1 Router:   0x98bf93ebf5c380C0e6Ae8e192A7e2AE08edAcc02
PulseX V2 Factory:  0x29eA7545DEf87022BAdc76323F373EA1e707C523
PulseX V2 Router:   0x165C3410fC91EF562C50559f7d2289fEbed552d9

DAI:                0xefD766cCb38EaF1dfd701853bFCe31359239F305 (18 dec)
USDC:               0x15D38573d2feeb82e7ad5187aB8c1D52810B1f07 (6 dec)
HEX:                0x2b591e99afE9f32eAA6214f7B7629768c40Eeb39 (8 dec)
PLSX:               0x95B303987A60C71504D99Aa1b13B4DA07b0790ab (18 dec)
INC:                0x2fa878Ab3F87CC1C9737Fc071108F904c0B0C95d (18 dec)
```

---

## Last Verified

**2026-03-02** — Rigorous Researcher audit. All contract addresses, token addresses, fee tiers, tick spacings, and subgraph endpoints verified against codebase config files. 1 fix applied (removed unverified `pulsechain.publicnode.com` RPC). Confidence: HIGH.

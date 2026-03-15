---
name: uniswap-v2-protocol
description: >
  Protocol-level reference for Uniswap V2 constant-product AMM and its forks
  (PulseX, SushiSwap V2, PancakeSwap V2). Covers the x*y=k invariant, reserve
  mechanics, LP token valuation, price derivation, and mint/burn lifecycle.
  Load when working with any V2-style AMM regardless of chain.
---

# Uniswap V2 Protocol Skill

## Purpose

Load this skill when an agent needs to:

- Calculate LP token values for V2-style constant-product pools
- Work with PulseX V1/V2, SushiSwap V2, PancakeSwap V2, or any Uniswap V2 fork
- Compute impermanent loss for constant-product AMMs
- Derive token prices from pool reserves
- Understand the mint/burn lifecycle of V2 LP tokens
- Derive pair contract addresses via CREATE2
- Implement or debug swap output calculations with fee adjustments

This skill is **protocol-level** and contains no chain-specific addresses. For contract addresses, RPC endpoints, and chain-specific configuration, see the relevant `chains/{chain}/SKILL.md` or ecosystem skill files.

---

## Architecture Overview

### Constant Product Invariant

The core invariant governing all Uniswap V2-style pools:

```
x * y = k
```

Where `x` and `y` are the reserves of token0 and token1 respectively, and `k` is a constant that can only increase (via fees). Every swap, mint, or burn must preserve or increase `k`.

### System Components

| Component | Role |
|-----------|------|
| **Pair Contract** | Holds both token reserves, implements swap/mint/burn, issues LP tokens |
| **Factory Contract** | Deploys new pair contracts via CREATE2, maintains pair registry |
| **Router Contract** | Provides safe high-level interfaces for swap/add/remove liquidity |
| **LP Token (ERC20)** | Each pair is itself an ERC20 token representing proportional claim on reserves |

### Key Design Properties

- **One pair per token pair per factory** — no duplicate pools for the same token pair within a single factory
- **Token ordering is deterministic** — `token0 < token1` by address (lowercase hex sort)
- **LP tokens are fungible** — all LPs in the same pool have identical risk/reward profiles
- **No tick ranges** — unlike V3, liquidity is spread uniformly across all prices (0 to infinity)
- **Fees accrue to reserves** — swap fees increase `k`, benefiting all LP holders proportionally

---

## Core Interfaces

### Pair Contract ABI

```typescript
import { parseAbi } from 'viem';

const UNISWAP_V2_PAIR_ABI = parseAbi([
  // Reserve and token queries
  'function getReserves() view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)',
  'function token0() view returns (address)',
  'function token1() view returns (address)',

  // LP token (ERC20) functions
  'function totalSupply() view returns (uint256)',
  'function balanceOf(address owner) view returns (uint256)',
  'function approve(address spender, uint256 value) returns (bool)',
  'function transfer(address to, uint256 value) returns (bool)',

  // Core pair operations
  'function mint(address to) returns (uint256 liquidity)',
  'function burn(address to) returns (uint256 amount0, uint256 amount1)',
  'function swap(uint256 amount0Out, uint256 amount1Out, address to, bytes calldata data)',

  // Protocol fee tracking
  'function kLast() view returns (uint256)',

  // Metadata
  'function factory() view returns (address)',
  'function MINIMUM_LIQUIDITY() view returns (uint256)',
]);
```

### Factory Contract ABI

```typescript
const UNISWAP_V2_FACTORY_ABI = parseAbi([
  'function getPair(address tokenA, address tokenB) view returns (address pair)',
  'function allPairs(uint256 index) view returns (address pair)',
  'function allPairsLength() view returns (uint256)',
  'function feeTo() view returns (address)',
  'function feeToSetter() view returns (address)',
  'function createPair(address tokenA, address tokenB) returns (address pair)',
]);
```

### Router Contract ABI (Commonly Used Functions)

```typescript
const UNISWAP_V2_ROUTER_ABI = parseAbi([
  'function getAmountsOut(uint256 amountIn, address[] calldata path) view returns (uint256[] memory amounts)',
  'function getAmountsIn(uint256 amountOut, address[] calldata path) view returns (uint256[] memory amounts)',
  'function addLiquidity(address tokenA, address tokenB, uint256 amountADesired, uint256 amountBDesired, uint256 amountAMin, uint256 amountBMin, address to, uint256 deadline) returns (uint256 amountA, uint256 amountB, uint256 liquidity)',
  'function removeLiquidity(address tokenA, address tokenB, uint256 liquidity, uint256 amountAMin, uint256 amountBMin, address to, uint256 deadline) returns (uint256 amountA, uint256 amountB)',
  'function swapExactTokensForTokens(uint256 amountIn, uint256 amountOutMin, address[] calldata path, address to, uint256 deadline) returns (uint256[] memory amounts)',
]);
```

### Reserve Ordering

**Critical**: `getReserves()` returns reserves in `token0`/`token1` order. Token0 is always the address that sorts lower (lexicographic comparison of lowercase hex). If you need the price of a specific token, you must know whether it is token0 or token1.

```typescript
// Deterministic token ordering — same rule across ALL V2 forks
function sortTokens(tokenA: `0x${string}`, tokenB: `0x${string}`): [`0x${string}`, `0x${string}`] {
  const a = tokenA.toLowerCase();
  const b = tokenB.toLowerCase();
  if (a === b) throw new Error('Identical addresses');
  return a < b ? [tokenA, tokenB] : [tokenB, tokenA];
}
```

---

## Critical Math (BigInt Only — Never JS Floats)

### 1. Price from Reserves

```typescript
/**
 * Calculate the price of token0 denominated in token1.
 *
 * CRITICAL: Normalize by decimals BEFORE dividing.
 * Raw reserves are in each token's native decimal scale.
 *
 * Only convert to Number at the final display boundary.
 */
function priceToken0InToken1(
  reserve0: bigint,
  reserve1: bigint,
  decimals0: number,
  decimals1: number,
): number {
  // Scale reserves to a common precision (18 decimals) using BigInt
  const PRECISION = 10n ** 18n;
  const scaledReserve0 = (reserve0 * PRECISION) / (10n ** BigInt(decimals0));
  const scaledReserve1 = (reserve1 * PRECISION) / (10n ** BigInt(decimals1));

  // price = scaledReserve1 / scaledReserve0
  // Multiply by PRECISION first to preserve fractional result
  const priceBig = (scaledReserve1 * PRECISION) / scaledReserve0;

  // Convert to float only at the display boundary
  return Number(priceBig) / Number(PRECISION);
}
```

### 2. LP Token Valuation

```typescript
/**
 * Calculate the USD value of a single LP token.
 *
 * value_per_LP = (reserve0 * price0_USD + reserve1 * price1_USD) / totalSupply
 *
 * Uses Decimal.js for safe multiplication of large BigInts with float prices.
 */
import Decimal from 'decimal.js';

function lpTokenValueUSD(
  reserve0: bigint,
  reserve1: bigint,
  decimals0: number,
  decimals1: number,
  price0USD: number,
  price1USD: number,
  totalSupply: bigint,
): number {
  const amount0 = new Decimal(reserve0.toString()).div(new Decimal(10).pow(decimals0));
  const amount1 = new Decimal(reserve1.toString()).div(new Decimal(10).pow(decimals1));

  const totalValueUSD = amount0.mul(price0USD).add(amount1.mul(price1USD));

  const supply = new Decimal(totalSupply.toString()).div(new Decimal(10).pow(18)); // LP tokens are always 18 decimals

  if (supply.isZero()) return 0;
  return totalValueUSD.div(supply).toNumber();
}
```

### 3. User's Share of Pool

```typescript
/**
 * Calculate the USD value of a user's LP position.
 *
 * user_value = (user_LP_balance / totalSupply) * total_pool_value
 */
function userPositionValueUSD(
  userLPBalance: bigint,
  totalSupply: bigint,
  reserve0: bigint,
  reserve1: bigint,
  decimals0: number,
  decimals1: number,
  price0USD: number,
  price1USD: number,
): number {
  if (totalSupply === 0n) return 0;

  const share = new Decimal(userLPBalance.toString()).div(new Decimal(totalSupply.toString()));

  const amount0 = new Decimal(reserve0.toString()).div(new Decimal(10).pow(decimals0));
  const amount1 = new Decimal(reserve1.toString()).div(new Decimal(10).pow(decimals1));

  const userAmount0 = amount0.mul(share);
  const userAmount1 = amount1.mul(share);

  return userAmount0.mul(price0USD).add(userAmount1.mul(price1USD)).toNumber();
}
```

### 4. Impermanent Loss (V2)

```typescript
/**
 * Calculate impermanent loss for a V2 constant-product position.
 *
 * IL = 2 * sqrt(r) / (1 + r) - 1
 *
 * Where r = current_price / entry_price (the price ratio change).
 *
 * Returns a negative number (e.g., -0.0566 = 5.66% loss vs HODL).
 * Returns 0 when r = 1 (no price change).
 */
function impermanentLoss(priceRatioChange: number): number {
  if (priceRatioChange <= 0) throw new Error('Price ratio must be positive');

  const r = priceRatioChange;
  const sqrtR = Math.sqrt(r);
  const il = (2 * sqrtR) / (1 + r) - 1;
  return il; // Always <= 0
}

// Example: price doubles (r = 2) → IL = -5.72%
// Example: price halves (r = 0.5) → IL = -5.72% (symmetric)
// Example: price 5x (r = 5) → IL = -25.46%
```

### 5. Swap Output (with Fee)

```typescript
/**
 * Calculate the output amount for a V2 swap.
 *
 * amountOut = (amountIn * feeNumerator * reserveOut) / (reserveIn * feeDenominator + amountIn * feeNumerator)
 *
 * Standard Uniswap V2: feeNumerator = 997, feeDenominator = 1000 (0.3% fee)
 * PulseX V1/V2:        feeNumerator = 9971, feeDenominator = 10000 (0.29% fee)
 * PancakeSwap V2:      feeNumerator = 9975, feeDenominator = 10000 (0.25% fee)
 *
 * ALL math is BigInt. No floats.
 */
function getAmountOut(
  amountIn: bigint,
  reserveIn: bigint,
  reserveOut: bigint,
  feeNumerator: bigint = 997n,
  feeDenominator: bigint = 1000n,
): bigint {
  if (amountIn <= 0n) throw new Error('Insufficient input amount');
  if (reserveIn <= 0n || reserveOut <= 0n) throw new Error('Insufficient liquidity');

  const amountInWithFee = amountIn * feeNumerator;
  const numerator = amountInWithFee * reserveOut;
  const denominator = reserveIn * feeDenominator + amountInWithFee;

  return numerator / denominator;
}

// Inverse: given desired output, calculate required input
function getAmountIn(
  amountOut: bigint,
  reserveIn: bigint,
  reserveOut: bigint,
  feeNumerator: bigint = 997n,
  feeDenominator: bigint = 1000n,
): bigint {
  if (amountOut <= 0n) throw new Error('Insufficient output amount');
  if (reserveIn <= 0n || reserveOut <= 0n) throw new Error('Insufficient liquidity');
  if (amountOut >= reserveOut) throw new Error('Insufficient liquidity for output');

  const numerator = reserveIn * amountOut * feeDenominator;
  const denominator = (reserveOut - amountOut) * feeNumerator;

  return numerator / denominator + 1n; // +1 to round up
}
```

---

## Decimal Handling

**This is the most common source of bugs in V2 math.** Mismatched decimals silently produce prices that are off by orders of magnitude.

### Rules

1. **ALWAYS fetch decimals on-chain via `decimals()`** — never assume 18
2. **Normalize reserves before any price calculation** — raw reserves are in each token's native decimal scale
3. **Common traps**: USDC/USDT = 6 decimals, WBTC = 8, HEX = 8
4. **LP tokens are always 18 decimals** — this is hardcoded in the Uniswap V2 pair contract

### On-Chain Decimal Fetching

```typescript
import { createPublicClient, http, parseAbi } from 'viem';

const ERC20_METADATA_ABI = parseAbi([
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)',
  'function name() view returns (string)',
]);

async function getTokenDecimals(
  client: ReturnType<typeof createPublicClient>,
  tokenAddress: `0x${string}`,
): Promise<number> {
  const decimals = await client.readContract({
    address: tokenAddress,
    abi: ERC20_METADATA_ABI,
    functionName: 'decimals',
  });
  return Number(decimals);
}

// Batch fetch for efficiency (single RPC call via multicall)
async function getTokenMetadataBatch(
  client: ReturnType<typeof createPublicClient>,
  tokenAddresses: `0x${string}`[],
): Promise<Array<{ address: `0x${string}`; symbol: string; decimals: number }>> {
  const contracts = tokenAddresses.flatMap((address) => [
    { address, abi: ERC20_METADATA_ABI, functionName: 'symbol' as const },
    { address, abi: ERC20_METADATA_ABI, functionName: 'decimals' as const },
  ]);

  const results = await client.multicall({ contracts, allowFailure: true });

  return tokenAddresses.map((address, i) => ({
    address,
    symbol: results[i * 2].status === 'success' ? (results[i * 2].result as string) : 'UNK',
    decimals: results[i * 2 + 1].status === 'success' ? Number(results[i * 2 + 1].result) : 18,
  }));
}
```

### Safe Reserve Normalization

```typescript
/**
 * Convert raw reserve to human-readable amount.
 * Use Decimal.js to avoid BigInt-to-Number precision loss.
 */
import Decimal from 'decimal.js';

function normalizeReserve(rawReserve: bigint, decimals: number): Decimal {
  return new Decimal(rawReserve.toString()).div(new Decimal(10).pow(decimals));
}

// Example: HEX with 8 decimals
// rawReserve = 500000000000n (5000 HEX)
// normalizeReserve(500000000000n, 8) → Decimal(5000)
```

---

## Pool Address Derivation (CREATE2)

V2 pair addresses are deterministic — computable off-chain without querying the factory.

```typescript
import { getCreate2Address, keccak256, encodePacked } from 'viem';

/**
 * Derive the pair contract address for a V2-style pool.
 *
 * CRITICAL: initCodeHash differs per DEX fork. Using the wrong hash
 * produces a valid-looking but incorrect address.
 *
 * Token addresses MUST be sorted (lower address first).
 */
function computePairAddress(
  factoryAddress: `0x${string}`,
  tokenA: `0x${string}`,
  tokenB: `0x${string}`,
  initCodeHash: `0x${string}`,
): `0x${string}` {
  const [token0, token1] = tokenA.toLowerCase() < tokenB.toLowerCase()
    ? [tokenA, tokenB]
    : [tokenB, tokenA];

  const salt = keccak256(encodePacked(['address', 'address'], [token0, token1]));

  return getCreate2Address({
    from: factoryAddress,
    salt,
    bytecodeHash: initCodeHash,
  });
}
```

### Init Code Hashes by Fork

The init code hash is a keccak256 hash of the pair contract's creation bytecode. It is unique to each DEX fork because each fork compiles slightly different Solidity code.

| Fork | Init Code Hash | Notes |
|------|----------------|-------|
| Uniswap V2 | `0x96e8ac4277198ff8b6f785478aa9a39f403cb768dd02cbee326c3e7da348845f` | Ethereum mainnet canonical |
| SushiSwap V2 | `0xe18a34eb0e04b04f7a0ac29a6e80748dca96319b42c54d679cb821dca90c6303` | Same on all chains SushiSwap deploys to |
| PancakeSwap V2 | `0x00fb7f630766e6a796048ea87d01acd3068e8ff67d078148a3fa3f4a84f69bd5` | BSC and other chains |
| PulseX V1 | `0x2ad889f82040abccb2649ea6a874796c1601fb67f91a747a80e08860c73ddf24` | PulseChain only |
| PulseX V2 | `0x887bf2e98c2d4b43a648d75f8f991c28d3d5ebf8de9f55c45e01b8d86f130e49` | PulseChain only |

**Always verify init code hashes** against the deployed factory on the target chain. Forks occasionally modify the pair contract, changing the hash.

---

## Mint/Burn Lifecycle

### Minting (Adding Liquidity)

1. User approves Router to spend both tokens
2. Router transfers both tokens to the Pair contract in the correct ratio
3. Pair contract calculates LP tokens to mint:
   - **First deposit**: `liquidity = sqrt(amount0 * amount1) - MINIMUM_LIQUIDITY`
   - **Subsequent deposits**: `liquidity = min(amount0 * totalSupply / reserve0, amount1 * totalSupply / reserve1)`
4. `MINIMUM_LIQUIDITY` (1000 wei) is permanently locked on first mint to prevent division-by-zero attacks
5. LP tokens are minted to the user

```typescript
// Reading a user's LP position
async function getUserV2Position(
  client: ReturnType<typeof createPublicClient>,
  pairAddress: `0x${string}`,
  userAddress: `0x${string}`,
) {
  const [reserves, token0, token1, totalSupply, userBalance] = await client.multicall({
    contracts: [
      { address: pairAddress, abi: UNISWAP_V2_PAIR_ABI, functionName: 'getReserves' },
      { address: pairAddress, abi: UNISWAP_V2_PAIR_ABI, functionName: 'token0' },
      { address: pairAddress, abi: UNISWAP_V2_PAIR_ABI, functionName: 'token1' },
      { address: pairAddress, abi: UNISWAP_V2_PAIR_ABI, functionName: 'totalSupply' },
      { address: pairAddress, abi: UNISWAP_V2_PAIR_ABI, functionName: 'balanceOf', args: [userAddress] },
    ],
    allowFailure: false,
  });

  const [reserve0, reserve1] = reserves;
  const shareOfPool = totalSupply > 0n
    ? new Decimal(userBalance.toString()).div(new Decimal(totalSupply.toString()))
    : new Decimal(0);

  return {
    pairAddress,
    token0,
    token1,
    reserve0,
    reserve1,
    totalSupply,
    userBalance,
    shareOfPool: shareOfPool.toNumber(),
    userAmount0: (reserve0 * userBalance) / totalSupply,
    userAmount1: (reserve1 * userBalance) / totalSupply,
  };
}
```

### Burning (Removing Liquidity)

1. User approves Router to spend their LP tokens (or uses permit)
2. Router transfers LP tokens to the Pair contract
3. Pair contract calculates proportional share of each reserve:
   - `amount0 = liquidity * reserve0 / totalSupply`
   - `amount1 = liquidity * reserve1 / totalSupply`
4. Both tokens are transferred to the user
5. LP tokens are burned

### Fee Accrual Mechanism

Unlike V3 where fees are tracked per-position, V2 fees are embedded in the reserves:

- Each swap increases one reserve and decreases the other
- The fee portion (e.g., 0.3%) stays in the pool, increasing `k`
- LP holders capture fees automatically — their share of reserves grows over time
- No explicit "collect fees" action exists; fees are realized on burn (remove liquidity)

```typescript
/**
 * Estimate fees earned by an LP position since entry.
 *
 * This is an approximation. True fee tracking requires indexing
 * all Swap events since the mint.
 *
 * Approach: Compare current share value vs initial deposit value.
 * Difference = fees earned + impermanent loss.
 */
function estimateFeesEarned(
  currentValue0: Decimal,
  currentValue1: Decimal,
  entryValue0: Decimal,
  entryValue1: Decimal,
  price0USD: number,
  price1USD: number,
): { feesAndILCombinedUSD: number } {
  const currentUSD = currentValue0.mul(price0USD).add(currentValue1.mul(price1USD));
  const entryUSD = entryValue0.mul(price0USD).add(entryValue1.mul(price1USD));

  // NOTE: This combines fees earned WITH impermanent loss.
  // To isolate fees, you must also calculate IL separately and subtract.
  return {
    feesAndILCombinedUSD: currentUSD.sub(entryUSD).toNumber(),
  };
}
```

---

## Known Forks & Differences

| Fork | Fee | Fee Params (numerator/denominator) | Init Code Hash Difference | Other Notes |
|------|-----|------------------------------------|--------------------------|----|
| **Uniswap V2** | 0.30% | 997 / 1000 | Standard | Canonical reference implementation |
| **SushiSwap V2** | 0.30% | 997 / 1000 | Different init hash | Same fee math as Uniswap |
| **PulseX V1** | 0.29% | 9971 / 10000 | Different init hash | PulseChain; V1 and V2 have separate factories |
| **PulseX V2** | 0.29% | 9971 / 10000 | Different init hash | PulseChain; different hash than V1 |
| **PancakeSwap V2** | 0.25% | 9975 / 10000 | Different init hash | BSC primary; also on Ethereum, Arbitrum, others |
| **TraderJoe V1** | 0.30% | 997 / 1000 | Different init hash | Avalanche primary |
| **SpookySwap** | 0.20% | 998 / 1000 | Different init hash | Fantom primary |
| **Camelot V2** | Variable | Configurable per pair | Different init hash | Arbitrum; uses directional fees |

**Important**: When integrating a new fork, always verify:
1. The fee numerator/denominator (check the pair contract source or `getAmountOut` logic)
2. The init code hash (compute from deployed factory or check documentation)
3. Whether the Router interface has additional parameters (some forks add referral, deadline, or fee overrides)

---

## Reading Pool Data (Complete Pattern)

```typescript
import { createPublicClient, http, parseAbi } from 'viem';
import Decimal from 'decimal.js';

/**
 * Full pattern: read V2 pool reserves, token metadata, and compute price.
 * Uses multicall for efficiency (2 RPC calls instead of 7).
 */
async function getV2PoolData(
  client: ReturnType<typeof createPublicClient>,
  pairAddress: `0x${string}`,
) {
  // Step 1: Read pair data (1 multicall = 1 RPC)
  const [reserves, token0Addr, token1Addr, totalSupply] = await client.multicall({
    contracts: [
      { address: pairAddress, abi: UNISWAP_V2_PAIR_ABI, functionName: 'getReserves' },
      { address: pairAddress, abi: UNISWAP_V2_PAIR_ABI, functionName: 'token0' },
      { address: pairAddress, abi: UNISWAP_V2_PAIR_ABI, functionName: 'token1' },
      { address: pairAddress, abi: UNISWAP_V2_PAIR_ABI, functionName: 'totalSupply' },
    ],
    allowFailure: false,
  });

  const [reserve0, reserve1] = reserves;

  // Step 2: Read token metadata (1 multicall = 1 RPC)
  const ERC20_ABI = parseAbi([
    'function decimals() view returns (uint8)',
    'function symbol() view returns (string)',
  ]);

  const [decimals0Result, symbol0Result, decimals1Result, symbol1Result] = await client.multicall({
    contracts: [
      { address: token0Addr, abi: ERC20_ABI, functionName: 'decimals' },
      { address: token0Addr, abi: ERC20_ABI, functionName: 'symbol' },
      { address: token1Addr, abi: ERC20_ABI, functionName: 'decimals' },
      { address: token1Addr, abi: ERC20_ABI, functionName: 'symbol' },
    ],
    allowFailure: true,
  });

  const decimals0 = decimals0Result.status === 'success' ? Number(decimals0Result.result) : 18;
  const symbol0 = symbol0Result.status === 'success' ? (symbol0Result.result as string) : 'UNK';
  const decimals1 = decimals1Result.status === 'success' ? Number(decimals1Result.result) : 18;
  const symbol1 = symbol1Result.status === 'success' ? (symbol1Result.result as string) : 'UNK';

  // Step 3: Compute price (token0 in terms of token1)
  const normalizedReserve0 = new Decimal(reserve0.toString()).div(new Decimal(10).pow(decimals0));
  const normalizedReserve1 = new Decimal(reserve1.toString()).div(new Decimal(10).pow(decimals1));

  const priceToken0InToken1 = normalizedReserve0.isZero()
    ? new Decimal(0)
    : normalizedReserve1.div(normalizedReserve0);

  const priceToken1InToken0 = normalizedReserve1.isZero()
    ? new Decimal(0)
    : normalizedReserve0.div(normalizedReserve1);

  return {
    pairAddress,
    token0: { address: token0Addr, symbol: symbol0, decimals: decimals0 },
    token1: { address: token1Addr, symbol: symbol1, decimals: decimals1 },
    reserve0,
    reserve1,
    totalSupply,
    priceToken0InToken1: priceToken0InToken1.toNumber(),
    priceToken1InToken0: priceToken1InToken0.toNumber(),
  };
}
```

---

## Common Pitfalls

### 1. Decimal Mismatch (Most Common Bug)

Raw reserves from `getReserves()` are in each token's native decimal scale. A pool with USDC (6 decimals) and WETH (18 decimals) has reserves that differ by 10^12 in scale. Dividing raw reserves without normalization produces a price that is off by 10^12.

### 2. Token Ordering Assumptions

Never assume which token is token0. Always read `token0()` and `token1()` from the pair contract, or sort addresses yourself. The "base" and "quote" tokens in a trading pair may not correspond to token0/token1.

### 3. Fee Parameter Variation

Using Uniswap's 997/1000 fee for a PancakeSwap pool (9975/10000) causes swap output calculations to be wrong. Always parameterize fee values per DEX.

### 4. LP Token Decimals

LP tokens in Uniswap V2 are always 18 decimals, regardless of the underlying token decimals. Do not read `decimals()` on the pair contract and assume it matches the underlying tokens.

### 5. MINIMUM_LIQUIDITY Lock

The first 1000 wei of LP tokens are permanently locked (sent to address(0)). This means `totalSupply` is always at least 1000 wei for any active pool. Account for this when calculating very small positions.

### 6. Flash Loan / Reentrancy via `swap()`

The V2 `swap()` function supports flash swaps via the `data` parameter. If `data.length > 0`, the pair calls `uniswapV2Call()` on the `to` address before checking the invariant. This is by design but important to understand for security analysis.

### 7. Reserve Overflow (uint112)

Reserves are stored as `uint112`, limiting each reserve to ~5.19 * 10^33. For 18-decimal tokens, this means ~5.19 * 10^15 tokens max per side. This is sufficient for nearly all tokens but can theoretically overflow for ultra-high-supply tokens with 18 decimals.

---

## When to Load This Skill

- Calculating LP token values for V2-style pools
- Working with PulseX V1/V2, SushiSwap V2, PancakeSwap V2, or any Uniswap V2 fork
- Computing impermanent loss for constant-product AMMs
- Deriving token prices from pool reserves
- Understanding mint/burn lifecycle for V2 LP tokens
- Implementing or debugging swap output calculations
- Deriving pair addresses via CREATE2

---

## Cross-References

- For **concentrated liquidity (V3)**, see `protocols/uniswap-v3.md`
- For **chain-specific contract addresses**, see the relevant ecosystem skill:
  - PulseChain: `pulsechain-ecosystem/SKILL.md`
  - Ethereum: `ethereum-ecosystem/SKILL.md`
  - Arbitrum: `arbitrum-ecosystem/SKILL.md`
  - Base: `base-ecosystem/SKILL.md`
  - Polygon: `polygon-ecosystem/SKILL.md`
  - Sonic: `sonic-ecosystem/SKILL.md`
- For **Solidly/ve(3,3) dual-invariant pools** (Aerodrome, Velodrome, PHUX), see `protocols/aerodrome.md`
- For **V3 fee math verification**, see `v3-math-verifier/SKILL.md`

---

## Last Verified

**2026-03-02** — Initial creation. Protocol math verified against Uniswap V2 whitepaper and reference implementation. Fee parameters verified for Uniswap V2, PulseX V1/V2, PancakeSwap V2, and SushiSwap V2. Init code hashes verified against known deployments.

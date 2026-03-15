---
name: uniswap-v3-protocol
description: >
  Protocol-level reference for Uniswap V3 concentrated liquidity and its forks
  (9mm, SushiSwap V3, PancakeSwap V3, Shadow Exchange/Ramses V3, Aerodrome Slipstream).
  THE single source of truth for fee calculation math, tick math, sqrtPriceX96,
  position NFT reading, and V3 impermanent loss. Load whenever editing financial
  logic, calculating fees, or working with any V3-style concentrated liquidity protocol.
---

# Uniswap V3 Protocol Reference

## Architecture Overview

### Concentrated Liquidity Model

Uniswap V3 replaces V2's full-range liquidity (`[0, infinity)`) with **concentrated liquidity**, where LPs provide capital within discrete price ranges `[tickLower, tickUpper]`. This delivers higher capital efficiency but introduces amplified impermanent loss and piecewise token composition math.

**Core design:**

- **Positions are NFTs** minted by `NonfungiblePositionManager`. Each NFT encodes the LP's range, liquidity amount, and fee accounting snapshots.
- **Pools hold actual liquidity.** The PositionManager is a wrapper contract that manages NFTs and delegates to the underlying Pool. When reading on-chain state, you read both.
- **Ticks discretize the price space.** Price moves in increments of `1.0001^tick`. Valid position boundaries must be multiples of the pool's tick spacing.
- **Each pool is defined by** `(token0, token1, fee)`. The fee tier determines the tick spacing.

### Contract Relationships

```
User
  |
  v
NonfungiblePositionManager  (NFT wrapper — mint, burn, collect)
  |
  v
Pool  (holds liquidity, executes swaps, tracks fee growth)
  |
  v
Factory  (deploys pools, maps fee → tickSpacing)
```

---

## Core Contracts & Interfaces

### NonfungiblePositionManager

```typescript
const POSITION_MANAGER_ABI = parseAbi([
  'function positions(uint256 tokenId) view returns (uint96 nonce, address operator, address token0, address token1, uint24 fee, int24 tickLower, int24 tickUpper, uint128 liquidity, uint256 feeGrowthInside0LastX128, uint256 feeGrowthInside1LastX128, uint128 tokensOwed0, uint128 tokensOwed1)',
  'function balanceOf(address owner) view returns (uint256)',
  'function tokenOfOwnerByIndex(address owner, uint256 index) view returns (uint256)',
]);
```

**Return fields from `positions(tokenId)`:**

| Field | Type | Description |
|-------|------|-------------|
| `nonce` | uint96 | Permit nonce |
| `operator` | address | Approved operator |
| `token0` | address | Pool token0 |
| `token1` | address | Pool token1 |
| `fee` | uint24 | Fee tier in hundredths of a bip (e.g., 3000 = 0.30%) |
| `tickLower` | int24 | Lower price bound (tick) |
| `tickUpper` | int24 | Upper price bound (tick) |
| `liquidity` | uint128 | Active liquidity in the position |
| `feeGrowthInside0LastX128` | uint256 | Snapshot of token0 fee growth inside range at last interaction |
| `feeGrowthInside1LastX128` | uint256 | Snapshot of token1 fee growth inside range at last interaction |
| `tokensOwed0` | uint128 | Token0 fees marked collectable but not yet withdrawn |
| `tokensOwed1` | uint128 | Token1 fees marked collectable but not yet withdrawn |

### Pool Contract

```typescript
const POOL_ABI = parseAbi([
  'function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)',
  'function feeGrowthGlobal0X128() view returns (uint256)',
  'function feeGrowthGlobal1X128() view returns (uint256)',
  'function ticks(int24 tick) view returns (uint128 liquidityGross, int128 liquidityNet, uint256 feeGrowthOutside0X128, uint256 feeGrowthOutside1X128, int56 tickCumulativeOutside, uint160 secondsPerLiquidityOutsideX128, uint32 secondsOutside, bool initialized)',
  'function liquidity() view returns (uint128)',
]);
```

**Key `slot0()` fields:**

| Field | Type | Description |
|-------|------|-------------|
| `sqrtPriceX96` | uint160 | Current price as `sqrt(P) * 2^96` (Q96.96 fixed point) |
| `tick` | int24 | Current tick index (the tick at or below the current price) |

**Key `ticks(tick)` fields:**

| Field | Type | Description |
|-------|------|-------------|
| `liquidityGross` | uint128 | Total liquidity referencing this tick |
| `liquidityNet` | int128 | Net liquidity change when crossing this tick |
| `feeGrowthOutside0X128` | uint256 | Fee growth per unit liquidity on the "outside" of this tick for token0 |
| `feeGrowthOutside1X128` | uint256 | Fee growth per unit liquidity on the "outside" of this tick for token1 |

### Factory Contract

```typescript
const FACTORY_ABI = parseAbi([
  'function getPool(address tokenA, address tokenB, uint24 fee) view returns (address pool)',
  'function feeAmountTickSpacing(uint24 fee) view returns (int24)',
]);
```

### Reading Position + Pool Data (Production Pattern)

```typescript
async function getV3PositionData(client, tokenId, positionManagerAddress) {
  // Step 1: Read position data
  const position = await client.readContract({
    address: positionManagerAddress,
    abi: POSITION_MANAGER_ABI,
    functionName: 'positions',
    args: [BigInt(tokenId)],
  });

  // Step 2: Derive pool address from factory (or compute via CREATE2)
  // Step 3: Batch pool reads via multicall (1 RPC call instead of 5)
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

---

## Price Math

### Tick-Price Relationship

```
P = 1.0001^tick
```

Where `P` is the price of token1 denominated in token0 (i.e., how many token0 units per 1 token1). More precisely: `P = token1_amount / token0_amount`.

### sqrtPriceX96 Encoding

The pool stores price as a Q64.96 fixed-point square root:

```
sqrtPriceX96 = sqrt(P) * 2^96
```

To recover the human-readable price:

```
P = (sqrtPriceX96 / 2^96)^2
```

In code (BigInt):

```typescript
const Q96 = 2n ** 96n;
// From sqrtPriceX96 to price (float, for display only)
const sqrtPrice = Number(sqrtPriceX96) / Number(Q96);
const price = sqrtPrice * sqrtPrice;
```

### Tick-to-Price (for range boundaries)

```typescript
function tickToPrice(tick: number): number {
  return 1.0001 ** tick;
}

function priceToTick(price: number): number {
  return Math.floor(Math.log(price) / Math.log(1.0001));
}
```

### CRITICAL: Price Denomination Warning

- **Price is ALWAYS `token1 / token0` ratio** — it is NOT a USD value
- **Never prefix ratio-based prices with `$`**
- Display as `{symbol1}/{symbol0}` (e.g., "0.00045 WPLS/HEX")
- USD values are separate fields: `price0USD`, `price1USD`, `feesUSD` — only these use `$`
- `position.currentPrice`, `minPrice`, `maxPrice`, `entryPrice` are all token ratios

---

## Fee Calculation (CRITICAL)

### The #1 Fee Calculation Bug

> **WARNING**: Unclaimed fees = `tokensOwed` + feeGrowthInside delta. Using ONLY `tokensOwed` significantly underreports fees. This is the most common fee calculation error in V3 dashboards.

Uniswap V3 unclaimed fees have **two components** that MUST both be included:

1. **`tokensOwed0/1`** -- Fees already marked as collectable in the position NFT (updated on mint/burn/collect interactions)
2. **Uncollected fee growth** -- Fees accrued since the last interaction, calculated from the `feeGrowthInside` delta multiplied by the position's liquidity

### Complete Algorithm

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

  // Modular subtraction to handle uint256 underflow wrapping.
  // Solidity uint256 math wraps on underflow; JavaScript BigInt does not.
  // This function replicates Solidity's unchecked { a - b } behavior.
  const wrapSub = (a: bigint, b: bigint) => ((a - b) % MAX_UINT256 + MAX_UINT256) % MAX_UINT256;

  // ──────────────────────────────────────────────
  // Step 1: Fee growth BELOW the lower tick
  // ──────────────────────────────────────────────
  // "outside" is relative to the current tick.
  // If currentTick >= tickLower, the lower tick has been crossed,
  // so "outside" (from the tick's perspective) is BELOW it = the stored value.
  // If currentTick < tickLower, "outside" is ABOVE it = global - stored.
  let feeGrowthBelow0: bigint, feeGrowthBelow1: bigint;
  if (params.currentTick >= params.tickLower) {
    feeGrowthBelow0 = params.feeGrowthOutsideLower0X128;
    feeGrowthBelow1 = params.feeGrowthOutsideLower1X128;
  } else {
    feeGrowthBelow0 = wrapSub(params.feeGrowthGlobal0X128, params.feeGrowthOutsideLower0X128);
    feeGrowthBelow1 = wrapSub(params.feeGrowthGlobal1X128, params.feeGrowthOutsideLower1X128);
  }

  // ──────────────────────────────────────────────
  // Step 2: Fee growth ABOVE the upper tick
  // ──────────────────────────────────────────────
  // If currentTick < tickUpper, the upper tick has NOT been crossed,
  // so "outside" is ABOVE it = the stored value.
  // If currentTick >= tickUpper, "outside" is BELOW it = global - stored.
  let feeGrowthAbove0: bigint, feeGrowthAbove1: bigint;
  if (params.currentTick < params.tickUpper) {
    feeGrowthAbove0 = params.feeGrowthOutsideUpper0X128;
    feeGrowthAbove1 = params.feeGrowthOutsideUpper1X128;
  } else {
    feeGrowthAbove0 = wrapSub(params.feeGrowthGlobal0X128, params.feeGrowthOutsideUpper0X128);
    feeGrowthAbove1 = wrapSub(params.feeGrowthGlobal1X128, params.feeGrowthOutsideUpper1X128);
  }

  // ──────────────────────────────────────────────
  // Step 3: Fee growth INSIDE the position range
  // ──────────────────────────────────────────────
  // inside = global - below - above
  const feeGrowthInside0 = wrapSub(wrapSub(params.feeGrowthGlobal0X128, feeGrowthBelow0), feeGrowthAbove0);
  const feeGrowthInside1 = wrapSub(wrapSub(params.feeGrowthGlobal1X128, feeGrowthBelow1), feeGrowthAbove1);

  // ──────────────────────────────────────────────
  // Step 4: Delta since last position interaction
  // ──────────────────────────────────────────────
  // feeGrowthInsideLast was snapshotted at mint/burn/collect time
  const delta0 = wrapSub(feeGrowthInside0, params.feeGrowthInside0LastX128);
  const delta1 = wrapSub(feeGrowthInside1, params.feeGrowthInside1LastX128);

  // ──────────────────────────────────────────────
  // Step 5: Total accumulated fees
  // ──────────────────────────────────────────────
  // uncollected = (delta * liquidity) / Q128
  // total = uncollected + tokensOwed (from prior interactions)
  const totalFees0 = (delta0 * params.liquidity) / Q128 + params.tokensOwed0;
  const totalFees1 = (delta1 * params.liquidity) / Q128 + params.tokensOwed1;

  return { accumulatedFees0: totalFees0, accumulatedFees1: totalFees1 };
}
```

### Required On-Chain Reads for Fee Calculation

To call `calculateAccumulatedFees`, you need data from **two contracts** in a single multicall:

| Source | Call | Fields Used |
|--------|------|-------------|
| PositionManager | `positions(tokenId)` | `liquidity`, `tickLower`, `tickUpper`, `feeGrowthInside0LastX128`, `feeGrowthInside1LastX128`, `tokensOwed0`, `tokensOwed1` |
| Pool | `slot0()` | `tick` (currentTick) |
| Pool | `feeGrowthGlobal0X128()` | global fee accumulator token0 |
| Pool | `feeGrowthGlobal1X128()` | global fee accumulator token1 |
| Pool | `ticks(tickLower)` | `feeGrowthOutside0X128`, `feeGrowthOutside1X128` |
| Pool | `ticks(tickUpper)` | `feeGrowthOutside0X128`, `feeGrowthOutside1X128` |

### Why wrapSub Is Necessary

Solidity `uint256` arithmetic wraps on underflow (e.g., `3 - 5 = MAX_UINT256 - 1` in unchecked blocks). JavaScript `BigInt` throws on negative results. The `wrapSub` function replicates Solidity's modular arithmetic. Without it, fee calculations produce incorrect (or crashing) results when fee growth accumulators have wrapped.

### Displaying Fees in UI Components

```javascript
// CORRECT - uses full on-chain calculation from the data hook
fees: p.feesUSD || fallbackValue

// WRONG - only uses partial fee data (misses uncollected growth)
fees: (p.tokensOwed0 * price0) + (p.tokensOwed1 * price1)
```

---

## V3 Impermanent Loss Math

### Foundation

Based on the Uniswap V3 whitepaper (https://uniswap.org/whitepaper-v3.pdf), formulas 6.29 and 6.30.

**Key difference from V2:**
- V2 IL assumes full-range liquidity `[0, infinity)`: `IL = 2*sqrt(r) / (1+r) - 1`
- V3 IL depends on the position's price bounds `[Pa, Pb]`
- V3 IL is **amplified**: narrower range = more capital efficiency AND more IL

### Three-Case Piecewise Position Value (L=1 Normalized)

All functions use `L=1` normalization since IL is a ratio (`LP_value / HODL_value - 1`). The liquidity scalar cancels out.

Given `sqrtPa = sqrt(lowerPrice)` and `sqrtPb = sqrt(upperPrice)`:

**Case 1: Price below range (`sqrtP <= sqrtPa`)**
- Position is entirely token0
- `amount0 = 1/sqrtPa - 1/sqrtPb`
- `amount1 = 0`
- `value = (1/sqrtPa - 1/sqrtPb) * P`

**Case 2: Price in range (`sqrtPa < sqrtP < sqrtPb`)**
- Position is mixed token0 + token1
- `amount0 = 1/sqrtP - 1/sqrtPb`
- `amount1 = sqrtP - sqrtPa`
- `value = (1/sqrtP - 1/sqrtPb) * P + (sqrtP - sqrtPa)`

**Case 3: Price above range (`sqrtP >= sqrtPb`)**
- Position is entirely token1
- `amount0 = 0`
- `amount1 = sqrtPb - sqrtPa`
- `value = sqrtPb - sqrtPa`

### IL Percentage Formula

```
IL% = (LP_value / HODL_value - 1) * 100
```

Where:
- `LP_value` = position value at current price (piecewise formula above)
- `HODL_value` = entry token amounts valued at current price

**HODL value calculation:**
1. Compute token amounts at entry price using the piecewise formula
2. Value those fixed amounts at the current price: `HODL = entry_amount0 * currentPrice + entry_amount1`

### Crystallized IL (USD)

```
crystallizedIL_USD = |IL%| / 100 * positionValue_USD
```

### V3 IL Amplification Factor

```
amplification = |V3_IL| / |V2_IL|
```

This tells you how many times worse IL is compared to a full-range V2 position. Narrower ranges produce higher amplification.

### V2 IL Formula (Comparison Only)

```
IL = (2 * sqrt(r) / (1 + r) - 1) * 100
where r = currentPrice / entryPrice
```

This formula assumes `[0, infinity)` range. It is **NOT correct for V3 positions** -- use the piecewise formulas above. The V2 formula is retained only for comparison charts.

### Implementation Reference

The production implementation is in `utils/v3ImpermanentLoss.js`. Key exports:

| Function | Purpose |
|----------|---------|
| `calculateV3IL(entry, current, lower, upper)` | IL percentage for a V3 position |
| `calculateV3ILAtPrice(target, entry, lower, upper)` | IL at a specific price point |
| `calculateV3CrystallizedIL(entry, current, lower, upper, value)` | IL in USD |
| `calculateV3ILAmplification(entry, current, lower, upper)` | V3/V2 amplification ratio |
| `calculateV3ILFactor(entry, current, lower, upper)` | LP/HODL ratio (multiplier) |
| `calculateV3TokenAmountsNormalized(price, lower, upper)` | Token amounts at any price (L=1) |
| `calculateV2IL(entry, current)` | Legacy V2 formula for comparison |

---

## Fee Tiers

### Standard Uniswap V3 (Ethereum, Arbitrum, Polygon, Base, Optimism)

| Fee (bps) | Percentage | Tick Spacing | Typical Use |
|-----------|-----------|--------------|-------------|
| 100 | 0.01% | 1 | Stable/stable pairs (USDC/USDT) |
| 500 | 0.05% | 10 | Low-volatility correlated pairs |
| 3000 | 0.30% | 60 | Most pairs (default) |
| 10000 | 1.00% | 200 | Exotic / high-volatility pairs |

### Fork Variants

#### 9mm (PulseChain, chain 369)

| Fee (bps) | Percentage | Tick Spacing | Notes |
|-----------|-----------|--------------|-------|
| 100 | 0.01% | 1 | Stable pairs |
| 500 | 0.05% | 10 | Low volatility |
| **2500** | **0.25%** | **50** | **Replaces Uniswap's 3000/60** |
| 10000 | 1.00% | 200 | Exotic pairs |

**9mm uses 2500 bps (0.25%) where standard Uniswap uses 3000 bps (0.30%).** Tick spacing is 50, not 60. This affects pool address computation (CREATE2) and tick alignment validation.

#### PancakeSwap V3 (Ethereum, BSC, Arbitrum, etc.)

| Fee (bps) | Percentage | Tick Spacing |
|-----------|-----------|--------------|
| 100 | 0.01% | 1 |
| 500 | 0.05% | 10 |
| **2500** | **0.25%** | **50** |
| 10000 | 1.00% | 200 |

PancakeSwap V3 mirrors 9mm's fee structure: **2500 bps with tick spacing 50**, not Uniswap's 3000/60.

#### SushiSwap V3 (Ethereum, Arbitrum, Polygon, etc.)

Standard tiers: 100, 500, 3000, 10000 (same as Uniswap V3).

#### Aerodrome Slipstream (Base, chain 8453)

Aerodrome uses a **different encoding scheme** for fee tiers:

| Fee Encoding | Actual Fee | Tick Spacing |
|-------------|-----------|--------------|
| 1 | 0.01% | 1 |
| 5 | 0.05% | 10 |
| 30 | 0.30% | 60 |
| 100 | 1.00% | 200 |

**The fee value stored on-chain is NOT in hundredths of a bip** -- it uses a simplified encoding. The Aerodrome adapter must convert between Aerodrome encoding and standard bps for display.

#### Shadow Exchange / Ramses V3 (Sonic, chain 146)

Uses CL (concentrated liquidity) pools with custom tick spacings. Fee tiers may vary by deployment -- always query the factory contract.

### Tick Spacing Validation

Position tick boundaries MUST be multiples of the pool's tick spacing:

```typescript
function isValidTick(tick: number, tickSpacing: number): boolean {
  return tick % tickSpacing === 0;
}
```

If `tickLower % tickSpacing !== 0`, the position data is corrupt or from a different fee tier.

---

## Financial Precision Rules

### Mandatory: BigInt for All Contract Values

```typescript
// CORRECT: BigInt throughout, float only at display
const fees0 = (delta0 * liquidity) / Q128 + tokensOwed0;  // BigInt
const displayFees = formatTokenAmount(fees0, decimals0);    // String for UI

// WRONG: Native JS float for financial math
const fees = Number(tokensOwed0) / 1e18 * price;  // Precision loss, NaN risk
```

### Rules

1. **NEVER use native JS floats** (`Number`, `parseFloat`) for fee, liquidity, or token amount calculations
2. **Use `BigInt`** for all contract return values and intermediate arithmetic
3. **Use `Decimal.js` or `bignumber.js`** when mixing token amounts with USD prices
4. **Format with `utils/formatters.js`** at the display layer only -- `formatCurrency`, `formatPrice`, `formatPercent`
5. **Guard against NaN propagation** -- micro-priced tokens multiplied by large raw amounts can overflow `Number`
6. **Never use `.toFixed()` directly** -- use the project's formatter utilities which handle edge cases

### Decimal Hazards by Chain

| Token | Decimals | Chain | Trap |
|-------|----------|-------|------|
| HEX | **8** | PulseChain | Looks like 18, math off by 10^10 |
| WBTC | **8** | Ethereum | Matches Bitcoin, not ETH |
| USDC | **6** | All chains | Bridged from Ethereum |
| USDT | **6** | All chains | Bridged from Ethereum |

**Always call `decimals()` on-chain.** Never assume 18.

---

## Tick Math Reference

### Key Formulas

```
tick = floor(log(P) / log(1.0001))
P = 1.0001^tick
sqrtPriceX96 = sqrt(1.0001^tick) * 2^96
```

### Min/Max Tick Bounds

```
MIN_TICK = -887272
MAX_TICK =  887272
```

These correspond to price range approximately `[5.4e-39, 1.8e+38]`.

### Token Amounts from Liquidity and Ticks

For a position with liquidity `L` between ticks `[tickLower, tickUpper]`:

**When current price is in range (`tickLower <= currentTick < tickUpper`):**

```
amount0 = L * (1/sqrt(P) - 1/sqrt(Pb))
amount1 = L * (sqrt(P) - sqrt(Pa))
```

Where `Pa = 1.0001^tickLower`, `Pb = 1.0001^tickUpper`, `P = current price`.

**When below range (`currentTick < tickLower`):**

```
amount0 = L * (1/sqrt(Pa) - 1/sqrt(Pb))
amount1 = 0
```

**When above range (`currentTick >= tickUpper`):**

```
amount0 = 0
amount1 = L * (sqrt(Pb) - sqrt(Pa))
```

---

## Position Discovery Patterns

### Via NFT Enumeration (Standard V3)

```typescript
// Get all position IDs for a wallet
const balance = await client.readContract({
  address: positionManagerAddress,
  abi: POSITION_MANAGER_ABI,
  functionName: 'balanceOf',
  args: [walletAddress],
});

const tokenIds = await Promise.all(
  Array.from({ length: Number(balance) }, (_, i) =>
    client.readContract({
      address: positionManagerAddress,
      abi: POSITION_MANAGER_ABI,
      functionName: 'tokenOfOwnerByIndex',
      args: [walletAddress, BigInt(i)],
    })
  )
);
```

### Via Subgraph (When Available)

```graphql
{
  positions(where: { owner: "0x..." }, first: 1000) {
    id
    tokenId
    pool { id token0 { symbol } token1 { symbol } feeTier }
    tickLower { tickIdx }
    tickUpper { tickIdx }
    liquidity
  }
}
```

**Reliability warning:** Subgraphs can lag behind chain head or go down entirely. Always implement RPC fallback for critical paths.

### Position ID Format (Multi-Chain Dashboards)

Use composite IDs to avoid collisions across chains and DEXs:

```
Format: {chainId}-{dex}-{tokenId}
Example: 1-uniswap-567890
Example: 369-9mm-155284
```

Bare numeric IDs (`155284`) collide across chains.

---

## Fork Compatibility Matrix

| Feature | Uniswap V3 | 9mm | SushiSwap V3 | PancakeSwap V3 | Aerodrome Slipstream | Shadow/Ramses V3 |
|---------|-----------|-----|-------------|----------------|---------------------|-----------------|
| Same ABI | -- | Yes | Yes | Yes | Modified | Modified |
| Fee Tiers | 100/500/3000/10000 | 100/500/**2500**/10000 | Standard | 100/500/**2500**/10000 | Custom encoding | Custom |
| Tick Spacing (mid) | 60 | **50** | 60 | **50** | 60 | Varies |
| NFT Enumerable | Yes | Yes | Yes | Yes | Yes | Yes |
| Fee Math Identical | -- | Yes | Yes | Yes | Yes | Yes |
| Pool Deployer | Factory | **Separate deployer** | Factory | **Separate deployer** | Factory | Factory |

**The fee calculation algorithm is identical across ALL V3 forks.** The `calculateAccumulatedFees` function works universally -- only the contract addresses and fee tier values differ.

---

## Cross-References

| Document | Use When |
|----------|----------|
| `protocols/uniswap-v2.md` | V2 constant-product math, reserve-based pricing, V2 IL formula |
| `protocols/uniswap-v4.md` | V4 singleton PoolManager, hooks, position discovery differences |
| `chains/{chain}/SKILL.md` | Chain-specific contract addresses, RPC endpoints, known pitfalls |
| `v3-math-verifier/SKILL.md` | Verification rules for fee logic, BigInt enforcement, formatter usage |
| `utils/v3ImpermanentLoss.js` | Production IL calculation implementation |
| `utils/math.js` | V3 fee calculation, tick math, BigInt helpers |
| `utils/formatters.js` | Number formatting for micro-prices and large values |

---

## Verification Checklist

When editing any V3 financial logic, confirm:

- [ ] Fee calculation includes BOTH `tokensOwed` AND `feeGrowthInside` delta
- [ ] All intermediate math uses `BigInt` (no `Number()` until display)
- [ ] `wrapSub` is used for all uint256 subtractions (handles underflow wrapping)
- [ ] Price values are labeled as token ratios, not prefixed with `$`
- [ ] Fee tier matches the DEX fork (2500 for 9mm/PancakeSwap, 3000 for Uniswap/SushiSwap)
- [ ] Tick boundaries are multiples of the pool's tick spacing
- [ ] Token decimals are fetched on-chain, not assumed to be 18
- [ ] Display formatting uses `utils/formatters.js`, not manual `.toFixed()`

---

## Last Verified

**2026-03-02** -- Created as canonical V3 protocol reference. Algorithm extracted from production `pulsechain-ecosystem/SKILL.md` (lines 316-381), verification rules from `v3-math-verifier/SKILL.md`, fee tiers from `ethereum-ecosystem/SKILL.md` (lines 114-122), IL math from `utils/v3ImpermanentLoss.js`. All formulas cross-verified against Uniswap V3 whitepaper and Solidity source.

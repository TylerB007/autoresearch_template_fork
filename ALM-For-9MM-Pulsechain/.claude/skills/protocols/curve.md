---
name: curve-protocol
description: >
  Protocol-level reference for Curve Finance StableSwap and CryptoSwap invariants.
  Covers the amplification parameter (A), virtual_price for LP valuation, get_dy
  for swap output calculation, pool types (stable, crypto, meta), and the
  Registry/Factory patterns for pool discovery. Load when working with Curve
  pools, LP token pricing, or stablecoin AMM math on any chain.
---

# Curve Finance Protocol Skill

## Purpose

Load this skill when an agent needs to:

- Understand Curve pool mechanics for LP valuation on the dashboard
- Calculate Curve LP token value using `virtual_price`
- Parse Curve fee structures (1e10 format, not bps)
- Discover Curve pools via Registry, Factory, or MetaRegistry patterns
- Differentiate between StableSwap, CryptoSwap, and MetaPool types
- Compare Curve's invariant to constant-product AMMs (Uniswap V2) or concentrated liquidity (Uniswap V3)

---

## Architecture Overview

Curve Finance specializes in low-slippage swaps between similarly-priced assets (stablecoins, pegged tokens, wrapped/synthetic pairs). Unlike constant-product AMMs that treat all price ranges equally, Curve concentrates liquidity around a target peg ratio.

**Key design principles:**

- **StableSwap invariant**: A hybrid between constant-sum (`x + y = k`, zero slippage but finite liquidity) and constant-product (`x * y = k`, infinite range but high slippage near peg)
- **Amplification parameter (A)**: Controls the curve shape. High A = behaves more like constant-sum (tighter peg, lower slippage). Low A = behaves more like constant-product (wider range, higher slippage)
- **Multi-token pools**: Pools can hold 2 to 8 tokens (not limited to pairs like Uniswap)
- **Fees accrue via virtual_price**: LP tokens do not require separate fee claiming. Trading fees increase `virtual_price`, making each LP token worth more over time

**Vyper-based contracts**: Curve contracts are written in Vyper (not Solidity). Function signatures and ABIs differ from typical Solidity projects. Array indexing in function calls uses `uint256` for token indices (`i`, `j`), not addresses.

---

## Pool Types

### 1. Stable Pools (StableSwap / Plain Pools)

- **Assets**: Same-peg tokens (e.g., USDC/USDT/DAI, stETH/ETH, FRAX/USDC)
- **Invariant**: StableSwap (see Core Math below)
- **Typical A**: 100 - 20,000 (higher for tighter pegs like stablecoins)
- **Typical fee**: 0.04% (4000000 in 1e10 format)
- **Token count**: Usually 2-4
- **Key pools**: 3pool (DAI/USDC/USDT), stETH/ETH, FRAX/USDC

### 2. Crypto Pools (CryptoSwap / CryptoV2)

- **Assets**: Different-priced tokens (e.g., USDT/WBTC/WETH, CRV/ETH)
- **Invariant**: CryptoSwap — extends StableSwap with an internal price oracle and dynamic repricing
- **Typical fee**: 0.04% - 0.40% (dynamic mid_fee / out_fee structure)
- **Internal oracle**: Maintains an exponential moving average (EMA) price oracle for each token pair
- **Key feature**: The pool dynamically adjusts its "center of liquidity" as relative prices change, unlike StableSwap which assumes a fixed 1:1 peg
- **Key pools**: tricrypto2 (USDT/WBTC/WETH)

### 3. Meta Pools

- **Assets**: One token + one Curve LP token (e.g., FRAX + 3pool LP token)
- **Purpose**: Allow new tokens to trade against deep existing liquidity without fragmenting it
- **LP-on-LP**: The base pool LP token itself has a `virtual_price`, so metapool LP valuation requires recursive resolution
- **Underlying swaps**: `exchange_underlying()` can swap directly between the meta token and any base pool token (e.g., FRAX to USDC) by routing through the base pool

### 4. Tricrypto Pools

- **Assets**: Specialized 3-token crypto pools (USDT/WBTC/WETH)
- **Invariant**: CryptoSwap adapted for 3 tokens with very different prices
- **Significance**: Curve's flagship non-stablecoin pool, one of the deepest on-chain liquidity sources for BTC/ETH/USD trading

---

## Core Math

### StableSwap Invariant

The StableSwap invariant balances between constant-sum and constant-product behavior:

```
A * n^n * sum(x_i) + D = A * D * n^n + D^(n+1) / (n^n * prod(x_i))
```

Where:
- `A` = amplification coefficient (dimensionless, typically 100 - 20,000)
- `n` = number of tokens in the pool
- `D` = total "virtual balance" (the invariant value when all tokens are at equal balance)
- `x_i` = balance of token `i` (normalized to pool precision, usually 18 decimals internally)

**Behavior at extremes:**
- When pool is balanced (`x_i` all equal): the invariant acts like constant-sum, giving near-zero slippage
- When pool is heavily imbalanced: the `A` term's influence diminishes, and the invariant transitions toward constant-product behavior, increasing slippage to protect liquidity

**Solving for D**: The contract uses Newton's method (iterative convergence) to solve for `D` given current balances and `A`. This is a gas-intensive operation done on-chain.

**Solving for swap output**: Given input amount `dx` for token `i`, solve for new balance of token `j` using the invariant, then `dy = old_balance_j - new_balance_j - fee`.

### CryptoSwap Invariant

The CryptoSwap invariant extends StableSwap for non-pegged assets:

```
K * D^(n-1) * sum(x_i) + prod(x_i) = K * D^n + (D/n)^n
```

Where `K` is a dynamic concentration parameter that adjusts based on the internal oracle price. When prices are near the oracle center, `K` is high (concentrated like StableSwap). When prices diverge, `K` decreases (spreading liquidity like constant-product).

**Key differences from StableSwap:**
- Internal EMA price oracle tracks market prices
- The "center" of concentrated liquidity shifts dynamically
- Fee structure is dynamic: `mid_fee` near center, `out_fee` far from center
- `virtual_price` can temporarily decrease during admin fee claims and parameter changes (unlike StableSwap where it only increases)

### virtual_price

```
virtual_price = D / total_supply_of_LP_tokens
```

- **Units**: Denominated in the pool's unit of account (NOT USD). For 3pool, it is in units of the normalized stablecoin value. For a BTC pool, it is in BTC-denominated units
- **18 decimals**: Always returned as a uint256 with 18 decimal places (1e18 = 1.0)
- **Monotonically increasing** for StableSwap pools: every swap fee increases `D` while `total_supply` stays constant, so `virtual_price` grows
- **For CryptoSwap**: Can temporarily decrease during admin fee claims, but long-term trend is upward
- **LP token value**: `LP_balance * virtual_price / 1e18` gives the value in pool-native units

**This is how Curve LP holders earn fees**: There is NO separate fee claim mechanism like Uniswap V3. Fees compound automatically into LP token value via virtual_price growth.

### get_dy(i, j, dx)

Returns the expected output amount for swapping `dx` of token `i` for token `j`:

- Accounts for pool fees (deducted from output)
- Uses Newton's method internally to solve the invariant
- `i` and `j` are integer indices (0, 1, 2, ...) into the pool's token list, NOT addresses
- For metapools: `get_dy_underlying(i, j, dx)` routes through the base pool

---

## Key Contract Interfaces

### Pool Interface (Read-Only for Dashboard)

```
get_virtual_price() -> uint256               // LP token value (18 decimals)
get_dy(i: uint256, j: uint256, dx: uint256) -> uint256  // Swap preview
balances(i: uint256) -> uint256              // Token balance at index i
coins(i: uint256) -> address                 // Token address at index i
A() -> uint256                               // Current amplification parameter
fee() -> uint256                             // Pool fee (1e10 format)
admin_fee() -> uint256                       // Admin fee fraction (1e10 format)
totalSupply() -> uint256                     // LP token total supply (ERC20)
balanceOf(addr: address) -> uint256          // LP token balance (ERC20)
```

### CryptoSwap Additional Methods

```
price_oracle(k: uint256) -> uint256          // Internal EMA price oracle for token k
price_scale(k: uint256) -> uint256           // Current price scaling factor
last_prices(k: uint256) -> uint256           // Last traded price
mid_fee() -> uint256                         // Fee near oracle center (1e10)
out_fee() -> uint256                         // Fee far from oracle center (1e10)
```

### Liquidity Operations (Reference Only)

```
add_liquidity(amounts: uint256[], min_mint: uint256)         // Flexible add (can be one-sided)
remove_liquidity(amount: uint256, min_amounts: uint256[])    // Proportional removal
remove_liquidity_one_coin(amount: uint256, i: uint256, min: uint256)  // Single-token removal
remove_liquidity_imbalance(amounts: uint256[], max_burn: uint256)     // Custom ratio removal
```

**Note**: `add_liquidity` accepts any combination of token amounts, including single-sided deposits. The pool handles internal rebalancing and applies a deposit fee proportional to the imbalance created.

---

## Fee Structure

### Fee Denomination

Curve fees are expressed as parts per `1e10` (10 billion). This is NOT basis points.

| Fee Value | Percentage | Common Usage |
|-----------|-----------|-------------|
| 4000000 | 0.04% | Stable pool default |
| 10000000 | 0.10% | Some stable pools |
| 40000000 | 0.40% | Crypto pool out_fee |
| 100000000 | 1.00% | Maximum factory pool fee |

**Conversion**: `fee_percentage = fee_value / 1e10 * 100`

### Fee Flow

```
Trading Fee (total)
  |
  +-- LP Fee (accrues to LPs via virtual_price)
  |     = trading_fee * (1 - admin_fee / 1e10)
  |
  +-- Admin Fee (accrues to protocol / veCRV holders)
        = trading_fee * (admin_fee / 1e10)
```

- **Admin fee** is typically 50% (`5000000000` in 1e10 format), meaning half of trading fees go to veCRV holders
- **LP fee** is the remaining portion, which increases `virtual_price`
- Admin fees accumulate in the pool until explicitly claimed by the DAO

### CryptoSwap Dynamic Fees

CryptoSwap pools use a dynamic fee that interpolates between `mid_fee` and `out_fee`:

- Near the internal oracle price (balanced): fee approaches `mid_fee` (typically 0.04%)
- Far from oracle price (imbalanced): fee approaches `out_fee` (typically 0.40%)
- This protects LPs from adverse selection when the pool is far from equilibrium

---

## Pool Discovery

### Address Provider (Entry Point)

The `AddressProvider` contract is deployed at the **same address on every chain**:

```
AddressProvider: 0x0000000022D53366457F9d5E68Ec105046FC4383
```

This is the canonical entry point for discovering all Curve infrastructure. Call `get_address(id)` with specific IDs to find registries and factories.

| ID | Returns | Description |
|----|---------|-------------|
| 0 | Main Registry | Legacy StableSwap pool registry |
| 3 | MetaPool Factory | StableSwap metapool factory |
| 5 | Crypto Registry | CryptoSwap pool registry |
| 6 | Crypto Factory | CryptoSwap pool factory |
| 7 | **MetaRegistry** | Unified aggregator of all registries |

### MetaRegistry (Recommended for Dashboard)

The MetaRegistry aggregates all individual registries and factories into a single unified interface. For a read-only analytics dashboard, the MetaRegistry is the preferred discovery method:

```
MetaRegistry (query via AddressProvider ID 7):
  find_pool_for_coins(from, to) -> address      // Find pool for token pair
  get_pool_name(pool) -> string                  // Human-readable pool name
  get_coins(pool) -> address[]                   // Token addresses in pool
  get_balances(pool) -> uint256[]                // Token balances
  get_n_coins(pool) -> uint256                   // Number of tokens
  get_decimals(pool) -> uint256[]                // Token decimals
  get_virtual_price_from_lp_token(lp) -> uint256 // virtual_price lookup
  get_gauge(pool) -> address                     // Associated gauge contract
  pool_count() -> uint256                        // Total number of registered pools
  pool_list(i) -> address                        // Pool address at index i
```

### Evolution of Discovery

1. **Registry Pattern** (legacy): `AddressProvider.get_address(0)` returns the main Registry. Iterate `pool_count()` and `pool_list(i)` to enumerate pools. Limited to core team-deployed pools.
2. **Factory Pattern** (permissionless): Factory contracts (IDs 3, 6) deploy new pools. Each factory maintains its own pool list.
3. **MetaRegistry** (current): Unified view across all registries and factories. Use this for new integrations.

### Chain-Specific Contract Addresses

| Chain | Registry | Address Provider | Factory |
|-------|----------|------------------|---------|
| Ethereum (1) | `0x90E00ACe148ca3b23Ac1bC8C240C2a7Dd9c2d7f5` | `0x0000000022D53366457F9d5E68Ec105046FC4383` | `0xB9fC157394Af804a3578134A6585C0dc9cc990d4` (V2) |
| Polygon (137) | `0x47bB542B9dE58b970bA50c9dae444DDB4c16751a` | `0x0000000022D53366457F9d5E68Ec105046FC4383` | `0x722272D36ef0Da72FF51c5A65Db7b870E2e8D4ee` |
| Arbitrum (42161) | `0x445FE580eF8d70FF569aB36e80c647af338db351` | `0x0000000022D53366457F9d5E68Ec105046FC4383` | `0xb17b674D9c5CB2e441F8e196a2f048A81355d031` |

**Note**: The `AddressProvider` address (`0x0000000022D53366457F9d5E68Ec105046FC4383`) is the same on every chain where Curve is deployed.

---

## LP Token Valuation for Dashboard

### Simple Pool (Stable or Crypto)

```
LP_value_in_pool_units = user_LP_balance * virtual_price / 1e18

LP_value_USD = LP_value_in_pool_units * base_asset_price_USD / 1e(decimals)
```

For a stablecoin pool (3pool), `base_asset_price_USD` is approximately $1.00.
For an ETH-denominated pool, `base_asset_price_USD` is the ETH/USD price.

### MetaPool (LP-on-LP)

MetaPools use another Curve LP token as one of their assets. Valuation requires recursive resolution:

```
base_pool_virtual_price = base_pool.get_virtual_price()     // e.g., 3pool virtual_price
meta_pool_virtual_price = meta_pool.get_virtual_price()      // metapool virtual_price

// The metapool virtual_price already accounts for the base pool's virtual_price
LP_value_USD = user_LP_balance * meta_pool_virtual_price * base_unit_USD / 1e36
```

**Important**: The metapool's `virtual_price` already incorporates the base pool's `virtual_price` in its calculation, so you do NOT need to multiply both virtual prices. The metapool's `get_virtual_price()` returns the value in terms of the base pool's unit of account, already adjusted.

### Alternative: Balance-Based Valuation

For more granular display (showing individual token amounts), query pool balances proportionally:

```
user_share = user_LP_balance / total_LP_supply
user_token_i = pool.balances(i) * user_share
user_value_USD = sum(user_token_i * price_i / 10^decimals_i)
```

This approach shows the underlying token composition but does not account for withdrawal fees or slippage.

---

## Gauge System (CRV Emissions)

### Overview

CRV token emissions are distributed to LPs through a gauge system. This is SEPARATE from trading fee accrual (which happens via `virtual_price`).

- LPs deposit their Curve LP tokens into a **gauge contract** to earn CRV rewards
- Each pool can have an associated gauge (query via MetaRegistry or Registry)
- Gauge weight determines what fraction of total CRV emissions a pool receives
- Weights are set by **veCRV holders** through governance votes (gauge weight voting)

### Gauge Interface (Read-Only)

```
balanceOf(addr: address) -> uint256          // User's staked LP tokens
claimable_tokens(addr: address) -> uint256   // Pending CRV rewards
integrate_fraction(addr: address) -> uint256 // Cumulative CRV earned
reward_tokens(i: uint256) -> address         // Additional reward token at index i
claimable_reward(addr, token) -> uint256     // Pending external rewards
```

### Dashboard Implications

- To show "total LP position value", check both the LP token balance AND gauge-staked balance
- CRV rewards are separate income from trading fees
- Some gauges also distribute additional reward tokens (e.g., LDO for stETH pool)
- veCRV boost can increase a user's CRV earnings up to 2.5x

---

## Common Pitfalls

### 1. Fee Denomination (1e10, NOT bps)

Curve uses `1e10` as the fee denominator, not basis points (1e4) like Uniswap.

```
// WRONG
fee_pct = fee / 10000  // This is Uniswap convention

// CORRECT
fee_pct = fee / 1e10   // Curve convention: 4000000 / 1e10 = 0.0004 = 0.04%
```

### 2. virtual_price Only Goes Up (StableSwap)

For StableSwap pools, `virtual_price` should only increase over time. If it drops, this is a strong indicator of an exploit or bug. CryptoSwap pools are the exception: `virtual_price` can temporarily decrease during admin fee claims and parameter adjustments.

### 3. Decimal Handling

Pools with mixed-decimal tokens (e.g., USDC at 6 decimals + DAI at 18 decimals) normalize internally to a common precision. Raw on-chain `balances(i)` returns values in the token's native decimals. When comparing balances across tokens, normalize to a common base.

### 4. A Parameter is Not Static

The amplification parameter `A` can be ramped up or down over time by governance. The ramp is linear and takes place over a set duration (typically days to weeks). During a ramp:
- `A()` returns the current interpolated value, not the target
- `future_A()` returns the target value
- `future_A_time()` returns when the ramp completes
- Dashboard should display the current `A()` value, noting if a ramp is in progress

### 5. Token Indices, Not Addresses

Curve pool functions use integer indices (`i`, `j`) to identify tokens, not addresses. The mapping is:
- `coins(0)` = first token
- `coins(1)` = second token
- etc.

Always query `coins(i)` to verify the index-to-address mapping before calling `get_dy`, `exchange`, or `balances`.

### 6. MetaPool Complexity

MetaPools contain an LP token from another Curve pool as one of their tokens. This creates LP-on-LP valuation complexity:
- `coins(1)` of a metapool is another Curve LP token (e.g., 3CRV)
- `get_dy(0, 1, dx)` gives output in base LP tokens, not underlying stablecoins
- `get_dy_underlying(0, 2, dx)` routes through the base pool to give output in an underlying token
- For dashboard valuation, the metapool's `virtual_price` is sufficient (it already compounds the base pool's value)

### 7. Gauge vs Wallet Balance

A user's "real" Curve LP position may be split between:
- Direct LP token balance: `lp_token.balanceOf(user)`
- Gauge-staked balance: `gauge.balanceOf(user)`
- Possibly in other staking/vault contracts (Convex, Yearn, etc.)

For a comprehensive portfolio view, check all three sources.

### 8. CryptoSwap Price Oracles

CryptoSwap pools have internal price oracles (`price_oracle()`) that track EMA prices. These are NOT real-time spot prices. The oracle lags behind market price intentionally to prevent manipulation. For dashboard price display, prefer external price feeds (DexScreener, CoinGecko) over Curve's internal oracle.

---

## Cross-References

| Resource | When to Use |
|----------|-------------|
| `protocols/uniswap-v2.md` | Comparing constant-product AMM to StableSwap |
| `protocols/uniswap-v3.md` | Comparing concentrated liquidity approaches |
| `base-ecosystem/SKILL.md` | Aerodrome Slipstream / Solidly-style stable pools on Base (different invariant from Curve) |
| `ethereum-ecosystem/SKILL.md` | Ethereum Curve contract addresses |
| `polygon-ecosystem/SKILL.md` | Polygon Curve contract addresses |
| `arbitrum-ecosystem/SKILL.md` | Arbitrum Curve contract addresses |

---

## Quick Reference Card

```
Protocol:           Curve Finance
Invariant:          StableSwap (stable) / CryptoSwap (crypto)
Contract Language:  Vyper
LP Fee Accrual:     virtual_price growth (no separate claiming)
Fee Format:         1e10 (NOT bps!) — 4000000 = 0.04%
Admin Fee:          Typically 50% (5000000000)
Token Indices:      uint256 (0, 1, 2...), NOT addresses

Entry Point (all chains):
  AddressProvider:  0x0000000022D53366457F9d5E68Ec105046FC4383
  MetaRegistry:     AddressProvider.get_address(7)

Ethereum (1):
  Registry:         0x90E00ACe148ca3b23Ac1bC8C240C2a7Dd9c2d7f5
  Factory V2:       0xB9fC157394Af804a3578134A6585C0dc9cc990d4
  Metapool Factory: 0x0959158b6040D32d04c301A72CBFD6b39E21c9AE

Polygon (137):
  Registry:         0x47bB542B9dE58b970bA50c9dae444DDB4c16751a
  Factory:          0x722272D36ef0Da72FF51c5A65Db7b870E2e8D4ee

Arbitrum (42161):
  Registry:         0x445FE580eF8d70FF569aB36e80c647af338db351
  Factory:          0xb17b674D9c5CB2e441F8e196a2f048A81355d031

Key Functions (read-only):
  get_virtual_price()      -> uint256 (18 dec)
  get_dy(i, j, dx)         -> uint256
  balances(i)              -> uint256
  coins(i)                 -> address
  A()                      -> uint256
  fee()                    -> uint256 (1e10 format)

LP Valuation:
  value = LP_balance * virtual_price * base_price_USD / 1e36
```

---

## Last Verified

**2026-03-02** — Initial creation. Contract addresses sourced from project ecosystem skill files (ethereum, polygon, arbitrum). Math and architecture verified against Curve technical documentation and StableSwap whitepaper. Confidence: HIGH for architecture and math, HIGH for contract addresses (cross-referenced with existing codebase config).

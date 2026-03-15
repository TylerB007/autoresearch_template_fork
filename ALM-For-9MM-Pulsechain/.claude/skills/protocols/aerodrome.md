---
name: aerodrome-protocol
description: >
  Protocol-level reference for the Solidly/Velodrome/Aerodrome DEX architecture
  and its forks (Shadow Exchange, Velodrome). Covers the dual-invariant system
  (stable x3y+y3x=k vs volatile xy=k), ve(3,3) tokenomics, gauge emissions,
  and Slipstream concentrated liquidity. Load when working with Aerodrome (Base),
  Velodrome (Optimism), Shadow Exchange (Sonic), or any Solidly fork.
---

# Aerodrome / Solidly Protocol Skill

## Purpose

Load this skill when working with:

- Aerodrome Finance on Base (chain 8453)
- Velodrome Finance on Optimism (chain 10)
- Shadow Exchange on Sonic (chain 146)
- Any Solidly ve(3,3) fork (Velocimeter, Thena, Equalizer, etc.)
- Understanding dual-invariant AMM mechanics (stable vs volatile pools)
- ve(3,3) tokenomics, gauge voting, or emission distribution
- Slipstream concentrated liquidity (Aerodrome's V3-style CL)

---

## Architecture Overview

The Solidly architecture, created by Andre Cronje in January 2022, combines two innovations:

1. **Dual-Invariant AMM** -- Two mathematically distinct pool types (stable and volatile) under one factory
2. **ve(3,3) Tokenomics** -- Vote-escrowed NFT governance that aligns fee revenue with emission direction

**Core components:**

| Component | Role |
|-----------|------|
| Pool Factory | Creates stable or volatile liquidity pools |
| Pools (Pairs) | Hold reserves, execute swaps using the appropriate invariant |
| Voter | Manages votes, creates gauges, distributes weekly emissions |
| Gauge | Distributes emission rewards to staked LPs |
| VotingEscrow | Locks governance tokens into veNFTs with time-weighted voting power |
| FeesVotingReward | Collects trading fees and distributes them to veNFT voters |
| Minter | Controls weekly emission schedule and rebase distribution |

**The fundamental insight:** LPs earn emission rewards (not trading fees), while veNFT voters earn trading fees (not emissions). This creates a flywheel where voters are incentivized to direct emissions to high-volume pools.

---

## Dual Invariant System

### Volatile Pools

```
x * y = k
```

Standard constant-product formula, identical to Uniswap V2. Used for uncorrelated asset pairs (e.g., ETH/USDC, AERO/ETH).

### Stable Pools

```
x3y + xy3 = k
```

The Solidly stable invariant. Provides dramatically lower slippage near the 1:1 price ratio. Used for correlated asset pairs (e.g., USDC/USDbC, stETH/ETH).

**Important distinctions from Curve's StableSwap:**

| Property | Solidly Stable (x3y + xy3 = k) | Curve StableSwap |
|----------|----------------------------------|------------------|
| Formula | Pure polynomial invariant | Hybrid: weighted blend of constant-sum and constant-product |
| Amplification parameter | None -- shape is fixed | A parameter tunes curvature |
| Multi-asset | Two assets only (in classic form) | Supports 2-4+ assets natively |
| Governance tuning | Pool type set at creation, immutable | A can be ramped up/down by governance |
| Equivalent name | Sometimes called "Solidly stableswap" | "Curve stableswap" or "StableSwap invariant" |

The Solidly stable invariant can also be written as xy(x2 + y2) = k, which is algebraically equivalent. This form makes it clearer that the invariant is symmetric in x and y.

### Pool Type Determination

- Pool type is set at creation time via a `stable` boolean flag passed to the factory
- Once created, a pool type (stable vs volatile) is immutable
- To check a pool type on-chain: call `pool.stable()` which returns `true` for stable pools
- The `metadata()` view function on the pair contract returns pool parameters including the stable flag

### Swap Fee Defaults

| Pool Type | Default Fee | Notes |
|-----------|------------|-------|
| Volatile | 0.30% | Can be adjusted by governance |
| Stable | 0.05% | Lower fee reflects lower risk |

Fees can be customized per-pool by the pool factory owner. Some forks allow dynamic fees.

---

## Slipstream (Concentrated Liquidity)

Aerodrome Slipstream is a V3-style concentrated liquidity system layered on top of the ve(3,3) architecture. It uses the same tick/range mechanics as Uniswap V3.

### How Slipstream Differs from Standard V3

| Aspect | Uniswap V3 | Aerodrome Slipstream |
|--------|-----------|---------------------|
| Fee encoding | 100 / 500 / 3000 / 10000 | **1 / 5 / 30 / 100** |
| Fee destination | 100% to LPs | Base fees to LP positions + emission rewards from gauges |
| Governance | Protocol fee switch (unused) | ve(3,3) gauge voting directs emissions |
| Position staking | Not applicable | LPs stake CL NFTs in gauges for emission rewards |

### Fee Tier Encoding (CRITICAL)

Aerodrome Slipstream uses a non-standard fee encoding:

| Slipstream Fee Value | Percentage | Tick Spacing | Uniswap V3 Equivalent |
|---------------------|-----------|--------------|----------------------|
| 1 | 0.01% | 1 | 100 |
| 5 | 0.05% | 10 | 500 |
| 30 | 0.30% | 60 | 3000 |
| 100 | 1.00% | 200 | 10000 |

**Conversion formula:** `slipstreamFee * 100 = uniswapV3Fee`

The tick spacings are identical to standard V3. The fee values are simply divided by 100.

### Fee Calculation

The core V3 fee math (feeGrowthGlobal, feeGrowthOutside, feeGrowthInside, tokensOwed) is **identical** to Uniswap V3. See `protocols/uniswap-v3.md` for the complete fee calculation algorithm.

The only difference is interpreting the fee tier value when computing expected fee revenue.

---

## Transaction Engineering — Slipstream Integration

The protocol economics above are accurate, but agents writing **transaction code** (mints, swaps, pool queries) against Slipstream must follow these battle-tested rules. Ignoring any of them causes instant reverts on Base.

### 1. `tickSpacing` Replaces `fee` in All Structs

Slipstream removes the `fee: uint24` parameter from `MintParams`, `ExactInputSingleParams`, and pool factory lookups. It is replaced by `tickSpacing: int24` as the sole pool identifier.

```typescript
// Aerodrome CL / Algebra V3 — use tickSpacing
const swapParams = {
  tokenIn, tokenOut,
  tickSpacing: fee,   // NOT fee: fee
  recipient, amountIn, amountOutMinimum, sqrtPriceLimitX96,
};

// Uniswap V3 / PancakeSwap V3 — use fee
const swapParams = {
  tokenIn, tokenOut,
  fee,                // NOT tickSpacing
  recipient, amountIn, amountOutMinimum, sqrtPriceLimitX96,
};
```

- Pool factory lookup: `factory.getPool(token0, token1, tickSpacing)` — not `fee`
- Slipstream pools have no `fee()` function — `tickSpacing()` is the only identifier
- This applies to both **Aerodrome CL** (Base) and **Algebra V3** (Sonic/Shadow Exchange)

*Codebase reference: `src/swap.ts:213-230`, `src/rebalancer.ts:1510-1525`*

### 2. EIP-1167 Minimal Proxies Break Batched RPC Calls

Aerodrome CL pools (and some token contracts on Base) are deployed as EIP-1167 minimal proxies. **`Promise.all()` batched RPC calls against these proxies cause silent `CALL_EXCEPTION` failures.**

```typescript
// ❌ WRONG — reverts on Aerodrome CL pools
const [slot0, liquidity, token0, token1, tickSpacing] = await Promise.all([
  pool.slot0(), pool.liquidity(), pool.token0(), pool.token1(), pool.tickSpacing(),
]);

// ✅ CORRECT — sequential queries for Aerodrome/Algebra
const slot0 = await pool.slot0();
const liquidity = await pool.liquidity();
const token0 = await pool.token0();
const token1 = await pool.token1();
const tickSpacing = await pool.tickSpacing();
```

Standard Uniswap V3 pools (non-proxy) can safely use `Promise.all`.

*Codebase reference: `src/pool.ts:36-54` (sequential) vs `src/pool.ts:57-64` (batched)*

### 3. `sqrtPriceX96: 0n` Required in MintParams

Slipstream's `MintParams` struct includes an additional `sqrtPriceX96` field not present in standard Uniswap V3. Set it to `0n` when the pool already exists (always true for rebalances).

```typescript
// Aerodrome CL MintParams (extra field)
const mintParams = {
  token0, token1,
  tickSpacing: fee,
  tickLower, tickUpper,
  amount0Desired, amount1Desired,
  amount0Min, amount1Min,
  recipient,
  deadline,
  sqrtPriceX96: 0n,  // Pool exists — required field, set to 0
};
```

Omitting this field causes the mint transaction to revert.

*Codebase reference: `src/rebalancer.ts:1511-1525`*

### 4. `deadline` Required (Unlike PancakeSwap V3)

Aerodrome CL requires a `deadline` timestamp in both swap and mint params. This matches Uniswap V3 behavior but differs from PancakeSwap V3, which does NOT accept `deadline`.

| Router Type | Pool Key Field | `deadline` | `sqrtPriceX96` in Mint |
|-------------|---------------|-----------|----------------------|
| `uniswap-v3` | `fee` | Required | Not used |
| `pancakeswap-v3` | `fee` | **Omit** | Not used |
| `aerodrome-cl` | `tickSpacing` | Required | Required (`0n`) |
| `algebra-v3` | `tickSpacing` | Required | Required (`0n`) |

Multi-DEX integrations must conditionally include/exclude these fields based on router type.

*Codebase reference: `src/swap.ts:213-230`*

---

## ve(3,3) Tokenomics

### Token Locking

1. Users lock the governance token (AERO, VELO, SHADOW, etc.) in the VotingEscrow contract
2. Locking creates a **veNFT** (vote-escrowed NFT) -- an ERC-721 token representing the locked position
3. Lock duration: up to 4 years (maximum voting power)
4. Voting power decays linearly over time as the lock approaches expiration
5. veNFTs can be merged, split, or extended

### The (3,3) Game Theory

The name "ve(3,3)" references the Nash Equilibrium from Olympus DAO (3,3) model:

- **(3,3)** = Everyone locks and votes = Maximum collective benefit
- **(1,1)** = Everyone sells = Minimum benefit
- The mechanism design incentivizes locking over selling because:
  - Lockers earn ALL trading fees from pools they vote for
  - Lockers receive anti-dilution rebases proportional to their share of total locked supply
  - Lockers can attract bribes by voting for specific pools

### Rebase Mechanism

To protect veNFT holders from dilution by new emissions:

- Each epoch, a rebase is distributed to veNFT holders
- Rebase amount is proportional to the ratio of locked supply to total supply
- Higher lock ratio = lower rebase (less dilution to compensate for)
- Rebases increase the locked balance inside the veNFT

---

## Gauge System

### Overview

Every pool (both Classic V2 and Slipstream CL) can have an associated **gauge** contract. The gauge is the mechanism through which LPs earn emission rewards.

### Lifecycle

1. **Gauge Creation**: `Voter.createGauge(poolFactory, pool)` -- creates a gauge for a specific pool
2. **LP Staking**: LPs deposit their LP tokens (Classic) or CL position NFTs (Slipstream) into the gauge
3. **Voting**: veNFT holders vote for gauges to direct emissions (`Voter.vote(tokenId, pools, weights)`)
4. **Distribution**: `Voter.distribute(gauge)` triggers emission distribution (callable by anyone)
5. **Claiming**: LPs call `gauge.getReward(account)` to claim accrued emission tokens

### Epoch Cycle

- **Epoch length**: 1 week (Thursday 00:00 UTC to Thursday 00:00 UTC)
- **Voting window**: veNFT holders can change votes at any time; votes lock at epoch flip
- **Distribution**: After epoch flip, `Voter.distribute()` sends emissions to gauges
- **Emission formula**: Each epoch, a fixed amount of governance tokens are minted and distributed proportionally to gauge votes

### Gauge Weight Calculation

```
gauge_emissions = total_weekly_emissions * (votes_for_gauge / total_votes)
```

Within a gauge, emissions are distributed proportionally to each LP share of staked liquidity.

---

## Fee Distribution (Critical Difference from Uniswap)

This is the most important conceptual difference between Solidly forks and Uniswap:

### Classic V2 Pools

| Revenue Stream | Recipient | Mechanism |
|---------------|-----------|-----------|
| Trading fees (100%) | **veNFT voters** | Fees accrue in FeesVotingReward contract; voters claim proportional to vote weight |
| Emission rewards | **Staked LPs** | Governance token emissions distributed through gauge |

**LPs do NOT earn trading fees in Classic V2 pools.** They earn emission tokens instead.

### Slipstream CL Pools

| Revenue Stream | Recipient | Mechanism |
|---------------|-----------|-----------|
| Base swap fees | **LP positions** | Standard V3 fee accrual (feeGrowthInside) -- fees go to LPs |
| Emission rewards | **Staked CL NFTs** | Governance token emissions distributed through CL gauge |

**In Slipstream, base swap fees DO go to LPs** (standard V3 mechanics). This is different from Classic V2 where fees go to voters. The emission rewards from gauges are an additional reward stream on top.

### Why This Matters for Analytics

When building dashboards or tracking LP profitability:

- **Classic V2**: LP revenue = emission rewards only. Do NOT count trading fees as LP income.
- **Slipstream CL**: LP revenue = base swap fees (standard V3) + emission rewards (gauge).
- **veNFT voters**: Voter revenue = trading fees from voted pools + bribes.
- Total LP earnings shown on protocol UIs typically combine both fee and emission components.

---

## Fork Variants

| Fork | Chain | Chain ID | Governance Token | CL Version | Notes |
|------|-------|----------|-----------------|------------|-------|
| Aerodrome | Base | 8453 | AERO | Slipstream | Dominant Base DEX (~45% share) |
| Velodrome | Optimism | 10 | VELO | Slipstream | Original Solidly fork for OP; merged with Aerodrome Nov 2025 |
| Shadow Exchange | Sonic | 146 | SHADOW / xSHADOW | Ramses V3 Core | Uses standard V3 fee encoding |
| Velocimeter | PulseChain | 369 | FLOW | No CL | ve(3,3) with oFLOW option token emissions |
| Thena | BNB Chain | 56 | THE | FUSION (Algebra) | Uses Algebra V3 for CL |
| Equalizer | Fantom / Sonic | 250 / 146 | EQUAL | V3-style | Multi-chain |
| Ramses | Arbitrum | 42161 | RAM | Ramses V3 | Shadow Exchange is based on Ramses |

### Aerodrome + Velodrome Merger (November 2025)

As of November 2025, Aerodrome and Velodrome merged into a single DEX with unified governance and multi-chain liquidity. They share the same development team and contract architecture.

---

## Shadow Exchange Specifics

Shadow Exchange on Sonic (chain 146) is a Solidly/ve(3,3) fork but uses **Ramses V3 Core** for concentrated liquidity, NOT Slipstream.

### Key Differences from Aerodrome

| Aspect | Aerodrome | Shadow Exchange |
|--------|-----------|----------------|
| CL implementation | Slipstream | Ramses V3 Core (Uniswap V3 fork) |
| Fee encoding | 1 / 5 / 30 / 100 | **100 / 500 / 3000 / 10000** (standard V3) |
| Position Managers | Single | Two (current + legacy) |
| Staking token | veAERO | xSHADOW |
| Dynamic fees | No | FeeShare mechanism can adjust fees |

### Two Position Managers

Shadow Exchange has two NonfungiblePositionManager contracts:

- **Current**: `0x12E66C8F215DdD5d48d150c8f46aD0c6fB0F4406`
- **Legacy**: `0xA57FA38b3fd45922394e9E1077748A2383F1542E`

When discovering positions, both must be queried. See `sonic-ecosystem/SKILL.md` for full details.

### FeeShare Mechanism

Shadow Exchange FeeShare allows dynamic fee adjustments per pool. The actual fee charged on swaps may differ from the fee tier the pool was created with. When calculating fee APR, use actual fee data from recent swap events rather than the configured fee tier.

### x(3,3) Emission Rewards

Shadow x(3,3) rewards are separate from base V3 swap fees:

- Base swap fees: Standard V3 accrual to LP positions
- x(3,3) emissions: Distributed through gauge contracts, requires staking
- Dashboard fee calculations capture base fees only; emission rewards require querying Shadow-specific contracts

---

## Common Pitfalls

### 1. Fee Encoding Mismatch

**Aerodrome Slipstream** uses 1/5/30/100. **Shadow Exchange** uses standard 100/500/3000/10000. Mixing these up will produce incorrect pool addresses, wrong fee tier labels, and broken analytics.

```
// Converting between encodings
aeroFee * 100 = standardV3Fee
standardV3Fee / 100 = aeroFee
```

### 2. Fee Destination Confusion

In Classic V2 pools, trading fees go to **voters**, NOT LPs. This is the opposite of Uniswap V2. Reporting trading fees as LP income for Classic V2 pools will overstate LP returns.

In Slipstream CL pools, base swap fees DO go to LPs (standard V3), but emission rewards are a separate stream.

### 3. Stable Invariant Is NOT Curve

The Solidly stable invariant x3y + xy3 = k is a fixed-shape polynomial curve with no tunable parameters. Curve StableSwap uses a fundamentally different formula with an amplification parameter A. Do not interchange the math.

### 4. veNFT Rewards Are Separate from LP Gauge Rewards

- veNFT holders earn: trading fees + bribes + rebases
- LPs (staked in gauges) earn: emission rewards (+ base fees in Slipstream CL)
- These are completely separate reward streams with different claim mechanisms

### 5. Pool Discovery Requires Multiple Factories

Aerodrome has both Classic V2 and Slipstream factories. When scanning for pools or building a complete picture:

- Classic V2 Factory: `0x420DD381b31aEf6683db6B902084cB0FFECe40Da`
- Slipstream Factory: `0x5e7BB104d84c7CB9B682AaC2F3d509f5F406809A`

Both must be checked. A token pair can have pools in both systems simultaneously.

### 6. Epoch Timing

Epochs flip at Thursday 00:00 UTC. Votes, emission distributions, and fee snapshots all align to this weekly cadence. Time-based queries or APR calculations must account for the epoch boundary.

### 7. Gauge Staking Required for Emissions

Simply providing liquidity does NOT earn emission rewards. LPs must explicitly stake their LP tokens (Classic) or CL position NFTs (Slipstream) into the pool gauge contract. Unstaked liquidity earns nothing beyond base CL fees (Slipstream only).

### 8. Using Standard V3 ABIs for Slipstream Transactions

If you write integration code using standard Uniswap V3 ABIs and struct shapes, **every transaction will revert**. See the "Transaction Engineering — Slipstream Integration" section above for the 4 critical struct and RPC differences that must be handled: `tickSpacing` vs `fee`, sequential RPC queries, `sqrtPriceX96` in MintParams, and conditional `deadline` inclusion.

---

## Cross-References

| Skill | Relevance |
|-------|-----------|
| `protocols/uniswap-v3.md` | Slipstream fee calculation uses identical V3 math |
| `protocols/uniswap-v2.md` | Volatile pool math is identical to xy=k |
| `protocols/curve.md` | Compare stable invariants (Curve uses different math with A parameter) |
| `base-ecosystem/SKILL.md` | Aerodrome contract addresses on Base |
| `sonic-ecosystem/SKILL.md` | Shadow Exchange contract addresses on Sonic |

---

## Last Verified

**2026-03-02** -- Created from Aerodrome contracts specification, existing ecosystem skills, and protocol documentation research. Covers Solidly architecture, ve(3,3) tokenomics, Slipstream CL, and fork variants. Cross-referenced against base-ecosystem and sonic-ecosystem SKILL.md files. Added Transaction Engineering section with 4 critical integration truths verified against production codebase (`src/swap.ts`, `src/pool.ts`, `src/rebalancer.ts`).

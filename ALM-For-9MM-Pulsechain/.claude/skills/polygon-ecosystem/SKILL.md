---
name: polygon-ecosystem
description: Reference skill for building read-only analytics, LP tracking, and DeFi dashboard applications on Polygon (chain ID 137). Covers RPC setup, DEX contracts (QuickSwap V3/Algebra, SushiSwap, Curve, Balancer, iZUMi), token addresses, price fetching, and known pitfalls including QuickSwap's Algebra dynamic fees and USDC fragmentation. Load when working with Polygon DeFi data, LP positions, or QuickSwap integration on chain 137.
---

# Polygon Ecosystem Skill

## Purpose

Load this skill when an agent needs to:

- Build or modify read-only analytics for Polygon (chain ID 137)
- Track concentrated liquidity positions on Polygon DEXs
- Work with QuickSwap V3 (Algebra protocol — dynamic fees, different from standard V3)
- Interact with SushiSwap, Curve, Balancer, or iZUMi on Polygon
- Fetch token prices, pool data, or on-chain state from Polygon
- Handle MATIC/POL native token and WMATIC wrapping

---

## Chain Configuration

```
Chain ID:        137
Chain Name:      Polygon
Native Token:    MATIC (18 decimals)
DexScreener ID:  "polygon"
```

### RPC Endpoints

| Endpoint | Notes |
|----------|-------|
| `https://polygon-rpc.com` | Primary |
| `https://rpc.ankr.com/polygon` | Ankr public |
| `https://polygon.llamarpc.com` | Alternative |

### Block Explorer

- **PolygonScan**: `https://polygonscan.com`

### Subgraph Endpoints

| Protocol | Subgraph ID / URL |
|----------|-------------------|
| Uniswap V3 | ID: `3hCPRGf4z88VC5rsBKU5AA9FBBq5nF3jbKJG7VZCbhjm` |
| QuickSwap V3 | `https://api.thegraph.com/subgraphs/name/sameepsi/quickswap-v3` |
| SushiSwap V3 | ID: `8obLTNcEymu5ViYeTfPBYFbTrmvk8jqa8Y1pjqE6wGYd` |
| Blocks | ID: `FRWDCP3m5n2TZyjdvt6EcpPbpW9kxDgHvRqvE82FEqwG` |

---

## Key Tokens

### Wrapped Native

```
WMATIC:  0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270 (18 decimals)
```

### Stablecoins

| Token | Address | Decimals | Notes |
|-------|---------|----------|-------|
| USDC (native) | `0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359` | **6** | Circle native |
| USDC.e (bridged) | `0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174` | **6** | Legacy Ethereum bridge |
| USDT | `0xc2132D05D31c914a87C6611C10748AEb04B58e8F` | **6** | |
| DAI | `0x8f3Cf7ad23Cd3CaDbD9735AFf958023239c6A063` | 18 | |

### Major Tokens

| Token | Address | Decimals | Notes |
|-------|---------|----------|-------|
| WETH | `0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619` | 18 | Bridged Ethereum |
| WBTC | `0x1BFD67037B42Cf73acf2047067bd4F2C47D9BfD6` | **8** | |
| QUICK | `0xB5C064F955D8e7F38fE0460C556a72987494eE17` | 18 | QuickSwap governance |

---

## Common Infrastructure

| Contract | Address |
|----------|---------|
| Multicall3 | `0xcA11bde05977b3631167028862bE2a173976CA11` |
| Permit2 | `0x000000000022D473030F116dDEE9F6B43aC78BA3` |

---

## Protocol Contracts (6 DEXs)

### 1. QuickSwap V3 (Algebra Protocol) — PRIMARY DEX

QuickSwap V3 is the dominant concentrated liquidity DEX on Polygon. It uses the **Algebra protocol**, which differs from standard Uniswap V3 in key ways:

- **Dynamic fees** instead of fixed fee tiers
- Different tick spacing model
- Non-standard pool interface

```
Factory:          0x411b0fAcC3489691f28ad58c47006AF5E3Ab3A28
SwapRouter:       0xf5b509bB0909a69B1c207E495f687a596C168E12
Quoter:           0xa15F0D7377B2A0C0c10db057f641beD21028FC89
Quoter V2:        0x3d146FcE6c1006857750cBe8aF44f76a28041CCc
Position Manager: 0x8eF88E4c7CfbbaC1C163f7eddd4B578792201de6
```

**Algebra-Specific Notes**:
- Dynamic fees mean the fee percentage changes based on pool volatility
- Tick spacings: 60, 100, 200 (not the standard 1, 10, 60, 200)
- Pool state queries return `fee` as a dynamic value, not a fixed tier
- Position NFTs work similarly to Uniswap V3 but factory interface differs

### 2. SushiSwap V3

```
Factory:          (uses standard Uniswap V3 interface)
Position Manager: (available via subgraph)
```

Fee Tiers: 100, 500, 3000, 10000 (standard Uniswap V3).

Subgraph: `https://api.thegraph.com/subgraphs/name/sushi-v3/v3-polygon`

### 3. Curve Finance

```
Registry:         0x47bB542B9dE58b970bA50c9dae444DDB4c16751a
Address Provider: 0x0000000022D53366457F9d5E68Ec105046FC4383
Factory:          0x722272D36ef0Da72FF51c5A65Db7b870E2e8D4ee
```

Pool types: Stable, Crypto, Metapool. Optimized for stablecoin swaps (USDC/USDT/DAI) with minimal slippage via StableSwap invariant.

### 4. Balancer V2

```
Vault:                     0xBA12222222228d8Ba445958a75a0704d566BF2C8
Weighted Pool Factory:     0x8E9aa87E45e92bad84D5F8DD1bff34Fb92637dE9
Stable Pool Factory:       0xc66Ba2B6595D3613CCab350C886aCE23866EDe24
Composable Stable Factory: 0x136fd06fA01Ecf624C7f2B3Cb15742C1339dC2C4
```

Pool types: Weighted (custom token weights, 2-8 tokens), Stable, Composable Stable. Features: veBAL governance, boosted pools, multi-token LP.

### 5. iZUMi Finance

```
Factory:           0x93C22Fbeff4448F2fb6e432579b0638838Ff9581
SwapRouter:        0xBd3bd95529e0784aD973FD14928eEDF3678cfad8
Quoter:            0x2db0AFD0045F3518c77eC6591a542e326Befd3D7
Liquidity Manager: 0x110dE362cc436D7f54210f96b8C7652C2617887D
```

Fee Tiers: 100 (0.01%), 400 (0.04%), 2000 (0.20%), 10000 (1.00%). Point Delta: 40. Features: Discretized liquidity, limit orders, one-sided LP.

### 6. Uniswap V3

**Note**: Uniswap V3 has a subgraph for Polygon but may not have official contract deployments. Position tracking available via subgraph queries. Check `config/dexs/uniswap.js` for current Polygon support status.

---

## Common Pitfalls

### 1. QuickSwap Algebra Dynamic Fees

QuickSwap V3 uses Algebra's **dynamic fee model**, not fixed Uniswap V3 fee tiers. This means:
- You cannot assume a fixed fee when calculating fee APR
- The fee value returned from pool state is the current dynamic fee, not a tier ID
- Tick spacing differs from standard V3 (60, 100, 200 instead of 1, 10, 60, 200)
- Pool address derivation uses Algebra's factory, not the standard Uniswap V3 `getPool` pattern

Normalize fee data in adapters when comparing across DEXs.

### 2. USDC Fragmentation

Like Base and Arbitrum, Polygon has two USDC tokens:
- **Native USDC** (`0x3c49...`): Circle's canonical deployment, newer
- **USDC.e** (`0x2791...`): Legacy Ethereum-bridged version, still widely used

Many established pools use USDC.e. New pools prefer native USDC. Support both.

### 3. MATIC vs POL Naming

Polygon's native token was renamed from MATIC to POL, but the chain still functions with MATIC as the gas token. WMATIC address remains the same. Some APIs may use "POL" while others still use "MATIC".

### 4. Low Gas = Frequent Rebalancing

Polygon's extremely low gas costs (~$0.01-0.02 per swap) make it economical for frequent position rebalancing. This means more active LP strategies are viable compared to Ethereum. However, this also means pools can have more volatile fee rates.

### 5. Subgraph Sync Delays

Polygon subgraphs occasionally lag 5-15 minutes behind chain head. Always validate subgraph data against on-chain calls for critical calculations. Check `_meta.block.number` in subgraph responses and compare to latest block via RPC.

### 6. Checkpoint Finality

Polygon uses ~6.5 hour checkpoint intervals with Ethereum for finality. Position snapshots in the dashboard update faster than this, but withdrawal finality depends on checkpoints.

### 7. Block Time

Polygon has ~2 second block times, much faster than Ethereum. This affects:
- `eth_getLogs` queries (more blocks per time period)
- Snapshot frequency calculations
- Historical data backfill (more data points per day)

---

## Gas Economics

| Operation | Approx Gas | Approx Cost |
|-----------|-----------|-------------|
| Swap | 50k-100k | ~$0.01-0.02 |
| Mint Position | 150k-250k | ~$0.02-0.05 |
| Collect Fees | 100k-150k | ~$0.01-0.03 |
| Add Liquidity | 200k-300k | ~$0.03-0.05 |

Low gas makes Polygon ideal for active LP management strategies.

---

## When to Combine with Other Skills

| Skill | Use When |
|-------|----------|
| `v3-math-verifier` | Editing fee calculation logic — note QuickSwap's dynamic fees differ |
| `ethereum-ecosystem` | Cross-chain position comparison |
| `base-ecosystem` | Comparing L2 DEX ecosystems |
| `frontend-design` | Building dashboard UI components |

---

## Quick Reference Card

```
Chain ID:           137
Native:             MATIC (18 dec)
Wrapped:            0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270 (WMATIC)
Multicall3:         0xcA11bde05977b3631167028862bE2a173976CA11
Permit2:            0x000000000022D473030F116dDEE9F6B43aC78BA3
RPC (primary):      https://polygon-rpc.com
Explorer:           https://polygonscan.com
DexScreener chain:  "polygon"

QuickSwap V3 (Algebra):
  Factory:            0x411b0fAcC3489691f28ad58c47006AF5E3Ab3A28
  PosMgr:             0x8eF88E4c7CfbbaC1C163f7eddd4B578792201de6
  Fees:               DYNAMIC (not fixed tiers!)
  Tick Spacings:      60, 100, 200

Curve Registry:     0x47bB542B9dE58b970bA50c9dae444DDB4c16751a
Balancer Vault:     0xBA12222222228d8Ba445958a75a0704d566BF2C8

USDC (native):  0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359 (6 dec)
USDC.e:         0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174 (6 dec)
USDT:           0xc2132D05D31c914a87C6611C10748AEb04B58e8F (6 dec)
DAI:            0x8f3Cf7ad23Cd3CaDbD9735AFf958023239c6A063 (18 dec)
WETH:           0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619 (18 dec)
WBTC:           0x1BFD67037B42Cf73acf2047067bd4F2C47D9BfD6 (8 dec)
QUICK:          0xB5C064F955D8e7F38fE0460C556a72987494eE17 (18 dec)
```

---

## Last Verified

**2026-03-02** — Rigorous Researcher audit. All contract addresses, token addresses, and subgraph IDs verified against codebase config files. No fixes needed. Confidence: HIGH.

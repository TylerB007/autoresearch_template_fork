---
name: arbitrum-ecosystem
description: Reference skill for building read-only analytics, LP tracking, and DeFi dashboard applications on Arbitrum One (chain ID 42161). Covers RPC setup, DEX contracts (Uniswap V3/V4, Camelot, SushiSwap, PancakeSwap, Curve, Balancer, Trader Joe, iZUMi), token addresses, price fetching, and known pitfalls including Messari subgraph schema. Load when working with Arbitrum DeFi data, LP positions, or Camelot integration on chain 42161.
---

# Arbitrum Ecosystem Skill

## Purpose

Load this skill when an agent needs to:

- Build or modify read-only analytics for Arbitrum One (chain ID 42161)
- Track concentrated liquidity positions on Arbitrum DEXs
- Work with Camelot (Arbitrum-native DEX) or its NFT/Nitro pool system
- Interact with Uniswap, SushiSwap, PancakeSwap, Curve, Balancer, Trader Joe, or iZUMi on Arbitrum
- Handle Messari-schema subgraph queries (Arbitrum Uniswap V3 uses non-standard schema)
- Fetch token prices, pool data, or on-chain state from Arbitrum

---

## Chain Configuration

```
Chain ID:        42161
Chain Name:      Arbitrum One
Native Token:    ETH (18 decimals)
DexScreener ID:  "arbitrum"
```

### RPC Endpoints

| Endpoint | Notes |
|----------|-------|
| `https://arb1.arbitrum.io/rpc` | Primary official |
| `https://arbitrum.llamarpc.com` | Alternative |
| `https://rpc.ankr.com/arbitrum` | Ankr public |

### Block Explorer

- **Arbiscan**: `https://arbiscan.io`

### Subgraph Endpoints

| Protocol | Subgraph ID | Schema |
|----------|-------------|--------|
| Uniswap V3 | `FQ6JYszEKApsBpAmiHesRsd9Ygc6mzmpNRANeVQFYoVX` | **Messari** (non-standard!) |
| SushiSwap V3 | `8nFDCAhdnJQEhQF3ZRnfWkJ6FkRsfAjcDYvt2G9uLv3V` | Standard |
| Blocks | `E7rWd4RVvGU6d7g55X38GhCXPGDzxwWPvaTKrqrrrNvz` | Standard |

**Critical**: Arbitrum's Uniswap V3 subgraph uses Messari schema — see pitfalls section.

---

## Key Tokens

### Wrapped Native

```
WETH:  0x82aF49447D8a07e3bd95BD0d56f35241523fBab1 (18 decimals)
```

### Stablecoins

| Token | Address | Decimals | Notes |
|-------|---------|----------|-------|
| USDC (native) | `0xaf88d065e77c8cC2239327C5EDb3A432268e5831` | **6** | Circle native |
| USDC.e (bridged) | `0xFF970A61A04b1cA14834A43f5dE4533eBDDB5CC8` | **6** | Legacy bridge |
| USDT | `0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9` | **6** | |
| DAI | `0xDA10009cBd5D07dd0CeCc66161FC93D7c9000da1` | 18 | |

### Major Tokens

| Token | Address | Decimals | Notes |
|-------|---------|----------|-------|
| WBTC | `0x2f2a2543B76A4166549F7aaB2e75Bef0aefC5B0f` | **8** | |
| ARB | `0x912CE59144191C1204E64559FE8253a0e49E6548` | 18 | Arbitrum governance token |
| LINK | `0xf97f4df75117a78c1A5a0DBb814Af92458539FB4` | 18 | |

---

## Common Infrastructure

| Contract | Address |
|----------|---------|
| Multicall3 | `0xcA11bde05977b3631167028862bE2a173976CA11` |
| Permit2 | `0x000000000022D473030F116dDEE9F6B43aC78BA3` |

---

## Protocol Contracts (8 DEXs)

### 1. Uniswap (V2 + V3 + V4)

**V2:**
```
Factory:        0xf1D7CC64Fb4452F05c498126312eBE29f30Fbcf9
Router:         0x4752ba5dbc23f44d87826276bf6fd6b1c372ad24
Init Code Hash: 0x96e8ac4277198ff8b6f785478aa9a39f403cb768dd02cbee326c3e7da348845f
```

**V3:**
```
Factory:          0x1F98431c8aD98523631AE4a59f267346ea31F984
Router:           0xE592427A0AEce92De3Edee1F18E0157C05861564
Position Manager: 0xC36442b4a4522E871399CD717aBDD847Ab11FE88
Quoter:           0xb27308f9F90D607463bb33eA1BeBb41C27CE5AB6
Quoter V2:        0x61fFE014bA17989E743c5F6cB21bF9697530B21e
SwapRouter02:     0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45
```

Fee Tiers: 100, 500, 3000, 10000 (standard). Tick Spacings: 1, 10, 60, 200.

**V4 (Singleton):**
```
PoolManager:      0x360e68faccca8ca495c1b759fd9eee466db9fb32
Position Manager: 0xd88f38f930b7952f2db2432cb002e7abbf3dd869
Universal Router: 0xa51afafe0263b40edaef0df8781ea9aa03e381a3
```

### 2. Camelot (ARBITRUM-NATIVE)

Camelot is the leading Arbitrum-native DEX with NFT pools, Nitro pools, and GRAIL token incentives. Only supported on chain 42161.

**V2:**
```
Factory:        0x6EcCab422D763aC031210895C81787E87B43A652
Router:         0xc873fEcbd354f5A56E00E710B90EF4201db2448d
Init Code Hash: 0xa856464ae65f7619087bc369daaf7e387dae1e5af69cfa7935850ebf754b04c1
```

**V3 (Concentrated Liquidity):**
```
Factory:          0x1a3c9B1d2F0529D97f2afC5136Cc23e58f1FD35B
SwapRouter:       0x1F721E2E82F6676FCE4eA07A5958cF098D339e18
Quoter:           0x0Fc73040b26E9bC8514fA028D998E73A254Fa76E
Position Manager: 0x00c7f3082833e796A5b3e4Bd59f6642FF44DCD15
```

Fee Tiers: 100, 500, 3000, 10000. Features: NFT Pools, Nitro Pools (boosted farming), Launchpad, GRAIL token.

### 3. SushiSwap (V2 + V3)

**V2:**
```
Factory:        0xc35DADB65012eC5796536bD9864eD8773aBc74C4
Router:         0x1b02dA8Cb0d097eB8D57A175b88c7D8b47997506
Init Code Hash: 0xe18a34eb0e04b04f7a0ac29a6e80748dca96319b42c54d679cb821dca90c6303
```

**V3:**
```
Factory:          0x1af415a1EbA07a4986a52B6f2e7dE7003D82231e
Router:           0xfc506AaA1340b4dedFfd88bE278bEe058952D674
Position Manager: 0xF0cBce1942A68BEB3d1b73F0dd86C8DCc363eF49
Quoter:           0x0524E833cCD057e4d7A296e3aaAb9f7675964Ce1
```

Fee Tiers: 100, 500, 3000, 10000 (standard).

### 4. PancakeSwap (V2 + V3)

**V2:**
```
Factory:        0x02a84c5b5a03e647c05dd5a9ce4e8c2f24be58e1
Router:         0x8cFe327CEc66d1C090Dd72bd0FF11d690C33a2Eb
Init Code Hash: 0x00fb7f630766e6a796048ea87d01acd3068e8ff67d078148a3fa3f4a84f69bd5
```

**V3:**
```
Factory:          0x0BFbCF9fa4f9C56B0F40a671Ad40E0805A091865
Deployer:         0x41ff9AA7e16B8B1a8a8dc4f0eFacd93D02d071c9
Router:           0x1b81D678ffb9C0263b24A97847620C99d213eB14
Position Manager: 0x46A15B0b27311cedF172AB29E4f4766fbE7F4364
Quoter V2:        0xB048Bbc1Ee6b733FFfCFb9e9CeF7375518e25997
```

**Fee Tiers**: 100, 500, **2500** (0.25%), 10000 — tick spacing 50 for 2500 tier.

### 5. Curve Finance

```
Registry:         0x445FE580eF8d70FF569aB36e80c647af338db351
Address Provider: 0x0000000022D53366457F9d5E68Ec105046FC4383
Factory:          0xb17b674D9c5CB2e441F8e196a2f048A81355d031
```

Pool types: Stable, Crypto, Metapool. StableSwap invariant for low-slippage stablecoin swaps.

### 6. Balancer V2

```
Vault:                     0xBA12222222228d8Ba445958a75a0704d566BF2C8
Weighted Pool Factory:     0x8E9aa87E45e92bad84D5F8DD1bff34Fb92637dE9
Stable Pool Factory:       0x8df6EfEc5547e31B0eb7d1291B511FF8a2bf987c
Composable Stable Factory: 0x2498A2B0d6462d2260EAC50aE1C3e03F4829BA95
```

Pool types: Weighted, Stable, Composable Stable, Meta. Multi-token pools (2-8 tokens).

### 7. Trader Joe (Liquidity Book)

**V2:**
```
Factory:  0x8e42f2F4101563bF679975178e880FD87d3eFd4e
Router:   0xb4315e873dBcf96Ffd0acd8EA43f689D8c20fB30
Quoter:   0x64b57F4249aA99a812212cee7DAEFEDC40B203cD
```

**V2.1:**
```
Factory:  0x1886D09C9Ade0c5DB822D85D21678Db67B6c2982
Router:   0xb4315e873dBcf96Ffd0acd8EA43f689D8c20fB30
```

Features: Discrete liquidity bins, variable fees, surge protection. Bin steps: 1, 2, 3, 4, 5, 10, 15, 20, 25, 50, 100.

### 8. iZUMi Finance

```
Factory:           0x93C22Fbeff4448F2fb6e432579b0638838Ff9581
SwapRouter:        0xBd3bd95529e0784aD973FD14928eEDF3678cfad8
Quoter:            0x2db0AFD0045F3518c77eC6591a542e326Befd3D7
Liquidity Manager: 0x110dE362cc436D7f54210f96b8C7652C2617887D
```

Fee Tiers: 100 (0.01%), 400 (0.04%), 2000 (0.20%), 10000 (1.00%). Point Delta: 40. Features: Discretized liquidity, limit orders, one-sided LP.

---

## Common Pitfalls

### 1. Messari Subgraph Schema (Critical)

Arbitrum's Uniswap V3 subgraph uses **Messari schema**, not the standard Uniswap V3 schema.

**Key difference**: Position queries use `account` field instead of `owner`.

```graphql
# Standard Uniswap V3 schema (Ethereum, Base, etc.)
positions(where: { owner: "0x..." }) { ... }

# Messari schema (Arbitrum)
positions(where: { account: "0x..." }) { ... }
```

**Status**: Adapter not yet implemented in `lib/graphql/adapters/`. When querying positions on Arbitrum, check for both field names or use direct RPC calls as fallback.

### 2. USDC Fragmentation

Like Base, Arbitrum has two USDC tokens:
- Native USDC (`0xaf88...`): canonical Circle deployment
- USDC.e (`0xFF97...`): legacy Ethereum bridge

Default to native USDC. Some older pools use USDC.e.

### 3. PancakeSwap 0.25% Tier

PancakeSwap V3 uses 2500 bps (0.25%) with tick spacing 50, not the standard 3000/60. Affects pool address derivation.

### 4. Trader Joe Bin-Based Liquidity

Trader Joe uses discrete bin-based liquidity (Liquidity Book), not continuous ranges like Uniswap V3. Position tracking requires different math — bins instead of tick ranges. Variable fees change dynamically based on volatility.

### 5. Camelot NFT/Nitro Pools

Camelot's incentive system (NFT Pools, Nitro Pools) adds complexity beyond standard V3 position tracking. GRAIL token rewards are not captured by standard fee calculation. Verify total earnings against Camelot UI.

### 6. Position URL Format

```
/position/{chainId}-{dex}-{tokenId}
Example: /position/42161-uniswap-12345
Example: /position/42161-camelot-67890
```

DEX name is lowercase protocol key: `uniswap`, `camelot`, `sushiswap`, `pancakeswap`, etc.

---

## Fee Tier Summary Across DEXs

| DEX | Tiers (bps) | Non-Standard? |
|-----|-------------|---------------|
| Uniswap | 100, 500, 3000, 10000 | No |
| Camelot | 100, 500, 3000, 10000 | No |
| SushiSwap | 100, 500, 3000, 10000 | No |
| PancakeSwap | 100, 500, **2500**, 10000 | Yes (0.25% not 0.30%) |
| iZUMi | 100, **400**, **2000**, 10000 | Yes (custom tiers) |
| Trader Joe | Bin steps 1-100 | Yes (entirely different model) |

---

## When to Combine with Other Skills

| Skill | Use When |
|-------|----------|
| `v3-math-verifier` | Editing fee calculation logic or IL math |
| `ethereum-ecosystem` | Cross-chain comparisons, shared Uniswap V3 patterns |
| `base-ecosystem` | Comparing L2 DEX ecosystems |
| `frontend-design` | Building dashboard UI components |

---

## Quick Reference Card

```
Chain ID:           42161
Native:             ETH (18 dec)
Wrapped:            0x82aF49447D8a07e3bd95BD0d56f35241523fBab1 (WETH)
Multicall3:         0xcA11bde05977b3631167028862bE2a173976CA11
Permit2:            0x000000000022D473030F116dDEE9F6B43aC78BA3
RPC (primary):      https://arb1.arbitrum.io/rpc
Explorer:           https://arbiscan.io
DexScreener chain:  "arbitrum"

Uniswap V3 Factory:     0x1F98431c8aD98523631AE4a59f267346ea31F984
Uniswap V3 PosMgr:      0xC36442b4a4522E871399CD717aBDD847Ab11FE88
Uniswap V3 Subgraph:    MESSARI SCHEMA (uses "account" not "owner")

Camelot V3 Factory:     0x1a3c9B1d2F0529D97f2afC5136Cc23e58f1FD35B
Camelot V3 PosMgr:      0x00c7f3082833e796A5b3e4Bd59f6642FF44DCD15

SushiSwap V3 Factory:   0x1af415a1EbA07a4986a52B6f2e7dE7003D82231e
SushiSwap V3 PosMgr:    0xF0cBce1942A68BEB3d1b73F0dd86C8DCc363eF49

PancakeSwap V3 PosMgr:  0x46A15B0b27311cedF172AB29E4f4766fbE7F4364
PancakeSwap V3 Tiers:   100, 500, 2500, 10000 (NOT 3000!)

Trader Joe V2 Factory:  0x8e42f2F4101563bF679975178e880FD87d3eFd4e

USDC (native):  0xaf88d065e77c8cC2239327C5EDb3A432268e5831 (6 dec)
USDC.e:         0xFF970A61A04b1cA14834A43f5dE4533eBDDB5CC8 (6 dec)
USDT:           0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9 (6 dec)
DAI:            0xDA10009cBd5D07dd0CeCc66161FC93D7c9000da1 (18 dec)
WBTC:           0x2f2a2543B76A4166549F7aaB2e75Bef0aefC5B0f (8 dec)
ARB:            0x912CE59144191C1204E64559FE8253a0e49E6548 (18 dec)
```

---

## Last Verified

**2026-03-02** — Rigorous Researcher audit. All contract addresses, token addresses, fee tiers, and subgraph IDs verified against codebase config files. No fixes needed. Confidence: HIGH.

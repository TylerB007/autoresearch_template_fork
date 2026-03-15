---
name: base-ecosystem
description: Reference skill for building read-only analytics, LP tracking, and DeFi dashboard applications on Base (chain ID 8453). Covers RPC setup, DEX contracts (Uniswap V3/V4, Aerodrome Slipstream, SushiSwap, PancakeSwap, Balancer, Maverick, iZUMi), token addresses, price fetching, and known pitfalls. Load when working with Base DeFi data, LP positions, or Aerodrome integration on chain 8453.
---

# Base Ecosystem Skill

## Purpose

Load this skill when an agent needs to:

- Build or modify read-only analytics for Base (chain ID 8453)
- Track concentrated liquidity positions on Base DEXs
- Work with Aerodrome (Slipstream + Classic) — the dominant Base DEX
- Interact with Uniswap V3/V4, SushiSwap, PancakeSwap, Balancer, Maverick, or iZUMi on Base
- Fetch token prices, pool data, or on-chain state from Base
- Configure viem/ethers clients for Base RPC

---

## Chain Configuration

```
Chain ID:        8453
Chain Name:      Base
Native Token:    ETH (18 decimals)
DexScreener ID:  "base"
```

### RPC Endpoints

| Endpoint | Notes |
|----------|-------|
| `https://base.publicnode.com` | Recommended primary |
| `https://base.llamarpc.com` | Alternative |
| `https://mainnet.base.org` | Official Base RPC |

### Block Explorer

- **Basescan**: `https://basescan.org`

### Subgraph Endpoints

| Protocol | Endpoint |
|----------|----------|
| Uniswap V3 | ID: `43Hwfi3dJSoGpyas9VwNoDAv55yjgGrPpNSmbQZArzMG` |
| Uniswap V4 | ID: `DiYPVdygkfjDWhbxGSqAQxwBKmfKnkWQojqeM2rkLb3G` |
| Aerodrome Slipstream | `https://api.thegraph.com/subgraphs/name/aerodrome-finance/aerodrome-cl` (external ref, not in project config) |

---

## Key Tokens

### Wrapped Native

```
WETH:  0x4200000000000000000000000000000000000006 (18 decimals)
```

**Note**: Base uses the L2 standard WETH address (`0x4200...0006`), NOT the Ethereum mainnet WETH address.

### Stablecoins

| Token | Address | Decimals | Notes |
|-------|---------|----------|-------|
| USDC (native) | `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` | **6** | Circle native USDC |
| USDbC (bridged) | `0xd9aAEc86B65D86f6A7B5B1b0c42FFA531710b6CA` | **6** | Legacy bridged USDC |
| DAI | `0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb` | 18 | Bridged DAI |

**USDC Fragmentation**: Base has TWO USDC variants. Native USDC (`0x8335...`) is the canonical version. USDbC (`0xd9aA...`) is the older bridged version. Both are 6 decimals but are different tokens with different liquidity pools.

### Other Major Tokens

| Token | Address | Decimals | Notes |
|-------|---------|----------|-------|
| cbETH | `0x2Ae3F1Ec7F1F5012CFEab0185bfc7aa3cf0DEc22` | 18 | Coinbase Wrapped Staked ETH |
| AERO | `0x940181a94A35A4569E4529A3CDfB74e38FD98631` | 18 | Aerodrome governance token |

---

## Common Infrastructure

| Contract | Address |
|----------|---------|
| Multicall3 | `0xcA11bde05977b3631167028862bE2a173976CA11` |
| Permit2 | `0x000000000022D473030F116dDEE9F6B43aC78BA3` |

---

## Protocol Contracts (7 DEXs)

### 1. Uniswap (V2 + V3 + V4)

**V2:**
```
Factory:        0x8909Dc15e40173Ff4699343b6eB8132c65e18eC6
Router:         0x4752ba5dbc23f44d87826276bf6fd6b1c372ad24
Init Code Hash: 0x96e8ac4277198ff8b6f785478aa9a39f403cb768dd02cbee326c3e7da348845f
```

**V3:**
```
Factory:          0x33128a8fC17869897dcE68Ed026d694621f6FDfD
Router:           0x2626664c2603336E57B271c5C0b26F421741e481
Position Manager: 0x03a520b32C04BF3bEEf7BEb72E919cf822Ed34f1
Quoter:           0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a
SwapRouter02:     0x2626664c2603336E57B271c5C0b26F421741e481
```

Fee Tiers: 100, 500, 3000, 10000 (standard)

**V4 (Singleton Architecture):**
```
PoolManager:      0x498581ff718922c3f8e6a244956af099b2652b2b
Position Manager: 0x7c5f5a4bbd8fd63184577525326123b519429bdc
Universal Router: 0x6ff5693b99212da76ad316178a184ab56d299b43
```

V4 PositionManager does NOT support ERC721Enumerable — use subgraph for position discovery.

### 2. Aerodrome (UNIQUE TO BASE)

Aerodrome is the dominant DEX on Base (~45% market share) with dual architecture.

**V2 Classic (Solidly Fork):**
```
Factory:  0x420DD381b31aEf6683db6B902084cB0FFECe40Da
Router:   0xcF77a3Ba9A5CA399B7c97c74d54e5b1Beb874E43
Voter:    0x16613524e02ad97eDfeF371bC883F2F5d6C480A5
Gauge:    0x4F81992FCe2E1846dD528eC0102e6eE1f61ed587
```

Features: veNFT (vote-escrowed NFT), gauge-based emissions, volatile and stable pool variants.

**Slipstream (V3-Style Concentrated Liquidity):**
```
Factory:          0x5e7BB104d84c7CB9B682AaC2F3d509f5F406809A
Router:           0xBE6D8f0d05cC4be24d5167a3eF062215bE6D18a5
Position Manager: 0x827922686190790b37229fd06084350E74485b72
Quoter:           0x254cF9E1E6e233aa1AC962CB9B05b2cfeAaE15b0
```

**Slipstream Fee Tiers** (non-standard encoding!):

| Fee Value | Percentage | Tick Spacing | Uniswap Equivalent |
|-----------|-----------|--------------|---------------------|
| 1 | 0.01% | 1 | 100 |
| 5 | 0.05% | 10 | 500 |
| 30 | 0.30% | 60 | 3000 |
| 100 | 1.00% | 200 | 10000 |

**Critical**: Aerodrome Slipstream uses fee values 1/5/30/100, NOT 100/500/3000/10000. When comparing across DEXs, map: `1 → 100, 5 → 500, 30 → 3000, 100 → 10000`.

### 3. SushiSwap (V2 + V3)

**V2:**
```
Factory:        0x71524B4f93c58fcbF659783284E38825f0622859
Router:         0x6BDED42c6DA8FBf0d2bA55B2fa120C5e0c8D7891
Init Code Hash: 0xe18a34eb0e04b04f7a0ac29a6e80748dca96319b42c54d679cb821dca90c6303
```

**V3:**
```
Factory:          0xc35DADB65012eC5796536bD9864eD8773aBc74C4
Router:           0xFB7eF66a7e61224DD6FcD0D7d9C3be5C8B049b9f
Position Manager: 0x80C7DD17B01855a6D2347444a0FCC36136a314de
Quoter:           0xb1E835Dc2785b52265711e17fCCb0fd018226a6e
```

Fee Tiers: 100, 500, 3000, 10000 (standard)

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

**PancakeSwap Fee Tiers**: 100, 500, **2500** (0.25%), 10000 — uses 2500 with tick spacing 50, not the standard 3000/60.

### 5. Balancer V2

```
Vault:                     0xBA12222222228d8Ba445958a75a0704d566BF2C8
Weighted Pool Factory:     0x4C32a8a8fDa4E24139B51b456B42290f51d6A1c4
Composable Stable Factory: 0x8df6EfEc5547e31B0eb7d1291B511FF8a2bf987c
```

Pool types: Weighted, Stable, Composable Stable, Meta.

### 6. Maverick V1

```
Factory:  0x0A7e848Aca42d879EF06507Fad15bCfBf1DE0a92
Router:   0x32AED3Bce901DA12ca8489788F3A99fCe1056e14
Position: 0xFd54762D435A490405DDa0fBc92b7168934e8525
```

Position modes: STATIC (0), RIGHT (1), LEFT (2), BOTH (3). Bin widths: 1-128 ticks.

### 7. iZUMi Finance

```
Factory:           0x93C22Fbeff4448F2fb6e432579b0638838Ff9581
SwapRouter:        0xBd3bd95529e0784aD973FD14928eEDF3678cfad8
Quoter:            0x2db0AFD0045F3518c77eC6591a542e326Befd3D7
Liquidity Manager: 0x110dE362cc436D7f54210f96b8C7652C2617887D
```

Fee Tiers: 100 (0.01%), 400 (0.04%), 2000 (0.20%), 10000 (1.00%). Point Delta: 40.

---

## Common Pitfalls

### 1. Aerodrome Fee Encoding

Aerodrome Slipstream uses fee values 1/5/30/100 instead of the standard 100/500/3000/10000. When cross-referencing pools or building universal fee comparisons, you must normalize. The underlying tick spacings match (1, 10, 60, 200).

### 2. USDC Fragmentation

Two USDC tokens exist on Base:
- Native USDC (`0x8335...`): canonical, used by Coinbase, higher liquidity
- USDbC (`0xd9aA...`): legacy bridged version, declining liquidity

Always default to native USDC. Some older pools may use USDbC.

### 3. PancakeSwap 0.25% Tier

PancakeSwap V3 uses a 2500 bps (0.25%) medium tier with tick spacing 50, not the Uniswap/SushiSwap standard of 3000 bps (0.30%) with tick spacing 60. Pool address derivation will fail if you assume standard tiers.

### 4. L2 WETH Address

Base uses the L2 standard WETH at `0x4200000000000000000000000000000000000006`, not the Ethereum mainnet WETH address. This is a common mistake when copying config from Ethereum.

### 5. Uniswap V4 Position Discovery

V4's singleton PoolManager doesn't support ERC721Enumerable. Cannot iterate NFT balances. Must use subgraph for position discovery.

### 6. Aerodrome veNFT Rewards

Aerodrome LPs earn base trading fees PLUS veNFT emission rewards. The dashboard may not fully track emission rewards — total LP earnings should be verified against Aerodrome's UI.

---

## DEX Market Share (Approximate)

| DEX | Share | Notes |
|-----|-------|-------|
| Aerodrome | ~45% | Dominant, veNFT ecosystem |
| Uniswap | ~35% | Deep liquidity, V3 + V4 |
| SushiSwap | ~10% | Cross-chain presence |
| PancakeSwap | ~5% | Growing |
| Balancer/Maverick/iZUMi | ~5% | Combined niche |

---

## When to Combine with Other Skills

| Skill | Use When |
|-------|----------|
| `v3-math-verifier` | Editing fee calculation logic or IL math |
| `ethereum-ecosystem` | Cross-chain comparisons (Base is an Ethereum L2) |
| `frontend-design` | Building dashboard UI components |
| `institutional-ui-enforcer` | Applying data-dense institutional layouts |

---

## Quick Reference Card

```
Chain ID:           8453
Native:             ETH (18 dec)
Wrapped:            0x4200000000000000000000000000000000000006 (WETH)
Multicall3:         0xcA11bde05977b3631167028862bE2a173976CA11
Permit2:            0x000000000022D473030F116dDEE9F6B43aC78BA3
RPC (primary):      https://base.publicnode.com
Explorer:           https://basescan.org
DexScreener chain:  "base"

Uniswap V3 Factory:     0x33128a8fC17869897dcE68Ed026d694621f6FDfD
Uniswap V3 PosMgr:      0x03a520b32C04BF3bEEf7BEb72E919cf822Ed34f1

Aerodrome Slipstream:
  Factory:               0x5e7BB104d84c7CB9B682AaC2F3d509f5F406809A
  PosMgr:                0x827922686190790b37229fd06084350E74485b72
  Fee Tiers:             1, 5, 30, 100 (NOT 100/500/3000/10000!)

Aerodrome V2 Classic:
  Factory:               0x420DD381b31aEf6683db6B902084cB0FFECe40Da
  Router:                0xcF77a3Ba9A5CA399B7c97c74d54e5b1Beb874E43

PancakeSwap V3 PosMgr:  0x46A15B0b27311cedF172AB29E4f4766fbE7F4364
PancakeSwap V3 Tiers:   100, 500, 2500, 10000 (NOT 3000!)

USDC (native):  0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913 (6 dec)
USDbC (legacy): 0xd9aAEc86B65D86f6A7B5B1b0c42FFA531710b6CA (6 dec)
DAI:            0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb (18 dec)
AERO:           0x940181a94A35A4569E4529A3CDfB74e38FD98631 (18 dec)
cbETH:          0x2Ae3F1Ec7F1F5012CFEab0185bfc7aa3cf0DEc22 (18 dec)
```

---

## Last Verified

**2026-03-02** — Rigorous Researcher audit. All contract addresses, token addresses, and fee tiers verified against codebase config files. 2 fixes applied (Uniswap V3 subgraph ID format, Aerodrome subgraph caveat). Confidence: HIGH.

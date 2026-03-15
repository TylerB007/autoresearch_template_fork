---
name: ethereum-ecosystem
description: Reference skill for building read-only analytics, LP tracking, and DeFi dashboard applications on Ethereum mainnet (chain ID 1). Covers RPC setup, DEX contracts (Uniswap V2/V3/V4, SushiSwap, PancakeSwap, Curve, Balancer, Maverick), token addresses, price fetching, V3 fee math, and known pitfalls. Load when working with Ethereum DeFi data, LP positions, or protocol integrations on chain 1.
---

# Ethereum Ecosystem Skill

## Purpose

Load this skill when an agent needs to:

- Build or modify read-only analytics for Ethereum mainnet (chain ID 1)
- Track Uniswap V2/V3/V4 concentrated liquidity positions
- Interact with SushiSwap, PancakeSwap, Curve, Balancer, or Maverick on Ethereum
- Fetch token prices, pool data, or on-chain state from Ethereum
- Configure viem/ethers clients for Ethereum RPC
- Calculate LP fees, impermanent loss, or position values on Ethereum

---

## Chain Configuration

```
Chain ID:        1
Chain Name:      Ethereum
Native Token:    ETH (18 decimals)
DexScreener ID:  "ethereum"
```

### RPC Endpoints

| Endpoint | Notes |
|----------|-------|
| Custom via `NEXT_PUBLIC_ETH_RPC_URL` | Highest priority — QuickNode, Alchemy, etc. |
| `https://ethereum.publicnode.com` | Public fallback 1 |
| `https://1rpc.io/eth` | Public fallback 2 |
| `https://eth.llamarpc.com` | Public fallback 3 — **CORS issues from localhost** |

**CORS Warning**: `eth.llamarpc.com` blocks browser-origin CORS requests. The codebase implements `createProviderWithFallback()` to try each RPC in sequence. For local dev, use a custom RPC via `NEXT_PUBLIC_ETH_RPC_URL`.

### Block Explorer

- **Etherscan**: `https://etherscan.io`
- Etherscan API is fully supported for `tokennfttx`, `tokentx`, and other queries

### Subgraph Endpoints (The Graph)

| Protocol | Subgraph ID |
|----------|-------------|
| Uniswap V3 | `5zvR82QoaXYFyDEKLZ9t6v9adgnptxYpKpSbxtgVENFV` |
| Uniswap V4 | `DiYPVdygkfjDWhbxGSqAQxwBKmfKnkWQojqeM2rkLb3G` |
| SushiSwap | `D1fgJGTLGmCwBwH8YseAQxHzQDTwHkgNnpnREhTp7jLP` |
| Blocks | `B1fMN8BjChFSNDtu2VrXBDAZQHqJkCGorANEJb3HBSLM` |

Format: `https://gateway.thegraph.com/api/{API_KEY}/subgraphs/id/{SUBGRAPH_ID}`

---

## Key Tokens

### Wrapped Native

```
WETH:     0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2 (18 decimals)
```

### Stablecoins

| Token | Address | Decimals |
|-------|---------|----------|
| USDC | `0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48` | **6** |
| USDT | `0xdAC17F958D2ee523a2206206994597C13D831ec7` | **6** |
| DAI | `0x6B175474E89094C44Da98b954EedeAC495271d0F` | 18 |

### Major Tokens

| Token | Address | Decimals |
|-------|---------|----------|
| WBTC | `0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599` | **8** |
| UNI | `0x1f9840a85d5aF5bf1D1762F925BDADdC4201F984` | 18 |
| LINK | `0x514910771AF9Ca656af840dff83E8264EcF986CA` | 18 |

---

## Protocol Contracts

### Common Infrastructure

| Contract | Address |
|----------|---------|
| Multicall3 | `0xcA11bde05977b3631167028862bE2a173976CA11` |
| Permit2 | `0x000000000022D473030F116dDEE9F6B43aC78BA3` |
| ENS Registry | `0x00000000000C2E074eC69A0dFb2997BA6C7d2e1e` |

### Uniswap V2

```
Factory:        0x5C69bEe701ef814a2B6a3EDD4B1652CB9cc5aA6f
Router:         0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D
Init Code Hash: 0x96e8ac4277198ff8b6f785478aa9a39f403cb768dd02cbee326c3e7da348845f
```

### Uniswap V3

```
Factory:          0x1F98431c8aD98523631AE4a59f267346ea31F984
Router:           0xE592427A0AEce92De3Edee1F18E0157C05861564
Position Manager: 0xC36442b4a4522E871399CD717aBDD847Ab11FE88
Quoter:           0xb27308f9F90D607463bb33eA1BeBb41C27CE5AB6
Quoter V2:        0x61fFE014bA17989E743c5F6cB21bF9697530B21e
SwapRouter02:     0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45
```

**Fee Tiers (Standard)**:

| Fee (bps) | Percentage | Tick Spacing |
|-----------|-----------|--------------|
| 100 | 0.01% | 1 |
| 500 | 0.05% | 10 |
| 3000 | 0.30% | 60 |
| 10000 | 1.00% | 200 |

### Uniswap V4 (Singleton Architecture)

```
PoolManager:      0x000000000004444c5dc75cB358380D2e3dE08A90
Position Manager: 0xbd216513d74c8cf14cf4747e6aaa6420ff64ee9e
Universal Router: 0x66a9893cc07d91d95644aedd05d03f95e1dba8af
```

**V4 Notes**:
- All pools live in a single PoolManager contract (singleton pattern)
- Position Manager does NOT support ERC721Enumerable — use subgraph for position discovery
- `hooklessPoolKey = true` (simplified pool key structure)

### SushiSwap

**V2:**
```
Factory:        0xC0AEe478e3658e2610c5F7A4A2E1777cE9e4f2Ac
Router:         0xd9e1cE17f2641f24aE83637ab66a2cca9C378B9F
Init Code Hash: 0xe18a34eb0e04b04f7a0ac29a6e80748dca96319b42c54d679cb821dca90c6303
```

**V3:**
```
Factory:          0xbACEB8eC6b9355Dfc0269C18bac9d6E2Bdc29C4F
Router:           0x2E6cd2d30aa43f40aa81619ff4b6E0a41479B13F
Position Manager: 0x2214A42d8e2A1d20635c2cb0664422c528B6A432
Quoter:           0x64e8802FE490fa7cc61d3463958199161Bb608A7
```

Fee Tiers: 100, 500, 3000, 10000 (standard)

### PancakeSwap

**V2:**
```
Factory:        0x1097053Fd2ea711dad45caCcc45EfF7548fCB362
Router:         0xEfF92A263d31888d860bD50809A8D171709b7b1c
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

**PancakeSwap Fee Tiers**: 100, 500, **2500** (0.25%), 10000 — note the 2500 tier with tick spacing 50, different from Uniswap's 3000/60.

### Curve Finance

```
Registry:         0x90E00ACe148ca3b23Ac1bC8C240C2a7Dd9c2d7f5
Address Provider: 0x0000000022D53366457F9d5E68Ec105046FC4383
Factory V2:       0xB9fC157394Af804a3578134A6585C0dc9cc990d4
Metapool Factory: 0x0959158b6040D32d04c301A72CBFD6b39E21c9AE
```

Pool types: Stable, Crypto, Metapool. Features: StableSwap invariant, CryptoV2, gauge rewards.

### Balancer V2

```
Vault:                       0xBA12222222228d8Ba445958a75a0704d566BF2C8
Weighted Pool Factory:       0x8E9aa87E45e92bad84D5F8DD1bff34Fb92637dE9
Stable Pool Factory:         0xc66Ba2B6595D3613CCab350C886aCE23866EDe24
Composable Stable Factory:   0xfADa0f4547AB2de89D1304A668C39B3E09Aa7c76
```

Pool types: Weighted, Stable, Composable Stable, Meta. Features: Multi-token pools (2-8 tokens), custom weights, veBAL governance.

### Maverick V1

```
Factory:  0xEb6625D65a0553c9dBc64449e56abFe519bd9c9B
Router:   0x4a585E0f7C18E2C414221d6402652d5e0990E5f8
Position: 0x5bB1c3734394d245F16e7e8101a89d1d2B5C4Ff5
```

Features: Dynamic bins, position modes (STATIC, RIGHT, LEFT, BOTH). Bin widths: 1, 2, 4, 8, 16, 32, 64, 128 ticks.

---

## V3 Fee Calculation

Uniswap V3 unclaimed fees have **two components** — both must be included:

1. **`tokensOwed0/1`** — Fees already marked as collectable in the position NFT
2. **Uncollected fee growth** — Fees accrued since last collect, from `feeGrowthInside` delta

**Using only `tokensOwed` significantly underreports actual fees.** Always use `feesUSD` from the data hook.

The complete fee calculation algorithm using BigInt math with uint256 wrapping is documented in the `pulsechain-ecosystem` skill — the math is identical across all chains.

### Price Denomination Warning

- `position.currentPrice` = pool tick price = `token1/token0` ratio, NOT USD
- Never prefix with `$` — display as `{symbol1}/{symbol0}`
- USD values are separate fields: `price0USD`, `price1USD`, `feesUSD`

---

## Common Pitfalls

### 1. Archive Node Requirement

Ethereum requires archive nodes for historical state queries older than ~128 blocks. Public RPCs may not have archive access, causing `getTransactionReceipt()` failures for old positions. The codebase falls back to querying `IncreaseLiquidity` event logs at the known mint block.

### 2. eth_getLogs Block Range

Ethereum's `eth_getLogs` limit varies by provider. The codebase uses conservative 5-block ranges for QuickNode Discover plan. Adjust for higher-tier providers.

### 3. CORS with Public RPCs

`eth.llamarpc.com` blocks CORS from localhost. The `createProviderWithFallback()` pattern tries each RPC until one succeeds. Use `NEXT_PUBLIC_ETH_RPC_URL` for reliable local development.

### 4. PancakeSwap Fee Tier Mismatch

PancakeSwap V3 uses 2500 bps (0.25%) with tick spacing 50, where Uniswap/SushiSwap use 3000 bps (0.30%) with tick spacing 60. Pool address derivation and tick alignment calculations must account for this.

### 5. V4 Position Discovery

Uniswap V4's singleton PoolManager doesn't support ERC721Enumerable. You cannot iterate NFT balances to find positions. Use the V4 subgraph for position discovery.

### 6. WBTC is 8 Decimals

WBTC uses 8 decimals (matching Bitcoin), not 18. This is a frequent source of math errors in WBTC/ETH pool calculations.

### 7. Gas Costs

Ethereum has the highest gas costs of all supported chains. Position management operations:
- Mint: ~350,000 gas
- Collect fees: ~200,000 gas
- Swap: ~150,000 gas

---

## Testing

### Test Pool

**Uniswap V3 WBTC/ETH**:
- Pool: `0xEeb8F880EAd7281A301ef2E6791A6bBe790603eD`
- Token0: WBTC, Token1: WETH, Fee: 3000 (0.30%), Tick Spacing: 60

### Backfill Test

```bash
node scripts/database/test-backfill.cjs --chain=1 --days=30
```

---

## When to Combine with Other Skills

| Skill | Use When |
|-------|----------|
| `v3-math-verifier` | Editing fee calculation logic or IL math |
| `pulsechain-ecosystem` | Cross-chain position comparison (Ethereum + PulseChain) |
| `frontend-design` | Building dashboard UI components |
| `supabase-backfill-runner` | Running historical data backfills |

---

## Quick Reference Card

```
Chain ID:           1
Native:             ETH (18 dec)
Wrapped:            0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2 (WETH)
Multicall3:         0xcA11bde05977b3631167028862bE2a173976CA11
Permit2:            0x000000000022D473030F116dDEE9F6B43aC78BA3
RPC (custom):       NEXT_PUBLIC_ETH_RPC_URL env var
Explorer:           https://etherscan.io
DexScreener chain:  "ethereum"

Uniswap V3 Factory:     0x1F98431c8aD98523631AE4a59f267346ea31F984
Uniswap V3 Router:      0xE592427A0AEce92De3Edee1F18E0157C05861564
Uniswap V3 PosMgr:      0xC36442b4a4522E871399CD717aBDD847Ab11FE88
Uniswap V3 Fee Tiers:   100, 500, 3000, 10000 (standard)

Uniswap V4 PoolMgr:     0x000000000004444c5dc75cB358380D2e3dE08A90
Uniswap V4 PosMgr:      0xbd216513d74c8cf14cf4747e6aaa6420ff64ee9e

SushiSwap V3 Factory:   0xbACEB8eC6b9355Dfc0269C18bac9d6E2Bdc29C4F
SushiSwap V3 PosMgr:    0x2214A42d8e2A1d20635c2cb0664422c528B6A432

PancakeSwap V3 Factory: 0x0BFbCF9fa4f9C56B0F40a671Ad40E0805A091865
PancakeSwap V3 PosMgr:  0x46A15B0b27311cedF172AB29E4f4766fbE7F4364
PancakeSwap V3 Tiers:   100, 500, 2500, 10000 (NOT 3000!)

USDC:  0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48 (6 dec)
USDT:  0xdAC17F958D2ee523a2206206994597C13D831ec7 (6 dec)
DAI:   0x6B175474E89094C44Da98b954EedeAC495271d0F (18 dec)
WBTC:  0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599 (8 dec)
```

---

## Last Verified

**2026-03-02** — Rigorous Researcher audit. All contract addresses, token addresses, and fee tiers verified against codebase config files. 1 fix applied (corrected SushiSwap subgraph ID). Confidence: HIGH.

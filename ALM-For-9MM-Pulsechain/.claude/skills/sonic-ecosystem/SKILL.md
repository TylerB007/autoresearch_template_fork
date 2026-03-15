---
name: sonic-ecosystem
description: Reference skill for building read-only analytics, LP tracking, and DeFi dashboard applications on Sonic (chain ID 146). Covers RPC setup, Shadow Exchange contracts (Ramses V3 Core concentrated liquidity with x(3,3) incentives), token addresses, price fetching, and known pitfalls including legacy position manager and FeeShare mechanism. Load when working with Sonic DeFi data, LP positions, or Shadow Exchange integration on chain 146.
---

# Sonic Ecosystem Skill

## Purpose

Load this skill when an agent needs to:

- Build or modify read-only analytics for Sonic (chain ID 146)
- Track concentrated liquidity positions on Shadow Exchange
- Work with Ramses V3 Core (Uniswap V3 fork) position data
- Understand Shadow Exchange's x(3,3) incentive model and FeeShare mechanism
- Fetch token prices, pool data, or on-chain state from Sonic
- Configure viem/ethers clients for Sonic RPC

Sonic is a newer L1 chain with Shadow Exchange as its primary (and only integrated) DEX. Shadow Exchange uses Ramses V3 Core — a Uniswap V3 fork with an x(3,3) incentive model.

---

## Chain Configuration

```
Chain ID:        146
Chain Name:      Sonic
Native Token:    S (Sonic, 18 decimals)
DexScreener ID:  "sonic"
```

### RPC Endpoints

| Endpoint | Notes |
|----------|-------|
| `https://rpc.soniclabs.com` | Primary |
| `https://rpc.sonic.fantom.network` | Fallback |

### Block Explorer

- **SonicScan**: `https://sonicscan.org`

### Subgraph Endpoint

| Protocol | Endpoint |
|----------|----------|
| Shadow Exchange | `https://api.thegraph.com/subgraphs/id/AfEueFh2MkpEp394Bo6EApfESwv97Zzg6jA48ugzXrwG` |

---

## Key Tokens

### Native & Wrapped

| Token | Address | Decimals |
|-------|---------|----------|
| S (native) | `0x0000000000000000000000000000000000000000` | 18 |
| wS (Wrapped Sonic) | `0x039e2fB66102314Ce7b64Ce5Ce3E5183bc94aD38` | 18 |

### Stablecoins

| Token | Address | Decimals | Notes |
|-------|---------|----------|-------|
| USDC | `0x29219dd400f2Bf60E5a23d13Be72B486D4038894` | **6** | Native USDC |
| USDT | `0x6047828dc181963ba44974801ff68e538da5eaf9` | **6** | Bridged |
| EURC | `0xe715cba7b5ccb33790cebff1436809d36cb17e57` | **6** | Euro stablecoin |

### Major Tokens

| Token | Address | Decimals | Notes |
|-------|---------|----------|-------|
| WETH | `0x50c42dEAcD8Fc9773493ED674b675bE577f2634b` | 18 | Bridged Ethereum |
| SHADOW | `0x3333b97138D4b086720b5aE8A7844b1345a33333` | 18 | Shadow Exchange governance |
| xSHADOW | `0x5050bc082FF4A74Fb6B0B04385dEfdDB114b2424` | 18 | Staked/wrapped SHADOW |

---

## Common Infrastructure

| Contract | Address |
|----------|---------|
| Multicall3 | `0xcA11bde05977b3631167028862bE2a173976CA11` |
| Permit2 | `0x000000000022D473030F116dDEE9F6B43aC78BA3` |

---

## Shadow Exchange (Primary DEX)

Shadow Exchange is a concentrated liquidity DEX built on **Ramses V3 Core** (a Uniswap V3 fork). It is the only integrated DEX for Sonic in the dashboard.

### Core Contracts

| Contract | Address |
|----------|---------|
| Factory | `0xcD2d0637c94fe77C2896BbCBB174cefFb08DE6d7` |
| Router | `0x1D368773735ee1E678950B7A97bcA2CafB330CDc` |
| Swap Router | `0x5543c6176feb9b4b179078205d7c29eea2e2d695` |
| Quoter | `0x219b7ADebc0935a3eC889a148c6924D51A07535A` |
| **Position Manager** | `0x12E66C8F215DdD5d48d150c8f46aD0c6fB0F4406` |
| Position Manager (Legacy) | `0xA57FA38b3fd45922394e9E1077748A2383F1542E` |
| Universal Router | `0x92643Dc4F75C374b689774160CDea09A0704a9c2` |

**Two Position Managers**: Older positions may use the legacy address (`0xA57F...`). The dashboard queries both. When scanning for positions, check both contracts.

### Fee Tiers (Standard V3)

| Fee (bps) | Percentage | Tick Spacing |
|-----------|-----------|--------------|
| 100 | 0.01% | 1 |
| 500 | 0.05% | 10 |
| 3000 | 0.30% | 60 |
| 10000 | 1.00% | 200 |

Shadow Exchange uses the same fee tier encoding as standard Uniswap V3 (100/500/3000/10000), unlike Aerodrome Slipstream which uses 1/5/30/100.

### Protocol Features

**x(3,3) Incentive Model**: Shadow Exchange distributes token rewards beyond base trading fees. LPs earn:
1. Base swap fees (standard V3 fee accrual)
2. x(3,3) emission rewards (protocol-specific, not captured by standard V3 fee calculation)

**FeeShare Mechanism**: Allows dynamic fee adjustments per pool. The actual fee charged may differ from the advertised fee tier. Check pool state for the current active fee percentage.

**veNFT System**: SHADOW token holders can lock tokens for xSHADOW to participate in governance and boost emission rewards.

---

## Uniswap V3 Compatibility

Since Shadow Exchange is built on Ramses V3 Core (Uniswap V3 fork), standard V3 patterns work:

- Position NFTs minted at the Position Manager contract
- Pool discovery via `factory.getPool(token0, token1, fee)`
- Standard `positions(uint256 tokenId)` view function
- Standard tick math and fee calculation
- Standard `slot0()`, `feeGrowthGlobal*X128()`, `ticks()` pool queries

**The V3 fee calculation algorithm (tokensOwed + feeGrowthInside delta) works unchanged.** See the `pulsechain-ecosystem` or `v3-math-verifier` skills for the complete fee calculation pattern.

---

## Common Pitfalls

### 1. Legacy Position Manager

Some older positions are minted at the legacy Position Manager (`0xA57FA38b3fd45922394e9E1077748A2383F1542E`). When discovering positions:

```typescript
// Must check BOTH contracts
const POSITION_MANAGERS = [
  '0x12E66C8F215DdD5d48d150c8f46aD0c6fB0F4406', // Current
  '0xA57FA38b3fd45922394e9E1077748A2383F1542E', // Legacy
];

// Query balanceOf on both, aggregate results
```

### 2. x(3,3) Rewards Not in Fee Calculation

The standard V3 fee calculation captures base swap fees only. Shadow Exchange's x(3,3) emission rewards are a separate reward stream that requires querying Shadow-specific gauge/reward contracts. The dashboard may underreport total LP earnings compared to Shadow Exchange's UI.

### 3. FeeShare Dynamic Fees

The `fee` field in pool state may not match the fee tier the pool was created with. FeeShare can dynamically adjust fees. When calculating fee APR, use the actual fee from recent swap events rather than the pool's configured fee tier.

### 4. Newer Chain — Limited Price Coverage

Sonic is newer, so external price services have limited coverage:
- **DexScreener**: Good coverage for major tokens (USDC, USDT, WETH, SHADOW)
- **DefiLlama**: Limited coverage for emerging Sonic-native tokens
- **CoinGecko**: Moderate coverage

Positions with low-liquidity or emerging tokens may show "—" for historical USD values. Use the Entry Value Modal for manual price entry.

### 5. RPC Limitations

Sonic RPCs are newer and may have:
- Smaller `eth_getLogs` block range limits than mature chains
- Limited archive node access (historical state queries may fail)
- Lower rate limits than Ethereum/Polygon RPCs

The dashboard handles this with chunked log queries and automatic fallback. Mint data fetching may be slower on Sonic.

### 6. Chain Not Enabled by Default

Sonic (146) is NOT in the V1.0 launch chain filter (`NEXT_PUBLIC_ENABLED_CHAINS=1,369`). To enable:

```bash
# .env.local
NEXT_PUBLIC_ENABLED_CHAINS=1,369,146
```

### 7. wS Wrapping

Native S (Sonic) must be wrapped to wS for DEX interactions. The wS contract follows the standard WETH9 interface at `0x039e2fB66102314Ce7b64Ce5Ce3E5183bc94aD38`.

---

## Known Issues (Resolved)

**"Sonic Chain Has No DEXs"** — Resolved Feb 2026. Shadow Exchange integration completed with full concentrated liquidity support. See `docs/planning/KNOWN_ISSUES.md`.

---

## When to Combine with Other Skills

| Skill | Use When |
|-------|----------|
| `v3-math-verifier` | Editing fee calculation logic — Shadow uses standard V3 math |
| `pulsechain-ecosystem` | Cross-reference V3 patterns (9mm and Shadow are both V3 forks) |
| `ethereum-ecosystem` | Comparing Uniswap V3 implementations |
| `frontend-design` | Building dashboard UI components |

---

## Quick Reference Card

```
Chain ID:           146
Native:             S (Sonic, 18 dec)
Wrapped:            0x039e2fB66102314Ce7b64Ce5Ce3E5183bc94aD38 (wS)
Multicall3:         0xcA11bde05977b3631167028862bE2a173976CA11
Permit2:            0x000000000022D473030F116dDEE9F6B43aC78BA3
RPC (primary):      https://rpc.soniclabs.com
Explorer:           https://sonicscan.org
DexScreener chain:  "sonic"

Shadow Exchange:
  Factory:            0xcD2d0637c94fe77C2896BbCBB174cefFb08DE6d7
  Router:             0x1D368773735ee1E678950B7A97bcA2CafB330CDc
  PosMgr (current):   0x12E66C8F215DdD5d48d150c8f46aD0c6fB0F4406
  PosMgr (legacy):    0xA57FA38b3fd45922394e9E1077748A2383F1542E
  Quoter:             0x219b7ADebc0935a3eC889a148c6924D51A07535A
  Universal Router:   0x92643Dc4F75C374b689774160CDea09A0704a9c2
  Fee Tiers:          100, 500, 3000, 10000 (standard V3)
  Subgraph:           AfEueFh2MkpEp394Bo6EApfESwv97Zzg6jA48ugzXrwG

USDC:    0x29219dd400f2Bf60E5a23d13Be72B486D4038894 (6 dec)
USDT:    0x6047828dc181963ba44974801ff68e538da5eaf9 (6 dec)
WETH:    0x50c42dEAcD8Fc9773493ED674b675bE577f2634b (18 dec)
SHADOW:  0x3333b97138D4b086720b5aE8A7844b1345a33333 (18 dec)
xSHADOW: 0x5050bc082FF4A74Fb6B0B04385dEfdDB114b2424 (18 dec)
```

---

## Last Verified

**2026-03-02** — Rigorous Researcher audit. All contract addresses, token addresses, fee tiers, and subgraph IDs verified against codebase config files. No fixes needed. Confidence: HIGH.

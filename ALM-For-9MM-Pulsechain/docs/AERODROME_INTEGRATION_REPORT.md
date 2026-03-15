# Aerodrome Finance Integration Analysis & Necessary Fixes

**Date:** February 27, 2026
**Target Ecosystem:** Aerodrome CL (Slipstream) on Base Network
**Purpose:** Identify architectural gaps and contract discrepancies between current repository implementation and official Aerodrome standards.

---

## Executive Summary
A technical comparison between the current codebase (`src/config/chains.ts`, `src/pool.ts`, `src/rebalancer.ts`) and Aerodrome Finance's [official Slipstream github repository](https://github.com/aerodrome-finance/slipstream/blob/main/README.md) has revealed several critical oversights. 

While the codebase correctly handles the parameter syntax for Slipstream's underlying pool implementation, **it incorrectly completely ignores the Gauge framework**, meaning users will forfeit 100% of their `$AERO` yield. Additionally, a crucial contract address is missing/invalid, and the integration currently points to an outdated contract registry.

---

## 🟢 Strengths & Validated Approaches

The codebase correctly applies the two primary differences for Slipstream's automated pool layer:

1. **`tickSpacing` as the Pool Key:** Identified correctly in `src/pool.ts` and `chains.ts`. Unlike standard Uniswap V3 which uses `fee` (uint24) as part of the pool derivation salt, Slipstream uses `tickSpacing` (int24). The implementation's mapping workaround securely resolves EIP-1167 proxy addresses.
2. **Custom MintParams Payload:** In `src/rebalancer.ts`, the implementation accurately detects the `aerodrome-cl` router and injects the required `sqrtPriceX96` parameter into `MintParams`.

---

## 🔴 Critical Mistakes & Required Remediation

### 1. Lack of "Gauge (Staking)" Integration results in 100% Yield Loss
This is the most severe architectural oversight. On standard UniswapV3 DEXes, providing liquidity to a pool natively earns trading fees. **On Aerodrome, the primary yield comes from `$AERO` emissions earned by staking the Position NFT into a Gauge.**

**The Problem in Code:**
1. **Ownership Validation Failure:** When a user stakes their position, the `Gauge` contract takes custody of the NFT. If the user passes a staked `tokenId` into `config.yaml`, the `verifyOwnership` function in `src/position.ts` will aggressively reject it because `ownerOf(tokenId)` returns the Gauge address, not the user wallet. 
2. **Abandonment of Yield:** If a user delegates an unstaked NFT, or the bot successfully executes a rebalance (which burns the old position and mints a new NFT), the newly outputted NFT is **never automatically re-staked**. LP Yield is completely lost.

**Required Action:** 
- Develop an `AerodromeGauge.ts` implementation standard.
- **Pre-Rebalance:** The bot must recognize staked tokens and execute a `withdraw()` on the active `CLGauge` to pull the NFT back to the Position Manager prior to decreasing liquidity.
- **Post-Rebalance:** The rebalancer must recognize the newly minted token, resolve the specific Gauge for that pool (via the `GaugeFactory`), and immediately `deposit()` the NFT.

<br>

### 2. Invalid Quoter Contract Address in Registry
The integration references a dead address for the Aerodrome Quoter.

**The Problem in Code:**
In `src/config/chains.ts`, the `quoter` contract is hardcoded as:
`0x3d4e44Eb1374DdD58c54f9271563F6a7c0244cA2`
This address **does not exist** on Base mainnet. Any slippage calculations or swap quotes routed through this address will throw a `CALL_EXCEPTION`. It appears to be a copy/paste merge of Uniswap's Quoter prefix (`0x3d4e..`).

**Required Action:**
Change to the verified Aerodrome QuoterV2 immediately.

<br>

### 3. Hardcoded to Deprecated / Locked Out "Initial Deployment"
Aerodrome has recently undergone a major migration to implement Gauge Emission Caps and redistributor limits.

**The Problem in Code:**
The configuration in `src/config/chains.ts` exclusively relies on Aerodrome's "Initial Deployment".
- Current NPM: `0x827922...5b72`
- Current Factory: `0x5e7BB1...809A`

While these contracts exist, active liquidity and `$AERO` incentives are primarily isolated entirely to the newer **Gauge Caps Deployment**. If a user tries to hand the bot an actively incentivized V2 token, it will hit the legacy Position Manager and revert.

**Required Action:**
The codebase must be updated to target the Gauge Caps deployments. Given that legacy positions are likely still scattered, the architecture should ideally delineate between `aerodrome-v1` and `aerodrome-v2` in the `dexes` registry.

---

## 🔧 Actionable Code Upgrades (Copy & Paste Reference)

**Fixing the Contract Registry (Gauge Caps Deployment / V2):**
If migrating to the active incentives contracts, substitute the `aerodrome-cl` configuration in `src/config/chains.ts` with the following endpoints pulled directly from Aerodrome's specification documentation:

```typescript
      'aerodrome-cl-v2': {
        protocolName: 'Aerodrome CL (Gauge Caps)',
        contracts: {
          nonfungiblePositionManager: '0xa990C6a764b73BF43cee5Bb40339c3322FB9D55F', // V2 NPM
          swapRouter: '0xcbBb8035cAc7D4B3Ca7aBb74cF7BdF900215Ce0D',
          factory: '0xaDe65c38CD4849aDBA595a4323a8C7DdfE89716a',
          quoter: '0x3d4C22254F86f64B7eC90ab8F7aeC1FBFD271c6C', // Valid Base Quoter address
          gaugeFactory: '0xB630227a79707D517320b6c0f885806389dFcbB3', // CRITICAL: Required for locating staking endpoints
        },
        swapRouterType: 'aerodrome-cl',
        feeTiers: {
          1: 1,      
          50: 50,    
          100: 100,  
          200: 200,  
          2000: 2000, 
        },
      }
```

## Summary Recommendation to Senior Dev
1. We cannot soft-launch the Base/Aerodrome module as-is; without Gauge (Staking) workflow logic, we will cause an active loss-of-yield incident on every token we touch.
2. We need a new state machine step inside `rebalancer.ts`: checking if a token is in a gauge → unstaking → processing standard V3 logic → re-staking new positional token.

*References Consulted:*
- `https://github.com/aerodrome-finance/slipstream/blob/main/README.md`
- `https://github.com/aerodrome-finance/slipstream/blob/main/SPECIFICATION.md`
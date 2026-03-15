---
name: uniswap-v4-protocol
description: >
  Protocol-level reference for Uniswap V4 singleton architecture, hooks system,
  and position management. Covers PoolManager singleton, PoolKey derivation,
  extsload for gas-optimized reads, and hook lifecycle. Status: Alpha/Partial —
  focus on reading state for analytics dashboards. Load when working with V4
  pools, positions, or hooks on any chain.
---

# Uniswap V4 Protocol

## Status: Alpha/Partial

This skill focuses on **reading V4 state for analytics dashboards**. V4 is the newest Uniswap version and tooling is still maturing. Items marked with ❓ need further verification as the protocol evolves.

---

## Architecture Overview

### Singleton Pattern

The fundamental V4 change: **ALL pools live in a single PoolManager contract** (vs V3's one-contract-per-pool).

```
V3: Factory deploys Pool_A, Pool_B, Pool_C (separate contracts)
V4: PoolManager holds Pool_A state, Pool_B state, Pool_C state (one contract)
```

**Benefits**:
- Massive gas savings: no per-pool contract deployment
- Multi-hop swaps settle internally (no token transfers between pools)
- Flash accounting via EIP-1153 transient storage

### Flash Accounting

V4 uses a "delta" system with transient storage:
1. Operations accumulate token deltas (credits/debits)
2. Deltas stored in EIP-1153 transient storage (cleared after transaction)
3. Only the NET settlement happens at transaction end
4. Multi-hop swaps: intermediate tokens never actually transfer

### Native ETH Support

V4 pools can hold ETH directly using `address(0)` as the currency — no WETH wrapping required. This saves gas for ETH-paired pools.

---

## Core Concepts

### PoolKey

A pool is identified by its `PoolKey` — a struct of 5 fields:

```solidity
struct PoolKey {
    Currency currency0;    // Lower-sorted token address (address(0) for native ETH)
    Currency currency1;    // Higher-sorted token address
    uint24 fee;            // Fee in hundredths of a bip (same as V3) OR dynamic fee flag
    int24 tickSpacing;     // Tick spacing (same concept as V3)
    IHooks hooks;          // Hook contract address (address(0) for no hooks)
}
```

**Pool ID** = `keccak256(abi.encode(poolKey))` — used for storage slot derivation.

**Dynamic Fee Flag**: If `fee` has bit `0x800000` set, the pool uses dynamic fees controlled by the hook contract.

### Hooks

Hooks are smart contracts that execute callbacks at various pool lifecycle points. The hook contract address itself encodes which callbacks are active via address bits (the leading bits of the address determine permissions).

**10 Lifecycle Callbacks**:
1. `beforeInitialize` / `afterInitialize`
2. `beforeAddLiquidity` / `afterAddLiquidity`
3. `beforeRemoveLiquidity` / `afterRemoveLiquidity`
4. `beforeSwap` / `afterSwap`
5. `beforeDonate` / `afterDonate`

**4 Delta-Returning Flags** (hooks can return token deltas):
- `beforeSwapReturnDelta`
- `afterSwapReturnDelta`
- `afterAddLiquidityReturnDelta`
- `afterRemoveLiquidityReturnDelta`

**For analytics dashboards**: Hooks can modify fee accrual, add surcharges, or redirect fees. A hookless pool behaves identically to V3. A hooked pool may have non-standard fee behavior that standard V3 math cannot capture.

---

## Key Contracts

Addresses are chain-specific — see `chains/{chain}/SKILL.md` for deployed addresses.

| Contract | Role |
|----------|------|
| `PoolManager` | Singleton holding ALL pool state and token balances |
| `PositionManager` | NFT-based position management (mints ERC721 position tokens) |
| `UniversalRouter` | Multi-protocol routing (V2, V3, V4 in one transaction) |
| `StateView` | Read-only contract for gas-efficient pool state queries |

### Known Deployments (Reference Only)

| Chain | PoolManager | PositionManager |
|-------|-------------|-----------------|
| Ethereum (1) | `0x000000000004444c5dc75cB358380D2e3dE08A90` | `0xbd216513d74c8cf14cf4747e6aaa6420ff64ee9e` |
| Base (8453) | `0x498581ff718922c3f8e6a244956af099b2652b2b` | `0x7c5f5a4bbd8fd63184577525326123b519429bdc` |

---

## Reading Pool State

Three approaches for reading V4 pool state, in order of preference:

### 1. StateView Contract (Recommended for Dashboards)

StateView provides standard view functions wrapping raw storage reads:

```typescript
// StateView ABI (partial)
const STATE_VIEW_ABI = [
  'function getSlot0(bytes32 poolId) view returns (uint160 sqrtPriceX96, int24 tick, uint24 protocolFee, uint24 lpFee)',
  'function getLiquidity(bytes32 poolId) view returns (uint128)',
  'function getTickInfo(bytes32 poolId, int24 tick) view returns (uint128 liquidityGross, int128 liquidityNet, uint256 feeGrowthOutside0X128, uint256 feeGrowthOutside1X128)',
  'function getFeeGrowthGlobals(bytes32 poolId) view returns (uint256 feeGrowthGlobal0, uint256 feeGrowthGlobal1)',
  'function getPositionInfo(bytes32 poolId, bytes32 positionId) view returns (uint128 liquidity, uint256 feeGrowthInside0LastX128, uint256 feeGrowthInside1LastX128)',
];
```

| Chain | StateView Address |
|-------|-------------------|
| Ethereum | `0x7ffe42c4a5deea5b0fec41c94c136cf115597227` |
| Base | `0xa3c0c9b65bad0b08107aa264b0f3db444b867a71` |

### 2. extsload (Gas-Optimized)

`extsload` reads raw storage slots from PoolManager. Cheapest option but requires knowing exact slot layouts:

```typescript
// Read arbitrary storage slots from PoolManager
const result = await client.readContract({
  address: poolManagerAddress,
  abi: ['function extsload(bytes32 slot) view returns (bytes32)'],
  functionName: 'extsload',
  args: [slotKey],
});
```

### 3. Subgraph (Position Discovery)

**PositionManager does NOT support ERC721Enumerable** — you cannot iterate `tokenOfOwnerByIndex` to find positions. Use the V4 subgraph for position discovery.

| Chain | Subgraph ID |
|-------|-------------|
| Ethereum | `DiYPVdygkfjDWhbxGSqAQxwBKmfKnkWQojqeM2rkLb3G` |
| Base | ❓ Verify — may share Ethereum ID or have separate deployment |

---

## Fee Calculation

### Hookless Pools (Standard)

For pools with `hooks == address(0)`, fee math is **identical to Uniswap V3**:

- Concentrated liquidity with tick ranges
- `feeGrowthGlobal`, `feeGrowthOutside`, `feeGrowthInsideLast` — same algorithm
- `tokensOwed + feeGrowthInside delta` — same two-component calculation

**See `protocols/uniswap-v3.md` for the complete fee calculation algorithm.**

### Hooked Pools (Non-Standard)

**WARNING**: Custom hooks can alter fee logic in ways that break standard V3 math:

- `beforeSwap` / `afterSwap` hooks can modify the effective fee
- Delta-returning hooks can redirect fees to the hook contract
- Dynamic fee pools (`fee & 0x800000`) have hook-determined fees per swap

**For analytics dashboards**: If a pool has hooks, flag fee calculations as potentially inaccurate. There is no generic way to compute fees for arbitrary hooked pools — each hook's logic is custom.

### Fee Tiers

V4 uses the same fee denomination as V3 (hundredths of a bip):

| Fee (bps) | Percentage | Tick Spacing |
|-----------|-----------|--------------|
| 100 | 0.01% | 1 |
| 500 | 0.05% | 10 |
| 3000 | 0.30% | 60 |
| 10000 | 1.00% | 200 |

But V4 also supports **arbitrary tick spacings** — not limited to the 4 standard tiers. Hook contracts can create pools with custom fee/tickSpacing combinations.

---

## Position Management

### PositionManager

- Mints ERC721 position NFTs (similar to V3's NonfungiblePositionManager)
- Positions have tick ranges, liquidity, and fee growth tracking (same as V3)
- **NOT ERC721Enumerable** — cannot iterate positions by owner on-chain

### Position Data Access

```typescript
// Via PositionManager (similar to V3 pattern)
const position = await client.readContract({
  address: positionManagerAddress,
  abi: POSITION_MANAGER_ABI,
  functionName: 'positions',
  args: [BigInt(tokenId)],
});
// Returns: token0, token1, fee, tickSpacing, hooks, tickLower, tickUpper, liquidity, ...
```

### Token Amount Calculation

Same formulas as V3 — token amounts depend on current tick vs position's tick range. Three cases: below range (all token0), in range (mixed), above range (all token1).

See `protocols/uniswap-v3.md` for the complete token amount formulas.

---

## Known Limitations for Dashboard Integration

1. **No ERC721Enumerable** → Subgraph dependency for position discovery. If subgraph is down, positions cannot be enumerated.

2. **Hook-modified fees** → Standard V3 fee calculation may be inaccurate for hooked pools. No generic workaround exists.

3. **Newer protocol** → Subgraph coverage and third-party tooling are less mature than V3. Expect gaps.

4. **Native ETH pools** → Balance tracking differs from ERC20 pools. `address(0)` as currency requires special handling.

5. **Dynamic fees** → Fee field may not represent actual fees charged. Must check for `0x800000` flag and query hook for actual fee schedule.

6. **StateView coverage** → StateView may not be deployed on all chains yet. Fallback to extsload or subgraph may be necessary.

---

## What This Skill Does NOT Cover

- Writing V4 transactions (swaps, minting, removing liquidity)
- Building custom hooks
- Flash loan patterns
- Cross-pool routing optimization
- Permit2 integration details
- UniversalRouter command encoding

These are out of scope for a read-only analytics dashboard.

---

## Cross-References

| Resource | When to Use |
|----------|-------------|
| `protocols/uniswap-v3.md` | Fee math for hookless V4 pools (identical algorithm) |
| `protocols/uniswap-v2.md` | V2 constant-product math (UniversalRouter can route through V2) |
| `chains/{chain}/SKILL.md` | Chain-specific V4 contract addresses |

---

## References

- [Uniswap V4 Overview](https://docs.uniswap.org/contracts/v4/overview)
- [PoolManager Concepts](https://docs.uniswap.org/contracts/v4/concepts/PoolManager)
- [Flash Accounting](https://docs.uniswap.org/contracts/v4/concepts/flash-accounting)
- [Hooks Documentation](https://docs.uniswap.org/concepts/protocol/hooks)
- [Reading Pool State Guide](https://docs.uniswap.org/contracts/v4/guides/read-pool-state)
- [StateView Guide](https://docs.uniswap.org/contracts/v4/guides/state-view)
- [V4 Deployments](https://docs.uniswap.org/contracts/v4/deployments)
- [IExtsload Interface](https://docs.uniswap.org/contracts/v4/reference/core/interfaces/IExtsload)
- [IHooks Interface](https://docs.uniswap.org/contracts/v4/reference/core/interfaces/IHooks)

---

## Last Verified

**2026-03-02** — Initial creation. Contract addresses sourced from existing chain skill files and Uniswap docs. StateView addresses verified via Etherscan/Basescan. Hooks system documented from official Uniswap V4 documentation. Status: Alpha/Partial.

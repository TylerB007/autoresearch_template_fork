# Constitutional Truths

**Governing law for all developers, agents, and iterations.**

Every statement below is an immutable fact verified from deployed smart contracts, on-chain state, or mathematical law. If any truth is violated, the application will fail. Nothing may appear in this document without 100% certainty. Policies, patterns, and implementation choices belong elsewhere.

---

## 1. Chain

PulseChain. Chain ID `369`. Native token PLS (18 decimals).

---

## 2. 9mm V3 Protocol Contract Addresses

Deployed, immutable, on-chain. Changing any address causes immediate contract call failures.

| Contract | Address |
|----------|---------|
| NonfungiblePositionManager | `0xCC05bf158202b4F461Ede8843d76dcd7Bbad07f2` |
| SwapRouter (SmartRouter) | `0xf6076d61A0C46C944852F65838E1b12A2910a717` |
| Factory | `0xe50dbdc88e87a2c92984d794bcf3d1d76f619c68` |
| Quoter | `0x250D0399E3f363d98f8A27942712d59248C33007` |

---

## 3. 9mm V3 Fee Tiers and Tick Spacing

These are set in the Factory contract at deployment. They cannot be changed.

| Tier | Fee | Tick Spacing |
|------|-----|-------------|
| LOWEST | 100 | 1 |
| LOW | 500 | 10 |
| MEDIUM | 2500 | 50 |
| HIGH | 10000 | 200 |

The MEDIUM tier is the only one that differs from Uniswap V3 (which uses fee 3000, tick spacing 60). Using Uniswap's MEDIUM values on 9mm causes on-chain "invalid tick" reverts.

---

## 4. SwapRouter ABI: No Deadline Field

The 9mm SmartRouter `exactInputSingle` parameters are:

```
tokenIn, tokenOut, fee, recipient, amountIn, amountOutMinimum, sqrtPriceLimitX96
```

There is no `deadline` field. Uniswap V3's SwapRouter has one. Passing a deadline to 9mm's router reverts the transaction.

The NonfungiblePositionManager `mint` struct does include `deadline`.

---

## 5. On-Chain Values Require BigInt

Token amounts, liquidity, and sqrtPriceX96 exceed JavaScript's `Number.MAX_SAFE_INTEGER` (2^53). Using `number` for these values causes silent precision loss and wrong calculations. `bigint` is mandatory.

The V3 price math constants are:

```
Q96  = 2^96
Q192 = 2^192
```

These are mathematically defined. They cannot be wrong.

---

## 6. V3 Concentrated Liquidity Requires Both Tokens When Tick Is In Range

If `currentTick >= tickLower && currentTick < tickUpper`, the pool's AMM curve requires non-zero amounts of both token0 and token1 to mint liquidity. Passing zero for either token reverts.

This is a mathematical property of Uniswap V3 / PancakeSwap V3 concentrated liquidity, enforced in the pool contract.

---

## 7. EVM CALL_EXCEPTION Means the Contract Reverted

An ethers.js `CALL_EXCEPTION` means the EVM executed the contract code and it hit a `revert` or `require` failure. This is a definitive on-chain response, not a network error. Retrying will produce the same result.

---

## 8. Aerodrome CL Uses tickSpacing as Pool Key (Not Fee)

Aerodrome CL (Slipstream) on Base replaces the `fee` field with `tickSpacing` everywhere in the V3 interface:

- `factory.getPool(token0, token1, tickSpacing)` — not `fee`
- `MintParams` uses `tickSpacing` field (no `fee` field), plus an extra `sqrtPriceX96: 0n` for existing pools
- `ExactInputSingleParams` uses `tickSpacing` — not `fee`
- `positions()` returns `tickSpacing` at index 4, not `fee`

The fee-to-tickSpacing mapping is an identity function:

| tickSpacing | tickSpacing |
|-------------|-------------|
| 1 | 1 |
| 50 | 50 |
| 100 | 100 |
| 200 | 200 |
| 2000 | 2000 |

Passing a Uniswap-style `fee` value (e.g., 3000) to an Aerodrome contract reverts.

---

## 9. Aerodrome CL Pools Are EIP-1167 Minimal Proxies

Aerodrome CL pools are deployed via a factory using EIP-1167 minimal proxies. This means batched RPC calls (e.g., `Promise.all`) to a single pool contract will fail with `CALL_EXCEPTION`. All properties for a single pool (`slot0`, `liquidity`, `token0`, etc.) must be queried sequentially.

---

## 10. Shadow.so (Sonic) is a Ramses V3 Fork with Algebra V3-Style NPM

Shadow.so on Sonic (Chain ID `146`) is built on Ramses V3 Core (itself a Uniswap V3 derivative), but its NonfungiblePositionManager uses an Algebra V3-style interface — `positions()` returns **10 fields** (no `nonce`, no `operator`; `tickSpacing` instead of `fee`). All other V3 interfaces follow the Aerodrome CL / Slipstream pattern:

- **Pool Key**: Uses `tickSpacing` instead of `fee`.
- **Pool Address**: Computed via **CREATE2** using deployer `0x8BBDc15759a8eCf99A92E004E0C64ea9A5142d59` (NOT EIP-1167 proxies). `POOL_INIT_CODE_HASH = 0xc701ee63862761c31d620a4a083c61bdc1e81761e6b9c9267fd19afd22e0821d`.
- **Swap ABI**: `ExactInputSingleParams` uses `tickSpacing` and includes `deadline`.
- **Dynamic Fees**: Pool fee is adjustable via governance `setFee()` — not fixed at creation.
- **swapRouterType in code**: `'algebra-v3'` (NOT `'aerodrome-cl'`).
- **Mint ABI differs from Aerodrome CL**: Shadow V3 `MintParams` is an **11-field struct** (no `sqrtPriceX96`) with selector `0x6d70c415`. Aerodrome CL `MintParams` has **12 fields** (includes `sqrtPriceX96: 0n`) with selector `0xb5007d1f`. These two ABIs must remain separate — using the Aerodrome ABI for Shadow V3 produces a nonexistent selector and the call silently fails on Sonic RPC (null revert data).
- **Contract Addresses (Sonic Mainnet, Chain 146)**:
  - **NonfungiblePositionManager (current)**: `0x12E66C8F215DdD5d48d150c8f46aD0c6fB0F4406`
  - **NonfungiblePositionManager (legacy)**: `0xA57FA38b3fd45922394e9E1077748A2383F1542E`
  - **SwapRouter**: `0x5543c6176feb9b4b179078205d7c29eea2e2d695`
  - **Factory**: `0xcD2d0637c94fe77C2896BbCBB174cefFb08DE6d7`
  - **QuoterV2**: `0x219b7ADebc0935a3eC889a148c6924D51A07535A`
- **Common Tick Spacings**: `1`, `50`, `100`, `200`, `2000`.
- **Verified on-chain**: `ownerOf(1141460)` returns the wallet on `0x12E66C8F` — the current NPM is correct. The legacy address (`0xA57FA38b`) is an older deployment; scan both for position discovery.

---

## 11. Two Independent Aerodrome CL Deployments on Base

Base hosts two separate Aerodrome CL contract sets with independent state:

**Original v1 (Slipstream)**:
| Contract | Address |
|----------|---------|
| NonfungiblePositionManager | `0x827922686190790b37229fd06084350E74485b72` |
| SwapRouter | `0xBE6D8f0d05cC4be24d5167a3eF062215bE6D18a5` |
| Factory | `0x5e7BB104d84c7CB9B682AaC2F3d509f5F406809A` |
| Quoter | `0x254cF9E1E6e233aa1AC962CB9B05b2cfeAaE15b0` |

**Gauge Caps**:
| Contract | Address |
|----------|---------|
| NonfungiblePositionManager | `0xa990C6a764b73BF43cee5Bb40339c3322FB9D55F` |
| SwapRouter | `0xcbBb8035cAc7D4B3Ca7aBb74cF7BdF900215Ce0D` |
| Factory | `0xaDe65c38CD4849aDBA595a4323a8C7DdfE89716a` |
| Quoter | `0x3d4C22254F86f64B7eC90ab8F7aeC1FBFD271c6C` |

A position minted on one deployment cannot be managed by the other's contracts. Using the wrong contract set causes reverts.

---

## 12. Canonical Uniswap V3 Addresses (Multi-Chain)

These addresses are deployed, immutable, and verified against official Uniswap documentation.

**Ethereum (Chain ID 1)**:
| Contract | Address |
|----------|---------|
| NonfungiblePositionManager | `0xC36442b4a4522E871399CD717aBDD847Ab11FE88` |
| SwapRouter | `0xE592427A0AEce92De3Edee1F18E0157C05861564` |
| Factory | `0x1F98431c8aD98523631AE4a59f267346ea31F984` |
| Quoter | `0xb27308f9F90D607463bb33eA1BeBb41C27CE5AB6` |

**Base (Chain ID 8453)** — different addresses from Ethereum:
| Contract | Address |
|----------|---------|
| NonfungiblePositionManager | `0x03a520b32C04BF3bEEf7BEb72E919cf822Ed34f1` |
| SwapRouter | `0x2626664c2603336E57B271c5C0b26F421741e481` |
| Factory | `0x33128a8fC17869897dcE68Ed026d694621f6FDfD` |
| Quoter | `0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a` |

**Arbitrum One (Chain ID 42161)** — same addresses as Ethereum:
| Contract | Address |
|----------|---------|
| NonfungiblePositionManager | `0xC36442b4a4522E871399CD717aBDD847Ab11FE88` |
| SwapRouter | `0xE592427A0AEce92De3Edee1F18E0157C05861564` |
| Factory | `0x1F98431c8aD98523631AE4a59f267346ea31F984` |
| Quoter | `0xb27308f9F90D607463bb33eA1BeBb41C27CE5AB6` |

---

**Last Verified**: 2026-02-27

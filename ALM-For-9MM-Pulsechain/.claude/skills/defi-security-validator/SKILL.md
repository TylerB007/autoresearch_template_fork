---
name: defi-security-validator
description: Reviews on-chain transaction code, mathematical operations, and DEX integrations to ensure they adhere to strict multi-chain DeFi security guidelines.
---

# DeFi Security & On-Chain Math Validator

This project is actively managing live funds on major blockchains. It operates under strict security and mathematical constraints.

## When to use this skill
- You are writing or reviewing code that interacts with Ethers.js or blockchain contracts.
- You are doing token math (amounts, liquidity, pricing).
- You are reviewing changes related to DEX logic (9mm, Uniswap V3).

## Validation Checklist

When reviewing or writing code, you **MUST** statically verify the following:

### 1. Zero "Number" Arithmetic (BigInt Mandatory)
- Verify `BigInt(x)` is used instead of `Number(x)` or floating-point math for any token amounts, prices, or liquidity. 
- Using `Number` causes catastrophic precision loss and is strictly forbidden.

### 2. No Infinite Approvals
- Verify `MaxUint256` is NEVER used for token approvals. 
- Approvals must be for the exact required amount.

### 3. Price-Aware Slippage
- Slippage calculations must be based on `sqrtPriceX96` (price-aware), NOT directly on token amounts (which wrongly assumes a 1:1 ratio).

### 4. Explicit Gas Limits
- Ensure any on-chain state-changing transaction includes an explicit `gasLimit` sourced from `GAS_LIMITS` constants.

### 5. 9mm V3 Tick Spacing Rule 
- If changes involve 9mm V3 on PulseChain, verify the code expects `2500` (0.25%) `MEDIUM` fee tier to use a tick spacing of **`50`** (NOT the Uniswap standard of `60`).

### 6. 9mm SwapRouter Has No Deadline
- If code calls 9mm's SmartRouter `exactInputSingle`, verify NO `deadline` field is passed in the params struct.
- Aerodrome CL and Uniswap V3 DO use `deadline` — this rule is 9mm/PancakeSwap V3 specific only.
- Passing `deadline` to 9mm's SmartRouter causes a silent revert.

### 7. Multi-DEX ABI Field Names (tickSpacing vs fee)
- Aerodrome CL (`aerodrome-cl`, `aerodrome-cl-gc`) and Algebra V3 (`algebra-v3`) use `tickSpacing` (not `fee`) in: `factory.getPool()`, `MintParams`, and `SwapRouter` params.
- Search for `fee:` in MintParams/swap calls targeting these DEX types — it must be `tickSpacing:` instead.
- Only Uniswap V3 and PancakeSwap V3 (9mm) use the `fee` field.

### 8. No Promise.all on EIP-1167 Proxy Pools
- Aerodrome CL and Sonic (Shadow/Algebra) pools are EIP-1167 minimal proxies that **fail with batched RPC calls**.
- Verify pool state queries (slot0, liquidity, token0/token1) use sequential `await`, NOT `Promise.all`.
- This also applies to some token contracts on Base that are EIP-1167 proxies.

### 9. CALL_EXCEPTION Is Never Transient
- Contract reverts (`CALL_EXCEPTION`) are definitive on-chain responses — retrying gives the same result.
- Verify error handling uses `isTransientRpcError()` and only retries: `SERVER_ERROR`, `TIMEOUT`, `NETWORK_ERROR`, 504, ECONNRESET.
- `CALL_EXCEPTION` must trigger safe mode (not retry loops).

### 10. Hardcoded Address Spot-Check
- When adding or modifying contract addresses, verify against official deployment docs or block explorer verified source.
- Never trust copy-paste — compare full checksummed addresses character by character.
- Historical incident: v2.2.1 audit found wrong Factory and NPM addresses in `ethereum.ts` and `arbitrum.ts`.

## Action Plan
1. Do a rigorous reading of the modified code against these 10 rules.
2. Search for common anti-patterns using text tools (e.g., `MaxUint256`, `tickSpacing: 60`, `Number(`, `Promise.all` near pool queries, `deadline` in 9mm swap params).
3. If violations are found, fix them immediately before allowing execution or deployment.
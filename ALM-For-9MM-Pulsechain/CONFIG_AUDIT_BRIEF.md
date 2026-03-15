# Configuration Audit & Verification Brief

## 1. Senior Developer Audit Prompt

**Role:** Senior Blockchain Reliability Engineer  
**Task:** Comprehensive Configuration & Constitutional Verification Audit  
**Target System:** Multi-Chain V3 Liquidity Manager (PulseChain, Ethereum, Base, Arbitrum)

**Context:**  
This system manages real funds across multiple EVM chains with varying V3 implementations. The most critical risk is a configuration mismatch between our code (fee tiers, tick spacings, contract addresses) and the immutable on-chain reality. 9mm V3 on PulseChain uses non-standard values that differ from Uniswap V3, while Base uses Aerodrome CL with its own quirks.

**Instructions:**  
Perform a line-by-line audit of the configuration files listed below. For every item, verify it against:
1.  **Official Documentation:** (Uniswap docs, 9mm docs, Aerodrome docs)
2.  **Block Explorer Code:** (Scan verified contracts)
3.  **Constitutional Truths:** (`CONSTITUTIONAL_TRUTHS.md`)

**Deliverables:**
1.  **Validation Report:** Confirm every hardcoded address and constant is correct.
2.  **Gap Analysis:** Identify any missing ABIs or incomplete chain configs.
3.  **Safety Check:** Verify that the `feeTiers` and `tickSpacings` logic in `fees.ts` correctly branches logic based on the chain/DEX to prevent "invalid tick" reverts.
4.  **Updates:** If any immutable fact is missing (e.g., Aerodrome specific tick spacings), propose adding it to `CONSTITUTIONAL_TRUTHS.md`.

**Specific Fail States to Watch For:**
*   Assuming Uniswap `MEDIUM` (3000/60) applies to 9mm V3 (2500/50).
*   Using Ethereum Mainnet contract addresses on L2s (Base/Arbitrum).
*   Mixing up `WETH` vs `WPLS` wrapped native token addresses.
*   Incorrect `chainId` usage (number vs string) leading to strict equality failures.

---

## 2. Reference Architecture & Current State

### Vital Configuration Files

| File Path | Purpose | Critical Dependencies |
| :--- | :--- | :--- |
| `src/config/chains.ts` | **Central Registry**. Maps `chainId` to RPCs, DEX protocols, and contract sets. | `DexConfig` interface, `CHAIN_REGISTRY` export. |
| `src/config/fees.ts` | **Logic Core**. Defines fee tier & tick spacing mappings. **HIGH RISK**: Contains distinct logic for 9mm, Uniswap, and Aerodrome. | `FEE_TIERS`, `TICK_SPACINGS` (9mm default), `UNISWAP_*`, `AERODROME_*`. |
| `src/config/contracts.ts` | 9mm / PulseChain specific addresses. | `CONTRACTS` (9mm V3), `TOKENS` (WPLS, HEX, etc). |
| `src/config/ethereum.ts` | Ethereum Mainnet config. | `ETHEREUM_CONFIG`, `ETHEREUM_CONTRACTS` (Uniswap V3). |
| `src/config/base.ts` | Base Chain config (Uniswap V3 + Aerodrome). | `BASE_CONFIG` (ChainId 8453), `BASE_CONTRACTS`. |
| `src/config/arbitrum.ts` | Arbitrum One config (Uniswap V3 + PancakeSwap V3). | `ARBITRUM_CONFIG` (ChainId 42161). |
| `CONSTITUTIONAL_TRUTHS.md` | **Immutable Law**. Defines non-negotiable facts (Chain IDs, 9mm contract addresses). | 9mm V3 Medium Fee (2500), Tick Spacing (50). |

### Data Structures

*   **`ChainRegistryEntry`**: The master object for a chain. Includes `rpcUrls`, `nativeCurrency`, `blockExplorerUrls`, and `contracts`.
*   **`DexConfig`**: Used in `chains.ts` for chains supporting multiple DEXes (e.g., Arbitrum). Allows specifying `protocolName` (e.g., "pancakeswap-v3") and overrides for `feeTiers`.

### ABIs Structure (`/abis`)

*   `UniswapV3Factory.json`, `UniswapV3Pool.json` (Standard)
*   `AerodromeCL*.json` (Specific fork implementation)
*   `NonfungiblePositionManager.json` (Generic V3 interface)

---

## 3. Verification Checklist

**PulseChain (Chain ID 369)**
- [ ] **Contract:** `NonfungiblePositionManager` matches `0xCC05...07f2` (Verified via Scan).
- [ ] **Contract:** `SwapRouter` matches `0xf607...a717` (Verified via Scan).
- [ ] **Fee/Tick:** MEDIUM tier is **2500 (0.25%)** with tick spacing **50**.
- [ ] **Token:** `WPLS` address is `0xA107...9a27`.

**Ethereum (Chain ID 1)**
- [ ] **Contract:** Uniswap V3 Factory matches `0x1F98431c8aD98523631AE4a59f267346ea31F984`.
- [ ] **Fee/Tick:** MEDIUM tier is **3000 (0.30%)** with tick spacing **60**.
- [ ] **RPC:** Fallback RPCs are valid and public.

**Base (Chain ID 8453)**
- [ ] **Contract:** Uniswap V3 Factory matches official Base deployment.
- [ ] **Aerodrome:** Verify Aerodrome CL Factory address if used.
- [ ] **Tick Spacing:** Verify Aerodrome specific mappings (e.g., is tick spacing 1 for fee 1?).

**Arbitrum (Chain ID 42161)**
- [ ] **DEX 1:** Uniswap V3 addresses match Arbitrum deployment.
- [ ] **DEX 2:** PancakeSwap V3 addresses match PancakeSwap docs for Arbitrum.

**Code Logic Integrity**
- [ ] **Math:** `TickMath` library usage is compatible with 50-tick spacing (max tick alignment).
- [ ] **Config Loader:** `config.yaml` overrides correctly propagate to runtime state.
- [ ] **Typing:** `chainId` comparisons use strict types (no `==` string/number coercion issues).

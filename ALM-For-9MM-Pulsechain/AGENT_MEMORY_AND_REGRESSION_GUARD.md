# Regression Guard & Post-Mortem Protocol

**Purpose**: Actionable operational guard for the 9mm V3 LP Auto-Rebalancer. Pre-deployment checklist, high-risk code map, multi-DEX validation matrix, and structured post-mortem template — all specific to this project.

**This document does NOT duplicate:**

- `MEMORY.md` — numbered rules from production failures (22+ rules)
- `CONSTITUTIONAL_TRUTHS.md` — immutable on-chain facts (12 truths)
- `SECURITY.md` — security rules and audit checklist
- `CONTRIBUTING.md` — development guidelines and PR checklist

**This document ADDS:**

- Part 1: Pre-deployment regression checklist (run before every deploy)
- Part 2: High-risk function map (consult before touching these functions)
- Part 3: Multi-chain/DEX validation matrix (consult before any chain/DEX work)
- Part 4: Post-mortem template (fill out after any bug fix or significant change)
- Part 5: Analytics subsystem invariants (Doc A data capture spec, v2.8.0)

---

## Part 1: Pre-Deployment Regression Guard

Run through these seven layers before every commit that touches `src/`. Each item is a concrete check — not a suggestion.

### Layer A: ESM Build Integrity

- [ ] All relative imports in `src/` end with `.js` (even for `.ts` files)
- [ ] No bare `require()` calls outside `createRequire(import.meta.url)` blocks in `src/contracts.ts`
- [ ] `package.json` has `"type": "module"`
- [ ] TypeScript compiles clean: `npx tsc --noEmit`

### Layer B: BigInt / Math Integrity

- [ ] No `Number()`, `parseInt()`, or `parseFloat()` applied to token amounts, liquidity, or `sqrtPriceX96` anywhere in `src/math.ts`, `src/rebalancer.ts`, `src/swap.ts`
- [ ] `calculateSwapAmount()` token0 branch (`src/math.ts:337`): divides `excessValueScaled` by `sqrtPriceSq * feeMultiplier` — NEVER multiplies by `Q192`. The v1.6.2 regression that multiplied by Q192 inflated results by ~10^58 causing 100% swaps
- [ ] `calculateSwapAmount()` token1 branch (`src/math.ts:343`): divides `deficitValueScaled` by `Q192 * feeMultiplier` — this branch was always correct
- [ ] `calculateAmountOutMinimum()` in `src/swap.ts`: uses `sqrtPriceX96` for price-aware slippage — NOT a flat percentage of `amountIn`
- [ ] Mint `amount0Min`/`amount1Min` derived from `getLiquidityForAmounts` + `getAmountsForLiquidity` pool math — NOT from `walletBalance * 0.99`

### Layer C: Fee Tier / Tick Spacing Integrity

- [ ] `src/config/fees.ts` MEDIUM tier: fee `2500` (not `3000`), tick spacing `50` (not `60`)
- [ ] No hardcoded `3000` or `60` anywhere in `src/` for fee/tick spacing (Uniswap MEDIUM values)
- [ ] Aerodrome CL positions use `tickSpacing` field in `ExactInputSingleParams` and `MintParams` — not `fee`
- [ ] `factory.getPool()` for Aerodrome uses `(token0, token1, tickSpacing)` — not `(token0, token1, fee)`
- [ ] ABI selection in `buildContractsForDex()` (`src/contracts.ts:60`) matches `swapRouterType`:
  - `pancakeswap-v3` → `SwapRouter.json` (no deadline field)
  - `uniswap-v3` → `UniswapV3SwapRouter.json` (has deadline)
  - `aerodrome-cl` / `aerodrome-cl-gc` → `AerodromeCLSwapRouter.json` (has deadline + tickSpacing)

### Layer D: Transaction Safety

- [ ] `isTwapSafe()` called before executing rebalance — both in monitoring loop and force-rebalance path
- [ ] `validateSqrtPrice()` called at TWO points: before `removeLiquidity` AND before `executeSwap`
- [ ] Pool state re-fetched immediately before swap step — not reusing stale `sqrtPriceX96` from earlier steps
- [ ] `writeRecoveryState()` called BEFORE `removeLiquidity` (burn) — if moved to after, stranded funds become undetectable
- [ ] `clearRecoveryState()` called AFTER `updateConfigTokenId` — not before successful mint
- [ ] Pre-mint zero-balance check: if `currentTick` inside `[tickLower, tickUpper]` and either token amount is `0n`, throw before minting (V3 requires both tokens when in range)
- [ ] `swapResult.amountOut === 0n` check exists after swap execution

### Layer E: Security & Secrets

- [ ] `config.privateKey` deleted after wallet creation in `setupAllChains()` — verify `delete` statement present
- [ ] No `JSON.stringify(config)` or `logger.*(config` without explicit field selection
- [ ] `ensureApproval()` uses exact amounts — no `MaxUint256` approvals
- [ ] `ensureApproval()` calls `approve(spender, 0)` first for USDT/KTA-like tokens (zero-first pattern)
- [ ] If Piteas aggregator is used: `swapData.to` validated against known router address; `swapData.value` asserted `=== 0n` for ERC-20 swaps
- [ ] All `/api/` routes use `requireAuth` middleware (except `/api/auth/login`)
- [ ] No raw `error.message` or stack traces in API responses or Telegram messages

### Layer F: Multi-Chain State Consistency

- [ ] All state maps use `posKey(chainId, tokenId)` composite keys — not bare `tokenId`
- [ ] Recovery state files are per-chain: `.recovery-state-{chainId}.json`
- [ ] Cross-process lock: `isRebalanceLocked(chainId, tokenId)` checked before dashboard on-chain tx (409 if locked)
- [ ] `validateRecoveryState()` asserts `token0`/`token1` addresses against known token whitelist

### Layer G: Contract Address & Position ID Integrity

- [ ] All hardcoded contract addresses in `src/config/ethereum.ts`, `src/config/arbitrum.ts`, `src/config/base.ts`, `src/config/contracts.ts` verified against official deployment docs or block explorer verified source
- [ ] Uniswap V3 canonical addresses match across ETH + Arbitrum (same addresses via CREATE2): Factory `0x1F98...F984`, NPM `0xC364...FE88`, Router `0xE592...1564`, Quoter `0xb273...5AB6`
- [ ] Base Uniswap V3 addresses are DIFFERENT from ETH/Arb (different deployer) — do not copy ETH addresses to Base
- [ ] No stale or wrong position IDs in `config.yaml` — verify `ownerOf(tokenId)` matches wallet address on-chain before adding to config
- [ ] Grep for old wrong addresses after any address change: `F765` (old wrong Factory), `6c7e91A0` (old wrong NPM) must return zero matches

---

## Part 2: High-Risk Code Map

These are the functions where a one-line change can cause irreversible fund loss. Consult the invariant before modifying.

### 1. `calculateSwapAmount()` — `src/math.ts:285`

**Risk**: Wrong Q192 multiplication causes 100% swap (v1.6.2 regression)
**Invariant**: Token0 return = `excessValueScaled * FEE_DENOMINATOR / (sqrtPriceSq * feeMultiplier)` — divide by `sqrtPriceSq`, never multiply by `Q192`
**Regression signal**: Any rebalance that swaps >90% of available tokens

### 2. `calculateAmountOutMinimum()` — `src/swap.ts:28`

**Risk**: Wrong slippage allows sandwich attacks or excessive fund loss
**Invariant**: zeroForOne: `amountIn * sqrtPriceSq / Q192`; oneForZero: `amountIn * Q192 / sqrtPriceSq` — then apply fee and slippage deductions
**Regression signal**: Swap output drastically below expected, or negative result not floored to 0

### 3. Mint `amount0Min`/`amount1Min` — `src/rebalancer.ts`

**Risk**: Wrong minimums cause mint revert AFTER NFT already burned (stranded funds)
**Invariant**: Derived from `getLiquidityForAmounts()` + `getAmountsForLiquidity()` pool math — never from wallet balance percentages
**Regression signal**: "STF" or "Price slippage check" revert on mint step

### 4. `writeRecoveryState()` / `clearRecoveryState()` sequencing — `src/rebalancer.ts`

**Risk**: If recovery state write moves after burn, or clear before mint, funds become undetectable
**Invariant**: `writeRecoveryState` → `removeLiquidity` → mint → `updateConfigTokenId` → `clearRecoveryState`
**Regression signal**: `.recovery-state-{chainId}.json` missing after failed rebalance

### 5. `validateSqrtPrice()` — `src/rebalancer.ts`

**Risk**: Stale or corrupted `sqrtPriceX96` produces impossible slippage params; bot transacts at wrong price
**Invariant**: Called at two callsites — before `removeLiquidity` AND before `executeSwap` — must not be removed or consolidated
**Regression signal**: Swap at wildly incorrect price, or silent 0-output swap

### 6. `isTransientRpcError()` — `src/rebalancer.ts`

**Risk**: Mis-classifying CALL_EXCEPTION as transient causes infinite retry loops on contract reverts
**Invariant**: `code === 'CALL_EXCEPTION'` → return `false` unconditionally. Only `SERVER_ERROR`, `NETWORK_ERROR`, `TIMEOUT`, 504, ECONNRESET → `true`
**Regression signal**: Bot retries the same revert 5 times before entering safe mode

### 7. `buildContractsForDex()` — `src/contracts.ts:60`

**Risk**: Wrong ABI selection causes silent wrong-format transaction encoding (no error until on-chain revert)
**Invariant**: ABI selection keyed on `swapRouterType` — each DEX type loads its own set of ABIs. Router/factory/NPM must all be from the same DEX deployment
**Regression signal**: "Transaction reverted" on swap immediately after seemingly correct encoding

### 8. `ensureApproval()` — `src/swap.ts`

**Risk**: Missing zero-first approval for USDT/KTA pattern; or missing `await tx.wait()` causes nonce race
**Invariant**: Approval `tx.wait()` completes before function returns. Zero-first pattern applied when existing allowance is nonzero and new amount differs
**Regression signal**: "ERC20: approve from non-zero to non-zero" revert

### 9. `validateRecoveryState()` — `src/recovery.ts`

**Risk**: Tampered `.recovery-state-{chainId}.json` pointing at malicious ERC-20 directs bot to call `approve`/`balanceOf` on attacker-controlled code
**Invariant**: Both `token0` and `token1` must match known token address whitelist
**Regression signal**: Recovery attempting operations with unknown token addresses

### 10. Hardcoded Contract Addresses — `src/config/ethereum.ts`, `src/config/arbitrum.ts`, `src/config/base.ts`

**Risk**: Wrong address causes all on-chain calls (factory.getPool, mint, burn, collect, swap) to hit non-existent contracts → silent failures or fund loss
**Invariant**: Every hardcoded address must be verified against official deployment docs (Uniswap, Aerodrome, PancakeSwap) or block explorer verified source. Uniswap V3 uses CREATE2 — same addresses on ETH + Arb, but DIFFERENT on Base.
**Regression signal**: `factory.getPool()` returns zero address; `ownerOf()` reverts; "missing revert data" errors on position queries
**Historical**: v2.2.1 audit found Factory (`F765` → `F984`) and NPM (`6c7e91A0` → `FE88`) wrong in both `ethereum.ts` and `arbitrum.ts` — never triggered because no live positions on those chains.

---

## Part 3: Multi-Chain / Multi-DEX Validation Matrix

Consult this table when touching `src/contracts.ts`, `src/rebalancer.ts` mint/swap params, or chain config.

| Feature | 9mm V3 (PulseChain) | Uniswap V3 (ETH/Base/Arb) | PancakeSwap V3 (Arb) | Aerodrome CL (Base) |
| ------- | ------------------- | ------------------------- | ------------------- | ------------------- |
| **SwapRouter deadline** | No | Yes | No | Yes |
| **Pool key param** | `fee` | `fee` | `fee` | `tickSpacing` |
| **MEDIUM fee** | 2500 | 3000 | 2500 | N/A (identity-mapped) |
| **MEDIUM tick spacing** | 50 | 60 | 50 | varies |
| **Pool ABI** | UniswapV3Pool | UniswapV3Pool | UniswapV3Pool | AerodromeCLPool |
| **slot0 fields** | 7 (incl. feeProtocol) | 7 | 7 | 6 (no feeProtocol) |
| **factory.getPool()** | (t0, t1, fee) | (t0, t1, fee) | (t0, t1, fee) | (t0, t1, tickSpacing) |
| **Pool address type** | CREATE2 | CREATE2 | CREATE2 | EIP-1167 proxy |
| **Promise.all safe** | Yes | Yes | Yes | **No** — sequential only |
| **MintParams key field** | `fee` | `fee` | `fee` | `tickSpacing` + `sqrtPriceX96: 0n` |
| **positions() index 4** | fee | fee | fee | tickSpacing |
| **config.yaml dex** | `9mm-v3` | `uniswap-v3` | `pancakeswap-v3` | `aerodrome-cl` / `aerodrome-cl-gc` |
| **Zero-first approval** | No | No | No | Yes (KTA, USDT-like) |

**When adding a new DEX**: Every row in this table must be answered. If any cell is unknown, verify on-chain before deploying.

**When adding a new chain**: Also verify RPC provider compatibility, gas estimation behavior, block time assumptions, and native token wrapping contract.

---

## Part 4: Post-Mortem Template

Execute this protocol AFTER any bug fix, feature addition, refactor, or edge-case resolution. All sections are mandatory.

---

### Section 1: Change Summary

- **Date**: 2026-02-27
- **Files modified**: `src/config/ethereum.ts`, `src/config/arbitrum.ts`, `src/config/constants.ts`, `CONSTITUTIONAL_TRUTHS.md`, `config.example.ethereum.yaml`, VPS `config.yaml` (position ID fixes)
- **Functions changed**: N/A (config constants only)
- **Change type**: Chain config
- **Which rebalance step affected?** 1-Fetch (factory.getPool, ownerOf — all steps would fail with wrong addresses)
- **Behind dry_run gating?** No — address constants are used in both dry-run and live mode
- **What was failing?** Uniswap V3 Factory and NPM addresses wrong on Ethereum + Arbitrum (last 3-6 hex chars). Position #440661 not owned by wallet. Position #213623 wrong ID (actual: #1213623).
- **What is now working?** All 5 positions (#155977, #156145, #54105286, #1213623, #2440661) monitoring clean with zero ownership errors. Ethereum/Arbitrum addresses match official Uniswap deployment docs.

---

### Section 2: Root Cause Analysis

Select all that apply:

- [ ] Stale on-chain state reuse (sqrtPriceX96, tick, liquidity from earlier step)
- [ ] Wrong DEX ABI selected for chain/position
- [ ] BigInt/Number precision loss or wrong arithmetic
- [ ] Fee vs tickSpacing confusion (9mm 2500/50 vs Uniswap 3000/60 vs Aerodrome identity)
- [ ] Recovery state sequencing error (write/clear timing)
- [ ] Aggregator trust boundary violation (Piteas/1inch to/value/data)
- [ ] Cross-chain state key collision (bare tokenId instead of posKey)
- [ ] EIP-1167 proxy / Promise.all batching issue (Aerodrome)
- [ ] Nonce race condition (approval → swap, or RPC rotation)
- [ ] TWAP observation cardinality insufficient
- [ ] Missing zero-first approval for non-standard ERC-20
- [ ] Contract revert mis-classified as transient RPC error
- [x] Other: Wrong hardcoded contract addresses (typo in hex chars) + wrong position IDs in config.yaml

**Why it failed:** Ethereum and Arbitrum Factory/NPM addresses had wrong hex suffixes — likely copy-paste error during initial multi-chain setup. Position #440661 was not owned by our wallet (likely confused with #2440661). Position #213623 was a digit transposition of #1213623.

**Why it was not caught earlier:** No live positions existed on Ethereum or Arbitrum, so the wrong addresses never triggered on-chain calls. Position ownership was not verified against on-chain `ownerOf()` when adding to config — the bot's safe mode error messages were the first signal.

**What assumption was incorrect:** That addresses copied during multi-chain config setup were verified. That position IDs entered in config.yaml were double-checked against on-chain ownership.

---

### Section 3: Rule Extraction

Convert the lesson into preventative rules using these project-specific labels:

```text
[MATH RULE]   — BigInt ops, Q96/Q192, sqrtPriceX96 usage, swap amount calculation
[CHAIN RULE]  — Chain-specific behavior (ABI, fee tier, pool key, gas)
[DEX RULE]    — DEX-specific (deadline field, tickSpacing vs fee, proxy pools)
[STATE RULE]  — posKey composite keys, recovery file sequencing, lock files, nonce tracking
[SECURITY RULE] — approvals, slippage, TWAP, aggregator validation, secret handling
[ASYNC RULE]  — await ordering, nonce safety, provider rotation, RPC fallback
[ARCH RULE]   — getter properties on contracts, config atomicity, ESM imports
```

Format:

```text
RULE-NNN: [LABEL]
If ___ then ALWAYS ___.
Never ___ without ___.
When dealing with ___ ensure ___.
```

**Rules extracted from this post-mortem:**

```text
RULE-25: [CHAIN RULE]
When adding hardcoded contract addresses to chain config files, ALWAYS verify every address against
official deployment docs (Uniswap, Aerodrome, PancakeSwap) or block explorer verified source.
Never trust copy-paste — compare full checksummed address character by character.

RULE-26: [STATE RULE]
When adding a position ID to config.yaml, ALWAYS verify ownerOf(tokenId) returns the bot's wallet
address on-chain before enabling monitoring. Never assume a token ID is correct without on-chain verification.
```

Add new rules to `MEMORY.md` (numbered sequentially after existing rules).

---

### Section 4: Regression Guard

- **Dry-run behavior to observe**: All 5 positions complete monitoring cycle with no "ownership mismatch" or "safe mode" log lines. `factory.getPool()` returns non-zero addresses for Ethereum/Arbitrum chains.
- **Log lines that indicate regression**: "Position ownership verification failed", "Entering safe mode", "missing revert data", "factory.getPool returned zero address"
- **Part 1 layers affected**: G (Contract Address & Position ID Integrity)

---

### Section 5: Cross-Reference Updates

Which existing documents need updating as a result of this change?

- [x] `MEMORY.md` — Added Rules 25-26 (address verification, position ID verification)
- [x] `CONSTITUTIONAL_TRUTHS.md` — Expanded from 7→12 sections (Aerodrome CL facts + multi-chain Uniswap V3 addresses)
- [x] `STATUS.md` — Updated position list, added v2.2.1 recent changes entry
- [x] `CHANGELOG.md` — Added v2.2.1 entry for config audit fixes
- [ ] `CONTRIBUTING.md` — No changes needed
- [ ] `SECURITY.md` — No new security rules (address verification is a config concern, not security)
- [ ] Part 3 matrix above — No new DEX or chain added

---

### Section 6: Future Risk Assessment

- **Which other files share the same pattern that was just fixed?** `src/config/base.ts` (already verified correct), `src/config/contracts.ts` (9mm/PulseChain, already verified correct). Any future chain config file.
- **Which chains/DEXes have NOT been tested with this change?** Ethereum and Arbitrum have corrected addresses but no live positions — the addresses have not been exercised with real on-chain calls yet. PulseChain and Base are fully tested with live positions.
- **Is there a parallel code path (e.g. recovery flow vs normal rebalance, force-rebalance vs monitoring loop, dashboard vs bot) that has the same bug?** No — addresses are loaded from config constants, shared across all code paths.
- **What modules or logic should be reviewed next?** When first deploying a position on Ethereum or Arbitrum, verify `factory.getPool()` returns a valid pool address to confirm the corrected addresses work end-to-end.

---

## Part 5: Analytics Subsystem Invariants (v2.8.0 — Doc A Data Capture)

These invariants govern the new analytics modules added in v2.8.0. Consult before modifying any file in `src/analytics/`.

### 5A: Price History & Volatility

- **JSONL files are per-pool**: `price-history-{poolAddress}.jsonl` — one file per pool, NOT per position
- **Retention**: 30 days rolling. `prunePriceHistory()` uses atomic write (tmp + rename) to avoid partial-file corruption
- **Sigma formula**: `sigma_Nd = std_dev(log_returns over N days) * sqrt(samples_per_year)` where `samples_per_year = actual_samples_per_day * 365` (adapts to observed sample rate)
- **Minimum observations**: sigma_7d requires >= 20 observations, sigma_30d requires >= 50. Below threshold returns `undefined`
- **Confidence scoring**: Based on gap fraction in observations — `< 5%` gaps = high, `< 15%` = medium, else low
- **`computeViabilityFields()` is pure**: No I/O, no state. Takes `(sigma30d, poolFeeRate, widthPct)`, returns `{ minPlRate, profitabilityMargin, profitabilityViable, effectiveAprPct }`
- **Profitability floor**: `min_pl_rate = sigma30d^2 / 8`. Pool is viable only if `pool_fee_rate > min_pl_rate` (strict greater-than, NOT >=)
- **`effectiveAprPct`**: Undefined when `widthPct` is 0 or undefined (avoids div-by-zero)

### 5B: Trigger Events

- **Every monitoring cycle emits a trigger event** — not just rebalances. Hold decisions, cooldown skips, and cost-benefit gates all produce structured records
- **Trigger types**: `price_exit`, `hold`, `near_edge_warning`, `volatility_regime_shift`, `manual_override`, `cooldown_active`, `cost_benefit_skip`, `critical_distance`
- **`triggerEventId`**: UUID, unique per event. Used for deduplication in `queryAllChainTriggerEvents()`
- **Context fields include sigma, poolFeeRate, estimatedCostUsd** — these are captured at trigger time for retrospective analysis

### 5C: Strategy Rule Set Snapshots

- **Emitted on config change only** — not every cycle. Triggered by Telegram `/config`, `reloadPositions()`, or initial config load
- **`ruleSetId`**: UUID, unique per snapshot. Used for deduplication in `queryAllChainStrategyRuleSets()`
- **Contains full param snapshot**: width_ticks, trigger_distance_ticks, confirm_minutes, strategy name, cost_benefit settings, kill_switch settings
- **`getLatestRuleSet(storagePath, tokenId)`**: Returns most recent snapshot for a position (sorted by `createdAt`)

### 5D: Retrospective Outcome Backfill

- **Background job**: Runs every 6 hours via `setInterval`. Started in `index.ts` alongside price backfill. Stopped on graceful shutdown.
- **Window eligibility**: A rebalance must be old enough before its outcome windows can be backfilled:
  - `feesEarned1dUsd`: rebalance must be >= 24h old
  - `feesEarned3dUsd`: >= 3 days old
  - `feesEarned7dUsd`: >= 7 days old
- **`actualDaysToRecovery`**: Sentinel value `-1` means "not recovered within 7 days". Only set when rebalance is >= 7 days old and cumulative fees never exceeded `totalLossUsd`
- **`nextRebalanceId`**: Links to the next rebalance involving the same position (by matching `newTokenId`). Array must be sorted chronologically for correct first-match behavior
- **`recoveredBeforeNextRebalance`**: `true` if cumulative fees between this rebalance and the next exceeded `totalLossUsd`
- **Atomic rewrite**: `rebalances.jsonl` is rewritten atomically (tmp + rename) when records are updated
- **Idempotent**: Running the backfill multiple times produces the same result — already-filled fields are not overwritten

### 5E: Storage Query Functions

- **All `queryAllChain*` functions** follow the same pattern: query base path + all `chain-*` subdirs, deduplicate by unique ID, sort chronologically
- **Deduplication keys**: `triggerEventId` for trigger events, `ruleSetId` for strategy rule sets, `rebalanceId` for rebalances
- **`bigintReviver`** in `storage.ts` must include all BigInt field names. When adding new BigInt fields to analytics types, add the field name to the `bigintFields` Set

---

**Last Updated**: 2026-03-06

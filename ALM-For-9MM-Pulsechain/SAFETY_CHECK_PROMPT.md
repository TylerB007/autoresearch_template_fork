# Safety Check Prompt

Copy and paste the block below into Claude Code after making changes to run a comprehensive security audit.

---

```
Run a comprehensive safety audit of this 9mm V3 LP Auto-Rebalancer codebase. This bot manages real funds on PulseChain — any leak or vulnerability can cause irreversible loss. Check every category below and report PASS/FAIL with file:line references for any failures.

## 1. SECRETS & PRIVATE KEY SAFETY

Search the entire `src/` directory for these patterns and flag any matches that are NOT inside comments, type definitions, or delete statements:

- Grep for `privateKey` — it should ONLY appear in: `configLoader.ts` (loading), `chain.ts` (wallet creation + deletion), `types.ts` (type definition), `multiChain.ts` (none expected). Any other file is a FAIL.
- Grep for `bot_token` as a string literal (not `process.env` access) — should not appear hardcoded anywhere.
- Grep for `JWT_SECRET` as a string literal — should not appear hardcoded.
- Grep for `DASHBOARD_PASSWORD` as a string literal — should not appear hardcoded.
- Verify `chain.ts` still contains `delete (config as unknown as Record<string, unknown>).privateKey` after wallet creation (in both `setupChain()` and `setupAllChains()`).
- Grep for `JSON.stringify(config)` or `JSON.stringify(config,` — any match that passes the full config object is a FAIL. Only explicit field selection is allowed (e.g., `JSON.stringify(config.positions)`).
- Grep for `JSON.stringify(mctx)` or `logger.info(.*mctx)` — `MultiChainContext` transitively holds wallet instances. Serialization is a FAIL.
- Grep for `logger.info(.*config)` or `logger.debug(.*config)` patterns that might serialize the full config object.
- Verify `.gitignore` contains entries for: `.env`, `.secret`, `config.yaml`, `.mcp.json`
- Check `git status` to ensure `.env`, `.secret`, and `config.yaml` are NOT tracked or staged.

## 2. API & DASHBOARD SECURITY

- Read `src/server/index.ts` and verify ALL route mounts under `/api/` (except `/api/auth`) use `requireAuth` middleware.
- Verify `cors()` is called with an explicit `origin` option — open `cors()` with no arguments is a FAIL.
- Verify `helmet()` is configured and `contentSecurityPolicy` is NOT set to `false`.
- Verify rate limiting is applied to `/api/` routes (general limiter) and `/api/auth/login` (strict limiter).
- Search all files in `src/server/routes/` for `res.status(4xx|5xx).json` responses — check that NONE include raw `error.message`, `err.message`, `String(error)`, or `error.stack`. Error responses must be generic strings like `'Internal server error'` or `'Fee collection failed'`. Flag every instance that leaks internal error details.
- Verify `/api/config` route redacts RPC URLs (shows hostname only, not full URL with potential API keys).

## 3. TRANSACTION SAFETY (FUNDS AT RISK)

- Grep for `MaxUint256` or `maxUint256` or `2n ** 256n - 1n` in approval contexts — any use for token approvals is a CRITICAL FAIL. Approvals must use exact amounts via `ensureApproval()`.
- Verify every `sendTransaction`, `mint`, `decreaseLiquidity`, `collect`, `burn`, `approve`, and swap call includes an explicit `gasLimit` property from `GAS_LIMITS` constants.
- Read `src/swap.ts` `calculateAmountOutMinimum()` — verify it uses `sqrtPriceX96` for price-aware slippage, NOT a percentage of `amountIn`.
- Verify `src/rebalancer.ts` calls `isTwapSafe()` before executing any rebalance.
- Verify `src/rebalancer.ts` `validateSqrtPrice()` is called before both removeLiquidity and swap steps.
- Verify mint `amount0Min`/`amount1Min` are derived from pool math (`getLiquidityForAmounts` + `getAmountsForLiquidity`), NOT from wallet balance percentages.

## 4. AGGREGATOR TRUST BOUNDARY (CRITICAL — Piteas controls raw tx params)

This is a high-value attack surface. The Piteas DEX aggregator API response directly controls `to`, `data`, and `value` fields of a raw `sendTransaction` call. A compromised or MitM'd API can drain the wallet.

- Read `src/aggregators/piteas.ts` and verify:
  - `swapData.to` is validated to equal `PITEAS_ROUTER_ADDRESS` (case-insensitive) BEFORE being passed to `sendTransaction`. If unvalidated, flag as CRITICAL — any address the API returns will receive the transaction.
  - `swapData.value` is validated — for ERC-20 to ERC-20 swaps (WPLS/HEX), `value` should be `0`. If the API can set arbitrary `value`, it can drain native PLS balance. Flag as CRITICAL if unconstrained.
  - `swapData.data` — while harder to validate, check if there's any sanity check (e.g., starts with expected function selector).
  - The approval target is the hardcoded `PITEAS_ROUTER_ADDRESS`, NOT `swapData.to` — this limits ERC-20 drain to the approved amount, but only if `to` validation exists.
  - `quote.outputAmount` from the API controls `amountOutMin` — check if there's a floor cross-check against `sqrtPriceX96` to prevent the API from quoting an artificially low output, effectively giving away tokens.
- If any of the above are missing, recommend: (1) assert `swapData.to === PITEAS_ROUTER_ADDRESS`, (2) cap `value` to 0n for token-to-token swaps, (3) add an independent price floor from on-chain `sqrtPriceX96`.

## 5. CONCURRENCY & NONCE SAFETY

- Check if the dashboard server (`9mm-dashboard`) and the bot (`9mm-rebalancer`) are separate PM2 processes sharing the same wallet. If yes, flag as HIGH — their independent `NonceTracker` instances will race on nonce assignment during concurrent transactions.
- Read `src/server/routes/positions.ts` for the `POST /:tokenId/collect` and `POST /:tokenId/rebalance` endpoints — verify they check `rebalancingPositions.has(posKey(chainId, tokenId))` BEFORE executing on-chain transactions. The lock check must use composite keys (not bare tokenId). If no concurrency guard exists, flag as HIGH.
- Check `src/swap.ts` `ensureApproval()` — verify the approval tx is `await`ed with `tx.wait()` BEFORE the subsequent swap nonce is assigned. A missing `await` means the approval and swap could share the same nonce.
- Verify `NonceTracker.resetNonce()` uses `max(chainPendingNonce, lastConfirmedNonce + 1)` — not just `chainPendingNonce` alone, which can go backwards after RPC rotation.
- Verify each chain has its own `NonceTracker` instance — nonces from chain A must never be used on chain B.

## 6. TWAP & PRICE ORACLE INTEGRITY

- Verify `isTwapSafe()` is called before every rebalance execution (not just in the monitoring loop — also in force-rebalance paths like dashboard `/rebalance` endpoint).
- Check what happens when `pool.observe()` throws a non-"OLD" error (e.g., RPC failure). If the TWAP check **fails open** (returns `safe: true` on error), flag as MODERATE — an attacker who can cause RPC errors during price manipulation bypasses the oracle check.
- Verify `slot0()` sqrtPriceX96 used for slippage calculations is re-fetched immediately before the swap — not reused from an earlier step that may be minutes stale.
- Check `sqrtPriceLimitX96` in swap calls — verify it caps price impact (e.g., 5% max) to limit flash-loan extraction even if TWAP passes.

## 7. DIVISION BY ZERO & MATH EDGE CASES

- Read `src/math.ts` functions `getAmount0ForLiquidity`, `getAmount1ForLiquidity`, `getLiquidityForAmount0`, `getLiquidityForAmount1`:
  - Flag if `sqrtPriceAX96 === 0n` would cause division by zero (denominator `sqrtPriceBX96 * sqrtPriceAX96`).
  - Flag if `sqrtPriceAX96 === sqrtPriceBX96` (i.e., `tickLower === tickUpper`) would cause division by zero (denominator `sqrtPriceBX96 - sqrtPriceAX96`).
  - Verify callers guard against these inputs or that `nearestUsableTick` enforces `tickLower < tickUpper`.
- Check `src/swap.ts` `calculateAmountOutMinimum()` — if `slippage_tolerance_bps >= 10000`, the result goes negative (BigInt supports negatives, unlike Solidity uint256). Verify there's a floor of `0n` or a range check on the config value.
- Search `src/configLoader.ts` for range validation on `slippage_tolerance_bps` — flag if values > 5000 (50%) are allowed without warning.

## 8. RECOVERY STATE FILE INTEGRITY

- Read `src/recovery.ts` where `.recovery-state-{chainId}.json` is loaded — verify `JSON.parse()` output is validated against expected schema before use (e.g., `token0`/`token1` are valid hex addresses, `oldTokenId` is a positive integer, `fee` is a known fee tier).
- Verify `validateRecoveryState()` also validates the `chainId` field if present (must be positive integer or undefined).
- Check if `recoveryState.token0` and `token1` are validated against known token addresses from the current position configs — a tampered file could point to malicious ERC-20 contracts whose `balanceOf`/`approve`/`transfer` execute arbitrary logic.
- Verify `.recovery-state*.json` patterns are in `.gitignore`.
- Check if `recoveryState` fields (e.g., `token0Symbol`) are logged via template literals — a tampered file with newlines in string fields could inject fake log lines (log injection).
- Verify `clearRecoveryState(chainId)` does NOT unconditionally delete the legacy `.recovery-state.json` — it should only delete the chain-specific file, or check the legacy file belongs to the same chain before deleting.
- Verify `detectStrandedFunds` receives a `chainId` parameter in ALL call sites (bot, dashboard, Telegram) — missing chainId means per-chain recovery files won't be found.

## 9. ESM & BUILD INTEGRITY

- Grep all `.ts` files in `src/` for import statements: `from '\./` or `from '\.\./` — verify every relative import ends with `.js`. Any import without `.js` extension is a FAIL (will break at runtime).
- Verify `package.json` has `"type": "module"`.
- Grep for bare `require(` calls — the ONLY acceptable usage is via `createRequire(import.meta.url)` for JSON imports. Any other `require()` is a FAIL.

## 10. ON-CHAIN MATH SAFETY

- Search `src/math.ts`, `src/rebalancer.ts`, `src/swap.ts` for `Number(` or `parseInt(` or `parseFloat(` applied to token amounts, liquidity values, or sqrtPriceX96. These MUST be BigInt. Any Number conversion of on-chain values is a FAIL.
- Verify tick spacing 50 is used for MEDIUM fee tier (2500). Search for `tickSpacing` assignments and `fee: 3000` — the value 3000 should NOT appear anywhere (9mm uses 2500, not Uniswap's 3000).
- Verify `src/config/fees.ts` defines MEDIUM as `{ fee: 2500, tickSpacing: 50 }`.

## 11. DEPENDENCY SAFETY

- Run `npm audit` and report any critical or high vulnerabilities.
- Check `package.json` — verify all `@types/*` packages are in `devDependencies`, not `dependencies`.
- Flag any new dependencies added since the last audit that seem unnecessary or risky.

## 12. TELEGRAM BOT SAFETY

- Read `src/telegramCommands.ts` authorization logic — verify commands are authorized by numeric `chat_id` comparison, NOT by username.
- Search `src/telegramCommands.ts` and `src/notifications.ts` for places that send error messages — verify none include raw `error.message` or `error.stack`. Error messages to Telegram should be sanitized (e.g., "Rebalance failed — check server logs"). Raw error messages may contain RPC URLs with embedded API keys.
- Verify the bot token is loaded from `process.env`, not hardcoded.
- Verify `/config` command parameter parsing uses a whitelist of allowed keys — no arbitrary config field should be settable via Telegram.

## 13. MULTI-CHAIN ISOLATION & STATE SAFETY

This section verifies the multi-chain refactor does not introduce cross-chain state corruption, wrong-chain transactions, or key mismatches.

### Composite Key Consistency

- Grep `src/` for `posKey(` — verify every call uses `posKey(chainId, tokenId)` where `chainId` is resolved from `posConfig.chain_id ?? config.chain.chainId` or `mctx.resolveChainId(pos)`. Flag any `posKey(posConfig.chain_id ?? 0, ...)` as CRITICAL — `0` is not a valid chain ID.
- Grep `src/` for the pattern `chain_id ?? 0` — every match is a FAIL. The fallback must always be `config.chain.chainId`.
- Grep `src/notifications/proactive.ts` and `src/rebalancer.ts` for inline key construction (`${...chain_id...}-${...token_id...}`) — verify it uses the same fallback as `posKey`.
- Verify `outOfRangeSince`, `rebalanceHistory`, `safeModePositions`, `rebalancingPositions`, `lastRebalanceTime`, `transientFailureCount` all use `posKey()` consistently.

### Per-Position Chain Resolution

- Read `src/server/routes/positions.ts` — verify ALL `getPositionStatus()`, `collectFees()`, `getMintTimestamp()`, and `checkAndRebalance()` calls resolve per-position chain via `multiChain.getChainById(multiChain.resolveChainId(pos))` and `multiChain.getContracts(pos)`. Using the default `contracts`/`chain` for all positions is a HIGH — wrong-chain transactions on non-default positions.
- Read `src/telegramCommands.ts` — verify `getChainForPosition()` and `getContractsForPosition()` are used for ALL on-chain calls (status, collect, remove, rebalance). Verify `/balance` ERC-20 queries use per-chain contracts (not just default).
- Read `src/server/routes/dashboard.ts` — verify per-position chain resolution for `getPositionStatus` and `getMintTimestamp`.
- Read `src/server/routes/analytics.ts` — verify per-position chain resolution for `getPositionStatus` in portfolio summary and export.
- Read `src/server/routes/recovery.ts` — verify `detectStrandedFunds` receives `chainId`. Verify `recoverStrandedFunds` uses the correct chain's contracts.

### Analytics Storage Path Consistency

- Verify the collector writes to `analytics/chain-{chainId}/` via `chainStoragePath()`.
- Verify ALL read paths (dashboard, analytics routes, Telegram `/chain`, `/link`, `/export`) use `resolveStoragePath()` to find per-chain data — reading only from flat `analytics/` is a FAIL once per-chain subdirs exist.
- Verify `resolveStoragePath()` falls back to base path when chain subdir doesn't exist (backward compat).

### RPC URL Isolation

- Read `src/configLoader.ts` `buildRpcUrlsForChain()` — verify generic env vars (`RPC_URL_PRIMARY`, etc.) are ONLY applied to the default chain, not to all chains. Cross-chain RPC leakage is a HIGH.
- Verify each chain gets its own `FallbackRpcProvider` with `staticNetwork` matching its chain ID.
- Grep `src/chain.ts` for `getCurrentUrl()` in log statements — verify URL is redacted to hostname only.

### Config Hot-Reload Validation

- Read `src/configLoader.ts` `reloadPositions()` — verify it validates:
  - `chain_id` against `config.chains` Map (reject unknown chains)
  - `strategy` against `VALID_STRATEGIES` (reject invalid strategies)
  - `width_ticks > 0` for non-preset strategies
  - No duplicate `token_id + chain_id` pairs
- If any validation is missing, flag as CRITICAL — hot-reload bypasses startup safety.

---

## 14. GIT & DEPLOYMENT SAFETY

- Run `git diff --cached` and `git diff` to check for any staged or unstaged secrets (private keys, tokens, passwords).
- Verify no binary files or large files are staged.
- Check that `config.yaml` changes are NOT committed (it's gitignored and the VPS version diverges from repo).
- Check that `.recovery-state*.json` files are NOT committed.
- Check that `analytics/chain-*/` directories are in `.gitignore` or otherwise not tracked.

## OUTPUT FORMAT

For each category, report:

### [Category Name]: PASS or FAIL

- [Check description]: PASS or FAIL
  - If FAIL: file:line and description of the issue
  - Severity: CRITICAL / HIGH / MODERATE / LOW

End with a summary:

### SUMMARY
- Categories passed: X/14
- CRITICAL issues: [list — any of these means DO NOT DEPLOY]
- HIGH issues: [list — fix before next deploy]
- MODERATE issues: [list — fix soon, track in STATUS.md]
- LOW issues: [list — note for future improvement]
- Recommendations: [actionable next steps]
```

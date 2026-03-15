# Project Status

**Last Updated**: 2026-03-06
**Version**: 2.8.0
**Status**: ✅ DEPLOYED & RUNNING

---

## 🚀 Current Deployment

### Production Environment
- **Platform**: DigitalOcean VPS
- **IP**: 143.110.130.198
- **SSH User**: `tyler` (root login is disabled)
- **Project Location**: `/opt/9mm-rebalancer`
- **Process Manager**: PM2 v6.0.14
- **Node.js**: v22.22.0
- **Runtime**: Production (NODE_ENV=production)
- **Git Auth**: GitHub PAT embedded in remote URL (for `git pull`)

### PM2 Processes
```
┌──────────────────┬────────┬───────────────────────────────────┐
│ Name             │ Port   │ Purpose                           │
├──────────────────┼────────┼───────────────────────────────────┤
│ 9mm-rebalancer   │ —      │ Main rebalancing bot              │
│ 9mm-dashboard    │ 3100   │ Web dashboard (Express + React)   │
└──────────────────┴────────┴───────────────────────────────────┘

Mode:            PRODUCTION (dry_run: false)
Monitoring:      Every 60 seconds (increased from 30s in v1.6.0)
Auto-restart:    ✅ Enabled (crashes + reboots)
Log rotation:    ✅ Enabled (10MB max, 10 files)
Telegram:        ✅ Two-way commands via @ALM_9mm_PersonalBot (v1.2.0)
Dashboard:       ✅ https://143.110.130.198 (v1.9.0, TLS via Caddy)
```

### Wallet & Positions

- **Wallet**: `0xcE3f...a1AB` (rotated 2026-02-10, stored in `.secret`)
- **Position #155977**: HEX/WPLS — center_6pct (PulseChain, trigger: 50, confirm: 60min)
- **Position #156145**: HEX/WPLS — center_6pct (PulseChain, trigger: 50, confirm: 60min)
- **Position #55045587**: WETH/KTA — center_6pct (Base, Aerodrome CL v1, trigger: 50, confirm: 30min)
- **Position #1141460**: WBTC/WETH — center_3pct (Sonic, Algebra V3, tickSpacing: 50)
- ~~**Position #1213623**: USDC/WETH~~ — **BURNED** during failed rebalance (2026-03-01). ~$109 USDC stranded on Ethereum, recovery pending.
- **Chains configured**: PulseChain (369), Ethereum (1), Base (8453), Sonic (146), Arbitrum One (42161)

---

## ⚠️ Known Issues

### 0. TWAP Oracle Has Low Observation Cardinality

**Status**: 🟡 Mitigated (not fully resolved)
**Description**: The HEX/WPLS 2500-fee pool has `observationCardinality = 1`. The `observe()` call always reverts with "OLD" for any lookback window > ~3 seconds. TWAP manipulation protection is effectively bypassed (falls through to "assume safe").
**Mitigation (v1.7.0)**: `isTwapSafe()` now retries with progressively shorter windows (300→60→10s) on "OLD" revert, so it will use whatever history is available instead of always failing.
**Mitigation (v2.7.0)**: Startup cardinality check warns via logs + Telegram if any pool has cardinality < 50. New `/fixtwap` Telegram command increases cardinality on-chain.
**Full fix**: Send `/fixtwap` via Telegram to call `pool.increaseObservationCardinalityNext(65536)` on-chain (one-time tx, very cheap on PulseChain).

### 2. Position Has Zero Liquidity (Resolved)

**Status**: 🟢 Resolved — Switched to position #155284
**Description**: Position #155181 reported zero liquidity during monitoring
**Resolution**: Updated `token_id` in config.yaml to active position #155284

### ~~2. Dry Run Mode Enabled~~ (Resolved)

**Status**: 🟢 Resolved — Production mode enabled
**Description**: `dry_run: false` set in config.yaml, bot executing real transactions

### ~~3. Telegram Bot 401 Polling Error~~ (Resolved)

**Status**: 🟢 Resolved — Switched to `@ALM_9mm_PersonalBot`
**Description**: Old bot token (`@automate9mmBot`) caused 401 Unauthorized errors on `getUpdates` polling
**Resolution**: Created new bot `@ALM_9mm_PersonalBot`, updated `telegram_bot_token` in config.yaml. Set `telegram_chat_id` to numeric `5874802252` (user `T_B_DeFi`).

### ~~4. Analytics Source Files Gitignored~~ (Resolved)

**Status**: 🟢 Resolved — Fixed `.gitignore` pattern
**Description**: `.gitignore` had `analytics/` which matched `src/analytics/` source code, preventing it from being committed
**Resolution**: Changed to `/analytics/` (root-level only). Committed analytics source files in `b94cefa`.

### ~~5. Positions Stuck in Safe Mode~~ (Resolved)

**Status**: 🟢 Resolved — Fixed ownership verification (v1.3.1)
**Description**: Positions #155284 and #155290 were stuck in safe mode despite being validly owned. The bot was treating RPC timeout errors as ownership failures, triggering safe mode on every startup.
**Resolution**: Modified `verifyOwnership()` in `src/position.ts` to distinguish between:
- **Contract reverts** (position doesn't exist) → trigger safe mode
- **RPC errors** (timeout, network issues) → retry via `chain.withRetry()`

**Impact**: ~$4.7M TVL now able to rebalance and earn fees again.

### ~~7. Swap Over-Calculation & Recovery Mint Failure~~ (Resolved)

**Status**: 🟢 Resolved — Q192 math fix + recovery swap step (v1.6.2)
**Description**: `calculateSwapAmount()` token0 branch had a spurious `* Q192` multiplier that inflated swap amounts by ~10^58. Every token0-sell rebalance swapped 100% instead of ~49%, leaving 0 of that token. The subsequent mint reverted because V3 requires both tokens for in-range positions. Additionally, the `/recover` flow had no swap step — it passed raw wallet balances directly to mint, which also failed when only one token was available.
**Resolution**:
1. Removed `* Q192` from token0 branch in `src/math.ts` (token1 branch was correct)
2. Added swap step to `recoverStrandedFunds()` in `src/recovery.ts` — mirrors normal rebalance steps 4-5
3. Added pre-mint sanity check in `src/rebalancer.ts` — clear error if tick in-range but token balance is 0
4. Added price impact limit and post-swap balance fallback in `src/swap.ts`
**Impact**: 4 consecutive rebalance failures resolved. Recovery of ~90,380 WPLS stranded funds succeeded.

### ~~8. Five Critical Rebalance Bugs (Feb 10–23 Failure Cascade)~~ (Resolved)

**Status**: 🟢 Resolved — v1.7.0 deployed 2026-02-23
**Description**: Comprehensive analysis of 13 days of failures (Feb 10–23) across positions #155778, #155781, #155806, #155876 identified 5 distinct bugs that would cause any rebalance to fail. The NFT burn step is irreversible — once it fires, funds are stranded until a successful mint. All 5 bugs either caused failure *after* the burn or allowed the burn to fire when it shouldn't.
**Resolution**:

1. **Mint slippage used full wallet balance** — `amount0Min`/`amount1Min` were 99% of raw `balanceOf()`, but the pool only deposits the ratio it needs. With stranded funds from prior failures inflating wallet balance, the pool's actual deposit was far below the minimum → revert. Fix: compute minimums from `getLiquidityForAmounts()` + `getAmountsForLiquidity()`.
2. **Nonce race after RPC rotation** — `resetNonce()` queried the new provider which returned stale nonces, causing `NONCE_EXPIRED`. Fix: added `lastConfirmedNonce` floor and 2-second delay between queries.
3. **WPLS auto-wrap used ERC20 ABI** — `getERC20(WPLS).deposit()` threw "not a function" because ERC20 ABI has no `deposit()`. Fix: created `abis/WETH9.json`, added `getWPLS()` to contracts.
4. **TWAP always failed** — Pool has `observationCardinality=1`, `observe([300,0])` always reverts "OLD". Fix: retry with 300→60→10s windows.
5. **Swap event parsed at wrong address** — `getPool(tokenIn)` used the ERC20 address, not the pool address. Swap event was never found, fallback used total wallet balance. Fix: resolve pool via `factory.getPool()`.

**Impact**: All positions now able to complete full rebalance cycle (collect → remove → swap → mint) without failure.

### ~~6. Safe Mode Triggered by Transient RPC 504s~~ (Resolved)

**Status**: 🟢 Resolved — Rebalance RPC resilience (v1.6.0)
**Description**: On 2026-02-11, PulseChain primary RPC (`rpc.pulsechain.com`) returned 504 Gateway Timeout during rebalance transaction execution. Both positions (#155361, #155367) entered SAFE MODE because the rebalancer's catch block entered safe mode unconditionally — even for transient RPC errors. The `withRetry()` mechanism only covered read-only calls, not transaction steps.
**Resolution**: Comprehensive fix in v1.6.0:
1. Added `isTransientRpcError()` classification — transient RPC errors (504, timeout, connection reset) skip safe mode when no recovery state file exists
2. Added `MAX_TRANSIENT_RETRIES = 5` cap — enters safe mode after 5 consecutive transient failures to prevent infinite loops
3. Changed `contracts.ts` to use dynamic getters — contract instances now resolve to current provider after RPC rotation (previously stale)
4. Added `confirm_minutes` parameter — position must stay out of range for N minutes before rebalancing (prevents reacting to transient price spikes)
5. Increased `trigger_distance_ticks` from 10 to 50 and `polling_interval_seconds` from 30 to 60

**Impact**: Bot now resilient to transient PulseChain RPC outages. No more unnecessary safe mode entries.

---

## ✅ Completed Tasks

### Deployment (2026-02-09)
- ✅ Created PM2 ecosystem config
- ✅ Deployed to DigitalOcean VPS (143.110.130.198)
- ✅ Installed Node.js v22.22.0 and PM2 v6.0.14
- ✅ Cloned repository to `/opt/9mm-rebalancer`
- ✅ Built application (`npm install && npm run build`)
- ✅ Configured private key (600 permissions, `.secret` file since v1.5.0)
- ✅ Started with PM2 (0 restarts, stable)
- ✅ Configured PM2 auto-startup (survives reboots)
- ✅ Installed PM2 log rotation (10MB max, 10 files, daily)
- ✅ Created health check script (`~/check-9mm-health.sh`)
- ✅ Created operations guide (`~/9mm-rebalancer/OPERATIONS.md`)

### Features Implemented
- ✅ Multi-provider RPC fallback (3 endpoints)
- ✅ Graceful shutdown (SIGINT/SIGTERM)
- ✅ Winston logging (JSON + file rotation)
- ✅ Telegram notifications (configured)
- ✅ Dry-run mode for safe testing
- ✅ Gas price safety checks
- ✅ Rebalance cooldown (5 minutes)
- ✅ Slippage protection (1%)
- ✅ BigInt V3 tick math (ported from Solidity)
- ✅ 7-step rebalance workflow
- ✅ Performance analytics & tracking (v1.1.0)
- ✅ Analytics CLI dashboard (v1.1.0)
- ✅ Per-step gas tracking from receipts (v1.1.0)
- ✅ Two-way Telegram bot commands (v1.2.0)
- ✅ Emergency stop via Telegram `/disable` (v1.2.0)
- ✅ Remote position monitoring via Telegram `/status`, `/report` (v1.2.0)
- ✅ Chat ID discovery helper `npm run getchatid` (v1.2.0)
- ✅ Web dashboard with JWT auth (v1.3.0)
- ✅ True unclaimed fees via `collect.staticCall()` (v1.3.0)
- ✅ Live USD prices from DexScreener (v1.3.0)
- ✅ Rebalance history page with metrics (v1.3.0)
- ✅ Manual fee collection from dashboard (v1.3.0)
- ✅ RPC-resilient ownership verification (v1.3.1)
- ✅ Position analytics dashboard with charts, P&L, health scores (v1.4.0)
- ✅ Dashboard recovery alerts — dismiss/recover stranded funds from web UI (v1.4.0)
- ✅ DEX aggregator integration — Piteas routing for better swap execution (v1.5.0)
- ✅ Width preset strategies — center_3pct, center_6pct, etc. (v1.5.0, renamed v2.2.0)
- ✅ Rebalance cost estimates with tooltips on position detail page (v1.5.1)
- ✅ Position USD value and lifetime APR on dashboard cards (v1.5.1)
- ✅ Navbar refresh button — re-fetch data without page reload (v1.5.1)
- ✅ Persistent auth sessions via localStorage — survives page refresh (v1.5.1)
- ✅ JWT expiry extended from 1h to 24h (v1.5.1)
- ✅ Configurable snuggle strategy ratios via `/config` Telegram command (v1.5.1)
- ✅ Transient RPC error classification — skip safe mode for recoverable errors (v1.6.0)
- ✅ Retry cap (5 consecutive failures) to prevent infinite gas drain (v1.6.0)
- ✅ Dynamic contract provider rotation via getters (v1.6.0)
- ✅ Confirmation delay (`confirm_minutes`) before rebalancing (v1.6.0)
- ✅ Fixed Q192 swap over-calculation bug in token0 branch (v1.6.2)
- ✅ Added swap step to recovery flow for single-token wallets (v1.6.2)
- ✅ Pre-mint sanity check: clear error when tick in-range but token balance is 0 (v1.6.2)
- ✅ Price impact limit and post-swap balance fallback for swap safety (v1.6.2)
- ✅ Pool-math-derived mint slippage — `getLiquidityForAmounts` + `getAmountsForLiquidity` (v1.7.0)
- ✅ Nonce tracker with `lastConfirmedNonce` floor and 2s reset delay (v1.7.0)
- ✅ WETH9 ABI and `getWPLS()` for native PLS auto-wrapping (v1.7.0)
- ✅ Adaptive TWAP window — retry 300→60→10s on "OLD" revert (v1.7.0)
- ✅ Factory-derived pool address for Swap event parsing (v1.7.0)
- ✅ WPLS auto-wrap in recovery flow before mint (v1.7.0)
- ✅ Rebalance Now button + preview modal on position detail page (v1.8.0)
- ✅ Force rebalance API endpoint `POST /api/positions/:id/rebalance` with lock guard (v1.8.0)
- ✅ Rebalance preview API endpoint `GET /api/positions/:id/rebalance-preview` (v1.8.0)
- ✅ Telegram `/rebalance` preview enhanced — new range ticks/prices + swap estimate (v1.8.0)
- ✅ Piteas aggregator trust boundary — `swapData.to` and `swapData.value` validated (v1.8.0)
- ✅ Cross-process rebalance lock files — dashboard 409s if bot is mid-rebalance (v1.8.0)
- ✅ Recovery state schema validation — token addresses whitelisted, all fields type-checked (v1.8.0)
- ✅ `slippage_tolerance_bps` range validation at startup (1–9999) (v1.8.0)
- ✅ `calculateAmountOutMinimum` floored at 0n (v1.8.0)
- ✅ `config.yaml` untracked from git — was leaking runtime secrets into history (v1.8.0)
- ✅ Dashboard enhancements — position cards show fees/age/rebalance count, wallet holdings, unclaimed fees (v1.9.0)
- ✅ Rebalance execution cost tracking — `preValue - postValue - gasCost` at single reference price (v1.9.0)
- ✅ Analytics export to CSV/JSON — per-rebalance and per-snapshot detail (v1.9.0)
- ✅ Health score system — component-based 0-100 scoring with weighted factors (v1.9.0)
- ✅ Volatility metrics — tick range, standard deviation, annualized volatility from snapshots (v1.9.0)
- ✅ Cost-benefit evaluation — break-even analysis, rebalance profitability assessment (v1.9.0)
- ✅ Proactive notifications — scheduled health alerts, out-of-range warnings, fee milestones (v1.9.0)
- ✅ Position chain visualization — timeline view of rebalance history with aggregate stats (v1.9.0)
- ✅ Slippage sanitization — clamped to 500 bps max, sanitized across API/chain/export reads (v1.9.0)
- ✅ 1inch aggregator integration — alternative DEX aggregator option (v1.9.0)
- ✅ Telegram `/chain` command — position chain history with per-link exec cost (v1.9.0)
- ✅ Execution cost in health score — <0.5% bonus, >2% penalty, >5% severe penalty (v1.9.0)
- ✅ Multi-chain single-process architecture — PulseChain, Ethereum, Base, Arbitrum (v2.0.0)
- ✅ Multi-DEX support — 9mm V3, Uniswap V3, PancakeSwap V3 per chain (v2.0.0)
- ✅ Per-position `chain_id` and `dex` fields for cross-chain position management (v2.0.0)
- ✅ Multi-chain wallet holdings — dashboard shows ERC-20 balances across all configured chains (v2.0.0)
- ✅ Per-chain DexScreener price lookups with chain-slug-scoped cache (v2.0.0)
- ✅ Chain registry with 4 chains, contract addresses, fee tiers, tokens, aggregators (v2.0.0)
- ✅ Info page — dashboard page showing supported networks, DEXes, strategies, commands (v2.0.0)
- ✅ Strategy rename — center/bullish/bearish/lazy_up/lazy_down with percentage presets (v2.2.0)
- ✅ Percentage display — width/trigger shown as ticks + percentage in Telegram, dashboard, and API (v2.2.0)
- ✅ Percentage config input — `/config width_percentage=5` and `/new` accept `%` input (v2.2.0)
- ✅ RPC URL redaction in all log output (v2.0.0)
- ✅ Per-chain analytics storage directories and recovery state files (v2.0.0)
- ✅ Composite state keys (`chainId-tokenId`) for all rebalancer Maps/Sets (v2.0.0)
- ✅ Aerodrome CL gauge staking — auto-unstake/restake workflow (v2.4.0)
- ✅ Algebra V3 (Shadow V3) support on Sonic chain (v2.4.0)
- ✅ Daily earnings endpoint + chart (v2.3.0)
- ✅ Analytics summary background-refresh cache (v2.3.0)
- ✅ Safe mode self-heal — ownership failures no longer enter safe mode, bot retries next cycle (v2.5.0)
- ✅ Startup ownership validation — verifyOwnership() called per-position at boot, bad token IDs logged immediately (v2.5.0)
- ✅ Stale recovery state auto-delete — when validation fails and ownerOf() returns CALL_EXCEPTION, file deleted automatically (v2.5.0)
- ✅ `/enable [tokenId]` clears safe mode — scoped to one position or all; warns if recovery state file present (v2.5.0)
- ✅ `/removestale` clears safe mode for removed positions (v2.5.0)
- ✅ Exported safe mode control: `clearSafeMode()`, `isSafeMode()`, `getSafeModePositions()` from rebalancer.ts (v2.5.0)
- ✅ Dashboard bot state visibility — safe mode, kill switch, rebalance lock badges + controls (v2.6.0)
- ✅ Emergency Stop / Enable buttons on dashboard (v2.6.0)
- ✅ TWAP deviation formula fixed — price-relative instead of tick-relative (v2.7.0)
- ✅ Unit test suite — Vitest 4.0.18, 79 tests across math/pool/rebalancer/costBenefit (v2.7.0)
- ✅ Cost-benefit gate — opt-in pre-rebalance fee/gas ratio check (v2.7.0)
- ✅ TWAP cardinality startup check + `/fixtwap` Telegram command (v2.7.0)
- ✅ Dashboard `/collect` concurrency lock — prevents nonce races (v2.7.0)
- ✅ Startup resilience — per-chain try/catch prevents single-chain RPC failure from crashing bot (v2.7.1)
- ✅ Auto-disable burned/unowned positions after 5 consecutive ownership failures (v2.7.1)
- ✅ Approve gas limit bumped to 100k for proxy tokens like USDC on Ethereum (v2.7.1)
- ✅ Approve retry with fresh nonce on on-chain revert or nonce collision (v2.7.1)
- ✅ Pre-rebalance nonce reset to prevent stale nonces after crash loops (v2.7.1)
- ✅ Trust proxy for Caddy reverse proxy — correct client IP in rate limiter (v2.7.1)
- ✅ Doc A V1 Data Capture Specification — complete analytics overhaul (v2.8.0)
- ✅ Price history subsystem — rolling 30-day per-pool JSONL store with sigma_7d/sigma_30d (v2.8.0)
- ✅ Profitability floor — `min_pl_rate = sigma30d^2 / 8`, viability flag, effective APR (v2.8.0)
- ✅ Structured trigger events — every monitoring cycle emits typed event (hold, price_exit, near_edge, etc.) (v2.8.0)
- ✅ Strategy rule set snapshots — versioned parameter snapshots on config change (v2.8.0)
- ✅ Retrospective outcome backfill — fees_earned_1d/3d/7d, actualDaysToRecovery, recoveredBeforeNextRebalance (v2.8.0)
- ✅ Price backfill queue — in-memory multi-source resolver (DexScreener, CoinGecko, TWAP fallback) (v2.8.0)
- ✅ Test suite expanded to 349 tests across 13 files (v2.8.0)

---

## 📋 Pending Tasks

### High Priority

1. **Multi-Wallet Support**
   - How to safely add additional wallets/private keys?
   - Manage multiple wallets with separate positions and strategies

2. **Automated Strategy Flows (Fee Compounding / Profit Taking)**
   - When claiming fees: convert to X token, send to X address, or add to XY pool
   - Automate profit-taking to stablecoins (e.g., collect fees → swap to USDC)
   - Automate fee compounding into lower-risk pools (e.g., USDC/ETH) to preserve value while gaining yield
   - Configurable per-position fee routing rules

### Medium Priority

1. ~~**Uniswap / Ethereum Compatibility**~~ — Done (v2.0.0)

2. ~~**Sonic / Shadow.so Compatibility**~~ — Done (v2.4.0)

3. ~~**Aerodrome CL Gauge Staking**~~ — Done (v2.4.0, not yet deployed)
   - Auto-unstake before rebalance, re-stake after mint
   - Config: `gauge_address` on position entries (aerodrome-cl/aerodrome-cl-gc only)
   - Security: gauge.voter() validation, per-token ERC-721 approve
   - Recovery: gauge_address persisted in recovery state, re-staked after recovery mint
   - Frontend: Gauge badge on PositionCard, Gauge Staking info on PositionDetail
   - Telegram: /status, /config, /new, /scan gauge support

4. **Discord Notifications**
   - Add Discord webhook URL to config.yaml
   - Test notifications

### Low Priority

1. ~~**Testing**~~ — Partially done (v2.8.0)
   - ✅ Unit test suite: 349 tests across 13 files covering math, pool, rebalancer, cost-benefit, metrics, healthScore, volatility, priceHistory, retrospective (Vitest)
   - Expand test coverage: RPC fallback switching, end-to-end rebalance simulation
   - Simulate various market conditions

---

## 🔄 Recent Changes

### 2026-03-06 - v2.8.0 Doc A V1 Data Capture Specification (Deployed)

Complete implementation of Doc A analytics spec — the largest analytics upgrade since v1.1.0:

- **Price history subsystem**: `src/analytics/priceHistory.ts` — rolling 30-day per-pool JSONL store. Computes annualized log-return volatility (`sigma_7d`, `sigma_30d`) with confidence scoring. Enables profitability floor analysis: `min_pl_rate = sigma30d^2 / 8`.
- **Structured trigger events**: Every monitoring cycle now emits a `TriggerEvent` record (`price_exit`, `hold`, `near_edge_warning`, `volatility_regime_shift`, `manual_override`, `cooldown_active`, `cost_benefit_skip`, `critical_distance`). Hold decisions are no longer invisible — queryable via `queryTriggerEvents()`.
- **Strategy rule set snapshots**: Config changes via Telegram `/config` or `reloadPositions()` emit versioned `StrategyRuleSetSnapshot` records. Full parameter history is now preserved.
- **Retrospective outcome backfill**: Background job (6h interval) revisits past rebalances and backfills `feesEarned1dUsd`, `feesEarned3dUsd`, `feesEarned7dUsd`, `actualDaysToRecovery`, `recoveredBeforeNextRebalance`, `nextRebalanceId`. First run on VPS updated 6 rebalance records (3 PulseChain + 3 Base).
- **Price backfill queue**: `src/analytics/backfill.ts` — in-memory queue with multi-source price resolver (DexScreener → CoinGecko → TWAP). Retries every 5 minutes.
- **52 new tests**: `priceHistory.test.ts` (28), `retrospective.test.ts` (24). Total: 349 tests across 13 files.

### 2026-03-02 - v2.7.1 Startup Resilience, Auto-Disable & Approve Gas Fix (Deployed)

- **Startup crash loop fix**: ETH RPC 429/403 errors caused 17 bot restarts in 4 minutes. Per-chain startup now wrapped in try/catch — degraded chains retry each monitoring cycle.
- **Auto-disable**: Burned/unowned positions silenced after 5 consecutive ownership failures. No further RPC calls. One-time Telegram notification. Cleared via `/removestale` or `/enable`.
- **USDC approve gas fix**: `GAS_LIMITS.APPROVE` bumped from 50k to 100k — USDC proxy contract on Ethereum needs ~55-65k gas for `approve()`.
- **Approve retry**: On-chain revert (status=0) and nonce collisions trigger one retry with fresh nonce. Zero-first approval failure is non-fatal.
- **Pre-rebalance nonce reset**: `resetNonce()` called before first on-chain tx in rebalance flow — prevents stale nonces after crash-loop restarts.
- **Trust proxy**: `app.set('trust proxy', 1)` added for Caddy — fixes `ERR_ERL_UNEXPECTED_X_FORWARDED_FOR` warning and correct rate limiter IP resolution.
- **Incident**: Position #1213623 (USDC/WETH, Ethereum) burned during failed rebalance on Mar 1. ~$109 USDC + trace WETH stranded. Auto-disabled after deployment. Recovery pending (approve gas fix now deployed).

### 2026-03-01 - v2.7.0 TWAP Formula Fix, Test Suite & Cost-Benefit Gate (Deployed)

- **TWAP formula fix**: Old formula `(tickDiff / |twapTick|) * 10_000` was mathematically broken at extreme ticks. New formula `|1.0001^tickDiff - 1| * 10_000` is stable across all tick ranges.
- **Unit test suite**: Vitest 4.0.18 with 79 tests covering BigInt V3 math, TWAP formula, error classification, cost-benefit logic. Run: `npx vitest run`
- **Cost-benefit gate**: Optional per-position feature to skip rebalances when fees don't justify gas. Config: `cost_benefit_enabled: true`, `min_fee_to_cost_ratio: 1.5`. Defaults to disabled.
- **TWAP cardinality check**: Startup warning + Telegram notification if pool cardinality < 50. New `/fixtwap` command increases cardinality on-chain.
- **`/collect` lock**: Dashboard fee collection now acquires rebalance lock to prevent nonce race conditions from concurrent requests.

### 2026-03-01 - v2.6.0 Bot State Visibility & Dashboard Controls (Deployed)

- Dashboard shows real-time bot state per position: safe mode (red), kill switch (orange), rebalance lock (blue) badges
- Emergency Stop / Enable buttons on dashboard
- "Clear Safe Mode" button on position detail page
- New API endpoints: `POST /api/bot/enable`, `/disable`, `/positions/:tokenId/clear-safe-mode`
- Telegram `/status` shows safe mode and kill switch status

### 2026-02-28 - v2.2.1 Configuration Audit & Address Fixes

**Critical address fixes:**
- Fixed Uniswap V3 Factory address in `ethereum.ts` and `arbitrum.ts`: `0x...F765` → `0x...F984` (last 3 hex chars wrong)
- Fixed Uniswap V3 NPM address in `ethereum.ts` and `arbitrum.ts`: `0x...6c7e91A0` → `0x...Ab11FE88` (last 16 chars wrong)
- Fixed duplicate function selector in `constants.ts`: `LIQUIDITY` had `0x128acb08` (same as SWAP), corrected to `0x1a686502`

**Position ID fixes (VPS config.yaml only):**
- Removed position #440661 — not owned by wallet (`0x83300ed0...`), replaced with #2440661
- Fixed position #213623 → #1213623 — digit transposition (Ethereum USDC/WETH)

**Documentation:**
- Expanded `CONSTITUTIONAL_TRUTHS.md` from 7 to 12 sections — added Aerodrome CL immutable facts (sections 8-11) and canonical Uniswap V3 multi-chain addresses (section 12)
- Added Layer G (Contract Address & Position ID Integrity) to regression guard pre-deployment checklist
- Added high-risk item #10 (Hardcoded Contract Addresses) to code map
- Filled post-mortem template with audit findings

### 2026-02-28 - v2.2.0 Strategy Rename & Percentage Display

- **Strategy rename**: `pulse` → `center`, `snuggle_up` → `bullish`, `snuggle_down` → `bearish`, `lazy_ascending` → `lazy_up`, `lazy_descending` → `lazy_down` (old names still valid)
- **Preset suffix rename**: `pulse_300` → `center_3pct`, `pulse_600` → `center_6pct`, etc.
- **Percentage display**: Width and trigger shown as `300 ticks (~3.0%)` in Telegram `/status`, `/config`, dashboard position detail, and positions table
- **Percentage config input**: Telegram `/config width_percentage=5` and `/new` flow accept `5%` input, auto-converted to ticks
- **API percentage fields**: `width_percentage` and `trigger_percentage` computed fields in GET responses
- **Auto-widen `_Npct` names**: `computeAutoWiden()` generates `center_12pct` instead of `center_1194`
- **`isValidStrategy()` function**: Replaces hardcoded `VALID_STRATEGIES` arrays with dynamic validation
- **`PRESET_WIDTH_REGEX`**: Shared regex eliminates 7 duplicated patterns across codebase

### 2026-02-27 - v2.0.0 Multi-Chain & Multi-DEX

**Multi-chain single-process architecture:**
- Manage positions across PulseChain (369), Ethereum (1), Base (8453), Arbitrum One (42161) from one config, one process, one Telegram bot, one dashboard
- `MultiChainContext` central resolver: per-position chain + contracts resolution via `chain_id` field
- Per-chain isolation: separate wallet, provider, NonceTracker, ContractRegistry per chain
- Backward compatible: existing single-chain `config.yaml` (no `chains:` block) works unchanged

**Multi-DEX support:**
- Chain registry (`src/config/chains.ts`) with 4 chains, V3 contract addresses, fee tier mappings, token lists, aggregator configs
- Per-chain config files: `src/config/ethereum.ts`, `src/config/base.ts`, `src/config/arbitrum.ts`
- Arbitrum supports both Uniswap V3 (default) and PancakeSwap V3 via `dex` field
- `ContractRegistry` with `getForDex()` per-DEX contract resolution

**Dashboard:**
- Multi-chain wallet holdings — ERC-20 balances queried across all configured chains
- Per-chain DexScreener price lookups with chain-slug-scoped cache
- Chain column in wallet holdings table
- Info page showing supported networks, DEXes, fee tiers, strategies, Telegram commands
- Per-chain native balance display

**Rebalancer state:**
- Composite keys (`chainId-tokenId`) for all state Maps/Sets
- Per-chain lock files (`.rebalance-lock-{chainId}-{tokenId}`)
- Per-chain recovery state files (`.recovery-state-{chainId}.json`)
- Per-chain analytics storage directories (`analytics/chain-{chainId}/`)

**Safety & security:**
- RPC URL redaction in all log output (hostname only)
- `reloadPositions()` validation parity with `loadConfig()` (chain_id, strategy, width_ticks, duplicates)
- Generic RPC env vars (`RPC_URL_PRIMARY`) scoped to default chain only
- Recovery state `chainId` field validation
- All dashboard/Telegram routes resolve per-position chain for on-chain calls

### 2026-02-26 - v1.9.0 Analytics Deep Dive & Execution Cost Tracking

**Dashboard Enhancements:**
- Position cards now show unclaimed fees (USD), position age, and rebalance count
- Dashboard overview displays wallet token holdings with USD values
- Position detail page links to chain visualization

**Rebalance Execution Cost Tracking:**
- New `calculateRebalanceCost()` in `src/analytics/metrics.ts` — computes `preValue - postValue - gasCost` at a single reference price (post-rebalance tick) to isolate from IL
- Two new fields on `RebalanceMetrics`: `rebalanceCostPercent` and `rebalanceCostToken0`
- Displayed in: analytics table ("Exec Cost" column), chain link cards, Telegram `/chain` per-link, health score input
- "Execution Costs" MetricCard added to P&L summary on PositionAnalytics page

**New Analytics Modules:**
- `src/analytics/volatility.ts` — tick volatility, standard deviation, annualized volatility from snapshot history
- `src/analytics/healthScore.ts` — component-based health scoring (0-100) with weighted factors (P&L, fees, time-in-range, distance, execution cost)
- `src/analytics/chain.ts` — position chain builder (root→current lineage) with per-link metrics and aggregates
- `src/analytics/export.ts` — CSV/JSON export of per-rebalance and per-snapshot analytics
- `src/costBenefit.ts` — break-even analysis, rebalance profitability evaluation

**New Frontend Pages:**
- `PositionChain.tsx` — timeline visualization of rebalance chain with aggregate lifetime summary

**Proactive Notifications:**
- `src/notifications/proactive.ts` — scheduled Telegram alerts for health degradation, prolonged out-of-range, fee milestones

**Other:**
- 1inch aggregator integration (`src/aggregators/oneinch.ts`) — alternative to Piteas
- Slippage values clamped to 500 bps max across all reads (API, chain, export)
- Telegram `/chain` command shows per-link exec cost
- Health score now includes `avgRebalanceCostPercent` component

### 2026-02-23 - v1.8.0 Rebalance Now Feature + Security Audit Fixes

**Rebalance Now (frontend + Telegram):**
- Added "Rebalance Now" button to position detail page — shows preview modal (value, fees, current→new range, estimated swap) before a two-step confirmation executes the full rebalance end-to-end
- New API: `GET /api/positions/:id/rebalance-preview` — evaluates strategy, computes new range, estimates swap USD, returns preview JSON
- New API: `POST /api/positions/:id/rebalance` — force-executes rebalance; navigates frontend to new token ID on success
- Telegram `/rebalance` preview enhanced to show new range ticks + prices and estimated swap amount

**Security audit fixes (6 findings):**
- **CRITICAL**: `src/aggregators/piteas.ts` — validate `swapData.to === PITEAS_ROUTER_ADDRESS` before `sendTransaction`; throw if mismatch. A compromised Piteas API could have redirected funds to any address.
- **HIGH**: `src/aggregators/piteas.ts` — validate `swapData.value === 0n` for ERC-20 swaps; always send `value: 0n` explicitly. Non-zero API value would drain native PLS.
- **HIGH**: `src/rebalancer.ts` + `src/server/routes/positions.ts` — cross-process lock files (`.rebalance-lock-{tokenId}`). Dashboard `/collect` and `/rebalance` return 409 if bot has active rebalance. Bot and dashboard are separate PM2 processes with independent NonceTrackers — concurrent on-chain txs would race on nonces.
- **MODERATE**: `src/recovery.ts` — `validateRecoveryState()` checks all fields (types, hex format, TOKENS whitelist). Tampered `.recovery-state.json` could previously direct the bot to interact with malicious ERC-20 contracts.
- **LOW**: `src/configLoader.ts` — `slippage_tolerance_bps` validated to 1–9999 at startup.
- **LOW**: `src/swap.ts` — `calculateAmountOutMinimum` floored at `0n`.
- **CHORE**: `config.yaml` removed from git tracking — was leaking Telegram bot token and webhook URLs into git history.

### 2026-02-23 - v1.7.0 Five Critical Rebalance Bug Fixes

After 13 days of failure analysis (Feb 10–23), identified and fixed 5 bugs that prevented any rebalance from completing successfully:

- **Mint slippage fix**: `amount0Min`/`amount1Min` now computed from `getLiquidityForAmounts()` + `getAmountsForLiquidity()` (what the pool will actually accept), not from raw wallet balance (which included stranded funds from prior failures).
- **Nonce tracker fix**: Added `lastConfirmedNonce` field, 2-second delay in `resetNonce()`, and `max(chainNonce, lastConfirmedNonce + 1)` floor. Prevents `NONCE_EXPIRED` after RPC provider rotation.
- **WPLS auto-wrap fix**: Created `abis/WETH9.json` with `deposit()` payable, added `getWPLS()` to `contracts.ts`. Both rebalancer and recovery now use proper WETH9 ABI for native PLS wrapping.
- **TWAP adaptive window**: `isTwapSafe()` retries with 300→60→10s windows on "OLD" revert. HEX/WPLS pool has `observationCardinality=1`.
- **Swap event parsing fix**: Resolved pool address from `factory.getPool(tokenIn, tokenOut, fee)` instead of incorrectly using `getPool(tokenIn)` (ERC20 address).
- **VPS config cleanup**: Removed dead positions (155778, 155781), added auto-recovered position 155876.
- **Incident**: Positions 155778, 155781, 155806 all stuck in safe mode. 155876 created by recovery. All resolved after deploying v1.7.0.

### 2026-02-17 - v1.6.2 Critical Math Fix & Recovery Swap Step

- **Q192 swap bug fixed**: `calculateSwapAmount()` token0 branch had a spurious `* Q192` multiplier inflating results by ~10^58. Every token0-sell rebalance swapped 100% instead of ~49%, causing mint failures. Removed the extra multiplier; token1 branch was already correct.
- **Recovery swap step added**: `recoverStrandedFunds()` now swaps to correct token ratio before minting, mirroring normal rebalance steps 4-5. Previously it passed raw wallet balances to mint, which failed when only one token was available.
- **Pre-mint sanity check**: Clear error message when tick is in-range but a token balance is 0, instead of opaque CALL_EXCEPTION.
- **Swap safety enhancements**: Price impact limit (5%), post-swap balanceOf fallback, post-swap zero-output check.
- **Incident**: 4 consecutive rebalance failures (Feb 10-17: #155345, #155361, #155367, #155608) all caused by Q192 bug. Recovery of ~90,380 WPLS stranded from #155608 succeeded after both fixes deployed.

### 2026-02-11 - v1.6.0 Rebalance RPC Resilience & Confirmation Delay

- **Transient RPC error handling**: Rebalance failures from 504/timeout/connection errors no longer trigger safe mode (when no recovery state exists). Bot retries on next monitoring cycle instead.
- **Retry cap**: Max 5 consecutive transient failures before entering safe mode (prevents infinite retry loops draining gas).
- **Dynamic contract providers**: Contract instances now use getters that resolve to current provider after RPC rotation. Previously, contract instances held stale references to the original provider.
- **Confirmation delay**: New `confirm_minutes` parameter — position must remain out of range for N minutes before rebalancing. Prevents reacting to transient price spikes.
- **Increased trigger distance**: `trigger_distance_ticks` changed from 10 to 50 for all positions.
- **Polling interval**: Increased from 30s to 60s to reduce RPC load.
- **Incident**: Both positions (#155361, #155367) entered safe mode on Feb 11 due to PulseChain RPC 504 Gateway Timeouts. Positions were verified in range and healthy on-chain. Safe mode cleared and bot restarted after deploying fixes.

### 2026-02-10 - v1.5.1 Dashboard UX Improvements

- **Rebalance cost estimates**: Position detail shows swap amount, slippage, gas, total cost, break-even at each range edge with hover tooltips
- **Position card metrics**: Dashboard cards now show USD value and lifetime APR
- **Navbar refresh button**: Re-fetches all data on current page without full page reload
- **Session persistence**: JWT stored in localStorage — page refresh no longer logs out the user
- **JWT expiry**: Extended from 1 hour to 24 hours
- **Configurable snuggle ratios**: `lower_ratio_percent` for snuggle strategies, adjustable via Telegram `/config`
- **Swap estimation fix**: Fixed $0.00 swap amounts by computing target ratio for the NEW range (not same range)

### 2026-02-10 - v1.5.0 DEX Aggregator Integration

- **Piteas Aggregator**: Routes rebalance swaps through DEX aggregator for better execution
  - Default swap provider changed from `"direct"` to `"piteas"`
  - Multi-DEX routing across PulseX V1/V2/V3, 9inch, etc.
  - 5-15% better execution on thin-liquidity pairs
  - Config option: `swap_provider: "direct"` to opt out
- **Width Preset Strategies**: pulse_300, pulse_600, snuggle_up_300, etc.
  - Built-in width presets for easier configuration
  - No need to specify `width_ticks` when using preset strategies
- **Wallet Key Rotation**: Migrated from `.env` to `.secret` file
- **Position Update**: Replaced #155350/#155351 with #155361 (HEX/WPLS, pulse_300)

### 2026-02-10 - v1.4.0 Analytics Dashboard + Recovery UI

- **Analytics Dashboard**: Full per-position analytics with P&L, charts, health scores
  - Cumulative fee chart, IL tracking chart, fee collection history
  - Rebalance cost breakdown with gas, slippage, net ROI
  - Position health assessment (0-100 score)
  - Portfolio summary on main dashboard
- **Dashboard Recovery Alerts**: Stranded funds now surfaced in web UI
  - Yellow warning banner on dashboard when recovery state file exists
  - "Dismiss" button to clear stale recovery alerts without SSH
  - "Recover" button to mint new position from stranded funds (with confirmation dialog)
  - API: GET /api/recovery/status, POST /api/recovery/dismiss, POST /api/recovery/recover
- **TLS Support**: Caddy reverse proxy with self-signed TLS for bare IP
- **Stranded Funds Recovery**: Automated detection + Telegram `/recover` command
- **Security Audit**: All 21 findings remediated

### 2026-02-10 - v1.3.1 Safe Mode RPC Resilience

- Fixed ownership verification to handle RPC failures gracefully
- Positions no longer enter safe mode due to temporary RPC timeouts
- Only true ownership failures (invalid token, wrong owner) trigger safe mode
- RPC errors now trigger retry via existing `chain.withRetry()` mechanism
- Added detailed error logging for ownership verification failures
- **Impact**: Resolved safe mode lock on positions #155284 and #155290

### 2026-02-10 - v1.3.0 Web Dashboard

- Added Express API server with JWT authentication, rate limiting, and helmet security
- Added React + Vite + Tailwind CSS frontend (dark theme SPA)
- Fixed unclaimed fees: now uses `collect.staticCall()` for true accrued fees instead of stale `tokensOwed`
- Added live USD prices from DexScreener API (5-minute cache)
- Added rebalance history page (`/history`) with expandable cards showing ranges, fees, swap details, metrics, PulseScan tx links
- Added manual fee collection button with confirmation dialog
- Added PM2 process `9mm-dashboard` on port 3100
- Dashboard accessible at `http://143.110.130.198:3100`
- Hardened VPS: switched from root to `tyler` user, project moved to `/opt/9mm-rebalancer`
- Set up GitHub PAT on VPS for `git pull` authentication

### 2026-02-09 - v1.2.0 Telegram Commands

- Added two-way Telegram command handler (`src/telegramCommands.ts`)
- Commands: `/status`, `/report`, `/balance`, `/position`, `/enable`, `/disable`, `/help`
- Emergency stop via `/disable` — disables rebalancing without stopping the bot
- Switched to `@ALM_9mm_PersonalBot` bot (resolved 401 polling errors)
- Set `telegram_chat_id` to numeric `5874802252` (user `T_B_DeFi`)
- Added `npm run getchatid` helper for chat ID discovery
- Fixed `.gitignore` pattern: `analytics/` → `/analytics/` (root-level only)
- Added PM2 convenience scripts to `package.json`

### 2026-02-09 - v1.1.0 Analytics Release

- Added performance analytics engine (`src/analytics/`)
- Added CLI dashboard (`npm run analytics summary|status|history`)
- Added per-step gas tracking from transaction receipts
- Metrics: Fee APR, Impermanent Loss, Net ROI, Capital Efficiency, Time-in-Range
- JSON Lines storage with daily rotation (~2-5 MB/month per position)
- Non-blocking design — analytics failures never crash the bot

### 2026-02-09 - v1.0.0 Initial Deployment

- Deployed application to DigitalOcean VPS
- Configured PM2 process manager
- Set up auto-restart and log rotation
- Created operational documentation
- Monitoring position #155284 in production mode

---

## 📊 Performance Metrics

### Resource Usage
- **CPU**: < 1% (idle during monitoring)
- **Memory**: 85 MB (stable)
- **Disk**: 4.7 GB / 67 GB (7% used)
- **Network**: Minimal (RPC calls every 60s)

### Reliability
- **Uptime**: Bot running continuously (PM2 auto-restarts on crash)
- **Restarts**: 177 (accumulated over Feb 10–23 failure cascade + manual restarts)
- **v1.7.0 Status**: Clean startup, no errors, monitoring 2 positions

---

## 🔐 Security Status

✅ **Private Key**: Stored in `.secret` with 600 permissions (rotated 2026-02-10)
✅ **Root Login**: Disabled — SSH as `tyler` only
✅ **Dashboard Auth**: JWT-based with password + rate-limited login (5 attempts/min)
✅ **Repository**: Can be made private (currently public for deployment)
✅ **Log Rotation**: Automatic (prevents disk fill)
✅ **Process Isolation**: Separate from other VPS services
✅ **Firewall**: SSH (22) + HTTPS (443) open
✅ **TLS**: Caddy reverse proxy with self-signed certificate (bare IP)
✅ **Security Audit**: 27/27 findings remediated (v1.8.0 — 6 new findings fixed)
✅ **Recovery**: Stranded funds detection on startup + `/recover` Telegram command + dashboard dismiss/recover UI

---

## 📞 Quick Access

### SSH Access
```bash
ssh tyler@143.110.130.198
cd /opt/9mm-rebalancer
```

### Web Dashboard
```
URL:      https://143.110.130.198
Password: (set in .env as DASHBOARD_PASSWORD)
```

### Common Commands

```bash
# Check status
pm2 list
pm2 show 9mm-rebalancer
pm2 show 9mm-dashboard
pm2 logs 9mm-rebalancer
pm2 logs 9mm-dashboard

# Restart
pm2 restart 9mm-rebalancer
pm2 restart 9mm-dashboard

# View logs
tail -f /opt/9mm-rebalancer/logs/rebalancer.log

# Analytics (v1.1.0)
cd /opt/9mm-rebalancer
npm run analytics summary
npm run analytics status 155284
npm run analytics history 155284

# Deploy update (from VPS)
cd /opt/9mm-rebalancer
git pull origin main
npm install
npx tsc
cd src/web && npm install && npm run build && cd ../..
pm2 restart 9mm-rebalancer && pm2 restart 9mm-dashboard
```

### Telegram Commands (v2.1.0)

Send to `@ALM_9mm_PersonalBot` in Telegram:

- `/status` — Position status (in/out of range, tick, liquidity)
- `/balance` — Wallet assets & values across all chains
- `/chain` — Position rebalance chain lineage
- `/link` — Manually link two positions in a chain
- `/scan` — Scan wallet for unconfigured positions across all chains (v2.1.0)
- `/new` — Add position to monitoring (guided flow)
- `/config` — View/update strategy parameters
- `/collect` — Collect unclaimed fees
- `/remove` — Remove liquidity (partial or full)
- `/rebalance` — Force manual rebalance
- `/enable` / `/disable` — Toggle auto-rebalancing
- `/recover` — Detect & recover stranded funds
- `/removestale` — Remove burned/invalid positions from config
- `/cancel` — Cancel active flow
- `/help` — Show all commands

### Documentation
- [DEPLOY_MANUAL.md](./DEPLOY_MANUAL.md) - Manual deployment guide
- [OPERATIONS.md](./OPERATIONS.md) - Operations guide (on VPS)
- [README.md](./README.md) - Project overview
- [ARCHITECTURE.md](./ARCHITECTURE.md) - System architecture

---

## 📈 Next Milestones

1. ~~**Week 1**: Confirm position liquidity, enable production mode~~ — Done
2. ~~**Week 1**: Web dashboard with live monitoring~~ — Done (v1.3.0)
3. ~~**Week 2**: Monitor rebalances, tune parameters, add HTTPS~~ — Done (v1.4.0, TLS via Caddy)
4. **Month 1**: Evaluate strategy performance, optimize settings
5. **Quarter 1**: Backtesting framework

---

## 🆘 Support

### Issue Resolution
1. Check logs: `pm2 logs 9mm-rebalancer --lines 100`
2. Run health check: `~/check-9mm-health.sh`
3. Review this status file for known issues
4. Check [TROUBLESHOOTING.md](./TROUBLESHOOTING.md)

### Contact
- Project Owner: Tyler (GitHub: TylerB007)
- Repository: https://github.com/TylerB007/ALM-For-9MM-Pulsechain

---

**Note**: This file is manually maintained. Update after significant changes.

# Changelog

All notable changes to the 9mm V3 LP Auto-Rebalancer will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [Unreleased]

### Added

- **Shadow/Sonic legacy NPM scan** (`src/positionDiscovery.ts`): `/scan` command now queries both Shadow V3 NPM deployments on Sonic — the current NPM (`0x12E66C8F`) and the legacy NPM (`0xA57FA38b`). Positions on the legacy contract are labelled `Shadow V3 (legacy NPM)` in the scan output. Extracted inner enumeration logic into `scanNpmContract()` helper to avoid code duplication.
- **OOR duration display** (`src/rebalancer.ts`, `src/server/routes/dashboard.ts`): Bot writes `.oor-since-{chainId}-{tokenId}` files when positions go out of range (following existing cross-process file pattern for lock/safe-mode state). Dashboard reads these files and includes `outOfRangeSinceMs` in the position list response. Position cards and table rows now show elapsed OOR time (e.g., "3.2h OOR") next to the status badge when a position is out of range.
- **Price-first range display** (`src/web/src/components/RangeBar.tsx`): Prices are now the primary text in the range bar labels with ticks rendered as small muted secondary text below. Added `invert?: boolean` prop to display `1/price` (flipped pair direction) across all three labels.
- **Pair direction flip icon** (`src/web/src/components/PositionCard.tsx`, `PositionsTable.tsx`, `RangeMiniBar.tsx`): A small ⇅ icon next to the pair name allows toggling between e.g. `WBTC/WETH` and `WETH/WBTC`. All prices and range labels invert accordingly. State is per-card/per-row and resets on page refresh.
- **OOR-first position sorting** (`src/web/src/pages/Dashboard.tsx`, `PositionsTable.tsx`): Out-of-range positions always appear at the top of both card and table views. The `sortPositions()` function in `PositionsTable.tsx` now uses OOR-first as a primary sort, with user-selected column sorts applying within each group.
- **Chain token logos** (`src/web/src/components/ChainLogo.tsx`): New component replacing the old text-only chain badges. Loads chain logo images from Trust Wallet CDN (Ethereum, Base, Arbitrum One) and CoinGecko (PulseChain, Sonic) with automatic text-label fallback on image error. Removes duplicated `CHAIN_BADGES` constants from `PositionCard.tsx` and `PositionsTable.tsx`.
- **Space Grotesk numerical font** (`src/web/src/index.css`, `tailwind.config.js`): Replaced IBM Plex Mono with Space Grotesk for the `.text-data` class used on all financial data values (prices, fees, APR, tick values). Added `font-display` family alias in Tailwind config.

### Fixed

- **Shadow V3 (Sonic) mint ABI — root cause of all `#1143929` mint failures** (`abis/AlgebraV3NonfungiblePositionManager.json`, `src/rebalancer.ts`): `AlgebraV3NonfungiblePositionManager.json` incorrectly included `sqrtPriceX96` as a 12th field in `MintParams`, generating selector `0xb5007d1f`. Shadow V3's actual `mint()` is an 11-field struct (no `sqrtPriceX96`) with selector `0x6d70c415`. Every mint attempt dispatched to a nonexistent function; Sonic RPC returns null revert data, which masked the error entirely. Fixed by removing `sqrtPriceX96` from the ABI and splitting `mintPosition()` into three branches — `aerodrome-cl` (12-field, `sqrtPriceX96: 0n`), `algebra-v3` (11-field, no `sqrtPriceX96`), and standard Uniswap/PancakeSwap. Recovery of stranded USDC/WETH from position `#1143929` succeeded on first attempt after fix — new position `#1144737` minted.

### Changed

- **`CONSTITUTIONAL_TRUTHS.md §10`**: Updated Shadow.so architecture description from "Aerodrome CL fork" to "Ramses V3 Core fork with Algebra V3-style NPM". Corrected NPM address from legacy `0xA57FA38b` to current `0x12E66C8F` (verified on-chain via `ownerOf(1141460)`). Added legacy address, dynamic fee note, and `swapRouterType` clarification. Added mint ABI selector facts (`0x6d70c415` vs `0xb5007d1f`) and corrected pool proxy pattern (CREATE2 via deployer `0x8BBDc15`, not EIP-1167).
- **`src/config/sonic.ts`** header comment: Updated to accurately describe Shadow as Ramses V3 Core with Algebra V3-style NPM. Updated source URLs to official docs and GitHub.
- **Combined silent low-gas alert** (`src/notifications/proactive.ts`): Replaced per-chain `checkLowGasBalance()` with `checkAllLowGasBalances()`. All chains are checked in parallel; any chains below threshold are bundled into a single combined Telegram message (max once per 24 hours globally, down from one message per chain per day). Alert is sent as a silent notification (no ping/vibration) via Telegram's `disable_notification` flag.
- **Silent notification support** (`src/notifications.ts`): Added optional `silent?: boolean` parameter to `sendNotification()` and `sendTelegram()`. When `true`, passes `disable_notification: true` in the Telegram API payload. Discord path is unaffected.
- **`src/index.ts`**: Replaced per-chain gas check loop with single `checkAllLowGasBalances(chainContexts, config)` call.

### Documentation

- **`memory/sonic-fee-investigation.md`**: Added Shadow Architecture Research section documenting the Ramses V3 Core confirmation, dynamic fees (FeeShare™), two-NPM-deployment history, and what was incorrect in the previous Constitutional Truths entry.
- **`memory/MEMORY.md`**: Updated Algebra V3 / Shadow V3 section to reference confirmed Ramses V3 Core architecture, legacy NPM address, and dynamic fee caveat.

---

## [2.8.0] - 2026-03-06

### Doc A V1 Data Capture Specification Implementation

Complete implementation of the Doc A V1 Data Capture Specification, adding annualized volatility, profitability floor analysis, structured trigger events, versioned strategy rule sets, and retrospective outcome backfill — the most analytically significant analytics upgrade since v1.1.0.

### Added

- **Price history subsystem** (`src/analytics/priceHistory.ts`): Rolling 30-day per-pool JSONL price store with atomic pruning. Records pool price ratios, USD prices per token, and source attribution. Computes annualized log-return volatility: `sigma_Nd = std_dev(log_returns) * sqrt(samples_per_year)` for 7-day and 30-day windows with confidence scoring (`high/medium/low/insufficient`).
- **Profitability floor** (`computeViabilityFields()`): `min_pl_rate = sigma30d^2 / 8`, `profitability_margin = pool_fee_rate - min_pl_rate`, `profitability_viable = pool_fee_rate > min_pl_rate`, `effective_apr_pct = pool_fee_rate * (100 / width_pct)`. Answers "is this pool worth providing liquidity to at current volatility?"
- **Structured trigger events** (`TriggerEvent` type + `emitTriggerEvent()` in collector): Every monitoring cycle now emits a typed event (`price_exit`, `hold`, `near_edge_warning`, `volatility_regime_shift`, `manual_override`, `cooldown_active`, `cost_benefit_skip`, `critical_distance`) with full context (sigma, pool fee rate, distance, time-in-range, estimated cost). Hold decisions are no longer invisible — they're structured records queryable via `queryTriggerEvents()` / `queryAllChainTriggerEvents()`.
- **Strategy rule set snapshots** (`StrategyRuleSetSnapshot` type + `emitRuleSetSnapshot()` in collector): When strategy parameters change (via Telegram `/config` or `reloadPositions()`), a full snapshot of all params is persisted with a UUID `ruleSetId`. Queryable via `queryStrategyRuleSets()` / `getLatestRuleSet()` / `queryAllChainStrategyRuleSets()`.
- **Retrospective outcome backfill** (`src/analytics/retrospective.ts`): Background job (6-hour interval) that revisits past rebalances and backfills: `feesEarned1dUsd`, `feesEarned3dUsd`, `feesEarned7dUsd`, `actualDaysToRecovery` (sentinel -1 = never recovered), `recoveredBeforeNextRebalance`, `nextRebalanceId`. Answers "did this rebalance pay for itself?" — the most important question for strategy tuning.
- **Price backfill subsystem** (`src/analytics/backfill.ts`): In-memory queue with resilient multi-source price resolver. When DexScreener is unavailable at event time, prices are queued and retried from DexScreener, CoinGecko, and on-chain TWAP fallback. Background job polls every 5 minutes.
- **Historical price enrichment** (`src/analytics/historicalPrice.ts`): Enriches lifecycle events and rebalance records with USD prices post-hoc. Maintains a pending price queue for events recorded before prices were available.
- **Expanded analytics types**: `TriggerEvent`, `StrategyRuleSetSnapshot`, `PriceHistoryRecord` added to `src/analytics/types.ts`. `AnalyticsRecord.type` union expanded with `'trigger_event'` and `'strategy_rule_set'`.
- **New storage queries**: `queryTriggerEvents()`, `queryAllChainTriggerEvents()`, `queryStrategyRuleSets()`, `getLatestRuleSet()`, `queryAllChainStrategyRuleSets()` in `src/analytics/storage.ts`.
- **New test files** (52 tests): `src/analytics/priceHistory.test.ts` (28 tests — viability fields, sigma formula, buildPriceHistoryRecord), `src/analytics/retrospective.test.ts` (24 tests — window eligibility, recovery scan, linkage matching, sentinel values).
- **Test suite expanded**: 349 tests across 13 files (was 297/11 before Doc A).

### Changed

- `src/index.ts`: Starts retrospective backfill on startup, stops on shutdown (alongside price backfill).
- `src/analytics/storage.ts`: Added `TriggerEvent` and `StrategyRuleSetSnapshot` imports, `dust0`/`dust1` to bigintReviver field set.
- `src/analytics/collector.ts`: Integrated `emitTriggerEvent()` and `emitRuleSetSnapshot()` functions.

---

## [2.7.1] - 2026-03-02

### Startup Resilience, Auto-Disable & Approve Gas Fix

Production hotfix addressing 3 issues discovered during 48-hour operations review: ETH RPC crash loops at startup, burned position spam, and USDC approve out-of-gas on Ethereum.

### Fixed

- **CRITICAL**: Startup crash loop — a single chain's RPC failure (ETH `eth.llamarpc.com` 429/403) killed the entire process. Per-chain startup now wrapped in try/catch; degraded chains retry each monitoring cycle. (`src/index.ts`)
- **HIGH**: USDC approve reverted on Ethereum — `GAS_LIMITS.APPROVE` was 50k but USDC proxy contract needs ~55-65k. Bumped to 100k. (`src/config/constants.ts`)
- **HIGH**: Approve retry with fresh nonce — on-chain reverts (status=0) and nonce collisions now trigger one retry with `resetNonce()`. Zero-first approval failure is non-fatal. (`src/swap.ts`)
- **MODERATE**: Nonce reset before first rebalance tx — prevents stale nonces after crash-loop restarts with orphaned pending txs. (`src/rebalancer.ts`)

### Added

- **Auto-disable for burned/unowned positions**: After 5 consecutive ownership failures, position is silenced (no further RPC calls). One-time Telegram notification. Cleared via `/removestale` or `/enable`. (`src/rebalancer.ts`)
- **`isAutoDisabled(pk)` and `clearAutoDisabled(pk)`** exported from `src/rebalancer.ts`
- **`/enable`** now clears auto-disabled state alongside safe mode (`src/telegramCommands.ts`)
- **`/removestale`** clears auto-disabled state for removed positions (`src/telegramCommands.ts`)
- **`/status`** shows auto-disabled badge when applicable (`src/telegramCommands.ts`)
- **`app.set('trust proxy', 1)`** for Caddy reverse proxy — fixes rate limiter client IP resolution (`src/server/index.ts`)

---

## [2.7.0] - 2026-03-01

### TWAP Formula Fix, Unit Test Suite, Cost-Benefit Gate & Operational Hardening

Critical TWAP deviation formula corrected, comprehensive Vitest test suite added, optional pre-rebalance cost-benefit gate introduced, and several operational safety improvements deployed.

### Fixed

- **CRITICAL**: TWAP deviation formula was mathematically incorrect. Old: `(tickDiff / |twapTick|) * 10_000` (tick-relative — broke at small absolute ticks, under-reported at large ticks). New: `|1.0001^tickDiff - 1| * 10_000` (price-relative — stable across all tick ranges, 1 tick ≈ 1 bps). (`src/pool.ts`)
- **MODERATE**: Dashboard `/collect` endpoint had no concurrency lock — simultaneous requests could race on nonce assignment. Now acquires rebalance lock around the entire fee collection flow; returns 409 if lock already held. (`src/server/routes/positions.ts`)

### Added

- **Unit test suite** (Vitest 4.0.18): 79 tests across 4 files covering BigInt V3 math, TWAP formula, error classification, and cost-benefit logic. Run: `npx vitest run`. (`vitest.config.ts`, `src/math.test.ts`, `src/pool.test.ts`, `src/rebalancer.test.ts`, `src/costBenefit.test.ts`)
- **Cost-benefit gate** (opt-in): Skip rebalances when unclaimed fees don't justify gas cost. Config: `cost_benefit_enabled: true`, `min_fee_to_cost_ratio: 1.5` per position. Fails open if price data unavailable. (`src/costBenefit.ts`, `src/configLoader.ts`, `src/types.ts`, `src/rebalancer.ts`)
- **TWAP cardinality startup check**: Runs once at boot, warns via logs + Telegram if any pool's `observationCardinality < 50`. Non-fatal, never blocks startup. (`src/index.ts`, `src/pool.ts`)
- **`/fixtwap` Telegram command**: Increases pool observation cardinality to 65536 on-chain (one-time tx). (`src/telegramCommands.ts`)
- **`increaseObservationCardinalityNext()`** added to UniswapV3Pool ABI. (`abis/UniswapV3Pool.json`)
- **`isTransientRpcError()`** exported from `src/rebalancer.ts` for unit testing.

---

## [2.6.0] - 2026-03-01

### Bot State Visibility & Dashboard Control Surface

Dashboard now exposes real-time bot state (safe mode, kill switch, rebalance locks) per position with interactive controls for operators.

### Added

- **Dashboard bot state**: red banner + Enable button when rebalancing disabled; yellow warning when positions blocked
- **Emergency Stop button** on dashboard when rebalancing is active
- **Position badges**: SAFE MODE (red), KILL SWITCH (orange), REBALANCING (blue) on PositionCard
- **PositionDetail**: red panel with "Clear Safe Mode" button; orange kill switch info panel
- **New API endpoints**: `POST /api/bot/enable`, `/api/bot/disable`, `/api/positions/:tokenId/clear-safe-mode`
- **`GET /api/dashboard`**: new `botState` block (`rebalancingEnabled`, `safeModePositions`, `positionStates`)
- **`GET /api/positions`**: new `inSafeMode`, `killSwitchTriggered`, `rebalanceLocked` fields
- **Telegram `/status`**: now shows safe mode and kill switch status per position
- **`getRebalanceLockAgeMs()`** exported from `src/rebalancer.ts` for dashboard display

---

## [2.5.0] - 2026-03-01

### Safe Mode Self-Heal, Startup Ownership Validation & Stale Recovery State Auto-Delete

Comprehensive fix for four production bugs that caused the VPS bot to enter permanent silent failure across multiple positions over 12-18 hours. The root causes were discovered via forensic log review: wrong token IDs in config.yaml triggered permanent safe mode (never cleared without PM2 restart), stale recovery state files repeated error logs every cycle indefinitely, and there was no Telegram mechanism to clear safe mode without restarting.

**Root cause**: A failed rebalance or config error → `safeModePositions.add(pk)` → bot silently skips that position forever → real positions go unmonitored → PM2 restart required.

### Fixed

- **CRITICAL**: Ownership failures no longer enter safe mode. An unowned position means wrong `token_id` in config.yaml — a config error, not a rebalance catastrophe. Bot now logs clearly and skips the cycle. Self-heals when config.yaml is corrected without PM2 restart. (`src/rebalancer.ts`)
- **CRITICAL**: Stale recovery state files with invalid/mismatched tokens no longer log errors indefinitely. When `validateRecoveryState()` fails, `detectStrandedFunds()` now calls `ownerOf(oldTokenId)` on-chain. If the NFT is burned (`CALL_EXCEPTION`), the file is deleted automatically with `unlinkSync()`. If the NFT still exists, the file is preserved with a "manual inspection required" warning. If the RPC call fails, the file is preserved safely. (`src/recovery.ts`)
- **MAJOR**: `/enable [tokenId]` now clears safe mode for positions in scope (all positions or a specific token ID). Reports which positions had safe mode cleared. Warns operator if a recovery state file still exists on disk (should run `/recover` first). (`src/telegramCommands.ts`)
- **MINOR**: `/removestale` now clears safe mode for all removed positions. Composite keys for removed positions are no longer tracked. (`src/telegramCommands.ts`)

### Added

- **`clearSafeMode(pk: string): boolean`** — exported from `src/rebalancer.ts`. Deletes the composite key from `safeModePositions`. Returns `true` if the position was actually in safe mode.
- **`isSafeMode(pk: string): boolean`** — exported from `src/rebalancer.ts`. Read-only check.
- **`getSafeModePositions(): string[]`** — exported from `src/rebalancer.ts`. Returns all keys currently in safe mode (for `/status` and `/enable` display).
- **Startup ownership validation** in `src/index.ts` — the startup position loop now calls `verifyOwnership()` before `getPositionStatus()`. Bad token IDs produce a `STARTUP WARNING` log immediately at boot and skip the misleading status fetch. RPC errors at startup are non-fatal (warning only, retry during monitoring loop).
- **`/enable [tokenId]`** — optional argument to scope `/enable` to a single position. Scoped response message confirms which positions were cleared.
- **`/help` text** updated: `/enable [tokenId] — Enable rebalancing, clear kill switch + safe mode`

### Design Decisions

- Safe mode is still entered on: (a) rebalance failure with recovery state file written to disk, (b) kill switch triggered. These represent real failures requiring human review — correct behavior unchanged.
- The `validateRecoveryState()` token whitelist is kept. It defends against tampered recovery state files pointing at malicious ERC-20 contracts. Auto-delete only fires after on-chain confirmation that the NFT is burned.
- Ownership failure self-heal does not require any operator action — fixing config.yaml and waiting for the next polling cycle is sufficient.

---

## [2.4.0] - 2026-02-28

### Aerodrome CL Gauge Staking Support

Auto-unstake/restake workflow for Aerodrome CL gauge-staked positions on Base. When a position has `gauge_address` configured, the bot automatically withdraws from the gauge before rebalancing and re-stakes the new position after minting.

### Added

- **`src/gauges.ts`** — new module for all gauge operations: `validateGauge()`, `getGaugeAddress()`, `isPositionStaked()`, `withdrawFromGauge()`, `depositToGauge()`. Includes security validation via `gauge.voter()` assertion against known Aerodrome Voter address.
- **`abis/AerodromeCLGauge.json`** — minimal ABI for CLGauge (deposit, withdraw, ownerOf, voter)
- **`abis/AerodromeVoter.json`** — minimal ABI for Voter contract (gauges lookup)
- **`gauge_address`** optional field on `PositionConfig` — only valid for `aerodrome-cl` and `aerodrome-cl-gc` DEXes. Validated as 0x-prefixed 40-hex address in `configLoader.ts`.
- **`gauge_address`** on `RecoveryState` — persisted during rebalance, validated in `validateRecoveryState()`. Recovery flow auto-re-stakes after mint.
- **Gas limits**: `GAUGE_DEPOSIT: 200_000`, `GAUGE_WITHDRAW: 150_000`, `GAUGE_APPROVE: 80_000`
- **Rebalancer step 2.5** — gauge withdrawal before step 3 (collect fees). Re-stake after step 6 (mint). Both gated by `!config.dry_run`. Non-fatal re-stake failure (logs warning, doesn't enter safe mode).
- **`verifyOwnership()`** — accepts optional `gaugeAddress` param. When provided, checks `gauge.ownerOf(tokenId)` for staked positions.
- **Telegram**: `/status` shows gauge address, `/config tokenId gauge_address=0x...` to set/update, `/new` and `/scan` flows ask for optional gauge address on Aerodrome CL positions
- **Notifications**: rebalance PnL includes "Unstaked → rebalanced → re-staked in gauge" when applicable. Approaching-trigger alert notes gauge unstake will occur. Daily summary shows 📌 badge for gauge-staked positions.
- **Dashboard API**: `gaugeAddress` included in position list response (from config, no RPC query)
- **Positions API**: `gauge_address` in list and detail endpoints
- **Frontend**: amber "Gauge" badge on PositionCard, "Gauge Staking" InfoCard on PositionDetail page

---

## [2.3.0] - 2026-02-28

### Daily Fees Collected Charts

Added daily earnings bar charts to both the main dashboard and individual position analytics page.

### Added

- **`GET /api/analytics/earnings?tokenId=<optional>`** — new endpoint returning `{ date, feesUsd }[]` per UTC day. Aggregates fees from rebalance events and manual fee collections. Uses current token prices for rebalance fee USD conversion (same approximation as per-position analytics). `FeeCollectionRecord.totalValueUsd` is used directly for manual collections (historically accurate).
- **`DailyEarningsChart`** (`src/web/src/components/charts/DailyEarningsChart.tsx`) — Recharts `BarChart` component showing fees collected per day. Green bars, dark theme consistent with FeeChart/ILChart.
- **`getDailyEarnings(tokenId?)`** added to `src/web/src/api/client.ts` with `DailyEarning` interface.
- **Dashboard** (`src/web/src/pages/Dashboard.tsx`) — portfolio-level daily fees chart below the portfolio summary cards, with skeleton loading state.
- **PositionAnalytics** (`src/web/src/pages/PositionAnalytics.tsx`) — per-position daily fees chart after the IL chart.

---

## [2.2.1] - 2026-02-28

### Configuration Audit & Address Verification

Comprehensive audit of all hardcoded addresses, fee tiers, tick spacings, and constitutional truths. Found and fixed 2 critical address bugs and 2 position ID misconfigurations.

### Fixed

- **CRITICAL**: Uniswap V3 Factory address wrong in `ethereum.ts` and `arbitrum.ts` — last 3 hex chars `F765` → `F984`. All `factory.getPool()` calls would have hit a non-existent contract on Ethereum/Arbitrum.
- **CRITICAL**: Uniswap V3 NPM address wrong in `ethereum.ts` and `arbitrum.ts` — last 16 chars completely different. All position queries, mints, burns, collects would have failed on Ethereum/Arbitrum.
- **LOW**: Duplicate function selector in `constants.ts` — `LIQUIDITY` had `0x128acb08` (same as `SWAP`), corrected to `0x1a686502`. Dead code, no runtime impact.
- **VPS**: Removed position #440661 from config (not owned by wallet, owner: `0x83300ed0...`)
- **VPS**: Fixed position ID #213623 → #1213623 (Ethereum USDC/WETH, digit transposition)

### Added

- **CONSTITUTIONAL_TRUTHS.md sections 8-11**: Aerodrome CL immutable facts — tickSpacing as pool key, EIP-1167 proxy pattern, slot0 field count, two independent deployments with all contract addresses
- **CONSTITUTIONAL_TRUTHS.md section 12**: Canonical Uniswap V3 addresses for Ethereum, Base, Arbitrum (12 addresses total)
- **Regression guard Layer G**: Contract Address & Position ID Integrity checklist in `AGENT_MEMORY_AND_REGRESSION_GUARD.md`
- **High-risk item #10**: Hardcoded Contract Addresses added to code map
- **Rules 25-26** in MEMORY.md: Address verification and position ID verification rules

---

## [2.2.0] - 2026-02-28

### Strategy Rename & Percentage Display

Renamed strategies to be more intuitive and added percentage display alongside ticks throughout the UI.

### Added

- **Percentage display** — width and trigger distance now shown as `300 ticks (~3.0%)` in Telegram `/status`, `/config`, dashboard position detail, and positions table
- **`width_percentage` / `trigger_percentage` config params** — Telegram `/config` and `/new` flow accept percentage input (e.g., `width_percentage=5` or `5%`), auto-converted to ticks via V3 exponential formula
- **`width_percentage` / `trigger_percentage` API fields** — GET responses include computed percentage fields for frontend display
- **`isValidStrategy()` function** — replaces hardcoded `VALID_STRATEGIES` array in `configLoader.ts` and `positions.ts`; validates any `base_Npct` or `base_N` suffix dynamically
- **`PRESET_WIDTH_REGEX`** — shared regex exported from `strategy.ts`, eliminates 7 duplicated regex patterns across codebase

### Changed

- **Strategy names renamed** (old names remain valid for backward compatibility):
  - `pulse` → `center` (neutral, centered range)
  - `snuggle_up` → `bullish` (30/70 split, more upside room)
  - `snuggle_down` → `bearish` (70/30 split, more downside room)
  - `lazy_ascending` → `lazy_up` (rebalance on pump only)
  - `lazy_descending` → `lazy_down` (rebalance on dump only)
- **Preset suffixes renamed**: `pulse_300` → `center_3pct`, `pulse_600` → `center_6pct`, etc.
- **Auto-widen generates `_Npct` names** — e.g., `center_12pct` instead of `center_1194`
- **Telegram strategy menu** updated with new labels (Center ~3%, Bullish ~6%, etc.)
- **Dashboard strategy form** updated with new dropdown labels and default `center_3pct`
- **Info page** updated with new strategy descriptions

### Backward Compatibility

- All old strategy names (`pulse`, `pulse_300`, `snuggle_up`, `lazy_ascending`, etc.) continue to work
- `STRATEGY_ALIASES` map in `strategy.ts` resolves old names to canonical internal names
- Existing `config.yaml` files with old names require no changes
- Recovery state files with old strategy names are handled correctly

---

## [2.1.0] - 2026-02-28

### Added

- **`/scan` Telegram command** — scans all configured NPMs (ERC721Enumerable) across all chains to discover wallet-owned positions not yet in config. User picks from the list and enters the strategy flow directly — no manual token ID, chain, or DEX entry needed.
- **`src/positionDiscovery.ts`** — new module for wallet position discovery via `balanceOf()` + `tokenOfOwnerByIndex()` + `positions()`. Chains scanned in parallel; Aerodrome DEXes use sequential queries for EIP-1167 proxy compatibility.
- **Aerodrome CL Gauge Caps DEX** (`aerodrome-cl-gc`) — separate DEX entry in chain registry for the newer Gauge Caps deployment on Base (NPM `0xa990C6a7...`, Factory `0xaDe65c38...`, Router `0xcbBb8035...`, Quoter `0x3d4C2225...`). Positions minted on Gauge Caps now resolve to the correct contracts.

### Fixed

- **Multi-chain recovery: wrong chain config** — `config.chain.*` always returned PulseChain config for all chains. Recovery, rebalancer, and auto-wrap now use `getChainConfig(chainId)` to resolve the position's actual chain.
- **Recovery state missing `dex` field** — if config changed before recovery, the bot fell back to chain-default contracts (wrong ABIs). `RecoveryState` now persists `dex` and recovery callsites use it as fallback.
- **Recovery wrap missing nonce management** — `deposit()` call had no nonce from `chain.nonceManager`, causing nonce desync with subsequent mint. Now mirrors rebalancer's wrap pattern.
- **Invalid Aerodrome v1 Quoter address** — corrected from non-existent `0x3d4e44Eb...` to verified `0x254cF9E1...`.
- **`ensureApproval` zero-first approval** — tokens with "Unsafe allowance change" protection (USDT, KTA) now have allowance reset to 0 before setting new amount.
- **`computeAutoWiden` used default chain ID** — now uses the position's actual `chainId`.

---

## [2.0.0] - 2026-02-27

### Multi-Chain & Multi-DEX Architecture

Single-process multi-chain support: manage LP positions across PulseChain, Ethereum, Base, and Arbitrum from one config file, one bot process, one Telegram bot, and one dashboard.

### Added — Multi-Chain Infrastructure

- **Chain registry** (`src/config/chains.ts`) — 4 chains with V3 contract addresses, fee tiers, token lists, aggregator configs, DexScreener slugs
- **Per-chain config files** — `src/config/ethereum.ts`, `src/config/base.ts`, `src/config/arbitrum.ts`
- **`MultiChainContext`** (`src/multiChain.ts`) — central resolver for per-position chain + contracts
- **`setupAllChains()`** (`src/chain.ts`) — creates wallet/provider/NonceTracker per chain
- **`createAllContractRegistries()`** (`src/contracts.ts`) — per-chain ContractRegistry with multi-DEX `getForDex()`
- **`config.yaml` multi-chain format** — `chains:` array with per-chain `chain_id` and `rpc_urls`
- **`chain_id` field on positions** — routes each position to correct chain's contracts and provider

### Added — Multi-DEX Support

- Arbitrum supports both Uniswap V3 (default) and PancakeSwap V3 via `dex` field
- `ContractRegistry.getForDex(dexName?)` resolves per-DEX contracts with caching

### Added — Dashboard Enhancements

- **Multi-chain wallet holdings** — ERC-20 balances queried across all configured chains with per-chain DexScreener USD pricing
- **Chain column** in wallet holdings table
- **Info page** (`/info`) — supported networks, DEXes, fee tiers, strategies, Telegram commands
- **Per-chain native balances** in dashboard response

### Added — Safety & Security

- **RPC URL redaction** — all log output shows hostname only via `redactUrl()` helper
- **`reloadPositions()` validation** — chain_id, strategy, width_ticks, duplicate rejection (parity with `loadConfig()`)
- **Generic RPC env vars scoped to default chain** — `RPC_URL_PRIMARY` etc. only apply to first configured chain
- **Recovery state `chainId` validation** — integer > 0 check in `validateRecoveryState()`
- **Per-chain analytics dirs** in `.gitignore` (`analytics/chain-*/`)

### Changed — Rebalancer State

- All module-level Maps/Sets use composite keys (`chainId-tokenId`)
- Lock files: `.rebalance-lock-{chainId}-{tokenId}`
- Recovery state files: `.recovery-state-{chainId}.json`
- Analytics storage: `analytics/chain-{chainId}/` subdirs

### Changed — Routes & Telegram

- All dashboard/position/recovery routes resolve per-position chain via `MultiChainContext`
- Telegram `/balance` shows per-chain native + ERC-20 balances
- Telegram `/recover` scans all chains for stranded funds
- Price service `getTokenPrices()` accepts optional `chainSlug` parameter; cache keys include slug

### Backward Compatibility

- Existing single-chain `config.yaml` (no `chains:` block) works unchanged
- Positions without `chain_id` default to `config.chain.chainId`
- Legacy `.recovery-state.json` (no chainId) treated as default chain
- Flat `analytics/` files read when no `chain-{id}/` subdir exists

---

## [1.9.0] - 2026-02-26

### Analytics Deep Dive & Execution Cost Tracking

Major analytics expansion: rebalance execution cost tracking, health score system, volatility metrics, position chain visualization, CSV/JSON export, proactive notifications, and dashboard enhancements.

### Added — Rebalance Execution Cost Tracking

- **`calculateRebalanceCost()`** (`src/analytics/metrics.ts`) — computes `preValue - postValue - gasCost` at a single reference price (post-rebalance tick) to isolate execution cost from impermanent loss. Returns `costPercent` (% of pre-rebalance value) and `costToken0` (token0-equivalent units). Clamped to [0, 50] for sanity.
- Two new fields on `RebalanceMetrics`: `rebalanceCostPercent`, `rebalanceCostToken0`
- "Exec Cost" column in rebalance cost breakdown table on PositionAnalytics page
- "Execution Costs" MetricCard in P&L summary (orange, shows sum + avg per rebalance)
- Exec cost displayed in chain link cards and Telegram `/chain` per-link output
- `avgRebalanceCostPercent` fed into health score calculation

### Added — New Analytics Modules

- **Health Score System** (`src/analytics/healthScore.ts`)
  - Component-based 0-100 scoring with weighted factors
  - Components: P&L, fee APR, time-in-range, distance from edge, execution cost
  - Execution cost scoring: <0.5% → +5 points, >2% → -10, >5% → -15
  - Used in Telegram `/status` and analytics API

- **Volatility Metrics** (`src/analytics/volatility.ts`)
  - Tick range, standard deviation, annualized volatility from snapshot history
  - Helps evaluate whether position width is appropriate for current market conditions

- **Position Chain Visualization** (`src/analytics/chain.ts`)
  - Builds root→current token lineage from rebalance history
  - Per-link metrics: duration, time-in-range, fee APR, net ROI, gas, slippage, exec cost
  - Aggregate stats: total rebalances, cumulative ROI, avg time-in-range, total gas

- **Analytics Export** (`src/analytics/export.ts`)
  - CSV and JSON export of per-rebalance detail and per-snapshot history
  - `PerRebalanceDetail` includes `rebalanceCostPercent`

- **Cost-Benefit Evaluation** (`src/costBenefit.ts`)
  - Break-even analysis, rebalance profitability assessment
  - Evaluates whether rebalancing was worth the execution costs

- **Proactive Notifications** (`src/notifications/proactive.ts`)
  - Scheduled Telegram alerts for health degradation, prolonged out-of-range, fee milestones
  - Configurable thresholds and intervals

### Added — Dashboard Enhancements

- **Position cards**: Show unclaimed fees (USD), position age, and rebalance count
- **Wallet holdings**: Dashboard overview displays token balances with USD values
- **Position Chain page** (`src/web/src/pages/PositionChain.tsx`): Timeline visualization of rebalance chain with lifetime aggregate summary banner
- **Chain link to detail**: Position detail page links to chain visualization

### Added — 1inch Aggregator

- **`src/aggregators/oneinch.ts`**: Alternative DEX aggregator integration alongside Piteas
- **`src/aggregators/types.ts`**: Shared aggregator interface types

### Added — Telegram Commands

- **`/chain [tokenId]`**: View position rebalance chain with per-link metrics and exec cost
- **`/export [tokenId]`**: Export analytics data

### Fixed — Slippage Sanitization

- Slippage values clamped to max 500 bps across all read paths (API responses, chain link builder, export)
- Prevents display of anomalous slippage values from early rebalances

### Files Changed

| File | Changes |
|------|---------|
| `src/analytics/metrics.ts` | New `calculateRebalanceCost()`, integrated into `calculateRebalanceMetrics()` |
| `src/analytics/types.ts` | +2 fields on `RebalanceMetrics` (`rebalanceCostPercent`, `rebalanceCostToken0`) |
| `src/analytics/healthScore.ts` | **New** — Component-based health scoring |
| `src/analytics/volatility.ts` | **New** — Tick volatility and annualized vol |
| `src/analytics/chain.ts` | **New** — Position chain builder with aggregates |
| `src/analytics/export.ts` | **New** — CSV/JSON analytics export |
| `src/analytics/collector.ts` | Integrated proactive notifications, volatility |
| `src/costBenefit.ts` | **New** — Break-even and profitability analysis |
| `src/notifications/proactive.ts` | **New** — Scheduled health/fee alerts |
| `src/aggregators/oneinch.ts` | **New** — 1inch aggregator client |
| `src/aggregators/types.ts` | **New** — Shared aggregator interfaces |
| `src/server/routes/analytics.ts` | Added `rebalanceCostPercent` to API, chain endpoint |
| `src/server/routes/dashboard.ts` | Wallet holdings, position card enhancements |
| `src/telegramCommands.ts` | `/chain` command, exec cost in `/status` health score |
| `src/web/src/pages/PositionChain.tsx` | **New** — Chain timeline page |
| `src/web/src/pages/PositionAnalytics.tsx` | Exec cost column + MetricCard |
| `src/web/src/api/client.ts` | Chain types, rebalanceCostPercent on existing types |
| `src/web/src/components/PositionCard.tsx` | Fees, age, rebalance count display |
| `src/web/src/pages/Dashboard.tsx` | Wallet holdings section |
| `src/web/src/App.tsx` | PositionChain route |
| `src/config/chains.ts` | Multi-chain config expansion |
| `src/config/constants.ts` | Updated COLLECT/BURN gas limits |
| `src/configLoader.ts` | Proactive notification config, aggregator config |
| `src/contracts.ts` | 1inch router support |
| `src/swap.ts` | 1inch aggregator routing |
| `src/rebalancer.ts` | Proactive notification hooks, enhanced analytics capture |
| `src/index.ts` | Proactive notification initialization |
| `src/types.ts` | New config types for notifications, aggregators |

---

## [1.8.0] - 2026-02-23

### Rebalance Now Feature + Security Audit Fixes

#### Added — Rebalance Now (Frontend + Telegram)

- `GET /api/positions/:tokenId/rebalance-preview` — evaluates strategy, computes new range, estimates swap USD amount, returns full preview without executing anything
- `POST /api/positions/:tokenId/rebalance` — force-executes full rebalance (`force=true`); returns old/new token ID, fees collected, swap details, mint tx hash
- Position detail page: "Rebalance Now" button opens a preview modal showing position value, unclaimed fees, current→new range ticks + prices, estimated swap amount, and warnings. Two-step confirmation (preview → ConfirmDialog) before execution. Navigates to new token ID on success with mint tx link.
- Telegram `/rebalance` preview enhanced: now shows new range tick values + prices and estimated swap amount with USD value and % of position

#### Fixed — Security Audit Findings

| Severity | File | Issue | Fix |
|----------|------|-------|-----|
| CRITICAL | `src/aggregators/piteas.ts:167` | `swapData.to` not validated — compromised API could redirect tx to any address | Assert `swapData.to === PITEAS_ROUTER_ADDRESS` before `sendTransaction`; throw on mismatch |
| HIGH | `src/aggregators/piteas.ts:172` | `swapData.value` not validated — non-zero would drain native PLS | Assert `swapData.value === 0n` for ERC-20 swaps; always pass `value: 0n` explicitly |
| HIGH | `src/rebalancer.ts` + `src/server/routes/positions.ts` | Dashboard and bot are separate PM2 processes with independent `NonceTracker`s — concurrent on-chain txs race on nonces | Lock files (`.rebalance-lock-{tokenId}`): bot writes on rebalance start, deletes on finish; dashboard `/collect` and `/rebalance` return 409 if locked |
| HIGH (chore) | `config.yaml` | Tracked by git — Telegram bot token and webhook URLs in history | `git rm --cached config.yaml`; confirmed `.gitignore` entry already present |
| MODERATE | `src/recovery.ts:43` | `JSON.parse()` of `.recovery-state.json` had no schema validation — tampered file could point bot at malicious ERC-20 contracts | `validateRecoveryState()`: checks all fields for correct types, validates `token0`/`token1` as checksummed hex addresses, and asserts they appear in the `TOKENS` whitelist |
| LOW | `src/configLoader.ts:251` | `slippage_tolerance_bps` had no range check — value ≥ 10000 causes BigInt underflow downstream | Throw at startup if value outside 1–9999 |
| LOW | `src/swap.ts:50` | `calculateAmountOutMinimum` could return negative BigInt if `slippageBps ≥ 10000` | Floor return value at `0n` |

#### Not Fixed (accepted risk)

- **npm audit CRITICAL/HIGH** — all in `node-telegram-bot-api`'s deprecated `request` dependency. Fix requires breaking downgrade to `0.63.0`. Actual exploit path requires attacker to control Telegram API query strings, which is impractical. Tracked for future dependency replacement.
- **TWAP fails open on non-OLD errors** — intentional for HEX/WPLS pool (`observationCardinality=1`). Documented in MEMORY.md.
- **Raw `error.message` to Telegram** — owner-only channel; acceptable.

### Files Changed

| File | Changes |
|------|---------|
| `src/aggregators/piteas.ts` | Validate `swapData.to` and `swapData.value`; hardcode `value: 0n` |
| `src/rebalancer.ts` | Add `acquireRebalanceLock`/`releaseRebalanceLock`/`isRebalanceLocked` exports; wire into rebalance try/finally |
| `src/server/routes/positions.ts` | Import `isRebalanceLocked`; add guard before collect and rebalance endpoints; fix `evaluateStrategy` call signature; fix `posConfig.params.*` paths; use `Map.get()` for price lookup |
| `src/recovery.ts` | Add `validateRecoveryState()` with field type checks and TOKENS whitelist |
| `src/configLoader.ts` | Validate `slippage_tolerance_bps` in range 1–9999 at startup |
| `src/swap.ts` | Floor `calculateAmountOutMinimum` at `0n` |
| `src/web/src/api/client.ts` | Add `RebalancePreview`, `RebalanceNowResult` interfaces; add `getRebalancePreview()`, `rebalanceNow()` |
| `src/web/src/pages/PositionDetail.tsx` | Full rewrite with Rebalance Now button, preview modal, two-step confirmation, success banner |
| `src/telegramCommands.ts` | Enhanced `/rebalance` preview with `evaluateStrategy`, range ticks/prices, swap estimate |
| `.gitignore` | Add `.rebalance-lock-*` |
| `config.yaml` | Removed from git tracking |

---

## [1.7.0] - 2026-02-23

### Five Critical Rebalance Bug Fixes

Comprehensive fix for the Feb 10–23 failure cascade. After 13 days of failure analysis across positions #155778, #155781, #155806, and #155876, identified and fixed 5 distinct bugs that prevented any rebalance from completing the full pipeline (collect → remove → swap → mint).

### Fixed — Mint Slippage Used Full Wallet Balance (`src/rebalancer.ts`)

- **Root cause**: `amount0Min`/`amount1Min` were calculated as `walletBalance * (1 - slippage%)`. But the wallet held stranded funds from prior failed rebalances (e.g., 21.75M WPLS). The V3 pool only deposits the ratio it needs at the current tick — if it needs 5M WPLS but `amount1Min = 20.79M`, the mint reverts with "Price slippage check".
- **Fix**: Replaced naive slippage calculation with pool-math-derived minimums:
  1. Call `getLiquidityForAmounts(sqrtPrice, sqrtA, sqrtB, amount0, amount1)` to compute expected liquidity
  2. Call `getAmountsForLiquidity(sqrtPrice, sqrtA, sqrtB, liquidity)` to compute what the pool will actually accept
  3. Apply slippage tolerance to *those* expected amounts, not the raw wallet balance
- **Impact**: Primary cause of all mint reverts resolved. Excess tokens remain safely in wallet.

### Fixed — Nonce Race After RPC Provider Rotation (`src/chain.ts`)

- **Root cause**: After RPC rotation, `resetNonce()` queried the new provider which may have stale mempool state, returning a lower nonce than already-used values → `NONCE_EXPIRED`.
- **Fix**: Added `lastConfirmedNonce` field to `NonceTracker`. `resetNonce()` now queries twice with a 2-second delay and uses `max(chainNonce, lastConfirmedNonce + 1)` as the floor.
- **Impact**: Resolved NONCE_EXPIRED failures on positions #155778 and #155806.

### Fixed — WPLS Auto-Wrap Missing deposit() (`src/contracts.ts`, `src/rebalancer.ts`, `src/recovery.ts`)

- **Root cause**: `contracts.getERC20(TOKENS.WPLS).deposit()` threw `TypeError: deposit is not a function` because the ERC20 ABI has no `deposit()` method. WPLS is a WETH9-style contract needing a dedicated ABI.
- **Fix**: Created `abis/WETH9.json` with `deposit()` payable, `withdraw(uint256)`, `balanceOf`, `approve`, `allowance`. Added `getWPLS()` method to `ContractInstances`. Updated both rebalancer and recovery to use `contracts.getWPLS()`.
- **Impact**: Native PLS in wallet (6.8M PLS / ~$56) can now be auto-wrapped to WPLS before minting.

### Fixed — TWAP Oracle Always Fails (`src/pool.ts`)

- **Root cause**: HEX/WPLS 2500-fee pool has `observationCardinality = 1`. `pool.observe([300, 0])` always reverts with "OLD" because there's only one observation slot — it can't look back 300 seconds.
- **Fix**: `isTwapSafe()` now retries with progressively shorter windows (300→60→10s) on "OLD" revert. Uses whatever history is available instead of always falling through to "assume safe".
- **Impact**: TWAP check now functional for pools with limited observation history.

### Fixed — Swap Event Parsed at Wrong Address (`src/swap.ts`)

- **Root cause**: `contracts.getPool(tokenIn).interface` created a pool contract at the ERC20 token address, not the actual pool address. The pool emits the Swap event, so parsing at the token address found nothing. Fallback used total wallet balance as `amountOut`, inflating the value.
- **Fix**: Resolve the actual pool address via `contracts.factory.getPool(tokenIn, tokenOut, fee)`, then parse Swap events from that contract.
- **Impact**: `amountOut` now reflects the actual swap output, not the entire wallet balance.

### Files Changed

| File | Changes |
|------|---------|
| `abis/WETH9.json` | **New** — Minimal WETH9 ABI (deposit, withdraw, balanceOf, approve, allowance) |
| `src/rebalancer.ts` | Fix #1 (mint slippage from pool math), Fix #3 (getWPLS for auto-wrap) |
| `src/chain.ts` | Fix #2 (lastConfirmedNonce, 2s delay in resetNonce) |
| `src/contracts.ts` | Fix #3 (WETH9 ABI import, getWPLS method) |
| `src/swap.ts` | Fix #5 (factory-derived pool address for Swap event) |
| `src/pool.ts` | Fix #4 (adaptive TWAP window 300→60→10s) |
| `src/recovery.ts` | Fix #3 (WPLS auto-wrap before recovery mint) |

---

## [1.6.2] - 2026-02-17

### Critical Math Fix & Recovery Swap Step

Two bugs caused 4 consecutive rebalance failures (Feb 10-17) and a failed recovery attempt.

### Fixed — Swap Calculation Q192 Bug (`src/math.ts`)

- **Root cause**: `calculateSwapAmount()` token0 branch had a spurious `* Q192` multiplier that inflated results by ~10^58, causing it to always hit the 100% balance cap and swap all of token0
- **Impact**: Every rebalance that needed to sell token0 (HEX) would swap 100% instead of the correct ~49%, leaving 0 HEX → mint reverts because V3 requires both tokens for in-range positions
- **Fix**: Removed `* Q192` from token0 branch (line 337). Token1 branch was already correct.
- **Affected positions**: #155345, #155361, #155367, #155608

### Fixed — Recovery Missing Swap Step (`src/recovery.ts`)

- **Root cause**: `recoverStrandedFunds()` passed raw wallet balances directly to `mintPosition()` with no swap step. Recovery centers the range on current tick (tick always in-range), so V3 requires both tokens. After the Q192 bug swapped 100% of HEX → WPLS, wallet had 0 HEX → mint reverted.
- **Fix**: Added swap step mirroring normal rebalance flow (steps 4-5): calls `calculateSwapAmount()` then `executeSwap()` before minting. Also uses 99% slippage tolerance for recovery mints.

### Added — Pre-Mint Sanity Check (`src/rebalancer.ts`)

- If current tick is inside the new range but either token balance is 0, throws a clear error instead of letting the mint revert with an opaque `CALL_EXCEPTION`
- Safety net only — with the Q192 fix this should never trigger

### Added — Swap Safety Enhancements (`src/swap.ts`, `src/rebalancer.ts`)

- Price impact limit: swaps that move price >5% are rejected (prevents catastrophic slippage)
- Post-swap balance fallback: if swap event parsing returns 0, reads `balanceOf` directly
- Post-swap sanity check: aborts if swap produced zero output
- Pre-mint sanity check: verifies both tokens available when tick is in-range

## [1.6.0] - 2026-02-11

### Rebalance RPC Resilience & Confirmation Delay

Comprehensive fix for transient RPC failures triggering unnecessary safe mode entries. After both positions entered safe mode on Feb 11 due to PulseChain RPC 504 Gateway Timeouts, the rebalancer was hardened with error classification, retry caps, dynamic provider rotation, and a confirmation delay to prevent reacting to transient price spikes.

### Added — Error Classification & Retry Logic

- **Transient RPC error classifier** (`src/rebalancer.ts`)
  - New `isTransientRpcError()` function classifies errors as transient (SERVER_ERROR, TIMEOUT, NETWORK_ERROR, 504, ECONNRESET, socket hang up) vs permanent (CALL_EXCEPTION)
  - Transient errors during rebalance skip safe mode when no recovery state file exists
  - Bot retries on next monitoring cycle instead of halting

- **Retry cap** (`src/rebalancer.ts`)
  - `transientFailureCount` Map tracks consecutive transient failures per position
  - `MAX_TRANSIENT_RETRIES = 5` — enters safe mode after 5 consecutive transient failures
  - Counter resets on successful rebalance or when entering safe mode
  - Prevents infinite retry loops that could drain gas tokens

- **Confirmation delay** (`src/rebalancer.ts`)
  - New `outOfRangeSince` Map tracks when a position first detected out of range
  - New `confirm_minutes` strategy parameter — position must remain out of range for N minutes before rebalancing
  - Timer resets if position returns in range before confirmation period elapses
  - Default: 0 (no delay, backward compatible)
  - Production config: 60 minutes for all positions

### Changed — Dynamic Contract Providers

- **Contract instances use getters** (`src/contracts.ts`)
  - `positionManager`, `swapRouter`, `factory` are now getter properties
  - Each access creates a fresh `ethers.Contract` with the current `chain.wallet`/`chain.provider`
  - Ensures RPC fallback rotation actually takes effect for transaction execution
  - Previously, contract instances held stale references to the original provider

### Changed — Configuration

- **Increased trigger distance**: `trigger_distance_ticks` changed from 10 to 50 for all positions
  - 50 ticks = ~0.5% price movement beyond range edge before triggering
  - Reduces unnecessary rebalances from minor price fluctuations

- **Increased polling interval**: `polling_interval_seconds` changed from 30 to 60
  - Reduces RPC load by 50%
  - Combined with `confirm_minutes: 60`, the 30s extra latency is negligible

- **New strategy parameter** (`src/types.ts`)
  - Added `confirm_minutes?: number` to `StrategyParams` interface
  - Documents: "position must stay out of range for this many minutes before rebalancing (default 0)"

### Technical Details

- Recovery state file (`.recovery-state.json`) is the key safety signal: if it exists, the bot has performed an irreversible on-chain action (NFT burn) and MUST enter safe mode regardless of error type
- Nonce is reset after transient failures since the tx may not have been submitted
- Telegram notification sent on transient failures (info level, not alarm)

### Files Changed

| File | Action |
| ---- | ------ |
| `src/rebalancer.ts` | Edit — Added `isTransientRpcError()`, `transientFailureCount` Map, `outOfRangeSince` Map, confirmation delay logic, modified catch block |
| `src/contracts.ts` | Edit — Changed contract instances to getter properties for dynamic provider resolution |
| `src/types.ts` | Edit — Added `confirm_minutes` to `StrategyParams` |
| `config.yaml` | Edit — `trigger_distance_ticks: 50`, `confirm_minutes: 60`, `polling_interval_seconds: 60` |

---

## [1.5.1] - 2026-02-10

### Dashboard UX Improvements

Improves the dashboard experience with persistent sessions, in-app refresh, better metrics visibility, and accurate rebalance cost estimates.

### Added — Dashboard Features

- **Navbar refresh button**: Circular arrow icon in the header re-fetches all data (prices, positions, metrics) without a full page reload. Works on all pages — Dashboard, Positions, Position Detail, Position Analytics, and History.
- **Position card metrics**: Each position card on the dashboard now shows USD value (blue) and lifetime APR (green) alongside the strategy label.
- **Rebalance cost estimates**: Position detail page shows estimated swap amount, slippage cost, gas cost, total cost, and break-even time at both range edges.
- **Rebalance cost tooltips**: Hover any cost metric for a detailed breakdown of the calculation (swap token, % of position, slippage rate, gas units, hourly income, break-even formula).
- **Configurable snuggle ratios**: `lower_ratio_percent` parameter for snuggle_up/snuggle_down strategies, adjustable via Telegram `/config` command.

### Fixed — Auth & Session

- **Session persistence**: JWT token is now stored in `localStorage` — refreshing the page or closing/reopening the tab no longer requires re-login.
- **Extended JWT expiry**: Token lifetime increased from 1 hour to 24 hours.

### Fixed — Rebalance Cost Math

- **Swap amount estimation**: Fixed $0.00 swap amounts — was computing swap into the same range (where ratio already matches) instead of the new range the strategy would create.
- **Swap overestimation**: Replaced fee-inflated `calculateSwapAmount` with USD value ratio approach (`estimateSwapForNewRange`) that correctly computes the target token0/token1 fraction from the new range geometry.
- **Strategy-aware estimates**: Cost estimates now mirror actual strategy logic (pulse centered, snuggle_up 30/70, snuggle_down 70/30, custom ratios).
- **Slippage default**: Combined slippage set to 0.50% (50 bps) as a flat rate.

---

## [1.5.0] - 2026-02-10

### DEX Aggregator Integration

Adds configurable swap routing to optimize rebalancing trades. Instead of being confined to 9mm's liquidity pools, the bot can now route through DEX aggregators for better execution prices.

### Added — Swap Provider Configuration

- **New config option**: `swap_provider` in `config.yaml`
  - `"direct"`: Routes swaps through 9mm SwapRouter only (original behavior)
  - `"piteas"`: Routes through Piteas DEX aggregator across all PulseChain DEXes

- **Piteas Aggregator Integration** (`src/aggregators/piteas.ts`)
  - API integration with Piteas aggregator (https://api.piteas.io)
  - Quote fetching to preview best routes before execution
  - Multi-DEX routing support (9inch, PulseX V1/V2/V3, etc.)
  - Automatic route optimization for best output
  - Slippage-protected swap execution via Piteas Router V2

- **Enhanced Swap Module** (`src/swap.ts`)
  - Provider-aware routing: checks `config.swap_provider` and routes accordingly
  - `executeSwap()` now supports both direct and aggregator modes
  - Refactored `executeSwapDirect()` for direct 9mm routing
  - Dry-run support for both providers

### Changed — Configuration

- **Default swap provider is now `"piteas"`** (was `"direct"`)
  - Piteas aggregator provides better execution in nearly all scenarios
  - No config changes needed - upgrade and it just works better
  - Opt-in to direct routing by adding `swap_provider: "direct"` if needed
  - Backward compatible - existing configs continue to work

- **Type System** (`src/types.ts`)
  - Added `SwapProvider` type: `'direct' | 'piteas'`
  - Added `SwapConfig` interface for swap configuration
  - Extended `ContractsConfig` with optional `piteasRouter` field
  - Added `swap_provider` field to `AppConfig`

- **Config Loader** (`src/configLoader.ts`)
  - Validates `swap_provider` against allowed values
  - Defaults to `"direct"` for backward compatibility
  - Throws error on invalid provider names

- **Config Example** (`config.yaml.example`)
  - Added `swap_provider: "piteas"` with explanatory comments
  - Documents when to use each provider

### Documentation

- **New Guide**: [DEX Aggregator Guide](docs/DEX_AGGREGATOR_GUIDE.md)
  - Comprehensive explanation of the problem and solution
  - Configuration instructions and recommendations
  - Gas cost comparison and performance examples
  - Troubleshooting section
  - Real-world performance comparison showing 10.8% better execution with aggregator

- **Updated README**
  - Added feature highlights section mentioning DEX aggregator support
  - Linked to DEX Aggregator Guide

### Technical Details

- Piteas Router V2: `0x3334F2A75ab4F8C70c3F8c0e9d8b4571a2fB4a4A`
- Aggregator swaps use 2x gas limit (250k-400k vs 150k-200k for direct)
- Token approvals are exact amounts (not MAX_UINT256) for both providers
- All swaps maintain slippage protection via `slippage_tolerance_bps`

### Why This Matters

For trading pairs with thin liquidity on 9mm (common scenario), routing through an aggregator can deliver:
- **Better execution prices**: 5-15% more tokens received
- **Lower price impact**: Splitting across multiple DEXes
- **Higher overall profitability**: Improved swap execution outweighs slightly higher gas costs

**Recommendation**: Use `swap_provider: "piteas"` unless your pair has excellent 9mm liquidity.

---

## [1.4.0] - 2026-02-10

### Comprehensive Analytics Dashboard

Adds a full analytics page per position with P&L tracking, charting, health scores, and portfolio-wide summary — giving clear feedback on whether to keep, adjust, or pull any LP position.

### Added — Analytics Frontend

- **Position Analytics Page** (`/positions/:tokenId/analytics`)
  - Cumulative fee chart (Recharts `LineChart`) with purple rebalance event markers
  - Impermanent loss tracking chart (Recharts `AreaChart`) over time
  - Fee collection history table with timestamps, USD values, and PulseScan tx links
  - Rebalance cost breakdown table: gas (PLS), fees collected (USD), slippage bps, net ROI %
  - Position health assessment (0-100 score: excellent/good/fair/poor)
  - P&L summary cards: Total Fees, Total Costs, Net Income, Current IL

- **Dashboard Portfolio Summary** (`Dashboard.tsx`)
  - New MetricCard row: Total Portfolio Value, Total Fees Earned, Total Gas Costs, Net P&L
  - Fetched via `GET /api/analytics/summary`

- **Position Detail Enhancements** (`PositionDetail.tsx`)
  - "Analytics" button linking to the full analytics page
  - Inline metric cards: Current IL %, Net Income, Days Since Rebalance, Total Fees (claimed + pending)
  - Fetched via `GET /api/analytics/positions/:tokenId/analytics`

- **New Components**
  - `MetricCard` — Reusable metric display with color coding (green/red/yellow/blue)
  - `FeeChart` — Cumulative fee line chart with rebalance markers
  - `ILChart` — IL tracking area chart with zero reference line

### Added — Dashboard Recovery Alerts

- **Recovery Alert Banner** (`Dashboard.tsx`)
  - Yellow warning banner at top of dashboard when stranded funds detected
  - Shows old position ID, token pair, fee tier, and wallet balances
  - "Dismiss" button with confirmation dialog — clears `.recovery-state.json`
  - "Recover" button with confirmation dialog — mints new LP position from stranded funds
  - Recover button disabled in dry-run mode for safety
  - Auto-fetches recovery status on page load

- **Recovery API Endpoints** (`src/server/routes/recovery.ts`)
  - `GET /api/recovery/status` — Check for stranded funds (calls `detectStrandedFunds()`)
  - `POST /api/recovery/dismiss` — Clear recovery state file + send Telegram notification
  - `POST /api/recovery/recover` — Mint new position from wallet balances (blocked in dry-run)
  - All endpoints protected by JWT auth

- **API Client** (`src/web/src/api/client.ts`)
  - `getRecoveryStatus()`, `dismissRecovery()`, `executeRecovery()` functions
  - `RecoveryStatus`, `RecoveryReport`, `RecoveryResult` type definitions

### Added — Analytics API

- **3 New Endpoints** (`src/server/routes/analytics.ts`)
  - `GET /api/analytics/positions/:tokenId/analytics` — Full lifecycle metrics: fees, gas, IL, health score, time series, tables
  - `GET /api/analytics/positions/:tokenId/snapshots?days=N` — Downsampled snapshot history for charting
  - `GET /api/analytics/summary` — Portfolio-wide totals across all positions

- **Fee Collection Tracking** (`src/server/routes/positions.ts`)
  - Manual fee collections now persist `fee_collection` analytics records
  - Records: amounts, gas cost, USD values at collection time, token info

### Added — Backend Types & Storage

- `FeeCollectionRecord` interface in `src/analytics/types.ts`
- `queryFeeCollections()` in `src/analytics/storage.ts`
- `gasUsed` added to BigInt fields in storage reviver
- `listAnalyticsFiles` exported for use by analytics routes

### New Dependencies

- `recharts` — React charting library (~200KB gzipped)
- `@types/express`, `@types/cors`, `@types/jsonwebtoken` — Dev types for clean backend builds

### Files Changed

| File | Action |
| ------ | -------- |
| `src/server/routes/analytics.ts` | **New** — 3 analytics API endpoints |
| `src/web/src/pages/PositionAnalytics.tsx` | **New** — Full analytics page |
| `src/web/src/components/MetricCard.tsx` | **New** — Reusable metric card |
| `src/web/src/components/charts/FeeChart.tsx` | **New** — Cumulative fee chart |
| `src/web/src/components/charts/ILChart.tsx` | **New** — IL tracking chart |
| `src/analytics/types.ts` | Edit — Added `FeeCollectionRecord` |
| `src/analytics/storage.ts` | Edit — Added `queryFeeCollections()` |
| `src/server/index.ts` | Edit — Mount analytics router |
| `src/server/routes/positions.ts` | Edit — Record fee collections |
| `src/web/src/App.tsx` | Edit — Added analytics route |
| `src/web/src/api/client.ts` | Edit — Added analytics interfaces & functions |
| `src/server/routes/recovery.ts` | **New** — 3 recovery API endpoints |
| `src/web/src/pages/Dashboard.tsx` | Edit — Portfolio summary row + recovery alert banner |
| `src/web/src/pages/PositionDetail.tsx` | Edit — Analytics button & inline metrics |

---

## [1.3.2] - 2026-02-10

### Fixed — Telegram `/status` Command

- **30s Timeout** (`src/telegramCommands.ts`)
  - Added `Promise.race` timeout wrapper around `getPositionStatus()` calls
  - Prevents `/status` from hanging indefinitely on RPC 504 Gateway Timeouts
  - Each position gets its own 30s timeout; failures report per-position

- **HTML Parse Mode** (`src/telegramCommands.ts`)
  - Switched all Telegram messages from Markdown V1 to HTML parse mode (`<b>`, `<i>`, `<code>`)
  - Fixes Telegram 400 Bad Request errors caused by `toLocaleString()` commas inside `_..._` italic markers
  - All commands updated: `/status`, `/balance`, `/position`, `/help`

- **Enhanced `/status` Output**
  - Now reports all positions (not just first)
  - Shows USD values for token amounts and unclaimed fees
  - Includes strategy details (width, trigger distance)
  - Fetches USD prices once for all tokens via DexScreener

**Impact**: Fixed `/status` command that was hanging for 2+ minutes and failing with Telegram parsing errors.

---

## [1.3.1] - 2026-02-10

### Fixed — Safe Mode RPC Resilience

- **Ownership Verification** (`src/position.ts`)
  - Fixed bug where RPC timeout errors were treated as ownership failures
  - Now distinguishes between contract reverts (invalid token) and RPC errors
  - RPC errors trigger retry via `chain.withRetry()` instead of entering safe mode
  - Only true ownership failures (position doesn't exist, wrong owner) trigger safe mode
  - Added detailed error logging for debugging ownership issues

**Impact**: Resolved issue where positions #155284 and #155290 were stuck in safe mode despite being validly owned, preventing ~$4.7M TVL from rebalancing and earning fees.

---

## [1.3.0] - 2026-02-10

### Web Dashboard & Enhanced Monitoring

Adds a full web dashboard for monitoring positions, viewing fees, checking prices, reviewing rebalance history, and manually collecting fees — all from a browser.

### Added — Web Dashboard

- **Express API Server** (`src/server/`)
  - JWT authentication with password login (`POST /api/auth/login`)
  - Rate limiting: 100 req/min general, 5 req/min login
  - Helmet security headers
  - Routes: `/api/dashboard`, `/api/positions`, `/api/rebalances`
  - Manual fee collection: `POST /api/positions/:tokenId/collect`

- **React Frontend** (`src/web/`)
  - Vite + React + TypeScript + Tailwind CSS
  - Dark theme SPA with responsive design
  - Pages: Dashboard, Positions, Position Detail, Rebalance History, Login
  - Components: Navbar, PositionCard, RangeBar, StatusBadge, StrategyForm, ConfirmDialog, AuthGuard

- **True Unclaimed Fees** (`src/position.ts`)
  - Uses `positionManager.collect.staticCall()` with `MAX_UINT128` to simulate fee collection
  - Returns actual accrued fees, not stale `tokensOwed0/1` from `positions()` view
  - Falls back gracefully to `tokensOwed` if staticCall fails

- **DexScreener Price Service** (`src/server/services/priceService.ts`)
  - Fetches USD prices from `api.dexscreener.com/tokens/v1/pulsechain/`
  - 5-minute TTL cache (stays under 60 req/min rate limit)
  - USD values shown next to all token amounts and fees

- **Rebalance History Page** (`/history`)
  - Expandable cards with old/new ranges, fee collection, swap details
  - Metrics: Fee APR, Net ROI, Impermanent Loss, Time-in-Range, Capital Efficiency
  - Transaction hash links to PulseScan
  - Configurable time periods (7d, 30d, 90d, 365d)

- **Manual Fee Collection**
  - "Collect Fees" button on Position Detail page
  - Confirmation dialog before executing on-chain transaction
  - Blocked in DRY_RUN mode for safety
  - Shows PulseScan link on success

- **PM2 Dashboard Process**
  - `9mm-dashboard` runs on port 3100 alongside `9mm-rebalancer`
  - Added to `ecosystem.config.cjs`

### Changed

- `src/types.ts` — Added `unclaimedFees0`, `unclaimedFees1` to `PositionStatus`
- `src/position.ts` — Added `collect.staticCall()` in `getPositionStatus()`
- `ecosystem.config.cjs` — Added `9mm-dashboard` PM2 process
- `.env.example` — Added `DASHBOARD_PASSWORD`, `DASHBOARD_JWT_SECRET`, `DASHBOARD_PORT`

### Infrastructure Changes

- VPS SSH: switched from `root` to `tyler` user (root login disabled)
- VPS project path: moved from `/root/9mm-rebalancer` to `/opt/9mm-rebalancer`
- Git auth on VPS: GitHub Personal Access Token embedded in remote URL

---

## [Unreleased]

### Added - Asymmetric Rebalancing Strategies

Two new asymmetric strategies that bias the position range toward expected price movement:

- **Snuggle Up Strategy** (`snuggle_up`)
  - Range split: 30% below current price, 70% above
  - Use case: Bullish sentiment, expect upward price movement

- **Snuggle Down Strategy** (`snuggle_down`)
  - Range split: 70% below current price, 30% above
  - Use case: Bearish sentiment, expect downward price movement

---

## [1.2.0] - 2026-02-09

### Two-Way Telegram Command Handler

Adds interactive Telegram bot commands for remote monitoring and emergency control of the rebalancer from your phone.

### Added — Telegram Commands

- **Telegram Command Handler** (`src/telegramCommands.ts`)
  - `/status` — Quick position status (in/out of range, tick, liquidity, mode)
  - `/report` — Detailed position report (pair, price, fees, strategy params)
  - `/balance` — Wallet PLS balance and address
  - `/position [id]` — Query any position NFT by token ID
  - `/enable` — Re-enable rebalancing after emergency stop
  - `/disable` — Emergency stop (disable rebalancing without stopping the bot)
  - `/help` / `/start` — Show available commands and current state
  - Authorization: Only responds to configured `telegram_chat_id` (numeric)
  - Error resilience: Stops polling after 3 consecutive 401 auth failures

- **Chat ID Discovery Helper** (`src/getChatId.ts`)
  - `npm run getchatid` — Discovers user's numeric Telegram chat ID
  - Needed because `telegram_chat_id` must be numeric, not a bot username

- **New Dependency**
  - `node-telegram-bot-api` ^0.67.0 — Long-polling Telegram Bot API client
  - `@types/node-telegram-bot-api` ^0.64.13 — TypeScript types

### Changed — Telegram Integration

- `src/index.ts` — Initializes `TelegramCommandHandler` if notifications enabled with bot token and chat ID; checks `isRebalancingEnabled()` before each rebalance cycle; stops polling on graceful shutdown
- `src/notifications.ts` — One-way notifications (axios HTTP POST) remain unchanged, now coexists with two-way polling
- `config.yaml` — Updated `telegram_bot_token` to `@ALM_9mm_PersonalBot` bot; set `telegram_chat_id` to numeric `5874802252`
- `.gitignore` — Fixed `analytics/` pattern to `/analytics/` (root-level only) to stop ignoring `src/analytics/` source files
- `package.json` — Added `getchatid` script, PM2 convenience scripts (`pm2:status`, `pm2:logs`, `pm2:stop`, `pm2:restart`), and deploy script

### Design Notes

- **Two systems, one bot token**: `notifications.ts` (one-way, axios) and `telegramCommands.ts` (two-way, polling) share the same bot token but use different mechanisms
- **Single-instance polling**: Only one process can poll a given bot token. Running locally while VPS is active causes 401 errors on the VPS.
- **Auth model**: Commands are authorized by matching sender's numeric chat ID against `telegram_chat_id` in config. Username matching also supported as fallback.
- **Graceful degradation**: If polling fails (e.g., invalid token, conflict), the error handler stops polling after 3 failures. The rest of the bot continues running normally.

---

## [1.1.0] - 2026-02-09

### Performance Analytics & Tracking System

Adds a comprehensive analytics layer for tracking position performance, calculating metrics, and enabling data-driven strategy refinement.

### Added — Analytics

- **Analytics Engine** (`src/analytics/`)
  - `types.ts` — Type definitions (PositionSnapshot, RebalanceAnalytics, GasUsageData, RebalanceMetrics)
  - `collector.ts` — Data capture orchestrator (snapshots every cycle, full analytics at rebalance)
  - `metrics.ts` — Performance calculations (Impermanent Loss, Fee APR, Capital Efficiency, Net ROI, Time-in-Range)
  - `storage.ts` — JSON Lines persistence with daily rotation (`analytics/analytics-YYYY-MM-DD.jsonl`)
  - `cache.ts` — In-memory cache for fast CLI queries (last 100 rebalances, latest snapshots per position)

- **CLI Dashboard** (`src/analytics-cli.ts`)
  - `npm run analytics summary` — Overall performance across all positions
  - `npm run analytics status [tokenId]` — Position status report with metrics
  - `npm run analytics history [tokenId]` — Rebalance timeline with gas breakdown

- **Gas Tracking**
  - Actual gas used extracted from transaction receipts for every rebalance step
  - Per-step breakdown: collectFees, decreaseLiquidity, collectTokens, burn, swap, mint
  - Total gas cost in PLS calculated from actual receipt data

- **Key Metrics Tracked**
  - Fee APR (annualized): `(fees / capital) * (365 / days) * 100%`
  - Impermanent Loss vs HODL: `2*sqrt(priceRatio) / (1 + priceRatio) - 1`
  - Net ROI: `(fees - gas) / capital * 100%`
  - Capital Efficiency Ratio: `fullRange / positionWidth`
  - Time-in-Range: Estimated from periodic snapshots
  - Fees-to-Cost Ratio: `feesCollected / gasCost`

- **Configuration** (`config.yaml`)

  ```yaml
  analytics:
    enabled: true
    snapshot_interval_minutes: 10
    persist_to_disk: true
    storage_path: "./analytics"
  ```

### Changed — Analytics Integration

- `src/types.ts` — Added `AnalyticsConfig` interface; added `gasUsed: bigint` to `CollectResult`, `RemoveLiquidityResult`, `SwapResult`, `MintResult`
- `src/configLoader.ts` — Loads analytics config with sensible defaults (disabled by default when section omitted)
- `src/index.ts` — Initializes `AnalyticsCollector`, captures position snapshots every monitoring cycle
- `src/rebalancer.ts` — Accepts analytics collector, extracts gas data from receipts, captures full analytics after successful rebalance
- `src/swap.ts` — Returns `gasUsed` from swap transaction receipts
- `.gitignore` — Added `analytics/` directory (runtime data, not source)
- `package.json` — Added `analytics`, `analytics:status`, `analytics:history`, `analytics:summary` scripts

### Design Principles

- **Opt-in**: Analytics disabled by default when config section is omitted; zero overhead when off
- **Non-blocking**: All analytics failures caught and logged as warnings, never crash the bot
- **No new dependencies**: Uses only Node.js built-ins (fs, path, crypto)
- **Production safe**: No breaking changes to v1.0.0; existing config.yaml works without analytics section
- **Lightweight**: Snapshots ~500 bytes, rebalance records ~2-3 KB; ~2-5 MB/month per position

---

## [1.0.0] - 2026-02-09

### 🎉 Initial Production Deployment

First stable release deployed to DigitalOcean VPS.

### Added
- **Core Rebalancing Logic**
  - 7-step rebalance workflow (remove liquidity, collect fees, swap, mint new position)
  - "Pulse" strategy with configurable width and trigger distance
  - Safe mode: revert to old position on failure
  - Rebalance cooldown (5 minutes default)
  - Gas price checks (max 2000 gwei default)
  - Slippage protection (1% default)

- **Monitoring System**
  - Configurable polling interval (30 seconds default)
  - Multi-position support (configured via YAML)
  - Position status tracking (in/out of range, liquidity, tick)
  - Graceful shutdown on SIGINT/SIGTERM

- **RPC Resilience**
  - Multi-provider fallback (3 RPC endpoints)
  - Automatic failover on connection errors
  - Network validation on startup

- **Logging**
  - Winston JSON logs (rebalancer.log, error.log)
  - PM2 stdout/stderr logs with rotation
  - Colorized console output for development
  - Structured log format with timestamps

- **Notifications**
  - Telegram bot integration
  - Discord webhook support (optional)
  - Rebalance success/failure alerts
  - Position status updates

- **Configuration**
  - YAML-based runtime configuration (config.yaml)
  - Environment variable support (.env)
  - Dry-run mode for safe testing
  - Per-position strategy parameters

- **Deployment Infrastructure**
  - PM2 ecosystem config (ecosystem.config.cjs)
  - Automated deployment script (scripts/deploy.sh)
  - Manual deployment guide (DEPLOY_MANUAL.md)
  - Health check script (check-9mm-health.sh)
  - Operations guide (OPERATIONS.md)

- **Documentation**
  - Comprehensive README with 9mm V3 differences
  - Architecture documentation (ARCHITECTURE.md)
  - Project status tracker (STATUS.md)
  - Troubleshooting guide (TROUBLESHOOTING.md)
  - Deployment manual (DEPLOY_MANUAL.md)

- **9mm V3 Integration**
  - Verified contract addresses from production
  - Correct fee tier mapping (MEDIUM = 2500, not 3000)
  - Proper tick spacing (50 for MEDIUM tier)
  - PulseChain-specific configuration (Chain ID 369)

### Configuration
```yaml
# Initial production settings
polling_interval_seconds: 30
max_gas_price_gwei: 2000
dry_run: true  # Safe testing mode
slippage_tolerance_bps: 100  # 1%
rebalance_cooldown_seconds: 300  # 5 minutes
```

### Deployment Details
- **VPS**: DigitalOcean Ubuntu 24.04 LTS
- **IP**: 143.110.130.198
- **Node.js**: v22.22.0
- **PM2**: v6.0.14
- **Auto-restart**: Enabled (crashes + reboots)
- **Log Rotation**: Enabled (10MB max, 10 files)

### Known Issues
- Position #155181 shows zero liquidity (requires investigation)
- See [STATUS.md](./STATUS.md) for current status

---

## [Unreleased]

### Planned Features
- [ ] Multi-position monitoring (concurrent)
- [ ] Advanced rebalancing strategies (time-weighted, volatility-based)
- [ ] Backtesting framework
- [ ] Gas optimization (batch operations)
- [ ] Grafana/Prometheus metrics export
- [x] ~~Web dashboard~~ — Added in v1.3.0
- [ ] SMS notifications (Twilio integration)
- [ ] Automated testing suite
- [ ] CI/CD pipeline (GitHub Actions)
- [ ] Docker containerization

### Potential Improvements

- [ ] Implement automatic log rotation for Winston logs
- [x] ~~Add position performance metrics (fees collected, IL, APR)~~ — Added in v1.1.0
- [ ] Support for limit orders / concentrated liquidity strategies
- [ ] Integration with 9mm V3 GraphQL API for historical data
- [ ] Optimize RPC calls (batching, caching)
- [ ] Add support for multiple wallets
- [x] ~~Emergency stop mechanism (kill switch)~~ — Added in v1.2.0 via Telegram `/disable` command
- [ ] Rebalance simulation / dry-run API

---

## Version History

| Version | Date | Status | Notes |
|---------|------|--------|-------|
| 1.9.0 | 2026-02-26 | ✅ Current | Analytics deep dive: exec cost tracking, health score, volatility, chain viz, export |
| 1.8.0 | 2026-02-23 | ✅ Stable | Rebalance Now button, security audit fixes (6 findings) |
| 1.7.0 | 2026-02-23 | ✅ Stable | 5 critical rebalance bug fixes (mint slippage, nonce, WPLS, TWAP, swap parse) |
| 1.6.2 | 2026-02-17 | ✅ Stable | Q192 math fix, recovery swap step |
| 1.6.0 | 2026-02-11 | ✅ Stable | RPC resilience, confirmation delay, dynamic providers |
| 1.5.0 | 2026-02-10 | ✅ Stable | DEX aggregator, width presets, wallet rotation |
| 1.4.0 | 2026-02-10 | ✅ Stable | Analytics dashboard, charts, P&L, health scores, recovery UI |
| 1.3.2 | 2026-02-10 | ✅ Stable | Telegram /status timeout fix, HTML parse mode |
| 1.3.1 | 2026-02-10 | ✅ Stable | Safe mode RPC resilience fix |
| 1.3.0 | 2026-02-10 | ✅ Stable | Web dashboard, prices, fee collection, history |
| 1.2.0 | 2026-02-09 | ✅ Stable | Two-way Telegram commands & emergency stop |
| 1.1.0 | 2026-02-09 | ✅ Stable | Performance analytics & tracking |
| 1.0.0 | 2026-02-09 | ✅ Stable | Initial production deployment |
| 0.1.0 | 2026-02-07 | 🧪 Beta | Local development & testing |

---

## Migration Guides

### Upgrading to 1.0.0
No migration needed (initial release).

---

## Breaking Changes

### 1.0.0
- Initial release - no breaking changes

---

## Security Updates

### 1.0.0
- Secure private key storage (.env with 600 permissions)
- Input validation on configuration
- Safe transaction handling with revert logic

---

## Performance

### 1.0.0 Benchmarks
- **Memory Usage**: ~85 MB (stable)
- **CPU Usage**: < 1% (idle), ~5-10% (rebalancing)
- **Startup Time**: ~2-3 seconds
- **Monitoring Latency**: ~1-2 seconds per position check
- **Rebalance Duration**: ~30-60 seconds (7 transactions)

---

## Dependencies

### Core Dependencies (1.0.0)
```json
{
  "ethers": "^6.13.0",
  "winston": "^3.14.0",
  "dotenv": "^16.4.0",
  "yaml": "^2.5.0",
  "axios": "^1.7.0"
}
```

### Dev Dependencies (1.0.0)
```json
{
  "typescript": "^5.6.0",
  "tsx": "^4.19.0",
  "@types/node": "^22.0.0"
}
```

---

## Contributors

- **Tyler** ([@TylerB007](https://github.com/TylerB007)) - Project owner & maintainer
- **Claude** (Anthropic) - Architecture design & deployment automation

---

## Release Process

### For Maintainers

1. **Update Version**
   ```bash
   npm version <major|minor|patch>
   # Updates package.json and creates git tag
   ```

2. **Update CHANGELOG.md**
   - Move items from [Unreleased] to new version section
   - Add date and version number
   - List all changes under appropriate categories

3. **Update Documentation**
   - Update STATUS.md with new deployment info
   - Update README.md if public API changed
   - Update ARCHITECTURE.md if design changed

4. **Commit & Tag**
   ```bash
   git add .
   git commit -m "chore: release v1.0.0"
   git tag -a v1.0.0 -m "Release v1.0.0"
   git push origin main --tags
   ```

5. **Deploy to Production**
   ```bash
   ssh root@143.110.130.198
   cd ~/9mm-rebalancer
   bash scripts/deploy.sh
   ```

6. **Verify Deployment**
   ```bash
   pm2 list
   pm2 logs 9mm-rebalancer --lines 50
   ~/check-9mm-health.sh
   ```

---

## Support

For questions, issues, or feature requests:
- **GitHub Issues**: https://github.com/TylerB007/ALM-For-9MM-Pulsechain/issues
- **Documentation**: See [README.md](./README.md) and [TROUBLESHOOTING.md](./TROUBLESHOOTING.md)

---

**Maintained by**: Tyler ([@TylerB007](https://github.com/TylerB007))
**License**: See [LICENSE](./LICENSE) file

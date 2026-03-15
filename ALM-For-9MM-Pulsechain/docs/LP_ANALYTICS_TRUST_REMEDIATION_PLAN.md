# LP Analytics Trust Remediation Plan

## Purpose

This document defines the implementation plan to make LP profitability analytics trustworthy, consistent, and end to end across the full lifecycle of a position:

- original LP entry
- fee accrual while active
- rebalance event
- new NFT / new pool interval
- continued performance across the full chain of successor positions

This plan is based on verified findings from the current codebase and informed by external research sources in:

- `docs/research/DEFI_LIQUIDITY_DEV_MASTER_INDEX.md`
- `docs/research/Research_Chain_Master_Source.md`

Those external sources are inputs for design options and validation patterns. They are not mandatory dependencies.

## Non-Negotiable Outcome

After this work, a user must be able to answer all of the following from the product UI and exported data without ambiguity:

1. What is my current position worth right now?
2. How much have I earned in claimed fees and unclaimed fees?
3. How much have I spent on gas, swap fees, slippage, price impact, and dust?
4. Am I profitable on the current interval?
5. Am I profitable across the full lifecycle from original position to current successor NFT?
6. Am I outperforming or underperforming HODL?
7. Did each rebalance recover its cost, and if so how quickly?
8. Which values are exact, which are approximations, and which are unavailable?

## Verified Current-State Findings

These findings are based on the current implementation, not assumptions.

### 1. Analytics exist, but lifetime profitability is fragmented

Verified in:

- `src/server/routes/analytics.ts`
- `src/analytics/chain.ts`
- `src/web/src/pages/PositionAnalytics.tsx`
- `src/web/src/pages/PositionChain.tsx`

Current state:

- The app captures snapshots, rebalances, fee collections, entries, and chain links.
- The current position analytics page is scoped to the active token ID.
- The chain page shows lineage and summary metrics, but not a canonical lifetime PnL ledger.

Impact:

- A user can inspect pieces of profitability, but cannot rely on one authoritative end-to-end answer.

### 2. Rebalance profitability math mixes incompatible units

Verified in `src/analytics/metrics.ts`.

Current state:

- Fees and capital are converted to token0-equivalent.
- Gas cost is stored in chain native units and then directly subtracted from token0-equivalent values in multiple calculations.

Impact:

- Metrics such as `feesToCostRatio`, `netROIPercent`, `trueNetROIPercent`, and `rebalanceCostPercent` are only approximately valid when token0 is the native wrapped asset.
- On multi-chain and non-native-token pairs, they are not trustworthy.

### 3. Retrospective recovery metrics can overcount earnings

Verified in `src/analytics/retrospective.ts`.

Current state:

- Post-rebalance recovery windows can count rebalance records tied to either `oldTokenId` or `newTokenId`.

Impact:

- `feesEarned1dUsd`, `feesEarned3dUsd`, `feesEarned7dUsd`, `actualDaysToRecovery`, and `recoveredBeforeNextRebalance` can be inflated.

### 4. Current IL is approximate, not exact concentrated-liquidity accounting

Verified in:

- `src/analytics/metrics.ts`
- `src/server/routes/analytics.ts`
- `src/analytics/collector.ts`

Current state:

- IL is derived from a simplified price-ratio formula.
- It does not model exact V3 composition by range state and successor-position history.

Impact:

- The current IL metric is directionally useful, but too approximate to support an authoritative profitability answer.

### 5. Snapshot history can lose historical valuation fidelity permanently

Verified in:

- `src/index.ts`
- `src/analytics/collector.ts`
- `src/pricing/backfill.ts`

Current state:

- Rebalance, entry, and lifecycle records can be queued for price backfill.
- Snapshots are not queued for price backfill when prices are missing at write time.

Impact:

- Snapshot-based value history, HODL comparisons, and time-series analytics can contain permanent zero-price holes after price feed outages.

### 6. UI messaging still overstates confidence

Verified in `src/web/src/pages/PositionAnalytics.tsx`.

Current state:

- The UI declares `Profitable` or `Unprofitable` using `netPnlUsd`, which is fees minus gas.
- That is not the same as true total profitability when swap friction, principal movement, dust, and lifecycle basis are included.

Impact:

- Users can be told they are profitable when their true lifetime chain outcome is negative.

### 7. Important recovery and break-even fields are not surfaced to the user

Verified in:

- `src/analytics/collector.ts`
- `src/server/routes/analytics.ts`
- `src/web/src/**`

Current state:

- The system computes estimated and retrospective rebalance recovery fields.
- These fields are not exposed in the main UI workflows.

Impact:

- Users cannot inspect whether a rebalance actually paid for itself.

## Design Principles

### 1. One canonical financial ledger

There must be exactly one authoritative profitability model for LP analytics. All API routes, dashboard summaries, chain views, exports, notifications, and health scores must derive from the same canonical ledger.

### 2. Event-time valuation first

All irreversible events must be valued at event-time prices, then stored. Live price recomputation is allowed only for current valuation, never for historical event replacement.

### 3. Distinguish exact vs estimated metrics

Each user-facing metric must be labeled as one of:

- exact
- historically anchored
- estimated
- unavailable

No approximate metric should be presented as if it were authoritative.

### 4. Lifetime chain and current interval are different views

The system must support both:

- current interval analytics for the active NFT only
- lifetime chain analytics across all successor NFTs

These views must never be conflated.

### 5. Multi-chain correctness over convenience

No profitability formula may mix token0 units, native gas units, and USD units in one calculation. Base accounting must be USD for cross-asset and cross-chain comparability.

## Optional External Design Patterns To Borrow

These are options, not requirements.

### Revert Finance

Potential use:

- historical pool state reconstruction
- LP PnL benchmarking
- backtesting conventions

Best fit here:

- validating lifetime LP-vs-HODL methodology
- testing rebalance cost recovery and interval-level profitability logic

### Gamma Strategies

Potential use:

- lineage-aware LP management patterns
- advanced LP performance framing beyond raw fee income

Best fit here:

- chain-level profitability presentation
- richer LP-vs-HODL and active-management attribution

### Arrakis Finance

Potential use:

- vault-style state transition accounting
- clearer treatment of lifecycle performance vs current state

Best fit here:

- canonical event ledger design
- rebalance attribution and state-transition reporting

### Aperture Finance

Potential use:

- intent-level profitability criteria
- cost-aware action gating

Best fit here:

- later phase integration with rebalance decisioning, not the base analytics fix

### Messari / The Graph / Dune / DefiLlama

Potential use:

- enrichment
- cross-checking
- backfills
- normalized metadata

Best fit here:

- resilience for price and pool-context backfills
- audit and reconciliation tooling

## Target Architecture

## A. Canonical LP Profitability Ledger

Introduce a canonical ledger abstraction per position lineage.

Suggested model:

- `lineageId`
- `rootTokenId`
- `chainId`
- `pair`
- `entryEvents[]`
- `rebalanceEvents[]`
- `feeCollectionEvents[]`
- `snapshotValuations[]`
- `currentIntervalSummary`
- `lifetimeSummary`

Each ledger event must store:

- event timestamp
- token amounts
- event-time USD prices
- native-token USD price
- exact gas cost in native and USD
- swap fee cost USD
- price impact USD
- dust USD
- source and confidence of prices

### Ledger invariants

1. Every active token belongs to exactly one lineage.
2. Every rebalance closes one interval and opens the next.
3. An interval PnL cannot include fees earned before its entry event.
4. Lifetime PnL is computed from the full lineage, not by summing percentages.
5. Percent returns are always derived from absolute USD values, never accumulated directly.

## B. Two Explicit Profitability Surfaces

### Current Interval View

For the active NFT only:

- current value
- current unclaimed fees
- claimed fees during current interval
- interval gas cost
- interval swap friction
- interval true PnL
- interval LP vs HODL

### Lifetime Chain View

For the root token through the current NFT:

- original capital deployed
- cumulative claimed fees
- current unclaimed fees
- cumulative gas
- cumulative swap friction
- cumulative dust
- lifetime true PnL
- lifetime return percent
- lifetime LP vs HODL
- rebalance-by-rebalance recovery outcomes

## C. Metric Trust Labels

Add trust labels to relevant API and UI fields:

- `exact`
- `event_time_exact`
- `estimated`
- `backfilled`
- `approximate`
- `missing`

Example:

- fee collection USD at event time: `event_time_exact`
- current position value with live price: `exact`
- IL using simplified formula: `approximate`
- snapshot value missing price: `missing`

## Implementation Plan

## Phase 0: Lock the semantics before coding

Goal:

- define exact business meaning for each user-facing profitability field

Required outputs:

1. Canonical glossary of metrics
2. Exact formulas for each metric
3. Explicit list of deprecated or approximate metrics

Deliverables:

- `docs/LP_ANALYTICS_METRIC_SPEC.md`
- `docs/LP_ANALYTICS_LEDGER_SPEC.md`

Acceptance criteria:

- No field named `profit`, `pnl`, `roi`, or `il` exists without a spec definition.
- Every dashboard metric can be traced back to one ledger formula.

## Phase 1: Introduce lineage-first identity

Goal:

- stop treating token ID as the only profitability identity

Implementation:

1. Extend analytics records with lineage metadata.
2. Backfill lineage links from existing rebalance records and manual links.
3. Add helper APIs to fetch lineage by token ID.

Needed changes:

- analytics types
- storage helpers
- chain builder
- analytics routes

Acceptance criteria:

- Any active token ID can resolve to a stable root lineage.
- Lifetime aggregation never depends on summing isolated current-token datasets.

## Phase 2: Build canonical USD ledger calculations

Goal:

- eliminate mixed-unit profitability math

Implementation:

1. Move all profitability base math to USD.
2. Keep token0-equivalent metrics only as optional secondary diagnostics.
3. Replace per-rebalance ROI calculations with:
   - fees earned USD
   - gas cost USD
   - swap fee USD
   - price impact USD
   - dust USD
   - interval true PnL USD
   - interval return percent derived from interval entry cost USD
4. Replace chain aggregate ROI with absolute cumulative USD totals plus a derived percent from original basis.

Acceptance criteria:

- No profitability function subtracts native gas units from token0-equivalent values.
- All user-facing profitability fields reconcile to USD totals.

## Phase 3: Correct retrospective rebalance recovery accounting

Goal:

- make rebalance payoff analysis exact within available data

Implementation:

1. Redefine post-rebalance earnings windows so they begin at the child position entry.
2. Exclude the opening rebalance's own fee collection from child recovery earnings.
3. Define recovery against total rebalance loss in USD.
4. Surface:
   - estimated break-even days
   - actual days to recovery
   - recovered before next rebalance

Acceptance criteria:

- A rebalance cannot count its own collected fees as post-open recovery.
- Recovered/not recovered status matches event chronology exactly.

## Phase 4: Add snapshot price backfill parity

Goal:

- preserve historical valuation continuity when live pricing fails

Implementation:

1. Extend snapshot records with backfill metadata fields.
2. Queue snapshots with missing price data for backfill.
3. Update snapshot time series once price data resolves.
4. Add integrity checks for snapshot price completeness over configurable windows.

Acceptance criteria:

- Missing price snapshots are either backfilled or explicitly marked permanently missing.
- Time-series charts can distinguish missing data from zero values.

## Phase 5: Replace approximate IL with exact or explicitly-scoped analytics

Goal:

- stop overstating confidence in IL-based profitability metrics

Preferred implementation:

1. Add exact range-aware LP-vs-HODL accounting for current interval and lifetime chain.
2. Keep the existing simplified IL only as a secondary approximation if exact IL is not yet feasible.
3. Rename the simplified metric if retained, for example `approxImpermanentLossPercent`.

Acceptance criteria:

- The UI does not present approximate IL as a final profitability answer.
- True PnL is not dependent on a simplified IL formula.

## Phase 6: Rebuild the UI around explicit trust boundaries

Goal:

- make profitability understandable and defensible to a user

Required UI changes:

1. Position Analytics page:
   - split into `Current Interval` and `Lifetime Chain`
   - show basis, fees, costs, net outcome, and LP vs HODL separately
2. Position Chain page:
   - replace cumulative summed ROI with lifetime chain ledger totals
   - add per-link recovery status
3. Dashboard:
   - display portfolio true PnL and portfolio LP vs HODL from canonical lineage totals
4. Labels:
   - replace raw `Profitable / Unprofitable` banner with trust-aware status
   - for example: `Current interval profitable`, `Lifetime chain unprofitable`, `insufficient historical basis`

Acceptance criteria:

- The UI can show whether a position is currently profitable, lifetime profitable, both, or neither.
- The user can see why.

## Phase 7: Add reconciliation and integrity tooling

Goal:

- continuously prove that analytics remain trustworthy

Implementation:

1. Extend integrity checks to cover:
   - lineage continuity
   - interval boundaries
   - no self-counted recovery earnings
   - price completeness for snapshots and entries
   - lifetime totals reconciling from raw events
2. Add a reconciliation route or CLI command that emits:
   - event totals
   - ledger totals
   - variance report

Acceptance criteria:

- The system can detect drift between raw records and presented profitability.
- Production analytics can be audited without manual log digging.

## Data Model Changes

Suggested additions:

### RebalanceAnalytics

- `lineageId`
- `intervalEntryCostUsd`
- `intervalTruePnlUsd`
- `intervalReturnPercent`
- `lifetimeCapitalBasisUsd` optional at time of write if available
- `metricConfidence`

### PositionSnapshot

- `lineageId`
- `priceStatus`
- `valuationConfidence`
- `currentIntervalId`

### PositionEntryRecord

- `lineageId`
- `intervalId`
- `basisType` such as `root_entry`, `rebalance_entry`, `manual_backfill`

### New derived ledger record

- `LineageProfitabilitySummary`
- `IntervalProfitabilitySummary`

These may be persisted or built on read. Build-on-read is acceptable initially if performance remains reasonable.

## Calculation Rules

### Canonical absolute fields

The base financial truth should be:

- `currentValueUsd`
- `claimedFeesUsd`
- `unclaimedFeesUsd`
- `gasCostUsd`
- `swapFeeCostUsd`
- `priceImpactCostUsd`
- `dustUsd`
- `totalCostsUsd`
- `entryBasisUsd`
- `hodlValueUsd`

### Canonical derived fields

- `truePnlUsd = currentValueUsd + claimedFeesUsd + unclaimedFeesUsd - entryBasisUsd - totalCostsUsd`
- `truePnlPercent = truePnlUsd / entryBasisUsd * 100`
- `lpVsHodlUsd = currentValueUsd + claimedFeesUsd + unclaimedFeesUsd - totalCostsUsd - hodlValueUsd`
- `lpVsHodlPercent = lpVsHodlUsd / hodlValueUsd * 100`

### Rules for percentages

1. Never add ROI percentages across intervals.
2. Always recompute percent return from an absolute USD numerator and basis denominator.
3. If basis is missing, percent return is unavailable, not zero.

## Edge Cases To Handle Explicitly

1. Positions created before entry tracking existed
2. Missing price data at event time
3. Manual fee collections
4. Manual chain links with incomplete financial data
5. Rebalances with no swap step
6. One-sided positions
7. Burned positions awaiting recovery
8. RPC outages causing snapshot gaps
9. Current position removed from config but historical chain still exists
10. Native token price unavailable at fee collection time

For each edge case, the API should return explicit confidence or degraded-state metadata rather than silently substituting misleading values.

## Test Plan

Add a dedicated end-to-end analytics test matrix.

### Unit tests

1. interval true PnL math in USD
2. lifetime chain aggregation from absolute values
3. recovery window logic without self-counting opening rebalance fees
4. snapshot price backfill propagation
5. trust-label assignment

### Integration tests

1. root position -> rebalance -> child position -> manual fee collection -> second rebalance
2. multi-chain pair where token0 is not the native wrapped asset
3. missing entry basis with first-priced-snapshot fallback
4. manual chain link inserted into lineage
5. permanently missing price data

### Integrity checks

1. rebalances older than 7 days have retrospective fields or explicit status
2. lifetime totals reconcile to event sums
3. dashboard portfolio totals reconcile to per-lineage totals

## Recommended Build Order

To maximize certainty and payoff, implement in this order:

1. metric spec and ledger spec
2. lineage-first identity model
3. USD-only profitability math
4. retrospective recovery fix
5. snapshot price backfill parity
6. UI split between current interval and lifetime chain
7. integrity and reconciliation tooling

This ordering is efficient because it fixes the accounting core before UI work and avoids rewriting presentation twice.

## What Not To Do

1. Do not add more derived metrics before fixing the base ledger.
2. Do not keep summing percent returns across chain links.
3. Do not market approximate IL as exact profitability.
4. Do not let the UI continue to declare profitability from fees-minus-gas alone once lifetime true PnL exists.
5. Do not depend on external subgraphs or third-party APIs as the sole truth source.

## Definition Of Done

This work is done only when all of the following are true:

1. A user can open one page and see both current interval and lifetime chain profitability.
2. Lifetime chain profitability is computed from absolute USD values over the full lineage.
3. Rebalance recovery metrics are chronologically correct.
4. Missing prices are surfaced with explicit confidence state.
5. Dashboard and chain views reconcile to the same canonical ledger totals.
6. Tests cover the edge cases listed above.
7. Integrity checks can detect drift or broken backfills before users are misled.

## Immediate Next Deliverables

The next implementation artifacts should be:

1. `docs/LP_ANALYTICS_METRIC_SPEC.md`
2. `docs/LP_ANALYTICS_LEDGER_SPEC.md`
3. code changes for lineage-first identity and USD-only profitability math
4. regression tests for retrospective recovery and chain aggregation

Until those are in place, the current analytics should be treated as useful but not yet fully authoritative for end-to-end profitability.

## Related Documents

- `docs/LP_ANALYTICS_METRIC_SPEC.md`
- `docs/LP_ANALYTICS_LEDGER_SPEC.md`
- `docs/FUTURE_UPGRADES_ROADMAP.md`
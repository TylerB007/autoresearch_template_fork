# LP Analytics Metric Specification

## Purpose

This document defines the canonical meaning, formula, trust level, and usage rules for LP analytics metrics in this repository.

It exists to prevent three recurring classes of failure:

1. different routes calculating the same metric differently
2. mixing incompatible units such as token0-equivalent, native gas units, and USD
3. presenting approximate metrics as if they were authoritative

This spec is the source of truth for:

- backend analytics calculations
- dashboard summaries
- position analytics pages
- position chain pages
- CSV and JSON exports
- notifications
- integrity checks

## Scope

This spec covers two levels of analytics:

1. `Current Interval`
This is the currently active NFT position only.

2. `Lifetime Chain`
This is the root LP entry through all successor NFTs created by rebalances.

These views must remain separate.

## Core Principles

### 1. Base accounting currency is USD

All canonical profitability metrics must be computed in USD.

Allowed secondary display metrics:

- token0-equivalent
- native-token-equivalent
- raw token amounts

These secondary metrics are diagnostics only. They cannot be the canonical basis for profitability.

### 2. Event-time values are authoritative

Any irreversible event must persist event-time valuation fields at write time when available.

Examples:

- fee collection
- rebalance execution
- new interval entry
- swap step

If event-time price data is missing, the metric must be marked degraded and optionally backfilled later.

### 3. Percentages are always derived from absolute values

Return percentages must never be accumulated by summation.

Always derive a percent from:

- numerator in USD
- denominator in USD

### 4. Missing data is not zero

If a field cannot be computed, it must be `null` or explicitly marked unavailable.

It must not default silently to zero in user-facing profitability outputs.

## Metric Trust Levels

Every user-facing metric must carry an internal trust classification.

### `exact`

- Derived from exact on-chain amounts and exact live values at current time
- Example: current value of current position using current token balances and current live prices

### `event_time_exact`

- Derived from exact on-chain amounts captured at event time and valued with event-time prices
- Example: fee collection USD at the time it occurred

### `backfilled`

- Missing at event time, later filled from a historical or secondary source

### `estimated`

- Derived using a model rather than exact event accounting
- Example: projected break-even days

### `approximate`

- Directionally useful but not financially authoritative
- Example: simplified IL approximation from price ratio alone

### `missing`

- Required data unavailable

## Canonical Metric Groups

## A. Position Value Metrics

### `currentValueUsd`

Meaning:

- USD value of the currently active LP position, excluding unclaimed fees unless those are explicitly represented in token balances

Formula:

- `currentValueUsd = amount0_current * price0_live + amount1_current * price1_live`

Level:

- current interval only

Trust:

- `exact` when live prices are available
- `missing` otherwise

Notes:

- This is a snapshot-of-now metric.
- It is not lifetime profitability.

### `currentUnclaimedFeesUsd`

Meaning:

- USD value of fees currently claimable by the active position

Formula:

- `currentUnclaimedFeesUsd = unclaimed_fee0 * price0_live + unclaimed_fee1 * price1_live`

Trust:

- `exact` when live prices are available
- `missing` otherwise

## B. Claimed Fee Metrics

### `claimedFeesUsd`

Meaning:

- Sum of all fee collection events already realized in a scope

Scope variants:

- `claimedFeesUsdCurrentInterval`
- `claimedFeesUsdLifetimeChain`

Formula:

- sum of stored event-time USD values for all eligible fee collection events in scope

Trust:

- `event_time_exact` when recorded at event time
- `backfilled` if later backfilled

Rules:

1. Do not recalculate historical claimed fees using current prices if event-time USD exists.
2. Manual fee collections and rebalance fee collections must both be included.
3. The same fee collection event must never be counted twice.

## C. Cost Metrics

### `gasCostUsd`

Meaning:

- USD cost of gas consumed within a scope

Scope variants:

- per event
- current interval cumulative
- lifetime chain cumulative

Formula:

- `gasCostUsd = gas_cost_native * native_token_price_at_event`

Trust:

- `event_time_exact` when event-time native price exists
- `backfilled` if filled later
- `missing` if native price cannot be resolved

Rules:

1. Never substitute current live native price for historical event cost in canonical outputs.
2. If only current live native price exists, store that result separately as non-canonical fallback.

### `swapFeeCostUsd`

Meaning:

- Explicit pool or route fee paid during rebalance swap execution

Trust:

- `event_time_exact` or `estimated`, depending on source

Rules:

1. Must be separated from price impact.
2. Must be included in total costs.

### `priceImpactCostUsd`

Meaning:

- Economic loss due to execution moving the realized price away from the reference fair price

Trust:

- `estimated` unless exact route decomposition is available

### `dustUsd`

Meaning:

- USD value of leftover capital not deployed into the successor position after rebalance

Trust:

- `event_time_exact` when event-time prices exist

### `totalCostsUsd`

Meaning:

- Total explicit and implicit execution cost in a scope

Canonical formula:

- `totalCostsUsd = gasCostUsd + swapFeeCostUsd + priceImpactCostUsd + dustUsd`

Rules:

1. If any component is unavailable, expose component nullability explicitly.
2. Canonical `totalCostsUsd` should be `null` if a required component is missing and no approved fallback exists.

## D. Basis Metrics

### `entryBasisUsd`

Meaning:

- Capital basis used to evaluate profitability for a scope

Scope variants:

- `currentIntervalEntryBasisUsd`
- `lifetimeChainEntryBasisUsd`

Rules:

1. Current interval basis is the entry cost of the current NFT interval.
2. Lifetime chain basis is the original root entry cost.
3. Rebalance-created child intervals must not overwrite root lifetime basis.
4. If basis is unknown, return `null`, not zero.

Trust:

- `event_time_exact` when recorded from entry record
- `backfilled` when reconstructed later
- `approximate` only for legacy fallback from first priced snapshot

## E. HODL Comparison Metrics

### `hodlValueUsd`

Meaning:

- Value now if the relevant basis token quantities had simply been held rather than LPed

Scope variants:

- current interval HODL benchmark
- lifetime chain HODL benchmark

Formula:

- `hodlValueUsd = basis_amount0 * price0_live + basis_amount1 * price1_live`

Rules:

1. The token quantities used must correspond to the chosen basis scope.
2. Current interval and lifetime chain HODL must not be mixed.

Trust:

- `exact` if basis quantities and live prices exist
- degraded otherwise according to missing parts

## F. Canonical Profitability Metrics

### `truePnlUsd`

Meaning:

- The canonical profitability metric for a scope

Current interval formula:

- `truePnlUsd = currentValueUsd + claimedFeesUsdCurrentInterval + currentUnclaimedFeesUsd - currentIntervalEntryBasisUsd - totalCostsUsdCurrentInterval`

Lifetime chain formula:

- `truePnlUsd = currentValueUsd + claimedFeesUsdLifetimeChain + currentUnclaimedFeesUsd - lifetimeChainEntryBasisUsd - totalCostsUsdLifetimeChain`

Trust:

- equal to the weakest trust level among required components

Rules:

1. This is the canonical profitability answer.
2. Any UI label `Profitable` or `Unprofitable` must be based on this field when available.

### `truePnlPercent`

Meaning:

- Percent return on basis for the chosen scope

Formula:

- `truePnlPercent = truePnlUsd / entryBasisUsd * 100`

Rules:

1. If `entryBasisUsd` is null or non-positive, this field is null.
2. Never sum this field across intervals.

### `lpVsHodlUsd`

Meaning:

- LP strategy outperformance or underperformance versus simply holding the basis token amounts

Formula:

- `lpVsHodlUsd = currentValueUsd + claimedFeesUsd + currentUnclaimedFeesUsd - totalCostsUsd - hodlValueUsd`

### `lpVsHodlPercent`

Formula:

- `lpVsHodlPercent = lpVsHodlUsd / hodlValueUsd * 100`

Rules:

1. If `hodlValueUsd` is unavailable or zero, this field is null.

## G. Interval Performance Metrics

### `intervalTruePnlUsd`

Meaning:

- True PnL for a single interval bounded by:
  - interval entry
  - next rebalance or current time

### `intervalReturnPercent`

Meaning:

- interval true return on interval basis

Formula:

- `intervalReturnPercent = intervalTruePnlUsd / currentIntervalEntryBasisUsd * 100`

## H. Rebalance Recovery Metrics

### `rebalanceTotalLossUsd`

Meaning:

- Total loss attributable to the rebalance event itself

Formula:

- `rebalanceTotalLossUsd = gasCostUsd + swapFeeCostUsd + priceImpactCostUsd + dustUsd + realizedRebalanceLossUsd`

Notes:

- `realizedRebalanceLossUsd` must be precisely defined in code and documentation.
- If exact concentrated-liquidity realization is not available, do not substitute approximate IL without marking it approximate.

### `estimatedBreakEvenDays`

Meaning:

- Forward-looking estimate of days needed to recover rebalance loss using expected fee accrual

Trust:

- `estimated`

### `actualDaysToRecovery`

Meaning:

- Realized number of days until post-rebalance earned fees covered rebalance loss

Rules:

1. Post-rebalance earnings window begins at child interval entry.
2. Opening rebalance fees must not count as recovery earnings for the child.

### `recoveredBeforeNextRebalance`

Meaning:

- Whether the rebalance paid for itself before the next rebalance of that child position

Trust:

- `event_time_exact` if all required history exists

## I. Non-Canonical Operational Metrics

These may remain in the product, but must not be treated as canonical profitability answers.

### `netIncomeUsd`

Meaning:

- fees minus gas only

Formula:

- `netIncomeUsd = claimedFeesUsd + currentUnclaimedFeesUsd - gasCostUsd`

Rules:

1. This is not true PnL.
2. UI must label it clearly as `Net Income`, not `Profitability`.

### `approxImpermanentLossPercent`

Meaning:

- approximate IL derived from simplified formula

Rules:

1. Must be labeled approximate.
2. Must not determine the final profitable/unprofitable status alone.

## Deprecations

The following patterns are prohibited in canonical logic:

1. subtracting native gas units from token0-equivalent values
2. summing ROI percentages across chain links
3. calculating historical fees from live prices when stored event-time USD exists
4. using zero as a fallback for missing basis or missing price data in user-facing PnL

## API Contract Rules

Every profitability response should expose both value and trust metadata.

Recommended shape:

```ts
interface MetricValue<T> {
  value: T | null;
  trust: 'exact' | 'event_time_exact' | 'backfilled' | 'estimated' | 'approximate' | 'missing';
  notes?: string[];
}
```

Example response groups:

- `currentInterval`
- `lifetimeChain`
- `operational`
- `recovery`

## UI Labeling Rules

Allowed user-facing labels:

- `Current Interval True P&L`
- `Lifetime Chain True P&L`
- `LP vs HODL`
- `Net Income`
- `Approximate IL`

Forbidden ambiguous labels:

- `Profit` without scope
- `ROI` without basis scope
- `P&L` without interval vs lifetime distinction

## Health Score Rules

Health score inputs must prefer canonical fields.

Preferred ranking:

1. `truePnlUsd` in scope
2. `truePnlPercent` in scope
3. time in range
4. fee efficiency
5. rebalance cost efficiency
6. approximate IL only as secondary context

Health scoring must not use `netIncomeUsd` as the sole profitability signal when `truePnlUsd` is available.

## Export Rules

CSV and JSON exports must include:

- metric scope
- trust level
- basis fields used
- explicit absolute USD totals

This is required so external analysis reproduces the in-app answer.

## Definition Of Done

This spec is satisfied only when:

1. all user-facing profitability metrics map to a metric in this document
2. each metric has one implementation path
3. the UI distinguishes current interval from lifetime chain
4. canonical profitability is always based on USD absolute values
5. approximate metrics are explicitly marked approximate
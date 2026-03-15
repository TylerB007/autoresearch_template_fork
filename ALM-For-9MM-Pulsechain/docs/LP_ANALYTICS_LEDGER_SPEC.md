# LP Analytics Ledger Specification

## Purpose

This document defines the canonical event ledger and aggregation model required to make LP analytics trustworthy across rebalances and successor NFTs.

The goal is to move from token-ID-local analytics to lineage-aware financial accounting.

## Problem This Solves

In this project, a rebalance burns one NFT and creates another. If analytics are scoped only to the current token ID, users lose the full economic story.

The ledger model solves that by making the canonical identity:

- a `lineage`

and making each NFT only one interval inside that lineage.

## Core Ledger Concepts

## 1. Lineage

A lineage is the full chain of capital transitions from original LP entry to the current active position.

Required fields:

- `lineageId`
- `rootTokenId`
- `chainId`
- `pairKey`
- `createdAt`
- `currentTokenId`
- `status`

### Lineage rules

1. A lineage begins when capital is first deployed into an LP position.
2. A lineage continues through every rebalance-created successor NFT.
3. A lineage ends only when capital is fully exited or explicitly archived.

## 2. Interval

An interval is one active NFT lifecycle bounded by:

- interval entry
- next rebalance or final exit

Required fields:

- `intervalId`
- `lineageId`
- `tokenId`
- `enteredAt`
- `closedAt | null`
- `entryBasisUsd`
- `entryAmount0`
- `entryAmount1`
- `entryPriceUsd0`
- `entryPriceUsd1`
- `status`

### Interval rules

1. Every interval belongs to exactly one lineage.
2. Every active token ID corresponds to exactly one open interval.
3. Interval profitability is always separate from lifetime chain profitability.

## 3. Event

A ledger event is any economic or structural action that changes accounting state.

Supported canonical event types:

- `root_entry`
- `position_entry`
- `snapshot`
- `fee_collection`
- `rebalance_started`
- `rebalance_swap`
- `rebalance_completed`
- `interval_closed`
- `manual_link`
- `recovery_mint`
- `final_exit`

## Canonical Ledger Entities

## A. `LineageRecord`

Suggested shape:

```ts
interface LineageRecord {
  lineageId: string;
  rootTokenId: number;
  currentTokenId: number | null;
  chainId: number;
  pairKey: string;
  createdAt: number;
  closedAt?: number;
  status: 'active' | 'closed' | 'recovery_pending' | 'archived';
}
```

## B. `IntervalRecord`

```ts
interface IntervalRecord {
  intervalId: string;
  lineageId: string;
  tokenId: number;
  chainId: number;
  enteredAt: number;
  closedAt?: number;
  entryBasisUsd: number | null;
  basisTrust: 'event_time_exact' | 'backfilled' | 'approximate' | 'missing';
  entryAmount0: string;
  entryAmount1: string;
  entryPriceUsd0?: number;
  entryPriceUsd1?: number;
  entryNativePriceUsd?: number;
  source: 'root_entry' | 'rebalance_entry' | 'recovery_entry' | 'manual_backfill';
  previousIntervalId?: string;
  nextIntervalId?: string;
  status: 'open' | 'closed' | 'invalid';
}
```

## C. `LedgerEventRecord`

```ts
interface LedgerEventRecord {
  ledgerEventId: string;
  lineageId: string;
  intervalId?: string;
  tokenId?: number;
  eventType:
    | 'root_entry'
    | 'position_entry'
    | 'snapshot'
    | 'fee_collection'
    | 'rebalance_started'
    | 'rebalance_swap'
    | 'rebalance_completed'
    | 'interval_closed'
    | 'manual_link'
    | 'recovery_mint'
    | 'final_exit';
  timestamp: number;
  amounts?: {
    amount0?: string;
    amount1?: string;
    fees0?: string;
    fees1?: string;
  };
  usd?: {
    valueUsd?: number;
    feeValueUsd?: number;
    gasCostUsd?: number;
    swapFeeCostUsd?: number;
    priceImpactCostUsd?: number;
    dustUsd?: number;
  };
  prices?: {
    priceUsd0?: number;
    priceUsd1?: number;
    nativePriceUsd?: number;
  };
  trust: {
    valuation: 'exact' | 'event_time_exact' | 'backfilled' | 'estimated' | 'approximate' | 'missing';
  };
  references?: {
    txHash?: string;
    rebalanceId?: string;
    previousTokenId?: number;
    newTokenId?: number;
  };
}
```

## D. `LineageProfitabilitySummary`

This is the canonical read model for lifetime profitability.

```ts
interface LineageProfitabilitySummary {
  lineageId: string;
  rootTokenId: number;
  currentTokenId: number | null;
  currentValueUsd: number | null;
  claimedFeesUsd: number | null;
  unclaimedFeesUsd: number | null;
  totalGasCostUsd: number | null;
  totalSwapFeeCostUsd: number | null;
  totalPriceImpactCostUsd: number | null;
  totalDustUsd: number | null;
  totalCostsUsd: number | null;
  entryBasisUsd: number | null;
  hodlValueUsd: number | null;
  truePnlUsd: number | null;
  truePnlPercent: number | null;
  lpVsHodlUsd: number | null;
  lpVsHodlPercent: number | null;
  trust: {
    profitability: 'exact' | 'event_time_exact' | 'backfilled' | 'estimated' | 'approximate' | 'missing';
  };
}
```

## E. `IntervalProfitabilitySummary`

This is the canonical read model for the current active interval.

```ts
interface IntervalProfitabilitySummary {
  intervalId: string;
  lineageId: string;
  tokenId: number;
  currentValueUsd: number | null;
  claimedFeesUsd: number | null;
  unclaimedFeesUsd: number | null;
  totalCostsUsd: number | null;
  entryBasisUsd: number | null;
  hodlValueUsd: number | null;
  truePnlUsd: number | null;
  truePnlPercent: number | null;
  lpVsHodlUsd: number | null;
  lpVsHodlPercent: number | null;
  trust: {
    profitability: 'exact' | 'event_time_exact' | 'backfilled' | 'estimated' | 'approximate' | 'missing';
  };
}
```

## Ledger Construction Rules

## 1. Root entry creation

When first capital is deployed into an LP position:

1. create `LineageRecord`
2. create first `IntervalRecord`
3. write `root_entry` event
4. set `rootTokenId = currentTokenId = tokenId`

## 2. Rebalance transition

When a rebalance burns old token A and mints new token B:

1. close old interval
2. write rebalance cost events and final old-interval fee collection
3. create new interval for token B
4. preserve lineage ID
5. update `currentTokenId`

### Rebalance event ordering

Canonical ordering:

1. `rebalance_started`
2. `fee_collection`
3. `interval_closed`
4. `rebalance_swap` if applicable
5. `position_entry`
6. `rebalance_completed`

## 3. Snapshot attachment

Each snapshot must belong to the active interval at the time it is recorded.

Required snapshot linkage:

- `lineageId`
- `intervalId`
- `tokenId`

This prevents orphaned snapshots and wrong-token analytics joins.

## 4. Manual links

Manual links may be necessary for legacy gaps or externally-created successor NFTs.

Rules:

1. Manual links may repair structure.
2. Manual links do not imply complete financial continuity.
3. Any lineage segment built from manual links must be flagged degraded unless basis and cost data are explicitly backfilled.

## 5. Recovery flows

When a rebalance fails after burn and capital is later reminted:

1. the lineage remains the same
2. the failed rebalance remains part of lineage history
3. the recovery mint becomes the new interval entry
4. stranded funds and recovery costs must be represented in the ledger

## Canonical Aggregation Rules

## A. Current interval summary

Current interval is computed from:

- current active interval record
- all fee collections within that interval
- current unclaimed fees on active position
- all interval costs

Formula:

- `intervalTruePnlUsd = currentValueUsd + claimedFeesUsd + unclaimedFeesUsd - intervalEntryBasisUsd - intervalTotalCostsUsd`

## B. Lifetime chain summary

Lifetime chain is computed from:

- root entry basis
- all intervals in lineage
- all fee collections in lineage
- current unclaimed fees of active interval
- all execution costs across lineage

Formula:

- `lineageTruePnlUsd = currentValueUsd + lineageClaimedFeesUsd + currentUnclaimedFeesUsd - rootEntryBasisUsd - lineageTotalCostsUsd`

## C. Rebalance recovery summary

For each rebalance:

1. determine rebalance total loss
2. track fees earned by child interval after child entry only
3. stop recovery window at next rebalance or current time

Forbidden behavior:

- counting the opening rebalance fee collection as child recovery earnings

## Persistence Strategy

Two acceptable options:

### Option 1. Derived read model only

- keep raw event records as source of truth
- build summaries on read

Pros:

- minimal migration risk

Cons:

- heavier route logic

### Option 2. Hybrid

- keep raw events
- persist derived `LineageProfitabilitySummary` and `IntervalProfitabilitySummary`
- refresh on mutation and on repair jobs

Pros:

- faster UI
- easier reconciliation

Recommended path:

- begin with Option 1 for correctness
- add Option 2 later if performance requires it

## Required Migrations

To adopt this ledger spec, the following migrations are needed.

### 1. Lineage backfill migration

Build lineage IDs from:

- existing rebalance links
- manual link records
- active config positions

### 2. Interval backfill migration

Create interval records for:

- root entries where available
- rebalance-created child entries
- legacy positions using best-available approximation

### 3. Snapshot linking migration

Attach snapshots to lineage and interval based on token ID and time range.

### 4. Price completeness migration

Queue missing-price snapshots and entry records for backfill.

## API Surface Required

At minimum, add canonical endpoints or canonical internal service methods for:

1. `getLineageByTokenId(tokenId)`
2. `getCurrentIntervalSummary(tokenId)`
3. `getLifetimeChainSummary(tokenId)`
4. `getLineageLedger(tokenId)`
5. `getRebalanceRecoverySummary(tokenId)`
6. `reconcileLineage(tokenId)`

## UI Requirements Driven By Ledger

The UI should consume the ledger summaries, not recompute profitability ad hoc.

### Position Analytics page

Must show:

- current interval summary
- lifetime chain summary
- trust labels
- cost decomposition
- HODL comparison
- recovery status of past rebalances

### Position Chain page

Must show:

- interval timeline
- per-interval true PnL
- per-rebalance cost and recovery
- lifetime totals from canonical lineage summary

### Dashboard

Must aggregate from lineage summaries, not directly from mixed token-local calculations.

## Integrity Requirements

The following checks must exist.

### Structural checks

1. every open interval has exactly one active token ID
2. every active token ID maps to one lineage
3. lineage has no loops
4. interval chronology is strictly ordered

### Financial checks

1. lifetime chain fees equal sum of underlying fee events
2. lifetime chain costs equal sum of cost events
3. current interval summary plus prior closed interval totals reconcile to lifetime summary
4. recovery windows do not count pre-entry or opening fees

### Trust checks

1. missing prices do not present as zero-value profitability
2. approximate fields are labeled approximate
3. portfolio total uses same canonical summary model as position detail

## Open Design Choices

These remain implementation choices, not spec blockers.

1. whether to persist interval summaries or compute on read
2. whether to represent trust per field or per metric group
3. how aggressively to backfill legacy basis data
4. whether exact concentrated-liquidity IL is implemented immediately or deferred behind explicit approximate labeling

## Implementation Sequence

Recommended order:

1. add lineage and interval identity
2. build raw ledger assembly service
3. rewrite current interval and lifetime chain profitability off ledger
4. patch retrospective recovery logic
5. attach snapshots to ledger and add backfill parity
6. update API responses
7. update UI
8. add reconciliation and integrity tests

## Definition Of Done

The ledger spec is implemented only when:

1. every active position resolves to a canonical lineage
2. current interval and lifetime chain summaries are generated from the ledger
3. profitability does not depend on token-ID-local route shortcuts
4. rebalance recovery analytics are chronologically correct
5. portfolio totals reconcile to lineage totals
# Document A — V1 Data Capture Specification

## LP Bot Analytics Engine — What Gets Logged, When, and From Where

**Version:** 1.0 | **Status:** Build-Ready Spec
**Companion:** Document B — Analysis & Decision Logic Spec (consumes this data)

---

## 1. Purpose & Scope

This document defines the **data capture layer only**. It specifies every table, field, data source, and update cadence needed to support downstream performance analysis and bot tuning.

This document does **not** define:
- Decision logic (when to rebalance, hold, widen, etc.)
- Dashboard layouts or chart specifications
- Failure-mode classification rules
- Alert thresholds or scoring systems

Those concerns belong in Document B.

**Governing principle:** The bot is only working if fee income beats predictable loss, concentration risk, and transaction/rebalance costs. This data layer must capture everything needed to evaluate that equation after the fact.

---

## 2. Schema Overview

Four tables:

| Table | Purpose | Write Frequency |
|---|---|---|
| `positions` | Static + slowly-changing position metadata | On deploy, on rebalance, on close |
| `snapshots` | Time-series state of each position and its pool | Every poll cycle (configurable; default 5 min) |
| `trigger_events` | Every trigger fire, regardless of action taken | On trigger fire |
| `rebalance_events` | Detailed post-trade record for every executed rebalance | On rebalance execution |

---

## 3. Table: `positions`

Captures the identity, configuration, and lifecycle state of each LP position.

### 3.1 Fields

| Field | Type | Description | Source | Write Timing |
|---|---|---|---|---|
| `position_id` | string (PK) | Unique internal identifier | System-generated | On deploy |
| `chain_id` | int | Chain identifier (1 = Ethereum, 137 = Polygon, etc.) | Config | On deploy |
| `pool_address` | string | On-chain pool contract address | Config / DexScreener | On deploy |
| `pair_symbol` | string | Human-readable pair (e.g., "WETH-USDC") | DexScreener API | On deploy |
| `token_a_address` | string | Contract address of token A | On-chain / DexScreener | On deploy |
| `token_b_address` | string | Contract address of token B | On-chain / DexScreener | On deploy |
| `token_a_symbol` | string | Symbol (e.g., "WETH") | DexScreener | On deploy |
| `token_b_symbol` | string | Symbol (e.g., "USDC") | DexScreener | On deploy |
| `token_a_decimals` | int | Token A decimal precision | On-chain | On deploy |
| `token_b_decimals` | int | Token B decimal precision | On-chain | On deploy |
| `fee_tier` | decimal | Pool fee tier (e.g., 0.003 for 0.3%) | On-chain | On deploy |
| `nft_token_id` | string | On-chain position NFT ID (if applicable) | On-chain tx receipt | On deploy |
| `entry_timestamp` | datetime | When position was first deployed | System clock | On deploy |
| `entry_price_ratio` | decimal | Price ratio (token A / token B) at entry | On-chain / DexScreener | On deploy |
| `initial_capital_usd` | decimal | Total USD value at deployment | Computed from entry prices | On deploy |
| `initial_token_a_qty` | decimal | Token A quantity deposited | On-chain tx | On deploy |
| `initial_token_b_qty` | decimal | Token B quantity deposited | On-chain tx | On deploy |
| `initial_lower_bound` | decimal | Lower price bound at entry | On-chain / bot config | On deploy |
| `initial_upper_bound` | decimal | Upper price bound at entry | On-chain / bot config | On deploy |
| `current_lower_bound` | decimal | Current lower price bound (changes on rebalance) | On-chain | On deploy, on rebalance |
| `current_upper_bound` | decimal | Current upper price bound (changes on rebalance) | On-chain | On deploy, on rebalance |
| `current_width_pct` | decimal | `((upper - lower) / entry_price) × 100` | Derived | On deploy, on rebalance |
| `strategy_rule_set_id` | string (FK) | Links to the parameter set governing this position | Bot config | On deploy, on rule change |
| `cumulative_realized_il_pct` | decimal | Running sum of all crystallized IL from rebalances | Derived from `rebalance_events` | On rebalance |
| `cumulative_rebalance_cost_usd` | decimal | Running sum of all rebalance costs (Type A + B) | Derived from `rebalance_events` | On rebalance |
| `total_rebalance_count` | int | Number of rebalances executed | Counter | On rebalance |
| `total_fees_claimed_usd` | decimal | Running total of all fees claimed/compounded | On-chain / bot log | On claim event |
| `status` | enum | `active` / `paused` / `closed` | Bot state machine | On state change |
| `close_timestamp` | datetime (nullable) | When position was closed | System clock | On close |
| `close_reason` | string (nullable) | Why position was closed (e.g., "profitability_breach", "manual", "pool_migration") | Bot / operator | On close |

### 3.2 Companion: `strategy_rule_sets`

Every position references a rule set. When parameters change, a new rule set version is created — the old position row keeps its FK to the old version, new snapshots link to the new one.

| Field | Type | Description |
|---|---|---|
| `rule_set_id` | string (PK) | Unique identifier |
| `version` | int | Incrementing version number |
| `created_at` | datetime | When this rule set was created |
| `default_width_pct` | decimal | Default range width % |
| `symmetric` | boolean | Symmetric vs asymmetric range |
| `recenter_logic` | string | Description of recenter method (e.g., "price_midpoint", "vwap_1h") |
| `edge_threshold_pct` | decimal | Distance to edge that triggers near-edge warning |
| `volatility_widening_factor` | decimal | Multiplier applied to width when σ_7d/σ_30d > 1.2 |
| `max_rebalance_frequency_hours` | decimal | Minimum hours between rebalances |
| `min_net_benefit_required_pct` | decimal | Minimum expected net benefit to justify rebalance |
| `max_rebalance_cost_pct` | decimal | Max allowed rebalance cost as % of position value |
| `pause_conditions` | json | Serialized pause trigger rules |
| `resume_conditions` | json | Serialized resume trigger rules |
| `notes` | string | Free-text description of what changed in this version |

---

## 4. Table: `snapshots`

Time-series record of position state and pool context. This is the primary analytical table.

### 4.1 Update Frequency

Default: every 5 minutes while position is `active`.
Additionally: force a snapshot immediately before and after every rebalance event.

### 4.2 Fields

#### Position State Fields

| Field | Type | Description | Source |
|---|---|---|---|
| `snapshot_id` | string (PK) | Unique identifier | System-generated |
| `position_id` | string (FK) | Links to `positions` table | System |
| `timestamp` | datetime | When this snapshot was taken | System clock |
| `current_price_ratio` | decimal | Live price ratio (token A / token B) | DexScreener API or on-chain oracle |
| `in_range` | boolean | Is current price within [lower, upper]? | Derived from price vs bounds |
| `distance_to_lower_pct` | decimal | `((current_price - lower_bound) / current_price) × 100` | Derived |
| `distance_to_upper_pct` | decimal | `((upper_bound - current_price) / current_price) × 100` | Derived |
| `current_token_a_qty` | decimal | Token A balance in position | On-chain position query |
| `current_token_b_qty` | decimal | Token B balance in position | On-chain position query |
| `current_position_value_usd` | decimal | `(token_a_qty × price_a_usd) + (token_b_qty × price_b_usd)` | Derived |
| `unclaimed_fees_token_a` | decimal | Accrued unclaimed fees (token A) | On-chain position query |
| `unclaimed_fees_token_b` | decimal | Accrued unclaimed fees (token B) | On-chain position query |
| `unclaimed_fees_usd` | decimal | USD value of unclaimed fees | Derived |
| `cumulative_fees_usd` | decimal | Total fees earned to date (claimed + unclaimed) | Derived from position + claims |

#### HODL Benchmark Fields

**Denomination convention for V1: all HODL comparisons are in USD.**

| Field | Type | Description | Source |
|---|---|---|---|
| `hodl_value_usd` | decimal | `(initial_token_a_qty × current_price_a_usd) + (initial_token_b_qty × current_price_b_usd)` | Derived |
| `unrealized_il_pct` | decimal | `((current_position_value_usd - hodl_value_usd) / initial_capital_usd) × 100` | Derived |
| `lp_return_pct` | decimal | `((current_position_value_usd + cumulative_fees_usd - initial_capital_usd) / initial_capital_usd) × 100` | Derived |
| `hodl_return_pct` | decimal | `((hodl_value_usd - initial_capital_usd) / initial_capital_usd) × 100` | Derived |
| `lp_vs_hodl_pct` | decimal | `lp_return_pct - hodl_return_pct` | Derived |

#### Cost Tracking Fields

| Field | Type | Description | Source |
|---|---|---|---|
| `cumulative_gas_cost_usd` | decimal | Running total of all gas costs for this position | Aggregated from `rebalance_events` |
| `cumulative_type_b_cost_usd` | decimal | Running total of all hidden costs (slippage + price impact) | Aggregated from `rebalance_events` |
| `cumulative_total_cost_usd` | decimal | `cumulative_gas_cost_usd + cumulative_type_b_cost_usd` | Derived |
| `cost_as_pct_of_fees` | decimal | `cumulative_total_cost_usd / cumulative_fees_usd × 100` (null if fees = 0) | Derived |
| `net_pnl_usd` | decimal | `current_position_value_usd + cumulative_fees_usd - initial_capital_usd - cumulative_total_cost_usd` | Derived |

#### Pool Context Fields

| Field | Type | Description | Source |
|---|---|---|---|
| `pool_tvl_usd` | decimal | Total value locked in pool | DexScreener API |
| `pool_volume_24h_usd` | decimal | 24h trading volume | DexScreener API |
| `pool_volume_7d_usd` | decimal | 7d trading volume (if available) | DexScreener API or computed |
| `pool_fee_rate` | decimal | Pool fee rate (π) — fees generated as % of pool size | DexScreener or `(volume_24h × fee_tier) / tvl × 365` approximation |
| `volume_to_tvl_ratio` | decimal | `pool_volume_24h_usd / pool_tvl_usd` | Derived |

#### Volatility Fields

Volatility requires price history. The capture layer must store two explicit volatility windows:

| Field | Type | Description | Source |
|---|---|---|---|
| `sigma_7d` | decimal | Annualized volatility computed from trailing 7 days of price data | Computed from price history (std dev of log returns × √365) |
| `sigma_30d` | decimal | Annualized volatility computed from trailing 30 days of price data | Computed from price history (std dev of log returns × √365) |
| `volatility_ratio` | decimal | `sigma_7d / sigma_30d` | Derived |

#### Derived Viability Fields (Computed at Capture Time)

These fields are cheap to compute and critical for retrospective analysis. Compute and store them — do not defer to query time.

| Field | Type | Description | Formula |
|---|---|---|---|
| `min_pl_rate` | decimal | Minimum predictable loss rate | `sigma_30d² / 8` (using σ_30d as the baseline) |
| `profitability_margin` | decimal | How much fee rate exceeds the PL floor | `pool_fee_rate - min_pl_rate` |
| `profitability_viable` | boolean | Is the non-negotiable condition met? | `pool_fee_rate > min_pl_rate` |
| `effective_apr_pct` | decimal | Concentrated APR estimate | `pool_fee_rate × concentration_factor` (where concentration_factor = 100 / width_pct) |
| `time_in_range_pct` | decimal | Cumulative TIR since position entry | `(count of in_range=true snapshots / total snapshots) × 100` |

### 4.3 Price History Subsystem

To compute σ_7d and σ_30d, the system must maintain a rolling price history.

| Field | Type | Description |
|---|---|---|
| `price_ts_id` | string (PK) | Unique identifier |
| `pool_address` | string | Pool this price belongs to |
| `timestamp` | datetime | When price was observed |
| `price_ratio` | decimal | Token A / Token B |
| `price_a_usd` | decimal | Token A in USD |
| `price_b_usd` | decimal | Token B in USD |

**Source:** DexScreener API (primary), on-chain TWAP (fallback).
**Frequency:** Every 5 minutes (aligned with snapshots).
**Retention:** Minimum 30 days rolling.

**Volatility computation method:**
```
log_returns[i] = ln(price_ratio[i] / price_ratio[i-1])
sigma_Nd = std_dev(log_returns over N days) × √(samples_per_year)
```

Where `samples_per_year` depends on sample frequency (e.g., 288 samples/day at 5-min intervals → `√(288 × 365)`).

---

## 5. Table: `trigger_events`

Logs every trigger fire, regardless of whether a rebalance was executed. This is the table that lets you later ask: "When the bot held instead of rebalancing, was that the right call?"

### 5.1 Fields

| Field | Type | Description | Source |
|---|---|---|---|
| `trigger_event_id` | string (PK) | Unique identifier | System-generated |
| `position_id` | string (FK) | Which position triggered | System |
| `timestamp` | datetime | When trigger fired | System clock |
| `trigger_type` | enum | One of: `price_exit`, `near_edge_warning`, `volatility_regime_shift`, `fee_rate_deterioration`, `profitability_breach`, `manual_override`, `scheduled_review` | Bot trigger engine |
| `price_ratio_at_trigger` | decimal | Current price when trigger fired | DexScreener / on-chain |
| `lower_bound` | decimal | Position lower bound at time of trigger | Position state |
| `upper_bound` | decimal | Position upper bound at time of trigger | Position state |
| `width_pct` | decimal | Range width at time of trigger | Derived |
| `distance_to_nearest_edge_pct` | decimal | Distance to whichever bound is closer | Derived |
| `in_range` | boolean | Was position actually in range? | Derived |
| `time_in_range_pct` | decimal | Cumulative TIR at trigger time | From latest snapshot |
| `cumulative_fees_usd` | decimal | Total fees earned to date | From latest snapshot |
| `unrealized_il_pct` | decimal | Current unrealized IL | From latest snapshot |
| `sigma_7d` | decimal | 7-day vol at trigger time | From latest snapshot |
| `sigma_30d` | decimal | 30-day vol at trigger time | From latest snapshot |
| `volatility_ratio` | decimal | σ_7d / σ_30d | Derived |
| `pool_fee_rate` | decimal | Pool fee rate (π) | From latest snapshot |
| `profitability_margin` | decimal | π − σ²/8 | From latest snapshot |
| `estimated_rebalance_cost_usd` | decimal | Estimated all-in cost if bot were to rebalance now | Computed: `0.5 × (est_slippage + swap_fee) × position_value + gas_estimate` |
| `estimated_break_even_days` | decimal | Days_BE if rebalance were executed | Computed: `365 × (|IL_edge| + reb_cost) / APR_new` |
| `action_taken` | enum | `rebalance`, `hold`, `widen`, `narrow`, `pause`, `close`, `manual_override` | Bot / operator |
| `action_reason` | string | Free-text or coded reason for the decision | Bot logic / operator |
| `linked_rebalance_id` | string (FK, nullable) | If action was rebalance, links to `rebalance_events` row | System |

---

## 6. Table: `rebalance_events`

Detailed post-trade record for every executed rebalance. This is the single most important evaluation unit for tuning bot rules.

### 6.1 Fields

| Field | Type | Description | Source |
|---|---|---|---|
| `rebalance_id` | string (PK) | Unique identifier | System-generated |
| `position_id` | string (FK) | Which position was rebalanced | System |
| `trigger_event_id` | string (FK) | Which trigger caused this rebalance | From `trigger_events` |
| `timestamp` | datetime | When rebalance was executed | System clock / tx confirmation |
| `tx_hash` | string | On-chain transaction hash | Blockchain |
| **Pre-Rebalance State** | | | |
| `old_lower_bound` | decimal | Lower bound before rebalance | Position state |
| `old_upper_bound` | decimal | Upper bound before rebalance | Position state |
| `old_width_pct` | decimal | Width before rebalance | Derived |
| `old_center_price` | decimal | Midpoint of old range | Derived |
| `price_at_rebalance` | decimal | Market price when rebalance executed | On-chain / DexScreener |
| `position_value_before_usd` | decimal | Position value immediately before | Pre-rebalance snapshot |
| **Post-Rebalance State** | | | |
| `new_lower_bound` | decimal | Lower bound after rebalance | On-chain tx |
| `new_upper_bound` | decimal | Upper bound after rebalance | On-chain tx |
| `new_width_pct` | decimal | Width after rebalance | Derived |
| `new_center_price` | decimal | Midpoint of new range | Derived |
| `position_value_after_usd` | decimal | Position value immediately after | Post-rebalance snapshot |
| **Cost Decomposition** | | | |
| `gas_cost_usd` | decimal | Type A: gas paid | On-chain tx receipt |
| `swap_fee_cost_usd` | decimal | Type A: pool swap fee paid during rebalance | Computed from swap amount × fee tier |
| `slippage_cost_usd` | decimal | Type B: actual slippage (expected vs executed price) | Computed: `|expected_swap_output - actual_swap_output|` |
| `price_impact_cost_usd` | decimal | Type B: price impact (market price movement caused by trade) | Computed or estimated |
| `total_type_a_cost_usd` | decimal | `gas_cost_usd + swap_fee_cost_usd` | Derived |
| `total_type_b_cost_usd` | decimal | `slippage_cost_usd + price_impact_cost_usd` | Derived |
| `total_rebalance_cost_usd` | decimal | `total_type_a_cost_usd + total_type_b_cost_usd` | Derived |
| **IL Crystallization** | | | |
| `crystallized_il_pct` | decimal | IL realized at moment of rebalance | `2√(P_edge/P_entry) / (1 + P_edge/P_entry) − 1` |
| `crystallized_il_usd` | decimal | USD value of crystallized IL | `crystallized_il_pct × position_value_before_usd` |
| `total_loss_usd` | decimal | `crystallized_il_usd + total_rebalance_cost_usd` | Derived — the L_total |
| `total_loss_pct` | decimal | `total_loss_usd / position_value_before_usd × 100` | Derived |
| **Recovery Estimates (at rebalance time)** | | | |
| `estimated_new_apr_pct` | decimal | Estimated APR of the new range | Computed at rebalance |
| `estimated_break_even_days` | decimal | `365 × total_loss_pct / estimated_new_apr_pct` | Derived |
| `estimated_break_even_calendar_days` | decimal | `estimated_break_even_days / estimated_time_in_range` | Derived |
| **Outcome Tracking (filled retrospectively)** | | | |
| `fees_earned_1d_usd` | decimal (nullable) | Fees earned in first 24h after rebalance | From snapshots, backfilled |
| `fees_earned_3d_usd` | decimal (nullable) | Fees earned in first 3 days | From snapshots, backfilled |
| `fees_earned_7d_usd` | decimal (nullable) | Fees earned in first 7 days | From snapshots, backfilled |
| `actual_days_to_recovery` | decimal (nullable) | Days until cumulative post-rebalance fees ≥ total_loss_usd | From snapshots, backfilled |
| `recovered_before_next_rebalance` | boolean (nullable) | Did fees cover total_loss before next rebalance? | From next rebalance event, backfilled |
| `next_rebalance_id` | string (FK, nullable) | ID of the next rebalance (if any) | System, backfilled |
| **Context** | | | |
| `rule_set_id` | string (FK) | Which strategy rule set was active | Position state |
| `operator_notes` | string (nullable) | Free-text notes from operator | Operator input |

---

## 7. Data Source Registry

Every field must trace to a named source. This table summarizes the primary sources.

| Source | What It Provides | Update Method | Failure Mode |
|---|---|---|---|
| **DexScreener API** | Price ratio, volume 24h, TVL, base fee APR, pair metadata | HTTP poll (every 5 min) | Stale data if API down; flag staleness in snapshot |
| **On-chain position query** | Token balances, unclaimed fees, tick bounds, NFT ID | RPC call to NonfungiblePositionManager | RPC timeout; retry with backoff |
| **On-chain tx receipt** | Gas cost, swap amounts, tx hash | Post-tx RPC query | Tx could revert; handle explicitly |
| **Price history store** | Historical price ratios for volatility computation | Accumulated from snapshots | Gaps cause inaccurate σ; interpolate or flag |
| **Bot config** | Strategy rule sets, thresholds, pause/resume rules | Local config file or database | Operator error; version everything |
| **System clock** | Timestamps | OS clock | NTP sync assumed |

### 7.1 Fallback & Staleness Rules

- If DexScreener API returns an error or times out, the snapshot must still be written with the last-known values and a `data_stale` boolean flag set to `true`.
- If on-chain RPC fails, retry 3× with exponential backoff. If still failing, log the failure and skip the snapshot (do not write partial data).
- Price history gaps > 30 minutes should be flagged. Volatility calculations on gapped data should carry a `sigma_confidence` field: `high` (< 5% gaps), `medium` (5–15% gaps), `low` (> 15% gaps).

---

## 8. Snapshot Metadata Fields

Every snapshot row also carries:

| Field | Type | Description |
|---|---|---|
| `data_stale` | boolean | True if any source returned stale/cached data |
| `sigma_confidence` | enum | `high` / `medium` / `low` — quality of volatility estimate |
| `snapshot_trigger` | enum | `scheduled` / `pre_rebalance` / `post_rebalance` / `manual` — why this snapshot was taken |

---

## 9. Retention & Storage Notes

| Table | Expected Row Volume (per position per day) | Retention |
|---|---|---|
| `positions` | ~0 (slow-changing) | Indefinite |
| `strategy_rule_sets` | ~0 (slow-changing) | Indefinite |
| `snapshots` | ~288 (at 5-min intervals) | Minimum 90 days; archive beyond |
| `price_history` | ~288 per pool | 30 days rolling (for volatility); archive if needed for backtesting |
| `trigger_events` | Variable (0–10 typical) | Indefinite |
| `rebalance_events` | Variable (0–3 typical) | Indefinite |

For V1, a relational database (PostgreSQL) is the recommended store. The snapshot table will be the largest; consider partitioning by `position_id` and `timestamp` if volume becomes an issue.

---

## 10. What This Schema Enables (Preview of Document B Queries)

This data layer is designed to answer the five core questions:

1. **Is this position making money net of everything?**
   → Query `snapshots.net_pnl_usd` and `snapshots.lp_vs_hodl_pct` over time.

2. **Is the current range logic effective?**
   → Query `snapshots.time_in_range_pct`, `snapshots.effective_apr_pct`, and join to `strategy_rule_sets` for parameter context.

3. **Are rebalances helping or hurting?**
   → Query `rebalance_events.recovered_before_next_rebalance` and `rebalance_events.actual_days_to_recovery`.

4. **Which pools and rule sets are structurally bad fits?**
   → Query `snapshots.profitability_viable` over time, join to `positions.pool_address` and `strategy_rule_sets`.

5. **What parameter changes improve outcomes?**
   → Compare `rebalance_events` and `snapshots` performance across different `rule_set_id` values on the same pool.

---

*End of Document A.*

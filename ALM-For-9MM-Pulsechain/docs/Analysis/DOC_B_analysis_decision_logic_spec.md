# Document B — Analysis & Decision Logic Specification

## LP Bot Analytics Engine — How to Interpret, Decide, and Display

**Version:** 1.0 | **Status:** Design Spec (Build After Document A Is Implemented)
**Dependency:** Document A — V1 Data Capture Specification (must be implemented first)

---

## 1. Purpose & Scope

This document defines everything that **consumes** the data captured by Document A:

- The five core questions the analytics system must answer
- Rebalance decision logic (cost-benefit framework)
- Failure-mode classification rules
- Alert thresholds and trigger responses
- Dashboard layout and chart specifications
- Strategy comparison methodology

This document does **not** redefine the schema, field names, or data sources — those are owned by Document A. All field references below use Document A field names.

---

## 2. The Five Core Questions

Every view, alert, and decision rule in this system serves one of these questions:

| # | Question | Primary Data Source (Document A) |
|---|---|---|
| 1 | Is this position making money net of everything? | `snapshots.net_pnl_usd`, `snapshots.lp_vs_hodl_pct` |
| 2 | Is the current range logic effective? | `snapshots.time_in_range_pct`, `snapshots.effective_apr_pct` |
| 3 | Are rebalances helping or hurting? | `rebalance_events.recovered_before_next_rebalance`, `rebalance_events.actual_days_to_recovery` |
| 4 | Which pools and rule sets are structurally bad fits? | `snapshots.profitability_viable`, `positions.pool_address`, `strategy_rule_sets` |
| 5 | What parameter changes improve outcomes? | Cross-join `rebalance_events` + `snapshots` across `rule_set_id` values |

---

## 3. Rebalance Decision Framework

This is the core intelligence of the bot. When a trigger fires, the bot must execute this calculation chain **before** taking action.

### 3.1 Trigger → Decision Pipeline

```
Trigger fires
    ↓
Log to trigger_events (Document A, Table 5)
    ↓
Execute cost-benefit calculation (this section)
    ↓
Determine action: rebalance / hold / widen / narrow / pause / close
    ↓
Log action_taken + action_reason to trigger_events
    ↓
If action = rebalance → execute and log to rebalance_events (Document A, Table 6)
```

**Cardinal rule:** A trigger does not automatically cause a rebalance. The trigger causes a *calculation*. The calculation determines the action.

### 3.2 The Five Triggers

| # | Trigger | Detection Logic | Data Fields Used |
|---|---|---|---|
| 1 | **Price Exit** | `snapshots.in_range = false` | `current_price_ratio`, `current_lower_bound`, `current_upper_bound` |
| 2 | **Near-Edge Warning** | `distance_to_nearest_edge_pct < edge_threshold_pct` (from `strategy_rule_sets`) | `snapshots.distance_to_lower_pct`, `snapshots.distance_to_upper_pct` |
| 3 | **Volatility Regime Shift** | `snapshots.volatility_ratio > 1.2` | `snapshots.sigma_7d`, `snapshots.sigma_30d` |
| 4 | **Fee Rate Deterioration** | `snapshots.pool_fee_rate` declining trend OR `pool_fee_rate` crosses below prior level by > 20% | `snapshots.pool_fee_rate` over trailing window |
| 5 | **Profitability Breach** | `snapshots.profitability_viable = false` (i.e., `π < σ²/8`) | `snapshots.profitability_margin` |

Additional system triggers (not from research, but operationally necessary):

| # | Trigger | Detection Logic |
|---|---|---|
| 6 | **Manual Override** | Operator input |
| 7 | **Scheduled Review** | Calendar-based check (e.g., weekly review of all positions) |

### 3.3 Cost-Benefit Calculation Chain

When a trigger fires, compute the following in sequence:

**Step 1 — Crystallized IL at Edge**

```
r = P_edge / P_entry

If price exited range:
    P_edge = whichever bound was breached (clamped to edge)
If price is still in range (near-edge trigger):
    P_edge = nearest bound (hypothetical)

IL_edge = (2 × √r) / (1 + r) − 1
```

**Step 2 — Estimated Rebalance Cost**

```
reb_cost = r_swap × (est_slippage + swap_fee) + gas_pct

Where:
    r_swap ≈ 0.5 if position is fully one-sided at edge
    r_swap = fraction of position that must be swapped (estimate from token composition)
    est_slippage = historical average slippage for this pool's liquidity depth
    swap_fee = pool fee tier
    gas_pct = estimated gas cost as % of position value
```

**Remember:** Type B hidden costs (slippage + price impact) are typically 3–5× larger than gas alone. The `est_slippage` input must reflect this reality, not just the pool's nominal swap fee.

**Step 3 — Total Loss to Recover**

```
L_total = |IL_edge| + reb_cost
```

This is the all-in setback that the new position must overcome through future fee income.

**Step 4 — Break-Even Days for New Range**

```
APR_new = estimated effective APR of the proposed new range
T_new = estimated time-in-range fraction for the new range

Days_BE_in_range = 365 × L_total / APR_new
Days_BE_calendar = Days_BE_in_range / T_new
```

**Step 5 — Final Execution Decision**

```
EXECUTE rebalance IF ALL of the following are true:
    1. (Expected fees from new range) − (reb_cost) − (Expected PL in new range) > 0
    2. Days_BE_calendar < expected active lifetime of new range
    3. Time since last rebalance > max_rebalance_frequency_hours (from strategy_rule_sets)
    4. total_rebalance_cost_usd / position_value < max_rebalance_cost_pct (from strategy_rule_sets)

DO NOT REBALANCE if any condition fails.
```

### 3.4 Alternative Actions When Rebalance Fails Cost-Benefit

If the calculation says "do not rebalance," the bot selects an alternative:

| Condition | Recommended Action | Rationale |
|---|---|---|
| Volatility calming (σ_7d/σ_30d < 1.0), mean-reverting pair | **Recenter (rebalance)** | Volatility cooling promises higher TIR and fast recovery |
| Volatility expanding (σ_7d/σ_30d > 1.2), or 2+ rebalances/month | **Widen range** | Stay in range longer; fewer costly rebalances |
| Mean-reverting but volatile, or strong peg (Corr > 0.95) | **Stagger multi-bands** | Split capital across 3–7 sub-ranges for smoother fee income |
| Trending regime (autocorrelation > 0.3), or major uncertainty event | **Pause / hold 1-sided** | Avoid compounding IL; preserve capital until conditions normalize |
| Profitability breach: π < σ²/8 | **Exit position** | Fundamental economics are broken; no amount of range adjustment fixes this |

### 3.5 Price Exit: Wait-or-Act Nuance

Two valid approaches exist for price exit triggers:

- **Immediate evaluation (default for trending or stable-risky pairs):** Fire the cost-benefit chain immediately.
- **Delayed evaluation (for downturn scenarios with mean-reverting pairs):** If the exit is caused by a broad market downturn and the pair has mean-reverting characteristics (autocorrelation < 0, high asset correlation), wait 24–48 hours before executing the cost-benefit chain. If price returns to range during the wait, the trigger is cancelled with zero realized IL.

The `action_reason` field in `trigger_events` should record which approach was used and why.

---

## 4. Failure-Mode Classification

For each active position, the system should periodically evaluate which (if any) failure mode applies. This classification is based on symptom patterns in the captured data.

### 4.1 Failure Mode Definitions

**Failure Mode 1: Range Too Narrow**

| Symptom | Detection Query |
|---|---|
| High headline fee APR | `snapshots.effective_apr_pct` significantly above pool average |
| Frequent range exits | `trigger_events` count where `trigger_type = price_exit` is high |
| Low time in range | `snapshots.time_in_range_pct < 50%` |
| Negative net return despite fees | `snapshots.net_pnl_usd < 0` while `snapshots.cumulative_fees_usd > 0` |
| High rebalance count | `positions.total_rebalance_count` high relative to position age |

**Mitigation:** Widen the range to reduce PL exposure and rebalance frequency.

---

**Failure Mode 2: Range Too Wide**

| Symptom | Detection Query |
|---|---|
| High time in range | `snapshots.time_in_range_pct > 95%` |
| Low fee generation | `snapshots.cumulative_fees_usd` growing slowly relative to capital |
| Stagnant returns | `snapshots.lp_return_pct` flat or barely positive |
| Low capital efficiency | `snapshots.effective_apr_pct` near or below base (unconcentrated) APR |

**Mitigation:** Narrow the range for higher capital efficiency, or redeploy to a more active pool.

---

**Failure Mode 3: Over-Rebalancing**

| Symptom | Detection Query |
|---|---|
| High rebalance frequency | `rebalance_events` count / position age in weeks |
| Costs consuming fees | `snapshots.cost_as_pct_of_fees > 50%` |
| Break-even rarely reached | `rebalance_events.recovered_before_next_rebalance = false` for majority of events |

**Mitigation:** Increase `max_rebalance_frequency_hours`. Increase `min_net_benefit_required_pct`. Audit Type B cost estimates — they may be underestimated.

---

**Failure Mode 4: Wrong Pool**

| Symptom | Detection Query |
|---|---|
| Consistent underperformance | `snapshots.lp_vs_hodl_pct` persistently negative over > 14 days |
| Poor fee/volatility profile | `snapshots.profitability_margin` near zero or negative |
| Sensible bot logic, bad results | Other failure modes do not apply, but `net_pnl_usd` is still negative |

**Mitigation:** Exit and redeploy to a pool with better fee-to-volatility economics. Stable-risky pools (e.g., USDC-ETH) are the most common structural offenders.

---

**Failure Mode 5: Position Too Small (Capital Depletion)**

| Symptom | Detection Query |
|---|---|
| Positive gross edge, negative net | `snapshots.cumulative_fees_usd > cumulative_total_cost_usd` is false, but `effective_apr_pct` looks healthy |
| Costs dominate | `snapshots.cost_as_pct_of_fees > 80%` |
| Gas is the primary cost | `rebalance_events.total_type_a_cost_usd >> total_type_b_cost_usd` (unusual — indicates gas is the bottleneck) |

**Mitigation:** Increase position size to amortize fixed costs, or migrate to Layer 2 where gas costs are negligible.

---

### 4.2 Classification Priority

If multiple failure modes match, prioritize in this order:

1. **Profitability Breach** (π < σ²/8) → this overrides everything; exit the position
2. **Wrong Pool** → no amount of parameter tuning fixes structural economics
3. **Position Too Small** → fixable by scaling capital, but pointless to tune other params until fixed
4. **Range Too Narrow** → most common cause of "looks good on paper, loses money in practice"
5. **Over-Rebalancing** → often co-occurs with Too Narrow
6. **Range Too Wide** → least damaging; position is safe but underperforming

---

## 5. Alert System

### 5.1 Alert Categories

| Alert | Trigger Condition | Severity | Action |
|---|---|---|---|
| **Near Lower Boundary** | `distance_to_lower_pct < edge_threshold_pct` | Warning | Log trigger_event; prepare rebalance calculation |
| **Near Upper Boundary** | `distance_to_upper_pct < edge_threshold_pct` | Warning | Log trigger_event; prepare rebalance calculation |
| **Out of Range** | `in_range = false` | Critical | Log trigger_event; execute cost-benefit chain |
| **Volatility Spike** | `volatility_ratio > 1.2` | Warning | Log trigger_event; consider widening |
| **Profitability Breach** | `profitability_viable = false` | Critical | Log trigger_event; immediate review — likely exit |
| **Rebalance Cost Too High** | `estimated_rebalance_cost_usd / position_value > max_rebalance_cost_pct` | Warning | Hold; do not rebalance even if other triggers fire |
| **Pool Deteriorating** | `pool_tvl_usd` dropped > 30% in 24h, OR `pool_volume_24h_usd` dropped > 50% | Warning | Review pool viability; may indicate migration or exploit |
| **Data Staleness** | `data_stale = true` for > 3 consecutive snapshots | Warning | Investigate data pipeline; do not make decisions on stale data |
| **Recovery Failure** | `recovered_before_next_rebalance = false` for 3+ consecutive rebalances | Critical | Likely over-rebalancing or structural problem; escalate to operator |

### 5.2 Alert Delivery (V1)

For V1, alerts are written to a log table and surfaced on the dashboard. Future versions may add Telegram/Discord webhooks.

| Field | Type | Description |
|---|---|---|
| `alert_id` | string (PK) | Unique identifier |
| `position_id` | string (FK) | Affected position |
| `timestamp` | datetime | When alert was generated |
| `alert_type` | enum | From the categories above |
| `severity` | enum | `warning` / `critical` |
| `message` | string | Human-readable description |
| `acknowledged` | boolean | Has operator seen this? |
| `resolved` | boolean | Has the condition cleared? |

---

## 6. Dashboard Specification

### 6.1 Portfolio Summary Panel

Single-glance health check across all positions.

| Metric | Source |
|---|---|
| Total deployed capital (USD) | Sum of `positions.initial_capital_usd` where `status = active` |
| Current total LP value (USD) | Sum of latest `snapshots.current_position_value_usd` |
| Total fees earned (USD) | Sum of latest `snapshots.cumulative_fees_usd` |
| Total costs incurred (USD) | Sum of latest `snapshots.cumulative_total_cost_usd` |
| Net PnL (USD) | Sum of latest `snapshots.net_pnl_usd` |
| Portfolio LP vs HODL (%) | Weighted average of `snapshots.lp_vs_hodl_pct` by position size |
| Positions in range / total | Count of `in_range = true` / count of active positions |
| Rebalances this week | Count of `rebalance_events` in trailing 7 days |
| Average time in range (%) | Weighted average of `snapshots.time_in_range_pct` |
| Active alerts | Count of unresolved alerts by severity |

### 6.2 Position Table

One row per active position, sortable by any column.

| Column | Source |
|---|---|
| Pair | `positions.pair_symbol` |
| Current Price | Latest `snapshots.current_price_ratio` |
| Range [lower — upper] | `positions.current_lower_bound` / `current_upper_bound` |
| Width % | `positions.current_width_pct` |
| Status | In-range / out-of-range / paused |
| Effective APR % | Latest `snapshots.effective_apr_pct` |
| Fees Earned (USD) | Latest `snapshots.cumulative_fees_usd` |
| Unrealized IL % | Latest `snapshots.unrealized_il_pct` |
| Net PnL (USD) | Latest `snapshots.net_pnl_usd` |
| LP vs HODL % | Latest `snapshots.lp_vs_hodl_pct` |
| Time in Range % | Latest `snapshots.time_in_range_pct` |
| Days Since Rebalance | Now − last `rebalance_events.timestamp` |
| Profitability Margin | Latest `snapshots.profitability_margin` |
| Alert State | Highest-severity unresolved alert |
| Rule Set | `positions.strategy_rule_set_id` + version |

### 6.3 Position Detail View

Drill-down for a single position. Contains all charts and the rebalance history.

---

## 7. Chart Specifications

Seven charts, ordered by analytical value. All charts pull exclusively from Document A tables.

### Chart 1: LP vs HODL Equity Curve

**The single most important chart.** If this line is below zero, the bot is losing to passive holding.

- **X-axis:** Time (from position entry to now)
- **Y-axis:** Percentage (%)
- **Series:**
  - `lp_return_pct` (blue) — total LP return including fees
  - `hodl_return_pct` (gray) — passive hold return
  - `lp_vs_hodl_pct` (green/red fill between curves) — the delta
- **Source:** `snapshots` table, filtered by `position_id`
- **Annotations:** Vertical lines at each `rebalance_events.timestamp`

### Chart 2: Price Ratio with Range Boundaries

Shows whether the bot's range is tracking price effectively.

- **X-axis:** Time
- **Y-axis:** Price ratio (token A / token B)
- **Series:**
  - `current_price_ratio` (line)
  - `current_lower_bound` / `current_upper_bound` (horizontal bands, shifting on rebalance)
- **Source:** `snapshots` + `positions` (bounds update on rebalance)
- **Shading:** Green when in range, red when out of range

### Chart 3: Time in Range / Range Utilization

- **X-axis:** Time
- **Y-axis:** Percentage (0–100%)
- **Series:**
  - `time_in_range_pct` (cumulative, rolling)
- **Reference lines:** 70% (minimum target) and 85% (healthy target)
- **Source:** `snapshots` table

### Chart 4: Fee Accrual

Shows whether fee income is accelerating, flat, or decelerating.

- **X-axis:** Time
- **Y-axis:** USD
- **Series:**
  - `cumulative_fees_usd` (monotonically increasing line)
  - Slope changes indicate fee rate changes
- **Source:** `snapshots` table

### Chart 5: IL Curve with Current Marker

- **X-axis:** Time
- **Y-axis:** Percentage (negative)
- **Series:**
  - `unrealized_il_pct` (red line)
  - Horizontal line at `cumulative_fees_usd / initial_capital_usd × 100` (green — fee offset)
  - When green > |red|, fees are winning
- **Source:** `snapshots` table

### Chart 6: Rebalance History Timeline

Visual record of every rebalance decision and its outcome.

- **X-axis:** Time
- **Y-axis:** Categorical (one row per rebalance event)
- **Per event:** Marker showing:
  - Trigger type (icon/color)
  - Cost (bar width or label)
  - Whether it recovered before next rebalance (green check / red X)
  - Days to recovery (if applicable)
- **Source:** `rebalance_events` table

### Chart 7: Cost vs Fee Generation

Scatter plot revealing whether costs are proportional to fee income.

- **X-axis:** `total_rebalance_cost_usd` (per rebalance event)
- **Y-axis:** Fees earned in 7 days following rebalance (`fees_earned_7d_usd`)
- **Diagonal line:** Break-even (cost = fees)
- **Points above line:** Profitable rebalances
- **Points below line:** Unprofitable rebalances
- **Color:** By `trigger_type`
- **Source:** `rebalance_events` table

---

## 8. Strategy Comparison Framework

### 8.1 A/B Testing Methodology

To compare parameter set A vs B on the same pool:

1. Both positions must be on the **same pool** during the **same time period**.
2. Join `snapshots` for both positions on matching timestamps.
3. Compare:
   - `lp_vs_hodl_pct` (which strategy generated more alpha?)
   - `time_in_range_pct` (which range was more productive?)
   - `cost_as_pct_of_fees` (which was more cost-efficient?)
   - `rebalance_events` count and `recovered_before_next_rebalance` rate
4. Control for position size differences by normalizing to percentage returns.

### 8.2 Key Comparison Queries

**Does wider range beat narrower range after costs?**
```sql
SELECT
    rs.default_width_pct,
    AVG(s.lp_vs_hodl_pct) as avg_alpha,
    AVG(s.time_in_range_pct) as avg_tir,
    AVG(s.cost_as_pct_of_fees) as avg_cost_ratio
FROM snapshots s
JOIN positions p ON s.position_id = p.position_id
JOIN strategy_rule_sets rs ON p.strategy_rule_set_id = rs.rule_set_id
WHERE p.pool_address = :pool
GROUP BY rs.default_width_pct
ORDER BY avg_alpha DESC;
```

**Is rebalance-on-exit better than proactive rebalance?**
```sql
SELECT
    te.trigger_type,
    te.action_taken,
    AVG(re.actual_days_to_recovery) as avg_recovery_days,
    AVG(CASE WHEN re.recovered_before_next_rebalance THEN 1 ELSE 0 END) as recovery_rate
FROM trigger_events te
LEFT JOIN rebalance_events re ON te.linked_rebalance_id = re.rebalance_id
WHERE te.trigger_type IN ('price_exit', 'near_edge_warning')
GROUP BY te.trigger_type, te.action_taken;
```

**Which pools are structurally viable?**
```sql
SELECT
    p.pair_symbol,
    p.pool_address,
    AVG(s.profitability_margin) as avg_margin,
    AVG(s.lp_vs_hodl_pct) as avg_alpha,
    SUM(CASE WHEN s.profitability_viable = false THEN 1 ELSE 0 END)::float
        / COUNT(*) as breach_rate
FROM snapshots s
JOIN positions p ON s.position_id = p.position_id
GROUP BY p.pair_symbol, p.pool_address
ORDER BY avg_margin DESC;
```

---

## 9. Decision Rules Summary (V1)

These are the operating rules the bot follows. They are intentionally simple and testable.

| # | Rule | Implementation |
|---|---|---|
| 1 | **Do not rebalance just because a trigger fired.** Only rebalance when the cost-benefit chain (Section 3.3) produces a positive expected value. | Gate all rebalance actions behind the 5-step calculation. |
| 2 | **Use threshold-based logic, not fixed-interval rebalancing.** | Triggers fire on conditions (price exit, vol shift, etc.), never on a timer. The `scheduled_review` trigger is for human review, not automatic action. |
| 3 | **Monitor time in range as a first-class metric.** | `time_in_range_pct` appears in snapshots, alerts, dashboard, and is a core input to the cost-benefit chain. |
| 4 | **Compare every strategy to HODL.** | `lp_vs_hodl_pct` is computed on every snapshot and is the primary column in the position table. |
| 5 | **Track costs separately.** | Gas, swap fee, slippage, and price impact are four distinct fields on every `rebalance_events` row. They are never buried in a single number. |
| 6 | **Respect the profitability gate.** | `profitability_viable = false` triggers a Critical alert and likely position exit. No rebalance or range adjustment fixes broken pool economics. |
| 7 | **Version every parameter change.** | Every `strategy_rule_sets` change creates a new version. Positions reference specific versions. This enables A/B comparison. |

---

## 10. Exit Rules

A position should be closed when any of the following conditions persist:

| Condition | Duration Threshold | Action |
|---|---|---|
| `profitability_viable = false` | > 48 hours (allowing for transient spikes) | Close position |
| `lp_vs_hodl_pct` persistently negative | > 14 days with no improving trend | Review; likely close |
| Pool TVL dropped > 50% | Immediate | Close; pool may be compromised |
| `time_in_range_pct < 30%` over trailing 7 days | 7 days | Range is catastrophically wrong; close or radically widen |
| Operator manual close | Immediate | Close and log reason |
| A materially better opportunity exists elsewhere | Operator judgment | Close and redeploy |

All closures should log `close_reason` to the `positions` table.

---

## 11. What Belongs in Future Versions (Not V1)

These are valuable but require either more data history, more compute, or more complexity than V1 justifies.

| Feature | Why Deferred |
|---|---|
| Sharpe ratio / risk-adjusted return ranking | Requires sufficient return history to compute meaningful standard deviation of returns |
| Pool-to-pool clustering by behavior | Requires multi-pool data at scale |
| LVR/PL estimation engine | Requires tick-level on-chain data and hedging simulation |
| JIT/MEV fee leakage detection | Requires block-level transaction analysis; hard to do from API data alone |
| Dynamic volatility forecasting (GARCH, etc.) | Realized vol is sufficient for V1; forecasting adds model risk |
| Regime classifier (mean-reverting vs trending) | Useful but autocorrelation heuristic in trigger logic is sufficient for V1 |
| Multi-band allocation optimizer | Requires a working single-band system first |
| Auto parameter search / backtesting engine | Requires 90+ days of snapshot history to be meaningful |
| Monte Carlo scenario testing | Valuable for risk management; premature without stable data pipeline |
| Cross-chain / L2 routing optimizer | V1 should prove the system works on a single chain first |

---

## 12. Implementation Priority

If building Document B features incrementally:

**Phase 1 (Ship with V1 data layer):**
- Trigger detection + logging (Section 3.1–3.2)
- Cost-benefit calculation chain (Section 3.3)
- Portfolio summary panel (Section 6.1)
- Position table (Section 6.2)
- Alert generation (Section 5)
- Charts 1 and 2 (LP vs HODL + Price with Boundaries)

**Phase 2 (After 2+ weeks of data):**
- Remaining 5 charts
- Failure-mode classification (Section 4)
- Rebalance outcome backfilling (the `fees_earned_Xd` and `recovered_before_next_rebalance` fields)

**Phase 3 (After 30+ days of data):**
- Strategy comparison queries (Section 8)
- Exit rule automation (Section 10)
- Parameter A/B testing

---

*End of Document B.*

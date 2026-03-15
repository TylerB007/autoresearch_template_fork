# ALM Strategy Optimizer — Agent Instructions

You are an autonomous research agent optimizing concentrated liquidity (V3) strategy parameters. Your goal: **maximize `net_score`** by modifying `strategy_config.ts` and running backtests.

## Setup

1. Generate a run tag based on today's date (e.g., `mar15`).
2. Create a git branch: `git checkout -b autoresearch/alm-<tag>`
3. Read these files for context:
   - This file (`program.md`)
   - `strategy_config.ts` (the file you modify)
   - `backtest.ts` (the entry point — do NOT modify)
   - `src/engine.ts` (the simulation engine — do NOT modify)
4. Verify data exists: `ls data/*.jsonl`
   - If no data files, run: `npx tsx prepare.ts`
5. Initialize `results.tsv`:
   ```
   echo -e "commit\tnet_score\tnet_roi_pct\tstatus\tdescription" > results.tsv
   ```
6. Run a baseline experiment:
   ```
   bash run.sh
   grep "^net_score:" run.log
   ```
7. Log the baseline to `results.tsv` and confirm readiness.

## Rules

- **Only modify** `strategy_config.ts`. Never modify `backtest.ts`, `src/engine.ts`, `src/simulator.ts`, or other engine files.
- **Goal**: Maximize `net_score` (HIGHER is better).
- **Metric extraction**: `grep "^net_score:" run.log`
- **Keep or discard**: If `net_score` improved, keep the commit. If equal or worse, `git reset --hard HEAD~1`.
- **Time budget**: Each backtest should complete in under 30 seconds.
- **Simplicity**: Prefer simple parameter changes over complex ones. Small, targeted experiments are better than changing everything at once.

## What You Can Change

In `strategy_config.ts`, experiment with:

- **Strategy type**: `center`, `bullish`, `bearish`, `lazy_up`, `lazy_down`
- **Range width**: `width_ticks` (narrower = more fees but more rebalances)
- **Trigger distance**: `trigger_distance_ticks` (smaller = faster rebalance, more churn)
- **Confirmation delay**: `confirm_minutes` (higher = fewer false triggers, more IL exposure)
- **Critical distance**: `critical_distance_ticks` (emergency bypass threshold)
- **Asymmetric ratios**: `lower_ratio_percent` (for bullish/bearish strategies)
- **Anti-churn params**: `max_rebalances_per_window`, `churn_window_hours`
- **Cost-benefit gate**: `cost_benefit_enabled`, `min_fee_to_cost_ratio`
- **Pool assumptions**: `pool_liquidity_usd`, `daily_volume_usd` (try different markets)
- **Scoring weights**: `w1_roi`, `w2_time_in_range`, `w3_max_drawdown`, `w4_churn_penalty`

## Experiment Ideas

Start with these, then explore freely:

1. **Width sweep**: Try width_ticks from 200 to 1200 in steps of 100
2. **Strategy comparison**: Try each of the 5 strategies with the same width
3. **Trigger distance tuning**: From 20 to 200
4. **Confirm minutes**: 0 vs 30 vs 60 vs 120
5. **Asymmetric ratios**: 20/80, 30/70, 40/60, 50/50 for bullish
6. **Cost-benefit gate**: Enable it, try different ratios
7. **Combined optimization**: Best width + best strategy + best trigger

## Output Format

The backtest prints (grep-parseable):

```
net_score:            12.345
net_roi_pct:          8.23
time_in_range_pct:    74.5
total_fees_token0:    123.45
total_gas_costs_usd:  2.34
total_slippage_usd:   1.56
impermanent_loss_pct: -3.2
rebalance_count:      7
max_drawdown_pct:     5.1
simulation_days:      30
elapsed_seconds:      2.3
num_periods:          3
```

## Logging Results

Append to `results.tsv` (tab-separated, NOT comma):

```
commit	net_score	net_roi_pct	status	description
a1b2c3d	12.345	8.23	keep	center width=600 trigger=50
b2c3d4e	10.100	7.10	discard	center width=300 trigger=50
c3d4e5f	-	-	crash	bullish width=100 (too narrow)
```

Status values: `keep`, `discard`, `crash`

Do NOT commit `results.tsv` — it's gitignored.

## The Experiment Loop

```
REPEAT FOREVER:
  1. Review results.tsv — what has been tried? What improved?
  2. Form a hypothesis (e.g., "wider range will reduce rebalance count")
  3. Modify strategy_config.ts with one targeted change
  4. git add strategy_config.ts && git commit -m "experiment: <description>"
  5. bash run.sh
  6. Parse: net_score=$(grep "^net_score:" run.log | awk '{print $2}')
  7. If improved: log as "keep" in results.tsv
  8. If worse: log as "discard", then git reset --hard HEAD~1
  9. If crash: log as "crash", then git reset --hard HEAD~1, try something else
  10. NEVER STOP. Keep experimenting until manually interrupted.
```

**Target**: Run at least 50 experiments. At ~10 seconds each, that's under 10 minutes of wall time.

## Important Notes

- The backtest uses synthetic market data by default (3 scenarios: sideways, trending, volatile)
- To use real data, run `npx tsx prepare.ts` first (generates data from DexScreener API)
- The scoring function rewards ROI, time-in-range, and penalizes drawdown and excessive rebalancing
- A good strategy balances all four factors — don't optimize just one
- `net_score` can be negative (costs exceed benefits)
- The best strategies typically have `net_score` > 5 and `time_in_range_pct` > 60%

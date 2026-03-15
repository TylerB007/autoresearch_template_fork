# Resume Task — ALM Strategy Backtester Autoresearch Cycle

## Session Context
- **Branch**: `claude/clone-repo-7SsbH`
- **Date paused**: 2026-03-15
- **Last commit**: `077b5f0` — feat: add real HEX/WPLS pool data fetcher and update config to match live pool

---

## What Was Built

An autoresearch-style autonomous optimizer for DeFi concentrated liquidity (V3) strategy parameters, located in `alm-backtester/`. It imports V3 math from the ALM-For-9MM-Pulsechain reference codebase and runs tick-by-tick backtests against synthetic or real price data.

### Key Files
| File | Purpose |
|------|---------|
| `alm-backtester/program.md` | Agent instructions — the autoresearch experiment loop |
| `alm-backtester/strategy_config.ts` | THE file the agent modifies (all tunable parameters) |
| `alm-backtester/backtest.ts` | Entry point — load data → simulate → print grep-parseable results |
| `alm-backtester/run.sh` | Wrapper: `timeout 60 npx tsx backtest.ts > run.log 2>&1` |
| `alm-backtester/prepare.ts` | Generates 6 synthetic market scenarios as JSONL |
| `alm-backtester/fetch_pool_data.ts` | Fetches real on-chain data (GeckoTerminal API or PulseChain RPC) |
| `alm-backtester/results.tsv` | Experiment log (gitignored) — 40+ experiments recorded |
| `alm-backtester/src/engine.ts` | Core simulation loop (do NOT modify) |
| `alm-backtester/src/simulator.ts` | Position lifecycle state machine (do NOT modify) |
| `alm-backtester/src/alm_bridge.ts` | Re-exports ALM math + local evaluateStrategy (do NOT modify) |
| `alm-backtester/src/types.ts` | Type definitions |
| `alm-backtester/tests/engine.test.ts` | 8 sanity tests (all passing) |
| `ALM-For-9MM-Pulsechain/` | Reference ALM codebase (imported via relative paths, read-only) |

---

## Target Pool
- **Pool address**: `0x8C357BE2cf2c1DE1c4Dca8aeA0Af1529f789976b`
- **Pair**: HEX/WPLS on 9mm V3 (PulseChain, chain ID 369)
- **Fee**: 2500 bps (0.25%), tick spacing 50
- **Token0**: HEX — 8 decimals, `0x2b591e99afE9f32eAA6214f7B7629768c40Eeb39`
- **Token1**: WPLS — 18 decimals, `0xA1077a294dDE1B09bB078844df40758a5D0f9a27`
- **Live stats (2026-03-15)**: TVL ~$337,780 | 24h Volume ~$402,760 | HEX price ~$0.0273
- **Current tick**: ~59650 (390 WPLS per HEX)

---

## Experiment Results Summary

### Phase 1: Synthetic data with generic params (31 experiments)
Baseline score: **-17.245** → Best score: **50.42**

Key findings:
- Wider ranges dominate (monotonic improvement 200→8000 ticks)
- Strategy type barely matters at wide widths (center ≈ bullish ≈ bearish)
- Volume/TVL ratio is the biggest lever for fee income
- Confirmation delay irrelevant when width is wide enough (0 rebalances)

### Phase 2: Synthetic data calibrated to real HEX/WPLS pool (8 experiments)
Updated startTick to 59650, real TVL/volume numbers.

| Config | net_score | ROI% | Rebalances |
|--------|-----------|------|------------|
| center w=3000 confirm=60 | 29.089 | 20.1% | 1 |
| center w=2000 confirm=60 | 23.390 | 14.9% | 3 |
| **center w=4000 confirm=0** | **29.741** | **20.7%** | **1** |
| center w=4000 trigger=100 | 29.606 | 20.6% | 1 |
| center w=5000 confirm=60 | 28.923 | 20.0% | 1 |

**Current best**: center, width=4000, trigger=50, confirm=0 → **net_score=29.741**

---

## What Needs to Happen Next

### Immediate: Fetch Real On-Chain Data
The sandbox environment blocks outbound connections to PulseChain RPCs and GeckoTerminal APIs. The user needs to run locally:

```bash
cd alm-backtester
npx tsx fetch_pool_data.ts
```

This will create `data/onchain-HEX-WPLS-2500bps.jsonl` with real swap history. Once that file exists, `bash run.sh` will automatically use it instead of synthetic data.

### Then: Re-run Full Optimization with Real Data
Once real data is available:
1. Remove synthetic data: `rm data/synthetic-*.jsonl`
2. Run baseline: `bash run.sh && grep "^net_score:" run.log`
3. Follow the experiment loop in `program.md`:
   - Width sweep: 1000, 2000, 3000, 4000, 5000, 6000
   - Strategy comparison: center, bullish, bearish, lazy_up, lazy_down
   - Trigger distance: 20, 50, 100, 200
   - Confirmation delay: 0, 30, 60, 120 minutes
   - Asymmetric ratios for bullish: 20/80, 30/70, 40/60
   - Cost-benefit gate: enable + sweep min_fee_to_cost_ratio
   - Combined optimization with best params from each sweep

### Experiments Not Yet Tried
- Bullish strategy with asymmetric lower_ratio_percent (20, 30, 40)
- Higher max_rebalances_per_window (5, 10)
- Shorter churn_window_hours (2, 4)
- Cost-benefit gate (enabled, ratio=1.0, 1.5, 2.0, 3.0)
- Different initial_capital_usd to test position share effects
- Walk-forward: train on 3 scenarios, validate on 3 holdout scenarios

---

## How to Run the Experiment Loop

```bash
cd alm-backtester

# 1. Setup (already done — verify)
npx vitest run        # Should pass 8 tests
bash run.sh           # Should produce run.log with net_score line

# 2. Modify strategy_config.ts with one change
# 3. Commit: git add strategy_config.ts && git commit -m "experiment: <description>"
# 4. Run: bash run.sh
# 5. Parse: grep "^net_score:" run.log
# 6. If improved → keep, log to results.tsv
# 7. If worse → git reset --hard HEAD~1, log as discard
# 8. Repeat
```

---

## Technical Notes

- The backtester uses BigInt V3 math imported from `ALM-For-9MM-Pulsechain/src/math.js`
- `evaluateStrategy()` is reimplemented locally in `alm_bridge.ts` to avoid winston logger dependency
- Synthetic data uses seeded xorshift32 PRNG (deterministic with same seed)
- Each backtest runs in ~14ms across 6 scenarios × 43K data points each
- `net_score = w1*ROI + w2*time_in_range - w3*max_drawdown - w4*churn_penalty` (HIGHER is better)
- The scoring weights (w1=1.0, w2=0.1, w3=0.2, w4=0.05) should NOT be changed to game the score — only change strategy/pool params

---

## Git State
- All work committed and pushed to `origin/claude/clone-repo-7SsbH`
- `results.tsv` is gitignored (experiment log stays local)
- `data/` directory is gitignored (synthetic/real data stays local)
- Clean working tree at pause time

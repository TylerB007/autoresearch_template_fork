# Strategy Analysis Prompt — 9mm V3 LP Auto-Rebalancer

## Instructions

You are analyzing performance data from an automated liquidity management bot running on PulseChain's 9mm DEX (a PancakeSwap V3 fork). Your goal is to provide actionable strategy recommendations.

## Context

- **Chain**: PulseChain (Chain ID 369), block time ~3s, gas is extremely cheap (~0.01 PLS per rebalance)
- **DEX**: 9mm V3 (PancakeSwap V3 fork with non-standard MEDIUM fee tier: 2500 = 0.25%, tick spacing 50)
- **Position type**: Concentrated liquidity (Uniswap V3 style)
- **Bot behavior**: Monitors positions every 60s, rebalances when price exits range by `trigger_distance_ticks`
- **Strategies available**:
  - `pulse_N` — Centered range of N ticks width, triggers when price exits range + trigger distance
  - `snuggle_up_N` / `snuggle_down_N` — Asymmetric ranges biased in one direction
  - `lazy_ascending` / `lazy_descending` — Directional ranges that only rebalance on trend reversals

## Data Schema

The JSON export contains:

### `positions[]` — Per-position summaries
- `tokenId`: Current NFT ID (changes on each rebalance)
- `pair`: e.g. "HEX/WPLS"
- `strategy`: Current strategy name
- `rebalanceCount`: Number of rebalances in the period
- `avgTimeInRangePercent`: How often the position was earning fees (higher = better)
- `avgFeeAPR`: Annualized fee yield (returns 0 for sub-24h periods to avoid misleading numbers)
- `avgImpermanentLossPercent`: Average IL vs holding
- `avgNetROIPercent`: (fees - gas) / capital, excludes IL
- `totalGasCostPLS`: Total gas spent on rebalances
- `chainSummary`: Full lifetime metrics across all NFT IDs (see below)
- `durationDays`: How long this position has been tracked

### `rebalances[]` — Individual rebalance events
- `timestamp`: Unix ms
- `strategy`: Strategy at time of rebalance
- `timeSincePreviousSeconds`: Time between this and the previous rebalance
- `feesCollected0/1`: Fees harvested during rebalance (stringified BigInt)
- `gasCostPLS`: Gas cost for this single rebalance
- `swapSlippageBps`: Estimated slippage from the token swap (basis points)
- `feeAPR`: Annualized fee yield for this period
- `netROIPercent`: Net return for this period
- `rawFeeYieldPercent`: Non-annualized fee yield (more reliable for short periods)
- `oldRange/newRange`: Tick ranges before and after

### `aggregateStats` — Cross-position aggregates
- `rebalancesPerDay`: Overall frequency
- `medianTimeBetweenRebalancesHours`: Median gap between rebalances
- `byStrategy`: Breakdown by strategy name

### `marketContext`
- `volatility`: Recent tick volatility (stdDev, regime, avgTickChange, maxTickChange)
  - Regimes: `low` (<5 ticks), `medium` (5-20), `high` (>20 ticks stdDev)

### `chainSummary` (in positions) — Lifetime chain metrics
- `totalRebalances`: Total across all NFT IDs in the chain
- `avgTimeInRangePercent`: Weighted average time in range
- `avgFeeAPR`: Average annualized fee APR
- `cumulativeNetROIPercent`: Cumulative net ROI across all links
- `totalGasCostPLS`: Total gas across entire chain
- `avgSlippageBps`: Average swap slippage

## Analysis Questions

Please analyze the following:

1. **Range Width vs Volatility**: Is the current range width appropriate for the observed tick volatility? Should it be wider (fewer rebalances, more time in range) or narrower (higher capital efficiency, more fees)?

2. **Rebalance Frequency**: Are rebalances happening too often (churn) or too infrequently (missing fees)? Look for back-to-back rebalances with low/zero fees collected.

3. **Fee Yield Efficiency**: What percentage of the theoretical maximum fees is the position actually capturing? Consider time-in-range, slippage, and gas costs.

4. **Impermanent Loss Impact**: How significant is IL compared to fee earnings? Is the net (fees - IL - gas) positive?

5. **Strategy Comparison**: If multiple strategies are present, which performs better and why?

6. **Cost-Benefit**: Are rebalances paying for themselves? Calculate the average break-even time for each rebalance.

7. **Directional Bias**: Does the price tend to move more in one direction? Would an asymmetric strategy (snuggle_up/down) be more appropriate?

8. **Recommendations**: Specific, actionable changes to:
   - Width (in ticks, multiples of 50 for tick spacing)
   - Trigger distance
   - Strategy type
   - Confirmation delay (minutes to wait before rebalancing)

## Output Format

Provide your analysis as:

### Overall Assessment
2-3 sentence summary of portfolio health.

### Per-Position Analysis
For each position, provide specific metrics and recommendations.

### Risk Warnings
Any concerning patterns (excessive churn, negative ROI, high IL).

### Recommended Changes
Specific parameter changes with rationale.

---

## Paste Your Export Data Below

```json
// Paste the output of: npm run analytics export -- --days=30
```

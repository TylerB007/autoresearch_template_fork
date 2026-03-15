# V3 LP Auto-Rebalancer: Future Upgrades Roadmap
**Generated from Technical Research & Top-Tier DeFi Repository Analysis**

This document outlines the next-generation upgrades for the `ALM-For-9MM-Pulsechain` project, utilizing architectures from leading DeFi protocols (Aperture, Gamma, Arrakis, Paradigm, Messari, and Zelos). 

---

## 1. Volatility-Adaptive Tick Widths (Dynamic LP)
**Goal:** Replace static `width_ticks` with dynamic ranges that expand during high volatility and contract during consolidation to maximize capital efficiency.
**Sources:** Aperture Finance (Automation SDK), Zelos Alpha Research.

### Implementation Instructions:
1. **Enhance `src/analytics/volatility.ts`**:
   - Implement rolling standard deviation formulas to calculate an annualized volatility score for the last 7, 14, and 30 days.
2. **Update `src/strategy.ts`**:
   - Introduce a new config toggle: `dynamic_width: true`.
   - Write a `calculateOptimalWidth(volatilityMetrics)` function to determine the target tick boundaries.
   - Example behavior: If HEX/WPLS volatility spikes above a certain threshold (e.g., 80% APY), dynamically widen the target rebalance range to 800 ticks (preventing constant out-of-range churning). If it drops, tighten to 200 ticks.
3. **Data Types**: All math must strictly use `BigInt` and calculate against `sqrtPriceX96`.

---

## 2. Intent-Based Cost/Benefit Solver (Smart Rebalancing)
**Goal:** Stop "dumb" rebalancing. The bot should evaluate the expected algorithmic profitability of a rebalance against the current network gas fee.
**Sources:** Aperture Finance (Intents).

### Implementation Instructions:
1. **Extend `src/costBenefit.ts`**:
   - Integrate an on-chain gas estimator for the 3-step process: Burn NFT -> Swap Tokens -> Mint NFT. Convert gas fee into USD.
   - Create a function `predict24hFees(newTickRange, currentVolume)` to estimate the expected yield of the fixed position.
2. **Update `src/rebalancer.ts`**:
   - Before firing the rebalance transaction, run `evaluateRebalanceIntent()`.
   - **Condition:** If `(Estimated Gas Cost) > (Expected 24h Fees - Expected 24h IL)`, return a `RebalanceDelayed` status. 
   - Add this delay logic to the existing `confirm_minutes` timer logic.

---

## 3. Options-Based "Effective Loss" Metric (Institutional Analytics)
**Goal:** Upgrade dashboard analytics from basic Impermanent Loss (IL) to "Effective Loss," treating LP positions as perpetual synthetic options.
**Sources:** Gamma Strategies / Guillaume Lambert's `awesome-uniswap-v3` research.

### Implementation Instructions:
1. **Modify `src/analytics/metrics.ts`**:
   - Add mathematical functions to calculate the position's "Delta" and "Gamma" risk.
   - Separate Impermanent Loss into *Expected Divergence* based on options pricing models.
2. **Upgrade `src/analytics/healthScore.ts`**:
   - Refactor the 0-100 score. A position that is slightly out-of-range but has high implied volatility (options premium) might actually be mathematically "healthier" than an in-range position in a dead market.
3. **Dashboard Integration**: Feed these new metrics down through the API to the React frontend `MetricCard` components.

---

## 4. MEV-Resistant Swap Hardening
**Goal:** Bulletproof the swap execution phase against JIT liquidity and multi-block sandwich attacks on PulseChain and other EVM chains.
**Sources:** Arrakis Finance (`v2-core`), Paradigm (`smart-order-router`).

### Implementation Instructions:
1. **Refactor `src/swap.ts`**:
   - Do not rely purely on `amountOutMinimum` (which assumes a 1:1 token price ratio and is vulnerable to front-running).
   - Implement strict slippage derived from `sqrtPriceLimitX96`. 
   - Calculate maximum acceptable curve displacement based on Paradigm’s AMM research math. If a router (Piteas/1inch) attempts a route that pushes the tick beyond this absolute `sqrtPriceX96` boundary, revert instantly.
2. **TWAP Expansion**: Ensure the TWAP check happens directly in the execution block context to prevent sudden atomic price manipulation prior to your mint.

---

## 5. Standardized GraphQL Retrospective Backfills
**Goal:** Transition historical data fetching from rate-limited RPC/DexScreener API calls to resilient, standardized Subgraphs to scale the UI data.
**Sources:** Messari Subgraphs, The Graph.

### Implementation Instructions:
1. **Enhance `src/analytics/backfill.ts`**:
   - Introduce a GraphQL client (e.g., `graphql-request`).
   - Query Messari’s standardized V3 subgraphs mapping `pool volumes`, `tick depth`, and `fee generation` for Base, Ethereum, and Arbitrum.
2. **State Construction**: 
   - Reconstruct the total historical PnL of a minted position instantly upon discovery (via `positionDiscovery.ts`), populating the `PriceHistoryRecord` store without waiting for 30 days of live cron data.

---

## 6. Offline Simulation & Backtesting Engine
**Goal:** Allow "dry running" of `config.yaml` strategies against historical pool states before committing real capital.
**Sources:** Revert Finance (`revert-backtester`), Aloe Labs (`uniswap-simulator`).

### Implementation Instructions:
1. **Create `scripts/simulate-strategy.ts`**:
   - Build a local Monte Carlo simulator utilizing the historical data aggregated in step 5.
   - Run a test configuration (e.g., `width: 300, lower_ratio: 25%`) through the last 60 days of real tick data.
2. **Output**: Print a simulated PnL report detailing how many times a rebalance *would* have triggered, the simulated gas cost, and the net yield compared to HODL. Use this to fine-tune strategy configuration safely.

---

## Rules for Future Agents Building These Modules:
- **Strict ESM Requirements:** All new file imports must use the `.js` extension (e.g., `import { X } from './math.js';`).
- **BigInt Domination:** Never use JS native `Number()` floats for options-pricing mathematics or volatility targets. Use `BigInt` scaling.
- **Dry-Run Confirmation:** Every feature introduced above must run successfully with `dry_run: true` in `config.yaml` for a verifiable window before moving to active execution logic to production logic dealing with private keys.

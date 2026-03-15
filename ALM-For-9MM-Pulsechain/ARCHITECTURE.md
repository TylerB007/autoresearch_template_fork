# System Architecture

**9mm V3 LP Auto-Rebalancer on PulseChain**

---

## 🏗️ High-Level Architecture

```
┌──────────────────────────────────────────────────────────────┐
│                     User / Operator                          │
│           (SSH / Telegram / Dashboard / Logs)                │
└───────────────────────┬──────────────────────────────────────┘
                        │
┌───────────────────────▼──────────────────────────────────────┐
│              DigitalOcean VPS (Ubuntu 24.04)                 │
│  ┌──────────────────────────────────────────────────────┐   │
│  │              PM2 Process Manager                      │   │
│  │  ┌────────────────────────────────────────────────┐  │   │
│  │  │     9mm-rebalancer (Node.js v22)              │  │   │
│  │  │  • Monitoring Loop (60s interval)             │  │   │
│  │  │  • Check position status, evaluate rebalance  │  │   │
│  │  │  • Execute rebalance if needed                │  │   │
│  │  │  • Telegram two-way commands                  │  │   │
│  │  └────────────────────────────────────────────────┘  │   │
│  │  ┌────────────────────────────────────────────────┐  │   │
│  │  │     9mm-dashboard (Express + React)           │  │   │
│  │  │  • REST API (JWT auth, rate limited)          │  │   │
│  │  │  • React SPA (positions, analytics, recovery) │  │   │
│  │  │  • DexScreener price feed (5-min cache)       │  │   │
│  │  │  • Caddy reverse proxy (TLS on :443)          │  │   │
│  │  └────────────────────────────────────────────────┘  │   │
│  └──────────────────────────────────────────────────────┘   │
└───────────────────────┬──────────────────────────────────────┘
                        │
        ┌───────────────┼───────────────┐
        │               │               │
        ▼               ▼               ▼
┌────────────┐  ┌────────────┐  ┌────────────┐
│  RPC Node  │  │  RPC Node  │  │  RPC Node  │
│  Primary   │  │  Fallback1 │  │  Fallback2 │
└─────┬──────┘  └─────┬──────┘  └─────┬──────┘
      │               │               │
      └───────────────┴───────────────┘
                      │
        ┌─────────────▼─────────────┐
        │   PulseChain Network      │
        │   (Chain ID 369)          │
        │                           │
        │  ┌─────────────────────┐  │
        │  │   9mm V3 DEX        │  │
        │  │  • Position Manager │  │
        │  │  • Swap Router      │  │
        │  │  • Factory          │  │
        │  │  • Pools            │  │
        │  └─────────────────────┘  │
        └───────────────────────────┘
                      │
        ┌─────────────▼─────────────┐
        │   Telegram API            │
        │   (Notifications)         │
        └───────────────────────────┘
```

---

## 📦 Module Architecture

### Core Modules

```
src/
├── index.ts              ─── Entry point & monitoring loop
│   ├── Loads configuration
│   ├── Initializes providers & contracts
│   ├── Starts monitoring loop (30s interval)
│   └── Handles graceful shutdown (SIGINT/SIGTERM)
│
├── chain.ts              ─── RPC provider management
│   ├── Multi-provider fallback (3 RPC endpoints)
│   ├── Nonce tracking
│   └── Network configuration
│
├── contracts.ts          ─── Contract instances (ethers v6)
│   ├── NonfungiblePositionManager (getter — dynamic provider)
│   ├── SwapRouter (getter — dynamic provider)
│   ├── Factory (getter — dynamic provider)
│   ├── Quoter
│   └── Uses createRequire() for ABI imports in ESM
│
├── rebalancer.ts         ─── 7-step rebalance workflow
│   ├── Step 1: Fetch current position
│   ├── Step 2: Calculate new range
│   ├── Step 3: Remove liquidity
│   ├── Step 4: Collect fees
│   ├── Step 5: Swap to rebalance ratio
│   ├── Step 6: Mint new position
│   ├── Step 7: Burn old NFT
│   └── Safe mode: Return to old position on failure
│
├── math.ts               ─── BigInt V3 math (tick/price/liquidity)
│   ├── TickMath (ported from Solidity)
│   ├── getSqrtRatioAtTick()
│   ├── getTickAtSqrtRatio()
│   ├── getLiquidityForAmounts()
│   └── getAmountsForLiquidity()
│
├── configLoader.ts       ─── YAML config loader
│   ├── Loads config.yaml at runtime
│   └── Named to avoid collision with src/config/
│
├── notifications.ts      ─── Telegram & Discord integration
│   └── Sends rebalance notifications
│
├── logger.ts             ─── Winston logging setup
│   ├── Console transport (colorized)
│   ├── File transports (JSON format)
│   └── Error log separate from info log
│
├── analytics-cli.ts      ─── CLI dashboard for viewing analytics
│   ├── status [tokenId]  — Position performance report
│   ├── history [tokenId] — Rebalance timeline with gas breakdown
│   └── summary           — Overall performance across all positions
│
├── analytics/            ─── Performance tracking & metrics (v1.1.0)
│   ├── types.ts          ─── Analytics type definitions
│   │   ├── PositionSnapshot (lightweight, every monitoring cycle)
│   │   ├── RebalanceAnalytics (comprehensive, at rebalance time)
│   │   ├── GasUsageData (per-step gas from receipts)
│   │   ├── RebalanceMetrics (IL, APR, ROI, efficiency)
│   │   ├── TriggerEvent (structured hold/exit/warning events) (v2.8.0)
│   │   ├── StrategyRuleSetSnapshot (versioned param history) (v2.8.0)
│   │   └── PriceHistoryRecord (per-pool price observations) (v2.8.0)
│   ├── collector.ts      ─── Data capture orchestrator
│   │   ├── createSnapshot() — O(1) from PositionStatus
│   │   ├── processSnapshot() — cache + disk at interval
│   │   ├── captureRebalance() — full analytics with metrics
│   │   ├── emitTriggerEvent() — structured hold/exit/warning events (v2.8.0)
│   │   └── emitRuleSetSnapshot() — versioned strategy param snapshots (v2.8.0)
│   ├── metrics.ts        ─── Performance calculations
│   │   ├── calculateFeeAPR() — annualized fee return
│   │   ├── calculateImpermanentLoss() — IL vs HODL
│   │   ├── calculateCapitalEfficiency() — range concentration
│   │   ├── estimateTimeInRange() — from snapshot history
│   │   └── calculateRebalanceCost() — execution cost (preValue - postValue - gas)
│   ├── healthScore.ts    ─── Position health scoring (v1.9.0)
│   │   ├── calculateHealthScore() — component-based 0-100 score
│   │   └── Components: P&L, fees, time-in-range, distance, exec cost
│   ├── volatility.ts     ─── Volatility metrics (v1.9.0)
│   │   ├── Tick range, std deviation, annualized volatility
│   │   └── Computed from snapshot history
│   ├── priceHistory.ts   ─── Price history & annualized volatility (v2.8.0)
│   │   ├── appendPriceHistory() — JSONL per-pool rolling 30-day store
│   │   ├── prunePriceHistory() — atomic retention (tmp + rename)
│   │   ├── computeSigma() — sigma_7d/sigma_30d (log-return * sqrt(samples/yr))
│   │   ├── computeViabilityFields() — min_pl_rate = sigma^2/8, profitability_viable
│   │   └── buildPriceHistoryRecord() — factory function
│   ├── retrospective.ts  ─── Retrospective outcome backfill (v2.8.0)
│   │   ├── startRetrospectiveBackfill() — background job (6h interval)
│   │   ├── stopRetrospectiveBackfill() — graceful shutdown
│   │   └── Backfills: feesEarned1d/3d/7dUsd, actualDaysToRecovery,
│   │       recoveredBeforeNextRebalance, nextRebalanceId
│   ├── backfill.ts       ─── Price backfill queue (v2.8.0)
│   │   ├── In-memory queue for events missing USD prices
│   │   ├── Multi-source resolver: DexScreener → CoinGecko → TWAP
│   │   └── Background job (5-min interval)
│   ├── historicalPrice.ts ─── Historical price enrichment (v2.8.0)
│   │   └── Enriches lifecycle events with USD prices post-hoc
│   ├── chain.ts          ─── Position chain builder (v1.9.0)
│   │   ├── getPositionChain() — root→current lineage with per-link metrics
│   │   └── Aggregate stats: total rebalances, cumulative ROI, avg time-in-range
│   ├── export.ts         ─── Analytics export (v1.9.0)
│   │   ├── exportRebalanceDetails() — CSV/JSON per-rebalance
│   │   └── exportSnapshotHistory() — CSV/JSON per-snapshot
│   ├── storage.ts        ─── JSON Lines persistence
│   │   ├── Daily rotation: analytics-YYYY-MM-DD.jsonl
│   │   ├── BigInt serialization (replacer/reviver)
│   │   ├── queryRebalances() / querySnapshots()
│   │   ├── queryTriggerEvents() / queryAllChainTriggerEvents() (v2.8.0)
│   │   └── queryStrategyRuleSets() / getLatestRuleSet() (v2.8.0)
│   └── cache.ts          ─── In-memory cache
│       ├── Latest snapshot per position
│       ├── Last 100 rebalances
│       └── Fast CLI queries without disk I/O
│
├── recovery.ts           ─── Stranded funds detection & recovery
│   ├── detectStrandedFunds() — reads .recovery-state.json + wallet balances
│   ├── recoverStrandedFunds() — mints new position from wallet balances
│   └── Called by bot on startup + dashboard API + Telegram /recover
│
├── costBenefit.ts        ─── Rebalance cost-benefit evaluation (v1.9.0)
│   ├── Break-even analysis for rebalance decisions
│   └── Profitability assessment (fees vs costs)
│
├── notifications/        ─── Advanced notification system (v1.9.0)
│   └── proactive.ts     ─── Scheduled health/fee Telegram alerts
│       ├── Health degradation warnings
│       ├── Prolonged out-of-range alerts
│       └── Fee milestone notifications
│
├── aggregators/          ─── DEX aggregator integrations (v1.5.0+)
│   ├── types.ts          ─── Shared aggregator interface types (v1.9.0)
│   ├── piteas.ts         ─── Piteas aggregator API client
│   │   ├── getQuote() — fetch best route across PulseChain DEXes
│   │   └── executeSwap() — execute aggregator swap with slippage
│   └── oneinch.ts        ─── 1inch aggregator API client (v1.9.0)
│       ├── getQuote() — fetch 1inch route
│       └── executeSwap() — execute 1inch swap
│
├── server/               ─── Express API server (v1.3.0+)
│   ├── index.ts          ─── Express app, middleware, route mounting
│   ├── auth.ts           ─── JWT auth middleware + login endpoint
│   ├── routes/
│   │   ├── dashboard.ts  ─── GET /api/dashboard (wallet, positions overview)
│   │   ├── positions.ts  ─── CRUD + live status + manual fee collection
│   │   ├── rebalances.ts ─── GET /api/rebalances (history from analytics)
│   │   ├── analytics.ts  ─── Position analytics, snapshots, portfolio summary
│   │   ├── config.ts     ─── GET /api/config (sanitized)
│   │   └── recovery.ts   ─── Recovery status, dismiss, recover (v1.4.0)
│   └── services/
│       └── priceService.ts ─── DexScreener USD prices (5-min cache)
│
├── web/                  ─── React frontend (v1.3.0+)
│   └── src/
│       ├── App.tsx       ─── Route definitions
│       ├── api/client.ts ─── API client + helpers (tickToPrice, formatUsd, etc.)
│       ├── pages/        ─── Dashboard, Positions, PositionDetail, PositionAnalytics, PositionChain, History, Login
│       ├── components/   ─── Navbar, PositionCard, RangeBar, StatusBadge, ConfirmDialog, MetricCard
│       │   └── charts/   ─── FeeChart, ILChart (Recharts)
│       └── context/      ─── AuthContext (JWT token management)
│
└── config/               ─── Static constants & addresses
    ├── index.ts          ─── Barrel export
    ├── pulsechain.ts     ─── Chain config (ID 369, RPC URLs)
    ├── contracts.ts      ─── Verified contract addresses
    ├── fees.ts           ─── Fee tiers (MEDIUM = 2500, not 3000!)
    └── constants.ts      ─── Gas limits, selectors, etc.
```

---

## 🔄 Data Flow

### Monitoring Loop

```
┌─────────────────────────────────────────────────────────────┐
│  1. Timer Triggers (every 60 seconds)                       │
└────────────────────┬────────────────────────────────────────┘
                     │
┌────────────────────▼────────────────────────────────────────┐
│  2. For each configured position:                           │
│     • Read position data from NFT contract                  │
│     • Get pool state (current tick, liquidity, etc.)        │
│     • Fetch token balances                                  │
└────────────────────┬────────────────────────────────────────┘
                     │
┌────────────────────▼────────────────────────────────────────┐
│  3. Evaluate rebalance conditions:                          │
│     • Is position out of range?                             │
│     • Is trigger distance exceeded? (50 ticks)              │
│     • Has position been out of range long enough?           │
│       (confirm_minutes: 60 min default)                     │
│     • Is cooldown period satisfied? (5 min)                 │
│     • Is gas price acceptable? (< 2000 gwei)                │
└────────────────────┬────────────────────────────────────────┘
                     │
          ┌──────────┴──────────┐
          │                     │
    ┌─────▼─────┐        ┌─────▼─────┐
    │  Rebalance│        │   Skip    │
    │  Needed   │        │           │
    └─────┬─────┘        └───────────┘
          │
┌─────────▼──────────────────────────────────────────────────┐
│  4. Execute Rebalance (7 steps):                            │
│     a. Fetch current position & pool state                  │
│     b. Calculate new range (centered on current price)      │
│     c. Decrease liquidity from old position                 │
│     d. Collect fees & tokens                                │
│     e. Swap tokens to match new range ratio (if needed)     │
│     f. Increase liquidity in new position (or mint new)     │
│     g. Burn old NFT (if minted new)                         │
└─────────┬──────────────────────────────────────────────────┘
          │
┌─────────▼──────────────────────────────────────────────────┐
│  5. Post-Rebalance:                                         │
│     • Update last rebalance timestamp (cooldown)            │
│     • Capture analytics (gas, fees, IL, metrics)            │
│     • Send notification (Telegram/Discord)                  │
│     • Log transaction hash & new position details           │
└─────────────────────────────────────────────────────────────┘
```

### Analytics Data Flow (v1.1.0)

```
Monitoring Loop (every 30s)
    │
    ├── getPositionStatus() ──→ PositionSnapshot
    │                              │
    │                     ┌────────┴────────┐
    │                     │                 │
    │              updateCache()     persistToDisk()
    │              (always)          (every 10 min)
    │                                       │
    │                              analytics/analytics-YYYY-MM-DD.jsonl
    │
    ├── checkAndRebalance()
    │         │
    │    [if rebalance triggered]
    │         │
    │    ┌────▼─────────────────────────────────┐
    │    │  Pre-status captured (freshStatus)    │
    │    │  Execute 7-step rebalance             │
    │    │  Gas tracked per step (from receipts) │
    │    │  Post-status captured (new position)  │
    │    └────┬─────────────────────────────────┘
    │         │
    │    captureRebalance()
    │         ├── calculateRebalanceMetrics()
    │         │     ├── Fee APR
    │         │     ├── Impermanent Loss
    │         │     ├── Capital Efficiency
    │         │     └── Net ROI
    │         ├── updateRebalanceCache()
    │         └── writeAnalyticsRecord() ──→ JSONL file
    │
    └── CLI Dashboard reads cache + storage
         ├── npm run analytics summary
         ├── npm run analytics status [tokenId]
         └── npm run analytics history [tokenId]
```

### Doc A Data Capture Flow (v2.8.0)

```
Monitoring Loop (every 60s)
    │
    ├── emitTriggerEvent()                    ← EVERY cycle (not just rebalances)
    │   ├── type: 'hold' | 'price_exit' | 'near_edge_warning' | ...
    │   ├── Context: sigma, poolFeeRate, distance, timeInRange, estimatedCost
    │   └── ──→ analytics-YYYY-MM-DD.jsonl (type: 'trigger_event')
    │
    ├── [on config change via /config or reloadPositions()]
    │   └── emitRuleSetSnapshot()             ← versioned strategy params
    │       └── ──→ analytics-YYYY-MM-DD.jsonl (type: 'strategy_rule_set')
    │
    ├── [price observation]
    │   └── appendPriceHistory()              ← per-pool JSONL
    │       └── ──→ price-history-{pool}.jsonl (30-day rolling)
    │
    └── [price unavailable at event time]
        └── enqueuePendingPrice()             ← in-memory backfill queue
            └── Background job (5 min) retries: DexScreener → CoinGecko → TWAP

Background Jobs:
    │
    ├── Price Backfill (every 5 min)
    │   └── Resolves pending prices from multi-source resolver
    │
    ├── Retrospective Backfill (every 6 hours)
    │   ├── Reads rebalances.jsonl
    │   ├── For each rebalance old enough:
    │   │   ├── Sum fees earned 1d/3d/7d after rebalance
    │   │   ├── Compute actualDaysToRecovery (sentinel -1 = never)
    │   │   ├── Link nextRebalanceId
    │   │   └── Set recoveredBeforeNextRebalance
    │   └── Atomic rewrite of rebalances.jsonl
    │
    └── Price History Pruning
        └── Removes observations older than 30 days

Volatility Pipeline:
    price-history-{pool}.jsonl
        │
        └── computeSigma()
            ├── sigma_7d = std_dev(log_returns_7d) × √(samples_per_year)
            ├── sigma_30d = std_dev(log_returns_30d) × √(samples_per_year)
            └── confidence: high/medium/low/insufficient
                │
                └── computeViabilityFields()
                    ├── min_pl_rate = sigma30d² / 8
                    ├── profitability_margin = pool_fee_rate − min_pl_rate
                    ├── profitability_viable = pool_fee_rate > min_pl_rate
                    └── effective_apr_pct = pool_fee_rate × (100 / width_pct)
```

---

## 🧮 Rebalance Logic

### Strategy System

The rebalancer supports multiple strategies defined in [src/strategy.ts](src/strategy.ts). Each strategy controls:
1. **When** to rebalance (trigger condition)
2. **How** to position the new range (width distribution)

All strategies share the same parameters:

```typescript
{
  width_ticks: 600,           // Total position width in ticks
  // width_percentage: 6,     // Alternatively, define width as a percentage
  trigger_distance_ticks: 50, // Rebalance when price N ticks outside range
  // trigger_percentage: 0.5, // Alternatively, define trigger as a percentage
  confirm_minutes: 60         // Must stay out of range this many minutes before rebalancing
}
```

---

### Symmetric Strategies

#### Pulse Strategy (Default)

**Behavior**: Standard re-centering around current price.

**Trigger**: Price moves outside range + trigger buffer (bidirectional).

**Range Calculation**:
```typescript
// width_ticks can be derived from width_percentage
halfWidth = Math.floor(width_ticks / 2)
newTickLower = nearestUsableTick(currentTick - halfWidth, tickSpacing)
newTickUpper = nearestUsableTick(currentTick + halfWidth, tickSpacing)
```

**Example**:
- `width_ticks = 600` (or `width_percentage = 6`), `currentTick = 1000`
- Result: `[700, 1300]` (300 ticks below, 300 ticks above)

**Use Case**: Neutral market, maximize time in range.

---

#### Static Strategy

**Behavior**: Passive monitoring only, never rebalances.

**Trigger**: Never.

**Use Case**: Manual control, logging/notifications without automated trading.

---

### Asymmetric Strategies (v1.2.0)

#### Snuggle Up Strategy

**Behavior**: Bullish bias, more room for upside.

**Trigger**: Price moves outside range + trigger buffer (bidirectional, same as pulse).

**Range Calculation**:
```typescript
// width_ticks can be derived from width_percentage
lowerWidth = Math.floor(width_ticks * 0.3)  // 30% below
upperWidth = width_ticks - lowerWidth        // 70% above
newTickLower = nearestUsableTick(currentTick - lowerWidth, tickSpacing)
newTickUpper = nearestUsableTick(currentTick + upperWidth, tickSpacing)
```

**Example**:
- `width_ticks = 600` (or `width_percentage = 6`), `currentTick = 1000`
- Result: `[820, 1420]` (180 ticks below, 420 ticks above)

**Use Case**: Bullish sentiment, expect price to rise. More upside room before going out of range.

**Impermanent Loss**: Higher IL risk if price drops, better fees if price rises.

---

#### Snuggle Down Strategy

**Behavior**: Bearish bias, more room for downside.

**Trigger**: Price moves outside range + trigger buffer (bidirectional, same as pulse).

**Range Calculation**:
```typescript
// width_ticks can be derived from width_percentage
upperWidth = Math.floor(width_ticks * 0.3)  // 30% above
lowerWidth = width_ticks - upperWidth        // 70% below
newTickLower = nearestUsableTick(currentTick - lowerWidth, tickSpacing)
newTickUpper = nearestUsableTick(currentTick + upperWidth, tickSpacing)
```

**Example**:
- `width_ticks = 600` (or `width_percentage = 6`), `currentTick = 1000`
- Result: `[580, 1180]` (420 ticks below, 180 ticks above)

**Use Case**: Bearish sentiment, expect price to fall. More downside room before going out of range.

**Impermanent Loss**: Higher IL risk if price rises, better fees if price falls.

---

### Directional Strategies

#### Lazy Ascending Strategy

**Behavior**: Bullish trend following, only rebalances upward.

**Trigger**: Only when price moves ABOVE upper bound + trigger buffer.

**Range Calculation**: Same as pulse (50/50 centered).

**Use Case**: Follow pumps, avoid selling during dumps. Holds position if price drops below range.

---

#### Lazy Descending Strategy

**Behavior**: Bearish trend following, only rebalances downward.

**Trigger**: Only when price moves BELOW lower bound + trigger buffer.

**Range Calculation**: Same as pulse (50/50 centered).

**Use Case**: Accumulate on dips, take profit on rallies. Holds position if price pumps above range.

---

### Strategy Comparison

| Strategy | Trigger | Width Split | When to Use |
|----------|---------|-------------|-------------|
| pulse | Bidirectional (out of range) | 50% / 50% | Neutral market |
| snuggle_up | Bidirectional (out of range) | 30% / 70% | Bullish bias |
| snuggle_down | Bidirectional (out of range) | 70% / 30% | Bearish bias |
| lazy_ascending | Only above upper | 50% / 50% | Follow pumps |
| lazy_descending | Only below lower | 50% / 50% | Accumulate dips |
| static | Never | N/A | Manual control |

**Key Insight**:
- **Directional strategies** change *when* rebalancing happens (trigger condition)
- **Asymmetric strategies** change *how* the range is positioned (width distribution)

---

### Price Range Calculation (General)

```
Current Pool Tick: T_current

Old Position Range:
  Lower Tick: T_lower_old
  Upper Tick: T_upper_old

Rebalance Trigger:
  // trigger_distance_ticks can be derived from trigger_percentage
  IF (T_current < T_lower_old - trigger_distance_ticks)
  OR (T_current > T_upper_old + trigger_distance_ticks)
  THEN rebalance

New Position Range:
  // width_ticks can be derived from width_percentage
  Center: T_current (round to tick spacing = 50)
  Lower Tick: T_current - (width_ticks / 2)
  Upper Tick: T_current + (width_ticks / 2)

Example:
  T_current = 280704
  width_ticks = 600 (or width_percentage = 6)

  T_lower_new = 280704 - 300 = 280404 → round to 280400
  T_upper_new = 280704 + 300 = 281004 → round to 281000

  New Range: [280400, 281000]
```

### Liquidity Rebalancing

```
1. Remove all liquidity from old position
   → Receive token0_amount, token1_amount

2. Calculate target ratio for new range
   → ratio = getLiquidityForAmounts(
       sqrtPriceX96_current,
       sqrtPriceX96_lower_new,
       sqrtPriceX96_upper_new,
       token0_amount,
       token1_amount
     )

3. If ratio doesn't match, swap tokens
   → Swap excess token0 → token1 (or vice versa)
   → Route via configured swap provider (defaults to Piteas):
     • Piteas (DEFAULT): DEX aggregator across all PulseChain DEXes (best for most pairs)
     • Direct (opt-in): 9mm SwapRouter only (for exceptional 9mm liquidity)
   → Slippage protection via config.slippage_tolerance_bps

4. Add liquidity to new position
   → Mint new NFT (or increase liquidity in existing)
   → All available tokens deposited
```

**Swap Providers** (v1.5.0+):
- **Piteas Aggregator Mode (DEFAULT)**: Routes across all PulseChain DEXes
  - Best for: Most trading pairs (thin 9mm liquidity is common)
  - Gas cost: ~250k-400k gas
  - Multi-DEX routing: 9inch, PulseX V1/V2/V3, etc.
  - Typically 5-15% better execution despite higher gas
  - API: https://api.piteas.io
  - No config needed - this is now the default
  
- **Direct Mode (opt-in)**: Routes through 9mm SwapRouter only
  - Best for: Pairs with exceptional 9mm liquidity (rare)
  - Gas cost: ~150k-200k gas
  - Single-DEX routing
  - Add `swap_provider: "direct"` to config.yaml to use

See [DEX Aggregator Guide](docs/DEX_AGGREGATOR_GUIDE.md) for details.

---

## 🔐 Security Model

### Private Key Management
- Stored in `.secret` file (600 permissions, read/write by owner only)
- Rotated on 2026-02-10 to fresh wallet
- Never committed to git (.gitignore)
- Loaded via dotenv at runtime
- Used for transaction signing only

### Transaction Safety
1. **Dry Run Mode**: Test mode with no real transactions
2. **Gas Price Limits**: Reject if gas > 2000 gwei
3. **Slippage Protection**: Max 1% slippage on swaps
4. **Cooldown Period**: 5 minutes between rebalances
5. **Safe Mode**: Revert to old position on failure

### RPC Failover
- Primary RPC failure → Fallback 1
- Fallback 1 failure → Fallback 2
- All RPC calls retry with exponential backoff

---

## 📊 Logging Architecture

### Winston Transports

```
logs/
├── rebalancer.log        ─── All logs (info + error)
│   └── Format: JSON, one line per log entry
│
├── error.log             ─── Errors only
│   └── Format: JSON, one line per log entry
│
└── (Console)             ─── Development/debugging
    └── Format: Colorized, human-readable
```

### PM2 Logs

```
logs/
├── pm2-out.log           ─── stdout from application
│   └── Rotated: 10MB max, 10 files retained
│
└── pm2-error.log         ─── stderr from application
    └── Rotated: 10MB max, 10 files retained
```

### Log Rotation
- **Winston**: Manual rotation (future improvement)
- **PM2**: Automatic via pm2-logrotate
  - Max size: 10 MB per file
  - Retention: 10 files
  - Compression: gzip
  - Schedule: Daily at midnight UTC

---

## 🔌 External Dependencies

### On-Chain
- **9mm V3 Contracts** (PulseChain mainnet)
  - NonfungiblePositionManager: `0xCC05bf158202b4F461Ede8843d76dcd7Bbad07f2`
  - SwapRouter: `0xeB45a3c4aedd0F47F345fB4c8A1802BB5740d725`
  - Factory: `0xe50dbdc88e87a2c92984d794bcf3d1d76f619c68`

### Off-Chain
- **RPC Providers** (3 endpoints with fallback)
  - Primary: `https://rpc.pulsechain.com`
  - Fallback 1: `https://rpc-pulsechain.g4mm4.io`
  - Fallback 2: `https://pulsechain-rpc.publicnode.com`

- **Telegram API** (optional notifications)
  - Bot token from config.yaml
  - Chat ID from config.yaml

- **Discord Webhooks** (optional notifications)
  - Webhook URL from config.yaml

---

## ⚙️ Configuration System

### Environment Variables (.env / .secret)
```env
PRIVATE_KEY=0x...                          # Wallet private key (in .secret on VPS)
RPC_URL_PRIMARY=https://rpc.pulsechain.com
RPC_URL_FALLBACK_1=https://rpc-pulsechain.g4mm4.io
RPC_URL_FALLBACK_2=https://pulsechain-rpc.publicnode.com
```

### Runtime Configuration (config.yaml)
```yaml
polling_interval_seconds: 60               # Monitoring frequency
max_gas_price_gwei: 2000                   # Gas price limit
dry_run: true                              # Safe mode flag
slippage_tolerance_bps: 100                # 1% slippage
rebalance_cooldown_seconds: 300            # 5 min cooldown

contracts:
  nonfungiblePositionManager: "0x..."
  swapRouter: "0x..."
  factory: "0x..."
  quoter: "0x..."

chain:
  chainId: 369
  rpcUrls: [...]

notifications:
  enabled: true
  telegram_bot_token: "..."
  telegram_chat_id: "..."
  discord_webhook_url: ""

analytics:
  enabled: true
  snapshot_interval_minutes: 10
  persist_to_disk: true
  storage_path: "./analytics"

positions:
  - token_id: 155361
    strategy: "pulse_300"
    params:
      trigger_percentage: 0.5 # Or use trigger_distance_ticks: 50
      confirm_minutes: 60
```

---

## 🚀 Deployment Architecture

### Process Management (PM2)
```javascript
// ecosystem.config.cjs
{
  name: '9mm-rebalancer',
  script: 'dist/index.js',
  instances: 1,                    // Single instance
  exec_mode: 'fork',               // Not cluster mode
  autorestart: true,               // Auto-restart on crash
  max_restarts: 10,                // Prevent restart loop
  restart_delay: 10000,            // 10s between restarts
  max_memory_restart: '512M',      // Restart if > 512MB
  kill_timeout: 5000,              // Allow graceful shutdown
  env: {
    NODE_ENV: 'production'
  }
}
```

### System Services
- **systemd** manages PM2 daemon
  - Service: `pm2-root.service`
  - Auto-starts on boot
  - Restarts PM2 on crash

---

## 📈 Performance Characteristics

### Resource Usage
- **CPU**: < 1% (mostly idle, spikes during rebalance)
- **Memory**: ~85 MB (stable, no leaks observed) + ~1-2 MB analytics cache
- **Disk I/O**: Minimal (logs + analytics ~2-5 MB/month per position)
- **Network**: ~1 RPC call per 60 seconds (idle), +1 for analytics snapshot

### Latency
- **Monitoring Cycle**: 60 seconds
- **Position Check**: ~1-2 seconds (RPC call)
- **Rebalance Execution**: ~30-60 seconds (7 transactions)
- **Block Confirmation**: ~3 seconds per tx (PulseChain)

### Scalability
- **Current**: 1 position
- **Theoretical Max**: 100+ positions (limited by RPC rate limits)
- **Bottleneck**: RPC calls (sequential per position)

---

## 🔄 Upgrade Path

### Hot Updates
```bash
cd /opt/9mm-rebalancer
git pull origin main
npm install
npx tsc
cd src/web && npm run build && cd ../..
pm2 restart 9mm-rebalancer && pm2 restart 9mm-dashboard
```
**Downtime**: ~2-3 seconds (PM2 restart)

### Zero-Downtime Updates
```bash
cd /opt/9mm-rebalancer
git pull origin main
npm install
npx tsc
cd src/web && npm run build && cd ../..
pm2 reload 9mm-rebalancer && pm2 reload 9mm-dashboard
```
**Downtime**: ~0 seconds (graceful reload)

---

## 🛡️ Failure Modes & Recovery

### RPC Failure (Read-Only Calls)

- **Detection**: Connection timeout or invalid response
- **Recovery**: Automatic failover to next RPC endpoint via `withRetry()`
- **Impact**: Minimal (< 5 second delay)

### RPC Failure During Rebalance (v1.6.0)

- **Detection**: `isTransientRpcError()` classifies 504, timeout, ECONNRESET, etc.
- **Recovery**: Depends on state:
  - **No recovery file**: Skip safe mode, retry on next monitoring cycle (up to 5 consecutive failures)
  - **Recovery file exists**: Enter safe mode (irreversible action already taken on-chain)
  - **5+ consecutive failures**: Enter safe mode as safety measure
- **Impact**: Bot continues monitoring; rebalance retried automatically

### Transaction Failure (Contract Revert)

- **Detection**: CALL_EXCEPTION from contract
- **Recovery**: Safe mode — enter safe mode, notify operator
- **Impact**: Position temporarily suboptimal, requires investigation

### Process Crash
- **Detection**: PM2 exit event
- **Recovery**: Automatic restart (< 10 seconds)
- **Impact**: Missed monitoring cycles, position unchanged

### VPS Reboot
- **Detection**: systemd service restart
- **Recovery**: PM2 auto-starts, resurrects 9mm-rebalancer
- **Impact**: ~30-60 second downtime

---

## 📚 Technology Stack

### Runtime
- **Node.js**: v22.22.0 (LTS)
- **TypeScript**: v5.6.0 (compiled to ES modules)
- **Module System**: ESM (`"type": "module"`)
- **Module Resolution**: NodeNext

### Core Libraries
- **ethers.js**: v6.13.0 (blockchain interaction)
- **winston**: v3.14.0 (logging)
- **dotenv**: v16.4.0 (environment variables)
- **yaml**: v2.5.0 (config parsing)
- **axios**: v1.7.0 (HTTP requests)

### Infrastructure
- **PM2**: v6.0.14 (process manager)
- **Ubuntu**: 24.04 LTS (VPS OS)
- **systemd**: (service management)

---

## 🔍 Monitoring & Observability

### Application Logs
- Location: `/opt/9mm-rebalancer/logs/`
- Format: JSON (machine-readable)
- Retention: Manual (consider implementing rotation)

### PM2 Metrics
```bash
pm2 monit              # Real-time CPU/memory
pm2 show 9mm-rebalancer # Detailed info
```

### Health Checks
```bash
~/check-9mm-health.sh  # Custom script
# Checks: PM2 status, error count, last cycle, disk space
```

### External Monitoring (Optional)
- Uptime monitoring (e.g., UptimeRobot, Pingdom)
- Log aggregation (e.g., Logtail, Papertrail)
- APM (e.g., New Relic, Datadog) - overkill for this project

---

## 📖 Related Documentation

- [STATUS.md](./STATUS.md) - Current deployment status
- [DEPLOY_MANUAL.md](./DEPLOY_MANUAL.md) - Deployment guide
- [README.md](./README.md) - Project overview
- [TROUBLESHOOTING.md](./TROUBLESHOOTING.md) - Common issues (to be created)
- [CHANGELOG.md](./CHANGELOG.md) - Version history (to be created)

---

**Last Updated**: 2026-03-06 (v2.8.0 — Doc A data capture spec: price history, sigma, viability, trigger events, retrospective backfill)
**Maintainer**: Tyler (GitHub: TylerB007)

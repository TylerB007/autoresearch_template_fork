# Koinly Audit Process Flowchart

## Command

```bash
npm run audit:koinly -- --csv <path-to-koinly-export.csv> [--days=90] [--json] [--pulsechain-only] [--wallet=<name>] [--chain-id=<id>]
```

Preset for the production PulseChain wallet naming:

```bash
npm run audit:koinly:pulsechain -- --csv <path-to-koinly-export.csv>
```

`--pulsechain-only` narrows the audit to PulseChain wallet rows in Koinly and internal analytics records with `chainId=369`.
`--wallet=<name>` makes the Koinly-side wallet filter explicit when the CSV contains multiple wallets.
`--chain-id=<id>` restricts internal analytics to one chain without relying on the PulseChain shortcut.

---

## Architecture

```
                          +-------------------+
                          |   audit-cli.ts    |
                          |   (entry point)   |
                          +--------+----------+
                                   |
                    +--------------+--------------+
                    |              |              |
                    v              v              v
           +-------+----+  +------+------+  +----+--------+
           | koinly.ts  |  | storage.ts  |  | matcher.ts  |
           | (CSV parse)|  | (JSONL load)|  | (matching)  |
           +-------+----+  +------+------+  +----+--------+
                    |              |              |
                    v              v              v
              KoinlyRow[]   InternalEvent[]   MatchResult
                                                 |
                                                 v
                                          +------+------+
                                          | report.ts   |
                                          | (output)    |
                                          +-------------+
```

---

## Step-by-Step Flow

### 1. Parse Koinly CSV (`src/audit/koinly.ts`)

```
CSV file
   |
   v
Auto-detect format from header row
   |
   +-- Format A: Koinly native export
   |     Columns: Row, Date, Time (UTC), Type, Wallet,
   |              Asset / Amount, Counterparty / Received,
   |              Real-time Value, P/L, Tag, Notes
   |
   +-- Format B: ChatGPT extract / manual export
         Columns: Date, Time (UTC), Type, Wallet,
                  Sent/Out Amount, Sent/Out Currency,
                  Received/In Amount, Received/In Currency,
                  Net Value (USD), Action, TX Hash, Fee
   |
   v
For each row:
   +-- Parse date + time --> Unix ms timestamp
   +-- Parse amounts (expand suffixes: 11.03m --> 11030000)
   +-- Parse USD values (strip $, commas)
   +-- Extract tx hash from any column (full or truncated 0x98...728e)
   |
   v
KoinlyRow[] (sorted by CSV row order)
```

### 2. Load Internal Analytics (`src/analytics/storage.ts`)

```
config.yaml --> analytics.storage_path (default: ./analytics)
   |
   v
Query 4 data sources in parallel:
   |
   +-- queryAllChainRebalances()      --> RebalanceAnalytics[]
   |     Scans: analytics/chain-*/rebalances.jsonl
   |     Contains: 7-step rebalance records with tx hashes,
   |               swap amounts, fees collected, gas costs
   |
   +-- queryAllChainFeeCollections()  --> FeeCollectionRecord[]
   |     Scans: analytics/chain-*/analytics-*.jsonl (type=fee_collection)
   |     Contains: standalone fee collection events
   |
   +-- queryAllChainPositionEntries() --> PositionEntryRecord[]
   |     Scans: analytics/chain-*/analytics-*.jsonl (type=position_entry)
   |     Contains: mint-side entry amounts and historically-priced entryCostUsd
   |               for manual/history mints not fully represented by rebalance records
   |
   +-- queryAllChainLifecycleEvents() --> RebalanceLifecycleEvent[]
         Scans: analytics/chain-*/analytics-*.jsonl (type=lifecycle)
         Contains: per-step events (fees_collected, position_exited,
                   swap_executed, position_opened, etc.)
```

### 3. Build Internal Event Index (`src/audit/matcher.ts`)

```
RebalanceAnalytics[] ----+
                         |
FeeCollectionRecord[] ---+
                         +--> buildInternalEventIndex()
PositionEntryRecord[] ---+
                         |
LifecycleEvent[] --------+
   |
   v
Flatten into InternalEvent[]:
   |
   +-- Each RebalanceAnalytics expands into up to 6 events:
   |     collectFees, decreaseLiquidity, collectTokens,
   |     burn, swap, mint
   |     (each with its own tx hash, gas cost, amounts)
   |
   +-- Each FeeCollectionRecord --> 1 event
   |
   +-- Each PositionEntryRecord --> 1 event
   |     (only if its tx hash is not already represented by a rebalance step)
   |     Adds mint-side USD valuation coverage for manual / legacy entries
   |
   +-- Each LifecycleEvent --> 1 event
   |     (only if tx hash NOT already covered by a Rebalance, FeeCollection, or PositionEntry)
   |
   v
InternalEvent[] (sorted by timestamp)
   Each has: kind, timestamp, txHash, tokenId, chainId,
             token symbols, amounts (human-readable),
             swap in/out amounts, gas cost, lifecycleEventType
```

### 4. Match Events (Two-Pass)

```
KoinlyRow[] + InternalEvent[]
   |
   v
PASS 1: TX Hash Match
   For each Koinly row with a tx hash:
       Compare against all internal tx hashes
       Match = prefix AND suffix match (case-insensitive)
       If multiple internal events share the same tx hash,
          choose the best compatible event kind
          (mint-like rows prefer PositionEntry over raw rebalance_mint)
     Guard: skip truncated hashes with < 6 hex char prefix
           (e.g., 0x8c...976b is too short, matches dozens of txs)
   |
   v
PASS 2: Timestamp + Type + Amount Scoring
   For each unmatched Koinly row:
     |
     +-- Determine compatible event kinds:
     |     Exchange + NFT received  --> rebalance_mint
     |     Exchange / token swap    --> rebalance_swap
     |     Deposit + mint tag       --> rebalance_mint
     |     Deposit + receive tag    --> fee_collection, collectFees/Tokens
     |     Send + mint tag          --> rebalance_mint
     |     Send + burn tag          --> rebalance_burn
     |     Cost / approve / revoke  --> any rebalance step
     |     Transfer                 --> [] (skip)
     |
     +-- Find candidates within +/- 5 min timestamp window
     |
     +-- Score each candidate:
     |     Time proximity:      0-100 (closer = higher)
     |     Symbol conflict:     -500 (hard reject for Exchange rows)
     |     Lifecycle type fit:  -100 to +50
     |     Asset amount match:  -10 to +100
     |     Received amount:     -10 to +100
     |     NFT tokenId match:   -50 or +200
     |
     +-- Accept best match if score > 0
   |
   v
MatchResult:
   matched[]          -- paired Koinly + Internal with discrepancies
   unmatchedKoinly[]   -- Koinly rows with no internal counterpart
   unmatchedInternal[] -- Internal events with no Koinly counterpart
```

### 5. Check Discrepancies (per matched pair)

```
For each matched pair (KoinlyRow, InternalEvent):
   |
   +-- USD Value Check
   |     Compare against internal usdValue when available
   |     Mint-like rows can compare against PositionEntry / entry-cost valuation
   |     Skip when internal value is 0 or absent (not recorded in older data)
   |     Cost rows:    compare Koinly USD vs internal gasCostUsd (+/- 10%)
   |     Other rows:   compare Koinly USD vs internal usdValue   (+/- 5%)
   |
   +-- Swap Symbol Check (Exchange rows only, skip if received is NFT)
   |     Koinly sent symbol must match internal swapInSymbol
   |     Wrapped variants OK: WPLS=PLS, WETH=ETH
   |     Mismatch = error
   |
   +-- Swap In Amount Check
   |     Compare Koinly sent amount vs internal swapInAmount
   |     Tolerance: +/- 0.1% (accounts for Koinly suffix rounding)
   |     This is the most reliable ground-truth comparison
   |
   +-- Swap Out Amount Check
   |     Rebalance swaps: severity forced to "ok" (informational only)
   |       Reason: internal = raw DEX output, Koinly = net wallet change
   |       (mint consumes most of the swap output immediately)
   |     Other swaps: normal tolerance check (+/- 0.1%)
   |
   v
Discrepancy[] per pair:
   { field, koinlyValue, internalValue, diffPct, severity }
   severity: ok | warning | error
```

### 6. Output Report (`src/audit/report.ts`)

```
--json flag?
   |
   +-- Yes --> JSON to stdout: { result, options }
   |
   +-- No  --> Terminal report with ANSI colors:
         |
         +-- Header: CSV path, analytics path, date range, row counts
         |
         +-- MATCHED section:
         |     Clean matches first (green OK)
         |     Then matches with discrepancies (yellow/red)
         |     Each shows: Koinly row, internal event, match method,
         |                 timestamp delta, discrepancy details
         |
         +-- UNMATCHED KOINLY ROWS:
         |     Each with contextual suggestion:
         |       Deposit/mint  --> "check position_opened lifecycle event"
         |       Cost          --> "check gas-only step, may be approval"
         |       Exchange      --> "check swap_executed lifecycle event"
         |
         +-- INTERNAL EVENTS NOT IN KOINLY:
         |     Events with no Koinly counterpart
         |     (cross-chain events, pre-export-range events)
         |
         +-- SUMMARY:
                      Matched:           N / M rows (X%)
                      Koinly coverage:   X% (unmatched Koinly rows)
                      Internal coverage: Y% (internal orphan events)
                      Discrepancies:     N (errors, warnings)
                      Status:
                         FAIL = any unmatched Koinly rows or hard discrepancies
                         WARN = internal orphan events or minor discrepancies only
                         PASS = full Koinly coverage, no orphaned internal events, no discrepancies
```

---

## File Map

| File | Purpose |
|------|---------|
| `src/audit-cli.ts` | CLI entry point, arg parsing, orchestration |
| `src/audit/koinly.ts` | CSV parser, dual-format auto-detection, amount/date/hash parsing |
| `src/audit/matcher.ts` | Event index builder, two-pass matching engine, discrepancy checker |
| `src/audit/report.ts` | Terminal reporter with ANSI colors, JSON output mode |

## Key Design Decisions

| Decision | Rationale |
|----------|-----------|
| `swap_in_amount` is the ground-truth comparison | Matches to 0.0% across all tested transactions |
| `swap_out_amount` is informational for rebalance swaps | Internal stores raw DEX output; Koinly stores net wallet change after mint |
| Mint USD values are not compared | Internal records gas cost; Koinly records position value |
| Fee collection USD=0 is "not recorded", not a mismatch | Older analytics records didn't populate `totalValueUsd` |
| Exchange rows receiving NFTs route to mint matching | Koinly categorizes LP deposits as "Exchange" (tokens for NFT) |
| Truncated hashes < 6 hex chars are skipped | Short prefixes like `0x8c` match dozens of different transactions |
| Minimum match score > 0 required | Prevents low-confidence pairings from polluting results |
| Symbol conflict = -500 score (hard reject) | Prevents false matches across different token pairs |

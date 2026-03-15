---
name: supabase-backfill-runner
description: Provides commands and error handling strategies for executing historical data backfills on PostgreSQL (Supabase). Use when tasked with troubleshooting DB RPCs, continuous strategy ledgers, or backfill completeness.
---
# Supabase Backfill Runner

This project handles massive historical state backfills across multiple EVM chains (primarily Ethereum and PulseChain) to map historical paths into the "Strategy Ledger".

## Execution Commands

Run backfill scripts non-interactively using the test scripts:
- **Ethereum (Chain 1) 30-day test:** 
  `node scripts/database/test-backfill.cjs --chain=1 --days=30`
- **PulseChain (Chain 369) 7-day test:** 
  `node scripts/database/test-backfill.cjs --chain=369 --days=7`
- **Verify DB RPCs & Status:** 
  `node scripts/database/test-backfill.cjs --test-backfill-status`

## Error Handling Instructions
1. **Duplicate Key Violations (Code 23505):** 
   - This is **expected behavior**, not a bug. The unique constraints actively block duplicates under concurrent async loads — a 23505 error confirms the constraint is working correctly. Do not suppress or "fix" this unless it breaks the overarching transaction.
2. **Missing Price Data:** 
   - On PulseChain, DefiLlama historical data is often sparse/missing. You should gracefully fallback or capture the log using `utils/logger.js`.
3. **Connectivity Issues:**
   - Double-check `.env.local` to verify `NEXT_PUBLIC_SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are provided. Direct Postgres connections (`Supabase_DB_Password`) often timeout strictly due to ISP/Vercel firewall constraints; prioritize using the REST JS Client unless applying raw Data Definition Language (DDL) migrations.
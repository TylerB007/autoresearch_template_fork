---
name: dashboard-memory-manager
description: Monitors Node.js process count and memory usage. Kills orphaned Turbopack/PostCSS workers and executes clean restarts. Use when system lags, memory usage is high, or before a build.
---
# Dashboard Memory Manager

Next.js 16 Turbopack has a known memory leak with PostCSS workers that can consume 5+ GB of RAM over time.

## When to use
- Before initiating an `npm run build`
- When the developer reports system lag or high memory
- When 5+ Node.js processes are active in the project

## How to execute cleanup
1. Run the performance check script:
   ```bash
   npm run perf:check
   ```
2. If process cleanup is needed, run the following PowerShell command to kill orphaned Node processes (PostCSS workers and stale builds):
   ```powershell
   Get-Process node | Where-Object {$_.CommandLine -match 'postcss|next build'} | Stop-Process -Force
   ```
   > **Note**: If a full reset is needed (dev server included), the command in step 3 handles killing and restarting the dev server cleanly.
3. Run the project's native cleanup command to clear the `.next` cache and safely restart:
   ```bash
   npm run dev:clean
   ```
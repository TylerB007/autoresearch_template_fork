# Troubleshooting Guide

Common issues and their solutions for the 9mm V3 LP Auto-Rebalancer.

---

## 🔍 Quick Diagnostics

Before diving into specific issues, run these commands:

```bash
# SSH into VPS
ssh root@143.110.130.198

# Check process status
pm2 list
pm2 show 9mm-rebalancer

# Run health check
~/check-9mm-health.sh

# View recent logs
pm2 logs 9mm-rebalancer --lines 50

# View error logs only
pm2 logs 9mm-rebalancer --err --lines 50
```

---

## ❌ Application Not Running

### Symptom
```bash
$ pm2 list
# Shows 9mm-rebalancer as "stopped" or "errored"
```

### Diagnosis
```bash
pm2 logs 9mm-rebalancer --lines 100
tail -50 ~/9mm-rebalancer/logs/error.log
```

### Common Causes

#### 1. Missing or Invalid .env File
**Error**: `Error: Private key not found in environment`

**Solution**:
```bash
cd ~/9mm-rebalancer
ls -la .env  # Verify file exists with 600 permissions

# If missing, recreate
nano .env
# Add:
# PRIVATE_KEY=0xYOUR_PRIVATE_KEY_HERE
# RPC_URL_PRIMARY=https://rpc.pulsechain.com
# RPC_URL_FALLBACK_1=https://rpc-pulsechain.g4mm4.io
# RPC_URL_FALLBACK_2=https://pulsechain-rpc.publicnode.com

chmod 600 .env
pm2 restart 9mm-rebalancer
```

#### 2. Invalid Private Key Format
**Error**: `Error: invalid private key`

**Solution**:
- Ensure private key starts with `0x`
- No spaces or line breaks in `.env` file
- Private key is 64 hex characters (+ `0x` prefix)

```bash
nano .env
# Correct format:
# PRIVATE_KEY=0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890
pm2 restart 9mm-rebalancer
```

#### 3. Missing config.yaml
**Error**: `Error: Cannot find module './config.yaml'`

**Solution**:
```bash
cd ~/9mm-rebalancer
ls -la config.yaml  # Verify file exists

# If missing, pull from git
git pull origin main
pm2 restart 9mm-rebalancer
```

#### 4. Build Not Completed
**Error**: `Error: Cannot find module './dist/index.js'`

**Solution**:
```bash
cd ~/9mm-rebalancer
npm install
npm run build
ls -la dist/index.js  # Verify build succeeded
pm2 restart 9mm-rebalancer
```

---

## 🔄 Application Keeps Restarting

### Symptom
```bash
$ pm2 list
# Shows high restart count (↺ column)
```

### Diagnosis
```bash
pm2 show 9mm-rebalancer | grep -E "restarts|uptime"
pm2 logs 9mm-rebalancer --lines 100
```

### Common Causes

#### 1. RPC Connection Failures
**Error**: `Error: could not detect network`

**Solution**:
```bash
# Test RPC endpoints manually
curl -X POST https://rpc.pulsechain.com \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","method":"eth_chainId","params":[],"id":1}'

# Should return: {"jsonrpc":"2.0","id":1,"result":"0x171"}  # 0x171 = 369

# If primary RPC fails, check fallbacks
curl -X POST https://rpc-pulsechain.g4mm4.io \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","method":"eth_chainId","params":[],"id":1}'

# Update .env with working RPC if needed
nano .env
pm2 restart 9mm-rebalancer
```

#### 2. Out of Memory
**Error**: PM2 shows "max memory restart"

**Solution**:
```bash
# Increase memory limit in ecosystem.config.cjs
cd ~/9mm-rebalancer
nano ecosystem.config.cjs
# Change: max_memory_restart: '512M' → '1G'

pm2 restart 9mm-rebalancer
pm2 save
```

#### 3. Unhandled Exception
**Check logs for stack traces**:
```bash
tail -100 ~/9mm-rebalancer/logs/error.log
```

**Solution**: Report issue with full stack trace

---

## 🚫 Position Monitoring Fails

### Symptom
```
Position 155181 has zero liquidity. Skipping.
```

### Diagnosis
```bash
# Check position on 9mm DEX
# Visit: https://9mm.pro/pools

# Or use status script locally
npm run status
```

### Common Causes

#### 1. Position Closed or Empty
**Solution**: Update config.yaml with active position
```bash
cd ~/9mm-rebalancer
nano config.yaml
# Update token_id to active position
pm2 restart 9mm-rebalancer
```

#### 2. Invalid Position ID
**Error**: `Error: position not found`

**Solution**:
```bash
# Verify position exists on-chain
# Use block explorer: https://scan.pulsechain.com
# Navigate to NonfungiblePositionManager contract
# Call: positions(tokenId)

# Update config.yaml with correct token_id
nano config.yaml
pm2 restart 9mm-rebalancer
```

---

## 🔄 Rebalance Swaps 100% of Token (Mint Reverts)

### Symptom
Logs show swap executing for the full token balance, then mint fails with `CALL_EXCEPTION`:
```
Swap complete: 57023986248762 token0 -> ... token1
Cannot mint: tick inside range but amount0=0, amount1=...
```
Or the mint reverts with `gasUsed: ~42000, status: 0, logs: []`.

### Cause
`calculateSwapAmount()` in `src/math.ts` may have a formula error in one of the branches (token0 or token1). The scaled value system uses `amount0 * sqrtPriceSq` and `amount1 * Q192`. Converting back to raw amounts must divide by the same factor — an extra multiplication inflates the result astronomically and hits the 100% balance cap.

### Resolution (v1.6.2)
This was fixed by removing a spurious `* Q192` from the token0 branch. If you see similar symptoms, check both branches of `calculateSwapAmount()` for dimensional consistency.

---

## 🔄 Mint Reverts After Successful Swap (Slippage Check Failure)

### Symptom

Rebalance completes the swap step successfully, but the mint transaction reverts with `gasUsed: ~181k-215k` (significant execution before revert). Logs may show:
```
Swap confirmed: 0x...
Error: transaction execution reverted (action="sendTransaction")
```

### Cause

`amount0Min`/`amount1Min` were calculated as a percentage of the full wallet balance. If the wallet contains stranded funds from prior failed rebalances (e.g., 21M WPLS from 3 previous failures), the V3 pool only accepts the ratio it needs at the current tick (maybe 5M), but `amount1Min = 21M * 99% = 20.79M` → the pool's 5M deposit is far below the minimum → revert.

### Resolution (v1.7.0)

Mint slippage minimums are now derived from pool math:
1. `getLiquidityForAmounts()` computes expected liquidity from desired amounts
2. `getAmountsForLiquidity()` computes what the pool will actually deposit
3. Slippage tolerance is applied to *those* expected amounts, not the raw wallet balance

Excess tokens remain safely in the wallet. If you see this on an older version, update to v1.7.0+.

---

## 🔄 NONCE_EXPIRED After RPC Provider Rotation

### Symptom

Rebalance fails mid-flow with:
```
NONCE_EXPIRED: nonce has already been used (nonce too low)
```

Typically happens after a 504 or timeout triggers RPC provider rotation.

### Cause

When `withRetry()` rotates to a new RPC provider, `resetNonce()` queries the new provider which may have stale mempool state and return a lower nonce than transactions already confirmed on the previous provider.

### Resolution (v1.7.0)

`NonceTracker` now tracks `lastConfirmedNonce` — the highest nonce that has been confirmed on-chain. `resetNonce()` queries the chain twice with a 2-second delay (handles propagation lag) and uses `max(chainNonce, lastConfirmedNonce + 1)` as the floor. This prevents nonce regression even with stale RPC state.

---

## 🔄 "deposit is not a function" — WPLS Auto-Wrap Fails

### Symptom

After the swap step, logs show:
```
Failed to auto-wrap native PLS to WPLS: TypeError: wplsContract.deposit is not a function
```

### Cause

Code was using `contracts.getERC20(TOKENS.WPLS)` which returns a contract with the generic ERC20 ABI. WPLS is a WETH9-style contract that needs `deposit()` (payable) and `withdraw()` methods not present in the ERC20 ABI.

### Resolution (v1.7.0)

Created `abis/WETH9.json` with the required methods. Added `getWPLS()` to `ContractInstances` in `src/contracts.ts`. Both the rebalancer and recovery flows now use `contracts.getWPLS()` instead of `contracts.getERC20()`.

---

## 🔄 TWAP Check Always Fails with "OLD" Revert

### Symptom

Every rebalance cycle logs:
```
TWAP check failed — pool may lack sufficient observation history
```

The `observe()` call reverts with "OLD" regardless of the lookback window.

### Cause

The pool has `observationCardinality = 1` (never expanded). With only one observation slot, the pool cannot look back any meaningful time period. This is a permanent condition until someone calls `increaseObservationCardinalityNext()` on the pool contract.

### Resolution (v1.7.0)

`isTwapSafe()` now retries with progressively shorter windows (300→60→10s) when it encounters an "OLD" revert. This allows it to use whatever observation history is available.

**Full fix**: Call `pool.increaseObservationCardinalityNext(100)` on-chain once. This is a cheap, one-time transaction that gives the pool enough buffer for a proper 300-second TWAP lookback.

To check a pool's current cardinality:
```bash
# On VPS or locally with node
node -e "
const { ethers } = require('ethers');
const p = new ethers.JsonRpcProvider('https://rpc.pulsechain.com');
const pool = new ethers.Contract('POOL_ADDRESS', ['function slot0() view returns (uint160,int24,uint16,uint16,uint16,uint32,bool)'], p);
pool.slot0().then(s => console.log('observationIndex:', s[2], 'cardinality:', s[3], 'cardinalityNext:', s[4]));
"
```

---

## 🔄 "Could not parse Swap event" — Fallback Uses Total Balance

### Symptom

After every swap, logs show:
```
Could not parse Swap event — checking output token balance as fallback
Output token balance is 31364670096059 — swap likely succeeded
```

The `amountOut` is set to the entire wallet balance, not just the swap output.

### Cause (pre-v1.7.0)

The code was calling `contracts.getPool(tokenIn)` which created a pool contract at the **ERC20 token address**, not the actual pool address. The pool emits the Swap event, so parsing at the wrong address found nothing.

### Resolution (v1.7.0)

The swap function now resolves the actual pool address via `contracts.factory.getPool(tokenIn, tokenOut, fee)` and parses Swap events from that contract. The fallback (wallet balance check) is still in place as a safety net but should no longer trigger.

---

## 🔄 Positions Stuck in Safe Mode

### Symptom

Bot logs show positions in `SAFE MODE` every cycle, even after the underlying issue was resolved:
```
Position 155778: SAFE MODE — skipping
Position 155781: SAFE MODE — skipping
```

### Cause (v2.5.0+)

Safe mode is entered only for genuine rebalance failures (recovery state file on disk) or kill switch triggers. It is **never** entered for config errors (wrong token IDs) since v2.5.0.

Safe mode is an **in-memory** `Set<string>` keyed by `"chainId-tokenId"`. It clears on PM2 restart, or via the `/enable` Telegram command (v2.5.0+).

### Resolution (v2.5.0+)

**Option A — Telegram (preferred, no restart needed)**:
```
/enable           # clears safe mode for ALL positions
/enable 155977    # clears safe mode for one position only
```
The bot will also reset all kill switches for the specified scope.

**Option B — PM2 restart** (clears all in-memory state):
```bash
pm2 restart 9mm-rebalancer
```

**If safe mode re-triggers immediately after clearing**: A recovery state file may still exist on disk. Run `/recover` to check for stranded funds and resolve them before the bot will resume rebalancing.

### Symptom: Wrong Token ID Causing Repeated Skips (v2.5.0+)

Since v2.5.0, wrong token IDs in config.yaml no longer enter safe mode. Instead you'll see:
```
STARTUP WARNING: Wallet does not own position #999999. This is likely a wrong token_id in config.yaml. Bot will skip this position each cycle until ownership is verified.
```
**Resolution**: Update the `token_id` in config.yaml to a token the wallet owns. The bot self-heals on the next monitoring cycle — no PM2 restart needed.

### Legacy: Dead Position IDs (pre-v2.5.0)

In earlier versions, dead position IDs triggered safe mode permanently. To check which positions your wallet actually owns:
```bash
# On VPS
node -e "
const { ethers } = require('ethers');
const p = new ethers.JsonRpcProvider('https://rpc.pulsechain.com');
const npm = new ethers.Contract('0xCC05bf158202b4F461Ede8843d76dca8aeA0Af1529f789976b', ['function balanceOf(address) view returns (uint256)', 'function tokenOfOwnerByIndex(address,uint256) view returns (uint256)'], p);
const wallet = 'YOUR_WALLET_ADDRESS';
npm.balanceOf(wallet).then(async n => { for(let i=0; i<n; i++) console.log((await npm.tokenOfOwnerByIndex(wallet, i)).toString()); });
"
```


To check which positions your wallet actually owns:
```bash
# On VPS
node -e "
const { ethers } = require('ethers');
const p = new ethers.JsonRpcProvider('https://rpc.pulsechain.com');
const npm = new ethers.Contract('0xCC05bf158202b4F461Ede8843d76dca8aeA0Af1529f789976b', ['function balanceOf(address) view returns (uint256)', 'function tokenOfOwnerByIndex(address,uint256) view returns (uint256)'], p);
const wallet = 'YOUR_WALLET_ADDRESS';
npm.balanceOf(wallet).then(async n => { for(let i=0; i<n; i++) console.log((await npm.tokenOfOwnerByIndex(wallet, i)).toString()); });
"
```

---

## 🔄 Stale Recovery State File Logging Errors Every Cycle

### Symptom

Bot logs show the same validation error every polling cycle, often referencing a burned position or a token address that fails the whitelist check:
```
Failed to read or validate recovery state file: token0 not in known token addresses: 0x4200...
Failed to read or validate recovery state file: token0 not in known token addresses: 0x4200...
```

### Cause

A `.recovery-state-{chainId}.json` file exists on disk from a previous rebalance that failed during or after the NFT burn step. If the validation fails (e.g. token address not in whitelist, invalid fee tier), the file is never deleted and the error repeats every cycle.

### Auto-Resolution (v2.5.0+)

Since v2.5.0, when `validateRecoveryState()` fails, `detectStrandedFunds()` calls `ownerOf(oldTokenId)` on-chain:

- If `CALL_EXCEPTION` (NFT is burned) → file is deleted automatically. Error stops repeating on next cycle.
- If NFT still exists → file is preserved with a "manual inspection required" warning (real stranded funds may exist).
- If RPC error → file is preserved safely (will retry next cycle).

**Manual (if auto-delete hasn't triggered)**:
```bash
# SSH into VPS
ls /opt/9mm-rebalancer/.recovery-state*.json
# If the referenced tokenId is confirmed burned on-chain:
rm /opt/9mm-rebalancer/.recovery-state-8453.json  # replace with your chain ID
pm2 restart 9mm-rebalancer
```

**Check on-chain** whether the old token ID is burned (ownerOf reverts) using a block explorer or:
```bash
node -e "
const { ethers } = require('ethers');
const p = new ethers.JsonRpcProvider('https://mainnet.base.org');
const npm = new ethers.Contract('0x827922686190790b37229fd06084350E74485b72', ['function ownerOf(uint256) view returns (address)'], p);
npm.ownerOf(YOUR_TOKEN_ID).then(o => console.log('owner:', o)).catch(e => console.log('burned:', e.code));
"
```

---

## 🔄 Recovery `/recover confirm` Fails with CALL_EXCEPTION

### Symptom
After triggering `/recover confirm` via Telegram, the mint transaction reverts:
```
Recovery error: transaction execution reverted
gasUsed: 42668, status: 0, logs: []
```

### Cause
`recoverStrandedFunds()` centers the new range on current tick. Since tick is always inside the range, V3 requires both tokens. If the wallet has only one token (common after a failed rebalance that over-swapped), the mint reverts.

### Resolution (v1.6.2)
Recovery now includes a swap step before minting — it calls `calculateSwapAmount()` and `executeSwap()` to balance the wallet tokens, mirroring the normal rebalance flow. If you see this error on an older version, update to v1.6.2+.

---

## 🔄 Recovery Fails with Empty Calldata on Non-Default Chain (e.g. Base/Aerodrome)

### Symptom

After triggering `/recover confirm` for a Base or Aerodrome position, the transaction reverts with empty calldata targeting a token contract:
```
Recovery error: transaction execution reverted (action="sendTransaction", data=null,
transaction={ "data": "", "to": "0xTokenAddress..." },
receipt={ "gasUsed": "24485", "status": 0 })
```

The `data: ""` (empty calldata) and low gas usage (~24k) indicate a plain ETH transfer was sent instead of a contract method call.

### Cause (pre-v2.1.0)

Three interconnected bugs:

1. **Wrong chain config in recovery/rebalancer**: `config.chain.wrappedNativeAddress` always returned the **default chain's** (PulseChain) wrapped native address, not the position's chain. For Base positions, the WETH auto-wrap comparison (`isToken0Native`) compared pool tokens against WPLS instead of WETH — either skipping a needed wrap or applying it incorrectly.

2. **Missing nonce management in recovery wrap**: The `deposit()` call in `recovery.ts` had no `nonce` parameter from `chain.nonceManager`, causing nonce desynchronization with subsequent `mintPosition` calls. The same logic in `rebalancer.ts` correctly used nonce management.

3. **Missing `dex` field in recovery state**: `RecoveryState` didn't persist the DEX identifier (e.g. `'aerodrome-cl'`). If the old token ID was no longer in `config.yaml` during recovery, the DEX resolution fell back to chain defaults (Uniswap V3 on Base), using wrong ABIs and contract addresses for Aerodrome positions.

### Resolution (v2.1.0)

- `rebalancer.ts` and `recovery.ts` now resolve the position's chain config via `getChainConfig(chainId)` instead of using `config.chain.*`
- Recovery wrap uses proper nonce management (`getNextNonce()`, `confirmNonce()`, `resetNonce()`)
- `RecoveryState` now includes an optional `dex` field, persisted during `writeRecoveryState()` and used as fallback during DEX resolution at recovery time
- Aerodrome quoter address corrected to verified contract `0x254cF9E1E6e233aa1AC962CB9B05b2cfeAaE15b0`

---

## 💸 Rebalance Transactions Failing

### Symptom
Logs show transaction attempts but all fail

### Diagnosis
```bash
pm2 logs 9mm-rebalancer --lines 200 | grep -i "transaction\|rebalance\|error"
```

### Common Causes

#### 1. Insufficient Gas / PLS Balance
**Error**: `Error: insufficient funds for gas`

**Solution**:
```bash
# Check wallet balance
npm run status  # Shows PLS balance

# Send more PLS to wallet: 0x43FE417eE15749AC9b43596aCe636A2CE0819647
```

#### 2. Gas Price Too High
**Log**: `Gas price 736955 gwei exceeds max 2000. Skipping.`

**Solution**: Wait for gas prices to drop, or increase limit
```bash
nano config.yaml
# Change: max_gas_price_gwei: 2000 → 5000 (or higher)
pm2 restart 9mm-rebalancer
```

#### 3. Slippage Too Tight
**Error**: `Transaction reverted: Too little received`

**Solution**:
```bash
nano config.yaml
# Change: slippage_tolerance_bps: 100 → 200  # 1% → 2%
pm2 restart 9mm-rebalancer
```

#### 4. Position In Cooldown
**Log**: `Position last rebalanced X seconds ago, cooldown not satisfied`

**Solution**: Wait for cooldown period (5 minutes default)
```bash
# Or reduce cooldown
nano config.yaml
# Change: rebalance_cooldown_seconds: 300 → 60  # 5 min → 1 min
pm2 restart 9mm-rebalancer
```

---

## 📡 RPC Connection Issues

### Symptom
```
Error: could not detect network
Error: timeout exceeded
Error: network changed
```

### Diagnosis
```bash
# Test RPC connectivity
curl -X POST https://rpc.pulsechain.com \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","method":"eth_blockNumber","params":[],"id":1}'
```

### Solutions

#### 1. RPC Endpoint Down
```bash
# Application has built-in fallback, but verify all 3 RPCs
nano .env
# Ensure all 3 RPC URLs are configured:
# RPC_URL_PRIMARY=https://rpc.pulsechain.com
# RPC_URL_FALLBACK_1=https://rpc-pulsechain.g4mm4.io
# RPC_URL_FALLBACK_2=https://pulsechain-rpc.publicnode.com

pm2 restart 9mm-rebalancer
```

#### 2. Firewall Blocking Outbound Connections
```bash
# Test outbound HTTPS
curl -I https://rpc.pulsechain.com

# If blocked, check VPS firewall
ufw status
# Allow outbound HTTPS (should be default)
```

#### 3. DNS Resolution Issues
```bash
# Test DNS
nslookup rpc.pulsechain.com

# If fails, try IP directly (not recommended long-term)
```

---

## 📊 Telegram Notifications Not Working

### Symptom
No Telegram messages received during rebalance

### Diagnosis
```bash
# Check notification config
cat ~/9mm-rebalancer/config.yaml | grep -A 5 "notifications"
```

### Common Causes

#### 1. Notifications Disabled
```bash
nano config.yaml
# Ensure: enabled: true
pm2 restart 9mm-rebalancer
```

#### 2. Invalid Bot Token
**Test token manually**:
```bash
curl "https://api.telegram.org/bot<YOUR_BOT_TOKEN>/getMe"
# Should return bot info
```

**Solution**:
```bash
nano config.yaml
# Update: telegram_bot_token: "correct_token"
pm2 restart 9mm-rebalancer
```

#### 3. Invalid Chat ID

**Get your chat ID**:

```bash
# Option 1: Use the helper script
npm run getchatid
# Send a message to the bot, it prints your numeric chat ID

# Option 2: Check logs after sending a message to the bot
pm2 logs 9mm-rebalancer --lines 50 | grep "Unauthorized Telegram"
# Shows: {"chatId":"YOUR_ID",...}

# Option 3: Use the Telegram API directly
curl "https://api.telegram.org/bot<YOUR_BOT_TOKEN>/getUpdates"
# Look for "chat":{"id":12345678,...}
```

**Solution**:

```bash
nano config.yaml
# Update: telegram_chat_id: "5874802252"  # Must be numeric, NOT a bot username
pm2 restart 9mm-rebalancer
```

---

## 🤖 Telegram Commands Not Working (v1.2.0)

### Symptom: Bot responds "Unauthorized. This bot is private."

**Cause**: `telegram_chat_id` in config.yaml doesn't match your numeric chat ID.

**Solution**:

```bash
# Check what chat ID the bot is expecting
cat ~/9mm-rebalancer/config.yaml | grep telegram_chat_id

# Find your actual chat ID in the logs (look for "Unauthorized Telegram command attempt")
pm2 logs 9mm-rebalancer --lines 200 | grep "Unauthorized Telegram"
# Output shows: {"username":"YOUR_USERNAME","chatId":"YOUR_NUMERIC_ID","expected":"..."}

# Update config with correct numeric chat ID
nano ~/9mm-rebalancer/config.yaml
# Set: telegram_chat_id: "YOUR_NUMERIC_ID"
pm2 restart 9mm-rebalancer
```

**Alternative**: Use the helper script locally:

```bash
npm run getchatid
# Send a message to the bot, it will print your numeric chat ID
```

### Symptom: 401 Unauthorized errors / "Telegram bot token rejected"

**Cause**: Another instance is already polling the same bot token. Telegram only allows one polling connection per bot token.

**Common scenarios**:

- Running `npm run dev` locally while VPS is running
- Two VPS processes polling the same bot
- Old bot token was invalidated (e.g., revoked via BotFather)

**Solution**:

```bash
# Check if another instance is running
pm2 list  # Check for duplicate processes

# If running locally, stop local instance first
# Ctrl+C to stop local dev

# Restart VPS process
pm2 restart 9mm-rebalancer
pm2 logs 9mm-rebalancer --lines 20
# Look for "Telegram command handler started" (success)
# or "Telegram bot token rejected (401)" (still conflicting)
```

**If token is truly invalid**:

```bash
# Test token manually
curl "https://api.telegram.org/bot<YOUR_BOT_TOKEN>/getMe"
# Should return {"ok":true,"result":{"id":...,"first_name":"...","username":"..."}}

# If returns {"ok":false}, create a new bot via @BotFather in Telegram
# Update config.yaml with new token
```

### Symptom: Commands not responding at all (no "Unauthorized" either)

**Cause**: Telegram command handler didn't initialize.

**Diagnosis**:

```bash
# Check if handler started
pm2 logs 9mm-rebalancer --lines 100 | grep -i telegram
# Should see: "Telegram command handler started"
# If missing, handler failed to initialize
```

**Common causes**:

1. **Empty `telegram_chat_id`**: The handler won't start if `telegram_chat_id` is empty or falsy (checked in `src/index.ts` line 61)
2. **Missing `telegram_bot_token`**: Same check — must be a non-empty string
3. **`notifications.enabled` is false**: Handler only starts when notifications are enabled

**Solution**:

```bash
cat ~/9mm-rebalancer/config.yaml | grep -A 4 notifications
# Verify:
#   enabled: true
#   telegram_bot_token: "non-empty-token"
#   telegram_chat_id: "non-empty-numeric-id"

nano ~/9mm-rebalancer/config.yaml
pm2 restart 9mm-rebalancer
```

### Symptom: Polling stops after a few minutes

**Cause**: The error handler stops polling after 3 consecutive 401 failures (by design).

**Solution**: Fix the underlying 401 issue (see above), then restart:

```bash
pm2 restart 9mm-rebalancer
```

---

## 💾 Disk Space Issues

### Symptom
```
Error: ENOSPC: no space left on device
```

### Diagnosis
```bash
df -h
du -sh ~/9mm-rebalancer/*
```

### Solutions

#### 1. Log Files Too Large
```bash
# Check log sizes
du -sh ~/9mm-rebalancer/logs/*

# Manually clear old logs
cd ~/9mm-rebalancer/logs
rm *.log.old *.log.1 *.log.2

# Verify PM2 log rotation is working
pm2 conf pm2-logrotate
```

#### 2. node_modules Too Large
```bash
# Clean up development dependencies
cd ~/9mm-rebalancer
npm prune --production
```

#### 3. PM2 Logs Too Large
```bash
# Clear PM2 logs
pm2 flush

# Verify log rotation settings
pm2 set pm2-logrotate:max_size 10M
pm2 set pm2-logrotate:retain 10
```

---

## 🔒 Permission Issues

### Symptom
```
Error: EACCES: permission denied
```

### Diagnosis
```bash
ls -la ~/9mm-rebalancer/
ls -la ~/9mm-rebalancer/.env
```

### Solutions

#### 1. Incorrect .env Permissions
```bash
chmod 600 ~/9mm-rebalancer/.env
chown root:root ~/9mm-rebalancer/.env
```

#### 2. Incorrect Directory Ownership
```bash
chown -R root:root ~/9mm-rebalancer/
```

#### 3. Log Directory Not Writable
```bash
chmod 755 ~/9mm-rebalancer/logs/
```

---

## 🔄 Updates Breaking Application

### Symptom
After `git pull`, application fails to start

### Diagnosis
```bash
cd ~/9mm-rebalancer
git log -1  # Check latest commit
git diff HEAD~1  # See what changed
```

### Solutions

#### 1. Dependency Changes
```bash
npm install  # Reinstall dependencies
npm run build
pm2 restart 9mm-rebalancer
```

#### 2. Configuration Changes
```bash
# Compare config.yaml with .env.example
diff config.yaml.old config.yaml

# Update config as needed
nano config.yaml
pm2 restart 9mm-rebalancer
```

#### 3. Rollback to Previous Version
```bash
git log --oneline -10  # Find previous good commit
git checkout <commit-hash>
npm install
npm run build
pm2 restart 9mm-rebalancer
```

---

## 🔧 PM2 Issues

### PM2 Not Starting on Reboot

**Solution**:
```bash
# Reconfigure PM2 startup
pm2 startup systemd -u root --hp /root
# Copy and run the generated command

pm2 save
systemctl status pm2-root
```

### PM2 List Shows Empty

**Solution**:
```bash
# Resurrect processes
pm2 resurrect

# Or start fresh
cd ~/9mm-rebalancer
pm2 start ecosystem.config.cjs
pm2 save
```

### PM2 Logs Not Rotating

**Solution**:
```bash
# Reinstall pm2-logrotate
pm2 uninstall pm2-logrotate
pm2 install pm2-logrotate

# Reconfigure
pm2 set pm2-logrotate:max_size 10M
pm2 set pm2-logrotate:retain 10
pm2 set pm2-logrotate:compress true
pm2 set pm2-logrotate:rotateInterval '0 0 * * *'
```

---

## 🧪 Testing Solutions

### Test in Dry Run Mode
```bash
# Ensure dry run is enabled
nano config.yaml
# dry_run: true

pm2 restart 9mm-rebalancer
pm2 logs 9mm-rebalancer --lines 50

# Watch for 2-3 monitoring cycles (60-90 seconds)
# Verify no errors
```

### Test Manually (Without PM2)
```bash
# Stop PM2 process
pm2 stop 9mm-rebalancer

# Run directly to see detailed errors
cd ~/9mm-rebalancer
node dist/index.js

# Press Ctrl+C to stop
# Restart PM2
pm2 start 9mm-rebalancer
```

---

## 📞 Getting Help

### Collect Diagnostic Information

```bash
# Create diagnostic report
cat > ~/9mm-diagnostic.txt << EOF
=== System Info ===
$(uname -a)
$(node --version)
$(npm --version)
$(pm2 --version)

=== PM2 Status ===
$(pm2 show 9mm-rebalancer)

=== Recent Logs ===
$(pm2 logs 9mm-rebalancer --lines 50 --nostream)

=== Error Logs ===
$(tail -50 ~/9mm-rebalancer/logs/error.log)

=== Config ===
$(cat ~/9mm-rebalancer/config.yaml)

=== Disk Space ===
$(df -h)

=== Process List ===
$(ps aux | grep node)
EOF

# View report
less ~/9mm-diagnostic.txt

# Send report when requesting support
```

### Contact

- **GitHub Issues**: https://github.com/TylerB007/ALM-For-9MM-Pulsechain/issues
- **Project Owner**: Tyler (GitHub: TylerB007)

---

## 🔄 Quick Fixes

### Nuclear Option (Reset Everything)

**⚠️ WARNING: This will delete all local changes and logs**

```bash
# Stop application
pm2 delete 9mm-rebalancer

# Backup .env
cp ~/9mm-rebalancer/.env ~/9mm-rebalancer-env-backup

# Remove directory
rm -rf ~/9mm-rebalancer

# Re-clone
mkdir -p ~/9mm-rebalancer
cd ~/9mm-rebalancer
git clone https://github.com/TylerB007/ALM-For-9MM-Pulsechain.git .

# Restore .env
cp ~/9mm-rebalancer-env-backup .env
chmod 600 .env

# Rebuild
npm install
npm run build

# Start fresh
pm2 start ecosystem.config.cjs
pm2 save
```

---

## 📝 Maintenance Commands

### Regular Health Checks
```bash
# Run daily
~/check-9mm-health.sh

# Check disk space
df -h

# Check log sizes
du -sh ~/9mm-rebalancer/logs/*

# Check PM2 status
pm2 status
```

### Monthly Maintenance
```bash
# Update dependencies (careful!)
cd ~/9mm-rebalancer
npm update
npm audit fix
npm run build
pm2 restart 9mm-rebalancer

# Clean old logs
pm2 flush
find ~/9mm-rebalancer/logs/ -name "*.log.*" -mtime +30 -delete
```

---

**Last Updated**: 2026-02-27
**Maintainer**: Tyler (GitHub: TylerB007)

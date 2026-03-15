# Prompt: Build a PulseChain 9mm V3 LP Auto-Rebalancer Bot

## Instructions for AI

You are building an end-to-end, ready-to-use automated liquidity position rebalancer bot for the **9mm DEX V3** on **PulseChain**. 9mm V3 is a Uniswap V3 fork — all contract interfaces are identical to Uniswap V3's standard ABIs (NonfungiblePositionManager, SwapRouter, UniswapV3Pool, UniswapV3Factory).

The bot monitors existing V3 concentrated liquidity positions, detects when they go out of range, and automatically rebalances them based on configurable strategy rules. It runs as a standalone Node.js/TypeScript CLI application on the user's local machine or VPS.

---

## Project Requirements

### Tech Stack
- **Runtime**: Node.js 18+ with TypeScript
- **Blockchain interaction**: ethers.js v6
- **Configuration**: `.env` file for secrets, `config.yaml` for strategy parameters
- **Logging**: Console + rotating log file (winston or pino)
- **Process management**: Runs as a persistent process with graceful shutdown (SIGINT/SIGTERM)

### Architecture — Single Project, These Files

```
9mm-rebalancer/
├── src/
│   ├── index.ts              # Entry point — loads config, starts monitoring loop
│   ├── config.ts             # Loads and validates .env + config.yaml
│   ├── chain.ts              # Provider setup, wallet signer, retry/fallback RPC logic
│   ├── contracts.ts          # Contract instances (PositionManager, Factory, Router, Pool)
│   ├── position.ts           # Fetch position data, calculate in-range/out-of-range status
│   ├── pool.ts               # Pool state: slot0, current tick, sqrtPriceX96, liquidity
│   ├── strategy.ts           # Strategy engine — rule evaluation and rebalance decision
│   ├── rebalancer.ts         # Execute rebalance: collect fees → remove liquidity → swap → mint new position
│   ├── swap.ts               # Execute exact-input swap via SwapRouter with slippage protection
│   ├── math.ts               # V3 math utilities (tick↔price, sqrtPriceX96, liquidity calculations)
│   ├── notifications.ts      # Optional: Telegram/Discord webhook alerts
│   ├── logger.ts             # Logger setup
│   └── types.ts              # TypeScript interfaces and types
├── abis/
│   ├── NonfungiblePositionManager.json
│   ├── UniswapV3Factory.json
│   ├── UniswapV3Pool.json
│   └── SwapRouter.json
├── config.yaml               # User strategy configuration
├── .env.example              # Environment variable template
├── package.json
├── tsconfig.json
└── README.md                 # Setup and usage guide
```

---

## PulseChain & 9mm V3 Specifics

### Chain Configuration
- **Chain ID**: 369
- **RPC URLs** (use multiple for fallback):
  - `https://rpc.pulsechain.com`
  - `https://rpc-pulsechain.g4mm4.io`
  - `https://pulsechain-rpc.publicnode.com`
- **Block time**: ~10 seconds (use this to calibrate polling interval)
- **Native token**: PLS (very cheap gas — fractions of a cent per transaction)
- **WPLS (Wrapped PLS)**: `0xA1077a294dDE1B09bB078844df40758a5D0f9a27`

### 9mm V3 Contract Addresses

**IMPORTANT**: 9mm is a Uniswap V3 fork. The contract interfaces/ABIs are identical to Uniswap V3. You MUST look up the actual deployed contract addresses for 9mm V3 on PulseChain before using them. The user should verify these on https://scan.9mm.pro or the 9mm GitHub (https://github.com/9mmPro/9mm-v3-contracts).

Provide placeholders in the config that the user fills in:
```yaml
contracts:
  # User MUST verify these addresses on scan.9mm.pro before running
  nonfungiblePositionManager: "0x_FILL_IN_FROM_9MM_DOCS"
  swapRouter: "0x_FILL_IN_FROM_9MM_DOCS"
  factory: "0x_FILL_IN_FROM_9MM_DOCS"
```

### Common PulseChain Token Addresses (for reference in config)
```
WPLS:  0xA1077a294dDE1B09bB078844df40758a5D0f9a27
PLSX:  0x95B303987A60C71504D99Aa1b13B4DA07b0790ab
HEX:   0x2b591e99afE9f32eAA6214f7B7629768c40Eeb39
DAI:   0xefD766cCb38EaF1dfd701853BFCe31359239F305
USDC:  0x15D38573d2feeb82e7ad5187aB8c1D52810B1f07
USDT:  0x0Cb6F5a34ad42ec934882A05265A7d5F59b51A2f
WETH:  0x02DcdD04e3F455D838cd1249292C58f3B79e3C3C
WBTC:  0xb17D901469B9208B17d916112988A3FeD19b5cA1
```

### ABIs

Use standard Uniswap V3 ABIs. Include only the functions actually needed (not the full ABI):

**NonfungiblePositionManager** — needed functions:
- `positions(uint256 tokenId)` → returns (nonce, operator, token0, token1, fee, tickLower, tickUpper, liquidity, feeGrowthInside0LastX128, feeGrowthInside1LastX128, tokensOwed0, tokensOwed1)
- `collect(CollectParams)` → returns (amount0, amount1)
- `decreaseLiquidity(DecreaseLiquidityParams)` → returns (amount0, amount1)
- `mint(MintParams)` → returns (tokenId, liquidity, amount0, amount1)
- `burn(uint256 tokenId)`

**UniswapV3Factory** — needed functions:
- `getPool(address tokenA, address tokenB, uint24 fee)` → returns pool address

**UniswapV3Pool** — needed functions:
- `slot0()` → returns (sqrtPriceX96, tick, observationIndex, observationCardinality, observationCardinalityNext, feeProtocol, unlocked)
- `liquidity()` → returns total liquidity
- `token0()` / `token1()`
- `fee()`
- `tickSpacing()`

**SwapRouter** — needed functions:
- `exactInputSingle(ExactInputSingleParams)` → returns amountOut

---

## Strategy Configuration (config.yaml)

Support multiple positions, each with independent strategy rules:

```yaml
# Global settings
polling_interval_seconds: 30        # How often to check positions
max_gas_price_gwei: 500             # Skip rebalance if gas is insane (unlikely on PulseChain)
dry_run: true                       # Log what WOULD happen without executing (start with this!)
slippage_tolerance_bps: 100         # 1% default slippage for swaps
rebalance_cooldown_seconds: 300     # Minimum time between rebalances for same position

# Contract addresses — user MUST fill these in
contracts:
  nonfungiblePositionManager: "0x_VERIFY_ON_SCAN_9MM_PRO"
  swapRouter: "0x_VERIFY_ON_SCAN_9MM_PRO"  
  factory: "0x_VERIFY_ON_SCAN_9MM_PRO"

# Notifications (optional)
notifications:
  enabled: false
  telegram_bot_token: ""
  telegram_chat_id: ""
  # OR
  discord_webhook_url: ""

# Position strategies
positions:
  - token_id: 12345                 # NFT token ID of the V3 position
    strategy: "pulse"               # Strategy type: pulse | lazy_ascending | lazy_descending | static
    
    # Strategy parameters
    params:
      # Width of the new position in ticks (must be multiple of pool's tickSpacing)
      width_ticks: 600
      
      # How far outside the range the tick must be before triggering rebalance
      # (in ticks beyond tickUpper or below tickLower)
      trigger_distance_ticks: 10
      
      # For "pulse" strategy: recenters position around current tick
      # For "lazy_ascending": only rebalances when price goes ABOVE tickUpper
      # For "lazy_descending": only rebalances when price goes BELOW tickLower
      # For "static": never auto-rebalances, only sends alerts

  - token_id: 67890
    strategy: "lazy_ascending"
    params:
      width_ticks: 1200
      trigger_distance_ticks: 20
```

---

## Strategy Logic (strategy.ts)

Implement these strategy types:

### 1. Pulse Strategy
The default. When the current tick exits the position range by more than `trigger_distance_ticks`:
- Calculate new tickLower and tickUpper centered on the current tick
- Snap to nearest valid tick (must be multiple of tickSpacing)
- Rebalance: collect fees → remove all liquidity → swap to correct ratio → mint new position at new range

### 2. Lazy Ascending
Only triggers rebalance when price moves ABOVE tickUpper + trigger_distance_ticks. Ignores downward movements. Good for bullish positions where you want to follow upward price action.

### 3. Lazy Descending  
Only triggers rebalance when price moves BELOW tickLower - trigger_distance_ticks. Ignores upward movements.

### 4. Static (Alert Only)
Never rebalances. Sends notification when position goes out of range. Useful for positions you want to manage manually but still monitor.

---

## Rebalance Execution Flow (rebalancer.ts)

The rebalance sequence must be atomic-safe and follow this exact order:

```
1. PRE-CHECKS
   ├─ Verify wallet still owns the NFT position
   ├─ Check position has liquidity > 0
   ├─ Check cooldown hasn't elapsed
   ├─ Fetch current pool state (slot0)
   └─ Verify trigger condition still valid (price may have moved back)

2. COLLECT FEES
   ├─ Call collect() on NonfungiblePositionManager
   └─ Log collected amounts

3. REMOVE LIQUIDITY
   ├─ Call decreaseLiquidity() with full liquidity amount
   ├─ Call collect() again to collect the withdrawn tokens
   ├─ Call burn() to burn the empty NFT
   └─ Log total token0 and token1 amounts recovered

4. CALCULATE NEW POSITION
   ├─ Get current tick from pool.slot0()
   ├─ Calculate new tickLower and tickUpper based on strategy
   ├─ Snap ticks to tickSpacing grid
   ├─ Calculate required token0/token1 ratio for new range
   └─ Determine swap direction and amount needed

5. SWAP (if needed)
   ├─ Calculate exact amount to swap to achieve target ratio
   ├─ Apply slippage tolerance
   ├─ Execute exactInputSingle on SwapRouter
   └─ Log swap details

6. MINT NEW POSITION
   ├─ Approve tokens to NonfungiblePositionManager
   ├─ Call mint() with new tick range and token amounts
   ├─ Update config with new tokenId (the old one was burned)
   ├─ Log new position details
   └─ Send notification

7. ERROR HANDLING
   ├─ If any step fails after removing liquidity, DO NOT leave tokens sitting
   ├─ Log complete state for manual recovery
   ├─ Send critical alert notification
   └─ Enter safe mode (pause this position's auto-rebalance)
```

---

## V3 Math Utilities (math.ts)

Implement these essential functions:

```typescript
// Convert tick to price (human-readable)
function tickToPrice(tick: number, decimals0: number, decimals1: number): number

// Convert price to nearest valid tick
function priceToTick(price: number, decimals0: number, decimals1: number): number

// Snap tick to nearest multiple of tickSpacing
function nearestUsableTick(tick: number, tickSpacing: number): number

// Calculate token0 and token1 amounts needed for a given liquidity at a tick range
function getAmountsForLiquidity(
  sqrtPriceX96: bigint,
  sqrtPriceAX96: bigint, 
  sqrtPriceBX96: bigint,
  liquidity: bigint
): { amount0: bigint, amount1: bigint }

// Calculate the liquidity for given token amounts at a tick range
function getLiquidityForAmounts(
  sqrtPriceX96: bigint,
  sqrtPriceAX96: bigint,
  sqrtPriceBX96: bigint,
  amount0: bigint,
  amount1: bigint
): bigint

// Convert tick to sqrtPriceX96
function tickToSqrtPriceX96(tick: number): bigint

// Calculate optimal swap amount to achieve target ratio for new position
function calculateSwapAmount(
  amount0: bigint,
  amount1: bigint,
  currentTick: number,
  newTickLower: number,
  newTickUpper: number,
  fee: number
): { tokenIn: 'token0' | 'token1', amountIn: bigint }
```

Use `BigInt` throughout for all on-chain math. Never use floating point for token amounts or price calculations.

---

## Critical Safety Requirements

1. **Dry run mode by default** — `dry_run: true` in config. When dry run is on, the bot logs exactly what it WOULD do (including tx calldata) but does not execute. User must explicitly set to false.

2. **Private key security** — Private key goes in `.env` only, never in config.yaml. The `.env` file should be in `.gitignore`. Warn loudly in README.

3. **Slippage protection** — All swaps must use `amountOutMinimum` calculated from oracle price minus slippage tolerance. All mints must use non-zero `amount0Min`/`amount1Min`.

4. **Approval management** — Check existing token allowances before approving. Use exact approval amounts, not MaxUint256, for safety.

5. **Position ownership verification** — Before every operation, verify the wallet owns the NFT. Someone could have transferred it.

6. **Error recovery** — If rebalance fails mid-execution (after removing liquidity but before minting), the bot must:
   - Log the exact token balances held by the wallet
   - Pause automatic rebalancing for that position
   - Send a critical alert
   - NOT attempt to retry automatically (user should review state first)

7. **Token ID tracking** — When a rebalance burns the old NFT and mints a new one, the new token ID must be written back to the config file so the bot tracks the correct position going forward.

8. **Nonce management** — Use manual nonce tracking to avoid stuck transactions. Implement nonce recovery if a tx fails.

9. **RPC fallback** — If the primary RPC fails, automatically try the backup RPCs. Log RPC errors and rotate.

---

## .env.example

```env
# PRIVATE KEY — keep this secret! Never commit this file.
PRIVATE_KEY=0xYOUR_PRIVATE_KEY_HERE

# Optional: Override RPC URLs (defaults are in chain.ts)
RPC_URL_PRIMARY=https://rpc.pulsechain.com
RPC_URL_FALLBACK_1=https://rpc-pulsechain.g4mm4.io
RPC_URL_FALLBACK_2=https://pulsechain-rpc.publicnode.com
```

---

## README.md Must Include

1. **What this is** — brief explanation of automated V3 LP rebalancing
2. **Prerequisites** — Node.js 18+, a PulseChain wallet with PLS for gas, existing 9mm V3 LP position(s)
3. **Setup instructions** — step by step: clone, npm install, configure .env, configure config.yaml
4. **How to find your position token ID** — explain checking on scan.9mm.pro or the 9mm app
5. **How to find 9mm V3 contract addresses** — point to scan.9mm.pro and the 9mm GitHub repo
6. **Strategy explanations** — what each strategy does with examples
7. **Running in dry-run mode first** — emphasize testing before going live
8. **Running in production** — `npm start` or using pm2 for persistence
9. **Risks and disclaimers**:
   - Smart contract risk (interacting with unaudited/forked contracts)
   - Impermanent loss risk (rebalancing crystallizes IL)
   - Sandwich attack risk (rebalance swaps can be sandwiched on PulseChain)
   - Bot failure risk (RPC downtime, process crash)
   - This is personal-use software, not audited, use at your own risk

---

## Output Format

Produce ALL files as complete, ready-to-run code. No placeholders like `// TODO` or `// implement this`. Every function must be fully implemented with proper error handling. The user should be able to:

```bash
git clone <repo>
cd 9mm-rebalancer
cp .env.example .env
# Edit .env with private key
# Edit config.yaml with position token IDs and verified contract addresses
npm install
npm run build
npm start
```

And have a working bot monitoring their positions in dry-run mode immediately.

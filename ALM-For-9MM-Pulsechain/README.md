# ALM for 9mm on PulseChain

Automated Liquidity Management (ALM) bot for 9mm V3 on PulseChain. This repository contains verified contract addresses, ABIs, and configuration files extracted from production sources.

## ✨ Key Features

- **🎯 6 Rebalancing Strategies**: Pulse, Snuggle Up/Down, Lazy Ascending/Descending, Static
- **📊 Analytics & Metrics**: Track IL, APR, ROI, and position performance
- **🔔 Telegram Integration**: Remote monitoring and commands
- **🌐 Web Dashboard**: Real-time position monitoring and analytics
- **💱 Smart Swap Routing**: Defaults to Piteas DEX aggregator for optimal execution across all PulseChain DEXes
- **🛡️ Safety Features**: Dry-run mode, gas limits, cooldown periods, safe mode recovery

> **New in v1.5.0**: DEX Aggregator is now the default! Swaps automatically route through [Piteas](https://app.piteas.io) for better execution. See [DEX Aggregator Guide](docs/DEX_AGGREGATOR_GUIDE.md) for details.

## 📁 Repository Structure

```
.
├── src/
│   ├── index.ts             # Entry point & monitoring loop
│   ├── rebalancer.ts        # 7-step rebalance workflow
│   ├── chain.ts             # Multi-provider RPC with fallback
│   ├── contracts.ts         # ethers v6 contract instances
│   ├── math.ts              # BigInt V3 math (tick/price/liquidity)
│   ├── configLoader.ts      # YAML config loader
│   ├── notifications.ts     # Telegram & Discord alerts
│   ├── telegramCommands.ts  # Interactive Telegram bot commands
│   ├── logger.ts            # Winston logging setup
│   ├── analytics-cli.ts     # CLI dashboard for analytics
│   ├── analytics/           # Performance tracking (v1.1.0)
│   │   ├── types.ts         # Analytics type definitions
│   │   ├── collector.ts     # Data capture orchestrator
│   │   ├── metrics.ts       # IL, APR, ROI calculations
│   │   ├── storage.ts       # JSON Lines persistence
│   │   └── cache.ts         # In-memory cache
│   └── config/              # Static constants & addresses
│       ├── index.ts         # Barrel export
│       ├── pulsechain.ts    # PulseChain network configuration
│       ├── contracts.ts     # Verified 9mm V3 contract addresses
│       ├── fees.ts          # Fee tiers and tick spacings
│       └── constants.ts     # Operational constants
├── abis/                    # Contract ABIs
│   ├── NonfungiblePositionManager.json
│   ├── UniswapV3Factory.json
│   ├── UniswapV3Pool.json
│   ├── SwapRouter.json
│   ├── ERC20.json
│   └── Multicall3.json
├── config.yaml              # Runtime configuration
├── .env.example             # Environment variables template
└── ecosystem.config.cjs     # PM2 process manager config
```

## 🔐 Verified Contract Addresses

All contract addresses have been verified and extracted from the `TylerB007/main-liquidity-dashboard` repository:

### Core 9mm V3 Contracts
- **NonfungiblePositionManager**: `0xCC05bf158202b4F461Ede8843d76dcd7Bbad07f2`
- **SwapRouter**: `0xeB45a3c4aedd0F47F345fB4c8A1802BB5740d725`
- **Factory**: `0xe50dbdc88e87a2c92984d794bcf3d1d76f619c68`
- **Quoter**: `0x250D0399E3f363d98f8A27942712d59248C33007`
- **PoolDeployer**: `0x00f37661fa1b2b8a530cfb7b6d5a5a6aed74177b`
- **TokenDescriptor**: `0xfc6d8b33211c1ace98d34b3b4b0df35f4e3186d1`

## ⚠️ Critical Differences from Uniswap V3

**9mm uses non-standard fee tiers!**

| Tier | Uniswap V3 | 9mm V3 | 9mm Tick Spacing |
|------|------------|--------|------------------|
| LOWEST | 100 (0.01%) | 100 (0.01%) | 1 |
| LOW | 500 (0.05%) | 500 (0.05%) | 10 |
| **MEDIUM** | **3000 (0.30%)** | **2500 (0.25%)** | **50** |
| HIGH | 10000 (1.00%) | 10000 (1.00%) | 200 |

The MEDIUM tier is the most commonly used tier and differs significantly:
- **Uniswap V3**: Fee = 3000 (0.30%), Tick Spacing = 60
- **9mm V3**: Fee = 2500 (0.25%), Tick Spacing = 50

## 🚀 Quick Start

1. **Copy environment variables**:
   ```bash
   cp .env.example .env
   ```

2. **Edit `.env`** with your private key:
   ```env
   PRIVATE_KEY=0xYOUR_PRIVATE_KEY_HERE
   ```

3. **Configure positions** in `config.yaml`:
   - Replace `token_id: 0` with your NFT position token ID
   - Adjust strategy parameters as needed

4. **Import configuration in your code**:
   ```typescript
   import {
     PULSECHAIN_CONFIG,
     CONTRACTS,
     TOKENS,
     FEE_TIERS,
     TICK_SPACINGS,
     getTickSpacing,
     GAS_LIMITS
   } from './src/config';
   ```

## 📊 Rebalancing Strategies

The rebalancer supports multiple strategies for different market conditions. Configure your strategy in `config.yaml`:

```yaml
positions:
  - token_id: 155284
    strategy: "pulse"  # Choose your strategy
    params:
      width_percentage: 10 # 10% auto-calculates width_ticks, helpful for varying volatility
      # width_ticks: 600 # Alternatively provide precise ticks
      trigger_percentage: 1 # 1% auto-calculates trigger_distance_ticks
      # trigger_distance_ticks: 10 # Alternatively provide precise ticks
```

### Available Strategies

#### 🎯 Symmetric Strategies

**Pulse (Default)** — Neutral market strategy
- **Trigger**: Rebalances when price moves out of range + trigger buffer
- **Range**: 50% below / 50% above current price (centered)
- **Use Case**: Neutral market, maximize time in range and fee collection
- **Example**: With `width_ticks: 600` (or `width_percentage: 6`), creates range `[current-300, current+300]`

**Static** — Monitoring only (no rebalancing)
- **Trigger**: Never rebalances automatically
- **Range**: N/A
- **Use Case**: Passive monitoring, manual intervention only
- **Behavior**: Logs warnings when out of range but takes no action

---

#### 📈 Asymmetric Strategies (v1.2.0)

**Snuggle Up** — Bullish market strategy
- **Trigger**: Rebalances when price moves out of range + trigger buffer
- **Range**: 30% below / 70% above current price
- **Use Case**: Bullish sentiment, expect price to rise
- **Advantage**: More room for upside before going out of range
- **Example**: With `width_ticks: 600` (or `width_percentage: 6`), creates range `[current-180, current+420]`

**Snuggle Down** — Bearish market strategy
- **Trigger**: Rebalances when price moves out of range + trigger buffer
- **Range**: 70% below / 30% above current price
- **Use Case**: Bearish sentiment, expect price to fall
- **Advantage**: More room for downside before going out of range
- **Example**: With `width_ticks: 600` (or `width_percentage: 6`), creates range `[current-420, current+180]`

---

#### 🔄 Directional Strategies

**Lazy Ascending** — Follow the pump
- **Trigger**: Only rebalances when price moves ABOVE upper bound
- **Range**: 50% below / 50% above (centered)
- **Use Case**: Bullish trend following, avoid selling during dumps
- **Behavior**: Follows price up but holds position if price drops

**Lazy Descending** — Accumulate on dips
- **Trigger**: Only rebalances when price moves BELOW lower bound
- **Range**: 50% below / 50% above (centered)
- **Use Case**: Accumulate assets on the way down, take profit on rallies
- **Behavior**: Follows price down but holds position if price pumps

---

### Strategy Comparison Table

| Strategy | Trigger Condition | Width Split | Best For |
|----------|------------------|-------------|----------|
| **pulse** | Out of range + buffer | 50% / 50% | Neutral markets |
| **snuggle_up** | Out of range + buffer | 30% / 70% | Bullish bias |
| **snuggle_down** | Out of range + buffer | 70% / 30% | Bearish bias |
| **lazy_ascending** | Above upper only | 50% / 50% | Following pumps |
| **lazy_descending** | Below lower only | 50% / 50% | Accumulating dips |
| **static** | Never | N/A | Monitoring only |

### Choosing the Right Strategy

- **Neutral market?** Use `pulse` for balanced fee collection
- **Expecting a pump?** Use `snuggle_up` for more upside room
- **Expecting a dump?** Use `snuggle_down` for more downside room
- **Following a trend up?** Use `lazy_ascending` to avoid selling low
- **Accumulating?** Use `lazy_descending` to buy dips
- **Manual control?** Use `static` for monitoring without automation

### Important Notes

⚠️ **Impermanent Loss Considerations**:
- Asymmetric strategies (`snuggle_up`, `snuggle_down`) concentrate more capital in one direction
- Higher potential IL if price moves opposite to your bias
- Better fee collection if price moves in your expected direction

⚠️ **Directional vs Asymmetric**:
- **Directional** (`lazy_*`) change *when* rebalancing happens (trigger condition)
- **Asymmetric** (`snuggle_*`) change *how* the range is positioned (width split)

⚠️ **Gas Costs**:
- All strategies (except `static`) rebalance with similar frequency
- No significant gas cost differences between strategies

## 📡 RPC Endpoints

PulseChain RPC URLs (with automatic fallback):
1. `https://rpc.pulsechain.com` (Primary)
2. `https://rpc-pulsechain.g4mm4.io` (Fallback 1)
3. `https://pulsechain-rpc.publicnode.com` (Fallback 2)

WebSocket: `wss://rpc.pulsechain.com`

## 🔍 Block Explorers

- Primary: https://scan.pulsechain.com
- IPFS: https://ipfs.scan.pulsechain.com
- Alternative: https://scan.mypinata.cloud/ipfs/bafybeienxyoyrhn5tswclvd3gdjy5mtkkwmu37aqtml6onbf7xnb3o22pe

## 📊 GraphQL Endpoints

- **9mm V3**: https://graph.9mm.pro/subgraphs/name/pulsechain/9mm-v3
- **9mm V2**: https://graph.9mm.pro/subgraphs/name/pulsechain/9mm
- **PulseX**: https://graph.pulsechain.com/subgraphs/name/pulsechain/pulsex
- **Blocks**: https://graph.pulsechain.com/subgraphs/name/pulsechain/blocks

## 💡 Usage Examples

### Get Tick Spacing for a Fee Tier

```typescript
import { getTickSpacing, FEE_TIERS } from './src/config';

// 9mm MEDIUM tier
const tickSpacing = getTickSpacing(FEE_TIERS.MEDIUM);
console.log(tickSpacing); // 50

// This will throw an error for unsupported fee tiers
try {
  getTickSpacing(3000); // Uniswap V3 MEDIUM - NOT supported on 9mm
} catch (error) {
  console.error(error.message);
}
```

### Load Contract Instance

```typescript
import { ethers } from 'ethers';
import { CONTRACTS } from './src/config';
import PositionManagerABI from './abis/NonfungiblePositionManager.json';

const provider = new ethers.JsonRpcProvider('https://rpc.pulsechain.com');
const positionManager = new ethers.Contract(
  CONTRACTS.NONFUNGIBLE_POSITION_MANAGER,
  PositionManagerABI,
  provider
);
```

## 📝 Configuration Files

### `src/config/pulsechain.ts`
Network configuration including chain ID (369), RPC URLs, native currency info, and GraphQL endpoints.

### `src/config/contracts.ts`
Verified contract addresses for 9mm V3 core contracts and major PulseChain tokens (WPLS, PLSX, HEX, INC, DAI, USDC, USDT, WETH, WBTC).

### `src/config/fees.ts`
Fee tier definitions and tick spacing mappings with helper functions. **Critical for correct 9mm V3 integration.**

### `src/config/constants.ts`
Operational constants including max uint values, zero address, default deadlines, slippage tolerance, gas limits, and function selectors.

## 🛡️ Security

- **Never commit `.env`** - Your private key must remain secret
- `.gitignore` is configured to exclude sensitive files
- All contract addresses have been verified from production sources

## 📚 Sources

All data extracted from `TylerB007/main-liquidity-dashboard` at commit `cc8c89f5d63f64d61144cabd652c396011a6faec`:
- `config/contracts.js` - Core contract addresses
- `config/dexs/ninemm.js` - 9mm DEX configuration
- `config/networks/pulsechain.js` - Network configuration
- `config/abis.js` - Human-readable ABIs
- `utils/ninemill_constants.js` - JSON ABIs and constants

## 📖 Documentation

### Essential Guides

- **[STATUS.md](./STATUS.md)** - Current deployment status & known issues
- **[DEPLOY_MANUAL.md](./DEPLOY_MANUAL.md)** - Step-by-step VPS deployment guide
- **[TROUBLESHOOTING.md](./TROUBLESHOOTING.md)** - Common problems & solutions

### Technical Reference

- **[ARCHITECTURE.md](./ARCHITECTURE.md)** - System design & data flow
- **[CHANGELOG.md](./CHANGELOG.md)** - Version history & release notes
- **[9mm-lp-rebalancer-prompt.md](./9mm-lp-rebalancer-prompt.md)** - Original project specification

### Quick Links

- **Deployment Status**: See [STATUS.md](./STATUS.md) for live production info
- **Need Help?**: Check [TROUBLESHOOTING.md](./TROUBLESHOOTING.md) first
- **Operations**: SSH into VPS and see `~/9mm-rebalancer/OPERATIONS.md`

## 📊 Performance Analytics (v1.1.0)

Track position performance with built-in analytics:

```bash
npm run analytics summary            # Overall performance
npm run analytics status [tokenId]   # Position status report
npm run analytics history [tokenId]  # Rebalance timeline
```

**Metrics tracked**: Fee APR, Impermanent Loss, Net ROI, Capital Efficiency, Time-in-Range, gas costs per step.

**Storage**: JSON Lines files in `./analytics/` with daily rotation (~2-5 MB/month per position).

**Configuration** in `config.yaml`:

```yaml
analytics:
  enabled: true
  snapshot_interval_minutes: 10
  persist_to_disk: true
  storage_path: "./analytics"
```

See [ARCHITECTURE.md](./ARCHITECTURE.md) for analytics data flow details.

## 🚀 Deployment Status

### Production Environment

**Status**: ✅ DEPLOYED & RUNNING (as of 2026-02-09)

- **Platform**: DigitalOcean VPS (143.110.130.198)
- **Runtime**: Node.js v22.22.0 with PM2 v6.0.14
- **Version**: 1.1.0 (analytics enabled)
- **Monitoring**: Position #155284 (HEX/WPLS) every 30 seconds
- **Auto-restart**: Enabled (survives crashes & reboots)

See [STATUS.md](./STATUS.md) for detailed current status.

## 🤝 Contributing

This repository is focused solely on **PulseChain + 9mm V3** integration. We do not include:
- Multi-chain configurations (Ethereum, Polygon, Base, etc.)
- Other DEX configurations (PulseX, Aerodrome, Uniswap V2/V4)
- UI/dashboard components
- Viem-specific chain definitions (uses ethers.js v6)

## ⚙️ Network Information

- **Chain ID**: 369
- **Chain Name**: PulseChain
- **Native Currency**: PLS (Pulse) - 18 decimals
- **Block Time**: ~3 seconds
- **Blocks Per Day**: ~28,800

## 📄 License

See LICENSE file for details.

---

**Project Owner**: Tyler ([@TylerB007](https://github.com/TylerB007))
**Repository**: https://github.com/TylerB007/ALM-For-9MM-Pulsechain

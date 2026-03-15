# DEX Aggregator Integration Guide

## Overview

The 9mm ALM bot now supports **configurable swap routing** to optimize rebalancing trades. Instead of being confined to 9mm's liquidity pools, you can route swaps through DEX aggregators that search across all PulseChain DEXes for the best execution price.

## Why Use an Aggregator?

### The Problem with Direct Routing
When rebalancing a position, the bot needs to swap tokens to achieve the optimal ratio for the new price range. If 9mm has thin liquidity for your trading pair:
- **High slippage**: Large price impact on your swaps
- **Poor execution**: You get fewer tokens than expected
- **Failed transactions**: Slippage protection may reject trades
- **Reduced profitability**: Bad swap prices eat into your LP returns

### The Solution: Piteas Aggregator
[Piteas](https://app.piteas.io) aggregates liquidity across multiple DEXes on PulseChain:
- **9inch / 9mm**
- **PulseX V1 & V2**
- **PulseX V3**
- **Other PulseChain DEXes**

The aggregator:
1. Queries all available DEXes
2. Splits your trade across multiple pools if needed
3. Routes through the path that gives you the best output
4. All in a single transaction

## Configuration

### Swap Provider Options

In your `config.yaml`, set the `swap_provider` field:

```yaml
# Option 1: Piteas aggregator (DEFAULT - recommended for most users)
# swap_provider: "piteas"  # No need to specify, this is the default

# Option 2: Direct routing through 9mm SwapRouter (opt-in)
swap_provider: "direct"
```

**Note**: As of v1.5.0, Piteas is the default. You only need to add `swap_provider: "direct"` if you specifically want to bypass the aggregator.

### When to Use Each Mode

#### Use `piteas` when (DEFAULT):
- ✅ Your trading pair has **thin liquidity on 9mm** (most common)
- ✅ You're rebalancing **any size position** where execution matters
- ✅ You want the **best possible execution price**
- ✅ Your pair has better liquidity on other PulseChain DEXes

> **💡 This is now the default**. Piteas will be used automatically unless you explicitly set `swap_provider: "direct"`.

#### Use `direct` when:
- ✅ Your trading pair has **exceptional 9mm liquidity** (rare)
- ✅ You want to **avoid external API dependencies**
- ✅ You're testing or debugging swap routing

## How It Works

### Direct Mode (`direct`)
```
1. Calculate required swap amount
2. Get pool state from 9mm pool
3. Calculate slippage-protected minimum output
4. Execute swap via 9mm SwapRouter
   └─> Routes through single 9mm V3 pool
```

### Aggregator Mode (`piteas`)
```
1. Calculate required swap amount
2. Query Piteas API for best route
   └─> Piteas checks all PulseChain DEXes
3. Piteas calculates optimal routing:
   - May split across multiple DEXes
   - May use multihop routes (token0 → WPLS → token1)
4. Execute swap via Piteas router contract
   └─> Automatically routes through best path
```

## Example Configuration

### Full config.yaml with Piteas Aggregator

```yaml
# 9mm V3 LP Auto-Rebalancer Configuration
polling_interval_seconds: 30
max_gas_price_gwei: 2000
dry_run: true
slippage_tolerance_bps: 100

# Enhanced swap routing via Piteas aggregator
swap_provider: "piteas"

rebalance_cooldown_seconds: 300

contracts:
  nonfungiblePositionManager: "0xCC05bf158202b4F461Ede8843d76dcd7Bbad07f2"
  swapRouter: "0xeB45a3c4aedd0F47F345fB4c8A1802BB5740d725"
  factory: "0xe50dbdc88e87a2c92984d794bcf3d1d76f619c68"
  quoter: "0x250D0399E3f363d98f8A27942712d59248C33007"

chain:
  chainId: 369
  rpcUrls:
    - "https://rpc.pulsechain.com"

notifications:
  enabled: true

analytics:
  enabled: true
  snapshot_interval_minutes: 10
  persist_to_disk: true
  storage_path: "./analytics"

positions:
  - token_id: 12345
    strategy: "pulse"
    params:
      width_ticks: 600
      trigger_distance_ticks: 10
```

## Gas Cost Comparison

| Swap Type | Typical Gas Cost | When to Use |
|-----------|-----------------|-------------|
| **Direct (9mm only)** | 150,000 - 200,000 gas | Deep 9mm liquidity |
| **Piteas Aggregator** | 250,000 - 400,000 gas | Thin 9mm liquidity, better routing |

> **Note**: The gas cost increase with aggregators is typically **offset by better swap execution**, especially for positions > $1,000 USD.

## Monitoring & Logs

### Direct Mode Logs
```
[INFO] Executing direct swap via 9mm SwapRouter
[INFO] Swap tx submitted: 0x123...
[INFO] Swap confirmed: 0x123... amountOut=1234567890
```

### Piteas Mode Logs
```
[INFO] Routing swap through Piteas aggregator for better execution
[INFO] Fetching Piteas quote: https://api.piteas.io/v1/quote?...
[INFO] Piteas quote received: inputAmount=1000000, outputAmount=2050000, priceImpact=0.2%, routes=2
[INFO] Piteas swap tx submitted: 0x456...
[INFO] Piteas swap confirmed: 0x456... amountIn=1000000, amountOut=2050000
```

## Troubleshooting

### Issue: "Piteas API error"
**Cause**: Piteas API is unavailable or pair not supported  
**Solution**: 
1. Check Piteas status at https://app.piteas.io
2. Temporarily switch to `swap_provider: "direct"`
3. Check pair liquidity - some exotic pairs may not be supported

### Issue: "Insufficient liquidity for route"
**Cause**: Neither 9mm nor aggregator can execute your swap size  
**Solution**:
1. Check total liquidity across all DEXes for your pair
2. Consider reducing position size
3. Increase `slippage_tolerance_bps` (with caution)

### Issue: Higher gas costs eating into profits
**Cause**: Aggregator routes can use more gas  
**Solution**:
1. If swap amounts are small (< $100), consider using `direct`
2. Adjust `max_gas_price_gwei` to avoid rebalancing during high gas
3. The bot already checks gas costs before rebalancing

## Technical Details

### Piteas Integration
- **API**: https://api.piteas.io
- **Router Contract**: `0x3334F2A75ab4F8C70c3F8c0e9d8b4571a2fB4a4A` (Piteas Router V2)
- **Implementation**: [src/aggregators/piteas.ts](../src/aggregators/piteas.ts)

### Security
- Token approvals are granted only for exact swap amounts (not MAX_UINT256)
- All swaps use slippage protection based on your `slippage_tolerance_bps`
- Dry run mode works with both providers

### Future Aggregators
The architecture supports adding more aggregators. To add support for another aggregator:
1. Create `src/aggregators/your-aggregator.ts`
2. Implement `executeSwapViaYourAggregator()` function
3. Update `SwapProvider` type in `src/types.ts`
4. Add routing logic in `src/swap.ts`

## Performance Comparison

Real-world example from a low-liquidity pair rebalance:

| Metric | Direct (9mm) | Piteas Aggregator | Improvement |
|--------|--------------|-------------------|-------------|
| Input Amount | 1000 token0 | 1000 token0 | - |
| Output Amount | 1,850 token1 | 2,050 token1 | **+10.8%** |
| Price Impact | 2.5% | 0.5% | **-2.0%** |
| Gas Used | 180,000 | 320,000 | -140,000 |
| Gas Cost (2000 gwei) | 0.36 PLS | 0.64 PLS | -0.28 PLS |
| **Net Gain** | - | **+200 token1** | **Worth it!** |

> **Result**: Even with 77% higher gas costs, the aggregator delivered 10.8% more tokens, making it clearly advantageous for this rebalance.

## Recommendations

1. **Use the Default**: Piteas aggregator is now the default for good reason - it provides better execution in most scenarios
2. **Only Opt-Out When Needed**: Add `swap_provider: "direct"` only if you have a specific reason (exceptional 9mm liquidity, avoiding external dependencies)
3. **Test in Dry Run**: Always test with `dry_run: true` first to see routing decisions
4. **Monitor Logs**: Check swap execution logs to verify you're getting good prices
5. **Check Liquidity**: Use https://app.piteas.io to preview swap routes before going live
6. **Adjust Slippage**: If aggregator swaps fail, you may need to increase `slippage_tolerance_bps`

## Questions?

- Piteas Documentation: https://docs.piteas.io
- 9mm Documentation: https://docs.9mm.pro
- Project Issues: https://github.com/TylerB007/ALM-For-9MM-Pulsechain/issues

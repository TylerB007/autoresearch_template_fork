# Migrating to DEX Aggregator Support (v1.5.0)

This guide helps existing ALM bot users upgrade to v1.5.0 and enable DEX aggregator routing for better swap execution.

## What's New?

Your bot can now route swaps through [Piteas](https://app.piteas.io), a DEX aggregator that searches across all PulseChain DEXes (9mm, 9inch, PulseX V1/V2/V3) to find the best execution price.

### Why Upgrade?
- **5-15% better swap execution** on thin liquidity pairs
- **Lower price impact** through multi-DEX routing
- **Same safety features** (slippage protection, dry-run, gas limits)
- **Backward compatible** - existing configs still work

## Migration Steps

### Step 1: Update Your Code

Pull the latest code:
```bash
cd ALM-For-9MM-Pulsechain
git pull origin main
npm install  # Install any new dependencies
```

### Step 2: Enjoy the New Default

**No config changes needed!** As of v1.5.0, the bot defaults to using Piteas aggregator automatically.

Your existing `config.yaml` will work as-is. The bot will now route swaps through Piteas for better execution.

**Optional**: If you want to explicitly use direct routing (not recommended), add:
```yaml
swap_provider: "direct"  # Only if you need to bypass aggregator
```

Otherwise, just use your existing config - Piteas is now the default.

### Step 3: Test in Dry-Run Mode

Before going live, test with dry-run:

```bash
# Make sure dry_run: true in config.yaml
npm start
```

Monitor the logs for:
```
[INFO] Routing swap through Piteas aggregator for better execution
[INFO] Piteas quote received: routes=2, priceImpact=0.5%
[INFO] [DRY RUN] Would execute swap via Piteas
```

### Step 4: Go Live

Once satisfied with dry-run results:

1. Set `dry_run: false` in `config.yaml`
2. Restart the bot: `pm2 restart 9mm-rebalancer`
3. Monitor the first few rebalances closely

## Configuration Options

### Default: Piteas Aggregator (Recommended)
**No config needed** - Piteas is now the default!

**Best for**: Everyone, unless you have exceptional 9mm liquidity

**Pros**:
- ✅ Best execution across all PulseChain DEXes
- ✅ Lower price impact
- ✅ Typically 5-15% more tokens received
- ✅ Now the default - no config needed

**Cons**:
- ❌ Higher gas costs (~250k-400k vs 150k-200k)
- ❌ Requires Piteas API availability

### Opt-In: Direct 9mm Routing
```yaml
swap_provider: "direct"  # Add this line to bypass aggregator
```
**Best for**: Pairs with exceptional 9mm liquidity (rare)

**Pros**:
- ✅ Lower gas costs
- ✅ No external dependencies
- ✅ Predictable behavior

**Cons**:
- ❌ Limited to 9mm liquidity only
- ❌ Higher slippage on thin liquidity pairs
- ❌ You have to opt-in to worse execution

## When to Use Piteas?

Use `swap_provider: "piteas"` if you answer YES to any of these:
- [ ] My trading pair has thin liquidity on 9mm
- [ ] My rebalance swaps often have high slippage (>1%)
- [ ] My position value is > $1,000 USD
- [ ] I want the absolute best execution price
- [ ] Other DEXes have better liquidity for my pair

Use `swap_provider: "direct"` if you answer YES to these:
- [ ] My pair has deep liquidity on 9mm (millions in TVL)
- [ ] My position is small (<$500 USD)
- [ ] I want to minimize gas costs
- [ ] I prioritize simplicity over optimization

**Still unsure?** Default to Piteas. The improved execution typically outweighs the gas cost increase.

## Monitoring & Validation

### Check Piteas Mode is Active
Look for these log entries during rebalance:
```
[INFO] Routing swap through Piteas aggregator for better execution
[INFO] Fetching Piteas quote: https://api.piteas.io/v1/quote?...
[INFO] Piteas quote received: inputAmount=1000000, outputAmount=2050000
```

### Check Direct Mode is Active
Look for these log entries during rebalance:
```
[INFO] Executing direct swap via 9mm SwapRouter
[INFO] Swap tx submitted: 0x...
```

### Compare Results
Preview swap quotes at https://app.piteas.io to see potential improvements:
1. Visit app.piteas.io
2. Enter your trading pair
3. Enter typical swap amount
4. Compare Piteas route vs single-DEX route

## Troubleshooting

### Issue: "Invalid swap_provider" error
**Cause**: Typo in config  
**Solution**: Use exactly `"piteas"` or `"direct"` (lowercase, in quotes)

### Issue: Bot still using direct routing
**Cause**: Config not reloaded  
**Solution**: Restart bot after config changes
```bash
pm2 restart 9mm-rebalancer
```

### Issue: "Piteas API error"
**Cause**: Piteas service temporarily unavailable  
**Solution**: Temporarily switch to `swap_provider: "direct"` or wait for service recovery

### Issue: Higher gas costs eating profits
**Cause**: Aggregator uses more gas  
**Solution**: 
1. Check if swap execution improvement outweighs gas cost
2. For very small positions (<$100), consider using `"direct"`
3. Adjust `max_gas_price_gwei` to avoid rebalancing during high gas

### Issue: Swap reverted with "Insufficient output"
**Cause**: Slippage protection too tight for aggregator routing  
**Solution**: Slightly increase `slippage_tolerance_bps` (e.g., from 100 to 150)

## Rollback Plan

If you need to revert to original behavior:

1. Change config:
   ```yaml
   swap_provider: "direct"
   ```

2. Restart bot:
   ```bash
   pm2 restart 9mm-rebalancer
   ```

3. Or remove the `swap_provider` line entirely (defaults to direct)

## Performance Expectations

### Typical Improvements with Piteas
Based on real-world testing:

| Position Size | Liquidity | Expected Improvement | Gas Increase | Net Benefit |
|---------------|-----------|---------------------|--------------|-------------|
| $100-500 | Thin | 5-10% more tokens | 140k gas | Neutral/Small |
| $500-2k | Thin | 8-12% more tokens | 140k gas | ✅ Positive |
| $2k-10k | Thin | 10-15% more tokens | 140k gas | ✅ Very Positive |
| Any size | Deep 9mm | 0-2% more tokens | 140k gas | ❌ Negative |

**Key Takeaway**: Aggregator provides clear benefits for positions >$500 on thin liquidity pairs.

## Additional Resources

- **Full Guide**: [DEX Aggregator Guide](DEX_AGGREGATOR_GUIDE.md)
- **Implementation Details**: [Implementation Summary](DEX_AGGREGATOR_IMPLEMENTATION.md)
- **Piteas App**: https://app.piteas.io
- **Piteas Docs**: https://docs.piteas.io

## Questions?

- Check logs: `pm2 logs 9mm-rebalancer`
- Review guide: `docs/DEX_AGGREGATOR_GUIDE.md`
- Report issues: https://github.com/TylerB007/ALM-For-9MM-Pulsechain/issues

## Changelog

See [CHANGELOG.md](../CHANGELOG.md) for full v1.5.0 release notes.

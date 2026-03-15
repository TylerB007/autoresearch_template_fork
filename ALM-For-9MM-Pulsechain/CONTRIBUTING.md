# Contributing Guide

Guidelines for developing and maintaining the 9mm V3 LP Auto-Rebalancer.

---

## 🎯 Project Focus

This project is specifically designed for:

- **PulseChain** (Chain ID 369) only
- **9mm V3 DEX** integration (Uniswap V3 fork with non-standard fee tiers)
- **Automated liquidity management** for concentrated liquidity positions
- **ESM (ECMAScript Modules)** with NodeNext resolution

**Out of Scope**:

- Multi-chain support (Ethereum, Polygon, Base, etc.)
- Other DEXs (PulseX, Uniswap V2/V4, Aerodrome)
- UI/frontend components
- Viem integration (uses ethers.js v6)

---

## 🛠️ Development Setup

### Prerequisites

- **Node.js**: >= 18.0.0 (v22.22.0 recommended)
- **npm**: >= 8.0.0
- **TypeScript**: 5.6.0
- **Git**: Latest version

### Local Setup

```bash
# Clone repository
git clone https://github.com/TylerB007/ALM-For-9MM-Pulsechain.git
cd ALM-For-9MM-Pulsechain

# Install dependencies
npm install

# Copy environment template
cp .env.example .env

# Edit .env with your private key (for testing)
nano .env

# Build TypeScript
npm run build

# Run in development mode
npm run dev

# Or run compiled version
npm run start
```

### Development Environment

```bash
# Watch mode (auto-rebuild on file changes)
npm run dev  # Uses tsx for hot reload

# Check position status (without starting main loop)
npm run status

# Build for production
npm run build

# Run tests (when available)
npm test
```

---

## 📁 Project Structure

```
src/
├── index.ts              # Entry point & monitoring loop
├── chain.ts              # RPC provider with fallback
├── contracts.ts          # Contract instances (ethers v6)
├── rebalancer.ts         # 7-step rebalance workflow
├── math.ts               # BigInt V3 tick/liquidity math
├── configLoader.ts       # YAML config loader
├── notifications.ts      # Telegram & Discord alerts
├── logger.ts             # Winston logging setup
├── status.ts             # Position status CLI tool
└── config/               # Static constants
    ├── index.ts          # Barrel export
    ├── pulsechain.ts     # Chain config
    ├── contracts.ts      # Contract addresses
    ├── fees.ts           # Fee tiers & tick spacing
    └── constants.ts      # Gas limits, selectors

abis/                     # Contract ABIs (JSON)
logs/                     # Application logs (gitignored)
dist/                     # Compiled JavaScript (gitignored)
```

---

## 🧪 Testing

### Manual Testing Checklist

Before deploying changes:

1. **Dry Run Mode**
   ```bash
   # Ensure dry_run: true in config.yaml
   npm run dev
   # Monitor for 5-10 minutes
   # Verify no errors in logs
   ```

2. **Position Monitoring**
   ```bash
   npm run status
   # Verify position data loads correctly
   ```

3. **RPC Failover**
   ```bash
   # Temporarily break primary RPC in .env
   npm run dev
   # Verify fallback to secondary RPC
   ```

4. **Graceful Shutdown**
   ```bash
   npm run dev
   # Press Ctrl+C
   # Verify "Shutting down gracefully" message
   ```

### Automated Testing (Future)

```bash
# Unit tests (to be implemented)
npm test

# Integration tests (to be implemented)
npm run test:integration

# E2E tests (to be implemented)
npm run test:e2e
```

---

## 🔧 Code Style

### TypeScript Guidelines

- **Use strict mode**: All files should have strict type checking
- **Prefer interfaces over types**: For object shapes
- **Use BigInt for on-chain values**: Never use Number for token amounts
- **Handle errors explicitly**: No silent failures
- **Log important events**: Use Winston logger, not console.log

### ESM Imports

**CRITICAL**: All imports must include `.js` extension (even for `.ts` files):

```typescript
// ✅ Correct
import { CONTRACTS } from './config/index.js';
import { rebalancePosition } from './rebalancer.js';

// ❌ Wrong (will fail at runtime)
import { CONTRACTS } from './config/index';
import { rebalancePosition } from './rebalancer';
```

This is required for NodeNext module resolution with ESM.

### Naming Conventions

- **Files**: camelCase (e.g., `configLoader.ts`, `rebalancer.ts`)
- **Variables**: camelCase (e.g., `tokenId`, `sqrtPriceX96`)
- **Constants**: UPPER_SNAKE_CASE (e.g., `MAX_GAS_PRICE`, `FEE_TIERS`)
- **Types/Interfaces**: PascalCase (e.g., `PositionConfig`, `RebalanceResult`)
- **Functions**: camelCase (e.g., `getTickSpacing`, `calculateNewRange`)

### Code Comments

```typescript
// Good: Explain WHY, not WHAT
// Use tick spacing 50 for 9mm MEDIUM tier (not 60 like Uniswap)
const tickSpacing = 50;

// Bad: Obvious comment
// Set tick spacing to 50
const tickSpacing = 50;
```

---

## 🔐 Security Rules

**All contributors must follow [`SECURITY.md`](SECURITY.md)** — it is the authoritative security reference for this project. Key rules:

### Secrets & Private Keys

- **Never commit** `.env` files (already in `.gitignore`)
- **Never log** or serialize private keys, bot tokens, or passwords
- **Never** pass the full `config` object to `JSON.stringify()` or logging
- **Use environment variables** for all sensitive data
- **Set file permissions**: `.env` should be `600` (read/write by owner only)

### Transaction Safety

- **Always validate** gas prices before submitting transactions
- **Use price-aware slippage** (via `sqrtPriceX96`) — never calculate from `amountIn`
- **TWAP check** before every rebalance to prevent flash-loan manipulation
- **Exact token approvals** only — never use `MaxUint256`
- **Explicit `gasLimit`** on all transactions (from `GAS_LIMITS` constants)
- **Test in dry-run mode** before enabling production mode

### API & Dashboard Security

- **All `/api/` routes** (except login) must use `requireAuth` middleware
- **CORS** must be restricted to dashboard origin — never `cors()` without `origin`
- **CSP** must remain enabled — never `contentSecurityPolicy: false`
- **Error responses** must be generic — log details server-side only
- **Redact RPC URLs** in API responses (show hostname only)

### RPC Security

- **Don't trust single RPC**: Use fallback providers
- **Validate chain ID**: Ensure connected to PulseChain (369)
- **Handle connection errors**: Graceful fallback, not crashes

---

## 📝 Making Changes

### Branch Strategy

```bash
# Create feature branch
git checkout -b feature/your-feature-name

# Make changes, commit regularly
git add .
git commit -m "feat: add new feature"

# Push to GitHub
git push origin feature/your-feature-name

# Create Pull Request on GitHub
```

### Commit Message Format

Follow [Conventional Commits](https://www.conventionalcommits.org/):

```
feat: add Discord notification support
fix: correct tick spacing calculation for MEDIUM tier
docs: update README with deployment instructions
chore: update dependencies
refactor: simplify rebalance logic
test: add unit tests for math functions
perf: optimize RPC call batching
```

### Pull Request Checklist

- [ ] Code builds without errors (`npm run build`)
- [ ] Tested locally in dry-run mode
- [ ] Updated relevant documentation (README, CHANGELOG, etc.)
- [ ] ESM imports use `.js` extensions
- [ ] TypeScript strict mode passes
- [ ] Follows code style guidelines

### Security Checklist (Required — see [SECURITY.md](SECURITY.md) Section 7)

- [ ] No secrets in source code (search for `PRIVATE_KEY`, `bot_token`, `JWT_SECRET`)
- [ ] No `JSON.stringify(config)` or similar that could leak `privateKey`
- [ ] All new API endpoints use `requireAuth` middleware
- [ ] API error responses are generic (no internal details or stack traces)
- [ ] New transaction calls include explicit `gasLimit`
- [ ] Token approvals use exact amounts (not `MaxUint256`)
- [ ] BigInt used for all on-chain values (no `Number` for token amounts)
- [ ] CORS, CSP, and helmet remain properly configured
- [ ] Tick spacing 50 used for MEDIUM tier (not 60)
- [ ] New dependencies are justified and `npm audit` passes

---

## 🚀 Deployment Process

### To Development/Staging

```bash
# Test locally first
npm run dev  # Monitor for 10+ minutes

# Build for production
npm run build

# Deploy to test VPS (if available)
scp -r dist/ user@test-vps:/path/to/app/
ssh user@test-vps "cd /path/to/app && pm2 restart app"
```

### To Production VPS

**⚠️ CRITICAL: Always test in staging first!**

```bash
# Option 1: Automated deployment script
ssh root@143.110.130.198
cd ~/9mm-rebalancer
bash scripts/deploy.sh

# Option 2: Manual step-by-step
ssh root@143.110.130.198
cd ~/9mm-rebalancer
git pull origin main
npm install
npm run build
pm2 restart 9mm-rebalancer
pm2 save

# Verify deployment
pm2 logs 9mm-rebalancer --lines 50
~/check-9mm-health.sh
```

See [DEPLOY_MANUAL.md](./DEPLOY_MANUAL.md) for detailed instructions.

---

## 🐛 Debugging

### Common Issues

1. **ESM Import Errors**
   - Ensure all imports have `.js` extension
   - Check `package.json` has `"type": "module"`
   - Verify `tsconfig.json` uses `"module": "NodeNext"`

2. **BigInt Serialization**
   - Use custom replacer for JSON.stringify:
     ```typescript
     JSON.stringify(obj, (_, v) => typeof v === 'bigint' ? v.toString() : v)
     ```

3. **Tick Spacing Errors**
   - 9mm MEDIUM tier uses spacing 50 (not 60!)
   - Always round ticks to nearest multiple of spacing

4. **RPC Connection Issues**
   - Check all 3 RPC URLs in `.env`
   - Test manually with curl (see [TROUBLESHOOTING.md](./TROUBLESHOOTING.md))

### Debug Logging

```typescript
import { logger } from './logger.js';

// Different log levels
logger.info('Normal operation');
logger.warn('Warning: high gas price');
logger.error('Error details', { error: err.message });
logger.debug('Detailed debugging info');  // Only in dev mode

// With structured data
logger.info('Position checked', {
  tokenId: 155181,
  tick: 280704,
  inRange: false
});
```

---

## 📊 Performance Optimization

### Gas Optimization

- **Batch operations** when possible (future improvement)
- **Avoid unnecessary approvals**: Check allowance first
- **Use multicall**: Combine multiple reads into one call (future)
- **Monitor gas prices**: Skip rebalance if too high

### RPC Optimization

- **Cache static data**: Contract addresses, fee tiers
- **Minimize calls**: Batch position checks (future)
- **Use events**: Watch for position updates instead of polling (future)
- **Implement exponential backoff**: On RPC failures

### Memory Management

- **Avoid memory leaks**: Clean up event listeners
- **Monitor heap usage**: PM2 will restart if > max_memory_restart
- **Use streams for large data**: If processing historical data

---

## 📚 Documentation Standards

### Code Documentation

```typescript
/**
 * Calculate new position range centered on current tick
 * @param currentTick - Current pool tick
 * @param widthTicks - Desired position width in ticks
 * @param tickSpacing - Tick spacing for this pool (e.g., 50 for MEDIUM tier)
 * @returns Object with tickLower and tickUpper, rounded to tick spacing
 */
export function calculateNewRange(
  currentTick: number,
  widthTicks: number,
  tickSpacing: number
): { tickLower: number; tickUpper: number } {
  // Implementation...
}
```

### README Updates

When adding features, update:
- [README.md](./README.md) - High-level overview
- [ARCHITECTURE.md](./ARCHITECTURE.md) - Technical details
- [CHANGELOG.md](./CHANGELOG.md) - Version history
- [STATUS.md](./STATUS.md) - Current deployment info

---

## 🎨 Adding New Features

### Example: Adding a New Strategy

1. **Define strategy interface** in `src/rebalancer.ts`:
   ```typescript
   interface StrategyParams {
     pulse: { width_ticks: number; trigger_distance_ticks: number };
     your_strategy: { param1: number; param2: number };
   }
   ```

2. **Implement strategy logic**:
   ```typescript
   function calculateRangeYourStrategy(
     currentTick: number,
     params: { param1: number; param2: number }
   ): { tickLower: number; tickUpper: number } {
     // Your logic here
   }
   ```

3. **Update config schema** in `config.yaml`:
   ```yaml
   positions:
     - token_id: 155181
       strategy: "your_strategy"
       params:
         param1: 100
         param2: 200
   ```

4. **Add tests** (future):
   ```typescript
   describe('Your Strategy', () => {
     it('should calculate range correctly', () => {
       const result = calculateRangeYourStrategy(280704, { param1: 100, param2: 200 });
       expect(result.tickLower).toBe(280650);
       expect(result.tickUpper).toBe(280750);
     });
   });
   ```

5. **Document** in [ARCHITECTURE.md](./ARCHITECTURE.md)

---

## 🔄 Maintenance

### Regular Updates

```bash
# Check for outdated dependencies
npm outdated

# Update dependencies (carefully!)
npm update

# Audit for vulnerabilities
npm audit
npm audit fix  # Only for non-breaking fixes

# Rebuild and test
npm run build
npm run dev  # Test locally
```

### Log Management

```bash
# On VPS
ssh root@143.110.130.198

# Check log sizes
du -sh ~/9mm-rebalancer/logs/*

# Manually rotate if needed
cd ~/9mm-rebalancer/logs
mv rebalancer.log rebalancer.log.old
pm2 restart 9mm-rebalancer

# PM2 logs
pm2 flush  # Clear old logs
```

---

## 📞 Getting Help

### Resources

- **Documentation**: Start with [README.md](./README.md)
- **Troubleshooting**: Check [TROUBLESHOOTING.md](./TROUBLESHOOTING.md)
- **Architecture**: Read [ARCHITECTURE.md](./ARCHITECTURE.md)
- **Status**: See [STATUS.md](./STATUS.md) for current deployment

### Asking Questions

When reporting issues, include:

1. **Environment**:
   - Node.js version (`node --version`)
   - npm version (`npm --version`)
   - OS and version

2. **Steps to reproduce**:
   - Exact commands run
   - Configuration used
   - Expected vs actual behavior

3. **Logs**:
   - Recent error logs (last 50-100 lines)
   - Full stack traces
   - Relevant config sections

4. **Context**:
   - What were you trying to do?
   - What changed recently?
   - Does it work in dry-run mode?

---

## 📜 License

By contributing, you agree that your contributions will be licensed under the same license as the project.

---

**Maintainer**: Tyler ([@TylerB007](https://github.com/TylerB007))
**Last Updated**: 2026-02-10

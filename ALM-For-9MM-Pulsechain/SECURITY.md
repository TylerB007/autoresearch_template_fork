# Security Policy & Development Rules

This document defines mandatory security rules for the 9mm V3 LP Auto-Rebalancer codebase. All contributors (human and AI) must follow these rules. Violations found during review must be fixed before merge.

**Last Updated:** 2026-02-26 (Security Audit v2 — Multi-Chain)
**See also:** `docs/security-audits/2026-02-10-security-audit.md`

---

## 1. Private Key & Secrets Handling

### Rules
- **NEVER** log, serialize, or return private keys in API responses
- **NEVER** store secrets (private keys, bot tokens, JWT secrets, passwords) in source code or `config.yaml`
- **Private key** must be stored in a `.secret` file (preferred) — NOT in `.env`. Environment variables are exposed in `/proc/PID/environ` to any root process. The `.secret` file is read by `loadPrivateKey()` in `src/configLoader.ts` and should have `chmod 600` permissions.
- **Other secrets** (bot tokens, JWT secret, dashboard password) live in `.env` and are loaded via `process.env`
- The `AppConfig.privateKey` is deleted after wallet creation in `setupAllChains()` (and legacy `setupChain()`) — do NOT re-add it
- The private key is captured in each `ChainContext`'s `withRetry` closure for provider rotation — this is an accepted trade-off; minimize the number of closures
- **NEVER** pass the full `config` object to `JSON.stringify()`, `logger.info()`, or API responses without explicit field selection
- **NEVER** serialize `MultiChainContext` — it transitively holds wallet instances with private key access

### Checks
- Before committing, search for: `privateKey`, `bot_token`, `JWT_SECRET`, `DASHBOARD_PASSWORD` — none should appear as string literals
- `.env`, `.secret`, `config.yaml`, and `.mcp.json` must remain in `.gitignore`

### VPS File Permissions
- `.secret` — `chmod 600` (owner read/write only)
- `.env` — `chmod 600`
- `config.yaml` — `chmod 600`
- `logs/` directory — `chmod 750`
- `logs/*.log` — `chmod 640`

---

## 2. API & Dashboard Security

### Authentication
- All `/api/` routes except `/api/auth/login` must use `requireAuth` middleware
- JWT tokens must include `issuer` and `audience` claims
- Dashboard passwords must be stored as bcrypt hashes in `.env` (plaintext triggers a startup warning)
- Login endpoint has strict rate limiting (5/min)

### CORS
- CORS must be restricted to the dashboard's own origin — never use `cors()` without an `origin` option
- The allowed origin is configured via `DASHBOARD_ORIGIN` environment variable

### Content Security Policy
- CSP must be enabled via helmet — never set `contentSecurityPolicy: false`
- Only `'self'` sources for scripts and connections
- `'unsafe-inline'` is permitted for styles only (Tailwind requirement)

### Error Responses
- API error responses must be generic — never include internal error messages, stack traces, or RPC URLs
- Log detailed errors server-side with `logger.error()`, return only safe messages to clients
- Example: `res.status(500).json({ error: 'Fee collection failed' })` — not the raw error

### Sensitive Data in Responses
- The `/api/config` endpoint must redact RPC URLs (show hostname only, mask paths)
- Never expose `telegram_bot_token`, `telegram_chat_id`, `DASHBOARD_PASSWORD`, or `JWT_SECRET`
- Wallet addresses in API responses are acceptable (they're public on-chain) but should be truncated in logs

---

## 3. Transaction Security

### Slippage Protection
- Swap `amountOutMinimum` must be calculated using the pool's `sqrtPriceX96` (price-aware)
- **NEVER** calculate slippage by subtracting from `amountIn` — this assumes 1:1 token price and provides no protection for pairs with different unit values
- `decreaseLiquidity` and `mint` must use `amountXMin` derived from expected amounts with slippage tolerance

### TWAP Validation
- Before executing a rebalance, compare spot tick against a 5-minute TWAP
- If the deviation exceeds the threshold (default 200bps), skip the rebalance and notify
- This prevents flash-loan price manipulation from triggering bad rebalances

### Token Approvals
- Always use exact approval amounts — **NEVER** use `MaxUint256` (infinite approvals)
- Use `ensureApproval()` which checks existing allowance before approving

### Gas Limits
- All on-chain transactions must specify explicit `gasLimit` from `GAS_LIMITS` constants
- Never rely on ethers gas estimation for critical transactions

### Contract Addresses
- Use hardcoded, verified contract addresses from `src/config/contracts.ts`
- Contract addresses are **NOT** overridable via `config.yaml` (removed for security)
- Any change to contract addresses requires a code change and review

---

## 4. Telegram Bot Security

### Authorization
- Commands are authorized by numeric chat ID only — never by username (usernames can be changed)
- Unauthorized messages must be silently ignored — do not respond (avoids confirming bot existence)
- Rate limit: max 10 commands per 60-second window

### State Persistence
- The `/disable` emergency stop flag is persisted to `.rebalancing-disabled` file
- This flag survives PM2 restarts — the operator's intent is always preserved
- `/enable` removes the flag file

### Information Leakage
- Wallet addresses in Telegram messages should be truncated (`0xAB12...CD34`)
- Never send private keys, bot tokens, or internal error details via Telegram

---

## 5. RPC & Chain Security

### Provider Configuration
- Chain ID is enforced via `staticNetwork` — ethers rejects mismatched chain IDs
- 3 fallback RPC providers per chain with automatic rotation after failures
- RPC URLs may contain API keys — treat them as secrets (redact in API responses, log hostname only)
- **NEVER** log `fallback.getCurrentUrl()` directly — extract hostname with `new URL(...).hostname` first

### Multi-Chain RPC Isolation
- Each chain MUST have its own set of RPC URLs — generic env vars (`RPC_URL_PRIMARY`) apply ONLY to the default chain
- Per-chain env vars use the pattern `RPC_URL_{chainId}_PRIMARY`, `RPC_URL_{chainId}_FALLBACK_1`, etc.
- **NEVER** allow a chain's RPC URLs to bleed to another chain — a PulseChain RPC used for Arbitrum would silently return wrong data

### Data Validation
- TWAP check provides defense against single-block price manipulation
- Ownership is verified before every rebalance attempt
- Cooldown period (default 300s) prevents rapid-fire rebalances

---

## 5a. Multi-Chain Security

### Chain Isolation
- Each chain MUST have its own `ChainContext` (provider, wallet, nonce tracker) — no shared mutable state between chains
- Each chain MUST have its own `ContractRegistry` — contract addresses differ between chains
- Composite keys (`{chainId}-{tokenId}`) MUST be used for all per-position state maps, lock files, and recovery files
- **NEVER** use bare `tokenId` as a map key — token IDs are only unique per NonfungiblePositionManager deployment

### Chain ID Fallback Rules
- When `posConfig.chain_id` is absent, ALWAYS fall back to `config.chain.chainId` (the configured default chain ID)
- **NEVER** use `?? 0` as a chainId fallback — chain ID 0 is not a valid EVM chain and produces orphaned state files/keys
- All code paths that construct composite keys MUST use the same fallback: `posConfig.chain_id ?? config.chain.chainId`

### Per-Chain File Paths
- Lock files: `.rebalance-lock-{chainId}-{tokenId}` — chain-scoped to prevent cross-chain interference
- Recovery state: `.recovery-state-{chainId}.json` — chain-scoped; legacy `.recovery-state.json` is backward-compat only
- Analytics: `analytics/chain-{chainId}/` subdirectories — backward-compat reads from flat `analytics/` if subdir doesn't exist
- **NEVER** unconditionally delete the legacy recovery file when clearing a chain-specific one — check contents first

### Cross-Chain Operation Safety
- Dashboard and Telegram on-chain operations (fee collection, rebalance, remove liquidity) MUST resolve the correct chain's contracts and provider per position
- **NEVER** use default chain contracts for operations on non-default chain positions — this sends transactions to wrong contract addresses
- The `MultiChainContext.getContracts(pos)` and `getChainById(resolveChainId(pos))` pattern MUST be used for all per-position on-chain calls

### Config Validation
- `reloadPositions()` MUST validate `chain_id` against `config.chains` — same validation as `loadConfig()`
- `reloadPositions()` MUST validate strategy names and parameter ranges — config hot-reload must not bypass startup validation
- Positions with duplicate `token_id + chain_id` MUST be rejected

---

## 6. Dependency Management

### Rules
- Run `npm audit` before each deployment — address critical/high vulnerabilities
- Do not add dependencies for single-use operations — prefer Node.js built-ins
- Type-only packages (`@types/*`) belong in `devDependencies`, not `dependencies`
- Remove unused dependencies promptly to reduce attack surface

---

## 7. Code Review Security Checklist

Before merging any PR, verify:

- [ ] No secrets in source code (search for `PRIVATE_KEY`, `bot_token`, etc.)
- [ ] All new API endpoints use `requireAuth` middleware
- [ ] API error responses are generic (no internal details)
- [ ] New transaction calls include `gasLimit`
- [ ] Token approvals use exact amounts (not MaxUint256)
- [ ] All imports use `.js` extensions (ESM requirement)
- [ ] BigInt used for all on-chain values (no Number for token amounts)
- [ ] New dependencies are justified and `npm audit` passes
- [ ] No `JSON.stringify(config)` or similar that could leak `privateKey`
- [ ] No `JSON.stringify(mctx)` or `logger.info(mctx)` that could leak wallet data
- [ ] CORS, CSP, and helmet remain properly configured
- [ ] Tick spacing 50 used for MEDIUM tier (not 60)
- [ ] All per-position on-chain calls resolve chain via `MultiChainContext` (not hardcoded default)
- [ ] All composite state keys use `posKey(chainId, tokenId)` with fallback `config.chain.chainId` (never `?? 0`)
- [ ] `reloadPositions()` validates `chain_id` and strategy the same as `loadConfig()`
- [ ] RPC URLs are not logged in full — hostname only
- [ ] Recovery and lock files use chain-scoped paths

---

## 8. Incident Response

If a security issue is discovered:

1. **Immediate**: Disable the bot via Telegram `/disable` or `pm2 stop 9mm-rebalancer`
2. **Assess**: Check wallet balances, position status, and recent transactions on PulseScan
3. **Contain**: If key compromise is suspected, transfer funds to a new wallet immediately
4. **Fix**: Apply the fix, test in dry-run mode, verify
5. **Document**: Update `STATUS.md` and this security audit log
6. **Rotate**: Rotate all secrets (private key, bot token, JWT secret, dashboard password)

---

## 9. Reporting Security Issues

This is a personal project. If you discover a vulnerability:
- Open a GitHub issue (public is fine for this personal project)
- Or contact the maintainer directly

---

*This document is the authoritative security reference for the project. When in conflict with other documentation, this document takes precedence.*

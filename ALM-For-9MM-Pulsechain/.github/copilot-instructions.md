# V3 LP Auto-Rebalancer Workspace Guidelines

These instructions define strict, non-negotiable patterns for working inside the multi-chain `ALM-For-9MM-Pulsechain` repository. You must enforce these automatically inside Claude, Copilot, or any other agent environment.

## Code Style & Typings
- **Strict ESM Requirements**: All TypeScript imports `MUST` include the `.js` extension, even for `.ts` files `(e.g., import { X } from './config.js';)`.
- **Zero Number Arithmetic**: You `MUST` use `BigInt(x)` instead of `Number(x)` for token arithmetic to prevent precision failure.
- **Explicit Gas Logging**: Never leave gas-bound functions without hardcoded limits sourced from `GAS_LIMITS` constants.

## Architecture & DEX Math
This project handles real funds across chains (PulseChain, Ethereum, Arbitrum). 
- **9MM V3 Divergence**: 9mm V3 on PulseChain is NOT Uniswap V3. You `MUST` use tick spacing `50` for `MEDIUM` tier (NOT `60`).
- **Resilience**: Review transience in `isTransientRpcError()` before classifying failure.

## Build and Test Commands
Before any code is committed, ensure it compiles and verifies against existing skills:
```bash
# Verify imports
node .claude/skills/esm-import-checker/scripts/check-esm.js

# Compile strictly
npm run build

# Web compile
cd src/web && npm run build
```

## Security & Project Conventions (Plan Mode & Dry Run)
- **Do Not Guess In Production**: If proposing changes to mathematical algorithms, routing, or Ethers contracts, you MUST invoke **Plan Mode**. Do not start writing directly.
- **Dry Run Verification**: Before proposing a PR for active transactions, you MUST edit `config.yaml` to ensure `dry_run: true`, and instruct the user to run `npm run dev`. Watch exactly 2 minutes of stdout to guarantee no reverts.
- **No Infinite Approvals**: Never use `MaxUint256` for approvals.
- **Price-Aware Slippage**: All slippage offsets must calculate against `sqrtPriceX96`.

## Parallel Workflows & Worktrees
- To ensure `config.yaml` with live production paths is never overwritten, if the user asks you to implement a secondary/feature branch, you MUST ask the user: "Would you like me to spawn `claude --worktree <feature-name>` to isolate our `config.yaml` and `.env` edits?"

## Integration Points
- See `CLAUDE.md` and `CONSTITUTIONAL_TRUTHS.md` for specific mathematical truths. If they are written there, they are immutable laws of this repo.
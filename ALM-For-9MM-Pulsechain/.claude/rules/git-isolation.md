---
paths:
  - "config.yaml"
  - ".env"
  - ".secret"
  - "ecosystem.config.cjs"
  - "src/**/*.ts"
---


# Bash & Grep Permissions

All bash requests (shell commands) and all grep (search) requests are explicitly permitted globally, regardless of branch or context. These actions are not subject to the isolation guardrail and may be executed freely.

# Git Worktree Production Isolation Guardrail

You are currently working in a repository that manages live, 24/7 automated on-chain V3 capital management (`ALM-For-9MM-Pulsechain`).

The `config.yaml` and `.env` files in the root `main` branch contain live API connections, exact strategy parameters, and secrets. **This root environment must not be casually disturbed during debugging.**

## Trigger Condition
If the user asks you to:
1. **Debug** an issue while you are on the `main` branch.
2. **Switch branches** (e.g., `git checkout <branch>`).
3. **Draft a new experimental feature** that modifies `config.yaml` endpoints.
4. Work on an isolated chain implementation while main is executing.
5. **Stash or reset** changes (e.g., `git stash`, `git reset`) that could discard local config state.

## Enforced Action
1. Stop processing the request immediately.
2. Formulate a prompt asking: 
   > "⚠️ **Isolation Warning**: Working on this feature directly in your main environment could destructively overwrite your live `config.yaml` or `.env` setups during branch checkouts. Would you like me to spawn `claude --worktree <feature-name>` to isolate our edits?"
3. Only proceed with the file edits / branch creation *after* the user confirms they either want to use a worktree, or explicitly acknowledge they want to modify the root `main` branch.
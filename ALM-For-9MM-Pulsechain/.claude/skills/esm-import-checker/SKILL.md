---
name: esm-import-checker
description: Validates all TypeScript imports to ensure they include the .js extension. Use this before creating PRs, running builds, or when code fails with "Cannot find module" errors.
---

# ESM Import Checker

This project uses `"type": "module"` with NodeNext module resolution. This means **EVERY** relative import in TypeScript must explicitly include the `.js` extension, even when importing `.ts` files.

## When to use this skill
- You have just written or modified code involving imports/exports.
- You are debugging a "Cannot find module" or `ERR_MODULE_NOT_FOUND` error.
- Setting up a commit or PR.

## Rules
- `import { X } from './utils'` ❌ (WRONG)
- `import { X } from './utils.js'` ✅ (CORRECT)
- `import { X } from '../config/index.js'` ✅ (CORRECT)

## Scope
The checker only scans **backend** Node.js code. It automatically skips `src/web/` (the React/Vite frontend) since bundlers resolve `.ts`/`.tsx` imports natively — `.js` extensions are only required for Node.js ESM runtime.

## How to verify
Run the bundled verification script from the root of the project:

```bash
node .claude/skills/esm-import-checker/scripts/check-esm.js
```

If it reports errors, fix each one individually by adding `.js` (or `/index.js` for directories) to the broken import statements.
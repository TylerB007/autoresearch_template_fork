---
name: institutional-ui-enforcer
description: Enforces the Institutional Design philosophy for frontend React components. Ensures compliance with Tailwind progressive breakpoints, typography rules, chain badges, and theme variables. Use when creating or modifying UI components.
---
# Institutional UI Enforcer

The Liquidity Dashboard follows a high-density, institutional-grade aesthetic.

## Design Checks

1. **Progressive Breakpoints:**
   - Grid and flex layouts MUST progressively scale. Do not jump breakpoints (e.g., from `sm` directly to `xl`).
   - Valid example: `grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4`
   - Invalid example: `grid grid-cols-1 xl:grid-cols-4`

2. **Typography & Metrics:**
   - All numeric outputs (prices, amounts, percentages) must include the classes: `font-mono tabular-nums`.
   - Structural text or UI column labels should typically be uppercase with `tracking-widest`.

3. **Styling Variables (No Hardcoded Colors):**
   - Ensure `text-theme-*`, `bg-theme-*`, and `border-theme-*` are exclusively used for colors to support Canonical Light/Dark modes.
   - Example: `<div className="bg-theme-bg-primary text-theme-text-primary" />`
   - Ensure conditional/composed classes are cleanly combined using `cn()` from `lib/utils.js`.

4. **TokenLogo Compliance (MANDATORY):**
   - The `<TokenLogo>` component defaults to `showChainBadge={true}`.
   - **NEVER** pass `showChainBadge={false}`. Every token must display its network context badge to avoid multi-chain confusion.
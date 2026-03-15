---
name: v3-math-verifier
description: Enforces strict Uniswap V3 financial math rules, specifically around the calculation of unclaimed fees (tokensOwed + feeGrowthInside) and the prohibition of native JS floats. Use whenever editing financial logic, calculating Impermanent Loss, or rendering fee data.
---
# V3 Math Verifier

Financial precision is critical in this dashboard. Never use native JavaScript floats for liquidity or fee calculations.

## Required Verification Steps

1. **Fee Calculation:**
   - **NEVER** calculate fees manually using just `tokensOwed0 / tokensOwed1`.
   - Uniswap V3 Unclaimed Fees = `tokensOwed` + uncollected `feeGrowthInside`.
   - **Action:** Ensure the UI components strictly reference `p.feesUSD` or `accumulatedFees` provided by the central `useLiquidityDataQuery` hook.

2. **Avoid Native Floats:**
   - Ensure `bignumber.js`, `Decimal.js`, or string-based decimal math libraries are used for financial calculations at the boundary and service layers.

3. **Formatting:**
   - All numerical outputs must use `utils/formatters.js` (e.g., `formatCurrency`, `formatPrice`, `formatPercent`). Never format numbers manually with `.toFixed()` unless implementing a specialized fallback outside of the root formatter utility.

4. **Logging Math Steps:**
   - Instead of using `console.log` to trace mathematical bugs, ensure you use the project's standardized logger:
   ```javascript
   import { createLogger } from '../utils/logger';
   const log = createLogger('MathLogic');
   log.debug('Calculating IL', { value: ilValue });
   ```
# Instruction: plan-mode

## Purpose
Require Plan Mode for any changes to mathematical algorithms, routing, or Ethers contract logic. Do not start writing code directly for these areas — always plan, review, and validate first.

## When to Use
- Proposing changes to math, routing, or contract interaction logic
- Editing `src/math.ts`, `src/rebalancer.ts`, `src/swap.ts`, or any Ethers contract code

## How to Use
- Pause and outline the intended change
- Review relevant sections in `CLAUDE.md` and `CONSTITUTIONAL_TRUTHS.md`
- Validate the plan with the user or a reviewer before implementation

## Example
> "I want to change the rebalance algorithm. Here is my plan: ..."

## Reference
- See `.github/copilot-instructions.md` and `CLAUDE.md` for Plan Mode enforcement.

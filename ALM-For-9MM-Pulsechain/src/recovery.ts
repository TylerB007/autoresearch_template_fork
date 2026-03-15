/**
 * Stranded funds recovery — detects and recovers tokens left in the wallet
 * after a failed rebalance (old position burned but new position not minted).
 *
 * Detection: checks for `.recovery-state.json` written by the rebalancer
 * before removing liquidity. If this file exists on startup, funds are stranded.
 *
 * Recovery: operator triggers `/recover confirm` via Telegram. Bot mints a new
 * position using the wallet's token balances and the original strategy params.
 */

import { existsSync, readFileSync, unlinkSync } from 'node:fs';
import type { ContractInstances } from './contracts.js';
import type { ChainContext } from './chain.js';
import type { AppConfig, RecoveryState, StrandedFundsReport, MintResult } from './types.js';
import { RECOVERY_STATE_PATH, recoveryStatePath, mintPosition, updateConfigTokenId, clearRecoveryState } from './rebalancer.js';
import { TOKENS } from './config/contracts.js';
import { CHAIN_REGISTRY, getChainConfig } from './config/chains.js';
import { verifyOwnership } from './position.js';
import { getPoolState } from './pool.js';
import { getPoolAddress } from './pool.js';
import { nearestUsableTick, calculateSwapAmount } from './math.js';
import { executeSwap } from './swap.js';
import { parseStrategy } from './strategy.js';
import { depositToGauge } from './gauges.js';
import { sendNotification } from './notifications.js';
import logger from './logger.js';

const DUST_THRESHOLD = 1000n; // Ignore balances below this (wei)

// Known token addresses (lowercase) allowed in recovery state — from ALL configured chains
const KNOWN_TOKEN_ADDRESSES = new Set<string>();
// Add PulseChain tokens (backward compat)
for (const addr of Object.values(TOKENS)) KNOWN_TOKEN_ADDRESSES.add(addr.toLowerCase());
// Add tokens from all chains in the registry
for (const chain of Object.values(CHAIN_REGISTRY)) {
  for (const addr of Object.values(chain.tokens)) KNOWN_TOKEN_ADDRESSES.add(addr.toLowerCase());
  // Also add wrapped native (may not be in tokens map)
  KNOWN_TOKEN_ADDRESSES.add(chain.wrappedNativeAddress.toLowerCase());
}

// Valid fee tiers from all chains (union of all feeTiers + DEX feeTiers)
const VALID_FEE_TIERS = new Set<number>();
for (const chain of Object.values(CHAIN_REGISTRY)) {
  for (const fee of Object.keys(chain.feeTiers)) VALID_FEE_TIERS.add(Number(fee));
  if (chain.dexes) {
    for (const dex of Object.values(chain.dexes)) {
      for (const fee of Object.keys(dex.feeTiers)) VALID_FEE_TIERS.add(Number(fee));
    }
  }
}

/**
 * Validate a parsed recovery state object against expected schema.
 * Throws if any field is missing, has wrong type, or contains unexpected values.
 * Guards against tampered files pointing at malicious ERC-20 contracts.
 */
function validateRecoveryState(s: unknown): asserts s is import('./types.js').RecoveryState {
  if (!s || typeof s !== 'object') throw new Error('Recovery state is not an object');
  const r = s as Record<string, unknown>;

  if (typeof r.oldTokenId !== 'number' || !Number.isInteger(r.oldTokenId) || r.oldTokenId <= 0)
    throw new Error(`Invalid oldTokenId: ${r.oldTokenId}`);

  if (typeof r.token0 !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(r.token0))
    throw new Error(`Invalid token0 address: ${r.token0}`);
  if (typeof r.token1 !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(r.token1))
    throw new Error(`Invalid token1 address: ${r.token1}`);

  const token0Known = KNOWN_TOKEN_ADDRESSES.has(r.token0.toLowerCase());
  const token1Known = KNOWN_TOKEN_ADDRESSES.has(r.token1.toLowerCase());
  if (!token0Known && !token1Known) {
    throw new Error(`Neither token0 ${r.token0} nor token1 ${r.token1} is a known token address — refusing recovery`);
  }
  if (!token0Known) {
    logger.warn(`Recovery: token0 ${r.token0} (${r.token0Symbol}) is not in chain registry — accepting (pair partner is known)`);
  }
  if (!token1Known) {
    logger.warn(`Recovery: token1 ${r.token1} (${r.token1Symbol}) is not in chain registry — accepting (pair partner is known)`);
  }

  if (typeof r.token0Symbol !== 'string' || r.token0Symbol.length === 0 || r.token0Symbol.length > 20)
    throw new Error(`Invalid token0Symbol: ${String(r.token0Symbol).slice(0, 30)}`);
  if (typeof r.token1Symbol !== 'string' || r.token1Symbol.length === 0 || r.token1Symbol.length > 20)
    throw new Error(`Invalid token1Symbol: ${String(r.token1Symbol).slice(0, 30)}`);

  if (typeof r.fee !== 'number' || !VALID_FEE_TIERS.has(r.fee))
    throw new Error(`Invalid fee tier: ${r.fee}`);
  if (typeof r.tickSpacing !== 'number' || r.tickSpacing <= 0)
    throw new Error(`Invalid tickSpacing: ${r.tickSpacing}`);
  if (typeof r.timestamp !== 'number' || r.timestamp <= 0)
    throw new Error(`Invalid timestamp: ${r.timestamp}`);

  // chainId is optional (legacy files omit it) but if present must be a positive integer
  if (r.chainId !== undefined && (typeof r.chainId !== 'number' || !Number.isInteger(r.chainId) || r.chainId <= 0))
    throw new Error(`Invalid chainId: ${r.chainId}`);

  // dex is optional (legacy files omit it) but if present must be a non-empty string
  if (r.dex !== undefined && (typeof r.dex !== 'string' || r.dex.length === 0 || r.dex.length > 50))
    throw new Error(`Invalid dex: ${String(r.dex).slice(0, 60)}`);

  // gauge_address is optional but if present must be a valid hex address
  if (r.gauge_address !== undefined) {
    if (typeof r.gauge_address !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(r.gauge_address))
      throw new Error(`Invalid gauge_address: ${r.gauge_address}`);
  }
}

/**
 * Check for stranded funds on startup.
 * Returns a report if recovery state file exists and wallet holds tokens.
 */
export async function detectStrandedFunds(
  contracts: ContractInstances,
  chain: ChainContext,
  chainId?: number,
): Promise<StrandedFundsReport | null> {
  // Check per-chain file first, then legacy file
  const perChainPath = chainId ? recoveryStatePath(chainId) : null;
  const statePath = (perChainPath && existsSync(perChainPath))
    ? perChainPath
    : existsSync(RECOVERY_STATE_PATH) ? RECOVERY_STATE_PATH : null;

  if (!statePath) {
    return null;
  }

  let recoveryState: RecoveryState;
  let parsedOldTokenId: number | undefined;
  try {
    const raw = readFileSync(statePath, 'utf-8');
    const parsed: unknown = JSON.parse(raw);
    // Extract oldTokenId before validation so we can use it for cleanup if validation fails
    if (parsed && typeof parsed === 'object') {
      const r = parsed as Record<string, unknown>;
      if (typeof r.oldTokenId === 'number') parsedOldTokenId = r.oldTokenId;
    }
    validateRecoveryState(parsed);
    recoveryState = parsed;
  } catch (error) {
    logger.error(`Failed to read or validate recovery state file: ${(error as Error).message}`);

    // Auto-cleanup: if we can identify the oldTokenId, check whether the NFT still
    // exists on-chain. If it's burned (CALL_EXCEPTION), this file is stale and safe
    // to delete. This prevents the error from repeating on every startup/cycle.
    if (parsedOldTokenId !== undefined) {
      try {
        await contracts.positionManager.ownerOf(parsedOldTokenId);
        // ownerOf succeeded — NFT still exists. Keep the file; manual inspection required.
        logger.warn(
          `Recovery state file failed validation but position #${parsedOldTokenId} still exists on-chain. ` +
          `File preserved — manual inspection required at: ${statePath}`,
        );
      } catch (ownerErr: unknown) {
        const ownerErrAny = ownerErr as { code?: string; data?: unknown };
        // Genuine burns have non-null revert data in the CALL_EXCEPTION.
        // Sonic RPC flakiness produces CALL_EXCEPTION with data=null — must NOT delete
        // the recovery file in that case or stranded funds become unrecoverable.
        const hasRevertData = ownerErrAny.data != null;
        if (ownerErrAny.code === 'CALL_EXCEPTION' && hasRevertData) {
          // Genuine ERC-721 revert: NFT is confirmed burned — stale file, safe to delete
          try {
            unlinkSync(statePath);
            logger.info(
              `Deleted stale recovery state file for burned position #${parsedOldTokenId}: ${statePath}`,
            );
          } catch (unlinkErr) {
            logger.warn(`Failed to delete stale recovery state file: ${unlinkErr}`);
          }
        } else {
          // Null-data CALL_EXCEPTION (Sonic RPC flakiness) or other transient error —
          // cannot confirm NFT state, preserve file to avoid losing stranded funds record.
          logger.warn(
            `Could not verify on-chain state of position #${parsedOldTokenId} ` +
            `(${ownerErrAny.code ?? 'error'}, data=${String(ownerErrAny.data ?? null)}). Recovery state file preserved.`,
          );
        }
      }
    }

    return null;
  }

  // Multi-chain: if the recovery state has a chainId, only process it on the matching chain.
  // Prevents the wrong chain from reading the legacy .recovery-state.json and clearing it.
  if (chainId && recoveryState.chainId && recoveryState.chainId !== chainId) {
    return null;
  }

  logger.warn('===========================================');
  logger.warn('  RECOVERY STATE DETECTED');
  logger.warn(`  Position #${recoveryState.oldTokenId} may have stranded funds`);
  logger.warn(`  Failed at: ${new Date(recoveryState.timestamp).toISOString()}`);
  logger.warn('===========================================');

  // Check wallet balances for the token pair
  try {
    const token0Contract = contracts.getERC20(recoveryState.token0);
    const token1Contract = contracts.getERC20(recoveryState.token1);
    const balance0 = BigInt(await token0Contract.balanceOf(chain.wallet.address));
    const balance1 = BigInt(await token1Contract.balanceOf(chain.wallet.address));

    if (balance0 < DUST_THRESHOLD && balance1 < DUST_THRESHOLD) {
      logger.info('Wallet has no significant token balances — recovery state may be stale. Clearing.');
      clearRecoveryState(chainId ?? recoveryState.chainId ?? 0);
      return null;
    }

    // Format balances in human-readable units for the log (use 18 decimals as safe default)
    const fmt0 = (Number(balance0) / 1e18).toFixed(6);
    const fmt1 = (Number(balance1) / 1e18).toFixed(6);
    logger.warn(
      `Stranded funds detected: ${recoveryState.token0Symbol}=${fmt0} (raw: ${balance0.toString()}), ` +
        `${recoveryState.token1Symbol}=${fmt1} (raw: ${balance1.toString()}). ` +
        `Run /recover to remint, or dismiss if amounts are too small to be worth gas cost.`,
    );

    return { recoveryState, balance0, balance1 };
  } catch (error) {
    logger.error(`Failed to check wallet balances during recovery detection: ${error}`);
    return null;
  }
}

/**
 * Calculate a centered tick range for recovery using the original strategy params.
 */
function calculateRecoveryRange(
  currentTick: number,
  tickSpacing: number,
  widthTicks: number,
): { tickLower: number; tickUpper: number } {
  const halfWidth = Math.floor(widthTicks / 2);
  const tickLower = nearestUsableTick(currentTick - halfWidth, tickSpacing);
  const tickUpper = nearestUsableTick(currentTick + halfWidth, tickSpacing);
  return { tickLower, tickUpper };
}

/**
 * Execute recovery: mint a new position with the wallet's token balances.
 * Called by the /recover confirm Telegram command.
 */
export async function recoverStrandedFunds(
  report: StrandedFundsReport,
  config: AppConfig,
  contracts: ContractInstances,
  chain: ChainContext,
): Promise<MintResult> {
  const { recoveryState, balance0, balance1 } = report;

  logger.info('Starting stranded funds recovery...');
  logger.info(`Token pair: ${recoveryState.token0Symbol}/${recoveryState.token1Symbol}`);
  logger.info(`Balances: ${balance0.toString()} / ${balance1.toString()}`);

  // Reset nonce tracker to chain state — after a failed rebalance the in-memory
  // nonce is often stale, causing "nonce too low" on the first recovery tx.
  await chain.nonceManager.resetNonce();
  logger.info('Recovery: nonce tracker reset to chain state');

  // Safety check: verify the old position was actually burned.
  // If the crash happened between writeRecoveryState and burn, the old position
  // still exists on-chain with full liquidity. Minting a new position would orphan it.
  const oldPositionExists = await verifyOwnership(
    recoveryState.oldTokenId,
    chain.wallet.address,
    contracts,
    chain,
  );
  if (oldPositionExists) {
    throw new Error(
      `ABORT RECOVERY: Old position #${recoveryState.oldTokenId} still exists on-chain (not burned). ` +
      `The wallet balance likely contains collected fees, not stranded liquidity. ` +
      `Clear recovery state manually or let the bot resume normal monitoring.`,
    );
  }

  // Get current pool state for tick/price info
  const poolAddress = await getPoolAddress(
    contracts,
    recoveryState.token0,
    recoveryState.token1,
    recoveryState.fee,
    chain,
  );
  const poolState = await getPoolState(poolAddress, contracts, chain);

  // Resolve width: preset strategies (e.g., "snuggle_up_300") store width_ticks=0
  // in params but encode the width in the strategy name suffix
  const { presetWidth } = parseStrategy(recoveryState.strategy);
  const widthTicks = presetWidth ?? recoveryState.params.width_ticks;

  if (widthTicks <= 0) {
    throw new Error(
      `Cannot recover: width_ticks is ${widthTicks} for strategy "${recoveryState.strategy}". ` +
      `Set width manually via /config or use a preset strategy (e.g., pulse_300).`,
    );
  }

  // Calculate new range using the resolved strategy width
  const { tickLower, tickUpper } = calculateRecoveryRange(
    poolState.currentTick,
    recoveryState.tickSpacing,
    widthTicks,
  );

  logger.info(`Recovery range: [${tickLower}, ${tickUpper}] centered on tick ${poolState.currentTick}`);

  // Swap if needed — wallet may have only one token after a failed rebalance
  let finalBalance0 = balance0;
  let finalBalance1 = balance1;

  const tickInRange = poolState.currentTick >= tickLower && poolState.currentTick < tickUpper;
  if (tickInRange && (balance0 === 0n || balance1 === 0n)) {
    logger.info('Recovery: wallet has only one token — swapping for balanced mint');

    const swapCalc = calculateSwapAmount(
      balance0, balance1,
      poolState.currentTick,
      tickLower, tickUpper,
      recoveryState.fee,
    );

    if (swapCalc.amountIn > 0n && !config.dry_run) {
      // Fresh pool state for swap slippage
      const swapPool = await getPoolState(poolAddress, contracts, chain);

      const tokenInAddr = swapCalc.tokenIn === 'token0'
        ? recoveryState.token0 : recoveryState.token1;
      const tokenOutAddr = swapCalc.tokenIn === 'token0'
        ? recoveryState.token1 : recoveryState.token0;
      const zeroForOne = swapCalc.tokenIn === 'token0';

      const swapResult = await executeSwap(
        tokenInAddr, tokenOutAddr,
        recoveryState.fee,
        swapCalc.amountIn,
        swapPool.sqrtPriceX96,
        zeroForOne,
        config, contracts, chain,
      );

      logger.info(`Recovery swap: ${swapResult.amountIn} ${swapCalc.tokenIn} -> ${swapResult.amountOut}`);

      // Re-read balances after swap
      const token0Contract = contracts.getERC20(recoveryState.token0);
      const token1Contract = contracts.getERC20(recoveryState.token1);
      finalBalance0 = BigInt(await token0Contract.balanceOf(chain.wallet.address));
      finalBalance1 = BigInt(await token1Contract.balanceOf(chain.wallet.address));
      logger.info(`Recovery post-swap: ${finalBalance0} / ${finalBalance1}`);
    }
  }

  // Auto-wrap native currency to wrapped token if either pool token is the wrapped native
  const recoveryChainConfig = getChainConfig(recoveryState.chainId ?? config.chain.chainId);
  const wrappedNativeAddr = recoveryChainConfig.wrappedNativeAddress.toLowerCase();
  const nativeSymbol = recoveryChainConfig.nativeCurrencySymbol;
  const wrappedSymbol = `W${nativeSymbol}`;
  const isToken0Native = recoveryState.token0.toLowerCase() === wrappedNativeAddr;
  const isToken1Native = recoveryState.token1.toLowerCase() === wrappedNativeAddr;
  if (isToken0Native || isToken1Native) {
    const { ethers } = await import('ethers');
    const nativeBalance = await chain.provider.getBalance(chain.wallet.address);
    const gasReserve = ethers.parseEther('10');
    const wrappableAmount = nativeBalance - gasReserve;
    if (wrappableAmount > ethers.parseEther('0.01')) {
      logger.info(
        `Recovery: Found ${ethers.formatEther(nativeBalance)} native ${nativeSymbol}. ` +
        `Auto-wrapping ${ethers.formatEther(wrappableAmount)} to ${wrappedSymbol}.`,
      );
      const wrappedNativeContract = contracts.getWrappedNative();
      const wrapNonce = await chain.nonceManager.getNextNonce();
      try {
        const wrapTx = await wrappedNativeContract.deposit({ value: wrappableAmount, gasLimit: 50000, nonce: wrapNonce });
        await wrapTx.wait();
        chain.nonceManager.confirmNonce(wrapNonce);
        logger.info(`Recovery wrap complete: ${ethers.formatEther(wrappableAmount)} ${nativeSymbol} → ${wrappedSymbol}`);
        // Re-read balances after wrap
        const token0Contract = contracts.getERC20(recoveryState.token0);
        const token1Contract = contracts.getERC20(recoveryState.token1);
        finalBalance0 = BigInt(await token0Contract.balanceOf(chain.wallet.address));
        finalBalance1 = BigInt(await token1Contract.balanceOf(chain.wallet.address));
        logger.info(`Recovery post-wrap: ${finalBalance0} / ${finalBalance1}`);
      } catch (wrapError) {
        await chain.nonceManager.resetNonce();
        logger.warn(`Recovery: Failed to auto-wrap native ${nativeSymbol} to ${wrappedSymbol}: ${wrapError}. Continuing.`);
      }
    }
  }

  if (config.dry_run) {
    logger.info('[DRY RUN] Would mint recovery position — no transaction executed');
    return {
      newTokenId: 0,
      liquidity: 0n,
      amount0: finalBalance0,
      amount1: finalBalance1,
      txHash: '0x_DRY_RUN_RECOVERY',
      gasUsed: 0n,
    };
  }

  // Mint the new position — the swap step above has already balanced token ratios,
  // so standard 2% slippage is sufficient.
  const mintResult = await mintPosition(
    recoveryState.token0,
    recoveryState.token1,
    recoveryState.fee,
    tickLower,
    tickUpper,
    finalBalance0,
    finalBalance1,
    config,
    contracts,
    chain,
    200,
  );

  // Find the matching position config and update config.yaml
  const posConfig = config.positions.find(
    (p) => p.token_id === recoveryState.oldTokenId,
  );
  if (posConfig) {
    updateConfigTokenId(recoveryState.oldTokenId, mintResult.newTokenId, posConfig);
  } else {
    logger.warn(
      `Could not find position config for token_id ${recoveryState.oldTokenId} — ` +
        `manually update config.yaml with new token_id: ${mintResult.newTokenId}`,
    );
  }

  // Clear recovery state
  clearRecoveryState(recoveryState.chainId ?? 0);

  // Re-stake in gauge if the original position was staked
  let gaugeRestaked = false;
  if (recoveryState.gauge_address && !config.dry_run) {
    try {
      const npmAddress = contracts.positionManager.target as string;
      const recoveryChainId = recoveryState.chainId ?? config.chain.chainId;
      await depositToGauge(mintResult.newTokenId, recoveryState.gauge_address, npmAddress, chain, recoveryChainId);
      gaugeRestaked = true;
      logger.info(`Recovered position ${mintResult.newTokenId} re-staked in gauge ${recoveryState.gauge_address}`);
    } catch (gaugeErr) {
      // Don't fail recovery if re-stake fails — position is safe, just not earning gauge rewards
      logger.warn(`Failed to re-stake recovered position ${mintResult.newTokenId} in gauge: ${gaugeErr}. ` +
        `Position is safe but not staked. Re-stake manually or it will be staked on next rebalance.`);
    }
  }

  const msg =
    `Recovery complete!\n` +
    `New position #${mintResult.newTokenId}\n` +
    `Range: [${tickLower}, ${tickUpper}]\n` +
    `Liquidity: ${mintResult.liquidity.toString()}` +
    (gaugeRestaked ? `\nRe-staked in gauge` : '');

  logger.info(msg);
  await sendNotification(msg, config);

  return mintResult;
}

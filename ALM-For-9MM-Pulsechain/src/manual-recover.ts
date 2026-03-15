/**
 * Manual recovery script — mints new positions from stranded wallet funds
 * after a failed rebalance where NFTs were burned but new positions not minted.
 *
 * Usage:
 *   npm run recover -- --dry-run     Show plan without executing
 *   npm run recover -- --confirm      Execute recovery transactions
 */

import { loadConfig } from './configLoader.js';
import { setupChain } from './chain.js';
import { createContracts } from './contracts.js';
import { getPoolAddress, getPoolState } from './pool.js';
import { tickToSqrtPriceX96, calculateSwapAmount, nearestUsableTick, tickToPrice } from './math.js';
import { executeSwap } from './swap.js';
import { mintPosition, updateConfigTokenId, clearRecoveryState } from './rebalancer.js';
import logger from './logger.js';

// Fee tier for HEX/WPLS — 9mm MEDIUM = 2500 (tick spacing 50)
const FEE = 2500;
const TICK_SPACING = 50;

/**
 * Validate that sqrtPriceX96 is consistent with currentTick (same logic as rebalancer).
 */
function validateSqrtPrice(sqrtPriceX96: bigint, currentTick: number, label: string): void {
  const lower = tickToSqrtPriceX96(currentTick - 1);
  const upper = tickToSqrtPriceX96(currentTick + 1);
  if (sqrtPriceX96 < lower || sqrtPriceX96 > upper) {
    const expected = tickToSqrtPriceX96(currentTick);
    throw new Error(
      `${label}: sqrtPriceX96 ${sqrtPriceX96} inconsistent with tick ${currentTick} ` +
      `(expected ~${expected}, range ${lower}–${upper}). Aborting.`,
    );
  }
}

/**
 * Parse strategy name to extract base strategy and preset width.
 */
function parseStrategy(strategy: string): { base: string; presetWidth: number | null } {
  const match = strategy.match(/^(.+?)_(\d+)$/);
  if (match) {
    return { base: match[1], presetWidth: parseInt(match[2]) };
  }
  return { base: strategy, presetWidth: null };
}

/**
 * Calculate tick range based on strategy and current tick.
 */
function calculateRange(
  strategy: string,
  currentTick: number,
  widthTicks: number,
  lowerRatioPercent?: number,
): { tickLower: number; tickUpper: number } {
  // Parse strategy to extract base and preset width
  const { base: baseStrategy, presetWidth } = parseStrategy(strategy);

  // If strategy has preset width, override widthTicks
  if (presetWidth !== null) {
    widthTicks = presetWidth;
  }

  switch (baseStrategy) {
    case 'snuggle_up': {
      const lowerRatio = lowerRatioPercent ?? 30;
      const lowerWidth = Math.floor((widthTicks * lowerRatio) / 100);
      const upperWidth = widthTicks - lowerWidth;
      return {
        tickLower: nearestUsableTick(currentTick - lowerWidth, TICK_SPACING),
        tickUpper: nearestUsableTick(currentTick + upperWidth, TICK_SPACING),
      };
    }
    case 'snuggle_down': {
      const upperRatio = lowerRatioPercent ?? 30;
      const upperWidth = Math.floor((widthTicks * upperRatio) / 100);
      const lowerWidth = widthTicks - upperWidth;
      return {
        tickLower: nearestUsableTick(currentTick - lowerWidth, TICK_SPACING),
        tickUpper: nearestUsableTick(currentTick + upperWidth, TICK_SPACING),
      };
    }
    case 'pulse':
    default: {
      const halfWidth = Math.floor(widthTicks / 2);
      return {
        tickLower: nearestUsableTick(currentTick - halfWidth, TICK_SPACING),
        tickUpper: nearestUsableTick(currentTick + halfWidth, TICK_SPACING),
      };
    }
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const confirm = args.includes('--confirm');

  if (!dryRun && !confirm) {
    console.log('Usage:');
    console.log('  npm run recover -- --dry-run     Show recovery plan without executing');
    console.log('  npm run recover -- --confirm      Execute recovery transactions');
    process.exit(0);
  }

  logger.info('===========================================');
  logger.info('  Manual Recovery Script');
  logger.info(`  Mode: ${dryRun ? 'DRY RUN (no transactions)' : 'LIVE — will execute transactions!'}`);
  logger.info('===========================================');

  // Load config + chain
  const config = loadConfig();
  const chain = setupChain(config);
  const contracts = createContracts(config, chain);

  const walletAddr = chain.wallet.address;
  logger.info(`Wallet: ${walletAddr}`);

  // Get pool state
  const positions = config.positions;
  if (positions.length === 0) {
    logger.error('No positions configured in config.yaml');
    process.exit(1);
  }

  // Use the first position's pair to find the pool (all positions are HEX/WPLS)
  // We need to know token0/token1 addresses — read from pool
  const poolAddress = await getPoolAddress(
    contracts,
    '0x2b591e99afE9f32eAA6214f7B7629768c40Eeb39', // HEX
    '0xA1077a294dDE1B09bB078844df40758a5D0f9a27', // WPLS
    FEE,
    chain,
  );
  const poolState = await getPoolState(poolAddress, contracts, chain);
  validateSqrtPrice(poolState.sqrtPriceX96, poolState.currentTick, 'pool-state');

  const price = tickToPrice(poolState.currentTick, 8, 18); // HEX=8 decimals, WPLS=18 decimals
  logger.info(`Pool: ${poolAddress}`);
  logger.info(`Current tick: ${poolState.currentTick}, price: ${price.toFixed(6)}`);
  logger.info(`sqrtPriceX96: ${poolState.sqrtPriceX96}`);

  // Check wallet balances
  const token0Contract = contracts.getERC20(poolState.token0);
  const token1Contract = contracts.getERC20(poolState.token1);
  const balance0 = BigInt(await token0Contract.balanceOf(walletAddr));
  const balance1 = BigInt(await token1Contract.balanceOf(walletAddr));

  const [symbol0, decimals0] = await Promise.all([
    token0Contract.symbol() as Promise<string>,
    token0Contract.decimals().then(Number) as Promise<number>,
  ]);
  const [symbol1, decimals1] = await Promise.all([
    token1Contract.symbol() as Promise<string>,
    token1Contract.decimals().then(Number) as Promise<number>,
  ]);

  const human0 = Number(balance0) / 10 ** decimals0;
  const human1 = Number(balance1) / 10 ** decimals1;
  logger.info(`Wallet ${symbol0}: ${human0.toFixed(decimals0 > 8 ? 4 : decimals0)} (${balance0} raw)`);
  logger.info(`Wallet ${symbol1}: ${human1.toFixed(decimals1 > 8 ? 4 : decimals1)} (${balance1} raw)`);

  if (balance0 === 0n && balance1 === 0n) {
    logger.error('Wallet has no token balances to recover. Nothing to do.');
    process.exit(1);
  }

  // Split funds between positions
  const numPositions = positions.length;
  logger.info(`\nRecovering ${numPositions} position(s):`);

  for (let i = 0; i < positions.length; i++) {
    const pos = positions[i];
    logger.info('-------------------------------------------');
    logger.info(`Position ${i + 1}/${numPositions}: token_id=${pos.token_id}, strategy=${pos.strategy}`);

    // Calculate this position's share of wallet funds
    const share0 = balance0 / BigInt(numPositions);
    const share1 = balance1 / BigInt(numPositions);
    // Last position gets remainder to avoid rounding loss
    const posAmount0 = i === numPositions - 1 ? balance0 - share0 * BigInt(numPositions - 1) : share0;
    const posAmount1 = i === numPositions - 1 ? balance1 - share1 * BigInt(numPositions - 1) : share1;

    logger.info(`Allocated: ${symbol0}=${posAmount0}, ${symbol1}=${posAmount1}`);

    // Calculate target range
    const { tickLower, tickUpper } = calculateRange(
      pos.strategy,
      poolState.currentTick,
      pos.params.width_ticks,
      pos.params.lower_ratio_percent,
    );
    logger.info(`Target range: [${tickLower}, ${tickUpper}] (strategy: ${pos.strategy}, width: ${pos.params.width_ticks})`);

    // Calculate swap needed
    const swapCalc = calculateSwapAmount(
      posAmount0,
      posAmount1,
      poolState.currentTick,
      tickLower,
      tickUpper,
      poolState.fee,
    );

    if (swapCalc.amountIn > 0n) {
      const swapToken = swapCalc.tokenIn === 'token0' ? symbol0 : symbol1;
      const swapOut = swapCalc.tokenIn === 'token0' ? symbol1 : symbol0;
      logger.info(`Swap needed: ${swapCalc.amountIn} ${swapToken} -> ${swapOut}`);
    } else {
      logger.info('No swap needed — ratio already matches target range');
    }

    if (dryRun) {
      logger.info('[DRY RUN] Would execute swap + mint for this position');
      continue;
    }

    // LIVE MODE — execute transactions
    logger.info('Executing swap...');

    if (swapCalc.amountIn > 0n) {
      // Re-fetch pool state right before swap for fresh sqrtPriceX96
      const freshPool = await getPoolState(poolAddress, contracts, chain);
      validateSqrtPrice(freshPool.sqrtPriceX96, freshPool.currentTick, 'pre-swap');

      const tokenInAddr = swapCalc.tokenIn === 'token0' ? poolState.token0 : poolState.token1;
      const tokenOutAddr = swapCalc.tokenIn === 'token0' ? poolState.token1 : poolState.token0;
      const zeroForOne = swapCalc.tokenIn === 'token0';

      const swapResult = await executeSwap(
        tokenInAddr,
        tokenOutAddr,
        poolState.fee,
        swapCalc.amountIn,
        freshPool.sqrtPriceX96,
        zeroForOne,
        config,
        contracts,
        chain,
      );
      logger.info(`Swap complete: ${swapResult.amountIn} in, ${swapResult.amountOut} out (tx: ${swapResult.txHash})`);
    }

    // Get post-swap balances for minting
    const mintAmount0 = BigInt(await token0Contract.balanceOf(walletAddr));
    const mintAmount1 = BigInt(await token1Contract.balanceOf(walletAddr));

    // For multi-position: only use this position's share
    const useAmount0 = i < numPositions - 1
      ? mintAmount0 / BigInt(numPositions - i)
      : mintAmount0;
    const useAmount1 = i < numPositions - 1
      ? mintAmount1 / BigInt(numPositions - i)
      : mintAmount1;

    logger.info(`Minting with: ${symbol0}=${useAmount0}, ${symbol1}=${useAmount1}`);

    // Use 9900 bps (99%) slippage for recovery mints — the pool determines the actual
    // ratio deposited based on current price and range. The excess stays in wallet.
    // Normal rebalance flow pre-computes exact ratios, but recovery has imbalanced amounts.
    const mintResult = await mintPosition(
      poolState.token0,
      poolState.token1,
      poolState.fee,
      tickLower,
      tickUpper,
      useAmount0,
      useAmount1,
      config,
      contracts,
      chain,
      9900, // override slippage for recovery
    );

    logger.info(`Minted position #${mintResult.newTokenId} (tx: ${mintResult.txHash})`);
    logger.info(`Liquidity: ${mintResult.liquidity}`);

    // Update config.yaml with new token ID
    updateConfigTokenId(pos.token_id, mintResult.newTokenId, pos);
    logger.info(`Updated config.yaml: ${pos.token_id} -> ${mintResult.newTokenId}`);
  }

  // Clear any leftover recovery state (use default chain for manual recovery CLI)
  clearRecoveryState(config.chain.chainId);

  logger.info('===========================================');
  logger.info(dryRun ? '  Dry run complete — no transactions executed' : '  Recovery complete!');
  logger.info('===========================================');
}

main().catch((error) => {
  logger.error(`Recovery failed: ${error}`);
  process.exit(1);
});

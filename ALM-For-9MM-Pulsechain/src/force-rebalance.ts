/**
 * One-time force rebalance script
 * Forces immediate rebalance of positions regardless of current range status
 *
 * Usage:
 *   npm run force-rebalance -- --dry-run     Show plan without executing
 *   npm run force-rebalance -- --confirm     Execute rebalance transactions
 */

import { loadConfig } from './configLoader.js';
import { setupChain } from './chain.js';
import { createContracts } from './contracts.js';
import { getPositionStatus } from './position.js';
import { getPoolAddress, getPoolState } from './pool.js';
import { tickToSqrtPriceX96, calculateSwapAmount, nearestUsableTick, tickToPrice, getAmountsForLiquidity } from './math.js';
import { executeSwap } from './swap.js';
import { mintPosition, updateConfigTokenId } from './rebalancer.js';
import logger from './logger.js';

// Fee tier for HEX/WPLS — 9mm MEDIUM = 2500 (tick spacing 50)
const FEE = 2500;
const TICK_SPACING = 50;

/**
 * Validate that sqrtPriceX96 is consistent with currentTick.
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
    console.log('  npm run force-rebalance -- --dry-run     Show plan without executing');
    console.log('  npm run force-rebalance -- --confirm      Execute rebalance transactions');
    process.exit(0);
  }

  logger.info('===========================================');
  logger.info('  Force Rebalance Script');
  logger.info(`  Mode: ${dryRun ? 'DRY RUN (no transactions)' : 'LIVE — will execute transactions!'}`);
  logger.info('===========================================');

  // Load config + chain
  const config = loadConfig();
  const chain = setupChain(config);
  const contracts = createContracts(config, chain);

  const walletAddr = chain.wallet.address;
  logger.info(`Wallet: ${walletAddr}`);

  for (const posConfig of config.positions) {
    logger.info('-------------------------------------------');
    logger.info(`Position #${posConfig.token_id} (${posConfig.strategy})`);

    // Get position details
    const position = await contracts.positionManager.positions(posConfig.token_id);
    const token0 = position.token0;
    const token1 = position.token1;
    const fee = Number(position.fee);

    // Get pool state
    const poolAddress = await getPoolAddress(contracts, token0, token1, fee, chain);
    const poolState = await getPoolState(poolAddress, contracts, chain);
    validateSqrtPrice(poolState.sqrtPriceX96, poolState.currentTick, 'pool-state');

    const currentTick = poolState.currentTick;
    const currentRange = [Number(position.tickLower), Number(position.tickUpper)];
    const currentWidth = currentRange[1] - currentRange[0];

    logger.info(`Current tick: ${currentTick}`);
    logger.info(`Current range: [${currentRange[0]}, ${currentRange[1]}] (${currentWidth} ticks)`);
    logger.info(`Pool: ${poolAddress}`);

    // Calculate new range based on config
    const { tickLower, tickUpper } = calculateRange(
      posConfig.strategy,
      currentTick,
      posConfig.params.width_ticks,
      posConfig.params.lower_ratio_percent,
    );
    const newWidth = tickUpper - tickLower;

    logger.info(`New range: [${tickLower}, ${tickUpper}] (${newWidth} ticks)`);
    logger.info(`Target width from config: ${posConfig.params.width_ticks} ticks`);

    if (dryRun) {
      logger.info('[DRY RUN] Would execute: decrease liquidity → collect → burn → swap → mint → update config');
      continue;
    }

    // ======================================================================
    // LIVE MODE — Execute decrease liquidity, collect, burn, swap, mint
    // ======================================================================

    logger.info('📉 Step 1/4: Decreasing liquidity to zero...');

    // Decrease liquidity to 0 (remove all liquidity from NFT)
    const liquidity = position.liquidity;
    const sqrtPriceAX96 = tickToSqrtPriceX96(Number(position.tickLower));
    const sqrtPriceBX96 = tickToSqrtPriceX96(Number(position.tickUpper));
    const expectedAmounts = getAmountsForLiquidity(poolState.sqrtPriceX96, sqrtPriceAX96, sqrtPriceBX96, liquidity);
    const slippageMul = 10000n - 200n; // 2% max slippage
    const decreaseParams = {
      tokenId: posConfig.token_id,
      liquidity: liquidity,
      amount0Min: (expectedAmounts.amount0 * slippageMul) / 10000n,
      amount1Min: (expectedAmounts.amount1 * slippageMul) / 10000n,
      deadline: BigInt(Math.floor(Date.now() / 1000) + 1200), // 20 minutes
    };
    const decreaseTx = await contracts.positionManager.decreaseLiquidity(decreaseParams, {
      gasLimit: 300000,
    });
    await decreaseTx.wait();
    logger.info(`   Decreased liquidity: ${liquidity} (tx: ${decreaseTx.hash})`);

    logger.info('💰 Step 2/4: Collecting tokens...');

    // Collect tokens from NFT
    const collectParams = {
      tokenId: posConfig.token_id,
      recipient: walletAddr,
      amount0Max: BigInt('0xffffffffffffffffffffffffffffffff'),
      amount1Max: BigInt('0xffffffffffffffffffffffffffffffff'),
    };
    const collectTx = await contracts.positionManager.collect(collectParams, {
      gasLimit: 200000,
    });
    await collectTx.wait();
    logger.info(`   Collected tokens (tx: ${collectTx.hash})`);

    logger.info('🔥 Step 3/4: Burning empty NFT...');

    // Burn the empty NFT
    const burnTx = await contracts.positionManager.burn(posConfig.token_id, {
      gasLimit: 150000,
    });
    await burnTx.wait();
    logger.info(`   Burned position #${posConfig.token_id} (tx: ${burnTx.hash})`);

    // Get wallet balances
    const token0Contract = contracts.getERC20(token0);
    const token1Contract = contracts.getERC20(token1);
    const balance0 = BigInt(await token0Contract.balanceOf(walletAddr));
    const balance1 = BigInt(await token1Contract.balanceOf(walletAddr));

    const [symbol0, symbol1] = await Promise.all([
      token0Contract.symbol() as Promise<string>,
      token1Contract.symbol() as Promise<string>,
    ]);

    logger.info(`   Wallet ${symbol0}: ${balance0}, ${symbol1}: ${balance1}`);

    // Calculate swap needed
    logger.info('💱 Step 4/6: Calculating swap to match new range...');

    const swapCalc = calculateSwapAmount(
      balance0,
      balance1,
      currentTick,
      tickLower,
      tickUpper,
      fee,
    );

    if (swapCalc.amountIn > 0n) {
      const swapToken = swapCalc.tokenIn === 'token0' ? symbol0 : symbol1;
      const swapOut = swapCalc.tokenIn === 'token0' ? symbol1 : symbol0;
      logger.info(`   Swap needed: ${swapCalc.amountIn} ${swapToken} -> ${swapOut}`);

      // Re-fetch pool state right before swap
      const freshPool = await getPoolState(poolAddress, contracts, chain);
      validateSqrtPrice(freshPool.sqrtPriceX96, freshPool.currentTick, 'pre-swap');

      const tokenInAddr = swapCalc.tokenIn === 'token0' ? token0 : token1;
      const tokenOutAddr = swapCalc.tokenIn === 'token0' ? token1 : token0;
      const zeroForOne = swapCalc.tokenIn === 'token0';

      const swapResult = await executeSwap(
        tokenInAddr,
        tokenOutAddr,
        fee,
        swapCalc.amountIn,
        freshPool.sqrtPriceX96,
        zeroForOne,
        config,
        contracts,
        chain,
      );
      logger.info(`   Swap complete: ${swapResult.amountIn} in, ${swapResult.amountOut} out (tx: ${swapResult.txHash})`);
    } else {
      logger.info('   No swap needed — ratio already matches target range');
    }

    // Get post-swap balances
    const mintAmount0 = BigInt(await token0Contract.balanceOf(walletAddr));
    const mintAmount1 = BigInt(await token1Contract.balanceOf(walletAddr));

    logger.info('🌱 Step 5/6: Minting new position...');
    logger.info(`   Amounts: ${symbol0}=${mintAmount0}, ${symbol1}=${mintAmount1}`);

    const mintResult = await mintPosition(
      token0,
      token1,
      fee,
      tickLower,
      tickUpper,
      mintAmount0,
      mintAmount1,
      config,
      contracts,
      chain,
      config.slippage_tolerance_bps,
    );

    logger.info(`   Minted position #${mintResult.newTokenId} (tx: ${mintResult.txHash})`);
    logger.info(`   Liquidity: ${mintResult.liquidity}`);

    logger.info('📝 Step 6/6: Updating config.yaml...');

    // Update config.yaml with new token ID
    updateConfigTokenId(posConfig.token_id, mintResult.newTokenId, posConfig);
    logger.info(`   Updated config.yaml: ${posConfig.token_id} -> ${mintResult.newTokenId}`);
  }

  logger.info('===========================================');
  logger.info(dryRun ? '  Dry run complete — no transactions executed' : '  ✅ Force rebalance complete!');
  logger.info('===========================================');
}

main().catch((error) => {
  logger.error(`Force rebalance failed: ${error}`);
  process.exit(1);
});

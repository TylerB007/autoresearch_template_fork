/**
 * Position status checker - displays detailed info about a position
 * Usage: npm run status <tokenId>
 */

import { loadConfig } from './configLoader.js';
import { setupChain } from './chain.js';
import { createContracts } from './contracts.js';
import { getPositionStatus } from './position.js';
import { tickToPrice } from './math.js';
import logger from './logger.js';

async function main(): Promise<void> {
  const tokenId = process.argv[2];
  if (!tokenId) {
    console.error('Usage: npm run status <tokenId>');
    console.error('Example: npm run status 155181');
    process.exit(1);
  }

  const config = loadConfig();
  const chain = setupChain(config);
  const contracts = createContracts(config, chain);

  logger.info(`Fetching status for position #${tokenId}...`);

  try {
    const status = await getPositionStatus(Number(tokenId), contracts, chain);
    const { position, pool, token0Info, token1Info, isInRange, tickDistance, amount0, amount1 } = status;

    // Calculate prices
    const currentPrice = tickToPrice(pool.currentTick, token0Info.decimals, token1Info.decimals);
    const lowerPrice = tickToPrice(position.tickLower, token0Info.decimals, token1Info.decimals);
    const upperPrice = tickToPrice(position.tickUpper, token0Info.decimals, token1Info.decimals);

    console.log('\n' + '='.repeat(60));
    console.log(`Position #${tokenId} Status Report`);
    console.log('='.repeat(60));

    console.log('\n📊 POOL INFORMATION');
    console.log(`  Pair: ${token0Info.symbol}/${token1Info.symbol}`);
    console.log(`  Pool: ${pool.address}`);
    console.log(`  Fee Tier: ${pool.fee / 10000}% (${pool.fee})`);
    console.log(`  Tick Spacing: ${pool.tickSpacing}`);

    console.log('\n💰 CURRENT PRICE');
    console.log(`  Tick: ${pool.currentTick}`);
    console.log(`  Price: ${currentPrice.toFixed(6)} ${token1Info.symbol} per ${token0Info.symbol}`);
    console.log(`  Inverse: ${(1/currentPrice).toFixed(6)} ${token0Info.symbol} per ${token1Info.symbol}`);

    console.log('\n📍 POSITION RANGE');
    console.log(`  Lower Tick: ${position.tickLower} (${lowerPrice.toFixed(6)})`);
    console.log(`  Upper Tick: ${position.tickUpper} (${upperPrice.toFixed(6)})`);
    console.log(`  Status: ${isInRange ? '✅ IN RANGE' : '❌ OUT OF RANGE'}`);
    if (!isInRange) {
      console.log(`  Distance: ${tickDistance} ticks beyond range`);
    }

    console.log('\n💎 LIQUIDITY');
    console.log(`  Liquidity: ${position.liquidity.toString()}`);
    console.log(`  ${token0Info.symbol}: ${(Number(amount0) / 10**token0Info.decimals).toFixed(6)}`);
    console.log(`  ${token1Info.symbol}: ${(Number(amount1) / 10**token1Info.decimals).toFixed(6)}`);

    console.log('\n🎁 UNCLAIMED FEES');
    const fees0 = Number(position.tokensOwed0) / 10**token0Info.decimals;
    const fees1 = Number(position.tokensOwed1) / 10**token1Info.decimals;
    console.log(`  ${token0Info.symbol}: ${fees0.toFixed(6)}`);
    console.log(`  ${token1Info.symbol}: ${fees1.toFixed(6)}`);
    if (fees0 > 0 || fees1 > 0) {
      console.log(`  💡 Tip: Fees are collected automatically during rebalance`);
    } else {
      console.log(`  (No fees accumulated yet)`);
    }

    console.log('\n' + '='.repeat(60) + '\n');

  } catch (error) {
    logger.error(`Failed to fetch position status: ${error}`);
    process.exit(1);
  }
}

main().catch((error) => {
  logger.error(`Fatal error: ${error}`);
  process.exit(1);
});

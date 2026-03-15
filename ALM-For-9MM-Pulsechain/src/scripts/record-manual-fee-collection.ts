/**
 * Utility to retroactively record a fee collection that wasn't captured in analytics
 * Usage: tsx src/scripts/record-manual-fee-collection.ts <tokenId> <txHash>
 */

import { loadConfig } from '../configLoader.js';
import { setupChainForConfig } from '../chain.js';
import { createContractRegistryForChain } from '../contracts.js';
import { getPositionStatus } from '../position.js';
import { writeAnalyticsRecord, chainStoragePath } from '../analytics/storage.js';
import { getTokenPrices } from '../server/services/priceService.js';
import logger from '../logger.js';

async function main() {
  const args = process.argv.slice(2);
  if (args.length < 2) {
    console.error('Usage: tsx src/scripts/record-manual-fee-collection.ts <tokenId> <txHash>');
    console.error('Example: tsx src/scripts/record-manual-fee-collection.ts 155284 0xabc123...');
    process.exit(1);
  }

  const tokenId = parseInt(args[0], 10);
  const txHash = args[1];

  if (isNaN(tokenId)) {
    console.error('Error: tokenId must be a number');
    process.exit(1);
  }

  if (!txHash.startsWith('0x') || txHash.length !== 66) {
    console.error('Error: txHash must be a valid transaction hash (0x + 64 hex chars)');
    process.exit(1);
  }

  console.log('\n📊 Recording Manual Fee Collection to Analytics');
  console.log('================================================');
  console.log(`Token ID: ${tokenId}`);
  console.log(`TX Hash:  ${txHash}`);

  const config = loadConfig();
  const pos = config.positions.find((position) => position.token_id === tokenId);
  const chainId = pos?.chain_id ?? config.chain.chainId;
  const chainConfig = config.chains.get(chainId);
  const rpcUrls = config.rpcUrlsByChain.get(chainId);
  if (!chainConfig || !rpcUrls) {
    console.error(`❌ No configured chain context found for token ${tokenId} on chain ${chainId}`);
    process.exit(1);
  }
  const chain = setupChainForConfig(chainConfig, rpcUrls, config.privateKey);
  const contracts = createContractRegistryForChain(chainConfig, chain).getForDex(pos?.dex);

  // Get transaction data
  console.log('\n📡 Fetching transaction data from blockchain...');
  const receipt = await chain.provider.getTransactionReceipt(txHash);
  if (!receipt) {
    console.error('❌ Transaction not found');
    process.exit(1);
  }

  console.log(`✓ Transaction found (block ${receipt.blockNumber})`);

  // Parse Collect event from logs
  let amount0 = 0n;
  let amount1 = 0n;
  const iface = contracts.positionManager.interface;
  
  for (const log of receipt.logs) {
    try {
      const parsed = iface.parseLog({
        topics: log.topics as string[],
        data: log.data,
      });
      if (parsed && parsed.name === 'Collect' && BigInt(parsed.args.tokenId) === BigInt(tokenId)) {
        amount0 = BigInt(parsed.args.amount0);
        amount1 = BigInt(parsed.args.amount1);
        console.log(`✓ Collect event found: ${amount0.toString()} / ${amount1.toString()}`);
        break;
      }
    } catch {
      // Not a position manager event
    }
  }

  if (amount0 === 0n && amount1 === 0n) {
    console.error(`❌ No Collect event found for token ${tokenId} in this transaction`);
    process.exit(1);
  }

  // Get position info
  console.log('\n📍 Fetching position details...');
  const status = await getPositionStatus(tokenId, contracts, chain);
  console.log(`✓ Position: ${status.token0Info.symbol}/${status.token1Info.symbol}`);

  // Get token prices
  console.log('\n💰 Fetching token prices...');
  const prices = await getTokenPrices([status.token0Info.address, status.token1Info.address], chainConfig.dexScreenerSlug);
  const priceUsd0 = prices.get(status.token0Info.address.toLowerCase()) ?? 0;
  const priceUsd1 = prices.get(status.token1Info.address.toLowerCase()) ?? 0;
  console.log(`✓ ${status.token0Info.symbol}: $${priceUsd0.toFixed(4)}`);
  console.log(`✓ ${status.token1Info.symbol}: $${priceUsd1.toFixed(4)}`);

  // Calculate values
  const d0 = status.token0Info.decimals;
  const d1 = status.token1Info.decimals;
  const valueUsd0 = (Number(amount0) / 10 ** d0) * priceUsd0;
  const valueUsd1 = (Number(amount1) / 10 ** d1) * priceUsd1;
  const totalValueUsd = valueUsd0 + valueUsd1;

  const gasUsed = BigInt(receipt.gasUsed);
  const gasPrice = BigInt(receipt.gasPrice ?? 0n);
  const gasCostPLS = Number(gasUsed * gasPrice) / 1e18;

  // Get block timestamp
  const block = await chain.provider.getBlock(receipt.blockNumber);
  const timestamp = block ? block.timestamp * 1000 : Date.now();

  console.log('\n💵 Fee Collection Summary:');
  console.log(`   ${status.token0Info.symbol}: ${(Number(amount0) / 10 ** d0).toFixed(6)} ($${valueUsd0.toFixed(2)})`);
  console.log(`   ${status.token1Info.symbol}: ${(Number(amount1) / 10 ** d1).toFixed(6)} ($${valueUsd1.toFixed(2)})`);
  console.log(`   Total Value: $${totalValueUsd.toFixed(2)}`);
  console.log(`   Gas Cost: ${gasCostPLS.toFixed(4)} PLS`);
  console.log(`   Date: ${new Date(timestamp).toISOString()}`);

  // Write to analytics
  const storagePath = chainStoragePath(config.analytics?.storage_path ?? './analytics', chainId);
  console.log(`\n💾 Writing to analytics storage: ${storagePath}`);
  
  await writeAnalyticsRecord({
    type: 'fee_collection',
    timestamp,
    data: {
      timestamp,
      tokenId,
      chainId,
      dex: pos?.dex,
      blockNumber: receipt.blockNumber,
      txHash,
      amount0,
      amount1,
      gasUsed,
      gasPrice,
      gasCostPLS,
      priceUsd0,
      priceUsd1,
      valueUsd0,
      valueUsd1,
      totalValueUsd,
      token0Symbol: status.token0Info.symbol,
      token1Symbol: status.token1Info.symbol,
      token0Decimals: d0,
      token1Decimals: d1,
    },
  }, storagePath);

  console.log('✅ Fee collection recorded successfully!');
  console.log('\nYou can now view this in the dashboard analytics page.');
}

main().catch((error) => {
  console.error('\n❌ Error:', error);
  process.exit(1);
});

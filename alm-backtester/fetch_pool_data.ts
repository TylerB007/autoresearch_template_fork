/**
 * Fetches real historical data for the HEX/WPLS 9mm V3 pool on PulseChain.
 *
 * Two data sources (tries both, uses whichever succeeds):
 *   1. GeckoTerminal OHLCV API — hourly candles → tick conversion (easy, no RPC needed)
 *   2. On-chain Swap events via RPC — exact tick data from contract logs (most accurate)
 *
 * Output: data/onchain-HEX-WPLS-2500bps.jsonl
 *
 * Usage: npx tsx fetch_pool_data.ts
 */

import { writeFileSync, mkdirSync, existsSync } from 'fs';
import { join } from 'path';

const POOL_ADDRESS = '0x8C357BE2cf2c1DE1c4Dca8aeA0Af1529f789976b';
const DATA_DIR = join(import.meta.dirname ?? '.', 'data');

// ===== Pool Constants (verified from on-chain + GeckoTerminal) =====
const POOL_INFO = {
  token0: { symbol: 'HEX', decimals: 8, address: '0x2b591e99afE9f32eAA6214f7B7629768c40Eeb39' },
  token1: { symbol: 'WPLS', decimals: 18, address: '0xA1077a294dDE1B09bB078844df40758a5D0f9a27' },
  fee: 2500,       // 0.25%
  tickSpacing: 50,
};

// ===== Utility: convert price ratio to V3 tick =====
// tick = log(price) / log(1.0001)
// price here is token1/token0 ratio (WPLS per HEX)
function priceToTick(price: number): number {
  return Math.round(Math.log(price) / Math.log(1.0001));
}

// ===== Method 1: GeckoTerminal OHLCV API =====
async function fetchFromGeckoTerminal(): Promise<Array<{ timestamp: number; tick: number }> | null> {
  console.log('=== Method 1: GeckoTerminal OHLCV API ===');

  const baseUrl = `https://api.geckoterminal.com/api/v2/networks/pulsechain/pools/${POOL_ADDRESS}/ohlcv`;
  const results: Array<{ timestamp: number; tick: number }> = [];

  // Fetch hourly candles in batches (API returns up to 1000 per call)
  // We'll get 30 days of hourly data = ~720 candles
  const timeframes = ['hour'];

  for (const tf of timeframes) {
    let beforeTimestamp: number | null = null;
    let totalFetched = 0;

    for (let page = 0; page < 5; page++) {
      let url = `${baseUrl}/${tf}?aggregate=1&limit=1000&currency=token`;
      if (beforeTimestamp) {
        url += `&before_timestamp=${beforeTimestamp}`;
      }

      console.log(`  Fetching ${tf} candles (page ${page + 1})...`);

      try {
        const response = await fetch(url, {
          headers: { 'Accept': 'application/json' },
          signal: AbortSignal.timeout(15000),
        });

        if (!response.ok) {
          console.log(`  API returned ${response.status}: ${response.statusText}`);
          if (response.status === 429) {
            console.log('  Rate limited. Waiting 60s...');
            await new Promise(r => setTimeout(r, 60000));
            continue;
          }
          break;
        }

        const data = await response.json() as any;
        const ohlcvList = data?.data?.attributes?.ohlcv_list;

        if (!ohlcvList || ohlcvList.length === 0) {
          console.log('  No more data available');
          break;
        }

        for (const candle of ohlcvList) {
          // candle = [timestamp, open, high, low, close, volume]
          const [ts, open, high, low, close] = candle;
          const avgPrice = (open + close) / 2;

          // Price from GeckoTerminal is token1/token0 (WPLS per HEX)
          // Convert to tick
          if (avgPrice > 0) {
            results.push({
              timestamp: Math.floor(ts),
              tick: priceToTick(avgPrice),
            });
          }
        }

        totalFetched += ohlcvList.length;
        console.log(`  Got ${ohlcvList.length} candles (total: ${totalFetched})`);

        // Get oldest timestamp for pagination
        const oldestTs = ohlcvList[ohlcvList.length - 1][0];
        beforeTimestamp = Math.floor(oldestTs);

        // Rate limit
        await new Promise(r => setTimeout(r, 2500)); // Stay under 30 req/min
      } catch (err: any) {
        console.log(`  Error: ${err.message}`);
        break;
      }
    }
  }

  if (results.length === 0) {
    console.log('  No data from GeckoTerminal');
    return null;
  }

  // Sort by timestamp ascending
  results.sort((a, b) => a.timestamp - b.timestamp);
  console.log(`  Total: ${results.length} data points`);

  return results;
}

// ===== Method 2: On-chain Swap Events via RPC =====
async function fetchFromRPC(): Promise<Array<{ timestamp: number; tick: number }> | null> {
  console.log('');
  console.log('=== Method 2: On-chain Swap Events via RPC ===');

  let createPublicClient: any, http: any, parseAbi: any;
  try {
    const viem = await import('viem');
    createPublicClient = viem.createPublicClient;
    http = viem.http;
    parseAbi = viem.parseAbi;
  } catch {
    console.log('  viem not installed. Run: npm install viem');
    return null;
  }

  const RPC_URLS = [
    'https://rpc-pulsechain.g4mm4.io',
    'https://rpc.pulsechain.com',
    'https://pulsechain-rpc.publicnode.com',
  ];

  for (const rpcUrl of RPC_URLS) {
    console.log(`  Trying RPC: ${rpcUrl}`);

    const client = createPublicClient({
      transport: http(rpcUrl, {
        retryCount: 2,
        timeout: 15000,
      }),
    });

    try {
      // Test connection
      const blockNumber = await client.getBlockNumber();
      console.log(`  Connected! Current block: ${blockNumber}`);

      const POOL_ABI = parseAbi([
        'function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)',
      ]);

      const SWAP_EVENT = parseAbi([
        'event Swap(address indexed sender, address indexed recipient, int256 amount0, int256 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick)',
      ]);

      // Get current tick
      const slot0 = await client.readContract({
        address: POOL_ADDRESS as `0x${string}`,
        abi: POOL_ABI,
        functionName: 'slot0',
      });
      console.log(`  Current tick: ${Number(slot0[1])}`);

      // Fetch last 30 days of swap events
      const BLOCKS_PER_DAY = 28800n;
      const DAYS = 30n;
      const startBlock = blockNumber - BLOCKS_PER_DAY * DAYS;
      const CHUNK_SIZE = 5000n;

      const results: Array<{ tick: number; blockNumber: bigint; timestamp: number }> = [];
      let currentFrom = startBlock;
      let chunkCount = 0;

      while (currentFrom <= blockNumber) {
        const currentTo = currentFrom + CHUNK_SIZE > blockNumber ? blockNumber : currentFrom + CHUNK_SIZE;
        chunkCount++;

        if (chunkCount % 20 === 1) {
          const progress = Number(currentFrom - startBlock) / Number(blockNumber - startBlock) * 100;
          console.log(`  Progress: ${progress.toFixed(0)}% (${results.length} events so far)`);
        }

        try {
          const logs = await client.getLogs({
            address: POOL_ADDRESS as `0x${string}`,
            event: SWAP_EVENT[0],
            fromBlock: currentFrom,
            toBlock: currentTo,
          });

          for (const log of logs) {
            const args = log.args as any;
            if (args.tick !== undefined) {
              results.push({
                tick: Number(args.tick),
                blockNumber: log.blockNumber!,
                timestamp: 0,
              });
            }
          }
        } catch (err: any) {
          if (err?.message?.includes('limit') || err?.message?.includes('range')) {
            // Reduce chunk size
            const mid = currentFrom + (currentTo - currentFrom) / 2n;
            const firstHalf = await fetchChunk(client, SWAP_EVENT[0], currentFrom, mid);
            const secondHalf = await fetchChunk(client, SWAP_EVENT[0], mid + 1n, currentTo);
            results.push(...firstHalf, ...secondHalf);
            currentFrom = currentTo + 1n;
            continue;
          }
          console.log(`  Chunk error: ${err.message?.slice(0, 60)}`);
          await new Promise(r => setTimeout(r, 2000));
          continue;
        }

        currentFrom = currentTo + 1n;
        if (chunkCount % 10 === 0) await new Promise(r => setTimeout(r, 200));
      }

      console.log(`  Found ${results.length} swap events`);

      if (results.length === 0) {
        continue; // Try next RPC
      }

      // Resolve timestamps
      console.log('  Resolving block timestamps...');
      const uniqueBlocks = [...new Set(results.map(r => r.blockNumber))].sort();
      const blockTimestamps = new Map<bigint, number>();

      for (let i = 0; i < uniqueBlocks.length; i += 50) {
        const batch = uniqueBlocks.slice(i, i + 50);
        const timestamps = await Promise.all(
          batch.map(bn => client.getBlock({ blockNumber: bn })
            .then((b: any) => Number(b.timestamp))
            .catch(() => 0))
        );
        batch.forEach((bn, idx) => blockTimestamps.set(bn, timestamps[idx]));
        if (i % 200 === 0 && i > 0) {
          console.log(`  Timestamps: ${i}/${uniqueBlocks.length}`);
        }
        await new Promise(r => setTimeout(r, 200));
      }

      return results
        .map(r => ({ timestamp: blockTimestamps.get(r.blockNumber) ?? 0, tick: r.tick }))
        .filter(r => r.timestamp > 0)
        .sort((a, b) => a.timestamp - b.timestamp);

    } catch (err: any) {
      console.log(`  Failed: ${err.message?.slice(0, 80)}`);
      continue;
    }
  }

  return null;
}

async function fetchChunk(client: any, event: any, from: bigint, to: bigint) {
  try {
    const logs = await client.getLogs({
      address: POOL_ADDRESS as `0x${string}`,
      event,
      fromBlock: from,
      toBlock: to,
    });
    return logs
      .filter((l: any) => l.args?.tick !== undefined)
      .map((l: any) => ({
        tick: Number(l.args.tick),
        blockNumber: l.blockNumber!,
        timestamp: 0,
      }));
  } catch {
    return [];
  }
}

// ===== Main =====
async function main() {
  console.log('=== HEX/WPLS Pool Data Fetcher ===');
  console.log(`Pool: ${POOL_ADDRESS}`);
  console.log(`Pair: ${POOL_INFO.token0.symbol}/${POOL_INFO.token1.symbol}`);
  console.log(`Fee: ${POOL_INFO.fee} bps (${POOL_INFO.fee / 10000}%)`);
  console.log('');

  // Try GeckoTerminal first (faster, no RPC needed)
  let data = await fetchFromGeckoTerminal();

  // Fall back to RPC if GeckoTerminal fails
  if (!data || data.length < 10) {
    data = await fetchFromRPC();
  }

  if (!data || data.length === 0) {
    console.error('');
    console.error('ERROR: Could not fetch data from any source.');
    console.error('Make sure you have internet access and can reach:');
    console.error('  - https://api.geckoterminal.com (OHLCV API)');
    console.error('  - https://rpc-pulsechain.g4mm4.io (PulseChain RPC)');
    process.exit(1);
  }

  // Ensure data directory exists
  if (!existsSync(DATA_DIR)) {
    mkdirSync(DATA_DIR, { recursive: true });
  }

  // Write to JSONL
  const fileName = `onchain-${POOL_INFO.token0.symbol}-${POOL_INFO.token1.symbol}-${POOL_INFO.fee}bps.jsonl`;
  const filePath = join(DATA_DIR, fileName);

  const lines = data.map(d => JSON.stringify({ timestamp: d.timestamp, tick: d.tick }));
  writeFileSync(filePath, lines.join('\n') + '\n');

  // Summary
  const tickRange = data.reduce(
    (acc, d) => ({ min: Math.min(acc.min, d.tick), max: Math.max(acc.max, d.tick) }),
    { min: Infinity, max: -Infinity }
  );

  const firstTime = new Date(data[0].timestamp * 1000).toISOString();
  const lastTime = new Date(data[data.length - 1].timestamp * 1000).toISOString();
  const durationDays = (data[data.length - 1].timestamp - data[0].timestamp) / 86400;

  console.log('');
  console.log('=== Data Written ===');
  console.log(`File: ${filePath}`);
  console.log(`Events: ${data.length}`);
  console.log(`Period: ${firstTime} → ${lastTime}`);
  console.log(`Duration: ${durationDays.toFixed(1)} days`);
  console.log(`Tick range: [${tickRange.min}, ${tickRange.max}] (spread: ${tickRange.max - tickRange.min})`);
  console.log('');
  console.log('Next: run `bash run.sh` to backtest against this data.');
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});

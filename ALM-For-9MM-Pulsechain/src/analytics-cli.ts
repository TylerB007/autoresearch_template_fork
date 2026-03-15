/**
 * CLI dashboard for viewing analytics data.
 * Usage:
 *   npm run analytics status [tokenId]
 *   npm run analytics history [tokenId]
 *   npm run analytics summary
 */

import { loadConfig } from './configLoader.js';
import { queryRebalances, querySnapshots } from './analytics/storage.js';
import { estimateTimeInRange } from './analytics/metrics.js';
import { buildExportReport } from './analytics/export.js';
import type { RebalanceAnalytics, PositionSnapshot } from './analytics/types.js';

const DIVIDER = '='.repeat(72);
const THIN_DIVIDER = '-'.repeat(72);

function formatDate(ts: number): string {
  return new Date(ts).toISOString().replace('T', ' ').slice(0, 19);
}

function formatDuration(seconds: number): string {
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  if (days > 0) return `${days}d ${hours}h ${mins}m`;
  if (hours > 0) return `${hours}h ${mins}m`;
  return `${mins}m`;
}

function formatBigint(value: bigint, decimals: number, maxDecimals = 6): string {
  const divisor = 10n ** BigInt(decimals);
  const whole = value / divisor;
  const frac = value % divisor;
  if (frac === 0n) return whole.toString();
  const fracStr = frac.toString().padStart(decimals, '0').slice(0, maxDecimals).replace(/0+$/, '');
  return `${whole}.${fracStr}`;
}

async function commandStatus(tokenId: number | undefined): Promise<void> {
  const config = loadConfig();
  const storagePath = config.analytics.storage_path;

  // If no tokenId given, use first position from config
  const resolvedTokenId = tokenId ?? config.positions[0]?.token_id;
  if (!resolvedTokenId) {
    console.log('No position token ID specified and none found in config.');
    return;
  }

  const rebalances = await queryRebalances(storagePath);
  const positionRebalances = rebalances.filter(
    (r) => r.oldTokenId === resolvedTokenId || r.newTokenId === resolvedTokenId,
  );

  const snapshots = await querySnapshots(storagePath, resolvedTokenId);
  const latestSnapshot = snapshots[snapshots.length - 1];

  console.log(DIVIDER);
  console.log(`  Position #${resolvedTokenId} Performance Report`);
  console.log(DIVIDER);

  // Find matching position config
  const posConfig = config.positions.find((p) => p.token_id === resolvedTokenId);

  console.log('\nPOSITION OVERVIEW');
  console.log(`  Strategy: ${posConfig?.strategy ?? 'unknown'}`);
  console.log(`  Total Rebalances: ${positionRebalances.length}`);

  if (latestSnapshot) {
    console.log(`  Last Snapshot: ${formatDate(latestSnapshot.timestamp)}`);
    console.log(`  Status: ${latestSnapshot.isInRange ? 'IN RANGE' : 'OUT OF RANGE'}`);
    console.log(`  Current Tick: ${latestSnapshot.currentTick}`);
    console.log(`  Range: [${latestSnapshot.tickLower}, ${latestSnapshot.tickUpper}]`);
    console.log(`  Tick Distance: ${latestSnapshot.tickDistance}`);
    console.log(`  Pair: ${latestSnapshot.token0Symbol}/${latestSnapshot.token1Symbol}`);
    console.log(`  Pool Fee: ${latestSnapshot.poolFee / 10000}%`);
  } else {
    console.log('  No snapshots available yet.');
  }

  if (positionRebalances.length > 0) {
    // Aggregate metrics
    let totalFees0 = 0n;
    let totalFees1 = 0n;
    let totalGasPLS = 0;
    let totalFeeAPR = 0;
    let totalIL = 0;
    let totalROI = 0;

    for (const r of positionRebalances) {
      totalFees0 += r.feesCollected0;
      totalFees1 += r.feesCollected1;
      totalGasPLS += r.totalGasCostPLS;
      totalFeeAPR += r.metrics.feeAPR;
      totalIL += r.metrics.impermanentLossPercent;
      totalROI += r.metrics.netROIPercent;
    }

    const avgFeeAPR = totalFeeAPR / positionRebalances.length;
    const avgIL = totalIL / positionRebalances.length;
    const avgROI = totalROI / positionRebalances.length;

    const decimals0 = latestSnapshot?.token0Decimals ?? positionRebalances[0].preSnapshot.token0Decimals;
    const decimals1 = latestSnapshot?.token1Decimals ?? positionRebalances[0].preSnapshot.token1Decimals;
    const sym0 = latestSnapshot?.token0Symbol ?? positionRebalances[0].preSnapshot.token0Symbol;
    const sym1 = latestSnapshot?.token1Symbol ?? positionRebalances[0].preSnapshot.token1Symbol;

    console.log('\nPERFORMANCE METRICS');
    console.log(`  Total Fees Earned: ${formatBigint(totalFees0, decimals0)} ${sym0}, ${formatBigint(totalFees1, decimals1)} ${sym1}`);
    console.log(`  Avg Fee APR: ${avgFeeAPR.toFixed(2)}%`);
    console.log(`  Total Gas Cost: ${totalGasPLS.toFixed(4)} PLS`);
    console.log(`  Avg Net ROI: ${avgROI.toFixed(2)}%`);

    console.log('\nIMPERMANENT LOSS');
    console.log(`  Avg IL: ${avgIL.toFixed(2)}%`);

    // Time in range from snapshots
    if (snapshots.length > 0) {
      const timeInRange = estimateTimeInRange(snapshots);
      console.log('\nCAPITAL EFFICIENCY');
      console.log(`  Time In Range: ${timeInRange.toFixed(1)}%`);
      console.log(`  Snapshots: ${snapshots.length}`);
    }

    // Last 5 rebalances
    const recent = positionRebalances.slice(-5);
    console.log('\nREBALANCE HISTORY (Last 5)');
    for (const r of recent) {
      const date = formatDate(r.timestamp);
      const range = `[${r.newTickLower}, ${r.newTickUpper}]`;
      const gas = r.totalGasCostPLS.toFixed(4);
      const fees0 = formatBigint(r.feesCollected0, r.preSnapshot.token0Decimals);
      console.log(`  ${date} | Range: ${range} | Gas: ${gas} PLS | Fees: ${fees0} ${sym0}`);
    }
  } else {
    console.log('\nNo rebalances recorded yet.');
  }

  console.log(`\n${DIVIDER}`);
}

async function commandHistory(tokenId: number | undefined): Promise<void> {
  const config = loadConfig();
  const storagePath = config.analytics.storage_path;

  const resolvedTokenId = tokenId ?? config.positions[0]?.token_id;
  if (!resolvedTokenId) {
    console.log('No position token ID specified.');
    return;
  }

  const rebalances = await queryRebalances(storagePath);
  const positionRebalances = rebalances.filter(
    (r) => r.oldTokenId === resolvedTokenId || r.newTokenId === resolvedTokenId,
  );

  console.log(DIVIDER);
  console.log(`  Rebalance History for Position #${resolvedTokenId}`);
  console.log(DIVIDER);

  if (positionRebalances.length === 0) {
    console.log('\nNo rebalances recorded.');
    console.log(DIVIDER);
    return;
  }

  for (const r of positionRebalances) {
    console.log(`\n${THIN_DIVIDER}`);
    console.log(`  Rebalance ID: ${r.rebalanceId}`);
    console.log(`  Time: ${formatDate(r.timestamp)}`);
    console.log(`  Position: #${r.oldTokenId} -> #${r.newTokenId}`);
    console.log(`  Strategy: ${r.strategy}`);
    console.log(`  Duration: ${formatDuration(r.metrics.durationSeconds)}`);
    console.log(`  New Range: [${r.newTickLower}, ${r.newTickUpper}]`);
    console.log(`  Fees Collected: ${formatBigint(r.feesCollected0, r.preSnapshot.token0Decimals)} ${r.preSnapshot.token0Symbol}, ${formatBigint(r.feesCollected1, r.preSnapshot.token1Decimals)} ${r.preSnapshot.token1Symbol}`);
    console.log(`  Gas Cost: ${r.totalGasCostPLS.toFixed(4)} PLS`);

    if (r.swap) {
      const configuredTolerance = r.swap.configuredSlippageBps;
      const realizedExecDelta = r.swap.realizedExecutionDeltaBps ?? r.swap.slippageBps;
      const swapSummary = `${formatBigint(r.swap.amountIn, r.swap.tokenIn === 'token0' ? r.preSnapshot.token0Decimals : r.preSnapshot.token1Decimals)} ${r.swap.tokenIn} -> ${formatBigint(r.swap.amountOut, r.swap.tokenIn === 'token0' ? r.preSnapshot.token1Decimals : r.preSnapshot.token0Decimals)} ${r.swap.tokenIn === 'token0' ? 'token1' : 'token0'}`;
      const toleranceSummary = configuredTolerance != null
        ? `, configured tolerance: ${configuredTolerance}bps`
        : '';
      console.log(`  Swap: ${swapSummary} (realized exec delta: ${realizedExecDelta}bps${toleranceSummary})`);
    }

    console.log(`  Metrics:`);
    console.log(`    Fee APR: ${r.metrics.feeAPR.toFixed(2)}%`);
    console.log(`    IL: ${r.metrics.impermanentLossPercent.toFixed(2)}%`);
    console.log(`    Net ROI: ${r.metrics.netROIPercent.toFixed(2)}%`);
    console.log(`    Capital Efficiency: ${r.metrics.capitalEfficiencyRatio.toFixed(1)}x`);
    const fullExecutionCostUsd =
      typeof r.gasCostUsd === 'number'
        ? r.gasCostUsd + (r.swapFrictionUsd ?? 0) + (r.dustUsd ?? 0)
        : null;
    const feesToExecutionCostRatio =
      fullExecutionCostUsd !== null && typeof r.feesCollectedUsd === 'number'
        ? fullExecutionCostUsd > 0
          ? r.feesCollectedUsd / fullExecutionCostUsd
          : r.feesCollectedUsd > 0 ? Infinity : 0
        : r.metrics.feesToCostRatio;
    console.log(`    Fees/Full Exec Cost: ${feesToExecutionCostRatio === Infinity ? 'Infinity' : feesToExecutionCostRatio.toFixed(2)}x`);

    // Gas breakdown
    console.log(`  Gas Breakdown:`);
    console.log(`    Collect Fees: ${r.gasUsed.collectFees.toString()}`);
    console.log(`    Decrease Liq: ${r.gasUsed.decreaseLiquidity.toString()}`);
    console.log(`    Collect Tokens: ${r.gasUsed.collectTokens.toString()}`);
    console.log(`    Burn: ${r.gasUsed.burn.toString()}`);
    console.log(`    Swap: ${r.gasUsed.swap.toString()}`);
    console.log(`    Mint: ${r.gasUsed.mint.toString()}`);
    console.log(`    Total: ${r.gasUsed.total.toString()}`);
  }

  console.log(`\n${DIVIDER}`);
}

async function commandSummary(): Promise<void> {
  const config = loadConfig();
  const storagePath = config.analytics.storage_path;

  const rebalances = await queryRebalances(storagePath);
  const snapshots = await querySnapshots(storagePath);

  console.log(DIVIDER);
  console.log('  9mm V3 Rebalancer - Analytics Summary');
  console.log(DIVIDER);

  console.log(`\n  Config: ${config.positions.length} position(s), strategy: ${config.positions.map((p) => p.strategy).join(', ')}`);
  console.log(`  Analytics storage: ${storagePath}`);
  console.log(`  Total rebalances recorded: ${rebalances.length}`);
  console.log(`  Total snapshots recorded: ${snapshots.length}`);

  if (rebalances.length === 0) {
    console.log('\n  No rebalance data available yet.');
    console.log(`\n${DIVIDER}`);
    return;
  }

  // Aggregate across all positions
  let totalGasPLS = 0;
  let totalFees0 = 0n;
  let totalFees1 = 0n;
  let totalFeeAPR = 0;
  let totalIL = 0;
  let totalROI = 0;

  const positionIds = new Set<number>();

  for (const r of rebalances) {
    positionIds.add(r.oldTokenId);
    positionIds.add(r.newTokenId);
    totalGasPLS += r.totalGasCostPLS;
    totalFees0 += r.feesCollected0;
    totalFees1 += r.feesCollected1;
    totalFeeAPR += r.metrics.feeAPR;
    totalIL += r.metrics.impermanentLossPercent;
    totalROI += r.metrics.netROIPercent;
  }

  const avgFeeAPR = totalFeeAPR / rebalances.length;
  const avgIL = totalIL / rebalances.length;
  const avgROI = totalROI / rebalances.length;
  const avgGasCost = totalGasPLS / rebalances.length;

  const firstRebalance = rebalances[0];
  const sym0 = firstRebalance.preSnapshot.token0Symbol;
  const sym1 = firstRebalance.preSnapshot.token1Symbol;
  const dec0 = firstRebalance.preSnapshot.token0Decimals;
  const dec1 = firstRebalance.preSnapshot.token1Decimals;

  // Time range
  const earliest = rebalances[0].timestamp;
  const latest = rebalances[rebalances.length - 1].timestamp;
  const periodDays = (latest - earliest) / 86400000;

  console.log('\nOVERALL PERFORMANCE');
  console.log(`  Period: ${formatDate(earliest)} to ${formatDate(latest)} (${periodDays.toFixed(1)} days)`);
  console.log(`  Positions Tracked: ${positionIds.size}`);
  console.log(`  Total Rebalances: ${rebalances.length}`);
  if (periodDays > 0) {
    console.log(`  Avg Rebalance Frequency: ${(periodDays / rebalances.length).toFixed(1)} days`);
  }

  console.log('\nFEES & COSTS');
  console.log(`  Total Fees: ${formatBigint(totalFees0, dec0)} ${sym0}, ${formatBigint(totalFees1, dec1)} ${sym1}`);
  console.log(`  Total Gas: ${totalGasPLS.toFixed(4)} PLS`);
  console.log(`  Avg Gas/Rebalance: ${avgGasCost.toFixed(4)} PLS`);

  console.log('\nMETRICS (Averages)');
  console.log(`  Fee APR: ${avgFeeAPR.toFixed(2)}%`);
  console.log(`  Impermanent Loss: ${avgIL.toFixed(2)}%`);
  console.log(`  Net ROI: ${avgROI.toFixed(2)}%`);

  // Time in range from snapshots
  if (snapshots.length > 0) {
    const timeInRange = estimateTimeInRange(snapshots);
    console.log(`  Time In Range: ${timeInRange.toFixed(1)}% (from ${snapshots.length} snapshots)`);
  }

  // Strategy breakdown
  const strategyMap = new Map<string, RebalanceAnalytics[]>();
  for (const r of rebalances) {
    const existing = strategyMap.get(r.strategy) ?? [];
    existing.push(r);
    strategyMap.set(r.strategy, existing);
  }

  if (strategyMap.size > 1) {
    console.log('\nSTRATEGY COMPARISON');
    for (const [strategy, records] of strategyMap) {
      const avgAPR = records.reduce((s, r) => s + r.metrics.feeAPR, 0) / records.length;
      const avgILs = records.reduce((s, r) => s + r.metrics.impermanentLossPercent, 0) / records.length;
      const avgROIs = records.reduce((s, r) => s + r.metrics.netROIPercent, 0) / records.length;
      const totalGas = records.reduce((s, r) => s + r.totalGasCostPLS, 0);
      console.log(`  ${strategy}: ${records.length} rebalances | APR: ${avgAPR.toFixed(2)}% | IL: ${avgILs.toFixed(2)}% | ROI: ${avgROIs.toFixed(2)}% | Gas: ${totalGas.toFixed(4)} PLS`);
    }
  }

  console.log(`\n${DIVIDER}`);
}

// Main CLI entry point
async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const command = args[0] ?? 'summary';
  const tokenIdArg = args[1] ? parseInt(args[1], 10) : undefined;

  try {
    switch (command) {
      case 'status':
        await commandStatus(tokenIdArg);
        break;
      case 'history':
        await commandHistory(tokenIdArg);
        break;
      case 'summary':
        await commandSummary();
        break;
      case 'export': {
        const daysArg = args.find((a) => a.startsWith('--days='));
        const days = daysArg ? parseInt(daysArg.split('=')[1], 10) : 30;
        const config = loadConfig();
        const storagePath = config.analytics.storage_path;
        const report = await buildExportReport(storagePath, { days });
        const bigIntReplacer = (_: string, v: unknown) => typeof v === 'bigint' ? v.toString() : v;
        console.log(JSON.stringify(report, bigIntReplacer, 2));
        break;
      }
      default:
        console.log('9mm V3 Rebalancer Analytics CLI');
        console.log('');
        console.log('Usage:');
        console.log('  npm run analytics summary            Overall performance');
        console.log('  npm run analytics status [tokenId]   Position status');
        console.log('  npm run analytics history [tokenId]  Rebalance timeline');
        console.log('  npm run analytics export [--days=30] Export JSON for LLM analysis');
        console.log('');
        console.log('If tokenId is omitted, uses the first position from config.');
    }
  } catch (error) {
    console.error(`Error: ${error instanceof Error ? error.message : error}`);
    process.exit(1);
  }
}

main();

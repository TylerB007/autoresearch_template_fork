import { useState, useEffect, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { getPositionAnalytics, getDailyEarnings, downloadFile, formatUsd, type PositionAnalytics as PositionAnalyticsData, type DailyEarning } from '../api/client';
import { REFRESH_EVENT } from '../components/Navbar';
import MetricCard from '../components/MetricCard';
import { MetricCardSkeleton } from '../components/Skeleton';
import FeeChart from '../components/charts/FeeChart';
import ILChart from '../components/charts/ILChart';
import DailyEarningsChart from '../components/charts/DailyEarningsChart';
import { useChain } from '../context/ChainContext';

const healthColors: Record<string, string> = {
  excellent: 'bg-green-500',
  good: 'bg-blue-500',
  fair: 'bg-yellow-500',
  poor: 'bg-red-500',
};

const healthTextColors: Record<string, string> = {
  excellent: 'text-green-400',
  good: 'text-blue-400',
  fair: 'text-yellow-400',
  poor: 'text-red-400',
};

function formatSignedUsd(value: number | null | undefined): string {
  if (value == null) return '—';
  return `${value >= 0 ? '+' : ''}${formatUsd(value)}`;
}

function formatSignedPercent(value: number | null | undefined): string {
  if (value == null) return '—';
  return `${value >= 0 ? '+' : ''}${value.toFixed(2)}%`;
}

function trustTone(trust: string): string {
  switch (trust) {
    case 'exact':
    case 'event_time_exact':
      return 'text-green-400';
    case 'backfilled':
      return 'text-blue-400';
    case 'estimated':
    case 'approximate':
      return 'text-yellow-400';
    default:
      return 'text-red-400';
  }
}

export default function PositionAnalytics() {
  const { tokenId } = useParams<{ tokenId: string }>();
  const navigate = useNavigate();
  const { txUrl } = useChain();
  const [data, setData] = useState<PositionAnalyticsData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [earningsData, setEarningsData] = useState<DailyEarning[]>([]);

  const refreshData = useCallback(() => {
    if (!tokenId) return;
    setLoading(true);
    getPositionAnalytics(Number(tokenId))
      .then(setData)
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
    getDailyEarnings(Number(tokenId))
      .then(setEarningsData)
      .catch(() => {});
  }, [tokenId]);

  useEffect(() => {
    refreshData();
  }, [refreshData]);

  useEffect(() => {
    window.addEventListener(REFRESH_EVENT, refreshData);
    return () => window.removeEventListener(REFRESH_EVENT, refreshData);
  }, [refreshData]);

  if (loading) {
    return (
      <div className="mx-auto max-w-7xl space-y-6 px-4 py-6 sm:px-6 lg:px-8">
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-4">
          {[0, 1, 2, 3, 4, 5, 6, 7].map((i) => <MetricCardSkeleton key={i} />)}
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="mx-auto max-w-4xl px-4 py-6">
        <div className="rounded-3xl border border-red-400/30 bg-red-500/10 p-4">
          <p className="text-red-200">{error}</p>
        </div>
      </div>
    );
  }

  if (!data) return null;

  const rebalanceTimestamps = data.rebalanceCosts.map((r) => r.timestamp);
  const currentInterval = data.currentInterval;
  const lifetimeChain = data.lifetimeChain;
  const profitabilitySummary = lifetimeChain ?? currentInterval;
  const priceDisadvantageUsd = lifetimeChain?.totalPriceDisadvantageUsd ?? currentInterval?.totalPriceDisadvantageUsd ?? 0;
  const profitabilityLabel = lifetimeChain
    ? 'Lifetime Chain True P&L'
    : currentInterval
      ? 'Current Interval True P&L'
      : 'True P&L';

  return (
    <div className="mx-auto max-w-7xl space-y-6 px-4 py-6 sm:px-6 lg:px-8">
      <section className="panel overflow-hidden">
        <div className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-cyan-400/50 to-transparent" />
        <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
          <div className="space-y-3">
          <button
            onClick={() => navigate(`/positions/${tokenId}`)}
            className="inline-flex items-center gap-2 text-sm text-slate-400 transition-colors hover:text-white"
          >
            <span aria-hidden="true">&larr;</span>
            Back to Position
          </button>
            <div className="flex flex-wrap items-center gap-3">
              <span className="rounded-full border border-white/10 bg-white/5 px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.28em] text-cyan-200/80">
                Position Analytics
              </span>
              <div className={`h-2.5 w-2.5 rounded-full ${healthColors[data.healthLabel]}`} />
              <span className={`text-sm font-medium ${healthTextColors[data.healthLabel]}`}>
            {data.healthLabel.charAt(0).toUpperCase() + data.healthLabel.slice(1)} ({data.healthScore}/100)
          </span>
            </div>
            <div>
              <h1 className="text-3xl font-semibold tracking-tight text-white sm:text-4xl">
                Analytics for Position #{tokenId}
              </h1>
              <p className="mt-2 max-w-3xl text-sm leading-6 text-slate-300 sm:text-base">
                Canonical profitability, execution cost, fee generation, and health are separated here so current interval and lifetime chain semantics stay explicit.
              </p>
            </div>
        </div>
        </div>
      </section>

      {/* Canonical Profitability */}
      {profitabilitySummary && profitabilitySummary.truePnlUsd !== null ? (
        <div className="panel">
          <div className="flex items-center justify-between gap-3 mb-3">
            <h2 className="text-sm font-medium text-slate-400">Canonical Profitability</h2>
            <span className={`text-xs font-medium uppercase tracking-wide ${trustTone(profitabilitySummary.trust.overall)}`}>
              {profitabilitySummary.trust.overall.replace(/_/g, ' ')} trust
            </span>
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
            <MetricCard
              label={profitabilityLabel}
              value={formatSignedUsd(profitabilitySummary.truePnlUsd)}
              subValue={formatSignedPercent(profitabilitySummary.truePnlPercent)}
              color={(profitabilitySummary.truePnlUsd ?? 0) >= 0 ? 'green' : 'red'}
            />
            <MetricCard
              label="LP vs HODL"
              value={formatSignedPercent(profitabilitySummary.lpVsHodlPercent)}
              subValue={formatSignedUsd(profitabilitySummary.lpVsHodlUsd)}
              color={(profitabilitySummary.lpVsHodlPercent ?? 0) >= 0 ? 'green' : 'red'}
            />
            <MetricCard
              label={lifetimeChain ? 'Root Basis' : 'Interval Basis'}
              value={profitabilitySummary.entryCostUsd !== null ? formatUsd(profitabilitySummary.entryCostUsd) : '—'}
              subValue={`Now: ${formatUsd(profitabilitySummary.currentPositionValueUsd)}`}
              color="blue"
            />
            <MetricCard
              label={lifetimeChain ? 'Chain Costs' : 'Interval Costs'}
              value={formatUsd(profitabilitySummary.totalCostsUsd)}
              subValue={`Fees: ${formatUsd(profitabilitySummary.totalFeesUsd)}`}
              color="yellow"
            />
          </div>
          {(currentInterval || lifetimeChain) && (
            <div className="mt-4 grid grid-cols-1 gap-4 border-t border-white/10 pt-4 text-sm text-slate-300 sm:grid-cols-2">
              {currentInterval && (
                <div className="rounded-[24px] border border-white/10 bg-white/[0.03] p-4">
                  <div className="flex items-center justify-between mb-2">
                    <p className="font-medium text-slate-400">Current Interval</p>
                    <span className={`text-xs uppercase ${trustTone(currentInterval.trust.overall)}`}>
                      {currentInterval.trust.overall.replace(/_/g, ' ')}
                    </span>
                  </div>
                  <p>True P&L: <span className={currentInterval.truePnlUsd !== null && currentInterval.truePnlUsd >= 0 ? 'text-green-400' : 'text-red-400'}>{formatSignedUsd(currentInterval.truePnlUsd)}</span></p>
                  <p>Operational Net Income: {formatUsd(currentInterval.netIncomeUsd)}</p>
                  <p>Interval Basis: {currentInterval.entryCostUsd !== null ? formatUsd(currentInterval.entryCostUsd) : '—'}</p>
                </div>
              )}
              {lifetimeChain && (
                <div className="rounded-[24px] border border-white/10 bg-white/[0.03] p-4">
                  <div className="flex items-center justify-between mb-2">
                    <p className="font-medium text-slate-400">Lifetime Chain</p>
                    <span className={`text-xs uppercase ${trustTone(lifetimeChain.trust.overall)}`}>
                      {lifetimeChain.trust.overall.replace(/_/g, ' ')}
                    </span>
                  </div>
                  <p>True P&L: <span className={lifetimeChain.truePnlUsd !== null && lifetimeChain.truePnlUsd >= 0 ? 'text-green-400' : 'text-red-400'}>{formatSignedUsd(lifetimeChain.truePnlUsd)}</span></p>
                  <p>Root Basis: {lifetimeChain.entryCostUsd !== null ? formatUsd(lifetimeChain.entryCostUsd) : '—'}</p>
                  <p>Tracked NFTs: {lifetimeChain.lineageTokenIds.length}</p>
                </div>
              )}
            </div>
          )}
        </div>
      ) : (
        <div className="rounded-3xl border border-white/10 bg-white/[0.03] p-4">
          <p className="text-xs text-slate-500">
            Canonical true P&L is unavailable because basis or valuation history is incomplete. The cards below fall back to operational income and legacy range-drift diagnostics.
          </p>
        </div>
      )}

      {/* Operational And Diagnostic Cards */}
      <div className="grid grid-cols-2 sm:grid-cols-6 gap-4">
        <MetricCard
          label="Total Fees Earned"
          value={formatUsd(data.combinedFeesUsd)}
          subValue={`${formatUsd(data.totalFeesClaimedUsd)} claimed + ${formatUsd(data.currentUnclaimedFeesUsd)} pending`}
          color="green"
        />
        <MetricCard
          label="Gas Costs"
          value={formatUsd(data.totalGasCostUsd)}
          subValue={`${data.totalGasCostPLS.toFixed(2)} PLS`}
          color="red"
        />
        <MetricCard
          label="Swap Friction"
          value={data.totalSwapFrictionUsd > 0 ? formatUsd(data.totalSwapFrictionUsd) : '—'}
          subValue="Pool fees + price impact"
          color="yellow"
        />
        <MetricCard
          label="Price Disadvantage"
          value={priceDisadvantageUsd > 0 ? formatUsd(priceDisadvantageUsd) : '—'}
          subValue="Realized LP-vs-HODL loss on rebalance"
          color="yellow"
        />
        <MetricCard
          label="Operational Net Income"
          value={formatUsd(data.netPnlUsd)}
          subValue="Fees - gas, excludes basis-aware comparison"
          color={data.netPnlUsd >= 0 ? 'green' : 'red'}
        />
        <MetricCard
          label="Legacy Range Drift"
          value={`${data.currentILPercent.toFixed(3)}%`}
          subValue="Snapshot-era IL approximation, not canonical"
          color="yellow"
        />
      </div>

      {/* Secondary metrics */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
        <MetricCard
          label="Avg Fee APR"
          value={`${data.avgFeeAPR.toFixed(1)}%`}
          size="sm"
          color="blue"
        />
        <MetricCard
          label="Time In Range"
          value={`${data.timeInRangePercent.toFixed(1)}%`}
          size="sm"
        />
        <MetricCard
          label="Rebalances"
          value={String(data.totalRebalances)}
          subValue={data.totalRebalances > 0 ? `every ${data.avgRebalanceFrequencyDays.toFixed(1)}d avg` : undefined}
          size="sm"
        />
        <MetricCard
          label="Days Active"
          value={data.daysSinceStart.toFixed(1)}
          subValue={`Last rebalance: ${data.daysSinceLastRebalance.toFixed(1)}d ago`}
          size="sm"
        />
      </div>

      {/* Fee Accumulation Chart */}
      <div className="panel">
        <h2 className="mb-3 text-sm font-medium text-slate-400">Cumulative Fees (USD)</h2>
        <FeeChart data={data.feeTimeSeries} rebalanceTimestamps={rebalanceTimestamps} />
        {rebalanceTimestamps.length > 0 && (
          <p className="mt-2 text-xs text-slate-500">Purple dashed lines = rebalance events</p>
        )}
      </div>

      {/* IL Tracking Chart */}
      <div className="panel">
        <h2 className="mb-3 text-sm font-medium text-slate-400">Impermanent Loss (%)</h2>
        <ILChart data={data.ilTimeSeries} />
        <p className="mt-2 text-xs text-slate-500">
          Compared to HODL from first snapshot. Uses current prices for historical approximation.
        </p>
      </div>

      {/* Daily Fees Collected Chart */}
      <div className="panel">
        <h2 className="mb-3 text-sm font-medium text-slate-400">Daily Fees Collected</h2>
        <DailyEarningsChart data={earningsData} />
      </div>

      {/* Fee Collection History */}
      {data.feeCollections.length > 0 && (
        <div className="panel">
          <h2 className="mb-3 text-sm font-medium text-slate-400">Fee Collection History</h2>
          <div className="overflow-x-auto">
            <table className="w-full text-sm text-slate-300">
              <thead>
                <tr className="border-b border-white/10 text-xs uppercase text-slate-500">
                  <th className="text-left py-2 pr-4">Date</th>
                  <th className="text-right py-2 pr-4">Value (USD)</th>
                  <th className="text-right py-2">Transaction</th>
                </tr>
              </thead>
              <tbody>
                {data.feeCollections.map((fc, i) => (
                  <tr key={i} className="border-b border-white/5">
                    <td className="py-2 pr-4 text-slate-300">
                      {new Date(fc.timestamp).toLocaleString()}
                    </td>
                    <td className="py-2 pr-4 text-right text-green-400">
                      {formatUsd(fc.totalValueUsd)}
                    </td>
                    <td className="py-2 text-right">
                      <a
                        href={txUrl(fc.txHash)}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-xs text-cyan-300 transition-colors hover:text-cyan-200"
                      >
                        View
                      </a>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Rebalance Cost Breakdown */}
      {data.rebalanceCosts.length > 0 && (
        <div className="panel">
          <h2 className="mb-3 text-sm font-medium text-slate-400">Rebalance Cost Breakdown</h2>
          <div className="overflow-x-auto">
            <table className="w-full text-sm text-slate-300">
              <thead>
                <tr className="border-b border-white/10 text-xs uppercase text-slate-500">
                  <th className="text-left py-2 pr-4">Date</th>
                  <th className="text-right py-2 pr-4">Gas (PLS)</th>
                  <th className="text-right py-2 pr-4">Fees Collected</th>
                  <th className="text-right py-2 pr-4">Configured Tol</th>
                  <th className="text-right py-2 pr-4">Exec Delta</th>
                    <th className="text-right py-2 pr-4">Exec Cost (USD)</th>
                  <th className="text-right py-2">Net ROI</th>
                </tr>
              </thead>
              <tbody>
                {data.rebalanceCosts.map((rc, i) => (
                  <tr key={i} className="border-b border-white/5">
                    <td className="py-2 pr-4 text-slate-300">
                      {new Date(rc.timestamp).toLocaleDateString()}
                    </td>
                    <td className="py-2 pr-4 text-right text-red-400">
                      {rc.gasCostPLS.toFixed(2)}
                    </td>
                    <td className="py-2 pr-4 text-right text-green-400">
                      {formatUsd(rc.feesCollectedUsd)}
                    </td>
                    <td className="py-2 pr-4 text-right text-slate-400">
                      {rc.configuredSlippageToleranceBps != null
                        ? `${(rc.configuredSlippageToleranceBps / 100).toFixed(2)}%`
                        : 'legacy'}
                    </td>
                    <td className="py-2 pr-4 text-right text-slate-400">
                      {rc.realizedExecutionDeltaBps > 0 && rc.realizedExecutionDeltaBps < 5000
                        ? `${(rc.realizedExecutionDeltaBps / 100).toFixed(2)}%`
                        : rc.realizedExecutionDeltaBps >= 5000
                          ? 'N/A'
                          : '-'}
                    </td>
                    <td className="py-2 pr-4 text-right text-yellow-400">
                      {rc.executionCostUsd != null
                        ? formatUsd(rc.executionCostUsd)
                        : '—'}
                    </td>
                    <td className={`py-2 text-right ${rc.netRoi >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                      {rc.netRoi.toFixed(2)}%
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Position Health Summary */}
      <div className="panel">
        <h2 className="mb-3 text-sm font-medium text-slate-400">Position Health Assessment</h2>
        <div className="space-y-2 text-sm text-slate-300">
          <p>
            <span className="font-medium">Score:</span>{' '}
            <span className={healthTextColors[data.healthLabel]}>
              {data.healthScore}/100 ({data.healthLabel})
            </span>
          </p>
          <p>
            <span className="font-medium">Fee Performance:</span>{' '}
            {data.avgFeeAPR > 20 ? 'Strong' : data.avgFeeAPR > 5 ? 'Moderate' : 'Low'} APR at {data.avgFeeAPR.toFixed(1)}%
          </p>
          <p>
            <span className="font-medium">Range Efficiency:</span>{' '}
            {data.timeInRangePercent > 90 ? 'Excellent' : data.timeInRangePercent > 70 ? 'Good' : 'Needs attention'} — in range {data.timeInRangePercent.toFixed(1)}% of the time
          </p>
          <p>
            <span className="font-medium">Profitability Signal:</span>{' '}
            {profitabilitySummary && profitabilitySummary.truePnlUsd !== null ? (
              profitabilitySummary.truePnlUsd >= 0 ? (
                <span className="text-green-400">{profitabilityLabel} is positive ({formatSignedUsd(profitabilitySummary.truePnlUsd)})</span>
              ) : (
                <span className="text-red-400">{profitabilityLabel} is negative ({formatSignedUsd(profitabilitySummary.truePnlUsd)})</span>
              )
            ) : data.netPnlUsd >= 0 ? (
              <span className="text-yellow-400">Canonical basis unavailable, operational net income is positive ({formatUsd(data.netPnlUsd)})</span>
            ) : (
              <span className="text-yellow-400">Canonical basis unavailable, operational net income is negative ({formatUsd(data.netPnlUsd)})</span>
            )}
          </p>
          {data.currentILPercent < -1 && (
            <p className="text-yellow-400">
              Diagnostic only: legacy range-drift estimate is {data.currentILPercent.toFixed(2)}%. Use LP vs HODL and true P&L above for the canonical profitability view.
            </p>
          )}
        </div>
      </div>

      {/* CSV Export */}
      <div className="panel">
        <h2 className="mb-3 text-sm font-medium text-slate-400">Export Data (CSV)</h2>
        <p className="mb-3 text-xs text-slate-500">
          Download flat CSV files for analysis in spreadsheets or LLMs.
        </p>
        <div className="flex flex-col gap-3 sm:flex-row">
          <button
            onClick={() => downloadFile(`/api/analytics/export/csv?type=rebalances&tokenId=${tokenId}&days=365`, `rebalances_${tokenId}_365d.csv`)}
            className="rounded-full border border-cyan-400/20 bg-cyan-500/10 px-4 py-2 text-sm text-cyan-200 transition-colors hover:bg-cyan-500/15"
          >
            Rebalance History
          </button>
          <button
            onClick={() => downloadFile(`/api/analytics/export/csv?type=snapshots&tokenId=${tokenId}&days=90`, `snapshots_${tokenId}_90d.csv`)}
            className="rounded-full border border-fuchsia-400/20 bg-fuchsia-500/10 px-4 py-2 text-sm text-fuchsia-200 transition-colors hover:bg-fuchsia-500/15"
          >
            Snapshot Time Series
          </button>
          <button
            onClick={() => downloadFile(`/api/analytics/export/csv?type=combined&tokenId=${tokenId}&days=365`, `combined_${tokenId}_365d.csv`)}
            className="rounded-full border border-emerald-400/20 bg-emerald-500/10 px-4 py-2 text-sm text-emerald-200 transition-colors hover:bg-emerald-500/15"
          >
            Combined Chronology
          </button>
        </div>
      </div>
    </div>
  );
}

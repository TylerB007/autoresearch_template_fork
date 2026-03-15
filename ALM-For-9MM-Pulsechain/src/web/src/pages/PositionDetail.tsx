import { useState, useEffect, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import {
  getPositionStatus,
  getPositionAnalytics,
  updatePosition,
  collectFees,
  getRebalancePreview,
  rebalanceNow,
  clearPositionSafeMode,
  tickToPrice,
  formatPrice,
  formatTokenAmount,
  formatUsd,
  tokenAmountToUsd,
  type Position,
  type PositionAnalytics,
  type RebalancePreview,
  type RebalanceNowResult,
  type IncreaseLiquidityResult,
  type DecreaseLiquidityResult,
} from '../api/client';
import StatusBadge from '../components/StatusBadge';
import RangeBar from '../components/RangeBar';
import MetricCard from '../components/MetricCard';
import TokenPairLogos from '../components/TokenPairLogos';
import TokenLogo from '../components/TokenLogo';
import StrategyForm, { STRATEGY_LABELS } from '../components/StrategyForm';
import ConfirmDialog from '../components/ConfirmDialog';
import IncreaseLiquidityModal from '../components/IncreaseLiquidityModal';
import DecreaseLiquidityModal from '../components/DecreaseLiquidityModal';
import Tooltip from '../components/Tooltip';
import { REFRESH_EVENT } from '../components/Navbar';
import { useChain } from '../context/ChainContext';

export default function PositionDetail() {
  const { tokenId } = useParams<{ tokenId: string }>();
  const navigate = useNavigate();
  const { txUrl } = useChain();
  const [position, setPosition] = useState<Position | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [editing, setEditing] = useState(false);

  // Collect fees state
  const [showCollectConfirm, setShowCollectConfirm] = useState(false);
  const [collecting, setCollecting] = useState(false);
  const [collectResult, setCollectResult] = useState<{ txHash: string } | null>(null);

  // Rebalance state
  const [showRebalancePreview, setShowRebalancePreview] = useState(false);
  const [preview, setPreview] = useState<RebalancePreview | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState('');
  const [showRebalanceConfirm, setShowRebalanceConfirm] = useState(false);
  const [rebalancing, setRebalancing] = useState(false);
  const [rebalanceResult, setRebalanceResult] = useState<RebalanceNowResult | null>(null);

  // Increase/decrease liquidity state
  const [showIncreaseModal, setShowIncreaseModal] = useState(false);
  const [showDecreaseModal, setShowDecreaseModal] = useState(false);
  const [increaseResult, setIncreaseResult] = useState<IncreaseLiquidityResult | null>(null);
  const [decreaseResult, setDecreaseResult] = useState<DecreaseLiquidityResult | null>(null);

  const [analytics, setAnalytics] = useState<PositionAnalytics | null>(null);
  const [safeModeClearing, setSafeModeClearing] = useState(false);
  const [safeModeMsg, setSafeModeMsg] = useState('');

  const refreshData = useCallback(() => {
    if (!tokenId) return;
    setLoading(true);
    getPositionStatus(Number(tokenId))
      .then(setPosition)
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
    getPositionAnalytics(Number(tokenId))
      .then(setAnalytics)
      .catch(() => {});
  }, [tokenId]);

  useEffect(() => {
    refreshData();
  }, [refreshData]);

  useEffect(() => {
    window.addEventListener(REFRESH_EVENT, refreshData);
    return () => window.removeEventListener(REFRESH_EVENT, refreshData);
  }, [refreshData]);

  const handleUpdate = async (data: { strategy: string; width_ticks: number; trigger_distance_ticks: number }) => {
    if (!tokenId) return;
    try {
      const updated = await updatePosition(Number(tokenId), {
        strategy: data.strategy,
        width_ticks: data.width_ticks,
        trigger_distance_ticks: data.trigger_distance_ticks,
      });
      setPosition(updated);
      setEditing(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update');
    }
  };

  const handleCollect = async () => {
    if (!tokenId) return;
    setShowCollectConfirm(false);
    setCollecting(true);
    try {
      const result = await collectFees(Number(tokenId));
      setCollectResult({ txHash: result.txHash });
      const updated = await getPositionStatus(Number(tokenId));
      setPosition(updated);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to collect fees');
    } finally {
      setCollecting(false);
    }
  };

  const handleOpenRebalancePreview = async () => {
    if (!tokenId) return;
    setPreviewError('');
    setPreview(null);
    setShowRebalancePreview(true);
    setPreviewLoading(true);
    try {
      const p = await getRebalancePreview(Number(tokenId));
      setPreview(p);
    } catch (err) {
      setPreviewError(err instanceof Error ? err.message : 'Failed to load preview');
    } finally {
      setPreviewLoading(false);
    }
  };

  const handleRebalanceConfirm = async () => {
    if (!tokenId) return;
    setShowRebalanceConfirm(false);
    setShowRebalancePreview(false);
    setRebalancing(true);
    try {
      const result = await rebalanceNow(Number(tokenId));
      setRebalanceResult(result);
      // Refresh position — new token ID means we navigate to updated page
      const updated = await getPositionStatus(result.newTokenId).catch(() => null);
      if (updated) {
        setPosition(updated);
        // If token ID changed, update the URL without adding history entry
        if (result.newTokenId !== result.oldTokenId) {
          navigate(`/positions/${result.newTokenId}`, { replace: true });
        }
      } else {
        refreshData();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Rebalance failed');
    } finally {
      setRebalancing(false);
    }
  };

  const handleClearSafeMode = async () => {
    if (!tokenId) return;
    setSafeModeClearing(true);
    setSafeModeMsg('');
    try {
      const result = await clearPositionSafeMode(Number(tokenId));
      if (result.recoveryStateWarning) setSafeModeMsg(result.recoveryStateWarning);
      const updated = await getPositionStatus(Number(tokenId));
      setPosition(updated);
    } catch (err) {
      setSafeModeMsg(err instanceof Error ? err.message : 'Failed to clear safe mode');
    } finally {
      setSafeModeClearing(false);
    }
  };

  const hasFees = position?.feesOwed0 && position?.feesOwed1 &&
    (position.feesOwed0 !== '0' || position.feesOwed1 !== '0');

  if (loading) {
    return (
      <div className="panel flex h-64 items-center justify-center">
        <span className="text-sm text-slate-400">Loading position...</span>
      </div>
    );
  }

  if (error) {
    return (
      <div className="mx-auto max-w-4xl px-4 py-6">
        <div className="rounded-3xl border border-red-500/30 bg-red-500/10 p-4">
          <p className="text-sm text-red-200">{error}</p>
        </div>
      </div>
    );
  }

  if (!position) return null;

  const currentInterval = analytics?.currentInterval;
  const lifetimeChain = analytics?.lifetimeChain;
  const profitabilitySummary = lifetimeChain ?? currentInterval;
  const profitabilityValue = analytics ? (profitabilitySummary?.truePnlUsd ?? analytics.totalPnlUsd ?? analytics.netPnlUsd) : null;
  const profitabilityLabel = profitabilitySummary
    ? lifetimeChain
      ? 'Chain True P&L'
      : 'Interval True P&L'
    : analytics?.totalPnlUsd !== null
      ? 'True P&L'
      : 'Net Income';
  const profitabilitySubValue = profitabilitySummary
    ? `${lifetimeChain ? 'Lifetime chain' : 'Current interval'} • ${profitabilitySummary.trust.overall.replace(/_/g, ' ')} trust`
    : undefined;
  const comparisonLabel = profitabilitySummary?.lpVsHodlPercent !== null && profitabilitySummary?.lpVsHodlPercent !== undefined
    ? 'LP vs HODL'
    : 'Current IL';
  const comparisonValue = profitabilitySummary?.lpVsHodlPercent !== null && profitabilitySummary?.lpVsHodlPercent !== undefined
    ? `${profitabilitySummary.lpVsHodlPercent >= 0 ? '+' : ''}${profitabilitySummary.lpVsHodlPercent.toFixed(2)}%`
    : analytics
      ? `${analytics.currentILPercent.toFixed(3)}%`
      : '—';
  const comparisonSubValue = profitabilitySummary?.lpVsHodlUsd !== null && profitabilitySummary?.lpVsHodlUsd !== undefined
    ? formatUsd(profitabilitySummary.lpVsHodlUsd)
    : 'Legacy range-only drift estimate';
  const priceDisadvantageUsd = profitabilitySummary?.totalPriceDisadvantageUsd ?? 0;

  return (
    <div className="mx-auto max-w-7xl space-y-6 px-4 py-6 sm:px-6 lg:px-8">
      <section className="panel overflow-hidden">
        <div className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-cyan-400/50 to-transparent" />
        <div className="flex flex-col gap-5 lg:flex-row lg:items-start lg:justify-between">
          <div className="space-y-4">
            <button
              onClick={() => navigate(-1)}
              className="inline-flex items-center gap-2 text-sm text-slate-400 transition-colors hover:text-white"
            >
              <span aria-hidden="true">&larr;</span>
              Back to monitored positions
            </button>
            <div className="space-y-3">
              <div className="flex flex-wrap items-center gap-3">
                <span className="rounded-full border border-white/10 bg-white/5 px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.28em] text-cyan-200/80">
                  Operator Workspace
                </span>
                <StatusBadge inRange={position.inRange} />
                {position.inSafeMode && (
                  <span className="rounded-full border border-red-400/30 bg-red-500/10 px-3 py-1 text-xs font-medium text-red-200">
                    Safe Mode Active
                  </span>
                )}
                {position.killSwitchTriggered && (
                  <span className="rounded-full border border-amber-400/30 bg-amber-500/10 px-3 py-1 text-xs font-medium text-amber-200">
                    Kill Switch Triggered
                  </span>
                )}
              </div>
              <div>
                <div className="flex items-center gap-3">
                  <TokenPairLogos
                    symbol0={position.token0Symbol || position.pair.split('/')[0]}
                    symbol1={position.token1Symbol || position.pair.split('/')[1]}
                    chainId={position.chainId}
                    size="lg"
                  />
                  <h1 className="text-3xl font-semibold tracking-tight text-white sm:text-4xl">
                    Position #{position.token_id}
                  </h1>
                </div>
                <p className="mt-2 max-w-3xl text-sm leading-6 text-slate-300 sm:text-base">
                  {position.pair} running {STRATEGY_LABELS[position.strategy] || position.strategy}. This view keeps the live range, liquidity controls, safety state, and profitability signals in one operator surface.
                </p>
              </div>
            </div>
          </div>
          <div className="flex flex-wrap gap-2 lg:max-w-xl lg:justify-end">
          {!editing && (
            <button
              onClick={() => navigate(`/positions/${tokenId}/analytics`)}
              className="rounded-full border border-indigo-400/30 bg-indigo-500/15 px-4 py-2 text-sm font-medium text-indigo-100 transition-colors hover:bg-indigo-500/25"
            >
              Analytics
            </button>
          )}
          {!editing && (
            <button
              onClick={() => navigate(`/positions/${tokenId}/chain`)}
              className="rounded-full border border-fuchsia-400/30 bg-fuchsia-500/15 px-4 py-2 text-sm font-medium text-fuchsia-100 transition-colors hover:bg-fuchsia-500/25"
            >
              Chain
            </button>
          )}
          {!editing && (
            <button
              onClick={() => setShowIncreaseModal(true)}
              className="rounded-full border border-emerald-400/30 bg-emerald-500/15 px-4 py-2 text-sm font-medium text-emerald-100 transition-colors hover:bg-emerald-500/25"
            >
              Increase
            </button>
          )}
          {!editing && (
            <button
              onClick={() => setShowDecreaseModal(true)}
              className="rounded-full border border-amber-400/30 bg-amber-500/15 px-4 py-2 text-sm font-medium text-amber-100 transition-colors hover:bg-amber-500/25"
            >
              Decrease
            </button>
          )}
          {!editing && (
            <button
              onClick={handleOpenRebalancePreview}
              disabled={rebalancing}
              className={`rounded-full px-4 py-2 text-sm font-medium transition-colors ${
                rebalancing
                  ? 'cursor-not-allowed border border-white/10 bg-white/5 text-slate-500'
                  : 'border border-cyan-400/40 bg-cyan-400 text-slate-950 hover:bg-cyan-300'
              }`}
            >
              {rebalancing ? 'Rebalancing…' : 'Rebalance Now'}
            </button>
          )}
          {!editing && (
            <button
              onClick={() => setEditing(true)}
              className="rounded-full border border-white/10 bg-white/5 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-white/10"
            >
              Edit
            </button>
          )}
          </div>
        </div>
      </section>

      {/* Rebalance success banner */}
      {rebalanceResult && (
        <div className="rounded-3xl border border-cyan-400/30 bg-cyan-500/10 p-4">
          <p className="text-sm font-medium text-cyan-100">
            ✅ Rebalance complete — #{rebalanceResult.oldTokenId} → #{rebalanceResult.newTokenId}
          </p>
          {rebalanceResult.newPosition && (
            <a
              href={txUrl(rebalanceResult.newPosition.txHash)}
              target="_blank"
              rel="noopener noreferrer"
              className="mt-2 inline-flex text-xs text-cyan-300 transition-colors hover:text-cyan-200"
            >
              View mint transaction ↗
            </a>
          )}
        </div>
      )}

      {/* Safe mode panel */}
      {position.inSafeMode && (
        <div className="rounded-3xl border border-red-400/30 bg-red-500/10 p-5">
          <h3 className="text-sm font-semibold text-red-100">Position in Safe Mode</h3>
          <p className="mt-2 text-sm text-slate-300">
            This position was halted after a rebalance failure or error. Review the rebalance history before resuming.
          </p>
          {safeModeMsg && (
            <p className="mt-3 rounded-2xl border border-amber-400/20 bg-amber-500/10 p-3 text-xs text-amber-100">{safeModeMsg}</p>
          )}
          <button
            onClick={handleClearSafeMode}
            disabled={safeModeClearing}
            className="mt-4 rounded-full border border-amber-400/40 bg-amber-400 px-4 py-2 text-sm font-medium text-slate-950 transition-colors hover:bg-amber-300 disabled:opacity-50"
          >
            {safeModeClearing ? 'Clearing...' : 'Clear Safe Mode — Resume Monitoring'}
          </button>
        </div>
      )}

      {/* Kill switch panel */}
      {position.killSwitchTriggered && (
        <div className="rounded-3xl border border-amber-400/30 bg-amber-500/10 p-5">
          <h3 className="text-sm font-semibold text-amber-100">Kill Switch Triggered</h3>
          <p className="mt-2 text-sm text-slate-300">
            Automated rebalancing has been disabled for this position due to consecutive losses.
            Use the Enable button on the dashboard or <code className="text-orange-200">/enable</code> in Telegram to reset.
          </p>
        </div>
      )}

      {/* Range visualization */}
      <div className="panel">
        <h2 className="text-sm font-medium text-slate-400">Price Range</h2>
        <RangeBar
          tickLower={position.tickLower}
          tickUpper={position.tickUpper}
          currentTick={position.currentTick}
          token0Decimals={position.token0Decimals}
          token1Decimals={position.token1Decimals}
          token0Symbol={position.token0Symbol}
          token1Symbol={position.token1Symbol}
        />
      </div>

      {/* Position age, APR, and key metrics */}
      {!editing && (
        <div className="grid grid-cols-2 gap-4 xl:grid-cols-4">
          {position.mintTimestamp && (
            <MetricCard
              label="Position Age"
              value={position.age ?? '—'}
              subValue={`Minted ${new Date(position.mintTimestamp).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit' })}`}
              color="blue"
              size="sm"
            />
          )}
          {position.lifetimeAPR !== undefined && position.lifetimeAPR > 0 && (
            <MetricCard
              label="Lifetime APR"
              value={`${position.lifetimeAPR.toFixed(1)}%`}
              subValue={`${formatUsd(position.totalFeesUsd ?? 0)} earned / ${formatUsd(position.positionValueUsd ?? 0)} value`}
              color="green"
              size="sm"
            />
          )}
          {position.totalFeesUsd !== undefined && (
            <MetricCard
              label="Total Fees"
              value={formatUsd(position.totalFeesUsd)}
              subValue={`${formatUsd(position.claimedFeesUsd ?? 0)} claimed + ${formatUsd(position.unclaimedFeesUsd ?? 0)} pending`}
              color="yellow"
              size="sm"
            />
          )}
          {analytics && (
            <MetricCard
              label={profitabilityLabel}
              value={profitabilityValue !== null ? formatUsd(profitabilityValue) : '—'}
              subValue={profitabilitySubValue}
              color={(profitabilityValue ?? 0) >= 0 ? 'green' : 'red'}
              size="sm"
            />
          )}
        </div>
      )}

      {/* Additional analytics metrics */}
      {!editing && analytics && (
        <div className="grid grid-cols-2 gap-4 xl:grid-cols-5">
          <MetricCard
            label={comparisonLabel}
            value={comparisonValue}
            subValue={comparisonSubValue}
            color={comparisonLabel === 'LP vs HODL'
              ? ((profitabilitySummary?.lpVsHodlPercent ?? 0) >= 0 ? 'green' : 'red')
              : 'yellow'}
            size="sm"
          />
          <MetricCard
            label={lifetimeChain ? 'Chain Price Disadv.' : 'Interval Price Disadv.'}
            value={formatUsd(priceDisadvantageUsd)}
            subValue="Tracked rebalance execution drag"
            color={priceDisadvantageUsd > 0 ? 'red' : 'green'}
            size="sm"
          />
          <MetricCard
            label="Days Since Rebalance"
            value={analytics.daysSinceLastRebalance.toFixed(1)}
            size="sm"
          />
          <MetricCard
            label="Time in Range"
            value={`${analytics.timeInRangePercent.toFixed(0)}%`}
            size="sm"
          />
          <MetricCard
            label="Health Score"
            value={`${analytics.healthScore}/100`}
            subValue={analytics.healthLabel}
            color={analytics.healthScore >= 75 ? 'green' : analytics.healthScore >= 50 ? 'yellow' : 'red'}
            size="sm"
          />
        </div>
      )}

      {/* Info grid */}
      {!editing && (
        <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
          <InfoCard label="Pair" value={position.pair} />
          <InfoCard
            label="Strategy"
            value={STRATEGY_LABELS[position.strategy] || position.strategy}
          />
          <InfoCard label="Width" value={`${position.width_ticks} ticks${position.width_percentage ? ` (~${position.width_percentage}%)` : ''}`} />
          <InfoCard label="Trigger Distance" value={`${position.trigger_distance_ticks} ticks${position.trigger_percentage ? ` (~${position.trigger_percentage}%)` : ''}`} />
          {position.gauge_address && (
            <InfoCard
              label="Gauge Staking"
              value={`${position.gauge_address.slice(0, 6)}...${position.gauge_address.slice(-4)}`}
              subValue="Auto-unstake/restake on rebalance"
            />
          )}
          <InfoCard
            label="Current Tick"
            value={`${position.currentTick} (${formatPrice(tickToPrice(position.currentTick, position.token0Decimals, position.token1Decimals))} ${position.token1Symbol}/${position.token0Symbol})`}
          />
          <InfoCard label="Status" value={position.status} />
          <InfoCard
            label={`Amount ${position.token0Symbol || 'Token0'}`}
            value={formatTokenAmount(position.amount0, position.token0Decimals)}
            subValue={position.priceUsd0 ? formatUsd(tokenAmountToUsd(position.amount0, position.token0Decimals, position.priceUsd0)) : undefined}
          />
          <InfoCard
            label={`Amount ${position.token1Symbol || 'Token1'}`}
            value={formatTokenAmount(position.amount1, position.token1Decimals)}
            subValue={position.priceUsd1 ? formatUsd(tokenAmountToUsd(position.amount1, position.token1Decimals, position.priceUsd1)) : undefined}
          />
          {(position.priceUsd0 || position.priceUsd1) && (
            <InfoCard
              label="Total Position Value"
              value={formatUsd(
                tokenAmountToUsd(position.amount0, position.token0Decimals, position.priceUsd0 ?? 0) +
                tokenAmountToUsd(position.amount1, position.token1Decimals, position.priceUsd1 ?? 0)
              )}
            />
          )}
          <InfoCard
            label="Tick Lower"
            value={`${position.tickLower} (${formatPrice(tickToPrice(position.tickLower, position.token0Decimals, position.token1Decimals))} ${position.token1Symbol}/${position.token0Symbol})`}
          />
          <InfoCard
            label="Tick Upper"
            value={`${position.tickUpper} (${formatPrice(tickToPrice(position.tickUpper, position.token0Decimals, position.token1Decimals))} ${position.token1Symbol}/${position.token0Symbol})`}
          />
        </div>
      )}

      {/* Rebalance Cost Estimates */}
      {!editing && position.rebalanceCosts && (
        <div className="panel">
          <h2 className="text-sm font-medium text-slate-400">Rebalance Cost Estimates</h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mb-4">
            <RebalanceEdgeCard
              label="At Lower Edge"
              labelColor="text-red-400"
              edge={position.rebalanceCosts.lower}
              costs={position.rebalanceCosts}
              positionValueUsd={position.positionValueUsd ?? 0}
              lifetimeAPR={position.lifetimeAPR ?? 0}
            />
            <RebalanceEdgeCard
              label="At Upper Edge"
              labelColor="text-green-400"
              edge={position.rebalanceCosts.upper}
              costs={position.rebalanceCosts}
              positionValueUsd={position.positionValueUsd ?? 0}
              lifetimeAPR={position.lifetimeAPR ?? 0}
            />
          </div>
          {position.rebalanceCosts.critical && (
            <div className="mt-4 rounded-2xl border border-amber-400/20 bg-amber-500/10 p-4">
              <h3 className="mb-2 text-xs font-medium uppercase tracking-[0.22em] text-amber-200">
                Critical Distance Break-Even ({position.rebalanceCosts.critical.distanceTicks} ticks)
              </h3>
              <div className="grid grid-cols-1 gap-3 text-xs sm:grid-cols-2">
                <div className="flex justify-between">
                  <span className="text-slate-400">At MAX Lower:</span>
                  <span className="font-medium text-amber-100">
                    {position.rebalanceCosts.critical.lowerBreakEvenHours > 0
                      ? formatBreakEven(position.rebalanceCosts.critical.lowerBreakEvenHours)
                      : '—'}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-slate-400">At MAX Upper:</span>
                  <span className="font-medium text-amber-100">
                    {position.rebalanceCosts.critical.upperBreakEvenHours > 0
                      ? formatBreakEven(position.rebalanceCosts.critical.upperBreakEvenHours)
                      : '—'}
                  </span>
                </div>
              </div>
            </div>
          )}
          <p className="mt-3 text-xs text-slate-500">
            Estimates based on current gas price, {position.lifetimeAPR?.toFixed(1)}% lifetime APR, and {formatUsd(position.positionValueUsd ?? 0)} position value.
            Hover values for detailed breakdowns.
          </p>
        </div>
      )}

      {/* ── Rebalance Preview Modal ── */}
      {showRebalancePreview && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/80 p-4 backdrop-blur-md">
          <div className="w-full max-w-2xl rounded-[28px] border border-white/10 bg-[#08111f]/95 shadow-[0_32px_90px_rgba(2,8,23,0.78)]">
            <div className="flex items-center justify-between border-b border-white/10 p-5">
              <h2 className="text-base font-semibold text-white">Rebalance Preview — #{position.token_id}</h2>
              <button
                onClick={() => setShowRebalancePreview(false)}
                className="text-lg leading-none text-slate-500 transition-colors hover:text-white"
              >
                ✕
              </button>
            </div>

            <div className="p-5 space-y-4">
              {previewLoading && (
                <p className="py-4 text-center text-sm text-slate-400">Loading preview…</p>
              )}
              {previewError && (
                <p className="text-sm text-red-300">{previewError}</p>
              )}
              {preview && !previewLoading && (
                <>
                  {/* Status row */}
                  <div className="flex items-center gap-3 text-sm">
                    <span className={`font-medium ${preview.inRange ? 'text-green-400' : 'text-red-400'}`}>
                      {preview.inRange ? '🟢 In Range' : '🔴 Out of Range'}
                    </span>
                    <span className="text-slate-600">·</span>
                    <span className="text-slate-300">{preview.pair}</span>
                    <span className="text-slate-600">·</span>
                    <span className="text-slate-200">{STRATEGY_LABELS[preview.strategy] || preview.strategy}</span>
                  </div>

                  {/* Value & fees row */}
                  <div className="grid grid-cols-2 gap-3">
                    <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-3">
                      <p className="mb-1 text-xs uppercase tracking-[0.22em] text-slate-500">Position Value</p>
                      <p className="text-white font-semibold">{formatUsd(preview.positionValueUsd)}</p>
                    </div>
                    <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-3">
                      <p className="mb-1 text-xs uppercase tracking-[0.22em] text-slate-500">Unclaimed Fees</p>
                      <p className="text-yellow-400 font-semibold">{formatUsd(preview.feesUsd)}</p>
                      <p className="mt-0.5 text-xs text-slate-500">Will be collected first</p>
                    </div>
                  </div>

                  {/* Range change */}
                  <div className="space-y-2 rounded-2xl border border-white/10 bg-white/[0.03] p-3">
                    <p className="text-xs uppercase tracking-[0.22em] text-slate-500">Range Change</p>
                    <div className="flex items-center gap-2 text-sm">
                      <div className="flex-1">
                        <p className="mb-0.5 text-xs text-slate-500">Current</p>
                        <p className="font-mono text-xs text-slate-200">
                          [{preview.currentRange.tickLower} → {preview.currentRange.tickUpper}]
                        </p>
                        <p className="mt-0.5 text-xs text-slate-500">
                          {formatPrice(tickToPrice(preview.currentRange.tickLower, 8, 18))} – {formatPrice(tickToPrice(preview.currentRange.tickUpper, 8, 18))} {preview.token1Symbol}/{preview.token0Symbol}
                        </p>
                      </div>
                      <span className="text-blue-400 text-lg">→</span>
                      <div className="flex-1">
                        <p className="mb-0.5 text-xs text-slate-500">New</p>
                        <p className="font-mono text-xs text-cyan-200">
                          [{preview.newRange.tickLower} → {preview.newRange.tickUpper}]
                        </p>
                        <p className="mt-0.5 text-xs text-slate-500">
                          {formatPrice(tickToPrice(preview.newRange.tickLower, 8, 18))} – {formatPrice(tickToPrice(preview.newRange.tickUpper, 8, 18))} {preview.token1Symbol}/{preview.token0Symbol}
                        </p>
                      </div>
                    </div>
                  </div>

                  {/* Swap estimate */}
                  {preview.swapEstimate.amountUsd > 0 && (
                    <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-3">
                      <p className="mb-1 text-xs uppercase tracking-[0.22em] text-slate-500">Estimated Swap</p>
                      <p className="text-sm text-white">
                        ~{formatUsd(preview.swapEstimate.amountUsd)} of{' '}
                        <span className="font-medium text-cyan-200">{preview.swapEstimate.symbol}</span>
                        <span className="ml-1 text-slate-400">({preview.swapEstimate.pct.toFixed(1)}% of position)</span>
                      </p>
                    </div>
                  )}

                  {/* Warning note */}
                  <p className="rounded-2xl border border-white/10 bg-white/[0.03] p-3 text-xs text-slate-400">
                    ⚠️ Bypasses cooldown and confirmation timer. TWAP safety check is still enforced.
                    This is irreversible once the old NFT is burned.
                  </p>

                  {preview.dryRun && (
                    <p className="rounded-2xl border border-amber-400/20 bg-amber-500/10 p-3 text-xs text-amber-100">
                      🧪 Dry run mode is enabled — no transaction will execute.
                    </p>
                  )}
                </>
              )}
            </div>

            {!previewLoading && !previewError && preview && (
              <div className="p-5 pt-0 flex gap-3">
                <button
                  onClick={() => setShowRebalancePreview(false)}
                  className="flex-1 rounded-full border border-white/10 bg-white/5 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-white/10"
                >
                  Cancel
                </button>
                <button
                  onClick={() => setShowRebalanceConfirm(true)}
                  className="flex-1 rounded-full border border-cyan-400/30 bg-cyan-400 px-4 py-2 text-sm font-medium text-slate-950 transition-colors hover:bg-cyan-300"
                >
                  Confirm Rebalance
                </button>
              </div>
            )}
            {(previewLoading || previewError) && (
              <div className="p-5 pt-0">
                <button
                  onClick={() => setShowRebalancePreview(false)}
                  className="w-full rounded-full border border-white/10 bg-white/5 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-white/10"
                >
                  Close
                </button>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Rebalance confirmation dialog */}
      {showRebalanceConfirm && (
        <ConfirmDialog
          title="Confirm Rebalance"
          message={`Force a full rebalance for position #${position.token_id}? This will collect fees, burn the position NFT, swap tokens, and mint a new position. This action is irreversible once started.`}
          confirmLabel="Execute Rebalance"
          onConfirm={handleRebalanceConfirm}
          onCancel={() => setShowRebalanceConfirm(false)}
        />
      )}

      {/* Collect confirmation dialog */}
      {showCollectConfirm && position.feesOwed0 && position.feesOwed1 && (
        <ConfirmDialog
          title="Collect Fees"
          message={`Collect ${formatTokenAmount(position.feesOwed0, position.token0Decimals)} ${position.token0Symbol} and ${formatTokenAmount(position.feesOwed1, position.token1Decimals)} ${position.token1Symbol} from position #${position.token_id}? This will submit a transaction.`}
          confirmLabel="Collect"
          onConfirm={handleCollect}
          onCancel={() => setShowCollectConfirm(false)}
        />
      )}

      {/* Increase Liquidity Modal */}
      {showIncreaseModal && position && (
        <IncreaseLiquidityModal
          position={position}
          onClose={() => { setShowIncreaseModal(false); refreshData(); }}
          onSuccess={(res) => { setIncreaseResult(res); refreshData(); }}
          txUrl={txUrl}
        />
      )}

      {/* Decrease Liquidity Modal */}
      {showDecreaseModal && position && (
        <DecreaseLiquidityModal
          position={position}
          onClose={() => { setShowDecreaseModal(false); refreshData(); }}
          onSuccess={(res) => { setDecreaseResult(res); refreshData(); }}
          txUrl={txUrl}
        />
      )}

      {/* Increase success banner */}
      {increaseResult && (
        <div className="flex flex-col gap-3 rounded-3xl border border-emerald-400/30 bg-emerald-500/10 p-4 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-sm text-emerald-100">
            Liquidity increased! Added {formatTokenAmount(increaseResult.amount0, position.token0Decimals)} {position.token0Symbol} + {formatTokenAmount(increaseResult.amount1, position.token1Decimals)} {position.token1Symbol}
          </p>
          <a
            href={txUrl(increaseResult.txHash)}
            target="_blank"
            rel="noopener noreferrer"
            className="text-sm text-cyan-300 transition-colors hover:text-cyan-200"
          >
            View Transaction
          </a>
        </div>
      )}

      {/* Decrease success banner */}
      {decreaseResult && (
        <div className="flex flex-col gap-3 rounded-3xl border border-amber-400/30 bg-amber-500/10 p-4 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-sm text-amber-100">
            Liquidity decreased by {(decreaseResult.percentageBps / 100).toFixed(0)}%! Received {formatTokenAmount(decreaseResult.amount0, position.token0Decimals)} {position.token0Symbol} + {formatTokenAmount(decreaseResult.amount1, position.token1Decimals)} {position.token1Symbol}
          </p>
          <a
            href={txUrl(decreaseResult.decreaseTxHash)}
            target="_blank"
            rel="noopener noreferrer"
            className="text-sm text-cyan-300 transition-colors hover:text-cyan-200"
          >
            View Transaction
          </a>
        </div>
      )}

      {/* Collect success banner */}
      {collectResult && (
        <div className="flex flex-col gap-3 rounded-3xl border border-emerald-400/30 bg-emerald-500/10 p-4 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-sm text-emerald-100">
            Fees collected successfully!
          </p>
          <a
            href={txUrl(collectResult.txHash)}
            target="_blank"
            rel="noopener noreferrer"
            className="text-sm text-cyan-300 transition-colors hover:text-cyan-200"
          >
            View Transaction
          </a>
        </div>
      )}

      {/* Unclaimed Fees */}
      {!editing && position.feesOwed0 && position.feesOwed1 && (
        <div className="panel">
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-sm font-medium text-slate-400">Unclaimed Fees</h2>
            <button
              onClick={() => setShowCollectConfirm(true)}
              disabled={!hasFees || collecting}
              className={`rounded-full px-4 py-1.5 text-sm font-medium transition-colors ${
                hasFees && !collecting
                  ? 'border border-amber-400/30 bg-amber-400 text-slate-950 hover:bg-amber-300'
                  : 'cursor-not-allowed border border-white/10 bg-white/5 text-slate-500'
              }`}
            >
              {collecting ? 'Collecting...' : 'Collect Fees'}
            </button>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <div className="flex items-center gap-1.5">
                <TokenLogo symbol={position.token0Symbol || ''} chainId={position.chainId} size="xs" />
                <p className="text-xs uppercase tracking-[0.22em] text-slate-500">{position.token0Symbol}</p>
              </div>
              <p className="mt-1 text-lg font-semibold text-amber-200">
                {formatTokenAmount(position.feesOwed0, position.token0Decimals)}
                {position.priceUsd0 ? (
                    <span className="ml-2 text-sm font-normal text-slate-400">
                    ({formatUsd(tokenAmountToUsd(position.feesOwed0, position.token0Decimals, position.priceUsd0))})
                  </span>
                ) : null}
              </p>
            </div>
            <div>
              <div className="flex items-center gap-1.5">
                <TokenLogo symbol={position.token1Symbol || ''} chainId={position.chainId} size="xs" />
                <p className="text-xs uppercase tracking-[0.22em] text-slate-500">{position.token1Symbol}</p>
              </div>
              <p className="mt-1 text-lg font-semibold text-amber-200">
                {formatTokenAmount(position.feesOwed1, position.token1Decimals)}
                {position.priceUsd1 ? (
                    <span className="ml-2 text-sm font-normal text-slate-400">
                    ({formatUsd(tokenAmountToUsd(position.feesOwed1, position.token1Decimals, position.priceUsd1))})
                  </span>
                ) : null}
              </p>
            </div>
          </div>
          {(position.priceUsd0 || position.priceUsd1) && (
            <div className="mt-3 border-t border-white/10 pt-3">
              <p className="text-xs uppercase tracking-[0.22em] text-slate-500">Total Fees Value</p>
              <p className="mt-1 text-lg font-semibold text-amber-200">
                {formatUsd(
                  tokenAmountToUsd(position.feesOwed0, position.token0Decimals, position.priceUsd0 ?? 0) +
                  tokenAmountToUsd(position.feesOwed1, position.token1Decimals, position.priceUsd1 ?? 0)
                )}
              </p>
            </div>
          )}
        </div>
      )}

      {editing && (
        <div className="panel">
          <h2 className="mb-4 text-sm font-medium text-slate-400">Edit Strategy</h2>
          <StrategyForm
            initialData={{
              token_id: position.token_id,
              strategy: position.strategy,
              width_ticks: position.width_ticks,
              trigger_distance_ticks: position.trigger_distance_ticks,
            }}
            showTokenId={false}
            onSubmit={handleUpdate}
            onCancel={() => setEditing(false)}
            submitLabel="Save Changes"
          />
        </div>
      )}
    </div>
  );
}

function InfoCard({ label, value, subValue }: { label: string; value: string; subValue?: string }) {
  return (
    <div className="rounded-[24px] border border-white/10 bg-white/[0.03] p-4 shadow-[inset_0_1px_0_rgba(255,255,255,0.03)]">
      <p className="text-xs uppercase tracking-[0.24em] text-slate-500">{label}</p>
      <p className="mt-1 break-all text-sm font-medium text-white">{value}</p>
      {subValue && <p className="mt-0.5 text-xs text-slate-400">{subValue}</p>}
    </div>
  );
}

function formatBreakEven(hours: number): string {
  if (hours < 1) return `${Math.round(hours * 60)}min`;
  if (hours < 24) return `${hours.toFixed(1)}hr`;
  const days = Math.floor(hours / 24);
  const remainingHours = Math.round(hours % 24);
  return `${days}d ${remainingHours}hr`;
}

interface EdgeData {
  swapAmountUsd: number;
  swapTokenIn: 'token0' | 'token1';
  swapTokenInSymbol: string;
  swapPct: number;
  slippageCostUsd: number;
  totalCostUsd: number;
  breakEvenHours: number;
}

interface CostsData {
  gasCostUsd: number;
  gasCostPLS: number;
  totalGasUnits: number;
  slippageBps: number;
  hourlyIncomeUsd: number;
}

function RebalanceEdgeCard({
  label,
  labelColor,
  edge,
  costs,
  positionValueUsd,
  lifetimeAPR,
}: {
  label: string;
  labelColor: string;
  edge: EdgeData;
  costs: CostsData;
  positionValueUsd: number;
  lifetimeAPR: number;
}) {
  const swapPct = edge.swapPct.toFixed(1);

  return (
    <div className="rounded-[24px] border border-white/10 bg-white/[0.03] p-4 shadow-[inset_0_1px_0_rgba(255,255,255,0.03)]">
      <p className={`text-xs ${labelColor} uppercase tracking-wide font-medium mb-2`}>{label}</p>
      <div className="space-y-1.5">
        <div className="flex justify-between text-sm items-center">
          <span className="text-slate-400">Swap amount</span>
          <Tooltip content={
            <div className="space-y-1.5">
              <p className="mb-1 font-medium text-slate-200">Swap Breakdown</p>
              <p className="text-slate-400">At this edge, the position is 100% one token. To enter the new range, {edge.swapTokenInSymbol} must be swapped.</p>
              <div className="mt-1.5 space-y-0.5 border-t border-white/10 pt-1.5">
                <div className="flex justify-between">
                  <span className="text-slate-400">Selling:</span>
                  <span className="text-white">{edge.swapTokenInSymbol}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-slate-400">Swap value:</span>
                  <span className="text-white">{formatUsd(edge.swapAmountUsd)}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-slate-400">% of position:</span>
                  <span className="text-white">{swapPct}%</span>
                </div>
              </div>
            </div>
          }>
            <span className="cursor-help border-b border-dotted border-slate-600 text-white">{formatUsd(edge.swapAmountUsd)}</span>
          </Tooltip>
        </div>

        <div className="flex justify-between text-sm items-center">
          <span className="text-slate-400">Slippage cost</span>
          <Tooltip content={
            <div className="space-y-1.5">
              <p className="mb-1 font-medium text-slate-200">Slippage Breakdown</p>
              <p className="text-slate-400">Estimated cost from price impact and slippage on the swap.</p>
              <div className="mt-1.5 space-y-0.5 border-t border-white/10 pt-1.5">
                <div className="flex justify-between">
                  <span className="text-slate-400">Slippage rate:</span>
                  <span className="text-white">{costs.slippageBps} bps ({(costs.slippageBps / 100).toFixed(2)}%)</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-slate-400">Swap amount:</span>
                  <span className="text-white">{formatUsd(edge.swapAmountUsd)}</span>
                </div>
                <div className="flex justify-between border-t border-white/10 pt-1">
                  <span className="text-slate-400">Calculation:</span>
                  <span className="text-yellow-400">{formatUsd(edge.swapAmountUsd)} x {(costs.slippageBps / 100).toFixed(2)}%</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-slate-400">Slippage cost:</span>
                  <span className="text-yellow-400">{formatUsd(edge.slippageCostUsd)}</span>
                </div>
              </div>
            </div>
          }>
            <span className="cursor-help border-b border-dotted border-slate-600 text-amber-200">{formatUsd(edge.slippageCostUsd)}</span>
          </Tooltip>
        </div>

        <div className="flex justify-between text-sm items-center">
          <span className="text-slate-400">Gas cost</span>
          <Tooltip content={
            <div className="space-y-1.5">
              <p className="mb-1 font-medium text-slate-200">Gas Breakdown</p>
              <p className="text-slate-400">Total gas for all rebalance phases.</p>
              <div className="mt-1.5 space-y-0.5 border-t border-white/10 pt-1.5">
                <div className="flex justify-between">
                  <span className="text-slate-400">Gas units:</span>
                  <span className="text-white">{costs.totalGasUnits.toLocaleString()}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-slate-400">Cost in PLS:</span>
                  <span className="text-white">{costs.gasCostPLS.toFixed(4)} PLS</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-slate-400">Cost in USD:</span>
                  <span className="text-yellow-400">{formatUsd(costs.gasCostUsd)}</span>
                </div>
              </div>
              <p className="mt-1 text-[10px] text-slate-500">Phases: collect + burn + collect + burn + approve + swap + mint</p>
            </div>
          }>
            <span className="cursor-help border-b border-dotted border-slate-600 text-amber-200">{formatUsd(costs.gasCostUsd)}</span>
          </Tooltip>
        </div>

        <div className="mt-1.5 flex justify-between border-t border-white/10 pt-1.5 text-sm">
          <span className="font-medium text-slate-200">Total cost</span>
          <span className="text-white font-medium">{formatUsd(edge.totalCostUsd)}</span>
        </div>

        <div className="flex justify-between text-sm items-center">
          <span className="text-slate-400">Break-even</span>
          <Tooltip content={
            <div className="space-y-1.5">
              <p className="mb-1 font-medium text-slate-200">Break-even Calculation</p>
              <p className="text-slate-400">Time in range needed to earn back the rebalance cost from fee income.</p>
              <div className="mt-1.5 space-y-0.5 border-t border-white/10 pt-1.5">
                <div className="flex justify-between">
                  <span className="text-slate-400">Rebalance cost:</span>
                  <span className="text-white">{formatUsd(edge.totalCostUsd)}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-slate-400">Position value:</span>
                  <span className="text-white">{formatUsd(positionValueUsd)}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-slate-400">Lifetime APR:</span>
                  <span className="text-white">{lifetimeAPR.toFixed(1)}%</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-slate-400">Hourly income:</span>
                  <span className="text-white">{formatUsd(costs.hourlyIncomeUsd)}/hr</span>
                </div>
                <div className="flex justify-between border-t border-white/10 pt-1">
                  <span className="text-slate-400">Formula:</span>
                  <span className="text-slate-300">cost / hourly income</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-slate-400">Result:</span>
                  <span className="text-blue-400">
                    {formatUsd(edge.totalCostUsd)} / {formatUsd(costs.hourlyIncomeUsd)} = {edge.breakEvenHours > 0 ? `${edge.breakEvenHours.toFixed(1)}hr` : '—'}
                  </span>
                </div>
              </div>
            </div>
          }>
            <span className="cursor-help border-b border-dotted border-slate-600 font-medium text-cyan-200">
              {edge.breakEvenHours > 0 ? formatBreakEven(edge.breakEvenHours) : '—'}
            </span>
          </Tooltip>
        </div>
      </div>
    </div>
  );
}

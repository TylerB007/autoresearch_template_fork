import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { formatUsd, type PositionSummary } from '../api/client';
import StatusBadge from './StatusBadge';
import RangeBar from './RangeBar';
import { STRATEGY_LABELS } from './StrategyForm';
import TokenPairLogos from './TokenPairLogos';
import ChainLogo from './ChainLogo';

function formatAge(ms: number): string {
  if (ms <= 0) return '—';
  const hours = ms / (1000 * 3600);
  if (hours < 24) return `${hours.toFixed(1)}h`;
  const days = hours / 24;
  if (days < 30) return `${days.toFixed(1)}d`;
  const months = days / 30;
  return `${months.toFixed(1)}mo`;
}

interface PositionCardProps {
  position: PositionSummary;
}

export default function PositionCard({ position }: PositionCardProps) {
  const navigate = useNavigate();
  const [flipped, setFlipped] = useState(false);

  const openPosition = () => navigate(`/positions/${position.tokenId}`);
  const earnedValueUsd = position.totalEarningsUsd ?? position.totalFeesUsd;
  const claimableValueUsd = position.claimableYieldUsd ?? position.unclaimedFeesUsd;

  const sym0 = position.pair.split('/')[0];
  const sym1 = position.pair.split('/')[1];
  const displayPair = flipped ? `${sym1}/${sym0}` : position.pair;

  const oorMs = !position.inRange && position.outOfRangeSinceMs != null
    ? Date.now() - position.outOfRangeSinceMs
    : null;

  return (
    <div
      role="button"
      tabIndex={0}
      aria-label={`Open position ${position.tokenId} for ${position.pair}`}
      onClick={openPosition}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          openPosition();
        }
      }}
      className="panel panel-interactive group p-5"
    >
      <div className="mb-4 flex items-start justify-between gap-3">
        <div>
          <div className="mb-1 flex flex-wrap items-center gap-1.5">
            <span className="text-data text-xs text-slate-500">#{position.tokenId}</span>
            {position.chainName && <ChainLogo chainName={position.chainName} />}
            {position.gaugeAddress && (
              <span className="inline-flex items-center rounded-full border border-amber-500/30 bg-amber-500/10 px-2 py-1 text-[10px] font-semibold leading-none text-amber-200">
                Gauge
              </span>
            )}
            {position.inSafeMode && (
              <span className="inline-flex items-center rounded-full border border-rose-400/25 bg-rose-500/10 px-2 py-1 text-[10px] font-semibold leading-none text-rose-200">
                SAFE MODE
              </span>
            )}
            {position.killSwitchTriggered && (
              <span className="inline-flex items-center rounded-full border border-orange-400/25 bg-orange-500/10 px-2 py-1 text-[10px] font-semibold leading-none text-orange-200">
                KILL SWITCH
              </span>
            )}
            {position.rebalanceLocked && (
              <span className="inline-flex items-center rounded-full border border-sky-400/25 bg-sky-500/10 px-2 py-1 text-[10px] font-semibold leading-none text-sky-200">
                REBALANCING
              </span>
            )}
          </div>
          <div className="flex items-center gap-2.5">
            <TokenPairLogos
              symbol0={sym0}
              symbol1={sym1}
              chainId={position.chainId}
              size="md"
            />
            <h3 className="text-lg font-semibold text-white transition-colors duration-200 group-hover:text-sky-100">
              {displayPair}
            </h3>
            {/* Flip pair direction button */}
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); setFlipped((f) => !f); }}
              className="rounded p-0.5 text-slate-500 transition-colors hover:text-slate-300"
              title="Flip pair direction"
              aria-label="Flip pair direction"
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M7 16V4m0 0L3 8m4-4l4 4M17 8v12m0 0l4-4m-4 4l-4-4" />
              </svg>
            </button>
          </div>
        </div>
        <div className="flex flex-col items-end gap-1">
          <StatusBadge inRange={position.inRange} />
          {oorMs != null && (
            <span className="text-[10px] tabular-nums text-rose-300/70">
              {formatAge(oorMs)} OOR
            </span>
          )}
        </div>
      </div>
      <div className="mb-4 flex items-center justify-between gap-3">
        <span className="text-sm text-slate-400">
          {STRATEGY_LABELS[position.strategy] || position.strategy}
        </span>
        <div className="flex items-center gap-3 text-data">
          {position.positionValueUsd != null && position.positionValueUsd > 0 && (
            <span className="text-xs font-medium text-sky-300">{formatUsd(position.positionValueUsd)}</span>
          )}
          {position.lifetimeAPR != null && position.lifetimeAPR > 0 && (
            <span className="text-xs font-medium text-emerald-300">{position.lifetimeAPR.toFixed(1)}% APR</span>
          )}
        </div>
      </div>

      {/* Metrics row */}
      <div className="mb-4 grid grid-cols-2 gap-3 text-xs sm:grid-cols-4">
        <div>
          <span className="text-slate-500">Earned</span>
          <p className="text-data font-medium text-slate-100">
            {earnedValueUsd != null && earnedValueUsd > 0
              ? formatUsd(earnedValueUsd)
              : '—'}
          </p>
        </div>
        <div>
          <span className="text-slate-500">Claimable</span>
          <p className="text-data font-medium text-amber-200">
            {claimableValueUsd != null && claimableValueUsd > 0
              ? formatUsd(claimableValueUsd)
              : '—'}
          </p>
        </div>
        <div>
          <span className="text-slate-500">Age</span>
          <p className="text-data font-medium text-slate-100">
            {position.ageMs != null ? formatAge(position.ageMs) : '—'}
          </p>
        </div>
        <div>
          <span className="text-slate-500">Rebalances</span>
          <p className="text-data font-medium text-slate-100">
            {position.rebalanceCount != null ? position.rebalanceCount : '—'}
          </p>
        </div>
      </div>

      <RangeBar
        tickLower={position.tickLower}
        tickUpper={position.tickUpper}
        currentTick={position.currentTick}
        token0Decimals={position.token0Decimals}
        token1Decimals={position.token1Decimals}
        token0Symbol={sym0}
        token1Symbol={sym1}
        invert={flipped}
      />
    </div>
  );
}

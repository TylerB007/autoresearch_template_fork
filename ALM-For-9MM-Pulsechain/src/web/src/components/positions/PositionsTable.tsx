import { useState, useMemo, memo } from 'react';
import { useNavigate } from 'react-router-dom';
import { formatUsd, type PositionSummary } from '../../api/client.js';
import { STRATEGY_LABELS } from '../StrategyForm.js';
import RangeMiniBar from './RangeMiniBar.js';
import TokenPairLogos from '../TokenPairLogos.js';
import ChainLogo from '../ChainLogo.js';

function formatAge(ms: number): string {
  if (ms <= 0) return '—';
  const hours = ms / (1000 * 3600);
  if (hours < 24) return `${hours.toFixed(1)}h`;
  const days = hours / 24;
  if (days < 30) return `${days.toFixed(1)}d`;
  const months = days / 30;
  return `${months.toFixed(1)}mo`;
}

function aprColor(apr: number | undefined): string {
  if (apr == null) return 'text-slate-500';
  if (apr > 100) return 'text-emerald-300';
  if (apr >= 40) return 'text-teal-400';
  return 'text-slate-400';
}

type SortKey = 'positionValueUsd' | 'lifetimeAPR' | 'totalEarningsUsd' | 'claimableYieldUsd' | 'ageMs' | 'rebalanceCount';
type SortDir = 'asc' | 'desc';

interface TableSummary {
  totalPositions: number;
  totalValueUsd: number;
  totalFeesUsd: number;
  avgAPR: number | null;
  inRangeCount: number;
}

function computeSummary(positions: PositionSummary[]): TableSummary {
  const totalValueUsd = positions.reduce((s, p) => s + (p.positionValueUsd ?? 0), 0);
  const totalFeesUsd = positions.reduce((s, p) => s + (p.totalEarningsUsd ?? p.totalFeesUsd ?? 0), 0);
  const aprs = positions.map((p) => p.lifetimeAPR).filter((v): v is number => v != null);
  const avgAPR = aprs.length > 0 ? aprs.reduce((s, v) => s + v, 0) / aprs.length : null;
  const inRangeCount = positions.filter((p) => p.inRange).length;
  return { totalPositions: positions.length, totalValueUsd, totalFeesUsd, avgAPR, inRangeCount };
}

function sortPositions(positions: PositionSummary[], key: SortKey | null, dir: SortDir): PositionSummary[] {
  // Always show OOR positions first, then sort by key within each group
  return [...positions].sort((a, b) => {
    // OOR-first primary sort
    if (a.inRange !== b.inRange) return a.inRange ? 1 : -1;
    // Secondary: user-selected sort key
    if (!key) return 0;
    const av = (a[key] as number | undefined) ?? -Infinity;
    const bv = (b[key] as number | undefined) ?? -Infinity;
    return dir === 'asc' ? av - bv : bv - av;
  });
}

function SortableHeader({
  label,
  sortKey,
  currentKey,
  dir,
  onSort,
  className = '',
}: {
  label: string;
  sortKey: SortKey;
  currentKey: SortKey | null;
  dir: SortDir;
  onSort: (key: SortKey) => void;
  className?: string;
}) {
  const active = currentKey === sortKey;
  return (
    <th
      className={`cursor-pointer select-none hover:text-slate-200 ${className}`}
      onClick={() => onSort(sortKey)}
    >
      {label}
      <span className="ml-1 text-[10px] opacity-50">{active ? (dir === 'desc' ? '↓' : '↑') : '⇅'}</span>
    </th>
  );
}

/** Individual table row — has its own flip state so pair direction is per-row */
function PositionRow({ pos }: { pos: PositionSummary }) {
  const navigate = useNavigate();
  const [flipped, setFlipped] = useState(false);

  const earnedUsd = pos.totalEarningsUsd ?? pos.totalFeesUsd;
  const claimableUsd = pos.claimableYieldUsd ?? pos.unclaimedFeesUsd;
  const sym0 = pos.pair.split('/')[0];
  const sym1 = pos.pair.split('/')[1];
  const displayPair = flipped ? `${sym1}/${sym0}` : pos.pair;

  const oorMs = !pos.inRange && pos.outOfRangeSinceMs != null
    ? Date.now() - pos.outOfRangeSinceMs
    : null;

  return (
    <tr
      className={[
        'cursor-pointer transition-colors hover:bg-white/[0.02]',
        pos.killSwitchTriggered ? 'opacity-50' : '',
        pos.inSafeMode ? 'bg-amber-500/5' : '',
      ].filter(Boolean).join(' ')}
      style={{ borderLeft: pos.inRange ? '3px solid transparent' : '3px solid var(--danger)' }}
      onClick={() => navigate(`/positions/${pos.tokenId}`)}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => { if (e.key === 'Enter') navigate(`/positions/${pos.tokenId}`); }}
      aria-label={`Open position ${pos.tokenId} for ${pos.pair}`}
    >
      {/* Pool */}
      <td>
        <div className="flex items-center gap-2">
          <TokenPairLogos
            symbol0={sym0}
            symbol1={sym1}
            chainId={pos.chainId}
            size="sm"
          />
          <div className="flex items-center gap-1.5">
            <span className="font-semibold text-white">{displayPair}</span>
            <span className="text-data text-[10px] text-slate-500">#{pos.tokenId}</span>
            {/* Flip button */}
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); setFlipped((f) => !f); }}
              className="rounded p-0.5 text-slate-600 transition-colors hover:text-slate-300"
              title="Flip pair direction"
              aria-label="Flip pair direction"
            >
              <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M7 16V4m0 0L3 8m4-4l4 4M17 8v12m0 0l4-4m-4 4l-4-4" />
              </svg>
            </button>
          </div>
        </div>
        {(pos.inSafeMode || pos.killSwitchTriggered || pos.rebalanceLocked || pos.gaugeAddress) && (
          <div className="mt-0.5 flex flex-wrap gap-1">
            {pos.inSafeMode && (
              <span className="inline-flex items-center rounded-full border border-rose-400/25 bg-rose-500/10 px-1.5 py-0.5 text-[9px] font-semibold leading-none text-rose-200">
                SAFE MODE
              </span>
            )}
            {pos.killSwitchTriggered && (
              <span className="inline-flex items-center rounded-full border border-orange-400/25 bg-orange-500/10 px-1.5 py-0.5 text-[9px] font-semibold leading-none text-orange-200">
                KILL SWITCH
              </span>
            )}
            {pos.rebalanceLocked && (
              <span className="inline-flex items-center rounded-full border border-sky-400/25 bg-sky-500/10 px-1.5 py-0.5 text-[9px] font-semibold leading-none text-sky-200">
                REBALANCING
              </span>
            )}
            {pos.gaugeAddress && (
              <span className="inline-flex items-center rounded-full border border-amber-500/30 bg-amber-500/10 px-1.5 py-0.5 text-[9px] font-semibold leading-none text-amber-200">
                GAUGE
              </span>
            )}
          </div>
        )}
      </td>

      {/* Chain */}
      <td>
        {pos.chainName && <ChainLogo chainName={pos.chainName} />}
      </td>

      {/* Status + OOR duration */}
      <td>
        <div className="flex flex-col gap-0.5">
          <span className={`flex items-center gap-1.5 text-xs font-medium ${pos.inRange ? 'text-emerald-300' : 'text-rose-300'}`}>
            <span className={`h-2 w-2 rounded-full ${pos.inRange ? 'bg-emerald-400' : 'bg-rose-400'}`} />
            {pos.inRange ? 'In Range' : 'Out'}
          </span>
          {oorMs != null && (
            <span className="text-[10px] tabular-nums text-rose-300/60">
              {formatAge(oorMs)} OOR
            </span>
          )}
        </div>
      </td>

      {/* Strategy */}
      <td className="max-w-[140px] truncate text-sm text-slate-300">
        {STRATEGY_LABELS[pos.strategy] || pos.strategy}
      </td>

      {/* Value */}
      <td className="text-right text-data text-slate-100">
        {pos.positionValueUsd != null && pos.positionValueUsd > 0
          ? formatUsd(pos.positionValueUsd)
          : <span className="text-slate-600">—</span>}
      </td>

      {/* APR */}
      <td className={`text-right text-data font-medium ${aprColor(pos.lifetimeAPR)}`}>
        {pos.lifetimeAPR != null && pos.lifetimeAPR > 0
          ? `${pos.lifetimeAPR.toFixed(1)}%`
          : <span className="text-slate-600">—</span>}
      </td>

      {/* Fees earned */}
      <td className="text-right text-data text-slate-100">
        {earnedUsd != null && earnedUsd > 0
          ? formatUsd(earnedUsd)
          : <span className="text-slate-600">—</span>}
      </td>

      {/* Unclaimed */}
      <td className="text-right text-data text-amber-200">
        {claimableUsd != null && claimableUsd > 0
          ? formatUsd(claimableUsd)
          : <span className="text-slate-600">—</span>}
      </td>

      {/* Age */}
      <td className="text-right text-data text-slate-300">
        {pos.ageMs != null ? formatAge(pos.ageMs) : <span className="text-slate-600">—</span>}
      </td>

      {/* Rebalances */}
      <td className="text-right text-data text-slate-300">
        {pos.rebalanceCount ?? <span className="text-slate-600">—</span>}
      </td>

      {/* Range mini bar */}
      <td onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
        <RangeMiniBar
          tickLower={pos.tickLower}
          tickUpper={pos.tickUpper}
          currentTick={pos.currentTick}
          token0Decimals={pos.token0Decimals}
          token1Decimals={pos.token1Decimals}
          token0Symbol={flipped ? sym1 : sym0}
          token1Symbol={flipped ? sym0 : sym1}
          invert={flipped}
        />
      </td>

      {/* Actions */}
      <td className="text-right" onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
        <button
          onClick={() => navigate(`/positions/${pos.tokenId}`)}
          className="action-button action-button-secondary px-2.5 py-1 text-xs"
        >
          Details
        </button>
      </td>
    </tr>
  );
}

interface PositionsTableProps {
  positions: PositionSummary[];
}

export default memo(function PositionsTable({ positions }: PositionsTableProps) {
  const [sortKey, setSortKey] = useState<SortKey | null>(null);
  const [sortDir, setSortDir] = useState<SortDir>('desc');

  const sorted = useMemo(() => sortPositions(positions, sortKey, sortDir), [positions, sortKey, sortDir]);
  const summary = useMemo(() => computeSummary(positions), [positions]);

  const handleSort = (key: SortKey) => {
    if (sortKey === key) setSortDir((d) => (d === 'desc' ? 'asc' : 'desc'));
    else { setSortKey(key); setSortDir('desc'); }
  };

  return (
    <div className="space-y-3">
      {/* Summary bar */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 px-1 text-xs text-slate-400">
        <span>
          Total Positions:{' '}
          <span className="text-white">{summary.totalPositions}</span>
        </span>
        <span className="text-slate-600">|</span>
        <span>
          Total Value:{' '}
          <span className="text-data text-white">{formatUsd(summary.totalValueUsd)}</span>
        </span>
        <span className="text-slate-600">|</span>
        <span>
          Total Fees:{' '}
          <span className="text-data text-white">{formatUsd(summary.totalFeesUsd)}</span>
        </span>
        <span className="text-slate-600">|</span>
        <span>
          Avg APR:{' '}
          <span className={`text-data ${summary.avgAPR != null ? aprColor(summary.avgAPR) : 'text-slate-500'}`}>
            {summary.avgAPR != null ? `${summary.avgAPR.toFixed(1)}%` : '—'}
          </span>
        </span>
        <span className="text-slate-600">|</span>
        <span>
          In Range:{' '}
          <span className={`text-data ${summary.inRangeCount === summary.totalPositions ? 'text-emerald-300' : 'text-amber-300'}`}>
            {summary.inRangeCount}/{summary.totalPositions}
          </span>
        </span>
      </div>

      {/* Table */}
      <div className="table-shell overflow-x-auto">
        <table className="min-w-full">
          <thead>
            <tr>
              <th className="text-left">Pool</th>
              <th className="text-left">Chain</th>
              <th className="text-left">Status</th>
              <th className="text-left">Strategy</th>
              <SortableHeader label="Value" sortKey="positionValueUsd" currentKey={sortKey} dir={sortDir} onSort={handleSort} className="text-right" />
              <SortableHeader label="APR" sortKey="lifetimeAPR" currentKey={sortKey} dir={sortDir} onSort={handleSort} className="text-right" />
              <SortableHeader label="Fees" sortKey="totalEarningsUsd" currentKey={sortKey} dir={sortDir} onSort={handleSort} className="text-right" />
              <SortableHeader label="Unclaimed" sortKey="claimableYieldUsd" currentKey={sortKey} dir={sortDir} onSort={handleSort} className="text-right" />
              <SortableHeader label="Age" sortKey="ageMs" currentKey={sortKey} dir={sortDir} onSort={handleSort} className="text-right" />
              <SortableHeader label="Reb." sortKey="rebalanceCount" currentKey={sortKey} dir={sortDir} onSort={handleSort} className="text-right" />
              <th className="text-left">Range</th>
              <th className="text-right">Actions</th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((pos) => (
              <PositionRow key={pos.tokenId} pos={pos} />
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
});

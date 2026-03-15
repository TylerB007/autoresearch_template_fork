import { useState, useEffect, useCallback, useMemo } from 'react';
import {
  getRebalanceHistory, getEventLog,
  tickToPrice, formatPrice, formatTokenAmount,
  type RebalanceEvent, type LifecycleEvent, type RebalanceEventType,
} from '../api/client';
import { REFRESH_EVENT } from '../components/Navbar';
import { useChain } from '../context/ChainContext';

/** Group lifecycle events by rebalanceId */
function groupEvents(events: LifecycleEvent[]): Map<string, LifecycleEvent[]> {
  const map = new Map<string, LifecycleEvent[]>();
  for (const e of events) {
    const list = map.get(e.rebalanceId) ?? [];
    list.push(e);
    map.set(e.rebalanceId, list);
  }
  return map;
}

/** Unified timeline item: either a completed rebalance with events, or an event-only group */
interface TimelineItem {
  rebalanceId: string;
  timestamp: number;
  rebalance?: RebalanceEvent;
  events: LifecycleEvent[];
  status: 'completed' | 'failed' | 'in_progress';
}

function buildTimeline(rebalances: RebalanceEvent[], events: LifecycleEvent[]): TimelineItem[] {
  const eventGroups = groupEvents(events);
  const items: TimelineItem[] = [];
  const usedRebalanceIds = new Set<string>();

  // Add completed rebalances with their events
  for (const rb of rebalances) {
    usedRebalanceIds.add(rb.rebalanceId);
    items.push({
      rebalanceId: rb.rebalanceId,
      timestamp: rb.timestamp,
      rebalance: rb,
      events: eventGroups.get(rb.rebalanceId) ?? [],
      status: 'completed',
    });
  }

  // Add event-only groups (failed or in-progress rebalances)
  for (const [rebalanceId, evts] of eventGroups) {
    if (usedRebalanceIds.has(rebalanceId)) continue;
    const hasFailed = evts.some(e => e.eventType === 'rebalance_failed');
    const firstEvent = evts[0];
    items.push({
      rebalanceId,
      timestamp: firstEvent.timestamp,
      events: evts,
      status: hasFailed ? 'failed' : 'in_progress',
    });
  }

  // Sort by timestamp descending (most recent first)
  return items.sort((a, b) => b.timestamp - a.timestamp);
}

export default function RebalanceHistory() {
  const [rebalances, setRebalances] = useState<RebalanceEvent[]>([]);
  const [events, setEvents] = useState<LifecycleEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [days, setDays] = useState(30);

  const fetchHistory = useCallback(() => {
    setLoading(true);
    Promise.all([
      getRebalanceHistory(days).catch(() => ({ rebalances: [] as RebalanceEvent[] })),
      getEventLog(days).catch(() => ({ events: [] as LifecycleEvent[] })),
    ])
      .then(([rbRes, evtRes]) => {
        setRebalances(rbRes.rebalances);
        setEvents(evtRes.events);
        setError('');
      })
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, [days]);

  useEffect(() => { fetchHistory(); }, [fetchHistory]);

  useEffect(() => {
    window.addEventListener(REFRESH_EVENT, fetchHistory);
    return () => window.removeEventListener(REFRESH_EVENT, fetchHistory);
  }, [fetchHistory]);

  const timeline = useMemo(() => buildTimeline(rebalances, events), [rebalances, events]);

  if (loading) {
    return (
      <div className="panel flex h-64 items-center justify-center">
        <span className="text-slate-400">Loading history...</span>
      </div>
    );
  }

  if (error) {
    return (
      <div className="mx-auto max-w-7xl px-4 py-6">
        <div className="rounded-3xl border border-red-400/30 bg-red-500/10 p-4">
          <p className="text-red-200">Error: {error}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-7xl space-y-6 px-4 py-6 sm:px-6 lg:px-8">
      <section className="panel overflow-hidden">
        <div className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-cyan-400/50 to-transparent" />
        <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
          <div>
            <h1 className="text-3xl font-semibold tracking-tight text-white">History</h1>
            <p className="mt-2 max-w-3xl text-sm leading-6 text-slate-300">
              Unified timeline of completed rebalances and lifecycle events. Execution paths, failures, and range transitions are grouped by rebalance identity.
            </p>
          </div>
        <div className="flex items-center gap-2">
          <span className="text-sm text-slate-400">Period:</span>
          {[7, 30, 90, 365].map((d) => (
            <button
              key={d}
              onClick={() => setDays(d)}
              className={`rounded-full px-3 py-1 text-sm transition-colors ${
                days === d
                  ? 'border border-cyan-400/30 bg-cyan-400 text-slate-950'
                  : 'border border-white/10 bg-white/5 text-slate-300 hover:bg-white/10 hover:text-white'
              }`}
            >
              {d}d
            </button>
          ))}
        </div>
        </div>
      </section>

      {timeline.length === 0 ? (
        <div className="panel py-8 text-center">
          <p className="text-slate-500">No activity in the last {days} days.</p>
        </div>
      ) : (
        <div className="space-y-4">
          {timeline.map((item) => (
            <TimelineCard key={item.rebalanceId} item={item} />
          ))}
        </div>
      )}
    </div>
  );
}

// ============================================================
// Timeline Card — completed rebalance or event-only group
// ============================================================

function TimelineCard({ item }: { item: TimelineItem }) {
  const [expanded, setExpanded] = useState(false);

  if (item.rebalance) {
    return (
      <CompletedRebalanceCard
        rb={item.rebalance}
        events={item.events}
        expanded={expanded}
        onToggle={() => setExpanded(!expanded)}
      />
    );
  }

  return (
    <EventOnlyCard
      item={item}
      expanded={expanded}
      onToggle={() => setExpanded(!expanded)}
    />
  );
}

// ============================================================
// Completed Rebalance Card (existing design + event timeline)
// ============================================================

function CompletedRebalanceCard({
  rb, events, expanded, onToggle,
}: {
  rb: RebalanceEvent;
  events: LifecycleEvent[];
  expanded: boolean;
  onToggle: () => void;
}) {
  const { chain, txUrl } = useChain();
  const pre = rb.preSnapshot;
  const d0 = pre.token0Decimals;
  const d1 = pre.token1Decimals;
  const sym0 = pre.token0Symbol;
  const sym1 = pre.token1Symbol;

  const oldPriceLower = formatPrice(tickToPrice(pre.tickLower, d0, d1));
  const oldPriceUpper = formatPrice(tickToPrice(pre.tickUpper, d0, d1));
  const newPriceLower = formatPrice(tickToPrice(rb.newTickLower, d0, d1));
  const newPriceUpper = formatPrice(tickToPrice(rb.newTickUpper, d0, d1));
  const priceUnit = `${sym1}/${sym0}`;

  const date = new Date(rb.timestamp).toLocaleString();
  const netROI = rb.metrics.netROIPercent;
  const roiColor = netROI >= 0 ? 'text-green-400' : 'text-red-400';

  return (
    <div className="overflow-hidden rounded-[28px] border border-white/10 bg-white/[0.03]">
      {/* Summary row */}
      <button
        onClick={onToggle}
        className="flex w-full items-center justify-between px-5 py-4 text-left transition-colors hover:bg-white/[0.04]"
      >
        <div className="flex items-center gap-3">
          <StatusDot status="completed" />
          <div>
            <p className="text-sm font-medium text-white">{date}</p>
            <p className="text-xs text-slate-500">
              #{rb.oldTokenId} &rarr; #{rb.newTokenId} &middot; {rb.strategy}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-6 text-sm">
          {rb.recordQuality?.isPartial && (
            <span className="rounded bg-amber-900/40 px-1.5 py-0.5 text-xs text-amber-300">partial</span>
          )}
          <div className="text-right">
            <p className="text-xs text-slate-500">Fees</p>
            <p className="text-white">
              {formatTokenAmount(rb.feesCollected0, d0)} {sym0} + {formatTokenAmount(rb.feesCollected1, d1)} {sym1}
            </p>
          </div>
          <div className="text-right">
            <p className="text-xs text-slate-500">Gas</p>
            <p className="text-white">{rb.totalGasCostPLS.toLocaleString(undefined, { maximumFractionDigits: 0 })} {chain.nativeCurrencySymbol}</p>
          </div>
          <div className="text-right">
            <p className="text-xs text-slate-500">Net ROI</p>
            <p className={`font-semibold ${roiColor}`}>{netROI.toFixed(2)}%</p>
          </div>
          <span className="text-xs text-slate-500">{expanded ? '▲' : '▼'}</span>
        </div>
      </button>

      {/* Expanded details */}
      {expanded && (
        <div className="space-y-4 border-t border-white/10 px-5 pb-5 pt-4">
          {/* Event Timeline */}
          {events.length > 0 && (
            <div>
              <p className="mb-2 text-xs uppercase tracking-[0.22em] text-slate-500">Steps</p>
              <EventTimeline events={events} />
            </div>
          )}

          {/* Range transition */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <p className="mb-1 text-xs uppercase tracking-[0.22em] text-slate-500">Old Range</p>
              <p className="text-sm text-white">
                {oldPriceLower} — {oldPriceUpper} {priceUnit}
              </p>
              <p className="mt-0.5 text-xs text-slate-500">
                Ticks: {pre.tickLower} to {pre.tickUpper}
              </p>
            </div>
            <div>
              <p className="mb-1 text-xs uppercase tracking-[0.22em] text-slate-500">New Range</p>
              <p className="text-sm text-white">
                {newPriceLower} — {newPriceUpper} {priceUnit}
              </p>
              <p className="mt-0.5 text-xs text-slate-500">
                Ticks: {rb.newTickLower} to {rb.newTickUpper}
              </p>
            </div>
          </div>

          {/* Swap details */}
          {rb.swap && (
            <div>
              <p className="mb-1 text-xs uppercase tracking-[0.22em] text-slate-500">Swap</p>
              <p className="text-sm text-white">
                {rb.swap.tokenIn === 'token0'
                  ? `${formatTokenAmount(rb.swap.amountIn, d0)} ${sym0} → ${formatTokenAmount(rb.swap.amountOut, d1)} ${sym1}`
                  : `${formatTokenAmount(rb.swap.amountIn, d1)} ${sym1} → ${formatTokenAmount(rb.swap.amountOut, d0)} ${sym0}`
                }
              </p>
              <p className="mt-1 text-xs text-slate-500">
                Configured tolerance:{' '}
                {rb.swap.configuredSlippageBps != null
                  ? `${(rb.swap.configuredSlippageBps / 100).toFixed(2)}%`
                  : 'legacy record'}
                {' '}| Realized exec delta: {((rb.swap.realizedExecutionDeltaBps ?? rb.swap.slippageBps) / 100).toFixed(2)}%
              </p>
            </div>
          )}

          {/* Metrics grid */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <MetricCell label="Fee APR" value={`${rb.metrics.feeAPR.toFixed(2)}%`} />
            <MetricCell label="Time in Range" value={`${rb.metrics.timeInRangePercent.toFixed(1)}%`} />
            <MetricCell label="Duration" value={`${rb.metrics.durationDays.toFixed(1)}d`} />
            <MetricCell
              label="Fees / Full Exec Cost"
              value={rb.metrics.feesToExecutionCostRatio == null
                ? '—'
                : Number.isFinite(rb.metrics.feesToExecutionCostRatio)
                  ? `${rb.metrics.feesToExecutionCostRatio.toFixed(2)}x`
                  : 'Infinity'}
            />
            <MetricCell
              label="Impermanent Loss"
              value={`${rb.metrics.impermanentLossPercent.toFixed(3)}%`}
              color="text-orange-400"
            />
            <MetricCell
              label="Net ROI"
              value={`${rb.metrics.netROIPercent.toFixed(3)}%`}
              color={rb.metrics.netROIPercent >= 0 ? 'text-green-400' : 'text-red-400'}
            />
            <MetricCell label="Cap. Efficiency" value={`${rb.metrics.capitalEfficiencyRatio.toFixed(2)}x`} />
            <MetricCell label="Gas Cost" value={`${rb.totalGasCostPLS.toLocaleString(undefined, { maximumFractionDigits: 0 })} ${chain.nativeCurrencySymbol}`} />
          </div>
          {rb.recordQuality?.isPartial && (
            <p className="text-xs text-amber-300">
              Execution-cost quality: {rb.recordQuality.executionCostQuality}. Missing: {rb.recordQuality.missingFields.join(', ')}.
            </p>
          )}

          {/* Transaction hashes */}
          <div>
            <p className="mb-2 text-xs uppercase tracking-[0.22em] text-slate-500">Transactions</p>
            <div className="flex flex-wrap gap-2">
              <TxLink label="Collect" hash={rb.txHashes.collectFees} txUrl={txUrl} />
              <TxLink label="Remove" hash={rb.txHashes.decreaseLiquidity} txUrl={txUrl} />
              {rb.txHashes.swap && <TxLink label="Swap" hash={rb.txHashes.swap} txUrl={txUrl} />}
              <TxLink label="Mint" hash={rb.txHashes.mint} txUrl={txUrl} />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ============================================================
// Event-Only Card (failed / in-progress rebalances)
// ============================================================

function EventOnlyCard({
  item, expanded, onToggle,
}: {
  item: TimelineItem;
  expanded: boolean;
  onToggle: () => void;
}) {
  const firstEvent = item.events[0];
  const failedEvent = item.events.find(e => e.eventType === 'rebalance_failed');
  const date = new Date(item.timestamp).toLocaleString();
  const strategy = firstEvent?.strategy ?? 'unknown';
  const tokenId = firstEvent?.tokenId;

  const borderColor = item.status === 'failed' ? 'border-red-800/60' : 'border-yellow-800/60';

  return (
    <div className={`overflow-hidden rounded-[28px] border bg-white/[0.03] ${borderColor}`}>
      <button
        onClick={onToggle}
        className="flex w-full items-center justify-between px-5 py-4 text-left transition-colors hover:bg-white/[0.04]"
      >
        <div className="flex items-center gap-3">
          <StatusDot status={item.status} />
          <div>
            <p className="text-sm font-medium text-white">{date}</p>
            <p className="text-xs text-slate-500">
              #{tokenId} &middot; {strategy}
              {item.status === 'failed' && (
                <span className="text-red-400 ml-2">
                  Failed at {failedEvent?.failedAtStep ?? 'unknown step'}
                </span>
              )}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-4 text-sm">
          <span className={`text-xs font-medium px-2 py-0.5 rounded ${
            item.status === 'failed'
              ? 'bg-red-900/40 text-red-400'
              : 'bg-yellow-900/40 text-yellow-400'
          }`}>
            {item.status === 'failed' ? 'Failed' : 'In Progress'}
          </span>
          <span className="text-xs text-slate-500">{expanded ? '▲' : '▼'}</span>
        </div>
      </button>

      {expanded && (
        <div className="space-y-3 border-t border-white/10 px-5 pb-5 pt-4">
          <EventTimeline events={item.events} />
          {failedEvent?.error && (
            <div className="rounded-2xl border border-red-400/20 bg-red-500/10 p-3">
              <p className="text-xs text-red-400 font-medium">Error</p>
              <p className="text-sm text-red-300 mt-1 break-all">{failedEvent.error}</p>
              {failedEvent.enteredSafeMode !== undefined && (
                <p className="mt-1 text-xs text-slate-500">
                  Safe mode: {failedEvent.enteredSafeMode ? 'Yes — manual intervention required' : 'No — will retry automatically'}
                </p>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ============================================================
// Event Timeline — vertical step-by-step display
// ============================================================

const EVENT_CONFIG: Record<RebalanceEventType, { label: string; color: string; icon: string }> = {
  rebalance_triggered: { label: 'Triggered', color: 'text-blue-400', icon: '●' },
  fees_collected:      { label: 'Fees Collected', color: 'text-slate-300', icon: '●' },
  position_exited:     { label: 'Position Exited', color: 'text-slate-300', icon: '●' },
  swap_executed:       { label: 'Swap', color: 'text-slate-300', icon: '●' },
  position_opened:     { label: 'Position Opened', color: 'text-slate-300', icon: '●' },
  rebalance_completed: { label: 'Completed', color: 'text-green-400', icon: '✓' },
  rebalance_failed:    { label: 'Failed', color: 'text-red-400', icon: '✗' },
};

function EventTimeline({ events }: { events: LifecycleEvent[] }) {
  const { txUrl } = useChain();
  const sorted = [...events].sort((a, b) => a.timestamp - b.timestamp);
  const firstTs = sorted[0]?.timestamp ?? 0;

  return (
    <div className="space-y-0">
      {sorted.map((evt, i) => {
        const cfg = EVENT_CONFIG[evt.eventType];
        const isLast = i === sorted.length - 1;
        const relativeMs = evt.timestamp - firstTs;
        const relativeLabel = relativeMs < 1000 ? '' : `+${(relativeMs / 1000).toFixed(0)}s`;
        const time = new Date(evt.timestamp).toLocaleTimeString();

        return (
          <div key={`${evt.eventType}-${evt.timestamp}`} className="flex gap-3">
            {/* Timeline line + dot */}
            <div className="flex flex-col items-center w-4 flex-shrink-0">
              <span className={`text-xs ${cfg.color}`}>{cfg.icon}</span>
              {!isLast && <div className="my-0.5 w-px flex-1 bg-white/10" />}
            </div>

            {/* Content */}
            <div className="flex-1 pb-3 min-w-0">
              <div className="flex items-baseline gap-2 flex-wrap">
                <span className={`text-xs font-medium ${cfg.color}`}>{cfg.label}</span>
                <span className="text-xs text-slate-600">{time}</span>
                {relativeLabel && <span className="text-xs text-slate-600">{relativeLabel}</span>}
                {evt.txHash && (
                  <a
                    href={txUrl(evt.txHash)}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-xs text-cyan-300 transition-colors hover:text-cyan-200"
                  >
                    tx
                  </a>
                )}
              </div>
              <EventDescription evt={evt} />
            </div>
          </div>
        );
      })}
    </div>
  );
}

function EventDescription({ evt }: { evt: LifecycleEvent }) {
  const sym0 = evt.token0Symbol ?? 'token0';
  const sym1 = evt.token1Symbol ?? 'token1';
  const d0 = evt.token0Decimals ?? 18;
  const d1 = evt.token1Decimals ?? 18;

  switch (evt.eventType) {
    case 'rebalance_triggered':
      return (
        <p className="mt-0.5 truncate text-xs text-slate-500">
          {evt.strategy} — {evt.reason}
        </p>
      );
    case 'fees_collected':
      return evt.amount0 || evt.amount1 ? (
        <p className="mt-0.5 text-xs text-slate-500">
          {formatTokenAmount(evt.amount0 ?? '0', d0)} {sym0} + {formatTokenAmount(evt.amount1 ?? '0', d1)} {sym1}
        </p>
      ) : null;
    case 'position_exited':
      return evt.amount0 || evt.amount1 ? (
        <p className="mt-0.5 text-xs text-slate-500">
          Removed {formatTokenAmount(evt.amount0 ?? '0', d0)} {sym0} + {formatTokenAmount(evt.amount1 ?? '0', d1)} {sym1}
        </p>
      ) : null;
    case 'swap_executed':
      if (!evt.swap) return null;
      return (
        <p className="mt-0.5 text-xs text-slate-500">
          {evt.swap.tokenIn === 'token0'
            ? `${formatTokenAmount(evt.swap.amountIn, d0)} ${sym0} → ${formatTokenAmount(evt.swap.amountOut, d1)} ${sym1}`
            : `${formatTokenAmount(evt.swap.amountIn, d1)} ${sym1} → ${formatTokenAmount(evt.swap.amountOut, d0)} ${sym0}`
          }
        </p>
      );
    case 'position_opened':
      return (
        <p className="mt-0.5 text-xs text-slate-500">
          #{evt.newTokenId} — ticks [{evt.newTickLower}, {evt.newTickUpper}]
        </p>
      );
    case 'rebalance_failed':
      return (
        <p className="text-xs text-red-400/70 mt-0.5 truncate">
          Step: {evt.failedAtStep}{evt.enteredSafeMode ? ' — entered safe mode' : ' — will retry'}
        </p>
      );
    case 'rebalance_completed':
      return evt.newTokenId ? (
        <p className="text-xs text-green-400/70 mt-0.5">
          New position #{evt.newTokenId}
        </p>
      ) : null;
    default:
      return null;
  }
}

// ============================================================
// Shared Components
// ============================================================

function StatusDot({ status }: { status: 'completed' | 'failed' | 'in_progress' }) {
  const colors = {
    completed: 'bg-green-500',
    failed: 'bg-red-500',
    in_progress: 'bg-yellow-500',
  };
  return <span className={`w-2 h-2 rounded-full flex-shrink-0 ${colors[status]}`} />;
}

function MetricCell({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-2.5">
      <p className="text-xs text-slate-500">{label}</p>
      <p className={`text-sm font-medium mt-0.5 ${color ?? 'text-white'}`}>{value}</p>
    </div>
  );
}

function TxLink({ label, hash, txUrl }: { label: string; hash: string; txUrl: (h: string) => string }) {
  if (!hash) return null;
  const short = `${hash.slice(0, 6)}...${hash.slice(-4)}`;
  return (
    <a
      href={txUrl(hash)}
      target="_blank"
      rel="noopener noreferrer"
      className="inline-flex items-center gap-1 rounded-full border border-white/10 bg-white/[0.03] px-2.5 py-1.5 text-xs text-cyan-300 transition-colors hover:bg-white/[0.06] hover:text-cyan-200"
    >
      {label}: {short}
    </a>
  );
}

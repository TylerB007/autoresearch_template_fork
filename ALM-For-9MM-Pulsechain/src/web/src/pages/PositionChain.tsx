import { useEffect, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { getPositionChain, type PositionChainData, type ChainLink } from '../api/client';

function formatDuration(ms: number): string {
  const hours = ms / (1000 * 3600);
  if (hours < 24) return `${hours.toFixed(1)}h`;
  const days = hours / 24;
  return `${days.toFixed(1)}d`;
}

function formatDate(ts: number): string {
  return new Date(ts).toLocaleDateString(undefined, {
    month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
  });
}

function LinkCard({ link, isLast }: { link: ChainLink; isLast: boolean }) {
  const isActive = link.burnTimestamp === null;
  const isManual = link.isManualLink === true;

  return (
    <div className="relative">
      {/* Timeline connector */}
      {!isLast && (
        <div className={`absolute left-6 top-16 h-full w-0.5 ${isManual ? 'border-l-2 border-dashed border-fuchsia-400/30' : 'bg-white/10'}`} />
      )}
      <div className={`flex gap-4 ${isActive ? 'opacity-100' : 'opacity-80'}`}>
        {/* Timeline dot */}
        <div className="flex-shrink-0 mt-4">
          <div className={`flex h-12 w-12 items-center justify-center rounded-full text-sm font-bold ${
            isManual ? 'bg-fuchsia-500/20 text-fuchsia-200' :
            isActive ? 'bg-emerald-400 text-slate-950' : 'bg-white/10 text-slate-300'
          }`}>
            #{link.tokenId}
          </div>
        </div>
        {/* Card content */}
        <div className={`mb-4 flex-1 rounded-[24px] p-4 ${
          isManual ? 'border border-dashed border-fuchsia-400/30 bg-fuchsia-500/5' :
          isActive ? 'border border-emerald-400/30 bg-emerald-500/5' : 'border border-white/10 bg-white/[0.03]'
        }`}>
          <div className="flex items-center gap-2 mb-2">
            {isManual ? (
              <span className="rounded-full border border-fuchsia-400/30 bg-fuchsia-500/10 px-2 py-0.5 text-xs font-medium text-fuchsia-200">
                MANUAL LINK
              </span>
            ) : (
              <>
                <span className="text-sm font-medium text-slate-400">{link.strategy}</span>
                {isActive && (
                  <span className="rounded-full border border-emerald-400/30 bg-emerald-500/10 px-2 py-0.5 text-xs font-medium text-emerald-200">
                    ACTIVE
                  </span>
                )}
              </>
            )}
          </div>
          {isManual ? (
            <p className="text-sm text-slate-500">
              Manually linked — no execution data available
            </p>
          ) : (
            <>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-sm">
                <div>
                  <span className="text-slate-500">Range</span>
                  <p className="text-slate-200">[{link.tickLower}, {link.tickUpper}]</p>
                  <p className="text-xs text-slate-400">{link.widthTicks} ticks</p>
                </div>
                <div>
                  <span className="text-slate-500">Duration</span>
                  <p className="text-slate-200">{formatDuration(link.durationMs)}</p>
                  <p className="text-xs text-slate-400">{formatDate(link.mintTimestamp)}</p>
                </div>
                <div>
                  <span className="text-slate-500">In Range</span>
                  <p className={link.timeInRangePercent > 70 ? 'text-green-400' : link.timeInRangePercent > 40 ? 'text-yellow-400' : 'text-red-400'}>
                    {link.timeInRangePercent.toFixed(1)}%
                  </p>
                </div>
                <div>
                  <span className="text-slate-500">APR / ROI</span>
                  <p className="text-slate-200">{link.feeAPR.toFixed(1)}%</p>
                  <p className={`text-xs ${link.netROIPercent >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                    {link.netROIPercent >= 0 ? '+' : ''}{link.netROIPercent.toFixed(3)}% net
                  </p>
                </div>
              </div>
              <div className="mt-2 flex gap-4 text-xs text-slate-500">
                <span>Gas: {link.gasCostPLS.toFixed(2)} PLS</span>
                {link.swapExecDeltaBps > 0 && <span>Exec delta: {link.swapExecDeltaBps} bps</span>}
                {link.rebalanceCostPercent > 0 && (
                  <span className="text-yellow-400">Exec Cost: {link.rebalanceCostPercent.toFixed(2)}%</span>
                )}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

export default function PositionChain() {
  const { tokenId } = useParams<{ tokenId: string }>();
  const [chain, setChain] = useState<PositionChainData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!tokenId) return;
    setLoading(true);
    getPositionChain(parseInt(tokenId, 10))
      .then(setChain)
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, [tokenId]);

  if (loading) {
    return (
      <div className="max-w-4xl mx-auto p-6">
        <div className="animate-pulse text-slate-400">Loading chain data...</div>
      </div>
    );
  }

  if (error || !chain) {
    return (
      <div className="max-w-4xl mx-auto p-6">
        <div className="text-red-400">{error || 'No chain data found'}</div>
        <Link to={`/positions/${tokenId}`} className="text-blue-400 hover:underline mt-2 inline-block">
          Back to position
        </Link>
      </div>
    );
  }

  const agg = chain.aggregate;
  const durationDays = agg.totalDurationMs / (1000 * 86400);

  return (
    <div className="mx-auto max-w-4xl p-6">
      {/* Header */}
      <div className="panel mb-6 flex items-center gap-3">
        <Link to={`/positions/${tokenId}`} className="text-slate-400 transition-colors hover:text-white">
          &larr;
        </Link>
        <div>
          <h1 className="text-2xl font-bold text-white">
          Position Chain #{chain.currentTokenId}
          </h1>
          <p className="mt-1 text-sm text-slate-400">Root-to-current lineage across rebalances, preserving duration, APR, and cost signals for every NFT in the chain.</p>
        </div>
      </div>

      {/* Aggregate banner */}
      <div className="panel mb-8">
        <h2 className="text-lg font-semibold text-white mb-3">Lifetime Summary</h2>
        <div className="mb-3 text-sm text-slate-400">
          Root #{chain.rootTokenId} &rarr; Current #{chain.currentTokenId}
        </div>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
          <div>
            <span className="text-slate-500">Rebalances</span>
            <p className="text-xl font-bold text-white">{agg.totalRebalances}</p>
          </div>
          <div>
            <span className="text-slate-500">Duration</span>
            <p className="text-xl font-bold text-white">{durationDays.toFixed(1)}d</p>
          </div>
          <div>
            <span className="text-slate-500">Avg Time in Range</span>
            <p className={`text-xl font-bold ${agg.avgTimeInRangePercent > 70 ? 'text-green-400' : 'text-yellow-400'}`}>
              {agg.avgTimeInRangePercent.toFixed(1)}%
            </p>
          </div>
          <div>
            <span className="text-slate-500">Avg Fee APR</span>
            <p className="text-xl font-bold text-white">{agg.avgFeeAPR.toFixed(1)}%</p>
          </div>
          <div>
            <span className="text-slate-500">Cumulative Net ROI</span>
            <p className={`text-xl font-bold ${agg.cumulativeNetROIPercent >= 0 ? 'text-green-400' : 'text-red-400'}`}>
              {agg.cumulativeNetROIPercent >= 0 ? '+' : ''}{agg.cumulativeNetROIPercent.toFixed(3)}%
            </p>
          </div>
          <div>
            <span className="text-slate-500">Total Gas</span>
            <p className="text-xl font-bold text-white">{agg.totalGasCostPLS.toFixed(2)} PLS</p>
          </div>
          <div>
            <span className="text-slate-500">Avg Exec Delta</span>
            <p className="text-xl font-bold text-white">{agg.avgExecDeltaBps.toFixed(0)} bps</p>
          </div>
          <div>
            <span className="text-slate-500">Since</span>
            <p className="text-sm font-medium text-white">{formatDate(agg.firstSeen)}</p>
          </div>
        </div>
      </div>

      {/* Chain timeline */}
      <h2 className="mb-4 text-lg font-semibold text-white">Chain Links</h2>
      <div className="space-y-0">
        {chain.links.map((link, i) => (
          <LinkCard key={link.tokenId} link={link} isLast={i === chain.links.length - 1} />
        ))}
      </div>
    </div>
  );
}

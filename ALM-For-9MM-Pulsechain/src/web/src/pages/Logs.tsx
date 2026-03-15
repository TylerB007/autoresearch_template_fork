import { useState, useEffect, useCallback } from 'react';
import {
  getRebalanceHistory, formatTokenAmount, formatUsd,
  type RebalanceEvent,
} from '../api/client';
import { REFRESH_EVENT } from '../components/Navbar';
import { useChain } from '../context/ChainContext';

export default function Logs() {
  const [rebalances, setRebalances] = useState<RebalanceEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [days, setDays] = useState(90);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const fetchData = useCallback(() => {
    setLoading(true);
    getRebalanceHistory(days)
      .then((res) => {
        setRebalances(res.rebalances);
        setError('');
      })
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, [days]);

  useEffect(() => { fetchData(); }, [fetchData]);
  useEffect(() => {
    window.addEventListener(REFRESH_EVENT, fetchData);
    return () => window.removeEventListener(REFRESH_EVENT, fetchData);
  }, [fetchData]);

  if (loading) {
    return (
      <div className="panel flex h-64 items-center justify-center">
        <span className="text-slate-400">Loading logs...</span>
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

  // Sort most recent first
  const sorted = [...rebalances].sort((a, b) => b.timestamp - a.timestamp);

  return (
    <div className="mx-auto max-w-7xl space-y-6 px-4 py-6 sm:px-6 lg:px-8">
      <section className="panel overflow-hidden">
        <div className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-cyan-400/50 to-transparent" />
        <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
        <div>
          <h1 className="text-3xl font-semibold tracking-tight text-white">Analytics Logs</h1>
          <p className="mt-2 text-sm leading-6 text-slate-300">
            Full rebalance records with dust tracking, gas receipts, and price attribution
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

      {sorted.length === 0 ? (
        <div className="panel p-8 text-center">
          <p className="text-slate-500">No rebalance records in the last {days} days.</p>
        </div>
      ) : (
        <div className="space-y-3">
          {sorted.map((rb) => (
            <LogRecord
              key={rb.rebalanceId}
              rb={rb}
              expanded={expandedId === rb.rebalanceId}
              onToggle={() => setExpandedId(expandedId === rb.rebalanceId ? null : rb.rebalanceId)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

type ExtendedRebalance = RebalanceEvent;

function LogRecord({ rb, expanded, onToggle }: {
  rb: RebalanceEvent;
  expanded: boolean;
  onToggle: () => void;
}) {
  const { chain, txUrl } = useChain();
  const ext = rb as ExtendedRebalance;
  const pre = rb.preSnapshot;
  const d0 = pre.token0Decimals;
  const d1 = pre.token1Decimals;
  const sym0 = pre.token0Symbol;
  const sym1 = pre.token1Symbol;
  const date = new Date(rb.timestamp).toLocaleString();

  return (
    <div className="overflow-hidden rounded-[28px] border border-white/10 bg-white/[0.03]">
      {/* Summary row */}
      <button
        onClick={onToggle}
        className="flex w-full items-center justify-between px-5 py-3.5 text-left transition-colors hover:bg-white/[0.04]"
      >
        <div className="flex items-center gap-3 min-w-0">
          <span className="w-2 h-2 rounded-full flex-shrink-0 bg-green-500" />
          <div className="min-w-0">
            <p className="text-sm font-medium text-white">{date}</p>
            <p className="truncate text-xs text-slate-500">
              {rb.rebalanceId.slice(0, 12)}... &middot; #{rb.oldTokenId} &rarr; #{rb.newTokenId} &middot; {sym0}/{sym1}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-4 text-sm flex-shrink-0">
          {ext.recordQuality?.isPartial && (
            <span className="text-xs px-1.5 py-0.5 rounded bg-amber-900/40 text-amber-300">
              partial record
            </span>
          )}
          {ext.priceSource && (
            <span className="text-xs px-1.5 py-0.5 rounded bg-blue-900/40 text-blue-400">
              {ext.priceSource}
            </span>
          )}
          {ext.dustUsd != null && ext.dustUsd > 0 && (
            <span className="text-xs px-1.5 py-0.5 rounded bg-amber-900/40 text-amber-400">
              dust {formatUsd(ext.dustUsd)}
            </span>
          )}
          <span className="text-xs text-slate-500">{expanded ? '▲' : '▼'}</span>
        </div>
      </button>

      {/* Full details */}
      {expanded && (
        <div className="space-y-5 border-t border-white/10 px-5 pb-5 pt-4">
          {/* Section: Identity */}
          <Section title="Record Identity">
            <Field label="Rebalance ID" value={rb.rebalanceId} mono />
            <Field label="Timestamp" value={`${date} (${rb.timestamp})`} />
            {ext.timestampMs && (
              <Field label="Precise Timestamp" value={`${ext.timestampMs}ms`} />
            )}
            <Field label="Strategy" value={rb.strategy} />
            <Field label="Token ID" value={`#${rb.oldTokenId} → #${rb.newTokenId}`} />
            <Field label="Pair" value={`${sym0}/${sym1}`} />
            {ext.priceSource && <Field label="Price Source" value={ext.priceSource} />}
          </Section>

          {/* Section: Fees Collected */}
          <Section title="Fees Collected">
            <Field label={sym0} value={formatTokenAmount(rb.feesCollected0, d0)} />
            <Field label={sym1} value={formatTokenAmount(rb.feesCollected1, d1)} />
            {ext.feesCollectedUsd != null && (
              <Field label="USD Value" value={formatUsd(ext.feesCollectedUsd)} highlight />
            )}
          </Section>

          {/* Section: Gas Costs (Accountant-Grade) */}
          <Section title={ext.gasCostSource === 'receipt_exact' ? 'Gas Costs (Receipt-Based)' : 'Gas Costs (Estimated)'}>
            <Field
              label={`Total (${chain.nativeCurrencySymbol})`}
              value={rb.totalGasCostPLS.toLocaleString(undefined, { maximumFractionDigits: 4 })}
            />
            {ext.gasCostUsd != null && (
              <Field label="Total (USD)" value={formatUsd(ext.gasCostUsd)} highlight />
            )}
            {ext.metrics.executionCostUsd != null && (
              <Field label="Full Execution Cost (USD)" value={formatUsd(ext.metrics.executionCostUsd)} />
            )}
            {ext.gasUsed?.totalCostWei && (
              <Field label="Total Cost Wei" value={ext.gasUsed.totalCostWei} mono />
            )}
            {ext.gasPrice && (
              <Field label="Gas Price" value={`${ext.gasPrice} wei`} mono />
            )}
            {ext.gasUsed && (
              <div className="mt-2 grid grid-cols-2 sm:grid-cols-3 gap-2">
                {ext.gasUsed.collectFees !== '0' && <GasStep label="Collect Fees" value={ext.gasUsed.collectFees} />}
                {ext.gasUsed.decreaseLiquidity !== '0' && <GasStep label="Decrease Liq" value={ext.gasUsed.decreaseLiquidity} />}
                {ext.gasUsed.collectTokens !== '0' && <GasStep label="Collect Tokens" value={ext.gasUsed.collectTokens} />}
                {ext.gasUsed.burn !== '0' && <GasStep label="Burn" value={ext.gasUsed.burn} />}
                {ext.gasUsed.swap !== '0' && <GasStep label="Swap" value={ext.gasUsed.swap} />}
                {ext.gasUsed.mint !== '0' && <GasStep label="Mint" value={ext.gasUsed.mint} />}
              </div>
            )}
            {ext.gasUsed?.l1Fee && ext.gasUsed.l1Fee !== '0' && (
              <Field label="L1 Data Fee" value={ext.gasUsed.l1Fee} mono />
            )}
          </Section>

          {/* Section: Dust (Capital Reconciliation) */}
          <Section title="Dust (Uninvested Leftovers)">
            {ext.dust0 != null ? (
              <>
                <Field label={`${sym0} Dust`} value={formatTokenAmount(ext.dust0, d0)} />
                <Field label={`${sym1} Dust`} value={formatTokenAmount(ext.dust1 ?? '0', d1)} />
                {ext.dustUsd != null && (
                  <Field label="Dust USD" value={formatUsd(ext.dustUsd)} highlight={ext.dustUsd > 0} />
                )}
              </>
            ) : (
              <p className="text-xs italic text-slate-600">No dust data (pre-v2.8 record)</p>
            )}
          </Section>

          {/* Section: Swap Details */}
          {rb.swap && (
            <Section title="Swap Execution">
              <Field
                label="Direction"
                value={
                  rb.swap.tokenIn === 'token0'
                    ? `${formatTokenAmount(rb.swap.amountIn, d0)} ${sym0} → ${formatTokenAmount(rb.swap.amountOut, d1)} ${sym1}`
                    : `${formatTokenAmount(rb.swap.amountIn, d1)} ${sym1} → ${formatTokenAmount(rb.swap.amountOut, d0)} ${sym0}`
                }
              />
              {rb.swap.configuredSlippageBps != null ? (
                <Field label="Configured Tolerance" value={`${(rb.swap.configuredSlippageBps / 100).toFixed(2)}%`} />
              ) : (
                <p className="text-xs italic text-slate-500">Configured tolerance unavailable for this legacy record.</p>
              )}
              <Field
                label="Realized Exec Delta"
                value={`${((rb.swap.realizedExecutionDeltaBps ?? rb.swap.slippageBps) / 100).toFixed(2)}%`}
              />
              {ext.swapFrictionUsd != null && (
                <Field label="Swap Friction" value={formatUsd(ext.swapFrictionUsd)} />
              )}
            </Section>
          )}

          {/* Section: USD Prices at Rebalance */}
          {(ext.priceUsd0 != null || ext.priceUsd1 != null) && (
            <Section title="USD Prices at Rebalance">
              {ext.priceUsd0 != null && <Field label={sym0} value={formatUsd(ext.priceUsd0)} />}
              {ext.priceUsd1 != null && <Field label={sym1} value={formatUsd(ext.priceUsd1)} />}
              {ext.nativeTokenPriceUsd != null && (
                <Field label={chain.nativeCurrencySymbol} value={formatUsd(ext.nativeTokenPriceUsd)} />
              )}
              {ext.priceSource && (
                <Field label="Source" value={ext.priceSource} />
              )}
            </Section>
          )}

          {/* Section: Range Transition */}
          <Section title="Range Transition">
            <div className="grid grid-cols-2 gap-4">
              <div>
                <p className="mb-1 text-xs text-slate-500">Old Range</p>
                <p className="text-sm text-white font-mono">
                  [{pre.tickLower}, {pre.tickUpper}]
                </p>
                <p className="text-xs text-slate-500">Tick: {pre.currentTick}</p>
              </div>
              <div>
                <p className="mb-1 text-xs text-slate-500">New Range</p>
                <p className="text-sm text-white font-mono">
                  [{rb.newTickLower}, {rb.newTickUpper}]
                </p>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-4 mt-2">
              <div>
                <p className="mb-1 text-xs text-slate-500">Pre Amounts</p>
                <p className="text-xs text-slate-300">
                  {formatTokenAmount(pre.amount0, d0)} {sym0}
                </p>
                <p className="text-xs text-slate-300">
                  {formatTokenAmount(pre.amount1, d1)} {sym1}
                </p>
              </div>
              <div>
                <p className="mb-1 text-xs text-slate-500">Post Amounts</p>
                <p className="text-xs text-slate-300">
                  {formatTokenAmount(rb.newAmount0, d0)} {sym0}
                </p>
                <p className="text-xs text-slate-300">
                  {formatTokenAmount(rb.newAmount1, d1)} {sym1}
                </p>
              </div>
            </div>
          </Section>

          {/* Section: Performance Metrics */}
          <Section title="Performance Metrics">
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
              <Metric label="Fee APR" value={`${rb.metrics.feeAPR.toFixed(2)}%`} />
              <Metric
                label="Net ROI"
                value={`${rb.metrics.netROIPercent.toFixed(3)}%`}
                color={rb.metrics.netROIPercent >= 0 ? 'text-green-400' : 'text-red-400'}
              />
              {ext.metrics.trueNetROIPercent != null && (
                <Metric
                  label="True Net ROI"
                  value={`${ext.metrics.trueNetROIPercent.toFixed(3)}%`}
                  color={ext.metrics.trueNetROIPercent >= 0 ? 'text-green-400' : 'text-red-400'}
                />
              )}
              <Metric
                label="Impermanent Loss"
                value={`${rb.metrics.impermanentLossPercent.toFixed(3)}%`}
                color="text-orange-400"
              />
              <Metric label="Time in Range" value={`${rb.metrics.timeInRangePercent.toFixed(1)}%`} />
              <Metric label="Duration" value={`${rb.metrics.durationDays.toFixed(1)}d`} />
              <Metric label="Capital Efficiency" value={`${rb.metrics.capitalEfficiencyRatio.toFixed(2)}x`} />
              <Metric
                label="Fees / Full Exec Cost"
                value={rb.metrics.feesToExecutionCostRatio == null
                  ? '—'
                  : Number.isFinite(rb.metrics.feesToExecutionCostRatio)
                    ? `${rb.metrics.feesToExecutionCostRatio.toFixed(2)}x`
                    : 'Infinity'}
              />
              {ext.metrics.rawFeeYieldPercent != null && (
                <Metric label="Raw Fee Yield" value={`${ext.metrics.rawFeeYieldPercent.toFixed(4)}%`} />
              )}
              {ext.metrics.rebalanceCostPercent != null && (
                <Metric label="Rebalance Cost" value={`${ext.metrics.rebalanceCostPercent.toFixed(2)}%`} />
              )}
            </div>
            {ext.recordQuality?.isPartial && (
              <p className="mt-3 text-xs text-amber-300">
                Execution-cost quality: {ext.recordQuality.executionCostQuality}. Missing: {ext.recordQuality.missingFields.join(', ')}.
              </p>
            )}
          </Section>

          {/* Section: Transaction Hashes */}
          <Section title="Transaction Hashes">
            <div className="space-y-1">
              <TxRow label="Collect Fees" hash={rb.txHashes.collectFees} txUrl={txUrl} />
              <TxRow label="Decrease Liquidity" hash={rb.txHashes.decreaseLiquidity} txUrl={txUrl} />
              <TxRow label="Collect Tokens" hash={rb.txHashes.collectTokens} txUrl={txUrl} />
              <TxRow label="Burn" hash={rb.txHashes.burn} txUrl={txUrl} />
              {rb.txHashes.swap && <TxRow label="Swap" hash={rb.txHashes.swap} txUrl={txUrl} />}
              <TxRow label="Mint" hash={rb.txHashes.mint} txUrl={txUrl} />
            </div>
          </Section>
        </div>
      )}
    </div>
  );
}

// ============================================================
// Sub-components
// ============================================================

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <p className="mb-2 border-b border-white/10 pb-1 text-xs font-medium uppercase tracking-[0.22em] text-slate-500">
        {title}
      </p>
      <div className="space-y-1.5">{children}</div>
    </div>
  );
}

function Field({ label, value, mono, highlight }: {
  label: string;
  value: string;
  mono?: boolean;
  highlight?: boolean;
}) {
  return (
    <div className="flex items-baseline justify-between gap-4">
      <span className="flex-shrink-0 text-xs text-slate-500">{label}</span>
      <span className={`text-sm text-right truncate ${mono ? 'font-mono text-xs' : ''} ${highlight ? 'text-green-400 font-medium' : 'text-white'}`}>
        {value}
      </span>
    </div>
  );
}

function GasStep({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-2xl border border-white/10 bg-white/[0.03] px-2 py-1.5">
      <p className="text-xs text-slate-500">{label}</p>
      <p className="text-xs text-white font-mono">{Number(value).toLocaleString()}</p>
    </div>
  );
}

function Metric({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-2">
      <p className="text-xs text-slate-500">{label}</p>
      <p className={`text-sm font-medium mt-0.5 ${color ?? 'text-white'}`}>{value}</p>
    </div>
  );
}

function TxRow({ label, hash, txUrl }: { label: string; hash: string; txUrl: (h: string) => string }) {
  if (!hash) return null;
  return (
    <div className="flex items-center justify-between gap-2">
      <span className="text-xs text-slate-500">{label}</span>
      <a
        href={txUrl(hash)}
        target="_blank"
        rel="noopener noreferrer"
        className="text-xs font-mono text-blue-400 hover:text-blue-300 truncate max-w-[280px]"
      >
        {hash}
      </a>
    </div>
  );
}

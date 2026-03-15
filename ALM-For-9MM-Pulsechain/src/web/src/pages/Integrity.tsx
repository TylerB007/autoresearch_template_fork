import { useState, useCallback } from 'react';
import { apiFetch } from '../api/client';

// ── Types ─────────────────────────────────────────────────────────────────────

type CheckStatus = 'pass' | 'fail' | 'warn' | 'skip';

interface IntegrityCheck {
  name: string;
  category: 'snapshot' | 'rebalance';
  status: CheckStatus;
  violations: number;
  examples: string[];
  description: string;
}

interface IntegrityReport {
  ranAt: number;
  analyticsPath: string;
  lookbackDays: number;
  snapshotsChecked: number;
  rebalancesChecked: number;
  durationMs: number;
  summary: { passed: number; failed: number; warned: number; skipped: number };
  checks: IntegrityCheck[];
}

// ── Helpers ───────────────────────────────────────────────────────────────────

const STATUS_STYLES: Record<CheckStatus, { bg: string; border: string; badge: string; text: string; dot: string }> = {
  pass: {
    bg: 'bg-green-900/10',
    border: 'border-green-800/40',
    badge: 'bg-green-900/60 text-green-300 border border-green-700',
    text: 'text-green-400',
    dot: 'bg-green-400',
  },
  fail: {
    bg: 'bg-red-900/10',
    border: 'border-red-800/40',
    badge: 'bg-red-900/60 text-red-300 border border-red-700',
    text: 'text-red-400',
    dot: 'bg-red-400',
  },
  warn: {
    bg: 'bg-yellow-900/10',
    border: 'border-yellow-800/40',
    badge: 'bg-yellow-900/60 text-yellow-300 border border-yellow-700',
    text: 'text-yellow-400',
    dot: 'bg-yellow-400',
  },
  skip: {
    bg: 'bg-slate-900/20',
    border: 'border-slate-700/30',
    badge: 'border border-slate-700/40 bg-slate-800/70 text-slate-400',
    text: 'text-slate-500',
    dot: 'bg-slate-500',
  },
};

const STATUS_LABELS: Record<CheckStatus, string> = {
  pass: 'PASS',
  fail: 'FAIL',
  warn: 'WARN',
  skip: 'SKIP',
};

// ── Component ─────────────────────────────────────────────────────────────────

export default function Integrity() {
  const [report, setReport] = useState<IntegrityReport | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [days, setDays] = useState(30);
  const [expanded, setExpanded] = useState<string | null>(null);

  const runChecks = useCallback(async () => {
    setLoading(true);
    setError('');
    setReport(null);
    try {
      const data = await apiFetch<IntegrityReport>(`/api/integrity?days=${days}`);
      setReport(data);
    } catch (err: any) {
      setError(err.message ?? 'Failed to run integrity checks');
    } finally {
      setLoading(false);
    }
  }, [days]);

  const snapshotChecks = report?.checks.filter((c) => c.category === 'snapshot') ?? [];
  const rebalanceChecks = report?.checks.filter((c) => c.category === 'rebalance') ?? [];

  return (
    <div className="mx-auto max-w-6xl space-y-6 px-4 py-6 sm:px-6 lg:px-8">

      {/* Header */}
      <div className="panel overflow-hidden">
        <div className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-cyan-400/50 to-transparent" />
        <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-3xl font-semibold tracking-tight text-white">Data Integrity</h1>
          <p className="mt-2 text-sm leading-6 text-slate-300">
            Validates the analytics dataset the bot is actively writing — checks field coverage,
            internal consistency, and data accuracy against on-chain definitions.
          </p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <select
            value={days}
            onChange={(e) => setDays(Number(e.target.value))}
            className="input-base text-sm"
          >
            <option value={7}>7 days</option>
            <option value={14}>14 days</option>
            <option value={30}>30 days</option>
            <option value={60}>60 days</option>
            <option value={90}>90 days</option>
          </select>
          <button
            onClick={runChecks}
            disabled={loading}
            className="rounded-full border border-cyan-400/30 bg-cyan-400 px-4 py-1.5 text-sm font-medium text-slate-950 transition-colors hover:bg-cyan-300 disabled:border-white/10 disabled:bg-white/5 disabled:text-slate-500"
          >
            {loading ? 'Running…' : 'Run Checks'}
          </button>
        </div>
        </div>
      </div>

      {/* Error */}
      {error && (
        <div className="rounded-3xl border border-red-400/30 bg-red-500/10 p-4">
          <p className="text-red-400 text-sm">{error}</p>
        </div>
      )}

      {/* Loading */}
      {loading && (
        <div className="panel p-8 text-center">
          <div className="text-sm text-slate-300">Reading analytics files and running checks…</div>
          <div className="mt-3 text-xs text-slate-500">This may take a few seconds on large datasets.</div>
        </div>
      )}

      {/* Initial state */}
      {!loading && !report && !error && (
        <div className="panel p-8 text-center">
          <div className="text-sm text-slate-400">
            Click <span className="text-white font-medium">Run Checks</span> to validate the live analytics dataset.
          </div>
          <div className="mx-auto mt-2 max-w-lg text-xs text-slate-500">
            Checks run directly against the JSONL files the bot writes every 60 seconds.
            No transactions are made and no RPC calls are required.
          </div>
        </div>
      )}

      {/* Report */}
      {report && !loading && (
        <>
          {/* Summary bar */}
          <div className="panel">
            <div className="flex items-center justify-between mb-3">
              <span className="text-xs text-slate-500">
                Ran {new Date(report.ranAt).toLocaleTimeString()} &nbsp;·&nbsp;
                {report.snapshotsChecked.toLocaleString()} snapshots &nbsp;·&nbsp;
                {report.rebalancesChecked} rebalances &nbsp;·&nbsp;
                {report.lookbackDays}d lookback &nbsp;·&nbsp;
                {report.durationMs}ms
              </span>
              <span className="text-xs text-slate-600">{report.analyticsPath}</span>
            </div>
            <div className="flex gap-4">
              {[
                { label: 'Passed', count: report.summary.passed, color: 'text-green-400' },
                { label: 'Failed', count: report.summary.failed, color: 'text-red-400' },
                { label: 'Warnings', count: report.summary.warned, color: 'text-yellow-400' },
                { label: 'Skipped', count: report.summary.skipped, color: 'text-slate-500' },
              ].map(({ label, count, color }) => (
                <div key={label} className="text-center">
                  <div className={`text-2xl font-bold ${color}`}>{count}</div>
                  <div className="text-xs text-slate-500">{label}</div>
                </div>
              ))}
            </div>
          </div>

          {/* No data warning */}
          {report.snapshotsChecked === 0 && report.rebalancesChecked === 0 && (
            <div className="rounded-3xl border border-amber-400/20 bg-amber-500/10 p-4">
              <p className="text-sm font-medium text-amber-100">No analytics data found</p>
              <p className="mt-1 text-xs text-amber-200/80">
                The analytics directory at <code className="rounded bg-amber-500/10 px-1 text-amber-100">{report.analyticsPath}</code> is
                empty or contains no records in the last {report.lookbackDays} days.
                The bot must be running and writing data before checks can be performed.
              </p>
            </div>
          )}

          {/* Snapshot checks */}
          {snapshotChecks.length > 0 && (
            <section>
              <h2 className="mb-2 text-xs font-semibold uppercase tracking-[0.24em] text-slate-500">
                Snapshot Checks ({report.snapshotsChecked.toLocaleString()} records)
              </h2>
              <div className="space-y-2">
                {snapshotChecks.map((check) => (
                  <CheckRow
                    key={check.name + check.category}
                    check={check}
                    expanded={expanded === check.name + check.category}
                    onToggle={() => setExpanded((prev) =>
                      prev === check.name + check.category ? null : check.name + check.category,
                    )}
                  />
                ))}
              </div>
            </section>
          )}

          {/* Rebalance checks */}
          {rebalanceChecks.length > 0 && (
            <section>
              <h2 className="mb-2 text-xs font-semibold uppercase tracking-[0.24em] text-slate-500">
                Rebalance Checks ({report.rebalancesChecked} records)
              </h2>
              <div className="space-y-2">
                {rebalanceChecks.map((check) => (
                  <CheckRow
                    key={check.name + check.category}
                    check={check}
                    expanded={expanded === check.name + check.category}
                    onToggle={() => setExpanded((prev) =>
                      prev === check.name + check.category ? null : check.name + check.category,
                    )}
                  />
                ))}
              </div>
            </section>
          )}
        </>
      )}
    </div>
  );
}

// ── Check Row ─────────────────────────────────────────────────────────────────

function CheckRow({
  check,
  expanded,
  onToggle,
}: {
  check: IntegrityCheck;
  expanded: boolean;
  onToggle: () => void;
}) {
  const s = STATUS_STYLES[check.status];
  const hasDetails = check.violations > 0 || check.status === 'skip';

  return (
    <div className={`overflow-hidden rounded-[24px] border ${s.border} ${s.bg}`}>
      <button
        onClick={hasDetails ? onToggle : undefined}
        className={`w-full flex items-center gap-3 px-4 py-3 text-left ${hasDetails ? 'cursor-pointer hover:bg-white/5' : 'cursor-default'}`}
      >
        {/* Status dot */}
        <span className={`w-2 h-2 rounded-full shrink-0 ${s.dot}`} />

        {/* Name */}
        <span className="flex-1 text-sm font-medium text-slate-200">{check.name}</span>

        {/* Violation count */}
        {check.violations > 0 && (
          <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${s.badge}`}>
            {check.violations} violation{check.violations !== 1 ? 's' : ''}
          </span>
        )}

        {/* Status badge */}
        <span className={`text-xs px-2 py-0.5 rounded font-mono font-bold ${s.badge}`}>
          {STATUS_LABELS[check.status]}
        </span>

        {/* Expand chevron */}
        {hasDetails && (
          <svg
            className={`h-4 w-4 text-slate-500 transition-transform ${expanded ? 'rotate-180' : ''}`}
            fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}
          >
            <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
          </svg>
        )}
      </button>

      {/* Expanded detail */}
      {expanded && (
        <div className="px-4 pb-4 space-y-3 border-t border-white/5">
          {/* Description */}
          <p className="pt-3 text-xs text-slate-400">{check.description}</p>

          {/* Examples */}
          {check.examples.length > 0 && (
            <div>
              <p className="mb-1.5 text-xs font-medium text-slate-500">
                {check.violations > check.examples.length
                  ? `Showing ${check.examples.length} of ${check.violations} violations:`
                  : 'Violations:'}
              </p>
              <div className="space-y-1">
                {check.examples.map((ex, i) => (
                  <div key={i} className="break-all rounded-2xl border border-white/10 bg-[#060d18] px-2 py-1.5 font-mono text-xs text-slate-300">
                    {ex}
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

import { useState, useEffect, useCallback, useMemo } from 'react';
import { MetricCardSkeleton, Skeleton } from '../components/Skeleton';
import {
  getDashboard,
  getPortfolioSummary,
  getRecoveryStatus,
  getDailyEarnings,
  dismissRecovery,
  executeRecovery,
  enableBot,
  disableBot,
  downloadFile,
  formatUsd,
  type DashboardData,
  type PortfolioSummary,
  type RecoveryStatus,
  type DailyEarning,
} from '../api/client';
import PositionCard from '../components/PositionCard';
import PositionsTable from '../components/positions/PositionsTable.js';
import MetricCard from '../components/MetricCard';
import TokenLogo from '../components/TokenLogo';
import ConfirmDialog from '../components/ConfirmDialog';
import DailyEarningsChart from '../components/charts/DailyEarningsChart';
import { REFRESH_EVENT } from '../components/Navbar';

function SummaryBanner({
  title,
  body,
  tone,
  actions,
}: {
  title: string;
  body: string;
  tone: 'warning' | 'danger' | 'success';
  actions?: React.ReactNode;
}) {
  const toneClass = tone === 'warning' ? 'banner-warning' : tone === 'danger' ? 'banner-danger' : 'banner-success';
  return (
    <div className={`banner ${toneClass}`}>
      <div className="space-y-2">
        <p className="panel-title">Attention</p>
        <p className="text-base font-semibold text-white">{title}</p>
        <p className="text-sm leading-6 text-slate-300">{body}</p>
      </div>
      {actions ? <div className="flex flex-col gap-3 sm:flex-row sm:items-center">{actions}</div> : null}
    </div>
  );
}

function SectionHeader({ title, copy, actions }: { title: string; copy: string; actions?: React.ReactNode }) {
  return (
    <div className="panel-header">
      <div>
        <p className="panel-title">{title}</p>
        <p className="panel-copy">{copy}</p>
      </div>
      {actions}
    </div>
  );
}

function HoldingsTable({ data }: { data: NonNullable<DashboardData['walletTokens']> }) {
  return (
    <div className="table-shell">
      <table>
        <thead>
          <tr>
            <th>Token</th>
            <th>Chain</th>
            <th className="text-right">Balance</th>
            <th className="text-right">USD Value</th>
          </tr>
        </thead>
        <tbody>
          {data.map((token) => (
            <tr key={`${token.chainId ?? 0}-${token.address}`}>
              <td>
                <div className="flex items-center gap-2">
                  <TokenLogo symbol={token.symbol} chainId={token.chainId} size="sm" />
                  <div className="flex flex-col gap-1">
                    <span className="font-medium text-white">{token.symbol}</span>
                    <span className="text-xs text-slate-500">{token.address.slice(0, 8)}...{token.address.slice(-6)}</span>
                  </div>
                </div>
              </td>
              <td className="text-slate-300">{token.chainName ?? '—'}</td>
              <td className="text-right text-data text-slate-100">
                {token.balanceFormatted >= 1
                  ? token.balanceFormatted.toLocaleString(undefined, { maximumFractionDigits: 2 })
                  : token.balanceFormatted.toLocaleString(undefined, { maximumFractionDigits: 6 })}
              </td>
              <td className="text-right text-data text-slate-100">{token.valueUsd > 0 ? formatUsd(token.valueUsd) : '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default function Dashboard() {
  const [data, setData] = useState<DashboardData | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [portfolio, setPortfolio] = useState<PortfolioSummary | null>(null);
  const [portfolioError, setPortfolioError] = useState(false);
  const [earningsData, setEarningsData] = useState<DailyEarning[]>([]);
  const [earningsLoading, setEarningsLoading] = useState(true);
  const [recovery, setRecovery] = useState<RecoveryStatus | null>(null);
  const [recoveryAction, setRecoveryAction] = useState<'dismiss' | 'recover' | null>(null);
  const [recoveryLoading, setRecoveryLoading] = useState(false);
  const [botActionLoading, setBotActionLoading] = useState(false);
  const [botActionMsg, setBotActionMsg] = useState('');
  const [positionView, setPositionView] = useState<'table' | 'card'>(() =>
    (localStorage.getItem('dashboard_position_view') as 'table' | 'card') ?? 'table'
  );

  // OOR positions bubble to the top — highest priority for operator attention
  const sortedPositionList = useMemo(() =>
    [...(data?.positionList ?? [])].sort((a, b) => {
      if (a.inRange === b.inRange) return 0;
      return a.inRange ? 1 : -1;
    }),
    [data?.positionList],
  );

  const refreshAll = useCallback(() => {
    getDashboard()
      .then(setData)
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
    getPortfolioSummary()
      .then((p) => {
        setPortfolio(p);
        setPortfolioError(false);
      })
      .catch(() => setPortfolioError(true));
    getDailyEarnings()
      .then((d) => {
        setEarningsData(d);
        setEarningsLoading(false);
      })
      .catch(() => setEarningsLoading(false));
    getRecoveryStatus().then(setRecovery).catch(() => {});
  }, []);

  useEffect(() => {
    refreshAll();
  }, [refreshAll]);

  useEffect(() => {
    window.addEventListener(REFRESH_EVENT, refreshAll);
    return () => window.removeEventListener(REFRESH_EVENT, refreshAll);
  }, [refreshAll]);

  const handleDismiss = useCallback(async () => {
    setRecoveryAction(null);
    setRecoveryLoading(true);
    try {
      await dismissRecovery();
      setRecovery({ hasAlert: false });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setRecoveryLoading(false);
    }
  }, []);

  const handleRecover = useCallback(async () => {
    setRecoveryAction(null);
    setRecoveryLoading(true);
    try {
      await executeRecovery();
      setRecovery({ hasAlert: false });
      getDashboard().then(setData).catch(() => {});
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setRecoveryLoading(false);
    }
  }, []);

  const handleEnableBot = useCallback(async () => {
    setBotActionLoading(true);
    setBotActionMsg('');
    try {
      const result = await enableBot();
      if (result.recoveryStateWarning) setBotActionMsg(result.recoveryStateWarning);
      getDashboard().then(setData).catch(() => {});
    } catch (err) {
      setBotActionMsg((err as Error).message);
    } finally {
      setBotActionLoading(false);
    }
  }, []);

  const handleDisableBot = useCallback(async () => {
    setBotActionLoading(true);
    setBotActionMsg('');
    try {
      await disableBot();
      getDashboard().then(setData).catch(() => {});
    } catch (err) {
      setBotActionMsg((err as Error).message);
    } finally {
      setBotActionLoading(false);
    }
  }, []);

  if (loading) {
    return (
      <div className="page-section">
        <section className="page-hero animate-fade-rise">
          <Skeleton className="mb-3 h-4 w-28" />
          <Skeleton className="mb-3 h-10 w-64" />
          <Skeleton className="h-4 w-full max-w-xl" />
        </section>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-5">
          {[0, 1, 2, 3, 4].map((i) => <MetricCardSkeleton key={i} />)}
        </div>
        <div className="grid grid-cols-1 gap-4 xl:grid-cols-[1.4fr_0.9fr]">
          <div className="panel p-5"><Skeleton className="h-64 w-full" /></div>
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-1">
            {[0, 1, 2].map((i) => <MetricCardSkeleton key={i} />)}
          </div>
        </div>
        <div className="panel p-5">
          <Skeleton className="mb-4 h-4 w-32" />
          {[0, 1, 2, 3, 4, 5].map((i) => (
            <Skeleton key={i} className="mb-2 h-10 w-full rounded-xl" />
          ))}
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="page-section">
        <SummaryBanner title="Dashboard unavailable" body={error} tone="danger" />
      </div>
    );
  }

  if (!data) return null;

  const isDryRun = data.botMode === 'DRY_RUN' || data.botMode === 'dry_run';
  const blockedCount = data.botState?.positionStates.filter((p) => p.inSafeMode || p.killSwitch.triggered).length ?? 0;

  return (
    <div className="page-section">
      <section className="page-hero animate-fade-rise">
        <div className="page-grid lg:grid-cols-[1.6fr_0.8fr] lg:items-end">
          <div className="space-y-4">
            <div>
              <p className="eyebrow">
                {data.positions.total > 0 ? `${data.positions.total} Position${data.positions.total !== 1 ? 's' : ''} · ` : ''}
                {isDryRun ? 'Dry Run' : 'Live Mode'}
              </p>
              <h1 className="mt-2 text-4xl font-semibold tracking-[-0.05em] text-white sm:text-5xl">
                Full-spectrum LP control.
              </h1>
            </div>
            <p className="max-w-3xl text-sm leading-7 text-slate-300 sm:text-base">
              Bot posture, recovery state, chain balances, and position risk — organized for operational clarity, not reporting.
            </p>
          </div>
          <div className={`panel-muted grid gap-3 p-4 sm:grid-cols-2 lg:grid-cols-1 border-l-2 ${isDryRun ? 'border-amber-500/40' : 'border-emerald-500/30'}`}>
            <div>
              <p className="metric-card-label">Execution Wallet</p>
              <p className="mt-2 text-sm text-slate-300">{data.wallet.address}</p>
            </div>
            <div>
              <p className="metric-card-label">Bot Posture</p>
              <p className={`mt-2 flex items-center gap-1.5 text-base font-semibold ${isDryRun ? 'text-theme-warning' : 'text-theme-success'}`}>
                <span className={`h-2 w-2 shrink-0 rounded-full ${isDryRun ? 'bg-amber-400' : 'bg-emerald-400 shadow-[0_0_6px_rgba(85,214,167,0.6)]'}`} />
                {isDryRun ? 'Dry Run' : 'Live Execution'}
              </p>
            </div>
          </div>
        </div>
      </section>

      {recovery?.hasAlert && recovery.report && (
        <SummaryBanner
          title={`Recovery required for #${recovery.report.oldTokenId}`}
          body={`Stranded funds detected for ${recovery.report.token0Symbol}/${recovery.report.token1Symbol}. Wallet balances currently show ${recovery.report.balance0} ${recovery.report.token0Symbol} and ${recovery.report.balance1} ${recovery.report.token1Symbol}.`}
          tone="warning"
          actions={
            <>
              <button onClick={() => setRecoveryAction('dismiss')} disabled={recoveryLoading} className="action-button action-button-secondary">
                Dismiss Alert
              </button>
              <button
                onClick={() => setRecoveryAction('recover')}
                disabled={recoveryLoading || isDryRun}
                className="action-button bg-amber-400 text-slate-950 hover:bg-amber-300 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {recoveryLoading ? 'Working...' : 'Recover Funds'}
              </button>
            </>
          }
        />
      )}

      {data.botState && !data.botState.rebalancingEnabled && (
        <SummaryBanner
          title="Bot halted — rebalancing suspended"
          body="The emergency stop is active. No automated rebalance actions will execute until the bot is re-enabled."
          tone="danger"
          actions={
            <button onClick={handleEnableBot} disabled={botActionLoading} className="action-button bg-emerald-400 text-slate-950 hover:bg-emerald-300 disabled:opacity-50">
              {botActionLoading ? 'Working...' : 'Enable Bot'}
            </button>
          }
        />
      )}

      {data.botState?.rebalancingEnabled && blockedCount > 0 && (
        <SummaryBanner
          title={`${blockedCount} position${blockedCount > 1 ? 's are' : ' is'} blocked`}
          body="Safe mode and kill-switch states remain visible in the position grid below. Review those positions before forcing any manual actions."
          tone="warning"
        />
      )}

      {botActionMsg && <SummaryBanner title="Bot action response" body={botActionMsg} tone="warning" />}

      {recoveryAction === 'dismiss' && (
        <ConfirmDialog
          title="Dismiss Recovery Alert"
          message="This clears the recovery-state file. If stranded funds still exist in the wallet, recovery will need to be handled manually later."
          confirmLabel="Dismiss"
          onConfirm={handleDismiss}
          onCancel={() => setRecoveryAction(null)}
        />
      )}

      {recoveryAction === 'recover' && (
        <ConfirmDialog
          title="Recover Stranded Funds"
          message="This mints a new LP position using wallet balances and executes a real on-chain transaction. Continue only if you want recovery to proceed immediately."
          confirmLabel="Recover"
          onConfirm={handleRecover}
          onCancel={() => setRecoveryAction(null)}
        />
      )}

      <section className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-5">
        <MetricCard label="Native Balance" value={Number(data.wallet.plsBalance).toLocaleString()} subValue="Primary execution wallet" color="blue" tone="accent" />
        <MetricCard label="Total Positions" value={String(data.positions.total)} subValue="Configured management scope" tone="neutral" />
        <MetricCard label="In Range" value={String(data.positions.inRange)} subValue="Currently earning inside band" color="green" tone="success" />
        <MetricCard label="Out of Range" value={String(data.positions.outOfRange)} subValue="Needs monitoring or action" color="red" tone={data.positions.outOfRange > 0 ? 'danger' : 'neutral'} />
        <MetricCard label="Execution Mode" value={isDryRun ? 'DRY RUN' : 'LIVE'} subValue={data.botState?.rebalancingEnabled ? 'Bot enabled' : 'Bot disabled'} color={isDryRun ? 'yellow' : 'green'} tone={isDryRun ? 'warning' : 'success'} />
      </section>

      <section className="grid grid-cols-1 gap-4 xl:grid-cols-[1.5fr_0.95fr]">
        <div className="chart-shell p-5">
          <SectionHeader title="Fee Throughput" copy="Realized fee collections across the managed portfolio — last 30 days." />
          <div className="mt-5">
            {earningsLoading ? <Skeleton className="h-64 w-full" /> : <DailyEarningsChart data={earningsData} />}
          </div>
        </div>

        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-1">
          {portfolio ? (
            <>
              <MetricCard label="Portfolio Value" value={formatUsd(portfolio.totalValueUsd)} color="blue" tone="accent" />
              <MetricCard label="Fees Earned" value={formatUsd(portfolio.totalFeesEarnedUsd)} color="green" tone="success" />
              <MetricCard label="Claimable Yield" value={formatUsd(data.totalClaimableUsd ?? data.totalUnclaimedFeesUsd ?? 0)} color="yellow" tone="warning" />
              <MetricCard label="Gas Costs" value={formatUsd(portfolio.totalGasCostUsd)} color="red" tone="danger" />
              <MetricCard
                label={portfolio.portfolioTotalPnlUsd !== null && portfolio.portfolioTotalPnlUsd !== undefined ? 'True P&L' : 'Net P&L'}
                value={formatUsd(portfolio.portfolioTotalPnlUsd ?? portfolio.netPnlUsd)}
                subValue={portfolio.portfolioTotalPnlPercent != null
                  ? `${portfolio.portfolioTotalPnlPercent >= 0 ? '+' : ''}${portfolio.portfolioTotalPnlPercent.toFixed(2)}%${portfolio.portfolioLpVsHodlPercent != null ? ` | LP vs HODL ${portfolio.portfolioLpVsHodlPercent >= 0 ? '+' : ''}${portfolio.portfolioLpVsHodlPercent.toFixed(1)}%` : ''}`
                  : 'Portfolio summary based on the current analytics contract'}
                color={(portfolio.portfolioTotalPnlUsd ?? portfolio.netPnlUsd) >= 0 ? 'green' : 'red'}
                tone={(portfolio.portfolioTotalPnlUsd ?? portfolio.netPnlUsd) >= 0 ? 'success' : 'danger'}
              />
            </>
          ) : portfolioError ? (
            <div className="panel p-5 text-sm text-slate-400">Portfolio analytics are temporarily unavailable and will refresh on the next cycle.</div>
          ) : (
            [0, 1, 2, 3, 4].map((i) => <MetricCardSkeleton key={i} />)
          )}
        </div>
      </section>

      {portfolio && (
        <section className="panel p-5">
          <SectionHeader
            title="Data Exports"
            copy="Download rebalance history, position snapshots, and combined records."
            actions={
              <div className="flex flex-wrap gap-2">
                <button onClick={() => downloadFile('/api/analytics/export/csv?type=rebalances&days=365', 'rebalances_365d.csv')} className="action-button action-button-secondary">
                  Rebalances CSV
                </button>
                <button onClick={() => downloadFile('/api/analytics/export/csv?type=snapshots&days=90', 'snapshots_90d.csv')} className="action-button action-button-secondary">
                  Snapshots CSV
                </button>
                <button onClick={() => downloadFile('/api/analytics/export/csv?type=combined&days=365', 'combined_all_365d.csv')} className="action-button action-button-secondary">
                  Combined CSV
                </button>
              </div>
            }
          />
        </section>
      )}

      <section className="panel p-5">
        <SectionHeader
          title="Positions"
          copy={positionView === 'table'
            ? 'High-density table view. Click any row to open position detail.'
            : 'Live monitoring cards preserve risk-state badges, chain context, and fee posture.'}
          actions={
            <div className="flex items-center gap-2">
              <div className="flex overflow-hidden rounded-xl border border-white/10 text-xs">
                <button
                  onClick={() => { setPositionView('table'); localStorage.setItem('dashboard_position_view', 'table'); }}
                  className={`px-3 py-1.5 font-medium transition-colors ${positionView === 'table' ? 'bg-white/10 text-white' : 'text-slate-500 hover:text-slate-300'}`}
                  aria-pressed={positionView === 'table'}
                >Table</button>
                <button
                  onClick={() => { setPositionView('card'); localStorage.setItem('dashboard_position_view', 'card'); }}
                  className={`px-3 py-1.5 font-medium transition-colors ${positionView === 'card' ? 'bg-white/10 text-white' : 'text-slate-500 hover:text-slate-300'}`}
                  aria-pressed={positionView === 'card'}
                >Cards</button>
              </div>
              {data.botState?.rebalancingEnabled && (
                <button onClick={handleDisableBot} disabled={botActionLoading} className="action-button action-button-secondary text-rose-200">
                  Emergency Stop
                </button>
              )}
            </div>
          }
        />
        <div className="mt-5">
          {sortedPositionList.length === 0 ? (
            <div className="empty-state">No positions configured. Add via Telegram /new command.</div>
          ) : positionView === 'table' ? (
            <PositionsTable positions={sortedPositionList} />
          ) : (
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2 2xl:grid-cols-3">
              {sortedPositionList.map((pos) => (
                <PositionCard key={pos.tokenId} position={pos} />
              ))}
            </div>
          )}
        </div>
      </section>

      {data.chainBalances && data.chainBalances.length > 0 && (
        <section className="panel p-5">
          <SectionHeader title="Chain Balances" copy="Native balances across configured execution chains." />
          <div className="mt-5 grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
            {data.chainBalances.map((balance) => (
              <div key={balance.chainId} className="panel-muted p-4">
                <p className="metric-card-label">{balance.chainName}</p>
                <p className="mt-2 text-data text-lg font-semibold text-white">{Number(balance.balance).toLocaleString()}</p>
                <p className="mt-1 text-sm text-slate-400">{balance.nativeSymbol}</p>
              </div>
            ))}
          </div>
        </section>
      )}

      {data.walletTokens && data.walletTokens.length > 0 && (
        <section className="panel p-5">
          <SectionHeader title="Idle Holdings" copy="Undeployed wallet assets available for LP allocation." />
          <div className="mt-5">
            <HoldingsTable data={data.walletTokens} />
          </div>
        </section>
      )}
    </div>
  );
}

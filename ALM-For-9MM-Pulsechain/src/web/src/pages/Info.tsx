import { useState, useEffect } from 'react';

interface ChainDex {
  key: string;
  protocolName: string;
  swapRouterType: string;
}

interface FeeTier {
  fee: number;
  tickSpacing: number;
  label: string;
}

interface ChainInfo {
  chainId: number;
  chainName: string;
  protocolName: string;
  nativeCurrency: string;
  blockExplorerUrl: string;
  blockTimeSeconds?: number;
  feeTiers: FeeTier[];
  swapRouterType: string;
  dexes?: ChainDex[];
  aggregators: { piteas: boolean; oneinch: boolean };
}

export default function Info() {
  const [chains, setChains] = useState<ChainInfo[]>([]);
  const [chainsLoading, setChainsLoading] = useState(true);
  const [chainsError, setChainsError] = useState<string | null>(null);

  useEffect(() => {
    const token = localStorage.getItem('alm_token');
    fetch('/api/config/chains', {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    })
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json();
      })
      .then((data: ChainInfo[]) => {
        setChains(data);
        setChainsLoading(false);
      })
      .catch((err) => {
        setChainsError(err.message);
        setChainsLoading(false);
      });
  }, []);

  const features = [
    {
      title: 'Automated Rebalancing',
      description:
        'Monitors concentrated liquidity positions and automatically rebalances when price moves out of range. Configurable trigger distance, confirmation delay, range width, and optional cost-benefit gate per position. Kill switch halts trading on excessive losses.',
    },
    {
      title: 'Multi-Chain Support',
      description:
        'Manage positions across multiple EVM chains from a single process. Each chain gets its own RPC provider with fallback rotation, nonce tracker, and contract instances.',
    },
    {
      title: 'Multi-DEX Support',
      description:
        'Supports multiple V3 DEX protocols per chain: Uniswap V3, PancakeSwap V3 (9mm), Aerodrome CL / Slipstream (original + Gauge Caps), and Algebra V3 (Shadow on Sonic). Positions specify which DEX via the config dex field.',
    },
    {
      title: 'DEX Aggregator Swaps',
      description:
        'Uses DEX aggregators (Piteas on PulseChain, 1inch on Ethereum/Base/Arbitrum) for optimal swap routing during rebalances. Falls back to direct router swaps when aggregators are unavailable.',
    },
    {
      title: 'Telegram Bot',
      description:
        'Two-way Telegram bot with 20+ commands for monitoring, managing positions, adjusting strategies, collecting fees, forcing rebalances, and controlling the bot. Includes interactive guided flows for adding new positions.',
    },
    {
      title: 'Analytics & Tracking',
      description:
        'Tracks rebalance history, fees collected, impermanent loss, capital efficiency, daily earnings, tick volatility, and position health scores (0-100). Includes position chain lineage tracking across rebalances and CSV/JSON export.',
    },
    {
      title: 'Recovery System',
      description:
        'Detects stranded funds after failed rebalances and provides automated recovery -- swaps to correct token ratio and re-mints positions from remaining wallet balances.',
    },
    {
      title: 'Safety Mechanisms',
      description:
        'TWAP oracle validation with cardinality checks, confirmation delay timers, safe mode on contract reverts, transient RPC error classification with retry caps, cross-process rebalance lock files, and kill switch protection.',
    },
    {
      title: 'Gauge Staking',
      description:
        'Aerodrome CL positions can be staked in gauges for additional rewards. The bot automatically unstakes before rebalancing and re-stakes after minting the new position. Non-fatal re-stake failures do not trigger safe mode.',
    },
    {
      title: 'Cost-Benefit Gate',
      description:
        'Opt-in per-position feature that skips rebalances when unclaimed fees are less than estimated gas costs. Configurable fee-to-cost ratio threshold (default 1.5x). Fails open when price data is unavailable.',
    },
    {
      title: 'Position Discovery',
      description:
        'Wallet scanner (/scan) discovers positions across all configured chains and DEXes via ERC721Enumerable. Auto-detects chain, DEX protocol, token pair, and current range for easy onboarding.',
    },
    {
      title: 'Proactive Alerts',
      description:
        'Scheduled notifications for approaching range edges, confirmation timer countdowns, and daily portfolio summary digests. Configurable via /alerts command with rate limiting to prevent spam.',
    },
  ];

  const strategies = [
    {
      name: 'center_3pct',
      width: '~3%',
      description: 'Centered range (~300 ticks) -- higher capital efficiency, more frequent rebalances.',
    },
    {
      name: 'center_6pct',
      width: '~6%',
      description: 'Centered range (~583 ticks) -- balanced between efficiency and rebalance frequency.',
    },
    {
      name: 'bullish_3pct / bullish_6pct',
      width: '~3% / ~6%',
      description: 'Asymmetric range (30% below / 70% above by default) -- gives price more room to run up.',
    },
    {
      name: 'bearish_3pct / bearish_6pct',
      width: '~3% / ~6%',
      description: 'Asymmetric range (70% below / 30% above by default) -- gives price more room to drop.',
    },
    {
      name: 'lazy_up / lazy_down',
      width: 'Custom',
      description: 'One-directional rebalancing -- only rebalances on pump (up) or dump (down), ignores the other direction.',
    },
    {
      name: 'static',
      width: 'N/A',
      description: 'Monitor-only mode -- tracks position status and sends alerts but never executes rebalances.',
    },
    {
      name: 'custom (center / bullish / bearish)',
      width: 'User-defined',
      description: 'Fully customizable width, trigger distance, and asymmetric lower/upper ratios. Use any percentage suffix (e.g., center_12pct).',
    },
  ];

  const telegramCommands = {
    Monitoring: [
      ['/status', 'Position status (in/out of range, tick, liquidity, unclaimed fees)'],
      ['/balance', 'Wallet native balances across all configured chains'],
      ['/chain [id]', 'Position rebalance chain lineage with per-link metrics (fees, gas, APR)'],
      ['/scan', 'Discover wallet positions across all chains and DEXes'],
    ],
    'Position Management': [
      ['/new', 'Add a new position via interactive guided flow'],
      ['/config [id] [param=value]', 'View or update strategy parameters (width, trigger, ratios, cost-benefit)'],
      ['/collect', 'Collect unclaimed fees from a position'],
      ['/remove', 'Remove liquidity (partial percentage or full)'],
      ['/removestale', 'Remove burned or invalid positions from config'],
    ],
    'Rebalance & Liquidity': [
      ['/rebalance', 'Force an immediate rebalance (validates TWAP first)'],
      ['/increase', 'Add liquidity to current range'],
      ['/decrease', 'Remove liquidity from position'],
      ['/link <old> <new> [note]', 'Manually link two positions in a rebalance chain'],
    ],
    'Safety & Control': [
      ['/enable', 'Enable rebalancing (clears safe mode and kill switch)'],
      ['/disable', 'Emergency stop (persists across restarts)'],
      ['/alerts [enable|disable]', 'Toggle proactive notifications (range, timer, digest)'],
      ['/fixtwap [id]', 'Increase TWAP oracle observation cardinality on-chain'],
    ],
    Other: [
      ['/help', 'Show available commands and current bot status'],
      ['/cancel', 'Cancel any active interactive flow'],
    ],
  };

  const apiCategories = [
    { name: 'Dashboard', description: 'Aggregated wallet overview, position statuses, bot health, safe mode, and kill switch status across all chains.' },
    { name: 'Positions', description: 'Full CRUD for position configs, live on-chain status, manual fee collection, forced rebalances, and liquidity increase/decrease.' },
    { name: 'Analytics', description: 'Portfolio and per-position summaries, snapshots over time, daily earnings, health scores (0-100), tick volatility analysis, position chain lineage, and CSV/JSON export.' },
    { name: 'Rebalance History', description: 'Filterable rebalance events with fees collected, gas costs, swap details, and step-by-step lifecycle events.' },
    { name: 'Recovery', description: 'Detect stranded funds from failed rebalances, dismiss alerts, or trigger automated recovery mints.' },
    { name: 'Bot Control', description: 'Enable/disable rebalancing, clear safe mode for specific positions, and reset kill switch counters.' },
    { name: 'Calculator', description: 'Live pool state queries (price, tick, liquidity) and target token split ratios for planning new positions.' },
    { name: 'Config', description: 'Sanitized runtime configuration (secrets redacted, RPC URLs show hostname only).' },
  ];

  const safetyMechanisms = [
    { name: 'TWAP Oracle Validation', description: 'Checks time-weighted average price before every rebalance to prevent flash-loan manipulation. Retries shorter windows (300s, 60s, 10s) if pool cardinality is low.' },
    { name: 'Confirmation Delay', description: 'Position must stay out of range for a configurable period (e.g., 60 min) before rebalancing. Bypassed when position drifts beyond critical distance.' },
    { name: 'Kill Switch', description: 'Halts rebalancing on excessive losses: max loss percentage, consecutive loss count, loss window hours, and minimum hodl ratio thresholds.' },
    { name: 'Safe Mode', description: 'Auto-halts on contract reverts (CALL_EXCEPTION). Notifies via Telegram and dashboard. Requires manual acknowledgment to resume.' },
    { name: 'Transient Error Classification', description: 'RPC errors (504, timeout, ECONNRESET) are retried up to 5 times without entering safe mode. Contract reverts always trigger safe mode.' },
    { name: 'Cross-Process Locks', description: 'Lock files prevent the bot and dashboard from executing on-chain transactions for the same position simultaneously.' },
    { name: 'Cost-Benefit Gate', description: 'Opt-in check that skips rebalances when estimated gas costs exceed unclaimed fees. Fails open if price data is unavailable.' },
    { name: 'Gauge Validation', description: 'Before any gauge operation, validates the gauge address against the known Aerodrome Voter contract on-chain.' },
  ];

  /** Map swapRouterType to a display-friendly name */
  function dexTypeLabel(routerType: string): string | null {
    switch (routerType) {
      case 'pancakeswap-v3': return 'PancakeSwap V3 fork';
      case 'aerodrome-cl': return 'Slipstream (UniswapV3 fork)';
      case 'aerodrome-cl-gc': return 'Slipstream Gauge Caps';
      case 'algebra-v3': return 'Algebra V3 (Shadow)';
      case 'uniswap-v3': return null;
      default: return routerType;
    }
  }

  /** Get aggregator names for a chain */
  function aggregatorNames(agg: ChainInfo['aggregators']): string[] {
    const names: string[] = [];
    if (agg.piteas) names.push('Piteas');
    if (agg.oneinch) names.push('1inch');
    if (names.length === 0) names.push('Direct only');
    return names;
  }

  return (
    <div className="mx-auto max-w-6xl space-y-8 px-4 py-8">
      <section className="panel overflow-hidden">
        <div className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-cyan-400/50 to-transparent" />
        <h1 className="text-3xl font-bold tracking-tight text-white">System Info</h1>
        <p className="mt-2 max-w-4xl text-sm leading-6 text-slate-300">
          Overview of supported networks, DEXes, features, strategies, commands, API, and safety mechanisms.
        </p>
      </section>

      {/* Features */}
      <Section title="Features">
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          {features.map((f) => (
            <div key={f.title} className="rounded-[24px] border border-white/10 bg-white/[0.03] p-4">
              <h3 className="text-sm font-semibold text-white mb-1">{f.title}</h3>
              <p className="text-xs leading-relaxed text-slate-400">{f.description}</p>
            </div>
          ))}
        </div>
      </Section>

      {/* Networks & DEXes */}
      <Section title="Supported Networks">
        {chainsLoading ? (
          <div className="space-y-4">
            {[1, 2, 3].map((i) => (
              <div key={i} className="h-32 animate-pulse rounded-[24px] border border-white/10 bg-white/[0.03]" />
            ))}
          </div>
        ) : chainsError ? (
          <div className="rounded-3xl border border-red-400/30 bg-red-500/10 p-4 text-sm text-red-200">
            Failed to load chain data: {chainsError}
          </div>
        ) : (
          <div className="space-y-4">
            {chains.map((chain) => {
              const allDexes: { name: string; type: string | null; feeTiers: string[]; notes: string | null }[] = [];

              allDexes.push({
                name: chain.protocolName,
                type: dexTypeLabel(chain.swapRouterType),
                feeTiers: chain.feeTiers.map((ft) => ft.label),
                notes: chain.feeTiers.some((ft) => ft.fee === 2500 && ft.tickSpacing === 50)
                  ? 'Medium tier is 0.25% (2500) with tick spacing 50'
                  : null,
              });

              if (chain.dexes) {
                for (const dex of chain.dexes) {
                  allDexes.push({
                    name: dex.protocolName,
                    type: dexTypeLabel(dex.swapRouterType),
                    feeTiers: chain.feeTiers.map((ft) => ft.label),
                    notes: null,
                  });
                }
              }

              const blockTime = chain.blockTimeSeconds
                ? `~${chain.blockTimeSeconds}s`
                : null;

              return (
                <div key={chain.chainId} className="overflow-hidden rounded-[28px] border border-white/10 bg-white/[0.03]">
                  <div className="flex items-center justify-between border-b border-white/10 px-4 py-3">
                    <div className="flex items-center gap-3">
                      <span className="text-white font-semibold">{chain.chainName}</span>
                      <span className="font-mono text-xs text-slate-500">Chain {chain.chainId}</span>
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="text-xs text-slate-500">{chain.nativeCurrency}</span>
                      {blockTime && (
                        <>
                          <span className="text-xs text-slate-600">|</span>
                          <span className="text-xs text-slate-500">{blockTime} blocks</span>
                        </>
                      )}
                    </div>
                  </div>
                  <div className="px-4 py-3 space-y-3">
                    {allDexes.map((dex) => (
                      <div key={dex.name} className="flex flex-col gap-1">
                        <div className="flex items-center gap-2">
                          <span className="text-sm text-blue-400 font-medium">{dex.name}</span>
                          {dex.type && (
                            <span className="rounded-full border border-white/10 bg-white/[0.03] px-1.5 py-0.5 text-[10px] text-slate-400">
                              {dex.type}
                            </span>
                          )}
                        </div>
                        <div className="flex items-center gap-1.5">
                          <span className="text-xs text-slate-500">Fee tiers:</span>
                          {dex.feeTiers.map((fee) => (
                            <span key={fee} className="rounded-full border border-white/10 bg-white/[0.03] px-1.5 py-0.5 font-mono text-[10px] text-slate-300">
                              {fee}
                            </span>
                          ))}
                        </div>
                        {dex.notes && (
                          <p className="text-[11px] text-yellow-500/70">{dex.notes}</p>
                        )}
                      </div>
                    ))}
                    <div className="flex items-center gap-2 border-t border-white/10 pt-1">
                      <span className="text-xs text-slate-500">Aggregator:</span>
                      {aggregatorNames(chain.aggregators).map((a) => (
                        <span key={a} className="text-xs text-green-400/80">{a}</span>
                      ))}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </Section>

      {/* Strategies */}
      <Section title="Rebalance Strategies">
        <div className="overflow-hidden rounded-[28px] border border-white/10 bg-white/[0.03]">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-white/10 text-xs text-slate-500">
                <th className="text-left px-4 py-2 font-medium">Strategy</th>
                <th className="text-left px-4 py-2 font-medium">Width</th>
                <th className="text-left px-4 py-2 font-medium">Description</th>
              </tr>
            </thead>
            <tbody>
              {strategies.map((s) => (
                <tr key={s.name} className="border-b border-white/5 last:border-0">
                  <td className="px-4 py-2.5 text-blue-400 font-mono text-xs">{s.name}</td>
                  <td className="px-4 py-2.5 text-xs text-slate-300">{s.width}</td>
                  <td className="px-4 py-2.5 text-xs text-slate-400">{s.description}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="border-t border-white/10 px-4 py-2.5 text-[11px] text-slate-500">
            Legacy aliases still work: <span className="font-mono text-slate-300">pulse</span> = center,{' '}
            <span className="font-mono text-slate-300">snuggle_up</span> = bullish,{' '}
            <span className="font-mono text-slate-300">snuggle_down</span> = bearish,{' '}
            <span className="font-mono text-slate-300">lazy_ascending</span> = lazy_up,{' '}
            <span className="font-mono text-slate-300">lazy_descending</span> = lazy_down.
            Width uses V3 exponential formula (6% = ~583 ticks, not 600).
          </div>
        </div>
      </Section>

      {/* Telegram Commands */}
      <Section title="Telegram Commands">
        <div className="space-y-4">
          {Object.entries(telegramCommands).map(([category, cmds]) => (
            <div key={category} className="overflow-hidden rounded-[24px] border border-white/10 bg-white/[0.03]">
              <div className="border-b border-white/10 px-4 py-2">
                <span className="text-xs font-medium text-slate-300">{category}</span>
              </div>
              <table className="w-full text-sm">
                <tbody>
                  {cmds.map(([cmd, desc]) => (
                    <tr key={cmd} className="border-b border-white/5 last:border-0">
                      <td className="px-4 py-2 text-green-400 font-mono text-xs whitespace-nowrap">{cmd}</td>
                      <td className="px-4 py-2 text-xs text-slate-400">{desc}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ))}
        </div>
      </Section>

      {/* API Endpoints */}
      <Section title="API Endpoints">
        <p className="mb-3 text-xs text-slate-500">
          All endpoints require JWT authentication. The dashboard uses these internally.
        </p>
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          {apiCategories.map((cat) => (
            <div key={cat.name} className="rounded-[24px] border border-white/10 bg-white/[0.03] p-3">
              <h3 className="text-xs font-semibold text-blue-400 mb-1">{cat.name}</h3>
              <p className="text-[11px] leading-relaxed text-slate-400">{cat.description}</p>
            </div>
          ))}
        </div>
      </Section>

      {/* Safety & Risk Controls */}
      <Section title="Safety & Risk Controls">
        <div className="overflow-hidden rounded-[28px] border border-white/10 bg-white/[0.03]">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-white/10 text-xs text-slate-500">
                <th className="text-left px-4 py-2 font-medium">Mechanism</th>
                <th className="text-left px-4 py-2 font-medium">Description</th>
              </tr>
            </thead>
            <tbody>
              {safetyMechanisms.map((s) => (
                <tr key={s.name} className="border-b border-white/5 last:border-0">
                  <td className="px-4 py-2.5 text-yellow-400/80 text-xs font-medium whitespace-nowrap">{s.name}</td>
                  <td className="px-4 py-2.5 text-xs text-slate-400">{s.description}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Section>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mb-8">
      <h2 className="mb-3 text-lg font-semibold text-white">{title}</h2>
      {children}
    </section>
  );
}

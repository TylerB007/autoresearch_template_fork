import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';

// Static system status rows
const STATUS_ROWS = [
  { label: 'Strategy Engine', value: 'Active' },
  { label: 'Market Data', value: 'Connected' },
  { label: 'RPC Nodes', value: 'Healthy' },
  { label: 'Rebalance Logic', value: 'Monitoring' },
];

// Chain badges — same styles as PositionCard
const CHAIN_BADGES = [
  { label: 'PLS', className: 'bg-purple-900/60 text-purple-300 border border-purple-700' },
  { label: 'ETH', className: 'bg-blue-900/60 text-blue-300 border border-blue-700' },
  { label: 'BASE', className: 'bg-sky-900/60 text-cyan-300 border border-cyan-700' },
  { label: 'ARB', className: 'bg-indigo-900/60 text-indigo-300 border border-indigo-700' },
  { label: 'S', className: 'bg-amber-900/60 text-amber-300 border border-amber-700' },
];

// Inline SVG liquidity visualization — pure CSS animation, no library
function LiquidityViz() {
  // Bell-curve path for the liquidity distribution shape
  // Coordinates: viewBox 0 0 800 300, curve peaks around x=400
  const curvePath =
    'M 0 280 C 60 280 80 260 120 240 C 160 220 180 180 220 150 C 260 120 300 60 340 30 C 360 16 380 8 400 6 C 420 8 440 16 460 30 C 500 60 540 120 580 150 C 620 180 640 220 680 240 C 720 260 740 280 800 280 Z';

  // Pool range bands (colored rectangles under the curve)
  const bands = [
    { x: 310, width: 180, color: 'rgba(85,214,167,0.13)' },   // emerald — narrow range
    { x: 260, width: 280, color: 'rgba(115,184,255,0.10)' },  // sky — medium range
    { x: 200, width: 400, color: 'rgba(246,191,98,0.07)' },   // amber — wide range
  ];

  return (
    <svg
      viewBox="0 0 800 300"
      preserveAspectRatio="xMidYMid slice"
      className="absolute inset-0 h-full w-full"
      aria-hidden="true"
    >
      <defs>
        {/* Clip path to keep band fills under the curve */}
        <clipPath id="curve-clip">
          <path d={curvePath} />
        </clipPath>

        {/* Fade-out mask so the viz dissolves at edges */}
        <linearGradient id="h-fade" x1="0" x2="1" y1="0" y2="0">
          <stop offset="0%" stopColor="white" stopOpacity="0" />
          <stop offset="15%" stopColor="white" stopOpacity="1" />
          <stop offset="85%" stopColor="white" stopOpacity="1" />
          <stop offset="100%" stopColor="white" stopOpacity="0" />
        </linearGradient>
        <mask id="h-fade-mask">
          <rect width="800" height="300" fill="url(#h-fade)" />
        </mask>
      </defs>

      <g mask="url(#h-fade-mask)">
        {/* Horizontal tick grid lines — staggered pulse */}
        {Array.from({ length: 14 }, (_, i) => {
          const y = 20 + i * 20;
          const delay = `${(i * 0.4).toFixed(1)}s`;
          return (
            <line
              key={i}
              x1="0" y1={y} x2="800" y2={y}
              stroke="rgba(115,184,255,0.07)"
              strokeWidth="1"
              style={{
                animation: `lv-pulse 9s ease-in-out ${delay} infinite alternate`,
              }}
            />
          );
        })}

        {/* Pool range band fills (clipped to curve shape) */}
        {bands.map((b, i) => (
          <rect
            key={i}
            x={b.x} y={0}
            width={b.width} height={300}
            fill={b.color}
            clipPath="url(#curve-clip)"
          />
        ))}

        {/* Liquidity curve outline */}
        <path
          d={curvePath}
          fill="rgba(115,184,255,0.04)"
          stroke="rgba(115,184,255,0.18)"
          strokeWidth="1.5"
          style={{ animation: 'lv-curve 11s ease-in-out infinite alternate' }}
        />

        {/* Current price vertical line — drifts slowly */}
        <line
          x1="400" y1="0" x2="400" y2="300"
          stroke="rgba(85,214,167,0.35)"
          strokeWidth="1"
          strokeDasharray="4 6"
          style={{ animation: 'lv-price 14s ease-in-out infinite alternate' }}
        />

        {/* Price dot on the curve */}
        <circle
          cx="400" cy="6" r="3"
          fill="rgba(85,214,167,0.7)"
          style={{ animation: 'lv-price 14s ease-in-out infinite alternate' }}
        />
      </g>

      <style>{`
        @keyframes lv-pulse {
          from { opacity: 0.4; }
          to   { opacity: 1; }
        }
        @keyframes lv-curve {
          from { opacity: 0.7; }
          to   { opacity: 1; }
        }
        @keyframes lv-price {
          from { transform: translateX(-60px); }
          to   { transform: translateX(60px); }
        }
      `}</style>
    </svg>
  );
}

export default function Login() {
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const { login } = useAuth();
  const navigate = useNavigate();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      await login(password);
      navigate('/');
    } catch {
      setError('Invalid password');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="relative min-h-screen overflow-hidden px-4 py-10">
      {/* Base radial gradients */}
      <div className="absolute inset-0 bg-[radial-gradient(circle_at_top_left,rgba(115,184,255,0.14),transparent_28%),radial-gradient(circle_at_bottom_right,rgba(85,214,167,0.12),transparent_24%)]" />

      {/* Liquidity curve visualization */}
      <div className="absolute inset-0 opacity-60">
        <LiquidityViz />
      </div>

      <div className="relative mx-auto flex min-h-[calc(100vh-5rem)] max-w-6xl items-center justify-center">
        <div className="grid w-full gap-8 lg:grid-cols-[1.15fr_0.85fr]">

          {/* ── LEFT: Hero copy + system status ── */}
          <section className="page-hero flex flex-col justify-between">
            <div>
              <p className="eyebrow">Automated Liquidity Infrastructure</p>
              <h1 className="mt-3 max-w-2xl text-4xl font-semibold tracking-[-0.06em] sm:text-5xl lg:text-6xl">
                <span className="bg-gradient-to-r from-white to-sky-300 bg-clip-text text-transparent">
                  Autonomous execution.
                </span>
                <br />
                <span className="text-white">Real-time control.</span>
              </h1>
              <p className="mt-5 max-w-xl text-sm leading-7 text-slate-300 sm:text-base">
                Monitor pool state, manage liquidity ranges, and execute automated
                rebalance logic across Ethereum, Base, Arbitrum, and PulseChain.
              </p>
            </div>

            {/* System status panel */}
            <div className="mt-8 space-y-3">
              <div className="panel-muted p-5">
                <p className="eyebrow mb-4">System Status</p>
                <div className="space-y-3">
                  {STATUS_ROWS.map(({ label, value }) => (
                    <div key={label} className="flex items-center justify-between">
                      <div className="flex items-center gap-2.5">
                        <span className="h-2 w-2 shrink-0 rounded-full bg-emerald-400 shadow-[0_0_6px_rgba(85,214,167,0.6)]" />
                        <span className="text-data text-xs text-slate-400">{label}</span>
                      </div>
                      <span className="text-data text-xs font-medium text-emerald-300">{value}</span>
                    </div>
                  ))}
                </div>
              </div>

              {/* Chain badges */}
              <div className="flex flex-wrap items-center gap-2 px-1">
                <span className="text-data text-[10px] uppercase tracking-widest text-slate-600">Networks</span>
                {CHAIN_BADGES.map(({ label, className }) => (
                  <span
                    key={label}
                    className={`inline-flex items-center rounded-full px-2 py-1 text-[10px] font-semibold leading-none ${className}`}
                  >
                    {label}
                  </span>
                ))}
              </div>
            </div>
          </section>

          {/* ── RIGHT: Auth card ── */}
          <section
            className="modal-panel self-center p-6 sm:p-8"
            style={{ boxShadow: '0 0 80px rgba(90,140,220,0.12), var(--shadow)' }}
          >
            <p className="eyebrow">Operator Authentication</p>
            <h2 className="mt-2 text-3xl font-semibold tracking-[-0.05em] text-white">
              Enter Control Surface
            </h2>
            <p className="mt-3 text-sm leading-6 text-slate-400">
              Protected operator session. Authenticate to access live position
              monitoring and execution controls.
            </p>

            <form onSubmit={handleSubmit} className="mt-8 space-y-5">
              <div>
                <label htmlFor="password" className="field-label">Password</label>
                <input
                  id="password"
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className="field-input"
                  placeholder="Enter password"
                  required
                  autoFocus
                />
              </div>

              {error && (
                <div className="banner banner-danger">
                  <p className="text-sm text-slate-100">{error}</p>
                </div>
              )}

              <button
                type="submit"
                disabled={loading}
                className="action-button action-button-primary w-full disabled:cursor-not-allowed disabled:opacity-60"
              >
                {loading ? 'Authenticating...' : 'Authenticate →'}
              </button>

              <div className="space-y-1.5 text-center">
                <p className="text-data text-[11px] text-slate-500">↵ Press Enter to authenticate</p>
                <p className="text-[10px] text-slate-600">Session encrypted · TLS secured</p>
              </div>
            </form>
          </section>

        </div>
      </div>
    </div>
  );
}

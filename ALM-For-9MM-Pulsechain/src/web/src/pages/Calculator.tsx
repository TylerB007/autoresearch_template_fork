import { useState, useEffect, useCallback } from 'react';
import {
  getCalculatorPairs,
  getPoolState,
  getCalculatorSplit,
  formatUsd,
  type CalculatorPair,
  type PoolState,
  type CalculatorResult,
} from '../api/client';
import RangeBar from '../components/RangeBar';

export default function Calculator() {
  const [pairs, setPairs] = useState<CalculatorPair[]>([]);
  const [selectedPairIdx, setSelectedPairIdx] = useState(0);

  // Pool state (auto-fetched when pair changes)
  const [pool, setPool] = useState<PoolState | null>(null);
  const [poolLoading, setPoolLoading] = useState(false);
  const [poolError, setPoolError] = useState('');

  // User inputs — prices (e.g. "150" for 150 WPLS/HEX)
  const [priceLower, setPriceLower] = useState('');
  const [priceUpper, setPriceUpper] = useState('');
  const [balance0, setBalance0] = useState('');
  const [balance1, setBalance1] = useState('');

  // Result
  const [result, setResult] = useState<CalculatorResult | null>(null);
  const [calcLoading, setCalcLoading] = useState(false);
  const [calcError, setCalcError] = useState('');

  // Fetch known pairs on mount
  useEffect(() => {
    getCalculatorPairs().then(setPairs).catch(() => {});
  }, []);

  // Auto-fetch pool state when pair changes
  const fetchPoolState = useCallback(async () => {
    if (pairs.length === 0) return;
    const pair = pairs[selectedPairIdx];
    if (!pair) return;

    setPoolLoading(true);
    setPoolError('');
    setPool(null);
    setResult(null);

    try {
      const state = await getPoolState(pair.token0, pair.token1, pair.fee);
      setPool(state);
      // Pre-fill wallet balances
      setBalance0(formatBalance(state.walletBalance0));
      setBalance1(formatBalance(state.walletBalance1));
    } catch (err) {
      setPoolError(err instanceof Error ? err.message : 'Failed to fetch pool state');
    } finally {
      setPoolLoading(false);
    }
  }, [pairs, selectedPairIdx]);

  useEffect(() => {
    fetchPoolState();
  }, [fetchPoolState]);

  const calculate = useCallback(async () => {
    if (!pool || pairs.length === 0) return;

    const pl = parseFloat(priceLower);
    const pu = parseFloat(priceUpper);
    if (isNaN(pl) || isNaN(pu) || pl <= 0 || pu <= 0) {
      setCalcError('Enter valid prices');
      return;
    }
    if (pl >= pu) {
      setCalcError('Lower price must be less than upper price');
      return;
    }

    const b0 = parseFloat(balance0) || 0;
    const b1 = parseFloat(balance1) || 0;
    if (b0 <= 0 && b1 <= 0) {
      setCalcError('Enter at least one token balance');
      return;
    }

    setCalcLoading(true);
    setCalcError('');
    setResult(null);

    const pair = pairs[selectedPairIdx];
    try {
      const data = await getCalculatorSplit({
        token0: pair.token0,
        token1: pair.token1,
        fee: pair.fee,
        priceLower: pl,
        priceUpper: pu,
        balance0: b0,
        balance1: b1,
      });
      setResult(data);
    } catch (err) {
      setCalcError(err instanceof Error ? err.message : 'Failed to calculate');
    } finally {
      setCalcLoading(false);
    }
  }, [pool, pairs, selectedPairIdx, priceLower, priceUpper, balance0, balance1]);

  const priceUnit = pool ? `${pool.token1.symbol}/${pool.token0.symbol}` : '';

  return (
    <div className="mx-auto max-w-5xl space-y-6 px-4 py-8">
      <section className="panel overflow-hidden">
        <div className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-cyan-400/50 to-transparent" />
        <h1 className="text-3xl font-bold tracking-tight text-white">LP Split Calculator</h1>
        <p className="mt-2 max-w-3xl text-sm leading-6 text-slate-300">
          Use live pool state to estimate the token split required for a target concentrated-liquidity range before minting.
        </p>
      </section>

      {/* Step 1: Select Pool */}
      <div className="panel">
        <h2 className="mb-3 text-sm font-medium text-slate-400">1. Select Pool</h2>
        <div className="flex items-center gap-3">
          <select
            value={selectedPairIdx}
            onChange={(e) => setSelectedPairIdx(Number(e.target.value))}
            className="input-base flex-1"
          >
            {pairs.map((p, i) => (
              <option key={i} value={i}>{p.label}</option>
            ))}
          </select>
          <button
            onClick={fetchPoolState}
            disabled={poolLoading}
            className="rounded-full border border-white/10 bg-white/5 px-4 py-2 text-sm text-white transition-colors hover:bg-white/10 disabled:text-slate-500"
          >
            {poolLoading ? 'Loading...' : 'Refresh'}
          </button>
        </div>

        {poolError && (
          <p className="mt-2 text-sm text-red-300">{poolError}</p>
        )}

        {/* Live Pool Info */}
        {pool && (
          <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-3">
            <div>
              <span className="block text-xs text-slate-500">Current Price</span>
              <span className="text-sm text-white font-medium">{pool.priceFormatted}</span>
            </div>
            <div>
              <span className="block text-xs text-slate-500">Fee</span>
              <span className="text-sm text-white">{pool.feeFormatted}</span>
            </div>
            <div>
              <span className="block text-xs text-slate-500">Tick Spacing</span>
              <span className="text-sm text-white font-mono">{pool.tickSpacing}</span>
            </div>
            {pool.token0.priceUsd > 0 && (
              <div>
                <span className="block text-xs text-slate-500">{pool.token0.symbol} Price</span>
                <span className="text-sm text-white">{formatUsd(pool.token0.priceUsd)}</span>
              </div>
            )}
            {pool.token1.priceUsd > 0 && (
              <div>
                <span className="block text-xs text-slate-500">{pool.token1.symbol} Price</span>
                <span className="text-sm text-white">{formatUsd(pool.token1.priceUsd)}</span>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Step 2: Enter Range (Prices) */}
      {pool && (
        <div className="panel">
          <h2 className="mb-3 text-sm font-medium text-slate-400">
            2. Enter Price Range
            <span className="ml-1 text-slate-600">({priceUnit})</span>
          </h2>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="mb-1 block text-xs text-slate-500">Lower Price</label>
              <input
                type="number"
                value={priceLower}
                onChange={(e) => setPriceLower(e.target.value)}
                placeholder={String(Math.floor(pool.price * 0.95))}
                min={0}
                step="any"
                className="input-base w-full"
              />
            </div>
            <div>
              <label className="mb-1 block text-xs text-slate-500">Upper Price</label>
              <input
                type="number"
                value={priceUpper}
                onChange={(e) => setPriceUpper(e.target.value)}
                placeholder={String(Math.ceil(pool.price * 1.05))}
                min={0}
                step="any"
                className="input-base w-full"
              />
            </div>
          </div>

          {/* Show snapped tick info after calculation */}
          {result && (
            <p className="mt-3 text-xs text-slate-500">
              Snapped to ticks: {result.range.tickLower} — {result.range.tickUpper} ({result.range.widthTicks} ticks)
              &nbsp;&middot;&nbsp;
              Actual prices: {result.range.priceLowerFormatted} — {result.range.priceUpperFormatted}
            </p>
          )}
        </div>
      )}

      {/* Step 3: Enter Balances */}
      {pool && (
        <div className="panel">
          <h2 className="mb-3 text-sm font-medium text-slate-400">3. Your Token Balances</h2>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="mb-1 block text-xs text-slate-500">{pool.token0.symbol}</label>
              <input
                type="number"
                value={balance0}
                onChange={(e) => setBalance0(e.target.value)}
                placeholder="0"
                min={0}
                step="any"
                className="input-base w-full"
              />
              {balance0 && parseFloat(balance0) > 0 && pool.token0.priceUsd > 0 && (
                <span className="mt-1 block text-xs text-slate-500">
                  {formatUsd(parseFloat(balance0) * pool.token0.priceUsd)}
                </span>
              )}
            </div>
            <div>
              <label className="mb-1 block text-xs text-slate-500">{pool.token1.symbol}</label>
              <input
                type="number"
                value={balance1}
                onChange={(e) => setBalance1(e.target.value)}
                placeholder="0"
                min={0}
                step="any"
                className="input-base w-full"
              />
              {balance1 && parseFloat(balance1) > 0 && pool.token1.priceUsd > 0 && (
                <span className="mt-1 block text-xs text-slate-500">
                  {formatUsd(parseFloat(balance1) * pool.token1.priceUsd)}
                </span>
              )}
            </div>
          </div>

          <button
            onClick={calculate}
            disabled={calcLoading || !priceLower || !priceUpper}
            className="mt-4 w-full rounded-full border border-cyan-400/30 bg-cyan-400 px-6 py-2.5 text-sm font-medium text-slate-950 transition-colors hover:bg-cyan-300 disabled:border-white/10 disabled:bg-white/5 disabled:text-slate-500"
          >
            {calcLoading ? 'Calculating...' : 'Calculate Split'}
          </button>

          {calcError && (
            <p className="mt-3 text-sm text-red-300">{calcError}</p>
          )}
        </div>
      )}

      {/* Results */}
      {result && (
        <div className="space-y-4">
          {/* Range */}
          <div className="panel">
            <h2 className="mb-3 text-sm font-medium text-slate-400">
              Position Range
              <span className="ml-1 text-slate-600">
                ({result.range.priceLowerFormatted} — {result.range.priceUpperFormatted} {priceUnit})
              </span>
            </h2>
            <RangeBar
              tickLower={result.range.tickLower}
              tickUpper={result.range.tickUpper}
              currentTick={result.pool.currentTick}
              token0Decimals={result.tokens.token0.decimals}
              token1Decimals={result.tokens.token1.decimals}
              token0Symbol={result.tokens.token0.symbol}
              token1Symbol={result.tokens.token1.symbol}
            />
            <p className="mt-2 text-xs text-slate-500">
              Ticks: {result.range.tickLower} — {result.range.tickUpper} ({result.range.widthTicks} ticks)
            </p>
          </div>

          {/* Split + Wallet */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            {/* Target Split */}
            <div className="panel">
              <h2 className="mb-3 text-sm font-medium text-slate-400">Target Split</h2>
              <div className="space-y-2">
                <SplitBar
                  label={result.targetSplit.token0Symbol}
                  pct={result.targetSplit.token0Pct}
                  color="blue"
                />
                <SplitBar
                  label={result.targetSplit.token1Symbol}
                  pct={result.targetSplit.token1Pct}
                  color="purple"
                />
              </div>
            </div>

            {/* Wallet Balances */}
            <div className="panel">
              <h2 className="mb-3 text-sm font-medium text-slate-400">Your Balances</h2>
              <div className="space-y-2">
                <div className="flex justify-between text-sm">
                  <span className="text-slate-300">{result.tokens.token0.symbol}</span>
                  <span className="text-white">
                    {result.wallet.balance0Formatted}
                    <span className="ml-1 text-slate-500">({formatUsd(result.wallet.value0Usd)})</span>
                  </span>
                </div>
                <div className="flex justify-between text-sm">
                  <span className="text-slate-300">{result.tokens.token1.symbol}</span>
                  <span className="text-white">
                    {result.wallet.balance1Formatted}
                    <span className="ml-1 text-slate-500">({formatUsd(result.wallet.value1Usd)})</span>
                  </span>
                </div>
                <div className="flex justify-between border-t border-white/10 pt-2 text-sm">
                  <span className="text-slate-400">Total</span>
                  <span className="text-white font-medium">{formatUsd(result.wallet.totalValueUsd)}</span>
                </div>
              </div>
            </div>
          </div>

          {/* Swap Recommendation */}
          {result.swap.amountInUsd > 0.01 && (
            <div className="rounded-[24px] border border-amber-400/20 bg-amber-500/10 p-4">
              <h2 className="text-sm font-medium text-yellow-400 mb-2">Swap Recommendation</h2>
              <p className="text-lg font-semibold text-white">
                {result.swap.direction}
              </p>
              <p className="mt-1 text-sm text-slate-300">
                {result.swap.amountInFormatted} {result.swap.tokenInSymbol}
                <span className="text-slate-500">
                  {' '}({formatUsd(result.swap.amountInUsd)} = {result.swap.swapPct.toFixed(1)}% of total)
                </span>
              </p>
              <p className="mt-2 text-xs text-slate-500">
                Pool swap fee: {result.swap.estimatedFeePct}%
              </p>
            </div>
          )}

          {result.swap.amountInUsd <= 0.01 && (
            <div className="rounded-[24px] border border-emerald-400/20 bg-emerald-500/10 p-4">
              <p className="text-sm text-green-400">
                Your balances are already well-balanced for this position. No swap needed.
              </p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** Format a balance number for display in the input field */
function formatBalance(value: number): string {
  if (value === 0) return '0';
  if (value >= 1) return value.toFixed(2);
  if (value >= 0.0001) return value.toFixed(6);
  return value.toExponential(4);
}

function SplitBar({ label, pct, color }: { label: string; pct: number; color: 'blue' | 'purple' }) {
  const bgClass = color === 'blue' ? 'bg-blue-500' : 'bg-purple-500';
  return (
    <div>
      <div className="flex justify-between text-sm mb-1">
        <span className="text-slate-300">{label}</span>
        <span className="text-white font-medium">{pct.toFixed(1)}%</span>
      </div>
      <div className="h-2 overflow-hidden rounded-full bg-white/10">
        <div
          className={`h-full ${bgClass} rounded-full transition-all`}
          style={{ width: `${Math.min(pct, 100)}%` }}
        />
      </div>
    </div>
  );
}

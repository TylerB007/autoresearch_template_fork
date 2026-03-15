import { useState } from 'react';
import {
  decreaseLiquidityApi,
  formatTokenAmount,
  formatUsd,
  tokenAmountToUsd,
  type Position,
  type DecreaseLiquidityResult,
} from '../api/client';

interface Props {
  position: Position;
  onClose: () => void;
  onSuccess: (result: DecreaseLiquidityResult) => void;
  txUrl: (hash: string) => string;
}

const PRESET_PERCENTAGES = [25, 50, 75];

export default function DecreaseLiquidityModal({ position, onClose, onSuccess, txUrl }: Props) {
  const [percentage, setPercentage] = useState<number>(25);
  const [customPct, setCustomPct] = useState('');
  const [isCustom, setIsCustom] = useState(false);
  const [executing, setExecuting] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState<DecreaseLiquidityResult | null>(null);

  const activePct = isCustom ? (parseFloat(customPct) || 0) : percentage;
  const isValidPct = activePct > 0 && activePct < 100;

  // Estimate amounts based on percentage
  const posValue = position.positionValueUsd ?? 0;
  const estimatedWithdrawUsd = posValue * (activePct / 100);

  // Rough token estimates from current amounts
  const estimateAmount = (rawAmount: string, _decimals: number, pct: number): string => {
    if (!rawAmount || pct <= 0) return '0';
    try {
      const raw = BigInt(rawAmount);
      const estimated = (raw * BigInt(Math.round(pct * 100))) / 10000n;
      return estimated.toString();
    } catch {
      return '0';
    }
  };

  const est0 = estimateAmount(position.amount0, position.token0Decimals, activePct);
  const est1 = estimateAmount(position.amount1, position.token1Decimals, activePct);

  const handleExecute = async () => {
    if (!isValidPct) return;
    setExecuting(true);
    setError('');
    try {
      const bps = Math.round(activePct * 100);
      const res = await decreaseLiquidityApi(position.token_id, bps);
      setResult(res);
      onSuccess(res);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Decrease failed');
    } finally {
      setExecuting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/80 backdrop-blur-md">
      <div className="mx-4 w-full max-w-xl rounded-[28px] border border-white/10 bg-[#08111f]/95 shadow-[0_32px_90px_rgba(2,8,23,0.78)]">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-white/10 p-5">
          <h3 className="text-lg font-semibold text-white">
            Decrease Liquidity — #{position.token_id}
          </h3>
          <button
            onClick={onClose}
            className="text-xl leading-none text-slate-500 transition-colors hover:text-white"
          >
            ✕
          </button>
        </div>

        {/* Body */}
        <div className="p-5 space-y-4">
          {/* Position info */}
          <div className="text-sm text-slate-400">
            {position.pair} • {position.strategy}
            {posValue > 0 ? ` • ${formatUsd(posValue)}` : ''}
          </div>

          {result ? (
            // Success state
            <div className="space-y-2 rounded-2xl border border-emerald-400/30 bg-emerald-500/10 p-4">
              <p className="font-medium text-emerald-100">
                Liquidity decreased by {(result.percentageBps / 100).toFixed(0)}%!
              </p>
              <div className="space-y-1 text-sm text-slate-200">
                <p>
                  Received: {formatTokenAmount(result.amount0, position.token0Decimals)} {position.token0Symbol} + {formatTokenAmount(result.amount1, position.token1Decimals)} {position.token1Symbol}
                </p>
                {position.priceUsd0 && position.priceUsd1 && (
                  <p className="text-slate-400">
                    Value: {formatUsd(
                      tokenAmountToUsd(result.amount0, position.token0Decimals, position.priceUsd0) +
                      tokenAmountToUsd(result.amount1, position.token1Decimals, position.priceUsd1)
                    )}
                  </p>
                )}
              </div>
              <a
                href={txUrl(result.decreaseTxHash)}
                target="_blank"
                rel="noopener noreferrer"
                className="text-sm text-cyan-300 transition-colors hover:text-cyan-200"
              >
                View Transaction ↗
              </a>
            </div>
          ) : (
            <>
              {/* Current position amounts */}
              <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-3 text-sm">
                <p className="mb-2 text-xs uppercase tracking-[0.22em] text-slate-500">Current Position</p>
                <div className="grid grid-cols-2 gap-2 text-slate-200">
                  <div>
                    {formatTokenAmount(position.amount0, position.token0Decimals)} {position.token0Symbol}
                    {position.priceUsd0 ? (
                        <span className="ml-1 text-slate-500">
                        ({formatUsd(tokenAmountToUsd(position.amount0, position.token0Decimals, position.priceUsd0))})
                      </span>
                    ) : null}
                  </div>
                  <div>
                    {formatTokenAmount(position.amount1, position.token1Decimals)} {position.token1Symbol}
                    {position.priceUsd1 ? (
                        <span className="ml-1 text-slate-500">
                        ({formatUsd(tokenAmountToUsd(position.amount1, position.token1Decimals, position.priceUsd1))})
                      </span>
                    ) : null}
                  </div>
                </div>
              </div>

              {/* Percentage selection */}
              <div>
                <label className="mb-2 block text-sm font-medium text-slate-400">
                  Removal Percentage
                </label>
                <div className="flex gap-2 mb-3">
                  {PRESET_PERCENTAGES.map((pct) => (
                    <button
                      key={pct}
                      onClick={() => { setPercentage(pct); setIsCustom(false); }}
                      className={`flex-1 rounded-full py-2 text-sm font-medium transition-colors ${
                        !isCustom && percentage === pct
                          ? 'border border-cyan-400/30 bg-cyan-400 text-slate-950'
                          : 'border border-white/10 bg-white/5 text-slate-300 hover:bg-white/10'
                      }`}
                    >
                      {pct}%
                    </button>
                  ))}
                  <button
                    onClick={() => setIsCustom(true)}
                    className={`flex-1 rounded-full py-2 text-sm font-medium transition-colors ${
                      isCustom
                        ? 'border border-cyan-400/30 bg-cyan-400 text-slate-950'
                        : 'border border-white/10 bg-white/5 text-slate-300 hover:bg-white/10'
                    }`}
                  >
                    Custom
                  </button>
                </div>
                {isCustom && (
                    <div className="flex items-center gap-2">
                    <input
                      type="number"
                      value={customPct}
                      onChange={(e) => setCustomPct(e.target.value)}
                      placeholder="e.g. 35"
                      min="1"
                      max="99"
                        className="input-base flex-1"
                    />
                    <span className="text-sm text-slate-400">%</span>
                  </div>
                )}
              </div>

              {/* Preview */}
              {isValidPct && (
                <div className="space-y-1 rounded-2xl border border-white/10 bg-white/[0.03] p-3 text-sm">
                  <p className="mb-2 text-xs uppercase tracking-[0.22em] text-slate-500">
                    Estimated Withdrawal ({activePct}%)
                  </p>
                  <p className="text-slate-200">
                    ~{formatTokenAmount(est0, position.token0Decimals)} {position.token0Symbol}
                    {position.priceUsd0 ? ` (${formatUsd(tokenAmountToUsd(est0, position.token0Decimals, position.priceUsd0))})` : ''}
                  </p>
                  <p className="text-slate-200">
                    ~{formatTokenAmount(est1, position.token1Decimals)} {position.token1Symbol}
                    {position.priceUsd1 ? ` (${formatUsd(tokenAmountToUsd(est1, position.token1Decimals, position.priceUsd1))})` : ''}
                  </p>
                  {estimatedWithdrawUsd > 0 && (
                    <p className="mt-1 text-slate-400">
                      Total: ~{formatUsd(estimatedWithdrawUsd)}
                    </p>
                  )}
                  <p className="mt-2 text-xs text-slate-500">
                    Position NFT is not burned — remaining liquidity stays active.
                  </p>
                </div>
              )}

              {activePct >= 100 && (
                <div className="rounded-2xl border border-amber-400/30 bg-amber-500/10 p-3 text-sm text-amber-100">
                  For 100% removal + NFT burn, use the Remove Liquidity action instead.
                </div>
              )}
            </>
          )}

          {error && (
            <div className="rounded-2xl border border-red-400/30 bg-red-500/10 p-3 text-sm text-red-200">
              {error}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex gap-3 p-5 pt-0">
          {!result && !executing && (
            <>
              <button
                onClick={onClose}
                className="flex-1 rounded-full border border-white/10 bg-white/5 px-4 py-2 text-sm font-medium text-slate-200 transition-colors hover:bg-white/10"
              >
                Cancel
              </button>
              <button
                onClick={handleExecute}
                disabled={!isValidPct}
                className={`flex-1 rounded-full px-4 py-2 text-sm font-medium transition-colors ${
                  isValidPct
                    ? 'border border-amber-400/30 bg-amber-400 text-slate-950 hover:bg-amber-300'
                    : 'cursor-not-allowed border border-white/10 bg-white/5 text-slate-500'
                }`}
              >
                Decrease {isValidPct ? `${activePct}%` : ''}
              </button>
            </>
          )}
          {executing && (
            <div className="flex-1 py-2 text-center text-sm text-slate-400">
              Executing transaction...
            </div>
          )}
          {result && (
            <button
              onClick={onClose}
              className="flex-1 rounded-full border border-white/10 bg-white/5 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-white/10"
            >
              Close
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

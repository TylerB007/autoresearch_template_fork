import { useState, useEffect } from 'react';
import {
  getDashboard,
  getIncreasePreview,
  increaseLiquidityApi,
  formatTokenAmount,
  formatUsd,
  type Position,
  type IncreasePreview,
  type IncreaseLiquidityResult,
  type WalletToken,
} from '../api/client';

interface Props {
  position: Position;
  onClose: () => void;
  onSuccess: (result: IncreaseLiquidityResult) => void;
  txUrl: (hash: string) => string;
}

export default function IncreaseLiquidityModal({ position, onClose, onSuccess, txUrl }: Props) {
  const [walletTokens, setWalletTokens] = useState<WalletToken[]>([]);
  const [loading, setLoading] = useState(true);
  const [amount0, setAmount0] = useState('');
  const [amount1, setAmount1] = useState('');
  const [swapIfNeeded, setSwapIfNeeded] = useState(true);
  const [preview, setPreview] = useState<IncreasePreview | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [executing, setExecuting] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState<IncreaseLiquidityResult | null>(null);

  // Fetch wallet balances
  useEffect(() => {
    getDashboard()
      .then((data) => {
        setWalletTokens(data.walletTokens ?? []);
      })
      .catch(() => setError('Failed to load wallet balances'))
      .finally(() => setLoading(false));
  }, []);

  const token0Wallet = walletTokens.find(
    (t) => t.symbol === position.token0Symbol
  );
  const token1Wallet = walletTokens.find(
    (t) => t.symbol === position.token1Symbol
  );

  const toRaw = (humanAmount: string, decimals: number): string => {
    if (!humanAmount || isNaN(Number(humanAmount))) return '0';
    const parts = humanAmount.split('.');
    const integer = parts[0] || '0';
    const fraction = (parts[1] || '').padEnd(decimals, '0').slice(0, decimals);
    return (BigInt(integer) * BigInt(10 ** decimals) + BigInt(fraction)).toString();
  };

  const handleMax0 = () => {
    if (token0Wallet) {
      const human = (Number(token0Wallet.balance) / 10 ** token0Wallet.decimals).toString();
      setAmount0(human);
    }
  };

  const handleMax1 = () => {
    if (token1Wallet) {
      const human = (Number(token1Wallet.balance) / 10 ** token1Wallet.decimals).toString();
      setAmount1(human);
    }
  };

  const handlePreview = async () => {
    setPreviewLoading(true);
    setError('');
    try {
      const raw0 = toRaw(amount0, position.token0Decimals);
      const raw1 = toRaw(amount1, position.token1Decimals);
      if (raw0 === '0' && raw1 === '0') {
        setError('Enter at least one token amount');
        return;
      }
      const p = await getIncreasePreview(position.token_id, raw0, raw1);
      setPreview(p);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Preview failed');
    } finally {
      setPreviewLoading(false);
    }
  };

  const handleExecute = async () => {
    setExecuting(true);
    setError('');
    try {
      const raw0 = toRaw(amount0, position.token0Decimals);
      const raw1 = toRaw(amount1, position.token1Decimals);
      const res = await increaseLiquidityApi(position.token_id, raw0, raw1, swapIfNeeded);
      setResult(res);
      onSuccess(res);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Increase failed');
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
            Increase Liquidity — #{position.token_id}
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
            {position.positionValueUsd ? ` • ${formatUsd(position.positionValueUsd)}` : ''}
          </div>

          {loading ? (
            <div className="py-4 text-center text-slate-400">Loading wallet balances...</div>
          ) : result ? (
            // Success state
            <div className="space-y-2 rounded-2xl border border-emerald-400/30 bg-emerald-500/10 p-4">
              <p className="font-medium text-emerald-100">Liquidity increased successfully!</p>
              <div className="space-y-1 text-sm text-slate-200">
                <p>Added: {formatTokenAmount(result.amount0, position.token0Decimals)} {position.token0Symbol} + {formatTokenAmount(result.amount1, position.token1Decimals)} {position.token1Symbol}</p>
                {result.swap && (
                  <p className="text-slate-400">
                    Swapped: {formatTokenAmount(result.swap.amountIn, position.token0Decimals)} → {formatTokenAmount(result.swap.amountOut, position.token1Decimals)}
                  </p>
                )}
              </div>
              <a
                href={txUrl(result.txHash)}
                target="_blank"
                rel="noopener noreferrer"
                className="text-sm text-cyan-300 transition-colors hover:text-cyan-200"
              >
                View Transaction ↗
              </a>
            </div>
          ) : (
            <>
              {/* Wallet balances */}
              <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-3 text-sm">
                <p className="mb-2 text-xs uppercase tracking-[0.22em] text-slate-500">Wallet Balances</p>
                <div className="grid grid-cols-2 gap-2 text-slate-200">
                  <div>
                    {token0Wallet
                      ? `${token0Wallet.balanceFormatted.toLocaleString()} ${position.token0Symbol}`
                      : `0 ${position.token0Symbol}`}
                    {token0Wallet && token0Wallet.valueUsd > 0 && (
                      <span className="ml-1 text-slate-500">({formatUsd(token0Wallet.valueUsd)})</span>
                    )}
                  </div>
                  <div>
                    {token1Wallet
                      ? `${token1Wallet.balanceFormatted.toLocaleString()} ${position.token1Symbol}`
                      : `0 ${position.token1Symbol}`}
                    {token1Wallet && token1Wallet.valueUsd > 0 && (
                      <span className="ml-1 text-slate-500">({formatUsd(token1Wallet.valueUsd)})</span>
                    )}
                  </div>
                </div>
              </div>

              {/* Amount inputs */}
              <div className="space-y-3">
                <div>
                  <label className="mb-1 block text-sm font-medium text-slate-400">
                    {position.token0Symbol} Amount
                  </label>
                  <div className="flex gap-2">
                    <input
                      type="text"
                      value={amount0}
                      onChange={(e) => setAmount0(e.target.value)}
                      placeholder="0.0"
                      className="input-base flex-1"
                    />
                    <button
                      onClick={handleMax0}
                      className="rounded-full border border-white/10 bg-white/5 px-3 py-2 text-xs font-medium text-slate-200 transition-colors hover:bg-white/10"
                    >
                      MAX
                    </button>
                  </div>
                </div>
                <div>
                  <label className="mb-1 block text-sm font-medium text-slate-400">
                    {position.token1Symbol} Amount
                  </label>
                  <div className="flex gap-2">
                    <input
                      type="text"
                      value={amount1}
                      onChange={(e) => setAmount1(e.target.value)}
                      placeholder="0.0"
                      className="input-base flex-1"
                    />
                    <button
                      onClick={handleMax1}
                      className="rounded-full border border-white/10 bg-white/5 px-3 py-2 text-xs font-medium text-slate-200 transition-colors hover:bg-white/10"
                    >
                      MAX
                    </button>
                  </div>
                </div>
              </div>

              {/* Auto-swap toggle */}
              <label className="flex cursor-pointer items-center gap-2 text-sm text-slate-400">
                <input
                  type="checkbox"
                  checked={swapIfNeeded}
                  onChange={(e) => setSwapIfNeeded(e.target.checked)}
                  className="rounded border-white/20 bg-white/5 text-cyan-400 focus:ring-cyan-400"
                />
                Auto-swap to optimal ratio
              </label>

              {/* Preview */}
              {preview && (
                <div className="space-y-1 rounded-2xl border border-white/10 bg-white/[0.03] p-3 text-sm">
                  <p className="mb-2 text-xs uppercase tracking-[0.22em] text-slate-500">Preview</p>
                  {preview.swap && (
                    <p className="text-amber-200">
                      Swap: ~{formatTokenAmount(preview.swap.amountIn, preview.swap.tokenIn === 'token0' ? preview.token0Decimals : preview.token1Decimals)} {preview.swap.tokenInSymbol} → {preview.swap.tokenOutSymbol}
                    </p>
                  )}
                  <p className="text-slate-200">
                    Est. gas: {(Number(preview.estimatedGasCostWei) / 1e18).toFixed(6)} {position.chainId === 369 ? 'PLS' : position.chainId === 146 ? 'S' : 'ETH'}
                  </p>
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
                onClick={handlePreview}
                disabled={previewLoading || (!amount0 && !amount1)}
                className={`flex-1 rounded-full px-4 py-2 text-sm font-medium transition-colors ${
                  previewLoading || (!amount0 && !amount1)
                    ? 'cursor-not-allowed border border-white/10 bg-white/5 text-slate-500'
                    : 'border border-white/10 bg-white/5 text-white hover:bg-white/10'
                }`}
              >
                {previewLoading ? 'Loading...' : 'Preview'}
              </button>
              <button
                onClick={handleExecute}
                disabled={!amount0 && !amount1}
                className={`flex-1 rounded-full px-4 py-2 text-sm font-medium transition-colors ${
                  !amount0 && !amount1
                    ? 'cursor-not-allowed border border-white/10 bg-white/5 text-slate-500'
                    : 'border border-emerald-400/30 bg-emerald-400 text-slate-950 hover:bg-emerald-300'
                }`}
              >
                Increase Liquidity
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

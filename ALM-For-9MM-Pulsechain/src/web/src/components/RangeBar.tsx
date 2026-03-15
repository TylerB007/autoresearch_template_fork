import { tickToPrice, formatPrice } from '../api/client';

interface RangeBarProps {
  tickLower: number;
  tickUpper: number;
  currentTick: number;
  token0Decimals?: number;
  token1Decimals?: number;
  token0Symbol?: string;
  token1Symbol?: string;
  /** When true, display 1/price (token0 per token1) and swap label direction */
  invert?: boolean;
}

export default function RangeBar({
  tickLower,
  tickUpper,
  currentTick,
  token0Decimals,
  token1Decimals,
  token0Symbol,
  token1Symbol,
  invert = false,
}: RangeBarProps) {
  const range = tickUpper - tickLower;
  const padding = range * 0.2;
  const viewMin = tickLower - padding;
  const viewMax = tickUpper + padding;
  const viewRange = viewMax - viewMin;

  const rangeLeft = ((tickLower - viewMin) / viewRange) * 100;
  const rangeWidth = ((tickUpper - tickLower) / viewRange) * 100;
  const tickPos = Math.max(0, Math.min(100, ((currentTick - viewMin) / viewRange) * 100));

  const inRange = currentTick >= tickLower && currentTick <= tickUpper;

  const hasDecimals = token0Decimals !== undefined && token1Decimals !== undefined;

  // Raw prices (token1 per token0)
  const rawPriceLower = hasDecimals ? tickToPrice(tickLower, token0Decimals!, token1Decimals!) : null;
  const rawPriceUpper = hasDecimals ? tickToPrice(tickUpper, token0Decimals!, token1Decimals!) : null;
  const rawPriceCurrent = hasDecimals ? tickToPrice(currentTick, token0Decimals!, token1Decimals!) : null;

  // Displayed prices — when inverted, flip: lower↔upper, take reciprocal
  const priceLower = rawPriceLower !== null
    ? (invert ? (rawPriceUpper !== null ? 1 / rawPriceUpper : null) : rawPriceLower)
    : null;
  const priceUpper = rawPriceUpper !== null
    ? (invert ? (rawPriceLower !== null ? 1 / rawPriceLower : null) : rawPriceUpper)
    : null;
  const priceCurrent = rawPriceCurrent !== null
    ? (invert ? 1 / rawPriceCurrent : rawPriceCurrent)
    : null;

  // Label: normally "TOKEN1/TOKEN0", inverted "TOKEN0/TOKEN1"
  const priceLabel = token1Symbol && token0Symbol
    ? (invert ? `${token0Symbol}/${token1Symbol}` : `${token1Symbol}/${token0Symbol}`)
    : '';

  return (
    <div className="w-full">
      <div className="relative h-8 overflow-hidden rounded-2xl border border-white/10 bg-[rgba(255,255,255,0.04)]">
        {/* Active range */}
        <div
          className="absolute top-0 h-full rounded-xl border-x border-sky-300/30 bg-gradient-to-r from-sky-500/15 via-sky-300/20 to-sky-500/15"
          style={{ left: `${rangeLeft}%`, width: `${rangeWidth}%` }}
        />
        {/* Current tick marker */}
        <div
          className={`absolute top-0 h-full w-0.5 ${inRange ? 'bg-emerald-300' : 'bg-rose-300'}`}
          style={{ left: `${tickPos}%` }}
        />
        {/* Tick indicator dot */}
        <div
          className={`absolute top-1/2 -translate-y-1/2 -translate-x-1/2 h-3.5 w-3.5 rounded-full border-2 shadow-lg ${
            inRange
              ? 'border-emerald-100 bg-emerald-300'
              : 'border-rose-100 bg-rose-300'
          }`}
          style={{ left: `${tickPos}%` }}
        />
      </div>

      {/* Price labels — prices as primary, ticks as muted secondary */}
      <div className="mt-2 grid grid-cols-3 gap-2 text-[11px] text-data">
        {/* Lower bound */}
        <div className="flex flex-col gap-0.5">
          {priceLower !== null ? (
            <span className="text-slate-300">{formatPrice(priceLower)}</span>
          ) : null}
          <span className="text-[10px] text-slate-600">{tickLower}</span>
        </div>

        {/* Current tick — center */}
        <div className={`flex flex-col items-center gap-0.5 ${inRange ? 'text-emerald-300' : 'text-rose-300'}`}>
          {priceCurrent !== null ? (
            <span>
              {formatPrice(priceCurrent)}
              {priceLabel && (
                <span className={`ml-1 text-[10px] ${inRange ? 'text-emerald-400/70' : 'text-rose-400/70'}`}>
                  {priceLabel}
                </span>
              )}
            </span>
          ) : null}
          <span className="text-[10px] text-slate-600">{currentTick}</span>
        </div>

        {/* Upper bound */}
        <div className="flex flex-col items-end gap-0.5">
          {priceUpper !== null ? (
            <span className="text-slate-300">{formatPrice(priceUpper)}</span>
          ) : null}
          <span className="text-[10px] text-slate-600">{tickUpper}</span>
        </div>
      </div>
    </div>
  );
}

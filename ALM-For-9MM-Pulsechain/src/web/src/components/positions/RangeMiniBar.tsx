import { tickToPrice, formatPrice } from '../../api/client.js';
import Tooltip from '../Tooltip.js';

interface RangeMiniBarProps {
  tickLower: number;
  tickUpper: number;
  currentTick: number;
  token0Decimals?: number;
  token1Decimals?: number;
  token0Symbol?: string;
  token1Symbol?: string;
  /** When true, display 1/price (token0 per token1) in the tooltip */
  invert?: boolean;
}

export default function RangeMiniBar({
  tickLower,
  tickUpper,
  currentTick,
  token0Decimals,
  token1Decimals,
  token0Symbol,
  token1Symbol,
  invert = false,
}: RangeMiniBarProps) {
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
  const rawPriceLower = hasDecimals ? tickToPrice(tickLower, token0Decimals!, token1Decimals!) : null;
  const rawPriceUpper = hasDecimals ? tickToPrice(tickUpper, token0Decimals!, token1Decimals!) : null;
  const rawPriceCurrent = hasDecimals ? tickToPrice(currentTick, token0Decimals!, token1Decimals!) : null;

  // When inverted, lower↔upper swap and take reciprocal
  const priceLower = rawPriceLower !== null
    ? (invert ? (rawPriceUpper !== null ? 1 / rawPriceUpper : null) : rawPriceLower)
    : null;
  const priceUpper = rawPriceUpper !== null
    ? (invert ? (rawPriceLower !== null ? 1 / rawPriceLower : null) : rawPriceUpper)
    : null;
  const priceCurrent = rawPriceCurrent !== null
    ? (invert ? 1 / rawPriceCurrent : rawPriceCurrent)
    : null;

  // Label: invert swaps token order (symbols already swapped by caller, so label is always token1/token0)
  const priceLabel = token1Symbol && token0Symbol ? `${token1Symbol}/${token0Symbol}` : '';

  const tooltipContent = (
    <div className="space-y-1.5 text-[11px] text-data">
      <div className="flex justify-between gap-6 text-slate-400">
        <span>MIN price</span>
        <span>{priceLower !== null ? formatPrice(priceLower) : tickLower}</span>
      </div>
      <div className="flex justify-between gap-6 text-slate-400">
        <span>MAX price</span>
        <span>{priceUpper !== null ? formatPrice(priceUpper) : tickUpper}</span>
      </div>
      <div className={`flex justify-between gap-6 font-medium ${inRange ? 'text-emerald-300' : 'text-rose-300'}`}>
        <span>Current price{priceLabel ? ` (${priceLabel})` : ''}</span>
        <span>{priceCurrent !== null ? formatPrice(priceCurrent) : currentTick}</span>
      </div>
    </div>
  );

  return (
    <Tooltip content={tooltipContent}>
      {/* Track */}
      <div className="relative h-2 w-36 rounded-sm bg-white/[0.08]">
        {/* Active range — bright green fill */}
        <div
          className={`absolute top-0 h-full rounded-sm ${inRange ? 'bg-emerald-400' : 'bg-rose-500/70'}`}
          style={{ left: `${rangeLeft}%`, width: `${rangeWidth}%` }}
        />
        {/* Current price tick — white notch */}
        <div
          className="absolute top-1/2 -translate-y-1/2 -translate-x-1/2 h-4 w-0.5 rounded-full bg-white shadow-[0_0_4px_rgba(255,255,255,0.6)]"
          style={{ left: `${tickPos}%` }}
        />
      </div>
    </Tooltip>
  );
}

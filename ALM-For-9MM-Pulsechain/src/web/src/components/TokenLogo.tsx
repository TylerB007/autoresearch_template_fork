import { useState } from 'react';
import { getTokenLogoUrl } from '../config/tokenLogos';

// Deterministic muted color derived from symbol string for fallback initials circle.
function symbolColor(symbol: string): string {
  let hash = 0;
  for (let i = 0; i < symbol.length; i++) {
    hash = (hash * 31 + symbol.charCodeAt(i)) & 0xffffffff;
  }
  const hue = Math.abs(hash) % 360;
  return `hsl(${hue}, 45%, 25%)`;
}

const SIZE_CLASSES: Record<string, string> = {
  xs: 'h-4 w-4 text-[8px]',
  sm: 'h-5 w-5 text-[8px]',
  md: 'h-7 w-7 text-[9px]',
  lg: 'h-9 w-9 text-[11px]',
};

interface TokenLogoProps {
  symbol: string;
  chainId?: number;
  size?: 'xs' | 'sm' | 'md' | 'lg';
  className?: string;
}

export default function TokenLogo({ symbol, chainId, size = 'md', className = '' }: TokenLogoProps) {
  const [failed, setFailed] = useState(false);
  const safeSymbol = symbol ?? '';
  const url = getTokenLogoUrl(chainId, safeSymbol);
  const sizeClass = SIZE_CLASSES[size] ?? SIZE_CLASSES.md;
  const initials = safeSymbol.slice(0, 2).toUpperCase() || '?';

  if (url && !failed) {
    return (
      <img
        src={url}
        alt=""
        loading="lazy"
        referrerPolicy="no-referrer"
        onError={() => setFailed(true)}
        className={`inline-block flex-shrink-0 rounded-full object-cover ${sizeClass} ${className}`}
      />
    );
  }

  return (
    <div
      className={`inline-flex flex-shrink-0 items-center justify-center rounded-full font-bold text-white/90 ${sizeClass} ${className}`}
      style={{ backgroundColor: symbolColor(safeSymbol) }}
      aria-label={safeSymbol || 'token'}
    >
      {initials}
    </div>
  );
}

import TokenLogo from './TokenLogo';

// Standard DeFi LP pair overlap layout: token0 left, token1 overlapping slightly right.
// A ring matching the page background creates crisp separation between the two circles.

interface TokenPairLogosProps {
  symbol0: string;
  symbol1: string;
  chainId?: number;
  size?: 'sm' | 'md' | 'lg';
  className?: string;
}

type SizeConfig = {
  container: string;
  iconSize: 'xs' | 'sm' | 'md';
  offset: string;
};

const SIZE_CONFIG: Record<string, SizeConfig> = {
  sm: { container: 'h-5 w-8',  iconSize: 'xs', offset: 'left-3' },
  md: { container: 'h-7 w-11', iconSize: 'sm', offset: 'left-4' },
  lg: { container: 'h-9 w-14', iconSize: 'md', offset: 'left-5' },
};

export default function TokenPairLogos({ symbol0, symbol1, chainId, size = 'md', className = '' }: TokenPairLogosProps) {
  const { container, iconSize, offset } = SIZE_CONFIG[size] ?? SIZE_CONFIG.md;

  return (
    <div className={`relative flex-shrink-0 ${container} ${className}`}>
      {/* token0 — sits on top (z-10) */}
      <TokenLogo
        symbol={symbol0}
        chainId={chainId}
        size={iconSize}
        className="absolute left-0 top-0 z-10"
      />
      {/* token1 — offset right, ring matches dark page background for separation */}
      <TokenLogo
        symbol={symbol1}
        chainId={chainId}
        size={iconSize}
        className={`absolute top-0 z-0 ring-2 ring-[#07111a] ${offset}`}
      />
    </div>
  );
}

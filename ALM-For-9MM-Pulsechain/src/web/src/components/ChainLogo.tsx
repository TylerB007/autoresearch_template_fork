import { useState } from 'react';

const CHAIN_LOGO_URLS: Record<string, string> = {
  Ethereum: 'https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/ethereum/info/logo.png',
  Base: 'https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/base/info/logo.png',
  'Arbitrum One': 'https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/arbitrum/info/logo.png',
  PulseChain: 'https://assets.coingecko.com/coins/images/26927/standard/pls.png',
  Sonic: 'https://assets.coingecko.com/coins/images/38477/standard/sonic.jpg',
};

export const CHAIN_BADGE_COLORS: Record<string, string> = {
  PulseChain: 'bg-purple-900/60 border-purple-700 text-purple-300',
  Ethereum: 'bg-blue-900/60 border-blue-700 text-blue-300',
  Base: 'bg-sky-900/60 border-sky-700 text-cyan-300',
  'Arbitrum One': 'bg-indigo-900/60 border-indigo-700 text-indigo-300',
  Sonic: 'bg-amber-900/60 border-amber-700 text-amber-300',
};

export const CHAIN_BADGE_LABELS: Record<string, string> = {
  PulseChain: 'PLS',
  Ethereum: 'ETH',
  Base: 'BASE',
  'Arbitrum One': 'ARB',
  Sonic: 'S',
};

const DEFAULT_COLORS = 'bg-slate-800/70 border-slate-600/40 text-slate-300';

interface ChainLogoProps {
  chainName: string;
  size?: 'sm' | 'md';
}

export default function ChainLogo({ chainName, size = 'sm' }: ChainLogoProps) {
  const [imgFailed, setImgFailed] = useState(false);
  const url = CHAIN_LOGO_URLS[chainName];
  const colors = CHAIN_BADGE_COLORS[chainName] ?? DEFAULT_COLORS;
  const label = CHAIN_BADGE_LABELS[chainName] ?? '?';
  const px = size === 'md' ? 'px-2 py-1' : 'px-1.5 py-0.5';

  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full border ${colors} ${px} text-[10px] font-semibold leading-none`}
    >
      {url && !imgFailed ? (
        <img
          src={url}
          alt={label}
          className="h-3.5 w-3.5 rounded-full object-cover"
          onError={() => setImgFailed(true)}
        />
      ) : null}
      {!url || imgFailed ? label : null}
    </span>
  );
}

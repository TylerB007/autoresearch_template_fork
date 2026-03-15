import React, { createContext, useContext, useState, useEffect } from 'react';
import { getChainInfo, type ChainInfo } from '../api/client';

/** Default chain info (PulseChain fallback before API loads) */
const DEFAULT_CHAIN: ChainInfo = {
  chainId: 369,
  chainName: 'PulseChain',
  protocolName: '9mm V3',
  blockExplorerUrl: 'https://scan.pulsechain.com',
  nativeCurrencySymbol: 'PLS',
};

interface ChainContextType {
  chain: ChainInfo;
  loading: boolean;
  /** Build a tx explorer URL for the current chain */
  txUrl: (txHash: string) => string;
}

const ChainContext = createContext<ChainContextType>({
  chain: DEFAULT_CHAIN,
  loading: true,
  txUrl: (hash) => `${DEFAULT_CHAIN.blockExplorerUrl}/tx/${hash}`,
});

export function ChainProvider({ children }: { children: React.ReactNode }) {
  const [chain, setChain] = useState<ChainInfo>(DEFAULT_CHAIN);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    getChainInfo()
      .then((info) => {
        setChain(info);
        setLoading(false);
      })
      .catch(() => {
        // Use defaults if API not yet available (e.g. not logged in)
        setLoading(false);
      });
  }, []);

  const txUrl = (txHash: string) => `${chain.blockExplorerUrl}/tx/${txHash}`;

  return (
    <ChainContext.Provider value={{ chain, loading, txUrl }}>
      {children}
    </ChainContext.Provider>
  );
}

export function useChain(): ChainContextType {
  return useContext(ChainContext);
}

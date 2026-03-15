import type { KoinlyRow } from './koinly.js';

export interface AuditScopeOptions {
  pulsechainOnly?: boolean;
  chainId?: number;
  walletSubstring?: string;
}

export function includesPulsechainWalletLabel(wallet: string): boolean {
  const normalized = wallet.trim().toLowerCase();
  return normalized.includes('pulsechain') || normalized.includes('(pls)') || normalized.endsWith(' pls');
}

export function filterKoinlyRowsByWalletSubstring(rows: KoinlyRow[], walletSubstring: string): KoinlyRow[] {
  const needle = walletSubstring.trim().toLowerCase();
  if (!needle) return rows;
  return rows.filter((row) => row.wallet.toLowerCase().includes(needle));
}

export function filterKoinlyRowsForPulsechain(rows: KoinlyRow[]): KoinlyRow[] {
  return rows.filter((row) => includesPulsechainWalletLabel(row.wallet));
}

export function filterChainRecords<T extends { chainId?: number }>(records: T[], chainId: number): T[] {
  return records.filter((record) => record.chainId === chainId || record.chainId === undefined);
}

export function resolveAuditScope(options: AuditScopeOptions): {
  effectiveChainId?: number;
  effectiveWalletSubstring?: string;
  scopeLabel: string;
} {
  const effectiveChainId = options.chainId ?? (options.pulsechainOnly ? 369 : undefined);
  const effectiveWalletSubstring = options.walletSubstring?.trim() || undefined;

  if (options.pulsechainOnly && effectiveWalletSubstring) {
    return {
      effectiveChainId,
      effectiveWalletSubstring,
      scopeLabel: `PulseChain only (chainId 369, wallet~"${effectiveWalletSubstring}")`,
    };
  }

  if (options.pulsechainOnly) {
    return {
      effectiveChainId: 369,
      effectiveWalletSubstring: undefined,
      scopeLabel: 'PulseChain only (chainId 369)',
    };
  }

  if (effectiveChainId !== undefined && effectiveWalletSubstring) {
    return {
      effectiveChainId,
      effectiveWalletSubstring,
      scopeLabel: `chainId ${effectiveChainId} + wallet~"${effectiveWalletSubstring}"`,
    };
  }

  if (effectiveChainId !== undefined) {
    return {
      effectiveChainId,
      effectiveWalletSubstring: undefined,
      scopeLabel: `chainId ${effectiveChainId}`,
    };
  }

  if (effectiveWalletSubstring) {
    return {
      effectiveChainId: undefined,
      effectiveWalletSubstring,
      scopeLabel: `wallet~"${effectiveWalletSubstring}"`,
    };
  }

  return {
    effectiveChainId: undefined,
    effectiveWalletSubstring: undefined,
    scopeLabel: 'All chains',
  };
}
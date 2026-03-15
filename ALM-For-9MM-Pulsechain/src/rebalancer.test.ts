/**
 * Unit tests for pure/exported logic in src/rebalancer.ts.
 * Tests isTransientRpcError classification and the posKey helper.
 * Does NOT test on-chain flows (those require mocking ethers).
 */
import { describe, it, expect } from 'vitest';
import { isTransientRpcError, posKey } from './rebalancer.js';

// ── posKey ──────────────────────────────────────────────────────────────────

describe('posKey', () => {
  it('returns a composite string', () => {
    expect(posKey(369, 155977)).toBe('369-155977');
  });

  it('different chains produce different keys for same tokenId', () => {
    expect(posKey(369, 100)).not.toBe(posKey(1, 100));
  });

  it('different tokenIds produce different keys on same chain', () => {
    expect(posKey(369, 100)).not.toBe(posKey(369, 200));
  });
});

// ── isTransientRpcError ──────────────────────────────────────────────────────

function makeError(message: string, code?: string): Error {
  const e = new Error(message);
  if (code) (e as { code?: string }).code = code;
  return e;
}

describe('isTransientRpcError', () => {
  // Non-Error values
  it('returns false for non-Error values', () => {
    expect(isTransientRpcError('string error')).toBe(false);
    expect(isTransientRpcError(null)).toBe(false);
    expect(isTransientRpcError(undefined)).toBe(false);
    expect(isTransientRpcError(42)).toBe(false);
    expect(isTransientRpcError({ message: 'timeout' })).toBe(false);
  });

  // Contract revert — NOT transient
  it('CALL_EXCEPTION is NOT transient (contract revert)', () => {
    expect(isTransientRpcError(makeError('execution reverted', 'CALL_EXCEPTION'))).toBe(false);
  });

  // ethers v6 error codes — transient
  it('SERVER_ERROR is transient', () => {
    expect(isTransientRpcError(makeError('502 Bad Gateway', 'SERVER_ERROR'))).toBe(true);
  });

  it('NETWORK_ERROR is transient', () => {
    expect(isTransientRpcError(makeError('network request failed', 'NETWORK_ERROR'))).toBe(true);
  });

  it('TIMEOUT is transient', () => {
    expect(isTransientRpcError(makeError('request timeout', 'TIMEOUT'))).toBe(true);
  });

  // Message-based patterns — transient
  it('gateway time-out message is transient', () => {
    expect(isTransientRpcError(makeError('504 gateway time-out'))).toBe(true);
  });

  it('econnreset is transient', () => {
    expect(isTransientRpcError(makeError('read ECONNRESET'))).toBe(true);
  });

  it('socket hang up is transient', () => {
    expect(isTransientRpcError(makeError('socket hang up'))).toBe(true);
  });

  it('econnrefused is transient', () => {
    expect(isTransientRpcError(makeError('connect ECONNREFUSED'))).toBe(true);
  });

  it('etimedout is transient', () => {
    expect(isTransientRpcError(makeError('connect ETIMEDOUT'))).toBe(true);
  });

  it('case-insensitive message matching', () => {
    expect(isTransientRpcError(makeError('SOCKET HANG UP'))).toBe(true);
    expect(isTransientRpcError(makeError('Gateway Time-Out'))).toBe(true);
  });

  // Generic errors — NOT transient
  it('generic Error without code is not transient', () => {
    expect(isTransientRpcError(new Error('something went wrong'))).toBe(false);
  });

  it('INVALID_ARGUMENT is not transient', () => {
    expect(isTransientRpcError(makeError('invalid argument', 'INVALID_ARGUMENT'))).toBe(false);
  });

  it('unknown code is not transient', () => {
    expect(isTransientRpcError(makeError('unexpected error', 'UNKNOWN_ERROR'))).toBe(false);
  });
});

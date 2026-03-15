/**
 * Gauge staking operations for Aerodrome CL (Slipstream) positions.
 *
 * Aerodrome CL positions can be staked in CLGauge contracts to earn AERO
 * incentive rewards. When a staked position is rebalanced, the NFT must be
 * unstaked first (gauge.withdraw), then the normal rebalance flow runs, and
 * the new NFT is re-staked (gauge.deposit) after minting.
 *
 * Security: Before any state-changing gauge call, we verify the gauge
 * contract's `voter()` returns the known Aerodrome Voter address. This
 * prevents a misconfigured gauge_address from causing arbitrary contract calls.
 */

import { createRequire } from 'node:module';
import { ethers } from 'ethers';
import type { ChainContext } from './chain.js';
import { GAS_LIMITS } from './config/constants.js';
import { ZERO_ADDRESS } from './config/constants.js';
import logger from './logger.js';

const require = createRequire(import.meta.url);
const CLGaugeABI = require('../abis/AerodromeCLGauge.json');
const VoterABI = require('../abis/AerodromeVoter.json');

/** Known Aerodrome Voter contracts by chain ID */
const AERODROME_VOTER: Record<number, string> = {
  8453: '0x16613524e02ad97eDfeF371bC883F2F5d6C480A5', // Base Mainnet
};

/** In-memory cache: poolAddress → gaugeAddress */
const gaugeCache = new Map<string, string>();

const ADDRESS_REGEX = /^0x[0-9a-fA-F]{40}$/;

/**
 * Validate that a gauge address is a legitimate Aerodrome CL gauge.
 * Calls gauge.voter() and compares to the known Voter contract for the chain.
 * Throws if validation fails.
 */
async function validateGauge(
  gaugeAddress: string,
  chain: ChainContext,
  chainId: number,
): Promise<void> {
  if (!ADDRESS_REGEX.test(gaugeAddress)) {
    throw new Error(`Invalid gauge address format: ${gaugeAddress}`);
  }
  if (gaugeAddress === ZERO_ADDRESS) {
    throw new Error('Gauge address is the zero address');
  }

  const expectedVoter = AERODROME_VOTER[chainId];
  if (!expectedVoter) {
    throw new Error(`No known Aerodrome Voter address for chain ${chainId} — cannot validate gauge`);
  }

  const gauge = new ethers.Contract(gaugeAddress, CLGaugeABI, chain.provider);
  const actualVoter: string = await chain.withRetry(async () => gauge.voter());

  if (actualVoter.toLowerCase() !== expectedVoter.toLowerCase()) {
    throw new Error(
      `Gauge ${gaugeAddress} voter() returned ${actualVoter}, expected ${expectedVoter}. ` +
      `This gauge address may be invalid or malicious — refusing to interact.`,
    );
  }
}

/**
 * Resolve the gauge address for a pool via the Voter contract.
 * Results are cached in-memory.
 */
export async function getGaugeAddress(
  poolAddress: string,
  chain: ChainContext,
  chainId: number,
): Promise<string | null> {
  const cacheKey = `${chainId}-${poolAddress.toLowerCase()}`;
  const cached = gaugeCache.get(cacheKey);
  if (cached) return cached;

  const voterAddress = AERODROME_VOTER[chainId];
  if (!voterAddress) return null;

  const voter = new ethers.Contract(voterAddress, VoterABI, chain.provider);
  const gaugeAddr: string = await chain.withRetry(async () => voter.gauges(poolAddress));

  if (!gaugeAddr || gaugeAddr === ZERO_ADDRESS) return null;

  gaugeCache.set(cacheKey, gaugeAddr);
  return gaugeAddr;
}

/**
 * Check if a position NFT is currently staked in a gauge.
 * Returns true if gauge.ownerOf(tokenId) matches the wallet address.
 */
export async function isPositionStaked(
  tokenId: number,
  gaugeAddress: string,
  chain: ChainContext,
): Promise<boolean> {
  try {
    const gauge = new ethers.Contract(gaugeAddress, CLGaugeABI, chain.provider);
    const owner: string = await chain.withRetry(async () => gauge.ownerOf(tokenId));
    return owner.toLowerCase() === chain.wallet.address.toLowerCase();
  } catch (err: any) {
    // If ownerOf reverts, the token isn't staked in this gauge
    if (err.code === 'CALL_EXCEPTION') return false;
    throw err;
  }
}

/**
 * Unstake an NFT from a gauge. Transfers the NFT back to the caller's wallet.
 * Validates the gauge is legitimate before executing.
 */
export async function withdrawFromGauge(
  tokenId: number,
  gaugeAddress: string,
  chain: ChainContext,
  chainId: number,
): Promise<{ txHash: string; gasUsed: bigint }> {
  await validateGauge(gaugeAddress, chain, chainId);

  const gauge = new ethers.Contract(gaugeAddress, CLGaugeABI, chain.wallet);
  const nonce = await chain.nonceManager.getNextNonce();

  logger.info(`Withdrawing position ${tokenId} from gauge ${gaugeAddress}`);
  const tx = await gauge.withdraw(tokenId, {
    gasLimit: GAS_LIMITS.GAUGE_WITHDRAW,
    nonce,
  });
  const receipt = await tx.wait();
  chain.nonceManager.confirmNonce(nonce);

  const gasUsed = BigInt(receipt.gasUsed);
  logger.info(`Gauge withdraw tx: ${receipt.hash} (gas: ${gasUsed})`);
  return { txHash: receipt.hash, gasUsed };
}

/**
 * Approve and deposit an NFT into a gauge for staking.
 * Uses per-token approve() (not setApprovalForAll) for minimal permission.
 * Validates the gauge is legitimate before executing.
 */
export async function depositToGauge(
  tokenId: number,
  gaugeAddress: string,
  npmAddress: string,
  chain: ChainContext,
  chainId: number,
): Promise<{ txHash: string; gasUsed: bigint }> {
  await validateGauge(gaugeAddress, chain, chainId);

  // Step 1: Approve the gauge to transfer this specific NFT
  const npm = new ethers.Contract(npmAddress, [
    'function approve(address to, uint256 tokenId) external',
  ], chain.wallet);

  const approveNonce = await chain.nonceManager.getNextNonce();
  logger.info(`Approving gauge ${gaugeAddress} for NFT #${tokenId}`);
  const approveTx = await npm.approve(gaugeAddress, tokenId, {
    gasLimit: GAS_LIMITS.GAUGE_APPROVE,
    nonce: approveNonce,
  });
  const approveReceipt = await approveTx.wait();
  chain.nonceManager.confirmNonce(approveNonce);

  const approveGas = BigInt(approveReceipt.gasUsed);
  logger.info(`NFT approve tx: ${approveReceipt.hash} (gas: ${approveGas})`);

  // Step 2: Deposit the NFT into the gauge
  const gauge = new ethers.Contract(gaugeAddress, CLGaugeABI, chain.wallet);
  const depositNonce = await chain.nonceManager.getNextNonce();

  logger.info(`Depositing position ${tokenId} into gauge ${gaugeAddress}`);
  const tx = await gauge.deposit(tokenId, {
    gasLimit: GAS_LIMITS.GAUGE_DEPOSIT,
    nonce: depositNonce,
  });
  const receipt = await tx.wait();
  chain.nonceManager.confirmNonce(depositNonce);

  const depositGas = BigInt(receipt.gasUsed);
  const totalGas = approveGas + depositGas;
  logger.info(`Gauge deposit tx: ${receipt.hash} (gas: ${depositGas}, total with approve: ${totalGas})`);
  return { txHash: receipt.hash, gasUsed: totalGas };
}

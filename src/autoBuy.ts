import { Connection, PublicKey, SystemProgram, TransactionMessage, VersionedTransaction, ComputeBudgetProgram, Keypair } from '@solana/web3.js';
import BN from 'bn.js';
import { PumpSdk, getBuyTokenAmountFromSolAmount } from '@pump-fun/pump-sdk';
import { logger } from './logger';
import { config } from './config';
import { sendTransactions, sendTransaction } from './sender/helius';

export type AutoBuyParams = {
  connection: Connection;
  wallet: Keypair;
  mint: PublicKey;
  createdAtMs: number;
};

function nowMs() { return Date.now(); }

export async function attemptAutoBuy({ connection, wallet, mint, createdAtMs }: AutoBuyParams): Promise<void> {
  if (!config.autoBuyEnabled) return;
  const age = nowMs() - createdAtMs;
  if (age < config.minCreateMs) return; // too early
  if (age > config.maxCreateAgeMs) return; // stale

  const sdk = new PumpSdk(connection);
  const user = wallet.publicKey;
  const global = await sdk.fetchGlobal();
  const feeConfig = await sdk.fetchFeeConfig();
  const { bondingCurveAccountInfo, bondingCurve, associatedUserAccountInfo } = await sdk.fetchBuyState(mint, user);

  // Quote tokens for buySol
  const lamports = new BN(Math.floor(config.buySol * 1_000_000_000));
  const amountTokens = getBuyTokenAmountFromSolAmount({
    global,
    feeConfig,
    mintSupply: null,
    bondingCurve,
    amount: lamports,
  });
  if (amountTokens.lten(0)) {
    logger.warn('Auto-buy quote returned zero tokens', { mint: mint.toBase58() });
    return;
  }

  // Build buy instructions
  const slippage = Math.max(0, Math.min(1000, config.maxSlippageBps)) / 1000; // pump sdk expects fraction 0.. ?
  const buyIxs = await sdk.buyInstructions({
    global,
    bondingCurveAccountInfo,
    bondingCurve,
    associatedUserAccountInfo,
    mint,
    user,
    amount: amountTokens,
    solAmount: lamports,
    slippage,
  } as any);

  // Compute budget adjustments
  const cuIxs = [
    ComputeBudgetProgram.setComputeUnitLimit({ units: 1_000_000 }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: Math.floor(config.priorityFeeSol * 1_000_000_000) }),
  ];

  const recent = await connection.getLatestBlockhash('processed');
  const messageV0 = new TransactionMessage({
    payerKey: user,
    recentBlockhash: recent.blockhash,
    instructions: [...cuIxs, ...buyIxs],
  }).compileToV0Message();
  const buyTx = new VersionedTransaction(messageV0);
  buyTx.sign([wallet]);
  const buyB64 = Buffer.from(buyTx.serialize()).toString('base64');

  if (config.jitoEnabled) {
    // Build tip tx
    const tipLamports = Math.floor(config.jitoTipSol * 1_000_000_000);
    let tipTo: PublicKey | null = null;
    try {
      const sources = (config.jitoTipAccounts && config.jitoTipAccounts.length > 0)
        ? config.jitoTipAccounts
        : (config.jitoTipAccount ? [config.jitoTipAccount] : []);
      const list: string[] = (sources as Array<string | undefined>).filter((s): s is string => typeof s === 'string' && !!s);
      if (list.length > 0) {
        const idx = Math.floor(Math.random() * list.length);
        const pick = list[idx]!; // safe by length check
        tipTo = new PublicKey(pick);
      }
    } catch {}
    if (!tipTo) {
      logger.warn('Jito enabled but no JITO_TIP_ACCOUNT provided; falling back to RPC send');
    } else {
      const tipMsg = new TransactionMessage({
        payerKey: user,
        recentBlockhash: recent.blockhash,
        instructions: [
          SystemProgram.transfer({ fromPubkey: user, toPubkey: tipTo, lamports: tipLamports }),
        ],
      }).compileToV0Message();
      const tipTx = new VersionedTransaction(tipMsg);
      tipTx.sign([wallet]);
      const tipB64 = Buffer.from(tipTx.serialize()).toString('base64');
      const senderUrl = (config.heliusSenderUrl && config.heliusSenderUrl.includes('/v0/transactions'))
        ? (config.heliusSenderUrl as string)
        : `https://api.helius.xyz/v0/transactions?api-key=${encodeURIComponent(config.heliusApiKey || '')}`;
      try {
        const res = await sendTransactions(senderUrl, [buyB64, tipB64], { preflightCommitment: config.senderCommitment, skipPreflight: true });
        logger.info('Bundle submitted', { mint: mint.toBase58(), result: res });
        return;
      } catch (e) {
        logger.warn('Bundle submission failed, falling back to single send', { err: String((e as any)?.message || e) });
      }
    }
  }

  // Fallback: send single tx
  try {
    const senderUrl = (config.heliusSenderUrl && config.heliusSenderUrl.includes('/v0/transactions'))
      ? (config.heliusSenderUrl as string)
      : `https://api.helius.xyz/v0/transactions?api-key=${encodeURIComponent(config.heliusApiKey || '')}`;
    const res = await sendTransaction(senderUrl, buyB64, { preflightCommitment: config.senderCommitment, skipPreflight: true });
    logger.info('Buy submitted (single)', { mint: mint.toBase58(), result: res });
  } catch (e) {
    logger.warn('Buy submission via Sender failed; attempting RPC direct send', { err: String((e as any)?.message || e) });
    try {
      const sig = await connection.sendRawTransaction(buyTx.serialize(), { skipPreflight: true, preflightCommitment: config.senderCommitment as any });
      logger.info('Buy submitted via RPC', { mint: mint.toBase58(), sig });
    } catch (e2) {
      logger.error('Buy submission failed (RPC fallback)', { err: String((e2 as any)?.message || e2) });
    }
  }
}

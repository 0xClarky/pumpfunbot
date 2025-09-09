import { Connection, PublicKey, SystemProgram, TransactionMessage, VersionedTransaction, ComputeBudgetProgram, Keypair } from '@solana/web3.js';
import BN from 'bn.js';
import { PumpSdk, getBuyTokenAmountFromSolAmount } from '@pump-fun/pump-sdk';
import { logger } from './logger';
import { config } from './config';
import { sendBundleJito } from './sender/jito';

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
      try {
        const res = await sendBundleJito({ blockEngineUrl: (config as any).jitoBlockEngine, identity: wallet, txs: [buyTx, tipTx], deadlineMs: (config as any).jitoDeadlineMs });
        if (res.ok) {
          logger.info('Jito bundle submitted', { mint: mint.toBase58(), bundleId: res.bundleId });
          return;
        }
        logger.warn('Jito bundle not accepted', { mint: mint.toBase58(), reason: res.reason });
      } catch (e) {
        logger.warn('Jito bundle submission error', { err: String((e as any)?.message || e) });
      }
    }
  }

  // Fallback: send via RPC
  try {
    const sig = await connection.sendRawTransaction(buyTx.serialize(), { skipPreflight: true, preflightCommitment: config.senderCommitment as any });
    logger.info('Buy submitted via RPC', { mint: mint.toBase58(), sig });
  } catch (e2) {
    logger.error('Buy submission failed (RPC fallback)', { err: String((e2 as any)?.message || e2) });
  }
}

import { Connection, PublicKey, SystemProgram, TransactionMessage, VersionedTransaction, ComputeBudgetProgram, Keypair } from '@solana/web3.js';
import BN from 'bn.js';
import { PumpSdk, getBuyTokenAmountFromSolAmount } from '@pump-fun/pump-sdk';
import { logger } from './logger';
import { config } from './config';
import { sendBundleJito } from './sender/jito';
import { sendBundleJsonRpc } from './sender/jito_jsonrpc';

export type AutoBuyParams = {
  connection: Connection;
  wallet: Keypair;
  mint: PublicKey;
  createdAtMs: number;
};

function nowMs() { return Date.now(); }

async function waitSignatureWS(
  connection: Connection,
  sig: string,
  commit: 'processed' | 'confirmed',
  timeoutMs: number,
): Promise<void> {
  return new Promise((resolve, reject) => {
    let timer: any;
    try {
      const subId = connection.onSignature(
        sig,
        (res: any) => {
          clearTimeout(timer);
          if (res?.err) reject(new Error(`tx-error:${JSON.stringify(res.err)}`));
          else resolve();
        },
        commit,
      );
      timer = setTimeout(() => {
        connection.removeSignatureListener(subId).catch(() => {});
        reject(new Error('ws-timeout'));
      }, timeoutMs);
    } catch (e) {
      reject(e as any);
    }
  });
}

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
  // Pump SDK expects a numeric 'slippage' such that: added = amount * floor(slippage*10) / 1000
  // To represent BPS correctly, use slippage = (bps / 100): e.g., 1000 bps => 10 (10%)
  const slippage = Math.max(0, Math.min(5000, config.maxSlippageBps)) / 100;
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

  // Compute budget adjustments (align with sell logic): ~300k CU and microLamports per CU
  function priorityFeeMicrosPerCU(): number {
    const lamports = Math.floor(config.priorityFeeSol * 1e9);
    const units = 200_000; // approximate units budget
    const lamportsPerCU = lamports / units;
    return Math.max(0, Math.floor(lamportsPerCU * 1e6)); // lamports -> microLamports
  }
  const microLamports = priorityFeeMicrosPerCU();
  const cuIxs = [
    ComputeBudgetProgram.setComputeUnitLimit({ units: 300_000 }),
    microLamports > 0 ? ComputeBudgetProgram.setComputeUnitPrice({ microLamports }) : null,
  ].filter(Boolean) as any[];

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
        // Prefer JSON-RPC if configured (no auth requirement at default limits)
        if ((config as any).jitoJsonRpcUrl) {
          const res = await sendBundleJsonRpc({ endpoint: (config as any).jitoJsonRpcUrl!, txsBase64: [buyB64, tipB64], uuid: (config as any).jitoUuid, timeoutMs: (config as any).jitoDeadlineMs });
          if (res.ok) {
            logger.info('Jito JSON-RPC bundle submitted', { mint: mint.toBase58(), result: res.result });
            return;
          }
          logger.warn('Jito JSON-RPC bundle failed', { mint: mint.toBase58(), err: res.error });
        } else {
          const res = await sendBundleJito({ blockEngineUrl: (config as any).jitoBlockEngine, identity: wallet, txs: [buyTx, tipTx], deadlineMs: (config as any).jitoDeadlineMs });
          if (res.ok) {
            logger.info('Jito gRPC bundle submitted', { mint: mint.toBase58(), bundleId: res.bundleId });
            return;
          }
          logger.warn('Jito gRPC bundle not accepted', { mint: mint.toBase58(), reason: res.reason });
        }
      } catch (e) {
        logger.warn('Jito bundle submission error', { err: String((e as any)?.message || e) });
      }
    }
  }

  // Fallback: send via RPC (single attempt, WS confirm; no retries)
  try {
    const latest = await connection.getLatestBlockhash('processed');
    // Rebuild with fresh blockhash
    const fallbackMsg = new TransactionMessage({
      payerKey: user,
      recentBlockhash: latest.blockhash,
      instructions: [...cuIxs, ...buyIxs],
    }).compileToV0Message();
    const fallbackTx = new VersionedTransaction(fallbackMsg);
    fallbackTx.sign([wallet]);
    const sig = await connection.sendRawTransaction(fallbackTx.serialize(), {
      skipPreflight: config.skipPreflight,
      preflightCommitment: config.senderCommitment as any,
      maxRetries: 0,
    } as any);
    logger.info('Buy submitted via RPC', { mint: mint.toBase58(), sig });
    // WS processed (fast) then background confirmed — do not block queue
    const fastWait = Math.max(1500, (config as any).senderWaitMs || 4000);
    try {
      await waitSignatureWS(connection, sig, 'processed', fastWait);
      logger.info('Buy observed (ws:processed)', { sig });
    } catch (eProc) {
      logger.warn('Buy ws processed timed out', { sig, err: String((eProc as any)?.message || eProc) });
    }
    // Background confirm (non-blocking)
    void (async () => {
      try {
        await waitSignatureWS(connection, sig, 'confirmed', 12000);
        logger.info('Buy confirmed (ws)', { sig });
      } catch {}
    })();
  } catch (e2) {
    logger.error('Buy submission failed (RPC fallback)', { err: String((e2 as any)?.message || e2) });
  }
}

import { Connection, PublicKey, ParsedTransactionWithMeta } from '@solana/web3.js';
import { getAssociatedTokenAddressSync } from '@solana/spl-token';
import { PUMP_PROGRAM_ID, PUMP_AMM_PROGRAM_ID, bondingCurvePda } from '@pump-fun/pump-sdk';
import { logger } from './logger';

export type BuyEvent = {
  signature: string;
  slot: number;
  blockTime?: number | null;
  mint: string;
  tokenDelta: bigint; // in base units
  solCostLamports: bigint; // lamports spent by wallet (includes tx fee)
  txFeeLamports?: bigint; // meta.fee
  curveCostLamports?: bigint; // lamports paid into program (excludes tx fee)
};

function includesPumpProgram(tx: ParsedTransactionWithMeta): boolean {
  const keys = tx.transaction.message.accountKeys.map((k) =>
    typeof k === 'string' ? k : ('pubkey' in k ? k.pubkey.toString() : String(k)),
  );
  return (
    keys.includes(PUMP_PROGRAM_ID.toBase58()) ||
    keys.includes(PUMP_AMM_PROGRAM_ID.toBase58())
  );
}

function findWalletIndex(tx: ParsedTransactionWithMeta, wallet: PublicKey): number {
  const keys = tx.transaction.message.accountKeys.map((k: any) =>
    'pubkey' in k ? k.pubkey.toBase58() : k.toString(),
  );
  return keys.indexOf(wallet.toBase58());
}

function parseBuyEvent(
  tx: ParsedTransactionWithMeta,
  wallet: PublicKey,
): BuyEvent | null {
  // Ignore ancient transactions relative to process start (if blockTime present)
  const bootTime = START_TIME_SECONDS;
  if (!tx.meta) return null;
  if (!includesPumpProgram(tx)) return null;

  const walletIndex = findWalletIndex(tx, wallet);
  if (walletIndex < 0) return null;

  const txFeeLamports = BigInt(tx.meta.fee ?? 0);

  // Token delta for owner=wallet; look for positive increase
  const preTB = tx.meta.preTokenBalances || [];
  const postTB = tx.meta.postTokenBalances || [];

  // Build map key by mint to sum deltas (some tx may touch multiple mints)
  const deltas = new Map<string, bigint>();
  for (const post of postTB) {
    if (post.owner !== wallet.toBase58()) continue;
    const mint = post.mint;
    const postRaw = BigInt(post.uiTokenAmount.amount);
    const preMatch = preTB.find(
      (p) => p.mint === mint && p.owner === post.owner && p.accountIndex === post.accountIndex,
    );
    const preRaw = preMatch ? BigInt(preMatch.uiTokenAmount.amount) : 0n;
    const delta = postRaw - preRaw;
    if (delta > 0n) {
      deltas.set(mint, (deltas.get(mint) || 0n) + delta);
    }
  }

  // Choose the largest positive delta as the bought mint
  let chosenMint: string | null = null;
  let maxDelta = 0n;
  for (const [mint, d] of deltas.entries()) {
    if (d > maxDelta) {
      maxDelta = d;
      chosenMint = mint;
    }
  }

  if (!chosenMint || maxDelta <= 0n) return null; // ensures it's a buy (token increase)
  if (typeof tx.blockTime === 'number' && tx.blockTime < bootTime - 5) return null;

  const sig = tx.transaction.signatures?.[0];
  if (!sig) return null;
  // Compute accurate SOL cost by summing wallet -> destination transfers in inner instructions,
  // excluding ATA rent deposit. This captures bonding curve + protocol fee, not network fee.
  let parsedCost = 0n;
  try {
    const ata = getAssociatedTokenAddressSync(new PublicKey(chosenMint), wallet, true).toBase58();
    const walletStr = wallet.toBase58();
    for (const inner of tx.meta.innerInstructions || []) {
      for (const ix of (inner as any).instructions || []) {
        const parsed = (ix as any).parsed;
        if (!parsed || parsed.type !== 'transfer') continue;
        const info = parsed.info || {};
        if (info.source === walletStr && info.destination && info.lamports) {
          const dest = String(info.destination);
          if (dest === ata) continue; // exclude ATA rent
          parsedCost += BigInt(info.lamports);
        }
      }
    }
  } catch {}

  // As a fallback, use lamport delta minus tx fee and minus any ATA rent we can infer
  let fallbackCost = 0n;
  try {
    const preLamports = BigInt(tx.meta.preBalances?.[walletIndex] ?? 0);
    const postLamports = BigInt(tx.meta.postBalances?.[walletIndex] ?? 0);
    let delta = preLamports > postLamports ? preLamports - postLamports : 0n;
    // subtract tx fee
    if (delta > txFeeLamports) delta -= txFeeLamports;
    // subtract ATA rent if present
    try {
      const ata = getAssociatedTokenAddressSync(new PublicKey(chosenMint), wallet, true).toBase58();
      const keys = tx.transaction.message.accountKeys.map((k: any) => ('pubkey' in k ? k.pubkey.toBase58() : k.toString()));
      const ataIdx = keys.indexOf(ata);
      if (ataIdx >= 0) {
        const pre = BigInt(tx.meta.preBalances?.[ataIdx] ?? 0);
        const post = BigInt(tx.meta.postBalances?.[ataIdx] ?? 0);
        if (post > pre) {
          const rent = post - pre;
          if (delta > rent) delta -= rent;
        }
      }
    } catch {}
    fallbackCost = delta;
  } catch {}

  const finalCurveCost = parsedCost > 0n ? parsedCost : fallbackCost;
  if (finalCurveCost <= 0n) return null; // ensure wallet actually paid SOL (filters transfers/airdrops)

  return {
    signature: sig,
    slot: tx.slot,
    blockTime: tx.blockTime ?? null,
    mint: chosenMint,
    tokenDelta: maxDelta,
    solCostLamports: finalCurveCost,
    txFeeLamports,
    curveCostLamports: finalCurveCost,
  };
}

// Bound to process start to avoid historical replays
const START_TIME_SECONDS = Math.floor(Date.now() / 1000);

export function startBuyDetection({
  connection,
  wallet,
  onBuy,
  pollMs = 1000,
  mode = 'auto',
}: {
  connection: Connection;
  wallet: PublicKey;
  onBuy: (evt: BuyEvent) => void;
  pollMs?: number;
  mode?: 'auto' | 'ws' | 'poll';
}): { stop: () => void } {
  let stopped = false;
  let subId: number | null = null;
  // tipSig tracks the newest signature seen at startup to avoid replaying history
  let tipSig: string | null = null;
  const inFlight = new Set<string>();
  const processed = new Set<string>();
  const processedQueue: string[] = [];
  function markProcessed(sig: string) {
    if (processed.has(sig)) return;
    processed.add(sig);
    processedQueue.push(sig);
    if (processedQueue.length > 200) {
      const old = processedQueue.shift();
      if (old) processed.delete(old);
    }
  }

  async function handleSignature(sig: string) {
    if (inFlight.has(sig)) return;
    inFlight.add(sig);
    try {
      const tx = await connection.getParsedTransaction(sig, {
        maxSupportedTransactionVersion: 0,
        commitment: 'confirmed',
      });
      if (!tx) return;
      const evt = parseBuyEvent(tx, wallet);
      if (evt) {
        logger.info('Detected buy', evt);
        onBuy(evt);
        markProcessed(sig);
      }
    } catch (e) {
      logger.warn('Failed to parse tx', { sig, err: String((e as any)?.message || e) });
    } finally {
      inFlight.delete(sig);
    }
  }

  // Primary: logs subscription for the wallet
  let wsActive = false;
  if (mode !== 'poll') {
    try {
      subId = connection.onLogs(wallet, (logs) => {
        if (stopped) return;
        if (logs.err) return; // only success
        if (!logs.signature) return;
        handleSignature(logs.signature);
      }, 'confirmed');
      logger.info('WS logs subscription active', { id: subId });
      wsActive = true;
    } catch (e) {
      logger.error('WS subscription failed', { err: String(e) });
    }
  }

  // Fallback: polling signatures
  async function pollLoop() {
    while (!stopped) {
      try {
        const sigs = await connection.getSignaturesForAddress(wallet, { limit: 20 }, 'confirmed');
        if (!tipSig) {
          // Initialize tip to newest and skip history on first poll
          tipSig = sigs[0]?.signature || null;
        } else {
          // Collect only signatures newer than tipSig
          const newOnes: string[] = [];
          for (const s of sigs) {
            if (s.signature === tipSig) break;
            if (!processed.has(s.signature)) newOnes.push(s.signature);
          }
          // Process oldest -> newest to maintain order
          for (let i = newOnes.length - 1; i >= 0; i--) {
            const sig = newOnes[i];
            if (!sig) continue;
            await handleSignature(sig);
          }
          if (sigs[0]?.signature) tipSig = sigs[0].signature;
        }
      } catch (e) {
        logger.warn('Polling failed', { err: String(e) });
      }
      await new Promise((r) => setTimeout(r, pollMs));
    }
  }
  // Run poller only if WS is not active or fails
  if (!wsActive || mode === 'poll') pollLoop();

  return {
    stop: () => {
      stopped = true;
      if (subId !== null) connection.removeOnLogsListener(subId).catch(() => {});
    },
  };
}

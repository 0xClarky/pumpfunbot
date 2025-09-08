import { Connection, PublicKey } from '@solana/web3.js';
import { getAssociatedTokenAddressSync } from '@solana/spl-token';
import { logger } from '../logger';

export async function computeCreatorInitialBuyLamports(
  connection: Connection,
  params: { signature: string; creator: string; mint: string },
): Promise<bigint> {
  try {
    const tx = await connection.getParsedTransaction(params.signature, {
      maxSupportedTransactionVersion: 0,
      commitment: 'confirmed',
    } as any);
    if (!tx) return 0n;
    const creatorPk = new PublicKey(params.creator);
    const ata = getAssociatedTokenAddressSync(new PublicKey(params.mint), creatorPk, true).toBase58();
    const creatorStr = creatorPk.toBase58();
    let spent = 0n;
    for (const inner of (tx.meta?.innerInstructions || []) as any[]) {
      for (const ix of (inner.instructions || []) as any[]) {
        const parsed = (ix as any).parsed;
        if (!parsed || parsed.type !== 'transfer') continue;
        const info = parsed.info || {};
        if (info.source === creatorStr && info.destination && info.lamports) {
          const dest = String(info.destination);
          if (dest === ata) continue; // exclude ATA rent
          spent += BigInt(info.lamports);
        }
      }
    }
    return spent;
  } catch (e) {
    logger.debug('creator-initial-buy parse failed', { err: String((e as any)?.message || e) });
    return 0n;
  }
}

export async function findFunderOneHop(
  connection: Connection,
  params: { creator: string; beforeSig?: string; timeoutMs: number; limit?: number },
): Promise<string | null> {
  const creator = new PublicKey(params.creator);
  const creatorStr = creator.toBase58();
  const deadline = Date.now() + params.timeoutMs;
  const limit = Math.max(1, Math.min(100, params.limit ?? 25));

  function balanceDeltaToCreator(tx: any): number {
    try {
      const keys = (tx.transaction?.message?.accountKeys || []).map((k: any) => (k?.pubkey ? k.pubkey.toBase58() : String(k)));
      const i = keys.indexOf(creatorStr);
      if (i < 0) return 0;
      const pre = Number(tx.meta?.preBalances?.[i] ?? 0);
      const post = Number(tx.meta?.postBalances?.[i] ?? 0);
      return post - pre;
    } catch { return 0; }
  }

  function scanParsedForFunder(tx: any): string | null {
    const scanList = (arr: any[]) => {
      for (const ix of arr) {
        const p = (ix as any).parsed;
        if (!p || !p.info) continue;
        if (p.type === 'transfer' && p.info.destination === creatorStr && p.info.source) {
          return String(p.info.source);
        }
        if (p.type === 'transferWithSeed' && p.info?.toPubkey === creatorStr && p.info?.fromPubkey) {
          return String(p.info.fromPubkey);
        }
      }
      return null;
    };
    // top-level parsed
    const top = (tx.transaction?.message?.instructions || []) as any[];
    const foundTop = scanList(top);
    if (foundTop) return foundTop;
    // inner parsed
    for (const entry of (tx.meta?.innerInstructions || []) as any[]) {
      const found = scanList(entry.instructions || []);
      if (found) return found;
    }
    return null;
  }

  try {
    const sigs = await connection.getSignaturesForAddress(creator, params.beforeSig ? { before: params.beforeSig, limit } : { limit }, 'confirmed');
    for (const s of sigs) {
      if (Date.now() > deadline) break;
      const tx = await connection.getParsedTransaction(s.signature, { maxSupportedTransactionVersion: 0, commitment: 'confirmed' } as any);
      if (!tx) continue;
      const inbound = balanceDeltaToCreator(tx);
      if (inbound <= 0) continue; // no SOL increase to creator
      const funder = scanParsedForFunder(tx);
      if (funder) return funder;
      // If parsed didn't expose the source, keep looking next tx
    }
  } catch (e) {
    logger.debug('funder-lookup failed', { err: String((e as any)?.message || e) });
  }
  return null;
}

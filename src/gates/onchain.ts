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
  params: { creator: string; beforeSig?: string; timeoutMs: number },
): Promise<string | null> {
  const creator = new PublicKey(params.creator);
  const deadline = Date.now() + params.timeoutMs;
  try {
    const sigs = await connection.getSignaturesForAddress(creator, params.beforeSig ? { before: params.beforeSig, limit: 25 } : { limit: 25 }, 'confirmed');
    for (const s of sigs) {
      if (Date.now() > deadline) break;
      const tx = await connection.getParsedTransaction(s.signature, { maxSupportedTransactionVersion: 0, commitment: 'confirmed' } as any);
      const inner = tx?.meta?.innerInstructions || [];
      let funder: string | null = null;
      for (const entry of inner as any[]) {
        for (const ix of (entry.instructions || []) as any[]) {
          const p = (ix as any).parsed;
          if (p?.type === 'transfer' && p.info?.destination === creator.toBase58()) {
            funder = String(p.info.source);
            break;
          }
        }
        if (funder) break;
      }
      if (funder) return funder;
    }
  } catch (e) {
    logger.debug('funder-lookup failed', { err: String((e as any)?.message || e) });
  }
  return null;
}


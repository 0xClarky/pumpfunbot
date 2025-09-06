import { PublicKey } from '@solana/web3.js';
import BN from 'bn.js';

export type Position = {
  mint: PublicKey;
  openedAt: number; // epoch seconds
  openedSig: string;
  tokens: BN; // in base units
  costLamports: BN; // basis includes fee
  peakSolOut?: BN; // highest observed expected SOL-out
};

export class Positions {
  private byMint = new Map<string, Position>();

  all(): Position[] {
    return [...this.byMint.values()];
  }

  get(mint: PublicKey): Position | undefined {
    return this.byMint.get(mint.toBase58());
  }

  // Accumulate a new buy into an existing position (adds tokens + cost)
  addBuy(pos: Position) {
    const key = pos.mint.toBase58();
    const existing = this.byMint.get(key);
    if (existing) {
      // Accumulate additional buys into same mint
      existing.tokens = existing.tokens.add(pos.tokens);
      existing.costLamports = existing.costLamports.add(pos.costLamports);
      existing.openedSig = pos.openedSig; // latest buy signature
      existing.openedAt = pos.openedAt;
      this.byMint.set(key, existing);
    } else {
      this.byMint.set(key, pos);
    }
  }

  // Update specific fields of an existing position without altering tokens/cost unless provided
  update(mint: PublicKey, fields: Partial<Position>) {
    const key = mint.toBase58();
    const existing = this.byMint.get(key);
    if (!existing) return;
    if (fields.openedAt !== undefined) existing.openedAt = fields.openedAt;
    if (fields.openedSig !== undefined) existing.openedSig = fields.openedSig;
    if (fields.tokens !== undefined) existing.tokens = fields.tokens;
    if (fields.costLamports !== undefined) existing.costLamports = fields.costLamports;
    if (fields.peakSolOut !== undefined) existing.peakSolOut = fields.peakSolOut;
    this.byMint.set(key, existing);
  }

  // Backward-compat: treat upsert as addBuy (only used on buy paths previously)
  upsert(pos: Position) {
    this.addBuy(pos);
  }

  close(mint: PublicKey) {
    this.byMint.delete(mint.toBase58());
  }
}

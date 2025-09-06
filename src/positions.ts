import { PublicKey } from '@solana/web3.js';
import BN from 'bn.js';

export type Position = {
  mint: PublicKey;
  openedAt: number; // epoch seconds
  openedSig: string;
  tokens: BN; // in base units
  costLamports: BN; // basis includes fee
};

export class Positions {
  private byMint = new Map<string, Position>();

  all(): Position[] {
    return [...this.byMint.values()];
  }

  get(mint: PublicKey): Position | undefined {
    return this.byMint.get(mint.toBase58());
  }

  upsert(pos: Position) {
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

  close(mint: PublicKey) {
    this.byMint.delete(mint.toBase58());
  }
}

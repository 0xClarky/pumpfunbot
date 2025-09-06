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
    this.byMint.set(pos.mint.toBase58(), pos);
  }

  close(mint: PublicKey) {
    this.byMint.delete(mint.toBase58());
  }
}


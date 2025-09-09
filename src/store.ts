import fs from 'fs';
import path from 'path';
import { logger } from './logger';

export type CreatorRecord = {
  id: string; // pubkey
  firstSig: string;
  creates: number;
  updatedAt: number; // epoch seconds
};

export type MintRecord = {
  mint: string;
  creator: string;
  sig: string;
  name: string;
  symbol: string;
  uri: string;
  ts: number; // epoch seconds
};

export type KnownCreatorRecord = {
  id: string;
  reason?: string;
  createdAt: number; // epoch seconds
};

type StoreShape = {
  creators: Record<string, CreatorRecord>;
  mints: Record<string, MintRecord>;
  knownCreators: Record<string, KnownCreatorRecord>;
  creatorLinks: Record<string, Record<string, { seenSig: string; createdAt: number }>>; // creator -> funder -> link
};

const dataDir = path.join(process.cwd(), 'data');
const dbPath = path.join(dataDir, 'store.json');

function ensureDir() {
  try { fs.mkdirSync(dataDir, { recursive: true }); } catch {}
}

export class Store {
  private data: StoreShape;

  constructor() {
    ensureDir();
    this.data = { creators: {}, mints: {}, knownCreators: {}, creatorLinks: {} };
    this.load();
  }

  private load() {
    try {
      if (fs.existsSync(dbPath)) {
        const raw = fs.readFileSync(dbPath, 'utf8');
        const json = JSON.parse(raw);
        this.data = {
          creators: json.creators || {},
          mints: json.mints || {},
          knownCreators: json.knownCreators || {},
          creatorLinks: json.creatorLinks || {},
        };
      }
    } catch (e) {
      logger.warn('Store load failed', { err: String(e) });
    }
  }

  save() {
    try {
      const tmp = dbPath + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(this.data));
      fs.renameSync(tmp, dbPath);
    } catch (e) {
      logger.warn('Store save failed', { err: String(e) });
    }
  }

  // Known creators (manual blacklist/seed)
  seedKnownCreators(ids: string[], reason = 'seed') {
    const now = Math.floor(Date.now() / 1000);
    for (const id of ids) {
      if (!id) continue;
      if (!this.data.knownCreators[id]) this.data.knownCreators[id] = { id, reason, createdAt: now };
    }
    this.save();
  }
  isKnownCreator(id: string): boolean {
    return Boolean(this.data.knownCreators[id]);
  }

  // Creators observed creating tokens
  hasCreator(id: string): boolean {
    return Boolean(this.data.creators[id]);
  }
  getCreatorCreates(id: string): number {
    const rec = this.data.creators[id];
    return rec ? Number(rec.creates || 0) : 0;
  }
  upsertCreatorOnCreate(id: string, sig: string) {
    const now = Math.floor(Date.now() / 1000);
    const rec = this.data.creators[id];
    if (rec) {
      rec.creates += 1;
      rec.updatedAt = now;
      if (!rec.firstSig) rec.firstSig = sig;
    } else {
      this.data.creators[id] = { id, firstSig: sig, creates: 1, updatedAt: now };
    }
    this.save();
  }

  addMint(m: MintRecord) {
    if (!m.mint) return;
    this.data.mints[m.mint] = m;
    this.save();
  }

  addCreatorLink(creator: string, funder: string, seenSig: string) {
    if (!creator || !funder) return;
    const now = Math.floor(Date.now() / 1000);
    if (!this.data.creatorLinks[creator]) this.data.creatorLinks[creator] = {};
    this.data.creatorLinks[creator][funder] = { seenSig, createdAt: now };
    this.save();
  }
}

export const store = new Store();

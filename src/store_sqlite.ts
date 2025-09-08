import fs from 'fs';
import path from 'path';
import { logger } from './logger';

export type CreatorRecord = {
  id: string;
  firstSig: string;
  creates: number;
  updatedAt: number;
};

export type MintRecord = {
  mint: string;
  creator: string;
  sig: string;
  name: string;
  symbol: string;
  uri: string;
  ts: number;
};

export type KnownCreatorRecord = {
  id: string;
  reason?: string;
  createdAt: number;
};

const dataDir = path.join(process.cwd(), 'data');
const dbFile = path.join(dataDir, 'app.db');
const jsonStore = path.join(dataDir, 'store.json');

// Attempt to load native better-sqlite3. Fallback to JSON store if unavailable.
let BetterSqlite3: any = null;
try {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  BetterSqlite3 = require('better-sqlite3');
} catch (e) {
  logger.warn('better-sqlite3 not available; using JSON store fallback', { err: (e as any)?.message || String(e) });
}

function ensureDir() {
  try { fs.mkdirSync(dataDir, { recursive: true }); } catch {}
}

function openDb(): any {
  ensureDir();
  const db = new BetterSqlite3(dbFile);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS creators (
      id TEXT PRIMARY KEY,
      first_sig TEXT,
      creates INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS mints (
      mint TEXT PRIMARY KEY,
      creator TEXT NOT NULL,
      sig TEXT NOT NULL,
      name TEXT,
      symbol TEXT,
      uri TEXT,
      ts INTEGER,
      FOREIGN KEY (creator) REFERENCES creators(id)
    );
    CREATE INDEX IF NOT EXISTS idx_mints_creator ON mints(creator);
    CREATE TABLE IF NOT EXISTS known_creators (
      id TEXT PRIMARY KEY,
      reason TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS creator_links (
      creator TEXT NOT NULL,
      funder TEXT NOT NULL,
      seen_sig TEXT,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (creator, funder)
    );
    CREATE INDEX IF NOT EXISTS idx_creator_links_funder ON creator_links(funder);
  `);
  return db;
}

class SqlStore {
  private db: any;
  private stmt = {
    seedKnown: null as any,
    isKnown: null as any,
    hasCreator: null as any,
    upsertCreator: null as any,
    addMint: null as any,
    addLink: null as any,
  };

  constructor() {
    this.db = openDb();
    this.prepare();
    this.maybeMigrateJson();
  }

  private prepare() {
    this.stmt.seedKnown = this.db.prepare(
      `INSERT INTO known_creators(id, reason, created_at)
       VALUES(?, ?, ?)
       ON CONFLICT(id) DO NOTHING`
    );
    this.stmt.isKnown = this.db.prepare(`SELECT 1 FROM known_creators WHERE id = ? LIMIT 1`);
    this.stmt.hasCreator = this.db.prepare(`SELECT 1 FROM creators WHERE id = ? LIMIT 1`);
    this.stmt.upsertCreator = this.db.prepare(
      `INSERT INTO creators(id, first_sig, creates, updated_at)
       VALUES(@id, @firstSig, 1, @updatedAt)
       ON CONFLICT(id) DO UPDATE SET
         creates = creators.creates + 1,
         updated_at = excluded.updated_at,
         first_sig = CASE WHEN creators.first_sig IS NULL OR creators.first_sig = '' THEN excluded.first_sig ELSE creators.first_sig END`
    );
    this.stmt.addMint = this.db.prepare(
      `INSERT INTO mints(mint, creator, sig, name, symbol, uri, ts)
       VALUES(@mint, @creator, @sig, @name, @symbol, @uri, @ts)
       ON CONFLICT(mint) DO UPDATE SET
         creator = excluded.creator,
         sig = excluded.sig,
         name = excluded.name,
         symbol = excluded.symbol,
         uri = excluded.uri,
         ts = excluded.ts`
    );
    this.stmt.addLink = this.db.prepare(
      `INSERT INTO creator_links(creator, funder, seen_sig, created_at)
       VALUES(?, ?, ?, ?)
       ON CONFLICT(creator, funder) DO UPDATE SET
         seen_sig = excluded.seen_sig,
         created_at = excluded.created_at`
    );
  }

  private maybeMigrateJson() {
    try {
      const row = this.db.prepare('SELECT COUNT(1) AS c FROM creators').get() as any;
      const empty = !row || Number(row.c) === 0;
      if (!empty) return;
      if (!fs.existsSync(jsonStore)) return;
      const raw = JSON.parse(fs.readFileSync(jsonStore, 'utf8')) || {};
      const creators = raw.creators || {};
      const mints = raw.mints || {};
      const known = raw.knownCreators || {};
      const links = raw.creatorLinks || {};
      const now = Math.floor(Date.now() / 1000);
      const tx = this.db.transaction(() => {
        for (const id of Object.keys(known)) {
          const k = known[id];
          this.stmt.seedKnown!.run(id, k?.reason || 'json-import', k?.createdAt || now);
        }
        for (const id of Object.keys(creators)) {
          const c = creators[id];
          this.stmt.upsertCreator!.run({ id, firstSig: c?.firstSig || '', updatedAt: c?.updatedAt || now });
        }
        for (const mint of Object.keys(mints)) {
          const m = mints[mint];
          this.stmt.addMint!.run({
            mint,
            creator: m?.creator || '',
            sig: m?.sig || '',
            name: m?.name || '',
            symbol: m?.symbol || '',
            uri: m?.uri || '',
            ts: m?.ts || now,
          });
        }
        for (const creator of Object.keys(links)) {
          const mm = links[creator] || {};
          for (const funder of Object.keys(mm)) {
            const l = mm[funder];
            this.stmt.addLink!.run(creator, funder, l?.seenSig || '', l?.createdAt || now);
          }
        }
      });
      tx();
      logger.info('Migrated JSON store to SQLite', { creators: Object.keys(creators).length, mints: Object.keys(mints).length });
    } catch (e) {
      logger.warn('JSON->SQLite migration skipped', { err: String(e) });
    }
  }

  seedKnownCreators(ids: string[], reason = 'seed') {
    const now = Math.floor(Date.now() / 1000);
    const tx = this.db.transaction((arr: string[]) => {
      for (const id of arr) {
        if (!id) continue;
        this.stmt.seedKnown!.run(id, reason, now);
      }
    });
    tx(ids);
  }
  isKnownCreator(id: string): boolean {
    const r = this.stmt.isKnown!.get(id) as any;
    return Boolean(r);
  }
  hasCreator(id: string): boolean {
    const r = this.stmt.hasCreator!.get(id) as any;
    return Boolean(r);
  }
  upsertCreatorOnCreate(id: string, sig: string) {
    const now = Math.floor(Date.now() / 1000);
    this.stmt.upsertCreator!.run({ id, firstSig: sig, updatedAt: now });
  }
  addMint(m: MintRecord) {
    this.stmt.addMint!.run(m);
  }
  addCreatorLink(creator: string, funder: string, seenSig: string) {
    const now = Math.floor(Date.now() / 1000);
    this.stmt.addLink!.run(creator, funder, seenSig, now);
  }
}

let storeImpl: any;
if (BetterSqlite3) {
  storeImpl = new SqlStore();
} else {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const json = require('./store');
  storeImpl = json.store;
}

export const store = storeImpl as {
  seedKnownCreators(ids: string[], reason?: string): void;
  isKnownCreator(id: string): boolean;
  hasCreator(id: string): boolean;
  upsertCreatorOnCreate(id: string, sig: string): void;
  addMint(m: MintRecord): void;
  addCreatorLink(creator: string, funder: string, seenSig: string): void;
};
export default store;

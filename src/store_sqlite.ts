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
    CREATE TABLE IF NOT EXISTS known_creators (
      id TEXT PRIMARY KEY,
      reason TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS creator_funders (
      creator TEXT NOT NULL,
      funder TEXT NOT NULL,
      seen_sig TEXT,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (creator, funder)
    );
    CREATE INDEX IF NOT EXISTS idx_creator_funders_funder ON creator_funders(funder);
  `);
  // Drop legacy/unused tables if present
  try { db.exec('DROP TABLE IF EXISTS mints; DROP TABLE IF EXISTS creator_links;'); } catch {}
  return db;
}

class SqlStore {
  private db: any;
  private stmt = {
    seedKnown: null as any,
    isKnown: null as any,
    hasCreator: null as any,
    upsertCreator: null as any,
    addFunder: null as any,
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
    this.stmt.addFunder = this.db.prepare(
      `INSERT INTO creator_funders(creator, funder, seen_sig, created_at)
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
        // Ignoring legacy mints; migrate creator_links -> creator_funders for clarity
        for (const creator of Object.keys(links)) {
          const mm = links[creator] || {};
          for (const funder of Object.keys(mm)) {
            const l = mm[funder];
            this.stmt.addFunder!.run(creator, funder, l?.seenSig || '', l?.createdAt || now);
          }
        }
      });
      tx();
      logger.info('Migrated JSON store to SQLite', { creators: Object.keys(creators).length, funders: Object.keys(links).length });
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
  addCreatorFunder(creator: string, funder: string, seenSig: string) {
    const now = Math.floor(Date.now() / 1000);
    this.stmt.addFunder!.run(creator, funder, seenSig, now);
  }
}

function makeJsonAdapter() {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const json = require('./store');
  const s = json.store;
  return {
    seedKnownCreators: (ids: string[], reason?: string) => s.seedKnownCreators(ids, reason),
    isKnownCreator: (id: string) => s.isKnownCreator(id),
    hasCreator: (id: string) => s.hasCreator(id),
    upsertCreatorOnCreate: (id: string, sig: string) => s.upsertCreatorOnCreate(id, sig),
    addCreatorFunder: (creator: string, funder: string, seenSig: string) => s.addCreatorLink(creator, funder, seenSig),
  };
}

let storeImpl: any;
if (BetterSqlite3) {
  try {
    storeImpl = new SqlStore();
  } catch (e) {
    logger.warn('better-sqlite3 init failed; using JSON store fallback', { err: (e as any)?.message || String(e) });
    storeImpl = makeJsonAdapter();
  }
} else {
  storeImpl = makeJsonAdapter();
}

export const store = storeImpl as {
  seedKnownCreators(ids: string[], reason?: string): void;
  isKnownCreator(id: string): boolean;
  hasCreator(id: string): boolean;
  upsertCreatorOnCreate(id: string, sig: string): void;
  addCreatorFunder(creator: string, funder: string, seenSig: string): void;
};
export default store;

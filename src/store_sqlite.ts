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
    -- Simulation / paper trading tables (legacy)
    CREATE TABLE IF NOT EXISTS sim_positions (
      mint TEXT PRIMARY KEY,
      opened_at INTEGER NOT NULL,
      opened_sig TEXT,
      tokens TEXT NOT NULL,
      cost_lamports TEXT NOT NULL,
      name TEXT,
      symbol TEXT,
      uri TEXT,
      closed_at INTEGER,
      close_reason TEXT,
      proceeds_lamports TEXT,
      pnl_lamports TEXT,
      pnl_pct REAL
    );
    -- Launch intelligence table (legacy)
    CREATE TABLE IF NOT EXISTS launches (
      mint TEXT PRIMARY KEY,
      creator TEXT NOT NULL,
      first_sig TEXT,
      created_at INTEGER NOT NULL,
      name TEXT,
      symbol TEXT,
      uri TEXT,
      creator_first_time INTEGER,
      creator_creates_count INTEGER,
      creator_initial_buy_lamports TEXT,
      volume_window_seconds INTEGER,
      baseline_vsol_lamports TEXT,
      net_inflow_lamports TEXT,
      gross_volume_lamports TEXT,
      volume_measured_at INTEGER
    );
    -- Unified simulated trade record (preferred)
    CREATE TABLE IF NOT EXISTS sim_trades (
      mint TEXT PRIMARY KEY,
      opened_at INTEGER NOT NULL,
      opened_sig TEXT,
      tokens TEXT NOT NULL,
      cost_lamports TEXT NOT NULL,
      name TEXT,
      symbol TEXT,
      -- close fields
      closed_at INTEGER,
      close_reason TEXT,
      proceeds_lamports TEXT,
      pnl_lamports TEXT,
      pnl_pct REAL,
      -- creator/launch fields
      creator TEXT,
      creator_first_time INTEGER,
      creator_creates_count INTEGER,
      creator_initial_buy_lamports TEXT,
      -- early activity proxy
      volume_window_seconds INTEGER,
      volume_lamports TEXT,
      volume_measured_at INTEGER
    );
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
    getCreator: null as any,
    simOpen: null as any,
    simClose: null as any,
    upsertLaunch: null as any,
    updateLaunchVolume: null as any,
    tradeOpen: null as any,
    tradeClose: null as any,
    tradeUpsertLaunch: null as any,
    tradeUpdateVolume: null as any,
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
    this.stmt.getCreator = this.db.prepare(`SELECT id, first_sig as firstSig, creates, updated_at as updatedAt FROM creators WHERE id = ? LIMIT 1`);
    this.stmt.simOpen = this.db.prepare(
      `INSERT INTO sim_positions(
         mint, opened_at, opened_sig, tokens, cost_lamports, name, symbol, uri
       ) VALUES(
         @mint, @openedAt, @openedSig, @tokens, @costLamports, @name, @symbol, @uri
       )
       ON CONFLICT(mint) DO UPDATE SET
         opened_at = excluded.opened_at,
         opened_sig = excluded.opened_sig,
         tokens = excluded.tokens,
         cost_lamports = excluded.cost_lamports,
         name = excluded.name,
         symbol = excluded.symbol,
         uri = excluded.uri`
    );
    this.stmt.simClose = this.db.prepare(
      `UPDATE sim_positions SET
         closed_at = @closedAt,
         close_reason = @closeReason,
         proceeds_lamports = @proceedsLamports,
         pnl_lamports = @pnlLamports,
         pnl_pct = @pnlPct
       WHERE mint = @mint`
    );
    this.stmt.upsertLaunch = this.db.prepare(
      `INSERT INTO launches(
         mint, creator, first_sig, created_at, name, symbol, uri,
         creator_first_time, creator_creates_count, creator_initial_buy_lamports,
         volume_window_seconds, baseline_vsol_lamports
       ) VALUES (
         @mint, @creator, @firstSig, @createdAt, @name, @symbol, @uri,
         @creatorFirstTime, @creatorCreatesCount, @creatorInitialBuyLamports,
         @volumeWindowSeconds, @baselineVsolLamports
       )
       ON CONFLICT(mint) DO UPDATE SET
         creator = excluded.creator,
         first_sig = excluded.first_sig,
         created_at = excluded.created_at,
         name = excluded.name,
         symbol = excluded.symbol,
         uri = excluded.uri,
         creator_first_time = excluded.creator_first_time,
         creator_creates_count = excluded.creator_creates_count,
         creator_initial_buy_lamports = excluded.creator_initial_buy_lamports,
         volume_window_seconds = excluded.volume_window_seconds,
         baseline_vsol_lamports = excluded.baseline_vsol_lamports`
    );
    this.stmt.updateLaunchVolume = this.db.prepare(
      `UPDATE launches SET
         net_inflow_lamports = COALESCE(@netInflowLamports, net_inflow_lamports),
         gross_volume_lamports = COALESCE(@grossVolumeLamports, gross_volume_lamports),
         volume_measured_at = @measuredAt
       WHERE mint = @mint`
    );
    // Unified table statements
    this.stmt.tradeOpen = this.db.prepare(
      `INSERT INTO sim_trades(
         mint, opened_at, opened_sig, tokens, cost_lamports, name, symbol
       ) VALUES (
         @mint, @openedAt, @openedSig, @tokens, @costLamports, @name, @symbol
       )
       ON CONFLICT(mint) DO UPDATE SET
         opened_at = excluded.opened_at,
         opened_sig = excluded.opened_sig,
         tokens = excluded.tokens,
         cost_lamports = excluded.cost_lamports,
         name = excluded.name,
         symbol = excluded.symbol`
    );
    this.stmt.tradeClose = this.db.prepare(
      `UPDATE sim_trades SET
         closed_at = @closedAt,
         close_reason = @closeReason,
         proceeds_lamports = @proceedsLamports,
         pnl_lamports = @pnlLamports,
         pnl_pct = @pnlPct
       WHERE mint = @mint`
    );
    this.stmt.tradeUpsertLaunch = this.db.prepare(
      `UPDATE sim_trades SET
         creator = @creator,
         creator_first_time = @creatorFirstTime,
         creator_creates_count = @creatorCreatesCount,
         creator_initial_buy_lamports = @creatorInitialBuyLamports,
         volume_window_seconds = @volumeWindowSeconds
       WHERE mint = @mint`
    );
    this.stmt.tradeUpdateVolume = this.db.prepare(
      `UPDATE sim_trades SET
         volume_lamports = @volumeLamports,
         volume_measured_at = @measuredAt
       WHERE mint = @mint`
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
  getCreatorCreates(id: string): number {
    const r = this.stmt.getCreator!.get(id) as any;
    return r ? Number(r.creates || 0) : 0;
  }
  upsertCreatorOnCreate(id: string, sig: string) {
    const now = Math.floor(Date.now() / 1000);
    this.stmt.upsertCreator!.run({ id, firstSig: sig, updatedAt: now });
  }
  addCreatorFunder(creator: string, funder: string, seenSig: string) {
    const now = Math.floor(Date.now() / 1000);
    this.stmt.addFunder!.run(creator, funder, seenSig, now);
  }

  simOpenPosition(args: {
    mint: string;
    openedAt: number;
    openedSig?: string;
    tokens: string;
    costLamports: string;
    name?: string;
    symbol?: string;
    uri?: string;
  }) {
    this.stmt.simOpen!.run({
      mint: args.mint,
      openedAt: args.openedAt,
      openedSig: args.openedSig || '',
      tokens: String(args.tokens),
      costLamports: String(args.costLamports),
      name: args.name || null,
      symbol: args.symbol || null,
      uri: args.uri || null,
    });
  }

  simClosePosition(args: {
    mint: string;
    closedAt: number;
    closeReason: string;
    proceedsLamports: string;
    pnlLamports: string;
    pnlPct: number;
  }) {
    this.stmt.simClose!.run({
      mint: args.mint,
      closedAt: args.closedAt,
      closeReason: args.closeReason,
      proceedsLamports: String(args.proceedsLamports),
      pnlLamports: String(args.pnlLamports),
      pnlPct: args.pnlPct,
    });
  }

  upsertLaunch(args: {
    mint: string;
    creator: string;
    firstSig: string;
    createdAt: number;
    name?: string;
    symbol?: string;
    uri?: string;
    creatorFirstTime: boolean;
    creatorCreatesCount: number;
    creatorInitialBuyLamports?: string | null;
    volumeWindowSeconds: number;
    baselineVsolLamports?: string | null;
  }) {
    this.stmt.upsertLaunch!.run({
      mint: args.mint,
      creator: args.creator,
      firstSig: args.firstSig,
      createdAt: args.createdAt,
      name: args.name || null,
      symbol: args.symbol || null,
      uri: args.uri || null,
      creatorFirstTime: args.creatorFirstTime ? 1 : 0,
      creatorCreatesCount: args.creatorCreatesCount,
      creatorInitialBuyLamports: args.creatorInitialBuyLamports ?? null,
      volumeWindowSeconds: args.volumeWindowSeconds,
      baselineVsolLamports: args.baselineVsolLamports ?? null,
    });
  }

  updateLaunchVolume(args: {
    mint: string;
    measuredAt: number;
    netInflowLamports?: string | null;
    grossVolumeLamports?: string | null;
  }) {
    this.stmt.updateLaunchVolume!.run({
      mint: args.mint,
      measuredAt: args.measuredAt,
      netInflowLamports: args.netInflowLamports ?? null,
      grossVolumeLamports: args.grossVolumeLamports ?? null,
    });
  }

  // Unified: open/update base trade fields on sim open
  simTradeOpen(args: {
    mint: string;
    openedAt: number;
    openedSig?: string;
    tokens: string;
    costLamports: string;
    name?: string;
    symbol?: string;
  }) {
    this.stmt.tradeOpen!.run({
      mint: args.mint,
      openedAt: args.openedAt,
      openedSig: args.openedSig || '',
      tokens: String(args.tokens),
      costLamports: String(args.costLamports),
      name: args.name || null,
      symbol: args.symbol || null,
    });
  }

  // Unified: close trade with pnl
  simTradeClose(args: {
    mint: string;
    closedAt: number;
    closeReason: string;
    proceedsLamports: string;
    pnlLamports: string;
    pnlPct: number;
  }) {
    this.stmt.tradeClose!.run({
      mint: args.mint,
      closedAt: args.closedAt,
      closeReason: args.closeReason,
      proceedsLamports: String(args.proceedsLamports),
      pnlLamports: String(args.pnlLamports),
      pnlPct: args.pnlPct,
    });
  }

  // Unified: attach creator/launch metadata (call at launch time)
  upsertTradeLaunch(args: {
    mint: string;
    creator: string;
    creatorFirstTime: boolean;
    creatorCreatesCount: number;
    creatorInitialBuyLamports?: string | null;
    volumeWindowSeconds: number;
  }) {
    this.stmt.tradeUpsertLaunch!.run({
      mint: args.mint,
      creator: args.creator,
      creatorFirstTime: args.creatorFirstTime ? 1 : 0,
      creatorCreatesCount: args.creatorCreatesCount,
      creatorInitialBuyLamports: args.creatorInitialBuyLamports ?? null,
      volumeWindowSeconds: args.volumeWindowSeconds,
    });
  }

  // Unified: update volume proxy
  updateTradeVolume(args: {
    mint: string;
    measuredAt: number;
    volumeLamports?: string | null;
  }) {
    this.stmt.tradeUpdateVolume!.run({
      mint: args.mint,
      measuredAt: args.measuredAt,
      volumeLamports: args.volumeLamports ?? null,
    });
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
    // JSON adapter does not persist sim/launch metrics; no-op to keep behavior safe
    simOpenPosition: (_args: any) => { try { logger.debug('simOpenPosition (json-adapter noop)'); } catch {} },
    simClosePosition: (_args: any) => { try { logger.debug('simClosePosition (json-adapter noop)'); } catch {} },
    upsertLaunch: (_args: any) => { try { logger.debug('upsertLaunch (json-adapter noop)'); } catch {} },
    updateLaunchVolume: (_args: any) => { try { logger.debug('updateLaunchVolume (json-adapter noop)'); } catch {} },
    simTradeOpen: (_args: any) => { try { logger.debug('simTradeOpen (json-adapter noop)'); } catch {} },
    simTradeClose: (_args: any) => { try { logger.debug('simTradeClose (json-adapter noop)'); } catch {} },
    upsertTradeLaunch: (_args: any) => { try { logger.debug('upsertTradeLaunch (json-adapter noop)'); } catch {} },
    updateTradeVolume: (_args: any) => { try { logger.debug('updateTradeVolume (json-adapter noop)'); } catch {} },
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
  getCreatorCreates(id: string): number;
  simOpenPosition(args: {
    mint: string;
    openedAt: number;
    openedSig?: string;
    tokens: string;
    costLamports: string;
    name?: string;
    symbol?: string;
    uri?: string;
  }): void;
  simClosePosition(args: {
    mint: string;
    closedAt: number;
    closeReason: string;
    proceedsLamports: string;
    pnlLamports: string;
    pnlPct: number;
  }): void;
  simTradeOpen(args: {
    mint: string;
    openedAt: number;
    openedSig?: string;
    tokens: string;
    costLamports: string;
    name?: string;
    symbol?: string;
  }): void;
  simTradeClose(args: {
    mint: string;
    closedAt: number;
    closeReason: string;
    proceedsLamports: string;
    pnlLamports: string;
    pnlPct: number;
  }): void;
  upsertLaunch(args: {
    mint: string;
    creator: string;
    firstSig: string;
    createdAt: number;
    name?: string;
    symbol?: string;
    uri?: string;
    creatorFirstTime: boolean;
    creatorCreatesCount: number;
    creatorInitialBuyLamports?: string | null;
    volumeWindowSeconds: number;
    baselineVsolLamports?: string | null;
  }): void;
  updateLaunchVolume(args: {
    mint: string;
    measuredAt: number;
    netInflowLamports?: string | null;
    grossVolumeLamports?: string | null;
  }): void;
  upsertTradeLaunch(args: {
    mint: string;
    creator: string;
    creatorFirstTime: boolean;
    creatorCreatesCount: number;
    creatorInitialBuyLamports?: string | null;
    volumeWindowSeconds: number;
  }): void;
  updateTradeVolume(args: {
    mint: string;
    measuredAt: number;
    volumeLamports?: string | null;
  }): void;
};
export default store;

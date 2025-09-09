/*
  Paper-trading analytics: summarizes sim_positions and joins with launches.
  Usage: npm run analytics
*/
import path from 'path';

function fmtPct(x: number): string {
  const sign = x > 0 ? '+' : '';
  return `${sign}${(x * 100).toFixed(2)}%`;
}

function toNumberSafe(x: any, divisor = 1): number {
  if (x === null || x === undefined) return 0;
  const n = Number(x);
  if (!isFinite(n)) return 0;
  return n / divisor;
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const arr: number[] = [...values].sort((a: number, b: number) => a - b);
  const mid = Math.floor(arr.length / 2);
  return arr.length % 2 ? arr[mid]! : ((arr[mid - 1]! + arr[mid]!) / 2);
}

async function main() {
  let Database: any;
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    Database = require('better-sqlite3');
  } catch (e) {
    console.error('better-sqlite3 not available. Install/rebuild it to use analytics.');
    console.error('Try: rm -rf node_modules package-lock.json && npm i && npm rebuild better-sqlite3 --build-from-source');
    process.exit(1);
  }
  const dbPath = path.join(process.cwd(), 'data', 'app.db');
  const db = new Database(dbPath, { readonly: true });

  // Ensure tables exist
  const hasTrades = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='sim_trades'").get();
  const hasSim = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='sim_positions'").get();
  const hasLaunches = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='launches'").get();

  // Pull closed trades
  let rows: any[] = [];
  if (hasTrades) {
    rows = db.prepare(`
      SELECT mint,
             opened_at AS openedAt,
             closed_at AS closedAt,
             pnl_pct AS pnlPct,
             pnl_lamports AS pnlLamports,
             proceeds_lamports AS proceedsLamports,
             cost_lamports AS costLamports,
             creator,
             creator_first_time AS creatorFirstTime,
             creator_creates_count AS creatorCreatesCount,
             name,
             symbol,
             volume_lamports AS netInflowLamports
      FROM sim_trades
      WHERE closed_at IS NOT NULL
    `).all();
  } else if (hasSim) {
    rows = db.prepare(`
      SELECT sp.mint,
             sp.opened_at AS openedAt,
             sp.closed_at AS closedAt,
             sp.pnl_pct AS pnlPct,
             sp.pnl_lamports AS pnlLamports,
             sp.proceeds_lamports AS proceedsLamports,
             sp.cost_lamports AS costLamports,
             l.creator AS creator,
             l.creator_first_time AS creatorFirstTime,
             l.creator_creates_count AS creatorCreatesCount,
             l.name AS name,
             l.symbol AS symbol,
             l.net_inflow_lamports AS netInflowLamports
      FROM sim_positions sp
      LEFT JOIN launches l ON l.mint = sp.mint
      WHERE sp.closed_at IS NOT NULL
    `).all();
  } else {
    console.log('No sim_trades or legacy tables found. Run the bot with SQLite enabled (better-sqlite3).');
    process.exit(0);
  }

  if (!rows || rows.length === 0) {
    console.log('No closed simulated trades found. Let the bot run longer or loosen thresholds.');
    process.exit(0);
  }

  // Aggregate
  const total = rows.length;
  const pnls = rows.map((r: any) => Number(r.pnlPct));
  const hits = rows.filter((r: any) => Number(r.pnlPct) > 0).length;
  const avg = pnls.reduce((a: number, b: number) => a + b, 0) / Math.max(1, pnls.length);
  const med = median(pnls);
  const holdTimes = rows.map((r: any) => (Number(r.closedAt) - Number(r.openedAt)) || 0);
  const avgHoldSec = holdTimes.reduce((a: number, b: number) => a + b, 0) / Math.max(1, holdTimes.length);

  console.log('=== Simulation Summary ===');
  console.log(`Closed trades: ${total}`);
  console.log(`Hit rate: ${(hits / total * 100).toFixed(2)}%`);
  console.log(`Avg PnL: ${fmtPct(avg)}`);
  console.log(`Med PnL: ${fmtPct(med)}`);
  console.log(`Avg hold: ${avgHoldSec.toFixed(1)}s`);

  // Sort top/worst
  const sorted = [...rows].sort((a, b) => Number(b.pnlPct) - Number(a.pnlPct));
  const top = sorted.slice(0, 10);
  const bottom = sorted.slice(-10);

  console.log('\n=== Top 10 ===');
  for (const r of top) {
    const line = [
      r.mint,
      r.symbol || '',
      fmtPct(Number(r.pnlPct)),
      r.creator ? `creator:${r.creator}` : '',
      r.creatorFirstTime != null ? (Number(r.creatorFirstTime) ? 'first' : 'repeat') : '',
    ].filter(Boolean).join(' | ');
    console.log(line);
  }

  console.log('\n=== Worst 10 ===');
  for (const r of bottom) {
    const line = [
      r.mint,
      r.symbol || '',
      fmtPct(Number(r.pnlPct)),
      r.creator ? `creator:${r.creator}` : '',
      r.creatorFirstTime != null ? (Number(r.creatorFirstTime) ? 'first' : 'repeat') : '',
    ].filter(Boolean).join(' | ');
    console.log(line);
  }

  // Creator performance (min 2 closed trades)
  const byCreator = new Map<string, { n: number; sum: number }>();
  for (const r of rows) {
    const c = r.creator as string | null;
    if (!c) continue;
    const cur = byCreator.get(c) || { n: 0, sum: 0 };
    cur.n += 1;
    cur.sum += Number(r.pnlPct);
    byCreator.set(c, cur);
  }
  const creatorStats = [...byCreator.entries()]
    .filter(([, v]) => v.n >= 2)
    .map(([creator, v]) => ({ creator, n: v.n, avg: v.sum / v.n }))
    .sort((a, b) => b.avg - a.avg)
    .slice(0, 10);

  console.log('\n=== Top Creators (avg PnL, >=2 closed) ===');
  for (const c of creatorStats) {
    console.log(`${c.creator} | trades:${c.n} | avg:${fmtPct(c.avg)}`);
  }

  // Optional: early net inflow correlation (bucketed)
  if (hasLaunches) {
    const pairs = rows
      .map((r: any) => ({
        inflow: toNumberSafe(r.netInflowLamports, 1e9), // SOL
        pnl: Number(r.pnlPct),
      }))
      .filter((p: any) => isFinite(p.inflow) && isFinite(p.pnl));
    if (pairs.length >= 5) {
      const topInflow = [...pairs].sort((a, b) => b.inflow - a.inflow).slice(0, Math.max(5, Math.floor(pairs.length * 0.1)));
      const lowInflow = [...pairs].sort((a, b) => a.inflow - b.inflow).slice(0, Math.max(5, Math.floor(pairs.length * 0.1)));
      const avgTop = topInflow.reduce((a: number, b: { pnl: number }) => a + b.pnl, 0) / topInflow.length;
      const avgLow = lowInflow.reduce((a: number, b: { pnl: number }) => a + b.pnl, 0) / lowInflow.length;
      console.log(`\nEarly inflow (15s) vs PnL:`);
      console.log(`Top inflow avg PnL: ${fmtPct(avgTop)}`);
      console.log(`Low inflow avg PnL: ${fmtPct(avgLow)}`);
    }
  }
}

main().catch((e) => {
  console.error('Analytics failed:', e?.stack || e);
  process.exit(1);
});

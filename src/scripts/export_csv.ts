/*
  Export sim_trades to CSV.
  Usage:
    npm run export:csv                # writes to data/sim_trades.csv
    npm run export:csv -- --out path  # custom output path
*/
import fs from 'fs';
import path from 'path';

function escapeCsv(val: any): string {
  if (val === null || val === undefined) return '';
  const s = String(val);
  if (/[",\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}

async function main() {
  let Database: any;
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    Database = require('better-sqlite3');
  } catch (e) {
    console.error('better-sqlite3 not available. Install/rebuild it to export CSV.');
    console.error('Try: rm -rf node_modules package-lock.json && npm i && npm rebuild better-sqlite3 --build-from-source');
    process.exit(1);
  }

  const outArgIdx = process.argv.indexOf('--out');
  let outPath: string;
  if (outArgIdx >= 0 && process.argv[outArgIdx + 1]) {
    outPath = String(process.argv[outArgIdx + 1]);
  } else {
    outPath = path.join(process.cwd(), 'data', 'sim_trades.csv');
  }

  const dbPath = path.join(process.cwd(), 'data', 'app.db');
  const db = new Database(dbPath, { readonly: true });
  const hasTrades = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='sim_trades'").get();
  if (!hasTrades) {
    console.log('No sim_trades table found in data/app.db.');
    process.exit(0);
  }

  const cols = [
    'mint',
    'opened_at',
    'opened_sig',
    'tokens',
    'cost_lamports',
    'name',
    'symbol',
    'closed_at',
    'close_reason',
    'proceeds_lamports',
    'pnl_lamports',
    'pnl_pct',
    'creator',
    'creator_first_time',
    'creator_creates_count',
    'creator_initial_buy_lamports',
    'volume_window_seconds',
    'volume_lamports',
    'volume_measured_at',
  ];

  const rows = db.prepare(`SELECT ${cols.join(', ')} FROM sim_trades`).all();

  let csv = cols.join(',') + '\n';
  for (const r of rows) {
    const line = cols.map((c) => escapeCsv((r as any)[c])).join(',');
    csv += line + '\n';
  }

  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, csv);
  console.log(`Exported ${rows.length} rows to ${outPath}`);
}

main().catch((e) => {
  console.error('Export failed:', e?.stack || e);
  process.exit(1);
});

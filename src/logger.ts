import fs from 'fs';

type LogLevel = 'info' | 'warn' | 'error' | 'debug';

const logFile = process.env.LOG_FILE || 'bot.log.json';
const stream = fs.createWriteStream(logFile, { flags: 'a' });

function jsonReplacer(_key: string, value: any) {
  if (typeof value === 'bigint') return value.toString();
  return value;
}

function write(level: LogLevel, msg: string, meta?: Record<string, any>) {
  const entry = {
    ts: new Date().toISOString(),
    level,
    msg,
    ...meta,
  };
  try {
    stream.write(JSON.stringify(entry, jsonReplacer) + '\n');
  } catch (e) {
    // Fallback: stringify shallow copy with BigInt coerced
    const safe: Record<string, any> = {};
    for (const [k, v] of Object.entries(entry)) {
      // eslint-disable-next-line valid-typeof
      safe[k] = typeof v === 'bigint' ? String(v) : v;
    }
    stream.write(JSON.stringify(safe) + '\n');
  }
  const line = `[${entry.ts}] ${level.toUpperCase()}: ${msg}`;
  // Keep console clean but informative
  if (level === 'error') console.error(line, meta || '');
  else if (level === 'warn') console.warn(line, meta || '');
  else console.log(line, meta || '');
}

export const logger = {
  info: (msg: string, meta?: Record<string, any>) => write('info', msg, meta),
  warn: (msg: string, meta?: Record<string, any>) => write('warn', msg, meta),
  error: (msg: string, meta?: Record<string, any>) => write('error', msg, meta),
  debug: (msg: string, meta?: Record<string, any>) => write('debug', msg, meta),
};

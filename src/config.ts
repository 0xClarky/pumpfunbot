import dotenv from 'dotenv';
import bs58 from 'bs58';

dotenv.config();

export type Config = {
  heliusApiKey: string;
  heliusRpcUrl: string; // HTTP
  heliusWsUrl: string;  // WS
  privateKey: Uint8Array; // Secret key bytes
  maxSlippageBps: number; // e.g., 1000 = 10%
  tpPct: number; // +35 => 0.35
  slPct: number; // -20 => -0.20
  priorityFeeSol: number; // e.g., 0.01 SOL
  skipPreflight: boolean;
  detectionMode: 'auto' | 'ws' | 'poll';
  pollIntervalMs: number;
  trackerEnabled: boolean;
  sellEnabled: boolean;
  minHoldMs: number; // grace period after buy before sell checks
  trailingSlBps: number; // e.g., 3000 = 30%
  sellStrategy: 'fixed' | 'trailing';
  // Discovery/sniper flags
  discoveryOnchain: boolean; // enable WS create detector
};

function parsePrivateKey(input?: string): Uint8Array {
  if (!input) throw new Error('Missing SOLANA_PRIVATE_KEY');
  const trimmed = input.trim();
  // Accept JSON array (solana-keygen) or base64 or base58
  try {
    if (trimmed.startsWith('[')) {
      const arr = JSON.parse(trimmed) as number[];
      return Uint8Array.from(arr);
    }
  } catch {}
  // Base58 first (most common for provided key strings)
  try {
    const b58 = bs58.decode(trimmed);
    if (b58.length > 0) return new Uint8Array(b58);
  } catch {}
  // Base64 as fallback
  try {
    // Validate by round-trip encoding to avoid accidental decode of non-base64
    const decoded = Buffer.from(trimmed, 'base64');
    if (decoded.length > 0 && Buffer.from(decoded).toString('base64').replace(/=+$/,'') === trimmed.replace(/=+$/,'')) {
      return new Uint8Array(decoded);
    }
  } catch {}
  throw new Error('SOLANA_PRIVATE_KEY must be JSON array, base64, or base58');
}

export const config: Config = {
  heliusApiKey: process.env.HELIUS_API_KEY || '',
  heliusRpcUrl:
    process.env.HELIUS_RPC_URL ||
    (process.env.HELIUS_API_KEY
      ? `https://mainnet.helius-rpc.com/?api-key=${process.env.HELIUS_API_KEY}`
      : ''),
  heliusWsUrl:
    process.env.HELIUS_WS_URL ||
    (process.env.HELIUS_API_KEY
      ? `wss://rpc.helius.xyz/?api-key=${process.env.HELIUS_API_KEY}`
      : ''),
  privateKey: parsePrivateKey(process.env.SOLANA_PRIVATE_KEY),
  maxSlippageBps: Number(process.env.MAX_SLIPPAGE_BPS || 1000),
  tpPct: Number(process.env.TP_PCT || 0.35),
  slPct: Number(process.env.SL_PCT || -0.2),
  priorityFeeSol: Number(process.env.PRIORITY_FEE_SOL || 0.01),
  skipPreflight: (process.env.SKIP_PREFLIGHT || 'true').toLowerCase() === 'true',
  detectionMode: ((process.env.DETECTION_MODE || 'auto') as any),
  pollIntervalMs: Number(process.env.POLL_INTERVAL_MS || 1000),
  trackerEnabled: (process.env.TRACKER_ENABLED || 'true').toLowerCase() === 'true',
  sellEnabled: (process.env.SELL_ENABLED || 'true').toLowerCase() === 'true',
  minHoldMs: Number(process.env.MIN_HOLD_MS || 2000),
  trailingSlBps: Number(process.env.TRAILING_SL_BPS || 3000),
  sellStrategy: ((process.env.SELL_STRATEGY || 'fixed') as 'fixed' | 'trailing'),
  discoveryOnchain: (process.env.DISCOVERY_ONCHAIN || 'false').toLowerCase() === 'true',
};

export function validateConfig(cfg: Config) {
  const errs: string[] = [];
  if (!cfg.heliusRpcUrl) errs.push('HELIUS_RPC_URL or HELIUS_API_KEY required');
  if (!cfg.heliusWsUrl) errs.push('HELIUS_WS_URL or HELIUS_API_KEY required');
  if (!cfg.privateKey?.length) errs.push('SOLANA_PRIVATE_KEY required');
  if (cfg.maxSlippageBps <= 0 || cfg.maxSlippageBps > 5000)
    errs.push('MAX_SLIPPAGE_BPS must be between 1 and 5000');
  if (cfg.tpPct <= 0) errs.push('TP_PCT must be > 0, e.g., 0.35');
  if (cfg.slPct >= 0) errs.push('SL_PCT must be < 0, e.g., -0.2');
  if (errs.length) throw new Error('Config error: ' + errs.join('; '));
}

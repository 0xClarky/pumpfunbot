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
  detectionEnabled: boolean;
  pollIntervalMs: number;
  trackerEnabled: boolean;
  sellEnabled: boolean;
  minHoldMs: number; // grace period after buy before sell checks
  trailingSlBps: number; // e.g., 3000 = 30%
  sellStrategy: 'fixed' | 'trailing';
  // Discovery/sniper flags
  discoveryOnchain: boolean; // enable WS create detector
  // Launch intel and filtering
  metadataTimeoutMs: number;
  filterAsciiOnly: boolean;
  filterRequireImage: boolean;
  filterRequireSocial: boolean; // require at least one of twitter/telegram/website
  nameMin: number;
  nameMax: number;
  symbolMin: number;
  symbolMax: number;
  blacklistCreators: string[];
  whitelistCreators: string[];
  blacklistWords: string[];
  // Sniper gating
  requireImage: boolean;
  requireTwitterHandleMatch: boolean;
  requireTwitterPresent: boolean;
  requireDescription: boolean;
  creatorMaxInitialBuySol: number; // reject if creator initial buy > this (SOL)
  creatorRequireFirstTime: boolean; // reject if creator exists in local DB
  creatorFunderBlacklistCheck: boolean; // 1-hop funder check against known creators
  httpHeadTimeoutMs: number; // image HEAD timeout
  lineageTimeoutMs: number; // funder lookup timeout
  funderSigLimit: number; // how many signatures to scan for funder
  // Image probe settings
  imageValidationMode: 'head' | 'probe';
  imageProbeTimeoutMs: number;
  imageProbeMaxBytes: number;
  imageGateways: string[];
  // Auto-buy + Jito/Helius Sender
  autoBuyEnabled: boolean;
  buySol: number; // SOL amount per buy
  minCreateMs: number; // wait at least this after create before buying
  maxCreateAgeMs: number; // do not buy if older than this
  minBuyGapMs: number; // cooldown between buys
  maxQuoteDriftBps: number; // allowed drift between quote and final
  jitoEnabled: boolean;
  jitoTipSol: number;
  jitoTipAccount?: string | undefined;
  jitoTipAccounts: string[]; // optional list; pick randomly if provided
  jitoBlockEngine: string; // e.g., ny.block-engine.jito.wtf:443
  jitoDeadlineMs: number; // bundle wait deadline
  jitoJsonRpcUrl?: string | undefined; // JSON-RPC sendBundle endpoint
  jitoUuid?: string | undefined; // optional x-jito-auth UUID
  heliusSenderUrl?: string | undefined; // if not set, fall back to heliusRpcUrl
  senderCommitment: 'processed' | 'confirmed';
  senderWaitMs: number;
  // Simulation / paper-trading
  simulationEnabled: boolean;
  // Simulation safety exits
  simHardSlEnabled: boolean; // enable fixed SL fallback even in trailing
  simTtlMs: number; // time-based exit; 0 disables
  simFlatSecs: number; // flat window seconds; 0 disables
  simFlatBps: number; // bps change considered "flat"; 0 disables
  simNoFlowSol: number; // close if 15s net inflow <= threshold (SOL); 0 disables
  simBaseTxLamports: number; // approximate base tx fee per leg (lamports)
  // Launch metrics
  launchMetricsEnabled: boolean;
  volumeWindowSeconds: number; // e.g., 15
  volumeMode: 'net' | 'scan';
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
  // Primary RPC/WS should use ERPC (or explicit HELIUS_* URLs if you set them)
  heliusRpcUrl:
    process.env.HELIUS_RPC_URL ||
    process.env.ERPC_RPC_URL ||
    '',
  heliusWsUrl:
    process.env.HELIUS_WS_URL ||
    process.env.ERPC_WS_URL ||
    '',
  privateKey: parsePrivateKey(process.env.SOLANA_PRIVATE_KEY),
  maxSlippageBps: Number(process.env.MAX_SLIPPAGE_BPS || 1000),
  tpPct: Number(process.env.TP_PCT || 0.35),
  slPct: Number(process.env.SL_PCT || -0.2),
  priorityFeeSol: Number(process.env.PRIORITY_FEE_SOL || 0.01),
  skipPreflight: (process.env.SKIP_PREFLIGHT || 'true').toLowerCase() === 'true',
  detectionMode: ((process.env.DETECTION_MODE || 'auto') as any),
  detectionEnabled: (process.env.DETECTION_ENABLED || 'true').toLowerCase() === 'true',
  pollIntervalMs: Number(process.env.POLL_INTERVAL_MS || 1000),
  trackerEnabled: (process.env.TRACKER_ENABLED || 'true').toLowerCase() === 'true',
  sellEnabled: (process.env.SELL_ENABLED || 'true').toLowerCase() === 'true',
  minHoldMs: Number(process.env.MIN_HOLD_MS || 2000),
  trailingSlBps: Number(process.env.TRAILING_SL_BPS || 3000),
  sellStrategy: ((process.env.SELL_STRATEGY || 'fixed') as 'fixed' | 'trailing'),
  discoveryOnchain: (process.env.DISCOVERY_ONCHAIN || 'false').toLowerCase() === 'true',
  metadataTimeoutMs: Number(process.env.METADATA_TIMEOUT_MS || 2500),
  filterAsciiOnly: (process.env.FILTER_ASCII_ONLY || 'true').toLowerCase() === 'true',
  filterRequireImage: (process.env.FILTER_REQUIRE_IMAGE || 'false').toLowerCase() === 'true',
  filterRequireSocial: (process.env.FILTER_REQUIRE_SOCIAL || 'false').toLowerCase() === 'true',
  nameMin: Number(process.env.NAME_MIN || 1),
  nameMax: Number(process.env.NAME_MAX || 32),
  symbolMin: Number(process.env.SYMBOL_MIN || 1),
  symbolMax: Number(process.env.SYMBOL_MAX || 10),
  blacklistCreators: (process.env.BLACKLIST_CREATORS || '').split(',').map(s=>s.trim()).filter(Boolean),
  whitelistCreators: (process.env.WHITELIST_CREATORS || '').split(',').map(s=>s.trim()).filter(Boolean),
  blacklistWords: (process.env.BLACKLIST_WORDS || '').split(',').map(s=>s.trim().toLowerCase()).filter(Boolean),
  // Sniper gating defaults (conservative)
  requireImage: (process.env.REQUIRE_IMAGE || 'true').toLowerCase() === 'true',
  requireTwitterHandleMatch: (process.env.REQUIRE_TWITTER_HANDLE_MATCH || 'true').toLowerCase() === 'true',
  requireTwitterPresent: (process.env.REQUIRE_TWITTER || 'true').toLowerCase() === 'true',
  requireDescription: (process.env.REQUIRE_DESC || 'false').toLowerCase() === 'true',
  creatorMaxInitialBuySol: Number(process.env.CREATOR_MAX_INITIAL_BUY_SOL || 2),
  creatorRequireFirstTime: (process.env.CREATOR_REQUIRE_FIRST_TIME || 'true').toLowerCase() === 'true',
  creatorFunderBlacklistCheck: (process.env.CREATOR_FUNDER_BLACKLIST_CHECK || 'false').toLowerCase() === 'true',
  httpHeadTimeoutMs: Number(process.env.HTTP_HEAD_TIMEOUT_MS || 400),
  lineageTimeoutMs: Number(process.env.LINEAGE_TIMEOUT_MS || 800),
  funderSigLimit: Number(process.env.FUNDER_SIG_LIMIT || 25),
  imageValidationMode: ((process.env.IMAGE_MODE || 'probe') === 'head' ? 'head' : 'probe'),
  imageProbeTimeoutMs: Number(process.env.IMAGE_PROBE_TIMEOUT_MS || 1000),
  imageProbeMaxBytes: Number(process.env.IMAGE_PROBE_MAX_BYTES || 8192),
  imageGateways: (process.env.IMAGE_GATEWAYS || 'ipfs.io,cloudflare-ipfs.com,metadata.pumplify.eu')
    .split(',').map(s => s.trim()).filter(Boolean),
  autoBuyEnabled: (process.env.AUTO_BUY_ENABLED || 'false').toLowerCase() === 'true',
  buySol: Number(process.env.BUY_SOL || 0.05),
  minCreateMs: Number(process.env.MIN_CREATE_MS || 300),
  maxCreateAgeMs: Number(process.env.MAX_CREATE_AGE_MS || 8000),
  minBuyGapMs: Number(process.env.MIN_BUY_GAP_MS || 1500),
  maxQuoteDriftBps: Number(process.env.MAX_QUOTE_DRIFT_BPS || 100),
  jitoEnabled: (process.env.JITO_ENABLED || 'true').toLowerCase() === 'true',
  jitoTipSol: Number(process.env.JITO_TIP_SOL || 0.001),
  jitoTipAccount: process.env.JITO_TIP_ACCOUNT || undefined,
  jitoTipAccounts: (process.env.JITO_TIP_ACCOUNTS || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean),
  jitoBlockEngine: process.env.JITO_BLOCK_ENGINE || 'ny.block-engine.jito.wtf:443',
  jitoDeadlineMs: Number(process.env.JITO_DEADLINE_MS || 2000),
  jitoJsonRpcUrl: process.env.JITO_JSONRPC_URL || undefined,
  jitoUuid: process.env.JITO_UUID || undefined,
  heliusSenderUrl: process.env.HELIUS_SENDER_URL || undefined,
  senderCommitment: ((process.env.SENDER_COMMITMENT || 'processed') as any),
  senderWaitMs: Number(process.env.SENDER_WAIT_MS || 4000),
  simulationEnabled: ((process.env.SIMULATION_ENABLED || process.env.PAPER_TRADE || 'false').toLowerCase() === 'true'),
  simHardSlEnabled: (process.env.SIM_HARD_SL_ENABLED || 'true').toLowerCase() === 'true',
  simTtlMs: Number(process.env.SIM_TTL_MS || 0),
  simFlatSecs: Number(process.env.SIM_FLAT_SECS || 0),
  simFlatBps: Number(process.env.SIM_FLAT_BPS || 0),
  simNoFlowSol: Number(process.env.SIM_NOFLOW_SOL || 0),
  simBaseTxLamports: Number(process.env.SIM_BASE_TX_LAMPORTS || 5000),
  launchMetricsEnabled: (process.env.LAUNCH_METRICS_ENABLED || 'true').toLowerCase() === 'true',
  volumeWindowSeconds: Number(process.env.VOLUME_WINDOW_SECONDS || 15),
  volumeMode: ((process.env.VOLUME_MODE || 'net') === 'scan' ? 'scan' : 'net'),
};

export function validateConfig(cfg: Config) {
  const errs: string[] = [];
  if (!cfg.heliusRpcUrl) errs.push('HELIUS_RPC_URL or ERPC_RPC_URL required');
  if (!cfg.heliusWsUrl) errs.push('HELIUS_WS_URL or ERPC_WS_URL required');
  if (!cfg.privateKey?.length) errs.push('SOLANA_PRIVATE_KEY required');
  if (cfg.maxSlippageBps <= 0 || cfg.maxSlippageBps > 5000)
    errs.push('MAX_SLIPPAGE_BPS must be between 1 and 5000');
  if (cfg.tpPct <= 0) errs.push('TP_PCT must be > 0, e.g., 0.35');
  if (cfg.slPct >= 0) errs.push('SL_PCT must be < 0, e.g., -0.2');
  if (errs.length) throw new Error('Config error: ' + errs.join('; '));
}

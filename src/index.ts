import { Keypair, Connection, clusterApiUrl, PublicKey } from '@solana/web3.js';
import { config, validateConfig } from './config';
import { logger } from './logger';
import { startBuyDetection } from './detection';
import { Positions } from './positions';
import BN from 'bn.js';
import { Tracker } from './tracker';
import { PumpSdk, getBuySolAmountFromTokenAmount } from '@pump-fun/pump-sdk';
import { startOnchainCreateDetection } from './sources/onchainCreateDetector';
import { fetchJsonMetadata } from './sources/metadata';
import { evaluateLaunch } from './filters';

async function main() {
  validateConfig(config);
  const kp = Keypair.fromSecretKey(config.privateKey);

  const rpcUrl = config.heliusRpcUrl || clusterApiUrl('mainnet-beta');
  const connection = new Connection(rpcUrl, {
    commitment: 'confirmed',
    wsEndpoint: config.heliusWsUrl,
  } as any);

  logger.info('Bot started', {
    rpcUrl,
    wsUrl: config.heliusWsUrl,
    wallet: kp.publicKey.toBase58(),
    tpPct: config.tpPct,
    slPct: config.slPct,
    sellStrategy: config.sellStrategy,
    trailingSlBps: config.trailingSlBps,
    maxSlippageBps: config.maxSlippageBps,
    priorityFeeSol: config.priorityFeeSol,
    skipPreflight: config.skipPreflight,
  });

  const positions = new Positions();

  let tracker: Tracker | null = null;
  const sdk = new PumpSdk(connection);
  // Warm global/fee caches early for consistent buy basis
  const [global, feeConfig] = await Promise.all([
    sdk.fetchGlobal(),
    sdk.fetchFeeConfig(),
  ]);
  if (config.trackerEnabled) {
    tracker = new Tracker(
      connection,
      kp,
      positions,
      {
        tpPct: config.tpPct, // legacy, unused by trailing logic
        slPct: config.slPct, // legacy, unused by trailing logic
        maxSlippageBps: config.maxSlippageBps,
        priorityFeeSol: config.priorityFeeSol,
        skipPreflight: config.skipPreflight,
        sellEnabled: config.sellEnabled,
        minHoldMs: config.minHoldMs,
        trailingSlBps: config.trailingSlBps,
        sellStrategy: config.sellStrategy,
      },
    );
    tracker.start();
  }

  const detector = startBuyDetection({
    connection,
    wallet: kp.publicKey,
    onBuy: async (evt) => {
      const mint = new PublicKey(evt.mint);
      try {
        const tokens = new BN(evt.tokenDelta.toString());
        const basis = new BN((evt.solCostLamports ?? 0n).toString());
        const pos = {
          mint,
          openedAt: evt.blockTime || Math.floor(Date.now() / 1000),
          openedSig: evt.signature,
          tokens,
          costLamports: basis,
        };
        positions.addBuy(pos);
        logger.info('Position opened', {
          mint: evt.mint,
          tokens: pos.tokens.toString(),
          costLamports: pos.costLamports.toString(),
          signature: evt.signature,
          basisSource: 'parsed-tx',
          eventTxFee: evt.txFeeLamports?.toString(),
        });
      } catch (e) {
        logger.warn('Failed to open position (unexpected)', { err: String(e) });
        const pos = {
          mint,
          openedAt: evt.blockTime || Math.floor(Date.now() / 1000),
          openedSig: evt.signature,
          tokens: new BN(evt.tokenDelta.toString()),
          costLamports: new BN((evt.solCostLamports ?? 0n).toString()),
        };
        positions.addBuy(pos);
      }
    },
    pollMs: config.pollIntervalMs,
    mode: config.detectionMode,
  });

  // Optional: on-chain discovery of new launches
  let createDetector: { stop: () => void } | null = null;
  if ((config as any).discoveryOnchain) {
    createDetector = startOnchainCreateDetection({
      connection,
      onCreate: async (evt) => {
        logger.info('New launch', {
          mint: evt.mint,
          creator: evt.creator,
          name: evt.name,
          symbol: evt.symbol,
          sig: evt.signature,
        });
        // Fetch and evaluate metadata (no buys yet)
        let metadata: any = null;
        try {
          metadata = await fetchJsonMetadata(evt.uri, config.metadataTimeoutMs);
        } catch {}
        const candidate = {
          signature: evt.signature,
          mint: evt.mint,
          creator: evt.creator,
          name: evt.name,
          symbol: evt.symbol,
          uri: evt.uri,
          metadata: metadata
            ? {
                description: metadata.description,
                image: metadata.image,
                twitter: metadata.twitter,
                telegram: metadata.telegram,
                website: metadata.website,
              }
            : null,
        };
        const decision = evaluateLaunch(candidate as any, config);
        logger.info('Launch evaluation', {
          mint: evt.mint,
          accepted: decision.accepted,
          reasons: decision.reasons.join(','),
          haveImage: Boolean(candidate.metadata?.image),
          haveSocial: Boolean(candidate.metadata && (candidate.metadata.twitter || candidate.metadata.telegram || candidate.metadata.website)),
        });
        const desc = (candidate.metadata?.description || '').slice(0, 160);
        logger.info('Launch metadata', {
          mint: evt.mint,
          uri: evt.uri,
          image: candidate.metadata?.image,
          twitter: candidate.metadata?.twitter,
          telegram: candidate.metadata?.telegram,
          website: candidate.metadata?.website,
          description: desc,
        });
      },
      commitment: 'processed',
    });
  }

  // Graceful shutdown
  const shutdown = () => {
    logger.info('Shutting down...');
    try { detector.stop(); } catch {}
    try { createDetector?.stop(); } catch {}
    try { tracker?.stop(); } catch {}
    setTimeout(() => process.exit(0), 200);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  const runFor = Number(process.env.RUN_FOR_SECONDS || 0);
  if (runFor > 0) {
    logger.info('Auto-shutdown scheduled', { seconds: runFor });
    setTimeout(shutdown, runFor * 1000);
  }
}

main().catch((e) => {
  logger.error('Fatal error', { err: String(e?.stack || e) });
  process.exit(1);
});

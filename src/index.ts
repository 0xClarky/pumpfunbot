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
import { store } from './store_sqlite';
import { checkSocial } from './gates/social';
import { computeCreatorInitialBuyLamports, findFunderOneHop } from './gates/onchain';
import { attemptAutoBuy } from './autoBuy';
// filters intentionally disabled for now; we're focusing on decode + metadata

async function main() {
  validateConfig(config);
  const kp = Keypair.fromSecretKey(config.privateKey);

  const rpcUrl = config.heliusRpcUrl || clusterApiUrl('mainnet-beta');
  const connection = new Connection(rpcUrl, {
    commitment: 'processed',
    wsEndpoint: config.heliusWsUrl,
  } as any);
  const httpConfirmed = new Connection(rpcUrl, {
    commitment: 'confirmed',
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

  // Seed known creators blacklist from env (optional)
  try { store.seedKnownCreators(config.blacklistCreators, 'env-blacklist'); } catch {}

  let detector: { stop: () => void } | null = null;
  if (config.detectionEnabled) {
    detector = startBuyDetection({
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
  } else {
    logger.info('Wallet buy-detection disabled');
  }

  // Optional: on-chain discovery of new launches
  let createDetector: { stop: () => void } | null = null;
  if ((config as any).discoveryOnchain) {
    createDetector = startOnchainCreateDetection({
      connection,
      fetchConnection: httpConfirmed,
      onCreate: async (evt) => {
        logger.info('New launch', {
          mint: evt.mint,
          creator: evt.creator,
          name: evt.name,
          symbol: evt.symbol,
          sig: evt.signature,
        });
        // Fetch metadata
        let metadata: any = null;
        try { metadata = await fetchJsonMetadata(evt.uri, config.metadataTimeoutMs); } catch {}

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

        // Parallel gates
        const socialP = checkSocial(
          {
            name: evt.name,
            symbol: evt.symbol,
            image: candidate.metadata?.image,
            twitter: candidate.metadata?.twitter,
            description: candidate.metadata?.description,
          },
          {
            requireImage: config.requireImage,
            requireTwitterHandleMatch: config.requireTwitterHandleMatch,
            requireDescription: config.requireDescription,
            httpHeadTimeoutMs: config.httpHeadTimeoutMs,
            imageValidationMode: config.imageValidationMode,
            imageProbeTimeoutMs: config.imageProbeTimeoutMs,
            imageProbeMaxBytes: config.imageProbeMaxBytes,
            imageGateways: config.imageGateways,
          },
        );

        const initialBuyP = computeCreatorInitialBuyLamports(httpConfirmed, {
          signature: evt.signature,
          creator: evt.creator,
          mint: evt.mint,
        });

        // Check first-time creator BEFORE persisting
        const firstTime = config.creatorRequireFirstTime ? !store.hasCreator(evt.creator) : true;

        const funderP = config.creatorFunderBlacklistCheck
          ? findFunderOneHop(httpConfirmed, { creator: evt.creator, beforeSig: evt.signature, timeoutMs: config.lineageTimeoutMs, limit: config.funderSigLimit })
          : Promise.resolve(null);

        const [social, initialBuyLamports, funder] = await Promise.all([socialP, initialBuyP, funderP]);
        const initialBuySol = Number(initialBuyLamports) / 1_000_000_000;
        const funderKnown = !!funder && (store.isKnownCreator(funder) || store.hasCreator(funder));
        if (funder) {
          try { store.addCreatorFunder(evt.creator, funder, evt.signature); } catch {}
        }

        const hardFails: string[] = [];
        if (!social.pass) hardFails.push(...social.reasons.map(r=>`social:${r}`));
        if (config.creatorRequireFirstTime && !firstTime) hardFails.push('creator:not-first-time');
        if (config.creatorMaxInitialBuySol > 0 && initialBuySol > config.creatorMaxInitialBuySol) hardFails.push('creator:initial-buy-too-large');
        if (config.creatorFunderBlacklistCheck && funderKnown) hardFails.push('creator:funder-known');

        logger.info('Launch decision snapshot', {
          mint: evt.mint,
          sig: evt.signature,
          creator: evt.creator,
          name: evt.name,
          symbol: evt.symbol,
          uri: evt.uri,
          image: candidate.metadata?.image,
          twitter: candidate.metadata?.twitter,
          socialReasons: social.reasons,
          initialBuySol: initialBuySol.toFixed(6),
          firstTime,
          funder,
          funderKnown,
          hardFails,
        });
        // Persist creator to local store after decision snapshot
        try {
          store.upsertCreatorOnCreate(evt.creator, evt.signature);
        } catch {}
        // Note: we are not buying yet; this logs the pass/fail signals.

        // Auto-buy decision
        if (config.autoBuyEnabled) {
          if (hardFails.length === 0) {
            try {
              await attemptAutoBuy({
                connection: httpConfirmed,
                wallet: kp,
                mint: new PublicKey(evt.mint),
                createdAtMs: (evt.blockTime ? evt.blockTime * 1000 : Date.now()),
              });
            } catch (e) {
              logger.warn('Auto-buy attempt failed', { err: String((e as any)?.message || e) });
            }
          } else {
            logger.debug('Auto-buy skipped due to hard fails', { mint: evt.mint, hardFails });
          }
        }
      },
      commitment: 'processed',
    });
  }

  // Graceful shutdown
  const shutdown = () => {
    logger.info('Shutting down...');
    try { detector?.stop(); } catch {}
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

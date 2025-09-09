import { Keypair, Connection, clusterApiUrl, PublicKey } from '@solana/web3.js';
import { config, validateConfig } from './config';
import { logger } from './logger';
import { startBuyDetection } from './detection';
import { Positions } from './positions';
import BN from 'bn.js';
import { Tracker } from './tracker';
import { PumpSdk } from '@pump-fun/pump-sdk';
import { startOnchainCreateDetection, NewLaunchEvent } from './sources/onchainCreateDetector';
import { fetchJsonMetadata } from './sources/metadata';
import { store } from './store_sqlite';
import { checkSocial } from './gates/social';
import { computeCreatorInitialBuyLamports, findFunderOneHop } from './gates/onchain';
import { attemptAutoBuy } from './autoBuy';
import { simulateAutoBuy } from './sim';
// import { bondingCurvePda } from '@pump-fun/pump-sdk';
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
          simulationMode: config.simulationEnabled,
          simHardSlEnabled: config.simHardSlEnabled,
          simTtlMs: config.simTtlMs,
          simFlatSecs: config.simFlatSecs,
          simFlatBps: config.simFlatBps,
          simBaseTxLamports: config.simBaseTxLamports,
        },
      );
    tracker.start();
  }

  // Seed known creators blacklist from env (optional)
  try { store.seedKnownCreators(config.blacklistCreators, 'env-blacklist'); } catch {}

  let detector: { stop: () => void } | null = null;
  // --- Master queue: serialize enrich -> vet -> (optional) buy ---
  const masterQueue: NewLaunchEvent[] = [];
  const queuedMints = new Set<string>();
  let processing = false;
  let lastBuyAtMs = 0;

  // Launch metrics helpers (baseline + 15s probe)
  async function recordLaunchBaselineAndSchedule({ evt, candidate, createdAtMs }: { evt: NewLaunchEvent; candidate: any; createdAtMs: number }) {
    if (!config.launchMetricsEnabled) return;
    try {
      const user = kp.publicKey; // not used for baseline math, but required by SDK fetch
      const sdkLocal = new PumpSdk(httpConfirmed);
      const st = await sdkLocal.fetchBuyState(new PublicKey(evt.mint), user);
      const baselineVsol = st.bondingCurve.virtualSolReserves; // BN
      const priorCreates = store.getCreatorCreates(evt.creator) || 0;
      const createsCountAfter = priorCreates + 1;
      // Unified table: write creator fields & window
      store.upsertTradeLaunch({
        mint: evt.mint,
        creator: evt.creator,
        creatorFirstTime: !store.hasCreator(evt.creator),
        creatorCreatesCount: createsCountAfter,
        creatorInitialBuyLamports: candidate.initialBuyLamports?.toString?.() || String(Math.floor((candidate.initialBuySol || 0) * 1e9)) || null,
        volumeWindowSeconds: config.volumeWindowSeconds,
      });
      // Schedule probe
      const delayMs = Math.max(0, createdAtMs + config.volumeWindowSeconds * 1000 - Date.now());
      const probe = async () => {
        try {
          const st2 = await sdkLocal.fetchBuyState(new PublicKey(evt.mint), user);
          const nowVsol = st2.bondingCurve.virtualSolReserves;
          const netInflow = nowVsol.sub(baselineVsol);
          store.updateTradeVolume({
            mint: evt.mint,
            measuredAt: Math.floor(Date.now() / 1000),
            volumeLamports: netInflow.toString(),
          });
          logger.info('Launch 15s volume snapshot', { mint: evt.mint, volumeLamports: netInflow.toString() });
          // Optional: no-flow exit for simulation
          if (config.simulationEnabled && !config.sellEnabled && (config.simNoFlowSol || 0) > 0) {
            const netSol = Number(netInflow.toString()) / 1e9;
            if (netSol <= (config.simNoFlowSol || 0)) {
              // Close the sim position if it's still open
              const pk = new PublicKey(evt.mint);
              const pos = positions.get(pk);
              if (pos) {
                try {
                  const bs = await sdkLocal.fetchBuyState(pk, user);
                  const mintSupply2 = bs.bondingCurve.tokenTotalSupply;
                  const solOut2 = (await import('@pump-fun/pump-sdk')).getSellSolAmountFromTokenAmount({
                    global,
                    feeConfig,
                    mintSupply: mintSupply2,
                    bondingCurve: bs.bondingCurve,
                    amount: pos.tokens,
                  });
                  const prio = Math.floor((config.priorityFeeSol || 0) * 1e9);
                  const base = config.simBaseTxLamports || 0;
                  let netOut2 = solOut2.sub(new BN(prio)).sub(new BN(base));
                  if (netOut2.isNeg()) netOut2 = new BN(0);
                  store.simTradeClose({
                    mint: evt.mint,
                    closedAt: Math.floor(Date.now() / 1000),
                    closeReason: 'NOFLOW',
                    proceedsLamports: netOut2.toString(),
                    pnlLamports: netOut2.sub(pos.costLamports).toString(),
                    pnlPct: pos.costLamports.isZero() ? 0 : netOut2.sub(pos.costLamports).muln(10000).div(pos.costLamports).toNumber() / 10000,
                  });
                  positions.close(pk);
                  logger.info('Sim position closed (NOFLOW)', { mint: evt.mint, netSol });
                } catch (e) {
                  logger.warn('NOFLOW close failed', { mint: evt.mint, err: String((e as any)?.message || e) });
                }
              }
            }
          }
        } catch (e) {
          logger.warn('Launch volume probe failed', { mint: evt.mint, err: String((e as any)?.message || e) });
        }
      };
      setTimeout(probe, delayMs);
      // Fallback retry 5s later in case trade row wasn't created yet
      setTimeout(probe, delayMs + 5000);
    } catch (e) {
      logger.warn('Launch baseline setup failed', { mint: evt.mint, err: String((e as any)?.message || e) });
    }
  }

  async function processQueue() {
    if (processing) return;
    if (masterQueue.length === 0) return;
    processing = true;
    try {
      const evt = masterQueue.shift();
      if (!evt) return;
      queuedMints.delete(evt.mint);
      const createdAtMs = evt.blockTime ? evt.blockTime * 1000 : Date.now();
      const ageMs = Date.now() - createdAtMs;
      if (ageMs > config.maxCreateAgeMs) {
        logger.warn('Skipping stale candidate', { mint: evt.mint, ageMs });
      } else {
        // Enrich metadata
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

        // Social gate (fast)
        const social = await checkSocial(
          { name: evt.name, symbol: evt.symbol, image: candidate.metadata?.image, twitter: candidate.metadata?.twitter, description: candidate.metadata?.description },
          { requireImage: config.requireImage, requireTwitterHandleMatch: config.requireTwitterHandleMatch, requireTwitterPresent: config.requireTwitterPresent, requireDescription: config.requireDescription, httpHeadTimeoutMs: config.httpHeadTimeoutMs, imageValidationMode: config.imageValidationMode, imageProbeTimeoutMs: config.imageProbeTimeoutMs, imageProbeMaxBytes: config.imageProbeMaxBytes, imageGateways: config.imageGateways },
        );

        // First-time creator (local)
        const firstTime = config.creatorRequireFirstTime ? !store.hasCreator(evt.creator) : true;

        // Early reject if obvious
        const hardFails: string[] = [];
        if (!social.pass) hardFails.push(...social.reasons.map(r=>`social:${r}`));
        if (config.creatorRequireFirstTime && !firstTime) hardFails.push('creator:not-first-time');

        // Creator initial buy (create tx only)
        let initialBuySol = 0;
        if (hardFails.length === 0) {
          const lamports = await computeCreatorInitialBuyLamports(httpConfirmed, { signature: evt.signature, creator: evt.creator, mint: evt.mint });
          initialBuySol = Number(lamports) / 1_000_000_000;
          if (config.creatorMaxInitialBuySol > 0 && initialBuySol > config.creatorMaxInitialBuySol) hardFails.push('creator:initial-buy-too-large');
        }

        // Funder check (heaviest) only if still passing
        let funder: string | null = null;
        let funderKnown = false;
        if (hardFails.length === 0 && config.creatorFunderBlacklistCheck) {
          funder = await findFunderOneHop(httpConfirmed, { creator: evt.creator, beforeSig: evt.signature, timeoutMs: config.lineageTimeoutMs, limit: config.funderSigLimit });
          funderKnown = !!funder && (store.hasCreator(funder) || store.isKnownCreator(funder));
          if (funder) {
            try { store.addCreatorFunder(evt.creator, funder, evt.signature); } catch {}
          }
          if (funderKnown) hardFails.push('creator:funder-known');
        }

        // Decision snapshot
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

        // Persist creator info and baseline launch metrics (non-blocking for trading)
        try { store.upsertCreatorOnCreate(evt.creator, evt.signature); } catch {}
        try { await recordLaunchBaselineAndSchedule({ evt, candidate: { ...candidate, initialBuySol, initialBuyLamports: BigInt(Math.floor(initialBuySol * 1e9)) }, createdAtMs }); } catch {}

        // Optional auto-buy or simulation
        if (hardFails.length === 0 && (config.autoBuyEnabled || config.simulationEnabled)) {
          const gap = Date.now() - lastBuyAtMs;
          const waitMs = config.minBuyGapMs > gap ? (config.minBuyGapMs - gap) : 0;
          if (waitMs > 0) await new Promise((r) => setTimeout(r, waitMs));
          try {
            if (config.simulationEnabled) {
              await simulateAutoBuy({
                connection: httpConfirmed,
                wallet: kp,
                positions,
                mint: new PublicKey(evt.mint),
                createdAtMs,
                buySol: config.buySol,
                metadata: candidate.metadata ? { name: candidate.name, symbol: candidate.symbol, uri: candidate.uri } : { name: candidate.name, symbol: candidate.symbol, uri: candidate.uri },
                creator: evt.creator,
                creatorFirstTime: !store.hasCreator(evt.creator),
                creatorCreatesCount: store.getCreatorCreates(evt.creator) + 1,
                creatorInitialBuyLamports: BigInt(Math.floor(initialBuySol * 1e9)).toString(),
                volumeWindowSeconds: config.volumeWindowSeconds,
              });
            } else {
              await attemptAutoBuy({ connection: httpConfirmed, wallet: kp, mint: new PublicKey(evt.mint), createdAtMs });
            }
          } catch (e) {
            logger.warn('Auto-buy attempt (master queue) failed', { mint: evt.mint, err: String((e as any)?.message || e) });
          }
          lastBuyAtMs = Date.now();
        }
      }
    } finally {
      processing = false;
      if (masterQueue.length > 0) void processQueue();
    }
  }
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
        // Enqueue raw event for serialized processing
        if (!queuedMints.has(evt.mint)) {
          queuedMints.add(evt.mint);
          masterQueue.push(evt);
          logger.info('Candidate enqueued', { mint: evt.mint });
          void processQueue();
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

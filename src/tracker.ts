import { Connection, PublicKey, ComputeBudgetProgram, VersionedTransaction, TransactionMessage, Keypair } from '@solana/web3.js';
import { AccountLayout } from '@solana/spl-token';
import BN from 'bn.js';
import { logger } from './logger';
import { Positions, Position } from './positions';
import { PumpSdk, bondingCurveMarketCap, getSellSolAmountFromTokenAmount, getBuySolAmountFromTokenAmount } from '@pump-fun/pump-sdk';
import { store } from './store_sqlite';

type TrackerConfig = {
  tpPct: number; // e.g., 0.35 for +35%
  slPct: number; // e.g., -0.2 for -20%
  maxSlippageBps: number; // e.g., 1000
  priorityFeeSol: number; // e.g., 0.01
  skipPreflight: boolean;
  sellEnabled: boolean;
  minHoldMs: number;
  trailingSlBps: number;
  sellStrategy: 'fixed' | 'trailing';
  simulationMode?: boolean;
  simHardSlEnabled?: boolean;
  simTtlMs?: number;
  simFlatSecs?: number;
  simFlatBps?: number;
  simBaseTxLamports?: number;
};

export class Tracker {
  private stopFlag = false;
  private sdk: PumpSdk;
  private globalCache: any | null = null;
  private feeCfgCache: any | null = null;
  private selling = new Set<string>();
  private lastSolOut = new Map<string, BN>();
  private lastChangeAt = new Map<string, number>();

  constructor(
    private connection: Connection,
    private wallet: Keypair,
    private positions: Positions,
    private cfg: TrackerConfig,
  ) {
    this.sdk = new PumpSdk(connection);
  }

  private lamportsToSolString(l: BN): string {
    const LAMPORTS_PER_SOL = new BN(1_000_000_000);
    const whole = l.div(LAMPORTS_PER_SOL);
    const frac = l.mod(LAMPORTS_PER_SOL);
    const fracStr = frac.toString().padStart(9, '0').replace(/0+$/, '');
    return fracStr ? `${whole.toString()}.${fracStr}` : whole.toString();
  }

  async start() {
    // Warm caches
    await this.ensureGlobals();
    this.loop();
  }

  stop() {
    this.stopFlag = true;
  }

  private async ensureGlobals() {
    if (!this.globalCache) this.globalCache = await this.sdk.fetchGlobal();
    if (!this.feeCfgCache) this.feeCfgCache = await this.sdk.fetchFeeConfig();
  }

  private priorityFeeMicrosPerCU(): number {
    // Roughly target cost across ~200k CU
    const lamports = Math.floor(this.cfg.priorityFeeSol * 1e9);
    const units = 200_000;
    const lamportsPerCU = lamports / units;
    // convert lamports -> microLamports per CU (1 lamport = 1e6 microLamports)
    return Math.max(0, Math.floor(lamportsPerCU * 1e6));
  }

  private async evaluatePosition(pos: Position) {
    // Do not evaluate sells until minHoldMs has elapsed from open
    const nowMs = Date.now();
    if (nowMs < (pos.openedAt * 1000 + this.cfg.minHoldMs)) {
      return;
    }
    // Fetch on-chain state with manual-close detection (single RPC using buyState includes ATA)
    let bondingCurveAccountInfo: any;
    let bondingCurve: any;
    let associatedUserAccountInfo: any | null = null;
    try {
      const buyState = await this.sdk.fetchBuyState(pos.mint, this.wallet.publicKey);
      bondingCurveAccountInfo = buyState.bondingCurveAccountInfo;
      bondingCurve = buyState.bondingCurve;
      associatedUserAccountInfo = buyState.associatedUserAccountInfo;
    } catch (e) {
      const msg = String(e);
      const manualClose =
        msg.includes('Associated token account not found') ||
        msg.includes('TokenAccountNotFoundError') ||
        msg.includes('could not find account');
      if (manualClose) {
        // In simulation mode, record a simulated close to capture instant-death cases
        if (this.cfg.simulationMode && !this.cfg.sellEnabled) {
          try {
            store.simTradeClose({
              mint: pos.mint.toBase58(),
              closedAt: Math.floor(Date.now() / 1000),
              closeReason: 'HALT',
              proceedsLamports: '0',
              pnlLamports: pos.costLamports.neg().toString(),
              pnlPct: -1, // -100%
            });
            logger.info('Sim position closed (manual/halt)', { mint: pos.mint.toBase58(), reason: 'HALT' });
          } catch {}
          this.positions.close(pos.mint);
          return;
        }
        logger.info('Position closed manually, removing from tracker', { mint: pos.mint.toBase58() });
        this.positions.close(pos.mint);
        return;
      }
      throw e;
    }
    // If ATA missing or zero balance, treat as manually closed (skip in simulation mode)
    if (!this.cfg.simulationMode) {
      try {
        if (!associatedUserAccountInfo) {
          logger.info('Position ATA missing; removing from tracker', { mint: pos.mint.toBase58() });
          this.positions.close(pos.mint);
          return;
        }
        const data = associatedUserAccountInfo.data as Buffer;
        const decoded: any = AccountLayout.decode(Buffer.from(data));
        // decoded.amount is a Buffer-like u64; convert to string then BigInt
        const amt = BigInt(decoded.amount.toString());
        if (amt === 0n) {
          logger.info('Position balance zero; removing from tracker', { mint: pos.mint.toBase58() });
          this.positions.close(pos.mint);
          return;
        }
      } catch {
        // If decode fails, proceed — sell/trailing logic will still function
      }
    }
    const mintSupply = bondingCurve.tokenTotalSupply; // BN

    // SOL out if sell all now (gross, before netting fees)
    const solOut = getSellSolAmountFromTokenAmount({
      global: this.globalCache!,
      feeConfig: this.feeCfgCache!,
      mintSupply,
      bondingCurve,
      amount: pos.tokens,
    });

    // Helper to apply fee model to proceeds (simulation)
    const netOutWithFees = (gross: BN) => {
      const prio = Math.floor((this.cfg.priorityFeeSol || 0) * 1e9);
      const base = this.cfg.simBaseTxLamports || 0;
      const net = gross.sub(new BN(prio)).sub(new BN(base));
      return net.isNeg() ? new BN(0) : net; // clamp to >= 0 to avoid <-100% PnL
    };

    // If curve is complete/migrated, close immediately in simulation mode to record outcome
    if (bondingCurve.complete) {
      if (this.cfg.simulationMode && !this.cfg.sellEnabled) {
        const netOut = netOutWithFees(solOut);
        const pnlLamports = netOut.sub(pos.costLamports);
        const pnlPct = pos.costLamports.isZero() ? 0 : pnlLamports.muln(10000).div(pos.costLamports).toNumber() / 10000;
        try {
          store.simTradeClose({
            mint: pos.mint.toBase58(),
            closedAt: Math.floor(Date.now() / 1000),
            closeReason: 'HALT',
            proceedsLamports: netOut.toString(),
            pnlLamports: pnlLamports.toString(),
            pnlPct,
          });
        } catch {}
        this.positions.close(pos.mint);
        logger.warn('Sim position closed due to migration/complete', { mint: pos.mint.toBase58(), pnlPct: pnlPct.toFixed(4) });
        return;
      }
      // Live path: just drop tracking
      logger.warn('Position halted due to migration/complete', { mint: pos.mint.toBase58() });
      this.positions.close(pos.mint);
      return;
    }

    const mcap = bondingCurveMarketCap({
      mintSupply,
      virtualSolReserves: bondingCurve.virtualSolReserves,
      virtualTokenReserves: bondingCurve.virtualTokenReserves,
    });

    const pnlLamports = solOut.sub(pos.costLamports);
    const pnlPct = pos.costLamports.isZero()
      ? 0
      : pnlLamports.muln(10000).div(pos.costLamports).toNumber() / 10000;

    // Approximate price and mcap in SOL for console readability
    // Price per token (string with 9 decimals), preserve precision using scaling
    const priceLamportsScaled = pos.tokens.isZero()
      ? new BN(0)
      : solOut.mul(new BN(1_000_000_000)).div(pos.tokens);
    const priceSolStr = this.lamportsToSolString(priceLamportsScaled);
    const mcapSolStr = this.lamportsToSolString(mcap);

    logger.info('Track update', {
      mint: pos.mint.toBase58(),
      tokens: pos.tokens.toString(),
      solOut: solOut.toString(),
      cost: pos.costLamports.toString(),
      pnlPct: pnlPct.toFixed(4),
      mcapLamports: mcap.toString(),
      priceSol: priceSolStr,
      mcapSol: mcapSolStr,
    });

    // netOutWithFees defined earlier in this method

    // Time-to-live exit (simulation only)
    if (this.cfg.simulationMode && !this.cfg.sellEnabled && (this.cfg.simTtlMs || 0) > 0) {
      const ttlMs = this.cfg.simTtlMs || 0;
      if (Date.now() >= (pos.openedAt * 1000 + ttlMs)) {
        const netOut = netOutWithFees(solOut);
        const pnlLamports = netOut.sub(pos.costLamports);
        const ttlPnlPct = pos.costLamports.isZero() ? 0 : pnlLamports.muln(10000).div(pos.costLamports).toNumber() / 10000;
        try {
          store.simTradeClose({
            mint: pos.mint.toBase58(),
            closedAt: Math.floor(Date.now() / 1000),
            closeReason: 'TTL',
            proceedsLamports: netOut.toString(),
            pnlLamports: pnlLamports.toString(),
            pnlPct: ttlPnlPct,
          });
        } catch {}
        this.positions.close(pos.mint);
        logger.info('Sim position closed (TTL)', { mint: pos.mint.toBase58(), ttlMs });
        return;
      }
    }

    if (this.cfg.sellStrategy === 'trailing') {
      // Trailing stop logic
      if (!pos.peakSolOut || solOut.gt(pos.peakSolOut)) {
        this.positions.update(pos.mint, { peakSolOut: solOut });
        const trailNumer = 10000 - this.cfg.trailingSlBps;
        const trigger = solOut.muln(trailNumer).divn(10000);
        logger.info('Peak updated', {
          mint: pos.mint.toBase58(),
          peakSolOut: solOut.toString(),
          trailingSlBps: this.cfg.trailingSlBps,
          trailTrigger: trigger.toString(),
        });
        return; // don't sell in the same tick as peak update
      }
      if (pos.peakSolOut) {
        const trailNumer = 10000 - this.cfg.trailingSlBps;
        const trigger = pos.peakSolOut.muln(trailNumer).divn(10000);
        const key = pos.mint.toBase58();
        if (solOut.lte(trigger)) {
          if (!this.cfg.sellEnabled) {
            if (this.cfg.simulationMode) {
              const netOut = netOutWithFees(solOut);
              const pnlLamports = netOut.sub(pos.costLamports);
              const pnlPctSim = pos.costLamports.isZero() ? 0 : pnlLamports.muln(10000).div(pos.costLamports).toNumber() / 10000;
              try {
                store.simTradeClose({
                  mint: pos.mint.toBase58(),
                  closedAt: Math.floor(Date.now() / 1000),
                  closeReason: 'TSL',
                  proceedsLamports: netOut.toString(),
                  pnlLamports: pnlLamports.toString(),
                  pnlPct: pnlPctSim,
                });
              } catch {}
              this.positions.close(pos.mint);
              logger.info('Sim position closed', { mint: key, reason: 'TSL', proceeds: solOut.toString(), pnlPct: pnlPctSim.toFixed(4) });
              return;
            }
            logger.info('Sell condition met (dry-run)', { mint: key, reason: 'TSL', trailingSlBps: this.cfg.trailingSlBps });
            return;
          }
          if (this.selling.has(key)) return;
          this.selling.add(key);
          try {
            logger.info('Sell trigger', { mint: key, reason: 'TSL', trailingSlBps: this.cfg.trailingSlBps });
            await this.sellAll({ pos, bondingCurveAccountInfo, bondingCurve, expectedSol: solOut });
          } finally {
            this.selling.delete(key);
          }
        }
      }
      // Simulation hard SL fallback (handles instant dumps that never arm trailing)
      if (this.cfg.simulationMode && !this.cfg.sellEnabled && (this.cfg.simHardSlEnabled ?? true)) {
        if (pnlPct <= this.cfg.slPct) {
          const netOut = netOutWithFees(solOut);
          const pnlLamports = netOut.sub(pos.costLamports);
          try {
            store.simTradeClose({
              mint: pos.mint.toBase58(),
              closedAt: Math.floor(Date.now() / 1000),
              closeReason: 'SL',
              proceedsLamports: netOut.toString(),
              pnlLamports: pnlLamports.toString(),
              pnlPct,
            });
          } catch {}
          this.positions.close(pos.mint);
          logger.info('Sim position closed (hard SL fallback)', { mint: pos.mint.toBase58(), pnlPct: pnlPct.toFixed(4) });
          return;
        }
      }
      return;
    }

    // Fixed TP/SL strategy
    if (pnlPct >= this.cfg.tpPct || pnlPct <= this.cfg.slPct) {
      const key = pos.mint.toBase58();
      if (!this.cfg.sellEnabled) {
        const reason = pnlPct >= this.cfg.tpPct ? 'TP' : 'SL';
        if (this.cfg.simulationMode) {
          const netOut = netOutWithFees(solOut);
          const pnlLamports = netOut.sub(pos.costLamports);
          try {
            store.simTradeClose({
              mint: pos.mint.toBase58(),
              closedAt: Math.floor(Date.now() / 1000),
              closeReason: reason,
              proceedsLamports: netOut.toString(),
              pnlLamports: pnlLamports.toString(),
              pnlPct,
            });
          } catch {}
          this.positions.close(pos.mint);
          logger.info('Sim position closed', { mint: key, reason, proceeds: solOut.toString(), pnlPct: pnlPct.toFixed(4) });
          return;
        }
        logger.info('Sell condition met (dry-run)', { mint: key, reason, pnlPct: pnlPct.toFixed(4) });
        return;
      }
      if (this.selling.has(key)) return;
      this.selling.add(key);
      try {
        const reason = pnlPct >= this.cfg.tpPct ? 'TP' : 'SL';
        logger.info('Sell trigger', { mint: key, reason, pnlPct: pnlPct.toFixed(4) });
        await this.sellAll({ pos, bondingCurveAccountInfo, bondingCurve, expectedSol: solOut });
      } finally {
        this.selling.delete(key);
      }
    }

    // Flat exit tracking (simulation only)
    if (this.cfg.simulationMode && !this.cfg.sellEnabled && (this.cfg.simFlatSecs || 0) > 0 && (this.cfg.simFlatBps || 0) > 0) {
      const key = pos.mint.toBase58();
      const last = this.lastSolOut.get(key);
      const nowVal = solOut;
      const bps = this.cfg.simFlatBps || 0;
      const winMs = (this.cfg.simFlatSecs || 0) * 1000;
      if (!last || last.isZero()) {
        this.lastSolOut.set(key, nowVal);
        this.lastChangeAt.set(key, Date.now());
      } else {
        const diff = nowVal.sub(last).abs();
        // relative bps vs last value
        const relBps = last.isZero() ? new BN(0) : diff.muln(10000).div(last);
        if (relBps.lten(bps)) {
          const since = Date.now() - (this.lastChangeAt.get(key) || Date.now());
          if (since >= winMs) {
            const netOut = netOutWithFees(nowVal);
            const pnlLamports = netOut.sub(pos.costLamports);
            const flatPnlPct = pos.costLamports.isZero() ? 0 : pnlLamports.muln(10000).div(pos.costLamports).toNumber() / 10000;
            try {
              store.simTradeClose({
                mint: key,
                closedAt: Math.floor(Date.now() / 1000),
                closeReason: 'FLAT',
                proceedsLamports: netOut.toString(),
                pnlLamports: pnlLamports.toString(),
                pnlPct: flatPnlPct,
              });
            } catch {}
            this.positions.close(pos.mint);
            logger.info('Sim position closed (FLAT)', { mint: key, flatSecs: this.cfg.simFlatSecs, flatBps: bps });
            // cleanup
            this.lastSolOut.delete(key);
            this.lastChangeAt.delete(key);
            return;
          }
        } else {
          // significant move; update baseline
          this.lastSolOut.set(key, nowVal);
          this.lastChangeAt.set(key, Date.now());
        }
      }
    }
  }

  // Public helper to compute SDK-based cost basis from current curve state
  public async getSdkCostBasis(mint: PublicKey, tokens: BN): Promise<BN> {
    await this.ensureGlobals();
    const { bondingCurve } = await this.sdk.fetchBuyState(mint, this.wallet.publicKey);
    const mintSupply = bondingCurve.tokenTotalSupply;
    return getBuySolAmountFromTokenAmount({
      global: this.globalCache!,
      feeConfig: this.feeCfgCache!,
      mintSupply,
      bondingCurve,
      amount: tokens,
    });
  }

  private async sellAll({
    pos,
    bondingCurveAccountInfo,
    bondingCurve,
    expectedSol,
  }: {
    pos: Position;
    bondingCurveAccountInfo: any;
    bondingCurve: any;
    expectedSol: BN;
  }) {
    const microLamports = this.priorityFeeMicrosPerCU();
    const cuIxs = [
      ComputeBudgetProgram.setComputeUnitLimit({ units: 300_000 }),
      microLamports > 0
        ? ComputeBudgetProgram.setComputeUnitPrice({ microLamports })
        : null,
    ].filter(Boolean) as any[];

    const slippagePct = this.cfg.maxSlippageBps / 100; // SDK expects percent
    const sellIxs = await this.sdk.sellInstructions({
      global: this.globalCache!,
      bondingCurveAccountInfo,
      bondingCurve,
      mint: pos.mint,
      user: this.wallet.publicKey,
      amount: pos.tokens,
      solAmount: expectedSol,
      slippage: slippagePct,
    });

    // Build/send with WS-based confirmation (processed fast path + confirmed) and a single resubmit on timeout
    let attempt = 0;
    while (attempt < 2) {
      attempt++;
      const { blockhash } = await this.connection.getLatestBlockhash('processed');
      const message = new TransactionMessage({
        payerKey: this.wallet.publicKey,
        recentBlockhash: blockhash,
        instructions: [...cuIxs, ...sellIxs],
      }).compileToV0Message();
      const tx = new VersionedTransaction(message);
      tx.sign([this.wallet]);
      const sig = await this.connection.sendRawTransaction(tx.serialize(), {
        skipPreflight: this.cfg.skipPreflight,
        preflightCommitment: 'processed',
        maxRetries: 3,
      });
      logger.info('Sell submitted', { sig, attempt });

      // Fast path: wait for 'processed' quickly; resubmit early if we don't see it
      try {
        await this.waitSignatureWS(sig, 'processed', 5_000);
        logger.info('Sell observed', { sig, commitment: 'processed' });
      } catch (e) {
        if (attempt < 2) {
          logger.warn('Resubmitting due to no processed signal', { sig, attempt });
          continue; // early resubmit
        }
        throw e;
      }

      // Background: wait for 'confirmed' with its own timeout
      try {
        await this.waitSignatureWS(sig, 'confirmed', 12_000);
        logger.info('Sell confirmed', { sig, via: 'ws' });
        break; // success
      } catch (e) {
        const msg = String(e);
        if (attempt < 2 && msg.includes('ws-timeout')) {
          logger.warn('Resubmitting due to confirmation timeout', { sig, attempt });
          continue;
        }
        // Program failure or final timeout
        throw e;
      }
    }
    // Ensure position is removed after a successful sell to prevent re-evaluation
    this.positions.close(pos.mint);
    logger.info('Position closed', { mint: pos.mint.toBase58() });
  }

  private async waitSignatureWS(sig: string, commitment: 'processed' | 'confirmed', timeoutMs: number): Promise<void> {
    return new Promise((resolve, reject) => {
      let timer: any;
      try {
        const subId = this.connection.onSignature(
          sig,
          (res: any) => {
            clearTimeout(timer);
            if (res?.err) {
              reject(new Error(`Tx error: ${JSON.stringify(res.err)}`));
            } else {
              resolve();
            }
          },
          commitment,
        );
        timer = setTimeout(() => {
          this.connection.removeSignatureListener(subId).catch(() => {});
          reject(new Error('ws-timeout'));
        }, timeoutMs);
      } catch (e) {
        reject(e as any);
      }
    });
  }

  private async loop() {
    while (!this.stopFlag) {
      try {
        const all = this.positions.all();
        for (const p of all) {
          await this.evaluatePosition(p);
        }
      } catch (e) {
        logger.warn('Tracker loop error', { err: String(e) });
      }
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
}

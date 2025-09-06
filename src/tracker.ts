import { Connection, PublicKey, ComputeBudgetProgram, VersionedTransaction, TransactionMessage, Keypair } from '@solana/web3.js';
import { getAssociatedTokenAddressSync } from '@solana/spl-token';
import BN from 'bn.js';
import { logger } from './logger';
import { Positions, Position } from './positions';
import { PumpSdk, bondingCurveMarketCap, getSellSolAmountFromTokenAmount, getBuySolAmountFromTokenAmount } from '@pump-fun/pump-sdk';

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
};

export class Tracker {
  private stopFlag = false;
  private sdk: PumpSdk;
  private globalCache: any | null = null;
  private feeCfgCache: any | null = null;
  private selling = new Set<string>();

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
    // Fetch on-chain state with manual-close detection
    let bondingCurveAccountInfo: any;
    let bondingCurve: any;
    try {
      const sellState = await this.sdk.fetchSellState(pos.mint, this.wallet.publicKey);
      bondingCurveAccountInfo = sellState.bondingCurveAccountInfo;
      bondingCurve = sellState.bondingCurve;
    } catch (e) {
      const msg = String(e);
      const manualClose =
        msg.includes('Associated token account not found') ||
        msg.includes('TokenAccountNotFoundError') ||
        msg.includes('could not find account');
      if (manualClose) {
        logger.info('Position closed manually, removing from tracker', { mint: pos.mint.toBase58() });
        this.positions.close(pos.mint);
        return;
      }
      throw e;
    }

    // If ATA exists but balance is zero, treat as manually closed as well
    try {
      const ata = getAssociatedTokenAddressSync(pos.mint, this.wallet.publicKey, true);
      const bal = await this.connection.getTokenAccountBalance(ata);
      if (!bal?.value || bal.value.uiAmount === 0 || bal.value.amount === '0') {
        logger.info('Position balance zero; removing from tracker', { mint: pos.mint.toBase58() });
        this.positions.close(pos.mint);
        return;
      }
    } catch (_) {
      // ignore errors here; sellState succeeded so continue
    }
    if (bondingCurve.complete) {
      // Migration/complete state — halt this position per SOW
      logger.warn('Position halted due to migration/complete', { mint: pos.mint.toBase58() });
      this.positions.close(pos.mint);
      return;
    }
    const mintSupply = bondingCurve.tokenTotalSupply; // BN

    // SOL out if sell all now (after fees)
    const solOut = getSellSolAmountFromTokenAmount({
      global: this.globalCache!,
      feeConfig: this.feeCfgCache!,
      mintSupply,
      bondingCurve,
      amount: pos.tokens,
    });

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
      return;
    }

    // Fixed TP/SL strategy
    if (pnlPct >= this.cfg.tpPct || pnlPct <= this.cfg.slPct) {
      const key = pos.mint.toBase58();
      if (!this.cfg.sellEnabled) {
        const reason = pnlPct >= this.cfg.tpPct ? 'TP' : 'SL';
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

    // Build/send with one retry on blockhash expiration and a light status poll to reduce RPC churn
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    let attempt = 0;
    while (true) {
      attempt++;
      const { blockhash, lastValidBlockHeight } = await this.connection.getLatestBlockhash('processed');
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
      // poll signature status with modest backoff
      const start = Date.now();
      let delay = 300;
      while (true) {
        const st = await this.connection.getSignatureStatuses([sig]);
        const s = st.value[0];
        // Check for failure first: a tx can be finalized with an error
        if (s?.err) {
          logger.error('Sell transaction failed', { sig, err: s.err });
          throw new Error(`Tx error: ${JSON.stringify(s.err)}`);
        }
        if (s?.confirmationStatus === 'confirmed' || s?.confirmationStatus === 'finalized') {
          logger.info('Sell confirmed', { sig, confirmationStatus: s.confirmationStatus });
          attempt = 99; // exit outer loop
          break;
        }
        if (Date.now() - start > 20_000) {
          // treat as likely expired
          throw new Error('block height exceeded');
        }
        await sleep(delay);
        delay = Math.min(1000, Math.floor(delay * 1.3));
      }
      if (attempt >= 99) break;
      // resubmit on expiry once
      if (attempt < 2) {
        logger.warn('Resubmitting due to slow confirmation', { attempt });
        continue;
      }
      break;
    }
    // Ensure position is removed after a successful sell to prevent re-evaluation
    this.positions.close(pos.mint);
    logger.info('Position closed', { mint: pos.mint.toBase58() });
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

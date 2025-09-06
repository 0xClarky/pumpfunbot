import { Connection, PublicKey, ComputeBudgetProgram, VersionedTransaction, TransactionMessage, Keypair } from '@solana/web3.js';
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
    const { bondingCurveAccountInfo, bondingCurve } = await this.sdk.fetchSellState(
      pos.mint,
      this.wallet.publicKey,
    );
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
      : pnlLamports.toNumber() / pos.costLamports.toNumber();

    // Approximate price and mcap in SOL for console readability
    const priceLamportsPerToken = pos.tokens.isZero() ? new BN(0) : solOut.div(pos.tokens);
    const priceSol = Number(priceLamportsPerToken.toString()) / 1e9;
    const mcapSol = Number(mcap.toString()) / 1e9;

    logger.info('Track update', {
      mint: pos.mint.toBase58(),
      tokens: pos.tokens.toString(),
      solOut: solOut.toString(),
      cost: pos.costLamports.toString(),
      pnlPct: pnlPct.toFixed(4),
      mcapLamports: mcap.toString(),
      priceSol: priceSol.toFixed(10),
      mcapSol: mcapSol.toFixed(2),
    });

    if (pnlPct >= this.cfg.tpPct || pnlPct <= this.cfg.slPct) {
      if (!this.cfg.sellEnabled) {
        logger.info('Sell condition met (dry-run)', { mint: pos.mint.toBase58(), pnlPct: pnlPct.toFixed(4) });
        return;
      }
      const key = pos.mint.toBase58();
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

    // Build/send with one retry on blockhash expiration
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
      try {
        await this.connection.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, 'confirmed');
        logger.info('Sell confirmed', { sig });
        break;
      } catch (e) {
        const msg = String(e);
        if (attempt < 2 && msg.includes('block height exceeded')) {
          logger.warn('Resubmitting due to expired blockhash', { sig });
          continue;
        }
        throw e;
      }
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

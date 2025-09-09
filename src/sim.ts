import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import BN from 'bn.js';
import { PumpSdk, getBuyTokenAmountFromSolAmount } from '@pump-fun/pump-sdk';
import { Positions } from './positions';
import { logger } from './logger';
import { store } from './store_sqlite';
import { config } from './config';

export type SimBuyParams = {
  connection: Connection;
  wallet: Keypair;
  positions: Positions;
  mint: PublicKey;
  createdAtMs: number;
  buySol: number; // SOL per buy
  metadata?: { name?: string; symbol?: string; uri?: string } | null;
  creator?: string;
  creatorFirstTime?: boolean;
  creatorCreatesCount?: number;
  creatorInitialBuyLamports?: string | null;
  volumeWindowSeconds?: number;
};

export async function simulateAutoBuy({ connection, wallet, positions, mint, createdAtMs, buySol, metadata, creator, creatorFirstTime, creatorCreatesCount, creatorInitialBuyLamports, volumeWindowSeconds }: SimBuyParams): Promise<void> {
  // Quote token amount using current curve state
  const sdk = new PumpSdk(connection);
  const user = wallet.publicKey;
  let global: any;
  let feeConfig: any;
  let bondingCurve: any;
  let bondingCurveAccountInfo: any;
  try {
    [global, feeConfig] = await Promise.all([sdk.fetchGlobal(), sdk.fetchFeeConfig()]);
    const st = await sdk.fetchBuyState(mint, user);
    bondingCurve = st.bondingCurve;
    bondingCurveAccountInfo = st.bondingCurveAccountInfo;
  } catch (e) {
    logger.warn('Sim buy: failed to fetch state', { mint: mint.toBase58(), err: String((e as any)?.message || e) });
    return;
  }

  const lamports = new BN(Math.floor(buySol * 1_000_000_000));
  const amountTokens = getBuyTokenAmountFromSolAmount({
    global,
    feeConfig,
    mintSupply: null,
    bondingCurve,
    amount: lamports,
  });
  if (!amountTokens || amountTokens.lten(0)) {
    logger.warn('Sim buy: zero token quote', { mint: mint.toBase58() });
    return;
  }

  const openedAt = Math.floor((createdAtMs || Date.now()) / 1000);
  const openedSig = `sim-${Date.now()}`;
  const buyPriority = Math.floor((config.priorityFeeSol || 0) * 1e9);
  const baseFee = config.simBaseTxLamports || 0;
  const totalCost = lamports.add(new BN(buyPriority)).add(new BN(baseFee));
  const pos = {
    mint,
    openedAt,
    openedSig,
    tokens: amountTokens,
    costLamports: totalCost,
  };
  positions.addBuy(pos as any);
  try {
    const args: any = {
      mint: mint.toBase58(),
      openedAt,
      openedSig,
      tokens: amountTokens.toString(),
      costLamports: totalCost.toString(),
      name: metadata?.name,
      symbol: metadata?.symbol,
    };
    store.simTradeOpen(args);
    if (creator) {
      try {
        store.upsertTradeLaunch({
          mint: mint.toBase58(),
          creator,
          creatorFirstTime: !!creatorFirstTime,
          creatorCreatesCount: creatorCreatesCount || 0,
          creatorInitialBuyLamports: creatorInitialBuyLamports ?? null,
          volumeWindowSeconds: volumeWindowSeconds || 15,
        });
      } catch {}
    }
  } catch {}
  logger.info('Sim position opened', {
    mint: mint.toBase58(),
    tokens: amountTokens.toString(),
    costLamports: totalCost.toString(),
    openedSig,
  });
}

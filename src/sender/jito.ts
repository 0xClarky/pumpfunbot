import { Keypair, VersionedTransaction } from '@solana/web3.js';
import { logger } from '../logger';

export type JitoBundleResult = {
  ok: boolean;
  bundleId?: string | undefined;
  reason?: string | undefined;
};

export async function sendBundleJito(params: {
  blockEngineUrl: string;
  identity: Keypair;
  txs: VersionedTransaction[];
  deadlineMs: number;
}): Promise<JitoBundleResult> {
  const { blockEngineUrl, identity, txs, deadlineMs } = params;
  try {
    // Load concrete exports from dist paths
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { searcherClient } = require('jito-ts/dist/sdk/block-engine/searcher');
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { Bundle } = require('jito-ts/dist/sdk/block-engine/types');

    if (!searcherClient || !Bundle) throw new Error('jito-ts exports not found');

    const client = searcherClient(blockEngineUrl, identity);
    const bundle = new Bundle(txs);
    // The SDK's sendBundle returns { ok: boolean, value?: string, error?: Error }
    const res = await client.sendBundle(bundle);
    if (res?.ok) {
      return { ok: true, bundleId: res.value as string };
    } else {
      const reason = res?.error?.message || String(res?.error || 'unknown');
      return { ok: false, reason };
    }
  } catch (e) {
    logger.warn('Jito bundle send failed', { err: String((e as any)?.message || e) });
    return { ok: false, reason: String((e as any)?.message || e) };
  }
}

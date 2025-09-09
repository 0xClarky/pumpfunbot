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
    // Dynamic require to avoid type/compile issues if package not present
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const jito: any = require('jito-ts');
    // Try common export paths
    const SearcherClient = jito.SearcherClient || jito.default?.SearcherClient || jito.searcher?.SearcherClient || jito;
    const Bundle = jito.Bundle || jito.default?.Bundle || jito.searcher?.Bundle;

    if (!SearcherClient || !Bundle) {
      throw new Error('jito-ts exports not found');
    }

    // Some versions expose static connect(), others via constructor; try both
    let client: any;
    if (typeof SearcherClient.connect === 'function') {
      client = await SearcherClient.connect(blockEngineUrl, identity);
    } else {
      client = new SearcherClient(blockEngineUrl, identity);
    }

    const serialized = txs.map((tx) => tx.serialize());
    const bundle = new Bundle(serialized);

    // Send and optionally wait; different SDK versions expose different APIs
    if (typeof client.sendBundle === 'function') {
      const res = await client.sendBundle(bundle, { deadlineMs });
      const bundleId = res?.bundleId || res?.id || undefined;
      const ok = Boolean(bundleId);
      return { ok, bundleId, reason: ok ? undefined : 'no-bundle-id' };
    }
    if (typeof client.sendBundleAndAwait === 'function') {
      const res = await client.sendBundleAndAwait(bundle, { deadlineMs });
      const status = res?.status || res?.result || 'unknown';
      const ok = String(status).toLowerCase().includes('accepted');
      const bundleId = res?.bundleId || undefined;
      return { ok, bundleId, reason: ok ? undefined : String(status) };
    }

    throw new Error('Unsupported jito-ts client send method');
  } catch (e) {
    logger.warn('Jito bundle send failed', { err: String((e as any)?.message || e) });
    return { ok: false, reason: String((e as any)?.message || e) };
  }
}

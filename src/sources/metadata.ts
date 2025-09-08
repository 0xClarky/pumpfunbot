import { logger } from '../logger';

export type OffchainMetadata = {
  name?: string;
  symbol?: string;
  description?: string;
  image?: string;
  twitter?: string;
  telegram?: string;
  website?: string;
  [k: string]: any;
};

export async function fetchJsonMetadata(uri: string, timeoutMs: number): Promise<OffchainMetadata | null> {
  try {
    if (!uri || !/^https?:\/\//i.test(uri)) return null;
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    const res = await fetch(uri, { signal: ctrl.signal, redirect: 'follow' as any });
    clearTimeout(t);
    if (!res.ok) return null;
    const ct = res.headers.get('content-type') || '';
    if (!ct.toLowerCase().includes('application/json')) {
      // Some hosts serve JSON without correct header; attempt parse anyway
    }
    const json: any = await res.json().catch(() => null);
    if (!json || typeof json !== 'object') return null;
    const lower = (s?: string) => (typeof s === 'string' ? s : undefined);
    return {
      name: lower(json.name),
      symbol: lower(json.symbol),
      description: lower(json.description),
      image: lower(json.image || json.image_uri),
      twitter: lower(json.twitter || json.extensions?.twitter || json.external_url_twitter),
      telegram: lower(json.telegram || json.extensions?.telegram),
      website: lower(json.website || json.extensions?.website || json.external_url),
      ...json,
    } as OffchainMetadata;
  } catch (e) {
    logger.debug('Metadata fetch failed', { uri, err: String((e as any)?.message || e) });
    return null;
  }
}


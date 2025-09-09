import { logger } from '../logger';

// REST sender for Jito bundles (HTTP). Posts to /api/v1/bundles with { transactions: [base64...] }
export async function sendBundleJsonRpc(params: {
  endpoint: string;        // base url or full REST url
  txsBase64: string[];
  uuid?: string;           // optional x-jito-auth
  timeoutMs?: number;
}): Promise<{ ok: boolean; result?: any; error?: string }>{
  const { endpoint, txsBase64, uuid, timeoutMs = 3000 } = params;
  try {
    const ctrl = new AbortController();
    const to = setTimeout(() => ctrl.abort(), timeoutMs);
    // Normalize URL: if no /api path present, append the standard REST path
    let url = endpoint;
    try {
      const u = new URL(endpoint);
      if (!/\/api\//.test(u.pathname)) {
        u.pathname = '/api/v1/bundles';
      }
      url = u.toString();
    } catch {
      // best effort for non-URL strings
      if (!endpoint.includes('/api/')) url = endpoint.replace(/\/$/, '') + '/api/v1/bundles';
    }

    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (uuid) headers['x-jito-auth'] = uuid;
    const body = { transactions: txsBase64 };

    const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal: ctrl.signal } as any);
    clearTimeout(to);
    if (!res.ok) {
      const t = await res.text().catch(() => '');
      return { ok: false, error: `http:${res.status}:${t}` };
    }
    const json = await res.json().catch(() => null);
    if (!json) return { ok: false, error: 'invalid-json' };
    return { ok: true, result: json };
  } catch (e) {
    const msg = String((e as any)?.message || e);
    logger.warn('sendBundleJsonRpc failed', { err: msg });
    return { ok: false, error: msg };
  }
}

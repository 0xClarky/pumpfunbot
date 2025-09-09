import { logger } from '../logger';

export async function sendBundleJsonRpc(params: {
  endpoint: string;
  txsBase64: string[];
  uuid?: string;
  timeoutMs?: number;
}): Promise<{ ok: boolean; result?: any; error?: string }>{
  const { endpoint, txsBase64, uuid, timeoutMs = 3000 } = params;
  try {
    const ctrl = new AbortController();
    const to = setTimeout(() => ctrl.abort(), timeoutMs);
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (uuid) headers['x-jito-auth'] = uuid;
    const body = {
      jsonrpc: '2.0',
      id: 1,
      method: 'sendBundle',
      params: [txsBase64], // single parameter: array of base64 txs
    };
    const res = await fetch(endpoint, { method: 'POST', headers, body: JSON.stringify(body), signal: ctrl.signal } as any);
    clearTimeout(to);
    if (!res.ok) {
      const t = await res.text().catch(() => '');
      return { ok: false, error: `http:${res.status}:${t}` };
    }
    const json = await res.json().catch(() => null);
    if (!json) return { ok: false, error: 'invalid-json' };
    if (json.error) return { ok: false, error: JSON.stringify(json.error) };
    return { ok: true, result: json.result };
  } catch (e) {
    const msg = String((e as any)?.message || e);
    logger.warn('sendBundleJsonRpc failed', { err: msg });
    return { ok: false, error: msg };
  }
}


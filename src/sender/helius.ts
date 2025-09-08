import { logger } from '../logger';

async function postJson(url: string, body: any) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  } as any).catch((e) => ({ ok: false, status: 0, text: async () => String(e) } as any));
  if (!('ok' in res) || !res.ok) {
    const t = typeof (res as any).text === 'function' ? await (res as any).text() : '';
    throw new Error(`sender-http:${(res as any).status}:${t}`);
  }
  const json = await (res as any).json().catch(() => null);
  if (!json) throw new Error('sender-json');
  if ((json as any).error) throw new Error(`sender-error:${JSON.stringify((json as any).error)}`);
  return json;
}

function buildTransactionsUrl(base: string): string {
  try {
    const u = new URL(base);
    // If already pointing to /v0/transactions, keep
    if (u.pathname.includes('/v0/transactions')) return u.toString();
    // Switch rpc.helius.xyz -> api.helius.xyz and set path
    if (u.hostname.includes('rpc.helius.xyz')) {
      u.hostname = 'api.helius.xyz';
    }
    u.pathname = '/v0/transactions';
    return u.toString();
  } catch {
    // If parsing fails, best effort
    if (base.includes('/v0/transactions')) return base;
    return base.replace(/\/$/, '') + '/v0/transactions';
  }
}

export async function sendTransactions(endpoint: string, txsBase64: string[], opts?: { skipPreflight?: boolean; preflightCommitment?: string }): Promise<any> {
  const url = buildTransactionsUrl(endpoint);
  const body: any = {
    transactions: txsBase64,
    options: {
      skipPreflight: true,
      preflightCommitment: 'processed',
      ...(opts || {}),
    },
    encoding: 'base64',
  };
  const res = await postJson(url, body);
  return res;
}

export async function sendTransaction(endpoint: string, txBase64: string, opts?: { skipPreflight?: boolean; preflightCommitment?: string }): Promise<any> {
  return sendTransactions(endpoint, [txBase64], opts);
}

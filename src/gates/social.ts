import { logger } from '../logger';

export type SocialInput = {
  name: string;
  symbol: string;
  image?: string;
  twitter?: string;
  description?: string;
};

export type SocialConfig = {
  requireImage: boolean;
  requireTwitterHandleMatch: boolean;
  requireDescription: boolean;
  httpHeadTimeoutMs: number;
};

function alnumLower(s: string) {
  return (s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

export function extractTwitterHandle(url?: string): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    const host = u.hostname.toLowerCase();
    if (!/(^|\.)twitter\.com$/.test(host) && !/(^|\.)x\.com$/.test(host)) return null;
    const parts = u.pathname.split('/').filter(Boolean);
    if (!parts.length) return null;
    const handle = String(parts[0] || '').replace(/^@/, '');
    if (!handle) return null;
    return handle;
  } catch {
    return null;
  }
}

async function headOk(url: string, timeoutMs: number): Promise<boolean> {
  try {
    const ctrl = new AbortController();
    const to = setTimeout(() => ctrl.abort(), timeoutMs);
    let res = await fetch(url, { method: 'HEAD', signal: ctrl.signal } as any).catch(() => null);
    if (!res || !res.ok) {
      // fallback GET if HEAD not allowed by host
      res = await fetch(url, { method: 'GET', redirect: 'follow', signal: ctrl.signal } as any).catch(() => null);
    }
    clearTimeout(to);
    if (!res || !res.ok) return false;
    const headers: any = (res as any).headers;
    const ct = (headers && typeof headers.get === 'function' ? headers.get('content-type') : '')?.toLowerCase?.() || '';
    if (!ct) return true; // accept if no CT
    if (ct.includes('image/')) return true;
    // some hosts return octet-stream; still accept if size > 0
    const lenStr = headers && typeof headers.get === 'function' ? headers.get('content-length') : '0';
    const len = Number(lenStr || '0');
    return len > 0;
  } catch (e) {
    logger.debug('HEAD check failed', { url, err: String((e as any)?.message || e) });
    return false;
  }
}

export async function checkSocial(input: SocialInput, cfg: SocialConfig): Promise<{ pass: boolean; reasons: string[]; info: Record<string, any> }>{
  const reasons: string[] = [];
  const info: Record<string, any> = {};

  // Image required
  if (cfg.requireImage) {
    if (!input.image || !/^https:\/\//i.test(input.image)) {
      reasons.push('no-image');
    } else {
      info.imageOk = await headOk(input.image, cfg.httpHeadTimeoutMs);
      if (!info.imageOk) reasons.push('image-head-fail');
    }
  }

  // Twitter handle must include name or symbol
  if (cfg.requireTwitterHandleMatch) {
    const handle = extractTwitterHandle(input.twitter);
    info.twitterHandle = handle;
    const nm = alnumLower(input.name);
    const sy = alnumLower(input.symbol);
    const hd = alnumLower(handle || '');
    if (!handle) {
      reasons.push('no-twitter');
    } else {
      const ok = (nm && hd.includes(nm)) || (sy && hd.includes(sy));
      if (!ok) reasons.push('twitter-handle-mismatch');
    }
  }

  if (cfg.requireDescription) {
    if (!input.description || !input.description.trim()) reasons.push('no-description');
  }

  return { pass: reasons.length === 0, reasons, info };
}

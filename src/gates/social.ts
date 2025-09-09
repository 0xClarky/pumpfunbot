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
  requireTwitterPresent: boolean; // new: require a twitter link but no handle/name match
  requireDescription: boolean;
  // Legacy head mode (optional)
  httpHeadTimeoutMs?: number;
  // New probe mode
  imageValidationMode: 'head' | 'probe';
  imageProbeTimeoutMs: number;
  imageProbeMaxBytes: number;
  imageGateways: string[];
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

function isDataImage(url?: string): boolean {
  return !!url && /^data:image\//i.test(url);
}

function isIpfsLike(u?: string): boolean {
  if (!u) return false;
  if (/^ipfs:\/\//i.test(u)) return true;
  // CID-ish (very rough): starts with Qm... or baf...
  return /^Qm[1-9A-HJ-NP-Za-km-z]{44}/.test(u) || /^bafy[1-9A-HJ-NP-Za-km-z]{20,}/.test(u);
}

function buildIpfsCandidates(image: string, gateways: string[]): string[] {
  let cid = image;
  if (/^ipfs:\/\//i.test(image)) cid = image.replace(/^ipfs:\/\//i, '').replace(/^ipfs\//i, '');
  if (/^https?:\/\//i.test(image)) return [image];
  // bare CID or ipfs path
  cid = cid.replace(/^ipfs\//i, '');
  return gateways.map((g) => `https://${g.replace(/\/$/, '')}/ipfs/${cid}`);
}

async function probeBytes(url: string, timeoutMs: number, maxBytes: number): Promise<boolean> {
  try {
    const ctrl = new AbortController();
    const to = setTimeout(() => ctrl.abort(), timeoutMs);
    const res = await fetch(url, {
      method: 'GET',
      headers: { Range: `bytes=0-${Math.max(0, maxBytes - 1)}` } as any,
      redirect: 'follow' as any,
      signal: ctrl.signal,
    } as any).catch(() => null);
    clearTimeout(to);
    if (!res || !res.ok) return false;
    const headers: any = (res as any).headers;
    const ct = (headers && typeof headers.get === 'function' ? headers.get('content-type') : '') || '';
    const lenStr = headers && typeof headers.get === 'function' ? headers.get('content-length') : '';
    const lenNum = Number(lenStr || '0');
    if (ct.toLowerCase().includes('image/')) return true;
    if (lenNum > 0) return true;
    // As a last resort, read a tiny buffer
    try {
      const ab = await res.arrayBuffer();
      return (ab && (ab as ArrayBuffer).byteLength > 0);
    } catch {
      return false;
    }
  } catch (e) {
    logger.debug('Image probe failed', { url, err: String((e as any)?.message || e) });
    return false;
  }
}

export async function checkSocial(input: SocialInput, cfg: SocialConfig): Promise<{ pass: boolean; reasons: string[]; info: Record<string, any> }>{
  const reasons: string[] = [];
  const info: Record<string, any> = {};

  // Image required
  if (cfg.requireImage) {
    if (!input.image) {
      reasons.push('no-image');
    } else if (isDataImage(input.image)) {
      info.imageOk = true;
    } else if (cfg.imageValidationMode === 'probe') {
      const candidates = isIpfsLike(input.image)
        ? buildIpfsCandidates(input.image, cfg.imageGateways)
        : [input.image];
      let ok = false;
      for (const url of candidates) {
        if (!/^https?:\/\//i.test(url)) continue;
        if (await probeBytes(url, cfg.imageProbeTimeoutMs, cfg.imageProbeMaxBytes)) { ok = true; break; }
      }
      info.imageOk = ok;
      if (!ok) reasons.push('image-probe-fail');
    } else {
      // legacy head mode
      const urlOk = /^https?:\/\//i.test(input.image);
      if (!urlOk) {
        reasons.push('no-image');
      } else {
        info.imageOk = await headOk(input.image, cfg.httpHeadTimeoutMs || 400);
        if (!info.imageOk) reasons.push('image-head-fail');
      }
    }
  }

  // Twitter requirement
  if (cfg.requireTwitterHandleMatch || cfg.requireTwitterPresent) {
    const handle = extractTwitterHandle(input.twitter);
    info.twitterHandle = handle;
    if (!handle) {
      reasons.push('no-twitter');
    } else if (cfg.requireTwitterHandleMatch) {
      const nm = alnumLower(input.name);
      const sy = alnumLower(input.symbol);
      const hd = alnumLower(handle || '');
      const ok = (nm && hd.includes(nm)) || (sy && hd.includes(sy));
      if (!ok) reasons.push('twitter-handle-mismatch');
    }
  }

  if (cfg.requireDescription) {
    if (!input.description || !input.description.trim()) reasons.push('no-description');
  }

  return { pass: reasons.length === 0, reasons, info };
}

import { Config } from './config';

export type LaunchCandidate = {
  signature: string;
  mint: string;
  creator: string;
  name: string;
  symbol: string;
  uri: string;
  metadata?: {
    description?: string;
    image?: string;
    twitter?: string;
    telegram?: string;
    website?: string;
  } | null;
};

export type FilterResult = {
  accepted: boolean;
  reasons: string[]; // explanations; empty means pass
};

const isAscii = (s: string) => /^[\x20-\x7E]*$/.test(s);
const hasSocial = (m?: LaunchCandidate['metadata']) => {
  if (!m) return false;
  return Boolean(m.twitter || m.telegram || m.website);
};
export function evaluateLaunch(c: LaunchCandidate, cfg: Config): FilterResult {
  const reasons: string[] = [];

  // Whitelists/blacklists first
  if (cfg.whitelistCreators.length && !cfg.whitelistCreators.includes(c.creator)) {
    reasons.push('creator-not-whitelisted');
  }
  if (cfg.blacklistCreators.includes(c.creator)) {
    reasons.push('creator-blacklisted');
  }
  const lcName = (c.name || '').toLowerCase();
  const lcSym = (c.symbol || '').toLowerCase();
  if (cfg.blacklistWords.length) {
    for (const w of cfg.blacklistWords) {
      if (!w) continue;
      if (lcName.includes(w) || lcSym.includes(w)) {
        reasons.push('blacklist-word:' + w);
        break;
      }
    }
  }

  // Basic sanity
  if (!c.name || c.name.length < cfg.nameMin || c.name.length > cfg.nameMax) {
    reasons.push('invalid-name-length');
  }
  if (!c.symbol || c.symbol.length < cfg.symbolMin || c.symbol.length > cfg.symbolMax) {
    reasons.push('invalid-symbol-length');
  }
  if (cfg.filterAsciiOnly) {
    if (c.name && !isAscii(c.name)) reasons.push('name-non-ascii');
    if (c.symbol && !isAscii(c.symbol)) reasons.push('symbol-non-ascii');
  }
  if (!/^https?:\/\//i.test(c.uri)) reasons.push('uri-not-http(s)');

  // Metadata-based
  if (cfg.filterRequireImage && !c.metadata?.image) reasons.push('no-image');
  if (cfg.filterRequireSocial && !hasSocial(c.metadata)) reasons.push('no-social');

  return { accepted: reasons.length === 0, reasons };
}

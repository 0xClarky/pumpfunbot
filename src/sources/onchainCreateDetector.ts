import { Connection, Logs, PublicKey } from '@solana/web3.js';
import { getPumpProgram, PUMP_PROGRAM_ID } from '@pump-fun/pump-sdk';
import { logger } from '../logger';

export type NewLaunchEvent = {
  signature: string;
  slot: number;
  blockTime?: number | null;
  mint: string;
  creator: string;
  name: string;
  symbol: string;
  uri: string;
};

export function startOnchainCreateDetection({
  connection,
  fetchConnection,
  onCreate,
  commitment = 'processed',
}: {
  connection: Connection; // used for WS logs
  fetchConnection?: Connection; // used for HTTP fetch/confirm (default: connection)
  onCreate: (evt: NewLaunchEvent) => void;
  commitment?: 'processed' | 'confirmed';
}): { stop: () => void } {
  let stopped = false;
  let subId: number | null = null;
  const processed = new Set<string>();
  const inFlight = new Set<string>();
  const program = getPumpProgram(connection);

  async function waitSignatureWS(sig: string, commit: 'processed' | 'confirmed', timeoutMs: number): Promise<void> {
    return new Promise((resolve, reject) => {
      let timer: any;
      try {
        const subId = connection.onSignature(
          sig,
          (res: any) => {
            clearTimeout(timer);
            if (res?.err) reject(new Error(`tx-error:${JSON.stringify(res.err)}`));
            else resolve();
          },
          commit,
        );
        timer = setTimeout(() => {
          connection.removeSignatureListener(subId).catch(() => {});
          reject(new Error('ws-timeout'));
        }, timeoutMs);
      } catch (e) {
        reject(e as any);
      }
    });
  }

  function logsHasCreate(logs: Logs): boolean {
    const lines: string[] = (logs as any).logs || [];
    const re = /instruction:\s*create\s*$/i;
    for (const raw of lines) {
      if (typeof raw !== 'string') continue;
      if (re.test(raw)) return true; // only exact "create" instruction lines
    }
    return false;
  }

  async function handleSignature(signature: string, slot: number) {
    const http = fetchConnection || connection;
    if (processed.has(signature) || inFlight.has(signature)) return;
    inFlight.add(signature);
    try {
      // 1) First wait for confirmed via WS (fast and avoids commitment assertions)
      try {
        await waitSignatureWS(signature, 'confirmed', 20000);
      } catch (e) {
        logger.warn('Create tx confirmation (ws) failed or timed out', { sig: signature, err: String((e as any)?.message || e) });
        return;
      }

      // 2) Fetch RAW tx at confirmed using an HTTP connection with confirmed default
      let raw = await http.getTransaction(signature, {
        maxSupportedTransactionVersion: 0,
        commitment: 'confirmed',
      } as any);
      let attempts = 0;
      while (!raw && attempts < 15) {
        await new Promise((r) => setTimeout(r, 150));
        attempts++;
        raw = await http.getTransaction(signature, {
          maxSupportedTransactionVersion: 0,
          commitment: 'confirmed',
        } as any);
      }
      if (!raw) {
        logger.debug('Confirmed tx not available after wait', { sig: signature });
        return;
      }
      if (raw.meta?.err) return;

      // 2) Decode locally from compiled instructions
      const msg: any = raw.transaction.message as any;
      // Build a full account-keys array that includes address-table lookups (v0 txs)
      const toB58 = (k: any): string =>
        typeof k === 'string' ? k : k?.toBase58?.() || (k && 'pubkey' in k ? k.pubkey?.toBase58?.() : String(k));
      const staticKeys: string[] = (msg.staticAccountKeys || msg.accountKeys || []).map(toB58);
      const loadedW: string[] = (raw.meta as any)?.loadedAddresses?.writable?.map(toB58) || [];
      const loadedR: string[] = (raw.meta as any)?.loadedAddresses?.readonly?.map(toB58) || [];
      const allKeys: string[] = [...staticKeys, ...loadedW, ...loadedR];
      const compiled: any[] = (msg.compiledInstructions || msg.instructions || []) as any[];
      const pumpPid = PUMP_PROGRAM_ID.toBase58();
      let createEvent: NewLaunchEvent | null = null;
      let decodedCreate: { name: string; symbol: string; uri: string; creator?: PublicKey } | null = null;
      let mintCandidate: string | null = null;
      let userCandidate: string | null = null;
      const pumpIxDiagnostics: Array<{ idx: number; dataLen: number; name?: string }> = [];

      // Helper to try decode a single compiled ix
      const tryDecode = (ix: any) => {
        const pidIdx = (ix as any).programIdIndex as number | undefined;
        const programId = typeof pidIdx === 'number' && pidIdx >= 0 && pidIdx < allKeys.length ? allKeys[pidIdx] : undefined;
        if (programId !== pumpPid) return false;

        const d = (ix as any).data;
        const dataBuf = typeof d === 'string' ? Buffer.from(d, 'base64') : Buffer.from(d ?? []);
        const acctIdxs: number[] = Array.isArray((ix as any).accounts) ? ((ix as any).accounts as number[]) : [];
        if (!dataBuf.length) return false;

        try {
          const decoded = (program.coder as any).instruction.decode(dataBuf);
          if (!decoded) {
            pumpIxDiagnostics.push({ idx: pumpIxDiagnostics.length, dataLen: dataBuf.length });
            return false;
          }
          if (decoded?.name !== 'create') {
            pumpIxDiagnostics.push({ idx: pumpIxDiagnostics.length, dataLen: dataBuf.length, name: decoded.name });
            return false;
          }
          const { name, symbol, uri, creator } = decoded.data as { name: string; symbol: string; uri: string; creator?: PublicKey };
          decodedCreate = { name, symbol, uri, ...(creator ? { creator } : {}) } as any;
          if (acctIdxs.length > 7) {
            const m = allKeys[Number(acctIdxs[0])];
            const u = allKeys[Number(acctIdxs[7])];
            if (m) mintCandidate = m;
            if (u) userCandidate = u;
          }
          return true;
        } catch {
          return false;
        }
      };

      // 2a) search top-level first
      for (const ix of compiled) {
        const pidIdx = (ix as any).programIdIndex as number | undefined;
        const programId = typeof pidIdx === 'number' && pidIdx >= 0 && pidIdx < allKeys.length ? allKeys[pidIdx] : undefined;
        if (programId !== pumpPid) continue;

        const d = (ix as any).data;
        const dataBuf = typeof d === 'string' ? Buffer.from(d, 'base64') : Buffer.from(d ?? []);
        const acctIdxs: number[] = Array.isArray((ix as any).accounts) ? (ix as any).accounts as number[] : [];
        if (!dataBuf.length) continue;

        try {
          const decoded = (program.coder as any).instruction.decode(dataBuf);
          if (!decoded) {
            pumpIxDiagnostics.push({ idx: pumpIxDiagnostics.length, dataLen: dataBuf.length });
            continue;
          }
          if (decoded?.name !== 'create') {
            pumpIxDiagnostics.push({ idx: pumpIxDiagnostics.length, dataLen: dataBuf.length, name: decoded.name });
            continue;
          }
          const { name, symbol, uri, creator } = decoded.data as {
            name: string;
            symbol: string;
            uri: string;
            creator?: PublicKey;
          };
          decodedCreate = { name, symbol, uri, ...(creator ? { creator } : {}) } as any;
          if (acctIdxs.length > 7) {
            const m = allKeys[Number(acctIdxs[0])];
            const u = allKeys[Number(acctIdxs[7])];
            if (m) mintCandidate = m;
            if (u) userCandidate = u;
          }
          break;
        } catch {
          continue;
        }
      }

      // 2b) fallback: search inner instructions for pump.create
      if (!decodedCreate && (raw.meta as any)?.innerInstructions?.length) {
        for (const inner of (raw.meta as any).innerInstructions) {
          for (const ix of inner.instructions || []) {
            if (tryDecode(ix)) { break; }
          }
          if (decodedCreate) break;
        }
      }

      // If we decoded a create but don't have a mint from accounts, infer from token balances or parsed inner instructions
      if (decodedCreate && !mintCandidate) {
        // 2b-i) Try postTokenBalances (fast, available in raw meta)
        try {
          const postTB: any[] = ((raw.meta as any)?.postTokenBalances || []) as any[];
          const mints = postTB.map((b: any) => b?.mint).filter((m: any) => typeof m === 'string');
          if (mints.length > 0) {
            const counts = new Map<string, number>();
            for (const m of mints) counts.set(m, (counts.get(m) || 0) + 1);
            let best: string | null = null;
            let bestCount = 0;
            for (const [m, c] of counts.entries()) {
              if (c > bestCount) { best = m; bestCount = c; }
            }
            if (best) mintCandidate = best;
          }
        } catch {}
        // 2b-ii) Fallback to parsed inner SPL-Token instructions if needed
        if (!mintCandidate) try {
          let parsed: any = null;
          for (let i = 0; i < 20 && !parsed; i++) {
            parsed = await http.getParsedTransaction(signature, { maxSupportedTransactionVersion: 0, commitment: 'confirmed' } as any);
            if (!parsed) await new Promise((r) => setTimeout(r, 150));
          }
          const inners: any[] = (parsed?.meta as any)?.innerInstructions || [];
          for (const entry of inners) {
            for (const ix of (entry as any).instructions || []) {
              const p = (ix as any).program;
              const t = (ix as any).parsed?.type?.toLowerCase?.() || '';
              const info = (ix as any).parsed?.info || {};
              if (p === 'spl-token' && t.includes('initialize') && (info.mint || info.account)) {
                // Prefer explicit mint, else infer from account init (owner ATA init will include mint too)
                mintCandidate = info.mint || info.account || null;
                // If "account" is picked up from initAccount3, try to read its mint field when present
                if (info.account && info.mint) mintCandidate = info.mint;
                break;
              }
            }
            if (mintCandidate) break;
          }
        } catch {}
      }

      if (decodedCreate && mintCandidate) {
        createEvent = {
          signature,
          slot: raw.slot,
          blockTime: raw.blockTime ?? null,
          mint: mintCandidate,
          creator: decodedCreate.creator?.toBase58?.() || userCandidate || '',
          name: decodedCreate.name,
          symbol: decodedCreate.symbol,
          uri: decodedCreate.uri,
        };
      }

      if (!createEvent) {
        if (pumpIxDiagnostics.length) {
          logger.debug('Pump ix seen but not create', { sig: signature, pumpIxDiagnostics });
        } else {
          logger.debug('No decodable create instruction found in tx', { sig: signature });
        }
        return;
      }

      logger.info('Create detected and confirmed', {
        signature: createEvent.signature,
        mint: createEvent.mint,
        creator: createEvent.creator,
        name: createEvent.name,
        symbol: createEvent.symbol,
      });
      onCreate(createEvent);
      processed.add(signature);
    } catch (e) {
      logger.warn('Create processing failed', { sig: signature, err: String((e as any)?.message || e) });
    } finally {
      inFlight.delete(signature);
    }
  }

  (async () => {
    try {
      subId = await connection.onLogs(PUMP_PROGRAM_ID, (logs: Logs) => {
        if (stopped) return;
        if (logs.err) return;
        if (!logs.signature) return;
        if (!logsHasCreate(logs)) return;
        logger.debug('Create log observed', { sig: logs.signature });
        handleSignature(logs.signature, (logs as any).slot ?? 0);
      }, commitment as any);
      logger.debug('Subscribed to Pump logs', { commitment });
      logger.info('On-chain create detector active', { subId });
    } catch (e) {
      logger.error('Failed to subscribe to Pump logs', { err: String(e) });
    }
  })();

  return {
    stop: () => {
      stopped = true;
      if (subId !== null) connection.removeOnLogsListener(subId).catch(() => {});
    },
  };
}

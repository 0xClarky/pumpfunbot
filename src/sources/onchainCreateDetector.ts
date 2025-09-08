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
  onCreate,
  commitment = 'processed',
}: {
  connection: Connection;
  onCreate: (evt: NewLaunchEvent) => void;
  commitment?: 'processed' | 'confirmed';
}): { stop: () => void } {
  let stopped = false;
  let subId: number | null = null;
  const processed = new Set<string>();
  const inFlight = new Set<string>();
  const program = getPumpProgram(connection);

  function logsHasCreate(logs: Logs): boolean {
    const lines: string[] = (logs as any).logs || [];
    for (const raw of lines) {
      if (typeof raw !== 'string') continue;
      const l = raw.toLowerCase();
      if (l.includes('instruction: create')) return true; // match regardless of prefix/case
    }
    return false;
  }

  async function handleSignature(signature: string, slot: number) {
    if (processed.has(signature) || inFlight.has(signature)) return;
    inFlight.add(signature);
    try {
      // Small initial delay to allow RPC to index + parse
      await new Promise((r) => setTimeout(r, 400));

      // Fetch parsed tx at confirmed with short retries
      let tx = await connection.getParsedTransaction(signature, {
        maxSupportedTransactionVersion: 0,
        commitment: 'confirmed',
      });
      let attempts = 0;
      while (!tx && attempts < 25) {
        await new Promise((r) => setTimeout(r, 200));
        attempts++;
        tx = await connection.getParsedTransaction(signature, {
          maxSupportedTransactionVersion: 0,
          commitment: 'confirmed',
        });
      }
      if (!tx) {
        logger.debug('Create tx not yet available', { sig: signature });
        return;
      }
      if (tx.meta?.err) return;

      const pumpPid = PUMP_PROGRAM_ID.toBase58();
      const tryDecode = (ixs: any[], keys: string[], slot: number, blockTime: number | null): boolean => {
        for (const ix of ixs) {
          const pid = (ix.programId || ix.programIdIndex !== undefined
            ? (ix.programId?.toBase58?.() || keys[ix.programIdIndex])
            : undefined) as string | undefined;
          if (!pid || pid !== pumpPid) continue;
          const dataB64: string | undefined = (ix as any).data;
          const acctIdxs: number[] = ((ix as any).accounts || []) as number[];
          if (!dataB64 || !acctIdxs?.length) continue;
          try {
            const decoded = (program.coder as any).instruction.decode(Buffer.from(dataB64, 'base64'));
            if (!decoded || decoded.name !== 'create') continue;
            if (acctIdxs.length <= 7) continue;
            const mint = keys[Number(acctIdxs[0])];
            const user = keys[Number(acctIdxs[7])];
            if (!mint || !user) continue;
            const { name, symbol, uri, creator } = decoded.data as {
              name: string;
              symbol: string;
              uri: string;
              creator: PublicKey;
            };
            const evt: NewLaunchEvent = {
              signature,
              slot,
              blockTime,
              mint: String(mint),
              creator: (creator?.toBase58?.() as string) || String(user),
              name,
              symbol,
              uri,
            };
            logger.info('Create detected', {
              signature: evt.signature,
              mint: evt.mint,
              creator: evt.creator,
              name: evt.name,
              symbol: evt.symbol,
            });
            onCreate(evt);
            processed.add(signature);
            return true;
          } catch {
            continue;
          }
        }
        return false;
      };

      // Attempt decode from parsed tx
      let msg: any = tx.transaction.message as any;
      let keys: string[] = (msg.accountKeys || []).map((k: any) =>
        typeof k === 'string' ? k : ('pubkey' in k ? k.pubkey.toBase58() : String(k)),
      );
      let ixs: any[] = (msg.instructions || []) as any[];
      let ok = tryDecode(ixs, keys, tx.slot, tx.blockTime ?? null);
      if (ok) return;

      // Brief re-fetch and retry decode in case parsing lags
      for (let i = 0; i < 5 && !ok; i++) {
        await new Promise((r) => setTimeout(r, 200));
        const refreshed = await connection.getParsedTransaction(signature, {
          maxSupportedTransactionVersion: 0,
          commitment: 'confirmed',
        });
        if (refreshed) {
          msg = refreshed.transaction.message as any;
          keys = (msg.accountKeys || []).map((k: any) =>
            typeof k === 'string' ? k : ('pubkey' in k ? k.pubkey.toBase58() : String(k)),
          );
          ixs = (msg.instructions || []) as any[];
          ok = tryDecode(ixs, keys, refreshed.slot, refreshed.blockTime ?? null);
          if (ok) return;
        }
      }

      // Fallback: raw tx decode
      try {
        const raw = await connection.getTransaction(signature, {
          maxSupportedTransactionVersion: 0,
          commitment: 'confirmed',
        } as any);
        if (raw) {
          const msgRaw: any = raw.transaction.message as any;
          const rawKeys: string[] = (msgRaw.accountKeys || msgRaw.staticAccountKeys || []).map((k: any) =>
            typeof k === 'string' ? k : k.toBase58?.() || String(k),
          );
          const rawIxs: any[] = (msgRaw.instructions || msgRaw.compiledInstructions || []) as any[];
          ok = tryDecode(rawIxs, rawKeys, raw.slot, raw.blockTime ?? null);
          if (!ok) {
            // Detailed trace to diagnose shape
            try {
              for (const [idx, rix] of rawIxs.entries()) {
                const pid = rawKeys[(rix as any).programIdIndex];
                if (pid === pumpPid) {
                  const d = (rix as any).data;
                  const b = typeof d === 'string' ? Buffer.from(d, 'base64') : Buffer.alloc(0);
                  const hex = b.slice(0, 12).toString('hex');
                  const accs = ((rix as any).accounts || []).length;
                  logger.debug('Pump ix present but decode failed', { sig: signature, ixIndex: idx, dataLen: b.length, headHex: hex, accounts: accs });
                }
              }
            } catch {}
          }
          if (ok) return;
        }
      } catch (e) {
        logger.debug('Raw tx decode fallback failed', { sig: signature, err: String((e as any)?.message || e) });
      }

      logger.debug('No decodable create instruction found in tx', { sig: signature });
    } catch (e) {
      logger.warn('Create decode failed', { sig: signature, err: String((e as any)?.message || e) });
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

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
      // 1) Fetch RAW tx quickly at processed, with short retries
      let raw = await connection.getTransaction(signature, {
        maxSupportedTransactionVersion: 0,
        commitment: 'processed' as any,
      } as any);
      let attempts = 0;
      while (!raw && attempts < 30) {
        await new Promise((r) => setTimeout(r, 150));
        attempts++;
        raw = await connection.getTransaction(signature, {
          maxSupportedTransactionVersion: 0,
          commitment: 'processed' as any,
        } as any);
      }
      if (!raw) {
        logger.debug('Tx not found at processed yet', { sig: signature });
        return;
      }
      if (raw.meta?.err) return;

      // 2) Decode locally from compiled instructions
      const msg: any = raw.transaction.message as any;
      const staticKeys: string[] = (msg.staticAccountKeys || msg.accountKeys || []).map((k: any) =>
        typeof k === 'string' ? k : k.toBase58?.() || ('pubkey' in k ? k.pubkey.toBase58() : String(k)),
      );
      const compiled: any[] = (msg.compiledInstructions || msg.instructions || []) as any[];
      const pumpPid = PUMP_PROGRAM_ID.toBase58();
      let createEvent: NewLaunchEvent | null = null;

      for (const ix of compiled) {
        const pidIdx = (ix as any).programIdIndex as number | undefined;
        const programId = typeof pidIdx === 'number' && pidIdx >= 0 && pidIdx < staticKeys.length ? staticKeys[pidIdx] : undefined;
        if (programId !== pumpPid) continue;

        const d = (ix as any).data;
        const dataBuf = typeof d === 'string' ? Buffer.from(d, 'base64') : Buffer.from(d ?? []);
        const acctIdxs: number[] = Array.isArray((ix as any).accounts) ? (ix as any).accounts as number[] : [];
        if (!dataBuf.length || acctIdxs.length === 0) continue;

        try {
          const decoded = (program.coder as any).instruction.decode(dataBuf);
          if (!decoded || decoded.name !== 'create') continue;
          if (acctIdxs.length <= 7) continue;
          const mint = staticKeys[Number(acctIdxs[0])];
          const user = staticKeys[Number(acctIdxs[7])];
          if (!mint || !user) continue;
          const { name, symbol, uri, creator } = decoded.data as {
            name: string;
            symbol: string;
            uri: string;
            creator?: PublicKey;
          };
          createEvent = {
            signature,
            slot: raw.slot,
            blockTime: raw.blockTime ?? null,
            mint,
            creator: creator?.toBase58?.() || user,
            name,
            symbol,
            uri,
          };
          break;
        } catch {
          continue;
        }
      }

      if (!createEvent) {
        logger.debug('No decodable create instruction found in tx', { sig: signature });
        return;
      }

      // 3) Confirm before emitting
      try {
        await connection.confirmTransaction(signature, 'confirmed');
      } catch (e) {
        logger.warn('Create tx failed confirmation', { sig: signature, err: String((e as any)?.message || e) });
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

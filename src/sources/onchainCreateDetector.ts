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
      // Fetch at 'confirmed' (some providers disallow 'processed' for this method); retry briefly
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

      // Find the create instruction targeting Pump program
      const msg: any = tx.transaction.message as any;
      const keys: string[] = (msg.accountKeys || []).map((k: any) =>
        typeof k === 'string' ? k : ('pubkey' in k ? k.pubkey.toBase58() : String(k)),
      );

      const pumpPid = PUMP_PROGRAM_ID.toBase58();
      const ixs: any[] = (msg.instructions || []) as any[];
      let decodedOk = false;
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
          // Accounts mapping per IDL order for create; require indices
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
            slot: tx.slot,
            blockTime: tx.blockTime ?? null,
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
          decodedOk = true;
          return; // done
        } catch (e) {
          // not a create instruction, continue searching
          continue;
        }
      }
      if (!decodedOk) {
        logger.debug('No decodable create instruction found in tx', { sig: signature });
      }
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

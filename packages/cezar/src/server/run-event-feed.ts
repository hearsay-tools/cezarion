import { LIVE_BYTE_LIMIT, LIVE_EVENT_LIMIT } from '@open-mercato/cezar-contract/live-limits';
import type { LiveRunBatch, LiveRunDemand, RunEvent } from '@open-mercato/cezar-contract';
import { decodeLiveCursor } from '../runs/event-history.ts';
import { streamHistoryAfter } from '../runs/history-stream.ts';
import type { ProjectContext } from './project-context.ts';

export class LiveFeedReset extends Error {
  readonly status = 413;
}

function parsePersistedRunEvent(line: string): RunEvent | undefined {
  try {
    const value = JSON.parse(line) as RunEvent;
    if (Number.isSafeInteger(value.seq) && typeof value.type === 'string' && typeof value.ts === 'string') return value;
  } catch { /* Malformed historical lines have never belonged to replay. */ }
  return undefined;
}

interface RunEventBatchScan {
  offset: number;
  afterSeq: number;
  events: LiveRunBatch['events'];
  bytes: number;
  hasMore: boolean;
  laterWrites: boolean;
  snapshots: RunEvent[];
  snapshotIndex: number;
  snapshot?: ReturnType<ProjectContext['store']['liveReadSnapshot']>;
}

function acceptRunEvent(scan: RunEventBatchScan, event: RunEvent, length: number, byteLimit: number): boolean {
  if (event.seq <= scan.afterSeq) return true;
  if (length > byteLimit) throw new LiveFeedReset('event exceeds live batch limit — reload history');
  if (scan.events.length >= LIVE_EVENT_LIMIT || scan.bytes + length > byteLimit) {
    scan.hasMore = true;
    return false;
  }
  scan.events.push(event);
  scan.bytes += length;
  scan.afterSeq = event.seq;
  return true;
}

function acceptSnapshotsBefore(scan: RunEventBatchScan, seq: number, byteLimit: number): boolean {
  while (scan.snapshotIndex < scan.snapshots.length && scan.snapshots[scan.snapshotIndex]!.seq < seq) {
    const snapshot = scan.snapshots[scan.snapshotIndex]!;
    if (!acceptRunEvent(scan, snapshot, Buffer.byteLength(JSON.stringify(snapshot)) + 1, byteLimit)) return false;
    scan.snapshotIndex++;
  }
  return true;
}

/** Accept or skip one complete history line and advance the offset, or stop the scan when the batch is full. */
function consumePersistedLine(
  scan: RunEventBatchScan,
  line: Buffer,
  byteLimit: number,
): 'continue' | 'stop' {
  const length = line.length + 1;
  if (length > byteLimit) throw new LiveFeedReset('event exceeds live batch limit — reload history');
  const event = parsePersistedRunEvent(line.toString('utf8'));
  if (event && scan.snapshot && event.seq > scan.snapshot.throughSeq) {
    scan.laterWrites = true;
    return 'stop';
  }
  if (event && event.seq > scan.afterSeq) {
    if (!acceptSnapshotsBefore(scan, event.seq, byteLimit) || !acceptRunEvent(scan, event, length, byteLimit)) {
      return 'stop';
    }
  }
  scan.offset += length;
  return 'continue';
}

/** The returned cursor covers exactly the accepted prefix, including complete ignored lines.
 * Capture sorted live snapshots and their sequence boundary together BEFORE disk IO.
 * Later writes wait for the next capture: otherwise a newer persisted event could
 * acknowledge live content emitted during the scan but absent from the snapshots.
 * Keep the byte offset at the first unaccepted persisted record. */
export async function readRunEventBatch(dataDir: string, demand: LiveRunDemand, signal: AbortSignal, byteLimit = LIVE_BYTE_LIMIT, snapshot?: ReturnType<ProjectContext['store']['liveReadSnapshot']>): Promise<LiveRunBatch> {
  signal.throwIfAborted();
  const start = demand.cursor ? decodeLiveCursor(demand.cursor) : { offset: 0, boundarySeq: 0 };
  const scan: RunEventBatchScan = {
    offset: start.offset,
    afterSeq: Math.max(demand.afterSeq, start.boundarySeq),
    events: [],
    bytes: 0,
    hasMore: false,
    laterWrites: false,
    snapshots: snapshot?.events ?? [],
    snapshotIndex: 0,
    ...(snapshot ? { snapshot } : {}),
  };
  let pending: Buffer = Buffer.alloc(0);
  outer: for await (const chunk of streamHistoryAfter(dataDir, demand.runId, scan.offset, signal)) {
    pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
    let boundary: number;
    while ((boundary = pending.indexOf(10)) !== -1) {
      signal.throwIfAborted();
      const line = pending.subarray(0, boundary);
      if (consumePersistedLine(scan, line, byteLimit) === 'stop') break outer;
      pending = pending.subarray(boundary + 1);
    }
    if (pending.length > byteLimit) throw new LiveFeedReset('event exceeds live batch limit — reload history');
  }
  signal.throwIfAborted();
  if (!scan.hasMore) acceptSnapshotsBefore(scan, Infinity, byteLimit);
  // No newline means a writer is still appending: do not acknowledge that partial record.
  return {
    type: 'batch', projectId: demand.projectId, runId: demand.runId, events: scan.events, afterSeq: scan.afterSeq, hasMore: scan.hasMore || scan.laterWrites,
    cursor: Buffer.from(JSON.stringify({ v: 1, kind: 'live', offset: scan.offset, boundarySeq: scan.afterSeq })).toString('base64url'),
  };
}

/** Freeze the finite scan even for a cold store with no in-memory sequence yet.
 * Observing its first new write gives the upper boundary without rebuilding an
 * entire cold/compressed transcript just to discover its final sequence. */
export async function readFiniteRunFeed(
  context: Pick<ProjectContext, 'store' | 'dataDir'>, demand: LiveRunDemand, signal: AbortSignal,
): Promise<LiveRunBatch> {
  const snapshot = context.store.liveReadSnapshot(demand.runId);
  const bound = ({ runId, event }: { runId: string; event: RunEvent }) => {
    if (runId === demand.runId) snapshot.throughSeq = Math.min(snapshot.throughSeq, event.seq - 1);
  };
  context.store.on('event', bound);
  try { return await readRunEventBatch(context.dataDir, demand, signal, LIVE_BYTE_LIMIT, snapshot); }
  finally { context.store.off('event', bound); }
}

/** Attach before reading; serialize replay and live writes; bound slow-client memory. */
export async function subscribeRunFeed(
  context: Pick<ProjectContext, 'store' | 'dataDir'>,
  demand: LiveRunDemand,
  handlers: { event(event: RunEvent): Promise<void>; reset(reason: string, status?: 409 | 413): void },
  signal: AbortSignal,
  byteLimit = LIVE_BYTE_LIMIT,
): Promise<void> {
  if (signal.aborted) return;
  const controller = new AbortController();
  const stop = () => controller.abort();
  signal.addEventListener('abort', stop, { once: true });
  const stopped = new Promise<void>(resolve => { controller.signal.addEventListener('abort', () => resolve(), { once: true }); });
  const write = async (event: RunEvent) => {
    await Promise.race([handlers.event(event), stopped]);
    controller.signal.throwIfAborted();
  };
  let maxSeq = demand.afterSeq;
  let pendingBytes = 0;
  let pending: RunEvent[] = [];
  let wake: (() => void) | undefined;
  const reset = (reason: string, status: 409 | 413 = 409) => { if (!controller.signal.aborted) { stop(); handlers.reset(reason, status); } };
  const onEvent = ({ runId, event }: { runId: string; event: RunEvent }) => {
    if (runId !== demand.runId || event.seq <= maxSeq || controller.signal.aborted) return;
    pendingBytes += Buffer.byteLength(JSON.stringify(event));
    if (pendingBytes > byteLimit) { reset('live buffer exceeded — reload history'); return; }
    pending.push(event);
    wake?.();
  };
  const onDeleted = (id: string) => { if (id === demand.runId) reset('run removed'); };
  const onClosed = () => reset('project removed');
  context.store.on('closed', onClosed);
  context.store.on('event', onEvent);
  context.store.on('deleted', onDeleted);
  const detached = () => {
    context.store.off('closed', onClosed);
    context.store.off('event', onEvent);
    context.store.off('deleted', onDeleted);
    pending = [];
    wake?.();
  };
  controller.signal.addEventListener('abort', detached, { once: true });
  try {
    let cursor = demand.cursor;
    do {
      const batch = await readRunEventBatch(context.dataDir, { ...demand, ...(cursor ? { cursor } : {}), afterSeq: maxSeq }, controller.signal, byteLimit);
      for (const event of batch.events) {
        controller.signal.throwIfAborted();
        if (event.seq <= maxSeq) continue;
        await write(event);
        maxSeq = event.seq;
      }
      maxSeq = Math.max(maxSeq, batch.afterSeq);
      cursor = batch.cursor;
      if (!batch.hasMore) break;
    } while (!controller.signal.aborted);
    while (!controller.signal.aborted) {
      // RunStore assigns one monotonic clock per run; ignore duplicate/reordered replays.
      const event = pending.shift();
      if (event) {
        pendingBytes -= Buffer.byteLength(JSON.stringify(event));
        if (event.seq > maxSeq) { await write(event); maxSeq = event.seq; }
      } else {
        await new Promise<void>(resolve => { wake = resolve; });
        wake = undefined;
      }
    }
  } catch (error) {
    if (!controller.signal.aborted) reset(error instanceof Error ? error.message : 'feed failed', error instanceof LiveFeedReset ? 413 : 409);
  } finally {
    stop();
    detached();
    signal.removeEventListener('abort', stop);
  }
}

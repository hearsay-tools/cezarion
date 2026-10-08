import { LIVE_BYTE_LIMIT, LIVE_EVENT_LIMIT, type LiveRunBatch, type LiveRunDemand, type RunEvent } from '@open-mercato/cezar-contract';
import { decodeLiveCursor } from '../runs/event-history.ts';
import { streamHistoryAfter } from '../runs/history-stream.ts';
import type { ProjectContext } from './project-context.ts';

export class LiveFeedReset extends Error {
  readonly status = 413;
}

/** The returned cursor covers exactly the accepted prefix, including complete ignored lines. */
export async function readRunEventBatch(dataDir: string, demand: LiveRunDemand, signal: AbortSignal, byteLimit = LIVE_BYTE_LIMIT): Promise<LiveRunBatch> {
  signal.throwIfAborted();
  const start = demand.cursor ? decodeLiveCursor(demand.cursor) : { offset: 0, boundarySeq: 0 };
  let offset = start.offset;
  let afterSeq = Math.max(demand.afterSeq, start.boundarySeq);
  const events: LiveRunBatch['events'] = [];
  let bytes = 0;
  let pending: Buffer = Buffer.alloc(0);
  let hasMore = false;
  outer: for await (const chunk of streamHistoryAfter(dataDir, demand.runId, offset, signal)) {
    pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
    let boundary: number;
    while ((boundary = pending.indexOf(10)) !== -1) {
      signal.throwIfAborted();
      const length = boundary + 1;
      if (length > byteLimit) throw new LiveFeedReset('event exceeds live batch limit — reload history');
      const line = pending.subarray(0, boundary).toString('utf8');
      let event: RunEvent | undefined;
      try {
        const value = JSON.parse(line) as RunEvent;
        if (Number.isSafeInteger(value.seq) && typeof value.type === 'string' && typeof value.ts === 'string') event = value;
      } catch { /* Malformed historical lines have never belonged to replay. */ }
      if (event && event.seq > afterSeq) {
        if (events.length >= LIVE_EVENT_LIMIT || bytes + length > byteLimit) { hasMore = true; break outer; }
        events.push(event);
        bytes += length;
        afterSeq = event.seq;
      }
      offset += length;
      pending = pending.subarray(length);
    }
    if (pending.length > byteLimit) throw new LiveFeedReset('event exceeds live batch limit — reload history');
  }
  // No newline means a writer is still appending: do not acknowledge that partial record.
  return {
    type: 'batch', projectId: demand.projectId, runId: demand.runId, events, afterSeq, hasMore,
    cursor: Buffer.from(JSON.stringify({ v: 1, kind: 'live', offset, boundarySeq: afterSeq })).toString('base64url'),
  };
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

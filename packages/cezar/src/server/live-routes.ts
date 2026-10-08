import { Hono, type MiddlewareHandler } from 'hono';
import { streamSSE } from 'hono/streaming';
import { LIVE_BYTE_LIMIT, liveRunsRequestSchema, type LiveRunBatchResult, type LiveRunFrame, type LiveRunDemand } from '@open-mercato/cezar-contract';
import { HistoryCursorError } from '../runs/event-history.ts';
import { CockpitAlreadyRunningError } from './cockpit-ownership.ts';
import { RunStoreOpenError } from '../runs/store-open-error.ts';
import { isV2WireEventType } from '../runs/ui-event-sink.ts';
import { ProjectContextError, type ProjectContext } from './project-context.ts';
import { jsonZodValidator } from './validators.ts';
import { LiveFeedReset, readFiniteRunFeed, subscribeRunFeed } from './run-event-feed.ts';

type ResolvedProject = Pick<ProjectContext, 'id' | 'store' | 'dataDir'>;
interface LiveRouteDeps {
  resolveProject(id: string): Promise<ResolvedProject>;
  serverGeneration: string;
  resolveBootProject(): Promise<string>;
}

function failure(demand: LiveRunDemand, error: unknown): Exclude<LiveRunBatchResult, { type: 'batch' }> {
  const identity = { projectId: demand.projectId, runId: demand.runId };
  if (error instanceof HistoryCursorError || error instanceof LiveFeedReset) {
    return { ...identity, type: 'reset', status: error.status, error: error.message };
  }
  if (error instanceof ProjectContextError) {
    return { ...identity, type: 'error', status: error.reason === 'unknown-project' ? 404 : 409, error: error.message };
  }
  if (error instanceof RunStoreOpenError || error instanceof CockpitAlreadyRunningError) {
    return { ...identity, type: 'error', status: 409, error: error.message };
  }
  return { ...identity, type: 'error', status: 503, error: 'run feed unavailable' };
}

export function createLiveRoutes({ resolveProject, serverGeneration, resolveBootProject }: LiveRouteDeps) {
  const resolve = async (demand: LiveRunDemand, signal: AbortSignal) => {
    signal.throwIfAborted();
    const project = await resolveProject(demand.projectId);
    signal.throwIfAborted();
    if (project.store.unavailable) throw project.store.unavailable;
    return { project, demand: { ...demand, projectId: project.id } };
  };
  const canonicalDemand: MiddlewareHandler<{}, string, { out: { json: { runs: LiveRunDemand[] } } }> = async (c, next) => {
    const boot = await resolveBootProject();
    const runs = c.req.valid('json').runs;
    const keys = runs.map(run => `${run.projectId === 'default' ? boot : run.projectId}/${run.runId}`);
    if (new Set(keys).size !== keys.length) return c.json({ error: 'duplicate run demand' }, 400);
    await next();
  };
  return new Hono()
    .post('/workspace/run-event-batches', jsonZodValidator(liveRunsRequestSchema), canonicalDemand, async c => {
      const results: LiveRunBatchResult[] = [];
      // Sequential reads cap decompression/IO and make cancellation effective between demands.
      for (const raw of c.req.valid('json').runs) {
        let demand = raw;
        try {
          const resolved = await resolve(demand, c.req.raw.signal);
          demand = resolved.demand;
          if (!resolved.project.store.getRun(demand.runId)) {
            results.push({ projectId: demand.projectId, runId: demand.runId, type: 'error', status: 404, error: 'run not found' });
          } else results.push(await readFiniteRunFeed(resolved.project, demand, c.req.raw.signal));
        } catch (error) {
          c.req.raw.signal.throwIfAborted();
          results.push(failure(demand, error));
        }
      }
      return c.json({ generation: serverGeneration, results });
    })
    .post('/workspace/run-events', jsonZodValidator(liveRunsRequestSchema), canonicalDemand, c => {
      const demands = c.req.valid('json').runs;
      const response = streamSSE(c, async stream => {
        const controller = new AbortController();
        const stop = () => controller.abort();
        stream.onAbort(stop);
        c.req.raw.signal.addEventListener('abort', stop, { once: true });
        if (c.req.raw.signal.aborted) stop();
        let queuedBytes = 0;
        let writes = Promise.resolve();
        const send = (frame: LiveRunFrame): Promise<void> => {
          if (controller.signal.aborted) return Promise.resolve();
          const data = JSON.stringify(frame);
          const size = Buffer.byteLength(`event: live\ndata: ${data}\n\n`);
          // A single undeliverable event needs scoped history recovery. Closing the
          // whole stream would reconnect forever at exactly the same cursor.
          if (size > LIVE_BYTE_LIMIT) throw new LiveFeedReset('event exceeds live frame limit — reload history');
          // Closing a slow stream forces replay from document-owned cursors. Never drop a
          // frame and leave the stream looking healthy, nor queue unbounded Hono writes.
          if (queuedBytes + size > LIVE_BYTE_LIMIT) { stop(); void stream.close(); return Promise.resolve(); }
          queuedBytes += size;
          const next = writes.then(async () => {
            if (!controller.signal.aborted) await stream.writeSSE({ event: 'live', data });
          }).finally(() => { queuedBytes -= size; });
          writes = next.catch(() => { stop(); });
          return writes;
        };
        const feeds: Promise<void>[] = [];
        try {
          for (const raw of demands) {
            let demand = raw;
            try {
              const resolved = await resolve(demand, controller.signal);
              demand = resolved.demand;
              if (!resolved.project.store.getRun(demand.runId)) {
                await send({ projectId: demand.projectId, runId: demand.runId, type: 'error', status: 404, error: 'run not found' });
                continue;
              }
              const { projectId, runId } = demand;
              feeds.push(subscribeRunFeed(resolved.project, demand, {
                event: event => send({ type: 'event', projectId, runId, name: isV2WireEventType(event.type) ? 'ui-event' : 'run-event', event }),
                reset: (error, status = 409) => { void send({ type: 'reset', projectId, runId, status, error }); },
              }, controller.signal));
            } catch (error) {
              if (controller.signal.aborted) break;
              await send(failure(demand, error));
            }
          }
          await send({ type: 'ready', generation: serverGeneration });
          while (!controller.signal.aborted) {
            await send({ type: 'ping' });
            await new Promise<void>(resolve => {
              if (controller.signal.aborted) { resolve(); return; }
              const done = () => { clearTimeout(timer); controller.signal.removeEventListener('abort', done); resolve(); };
              const timer = setTimeout(done, 15_000);
              controller.signal.addEventListener('abort', done, { once: true });
            });
          }
        } finally {
          stop();
          await Promise.allSettled(feeds);
          c.req.raw.signal.removeEventListener('abort', stop);
        }
      });
      response.headers.set('Cache-Control', 'no-cache, no-transform');
      response.headers.set('X-Accel-Buffering', 'no');
      return response;
    });
}

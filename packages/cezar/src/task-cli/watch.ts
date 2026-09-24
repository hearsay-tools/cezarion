import {
  apiRunSchema,
  runRecordSchema,
  type ApiRun,
  type RunHistoryEvent,
  type RunStatus,
} from '@open-mercato/cezar-contract';
import { invalidResponse, refuse, request, TaskCliError, type Cockpit } from './http.ts';
import { SUCCESS_STATUSES, TERMINAL_STATUSES } from './projections.ts';

/**
 * Watching a task from a terminal (#504, spec 2026-09-24-cez-task-cli). Every loop here ends —
 * on a terminal status or at the caller's deadline — because a bot's tool call that never
 * returns is the failure this command family exists to prevent.
 */

export const DEFAULT_POLL_MS = 1_500;
const MAX_FIELD_CHARS = 2_000;

export type WaitMode = 'any' | 'all';
export type WaitUntil = 'settled' | 'attention';

export interface WaitEntry {
  id: string;
  status: RunStatus | 'missing';
  activity?: string;
  hasPendingHumanAsk?: boolean;
}

export interface WaitResult {
  exitCode: number;
  runs: WaitEntry[];
  timedOut: boolean;
}

function entryFor(id: string, run: ApiRun | undefined): WaitEntry {
  if (!run) return { id, status: 'missing' };
  return {
    id,
    status: run.status,
    ...(run.activity === undefined ? {} : { activity: run.activity }),
    hasPendingHumanAsk: run.hasPendingHumanAsk ?? false,
  };
}

/** Settled = nothing more will happen without a human; `missing` counts, it will never change. */
function isSettled(entry: WaitEntry, until: WaitUntil): boolean {
  if (entry.status === 'missing' || TERMINAL_STATUSES.includes(entry.status)) return true;
  return until === 'attention' && (entry.status === 'waiting' || entry.hasPendingHumanAsk === true);
}

/** A failure is only a terminal non-success; stopping for attention is not one. */
function isFailure(entry: WaitEntry): boolean {
  return entry.status === 'missing' || entry.status === 'failed' || entry.status === 'cancelled';
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Polls `GET /runs`: one call covers any number of runs and holds no socket open. */
export async function waitForRuns(
  cockpit: Cockpit,
  ids: string[],
  options: { mode: WaitMode; until: WaitUntil; timeoutMs: number; pollMs?: number },
): Promise<WaitResult> {
  const deadline = Date.now() + options.timeoutMs;
  for (;;) {
    const result = await request(cockpit, '/runs');
    if (result.status !== 200) refuse(result);
    const runs = apiRunSchema.array().safeParse(result.data);
    if (!runs.success) invalidResponse('run list');
    const byId = new Map(runs.data.map((run) => [run.id, run]));
    const entries = ids.map((id) => entryFor(id, byId.get(id)));
    const settled = entries.filter((entry) => isSettled(entry, options.until));
    const done = options.mode === 'any' ? settled.length > 0 : settled.length === entries.length;
    if (done) {
      const judged = options.mode === 'any' ? settled : entries;
      return { exitCode: judged.some(isFailure) && (options.mode === 'all' || judged.every(isFailure)) ? 1 : 0, runs: entries, timedOut: false };
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) return { exitCode: 3, runs: entries, timedOut: true };
    await sleep(Math.min(options.pollMs ?? DEFAULT_POLL_MS, remaining));
  }
}

const LOG_TYPES = new Set(['text', 'tool-call', 'tool-result', 'step-start', 'error', 'user-message']);

function clip(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return text.length > MAX_FIELD_CHARS ? `${text.slice(0, MAX_FIELD_CHARS - 1)}…` : text;
}

/** One printable line per event the log keeps, or undefined for the rest. */
export function logLine(event: RunHistoryEvent): Record<string, unknown> | undefined {
  if (!LOG_TYPES.has(event.type)) return undefined;
  const fields: Record<string, unknown> = {
    seq: event.seq,
    ts: event.ts,
    type: event.type,
    ...(event.stepId === undefined ? {} : { stepId: event.stepId }),
  };
  switch (event.type) {
    case 'text':
    case 'user-message':
      fields.text = clip(event.text);
      break;
    case 'tool-call':
      fields.tool = event.tool;
      fields.input = clip(event.input);
      break;
    case 'tool-result':
      fields.result = clip(event.result);
      break;
    case 'step-start':
      fields.name = event.name;
      if (event.iteration !== undefined) fields.iteration = event.iteration;
      break;
    case 'error':
      fields.message = clip(event.message);
      break;
  }
  return Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined));
}

/** Keeps the newest lines within `maxChars` (counting the newline between lines). */
class LineTail {
  private lines: string[] = [];
  private size = 0;
  constructor(private readonly maxChars: number) {}
  push(line: string): void {
    this.lines.push(line);
    this.size += line.length + (this.lines.length > 1 ? 1 : 0);
    while (this.size > this.maxChars && this.lines.length) {
      const dropped = this.lines.shift()!;
      this.size -= dropped.length + (this.lines.length ? 1 : 0);
    }
  }
  drain(): string[] {
    const lines = this.lines;
    this.lines = [];
    this.size = 0;
    return lines;
  }
}

interface SseFrame { event: string; data: string }

/** Minimal SSE framing: `event:` / `data:` fields, blank-line separated. */
async function* sseFrames(body: ReadableStream<Uint8Array>): AsyncGenerator<SseFrame> {
  const decoder = new TextDecoder();
  let buffer = '';
  for await (const chunk of body) {
    buffer += decoder.decode(chunk, { stream: true }).replace(/\r\n/g, '\n');
    let boundary: number;
    while ((boundary = buffer.indexOf('\n\n')) >= 0) {
      const block = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      let event = 'message';
      const data: string[] = [];
      for (const line of block.split('\n')) {
        if (line.startsWith('event:')) event = line.slice(6).trim();
        else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
      }
      yield { event, data: data.join('\n') };
    }
  }
}

/**
 * `log`, read from the run's SSE stream: the server replays every event after `afterSeq`, then
 * sends one `run` frame. Everything before that frame is the tail, bounded to `maxChars`. Without
 * `follow` the command ends there; with it, live events stream until a terminal `run` frame
 * (exit 0/1, final line is the status) or the deadline (exit 3). Deduped by `seq` throughout.
 *
 * The stream rather than `GET /history`: a history page starts at its first transcript item, so
 * it drops lifecycle events such as the opening `step-start`.
 */
export async function readLog(
  cockpit: Cockpit,
  id: string,
  options: { afterSeq: number; maxChars: number; follow: boolean; timeoutMs: number; print: (line: string) => void },
): Promise<number> {
  const tail = new LineTail(options.maxChars);
  let replaying = true;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs);
  let lastSeq = options.afterSeq;
  let status: RunStatus | undefined;
  try {
    let response: Response;
    try {
      response = await fetch(`${cockpit.api}/runs/${encodeURIComponent(id)}/events?afterSeq=${lastSeq}`, {
        redirect: 'error', signal: controller.signal, headers: { accept: 'text/event-stream' },
      });
    } catch (error) {
      if (controller.signal.aborted) return timedOut();
      throw new TaskCliError(2, { code: 'unavailable', error: `cockpit request failed: ${error instanceof Error ? error.message : String(error)}` });
    }
    if (!response.ok || !response.body) {
      const text = await response.text().catch(() => '');
      let data: unknown = text;
      try { data = JSON.parse(text); } catch { /* not JSON */ }
      refuse({ status: response.status, data });
    }
    try {
      for await (const frame of sseFrames(response.body)) {
        if (frame.event === 'run-event') {
          const event = JSON.parse(frame.data) as RunHistoryEvent;
          if (typeof event.seq !== 'number' || event.seq <= lastSeq) continue;
          lastSeq = event.seq;
          const line = logLine(event);
          if (!line) continue;
          if (replaying) tail.push(JSON.stringify(line));
          else options.print(JSON.stringify(line));
        } else if (frame.event === 'run') {
          const run = runRecordSchema.safeParse(JSON.parse(frame.data));
          if (!run.success) continue;
          status = run.data.status;
          if (replaying) {
            replaying = false;
            for (const line of tail.drain()) options.print(line);
            if (!options.follow) return 0;
          }
          if (TERMINAL_STATUSES.includes(status)) {
            options.print(JSON.stringify({ id, status, timedOut: false }));
            return SUCCESS_STATUSES.includes(status) ? 0 : 1;
          }
        }
      }
    } catch (error) {
      if (!controller.signal.aborted) throw error;
    }
    if (controller.signal.aborted) return timedOut();
    throw new TaskCliError(2, { code: 'unavailable', error: 'the cockpit closed the event stream' });
  } finally {
    clearTimeout(timer);
    controller.abort();
  }

  function timedOut(): number {
    for (const line of tail.drain()) options.print(line);
    options.print(JSON.stringify({ id, ...(status === undefined ? {} : { status }), timedOut: true }));
    return 3;
  }
}

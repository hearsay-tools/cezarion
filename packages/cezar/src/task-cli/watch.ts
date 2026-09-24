import {
  apiRunSchema,
  runHistoryPageSchema,
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
  /** `unknown`: the deadline passed before any poll answered. */
  status: RunStatus | 'missing' | 'unknown';
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
  if (entry.status === 'unknown') return false;
  if (entry.status === 'missing' || TERMINAL_STATUSES.includes(entry.status)) return true;
  return until === 'attention' && (entry.status === 'waiting' || entry.hasPendingHumanAsk === true);
}

/** A failure is only a terminal non-success; stopping for attention is not one. */
function isFailure(entry: WaitEntry): boolean {
  return entry.status === 'missing' || entry.status === 'failed' || entry.status === 'cancelled';
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Grace for the millisecond race between a budget-bounded poll's abort and the
 * deadline check (#538): `AbortSignal.timeout(budget)` can fire while
 * `Date.now()` still reads just under the deadline, turning a timeout into an
 * `unavailable` error (exit 2 instead of 3). A poll whose own abort consumed
 * (almost) all of its budget failed *at* the deadline, so it answers "timed
 * out". The grace never applies to other errors: a genuine failure stays
 * `unavailable` even when it lands inside the grace window.
 */
export const TIMEOUT_GRACE_MS = 250;

export function pollHitDeadline(startedAt: number, budgetMs: number, now: number = Date.now()): boolean {
  return now - startedAt >= budgetMs - TIMEOUT_GRACE_MS;
}

/**
 * True when the wrapped cockpit error came from the poll's own abort (its
 * budget running out) rather than a fast failure such as a refused
 * connection. `fetchJson` folds every fetch failure into `unavailable`, so the
 * abort surfaces only through the original message it preserves (`TimeoutError:
 * The operation was aborted due to timeout`).
 */
export function abortedPoll(error: unknown): boolean {
  if (!(error instanceof TaskCliError)) return false;
  const body = error.body as { error?: unknown };
  return /abort|timeout/i.test(String(body.error ?? ''));
}

/**
 * Polls `GET /runs`: one call covers any number of runs and holds no socket open. Each poll is
 * bounded by what is left of the deadline, so a slow cockpit answers "timed out" on time rather
 * than holding the caller for a full request timeout.
 */
export async function waitForRuns(
  cockpit: Cockpit,
  ids: string[],
  options: { mode: WaitMode; until: WaitUntil; timeoutMs: number; pollMs?: number },
): Promise<WaitResult> {
  const deadline = Date.now() + options.timeoutMs;
  let entries: WaitEntry[] = ids.map((id) => ({ id, status: 'unknown' }));
  for (;;) {
    const budget = deadline - Date.now();
    if (budget <= 0) return { exitCode: 3, runs: entries, timedOut: true };
    const pollStart = Date.now();
    let result;
    try {
      result = await request(cockpit, '/runs', { timeoutMs: budget });
    } catch (error) {
      if (Date.now() >= deadline) return { exitCode: 3, runs: entries, timedOut: true };
      if (abortedPoll(error) && pollHitDeadline(pollStart, budget)) return { exitCode: 3, runs: entries, timedOut: true };
      throw error;
    }
    if (result.status !== 200) refuse(result);
    const runs = apiRunSchema.array().safeParse(result.data);
    if (!runs.success) invalidResponse('run list');
    const byId = new Map(runs.data.map((run) => [run.id, run]));
    entries = ids.map((id) => entryFor(id, byId.get(id)));
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
 * `log`, read from the run's SSE stream, which replays every event after `afterSeq` and then
 * streams live. The route subscribes to live `run` updates BEFORE it replays, so a `run` frame
 * says nothing about where the replay is; the only reliable boundary is a `seq`. So:
 *
 * - the replay ends at `asOfSeq`, the event file's high-water mark read from `GET /history` just
 *   before connecting — everything up to it is the tail, bounded to `maxChars`, and without
 *   `follow` the command ends there;
 * - with `follow`, a terminal status ends the command only once the stream has caught up with a
 *   SECOND high-water read taken after that status arrived, so events the engine wrote just
 *   before finishing are not dropped when the status frame overtakes them (exit 0/1, final line
 *   is the status).
 *
 * One `deadline` bounds every request, the history reads included (exit 3). Deduped by `seq`.
 * The stream rather than `GET /history` pages: a history page starts at its first transcript
 * item, so it drops lifecycle events such as the opening `step-start`.
 */
export async function readLog(
  cockpit: Cockpit,
  id: string,
  options: { afterSeq: number; maxChars: number; follow: boolean; deadline: number; print: (line: string) => void },
): Promise<number> {
  const tail = new LineTail(options.maxChars);
  const remaining = () => options.deadline - Date.now();
  let lastSeq = options.afterSeq;
  let seenSeq = options.afterSeq;
  let status: RunStatus | undefined;
  let drainSeq: number | undefined;

  /** The event file's high-water mark, or undefined once the deadline has passed. */
  const highWater = async (): Promise<number | undefined> => {
    const budget = remaining();
    if (budget <= 0) return undefined;
    const startedAt = Date.now();
    let history;
    try {
      history = await request(cockpit, `/runs/${encodeURIComponent(id)}/history`, { timeoutMs: budget });
    } catch (error) {
      if (remaining() <= 0) return undefined;
      if (abortedPoll(error) && pollHitDeadline(startedAt, budget)) return undefined;
      throw error;
    }
    if (history.status !== 200) refuse(history);
    const page = runHistoryPageSchema.safeParse(history.data);
    return page.success ? page.data.asOfSeq : invalidResponse('history');
  };

  const boundarySeq = await highWater();
  if (boundarySeq === undefined) return timedOut();
  let replaying = boundarySeq > options.afterSeq;
  if (!replaying && !options.follow) return 0;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(remaining(), 0));
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
        if (frame.event === 'run-event' || frame.event === 'ui-event') {
          const event = JSON.parse(frame.data) as RunHistoryEvent;
          if (typeof event.seq !== 'number') continue;
          // Both streams share the file's seq space, so either one can reach a boundary;
          // only v1 lines are printed, deduped by seq.
          seenSeq = Math.max(seenSeq, event.seq);
          if (frame.event === 'run-event' && event.seq > lastSeq) {
            lastSeq = event.seq;
            const line = logLine(event);
            if (line) {
              if (replaying) tail.push(JSON.stringify(line));
              else options.print(JSON.stringify(line));
            }
          }
        } else if (frame.event === 'run') {
          const run = runRecordSchema.safeParse(JSON.parse(frame.data));
          if (run.success) status = run.data.status;
        }
        let exit = step();
        if (exit === 'drain') {
          drainSeq = await highWater();
          if (drainSeq === undefined) return timedOut();
          exit = step();
        }
        if (typeof exit === 'number') return exit;
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

  /** Ends the replay at its boundary; then a terminal status ends the command once drained. */
  function step(): number | 'drain' | undefined {
    if (replaying && seenSeq >= boundarySeq!) {
      replaying = false;
      for (const line of tail.drain()) options.print(line);
      if (!options.follow) return 0;
    }
    if (replaying || status === undefined || !TERMINAL_STATUSES.includes(status)) return undefined;
    if (drainSeq === undefined) return 'drain';
    if (seenSeq < drainSeq) return undefined;
    options.print(JSON.stringify({ id, status, timedOut: false }));
    return SUCCESS_STATUSES.includes(status) ? 0 : 1;
  }

  function timedOut(): number {
    for (const line of tail.drain()) options.print(line);
    options.print(JSON.stringify({ id, ...(status === undefined ? {} : { status }), timedOut: true }));
    return 3;
  }
}

import {
  ATTENTION_RANK,
  apiRunSchema,
  toRunSummary,
  runHistoryPageSchema,
  runRecordSchema,
  runSummarySchema,
  type RunSummary,
  type RunHistoryEvent,
  type RunStatus,
} from '@open-mercato/cezar-contract';
import { invalidResponse, refuse, request, TaskCliError, type Cockpit } from './http.ts';
import { attentionFields, TERMINAL_STATUSES, type AttentionFields } from './projections.ts';

/**
 * Watching a task from a terminal (#504, spec 2026-09-24-cez-task-cli). Every loop here ends —
 * on a terminal status, on the attention `--until` asks for, or at the caller's deadline —
 * because a bot's tool call that never returns is the failure this command family exists to
 * prevent.
 */

export const DEFAULT_POLL_MS = 1_500;
const MAX_FIELD_CHARS = 2_000;

export type WaitMode = 'any' | 'all';
/**
 * What ends a wait (#553/#609):
 *  - `attention` (the default): a terminal status, a missing run, OR the cockpit's attention
 *    function putting the run in a bucket that wants a human — `waiting` ("needs you"/"needs
 *    review"), `error`, `permission`. A root parked on its own workers ("waiting on 2 workers")
 *    and a `running`/`monitoring` run are NOT attention, exactly as the cockpit shows them.
 *  - `settled`: a terminal status or a missing run only. The opt-in for autonomous runs and for
 *    bots that want terminal state; a `waiting` park does not end it.
 */
export type WaitUntil = 'settled' | 'attention';
export const DEFAULT_WAIT_UNTIL: WaitUntil = 'attention';

export interface WaitEntry extends Partial<AttentionFields> {
  id: string;
  /** `unknown`: the deadline passed before any poll answered. */
  status: RunStatus | 'missing' | 'unknown';
  activity?: string;
  hasPendingHumanAsk?: boolean;
}

export interface WaitResult {
  exitCode: number;
  /** The `--until` that was in force, so a reader of the output knows what ended (or did not end) it. */
  until: WaitUntil;
  runs: WaitEntry[];
  timedOut: boolean;
}

function entryFor(id: string, run: RunSummary | undefined): WaitEntry {
  if (!run) return { id, status: 'missing' };
  return {
    id,
    status: run.status,
    ...(run.activity === undefined ? {} : { activity: run.activity }),
    ...attentionFields(run),
    hasPendingHumanAsk: run.hasPendingHumanAsk ?? false,
  };
}

/**
 * Whether this entry ends the wait. `settled` = nothing more will happen without a human;
 * `missing` counts, it will never change. `attention` adds the buckets the cockpit's Needs You
 * derives from — the SAME function, so the CLI and the cockpit cannot disagree about a run
 * parked on its workers (bucket `none`, keeps waiting) or one monitoring (bucket `running`).
 */
export function endsWait(entry: WaitEntry, until: WaitUntil): boolean {
  if (entry.status === 'unknown') return false;
  if (entry.status === 'missing' || TERMINAL_STATUSES.includes(entry.status)) return true;
  return until === 'attention' && entry.attention !== undefined && ATTENTION_RANK[entry.attention] <= ATTENTION_RANK.waiting;
}

/** What `deriveAttention` reads, as one comparable key: a change in any of it can move the run. */
function attentionKey(entry: WaitEntry): string {
  return JSON.stringify([entry.status, entry.activity, entry.hasPendingHumanAsk, entry.attention, entry.attentionLabel]);
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
 * The project's run list as summaries (#817). A cockpit older than the summary route answers it
 * 404 (an `apply` waiting for its restart, or a remote cockpit on an older release), and the CLI
 * then reads the full `GET /runs` it always read and projects it the same way the server would,
 * inside what is left of the same deadline. Any other refusal passes through.
 *
 * `archived: 'recent'` asks for the window (#864): every unarchived run plus the newest archived
 * roots. A cockpit older than the window ignores the parameter and answers every run, which is
 * still correct for a caller that filters archived runs out.
 */
export async function requestRunSummaries(cockpit: Cockpit, timeoutMs?: number, options: { archived?: 'recent' | 'all' } = {}): Promise<RunSummary[]> {
  const start = Date.now();
  const path = options.archived === 'recent' ? '/run-summaries?archived=recent' : '/run-summaries';
  const result = await request(cockpit, path, timeoutMs === undefined ? {} : { timeoutMs });
  if (result.status === 404) {
    const left = timeoutMs === undefined ? undefined : Math.max(1, timeoutMs - (Date.now() - start));
    const full = await request(cockpit, '/runs', left === undefined ? {} : { timeoutMs: left });
    if (full.status !== 200) refuse(full);
    const runs = apiRunSchema.array().safeParse(full.data);
    return runs.success ? runs.data.map((run) => toRunSummary(run)) : invalidResponse('run list');
  }
  if (result.status !== 200) refuse(result);
  const runs = runSummarySchema.array().safeParse(result.data);
  return runs.success ? runs.data : invalidResponse('run list');
}

/**
 * Polls `GET /run-summaries` (#817): one call covers any number of runs and holds no socket open. Each poll is
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
    const timedOut = (): WaitResult => ({ exitCode: 3, until: options.until, runs: entries, timedOut: true });
    if (budget <= 0) return timedOut();
    const pollStart = Date.now();
    let result;
    try {
      result = await requestRunSummaries(cockpit, budget);
    } catch (error) {
      if (Date.now() >= deadline) return timedOut();
      if (abortedPoll(error) && pollHitDeadline(pollStart, budget)) return timedOut();
      throw error;
    }
    const byId = new Map(result.map((run) => [run.id, run]));
    entries = ids.map((id) => entryFor(id, byId.get(id)));
    const ended = entries.filter((entry) => endsWait(entry, options.until));
    const done = options.mode === 'any' ? ended.length > 0 : ended.length === entries.length;
    if (done) {
      // 0 when every judged run is done/review or stopped for attention; 1 on failed/cancelled/missing.
      const judged = options.mode === 'any' ? ended : entries;
      return { exitCode: judged.some(isFailure) && (options.mode === 'all' || judged.every(isFailure)) ? 1 : 0, until: options.until, runs: entries, timedOut: false };
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) return timedOut();
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
 * - with `follow`, the end is judged the way `wait` judges it (#931): `endsWait` over an entry
 *   built by `entryFor` from a run read (`GET /runs/:id`), so `--until attention` (the default)
 *   also stops on a run that needs its caller, and `--until settled` only on a terminal status.
 *   The run is read once after the replay boundary and again whenever a `run` frame changes what
 *   attention reads; never on a timer;
 * - the deciding run ends the command only once the stream has caught up with a SECOND high-water
 *   read taken after that decision, so events the engine wrote just before parking or finishing
 *   are not dropped when the status frame overtakes them (exit 0/1, the final line is the
 *   judged run with `until`). A deleted run (`missing`, exit 1) has no history left to drain, and
 *   its feed closes without a `run` frame, so a closed stream is checked against a run read
 *   before it is reported as the cockpit failing (exit 2).
 *
 * One `deadline` bounds every request, the history reads included (exit 3). Deduped by `seq`.
 * The stream rather than `GET /history` pages: a history page starts at its first transcript
 * item, so it drops lifecycle events such as the opening `step-start`.
 */
export async function readLog(
  cockpit: Cockpit,
  id: string,
  options: { afterSeq: number; maxChars: number; follow: boolean; until: WaitUntil; deadline: number; print: (line: string) => void },
): Promise<number> {
  const tail = new LineTail(options.maxChars);
  const remaining = () => options.deadline - Date.now();
  let lastSeq = options.afterSeq;
  let seenSeq = options.afterSeq;
  let status: RunStatus | undefined;
  let drainSeq: number | undefined;
  /** The newest run read, what the attention key of the newest `run` frame was, and whether a read is owed. */
  let judged: WaitEntry | undefined;
  let frameKey: string | undefined;
  let readOwed = false;
  let decided: WaitEntry | undefined;

  /** One budget-bounded read; undefined once the deadline has passed. */
  const bounded = async (path: string) => {
    const budget = remaining();
    if (budget <= 0) return undefined;
    const startedAt = Date.now();
    try {
      return await request(cockpit, path, { timeoutMs: budget });
    } catch (error) {
      if (remaining() <= 0) return undefined;
      if (abortedPoll(error) && pollHitDeadline(startedAt, budget)) return undefined;
      throw error;
    }
  };

  /** The event file's high-water mark, or undefined once the deadline has passed. */
  const highWater = async (): Promise<number | undefined> => {
    const history = await bounded(`/runs/${encodeURIComponent(id)}/history`);
    if (history === undefined) return undefined;
    if (history.status !== 200) refuse(history);
    const page = runHistoryPageSchema.safeParse(history.data);
    return page.success ? page.data.asOfSeq : invalidResponse('history');
  };

  /** The run as `wait` sees it (a 404 is `missing`), or undefined once the deadline has passed. */
  const readRun = async (): Promise<WaitEntry | undefined> => {
    const result = await bounded(`/runs/${encodeURIComponent(id)}`);
    if (result === undefined) return undefined;
    if (result.status === 404) return entryFor(id, undefined);
    if (result.status !== 200) refuse(result);
    const run = apiRunSchema.safeParse(result.data);
    return run.success ? entryFor(id, toRunSummary(run.data)) : invalidResponse('run');
  };

  const boundarySeq = await highWater();
  if (boundarySeq === undefined) return timedOut();
  let replaying = boundarySeq > options.afterSeq;
  if (!replaying && !options.follow) return 0;
  // Nothing to replay: the boundary is already behind us, so the first run read is owed now.
  readOwed = !replaying;
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
          if (run.success) {
            status = run.data.status;
            // Only a change in what attention reads owes a run read; a repeated frame does not.
            const key = attentionKey(entryFor(id, toRunSummary(run.data)));
            if (key !== frameKey) { frameKey = key; readOwed = true; }
          }
        }
        let exit = step();
        if (exit === 'judge') {
          const entry = await readRun();
          if (entry === undefined) return timedOut();
          judged = entry;
          readOwed = false;
          if (endsWait(entry, options.until)) decided = entry;
          exit = step();
        }
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
    // Deleting a run resets its feed and closes the stream without a `run` frame, so a follow
    // asks whether the run is still there before calling the close a cockpit failure.
    if (options.follow) {
      const entry = await readRun();
      if (entry === undefined) return timedOut();
      if (entry.status === 'missing') {
        for (const line of tail.drain()) options.print(line);
        return finish(entry);
      }
    }
    throw new TaskCliError(2, { code: 'unavailable', error: 'the cockpit closed the event stream' });
  } finally {
    clearTimeout(timer);
    controller.abort();
  }

  /**
   * Ends the replay at its boundary (and owes the first run read there); then a run read that
   * `endsWait` accepts ends the command once drained.
   */
  function step(): number | 'judge' | 'drain' | undefined {
    if (replaying && seenSeq >= boundarySeq!) {
      replaying = false;
      readOwed = true;
      for (const line of tail.drain()) options.print(line);
      if (!options.follow) return 0;
    }
    if (replaying) return undefined;
    if (decided === undefined) return readOwed ? 'judge' : undefined;
    // A deleted run's history is gone with it: there is nothing left to drain.
    if (decided.status === 'missing') return finish(decided);
    if (drainSeq === undefined) return 'drain';
    if (seenSeq < drainSeq) return undefined;
    return finish(decided);
  }

  function finish(entry: WaitEntry): number {
    options.print(JSON.stringify(finalLine(entry, false)));
    return isFailure(entry) ? 1 : 0;
  }

  /** `{ id, status, attention, attentionLabel, until, timedOut }`, the run fields as far as known. */
  function finalLine(entry: WaitEntry | undefined, timedOut: boolean) {
    const known = entry ?? (status === undefined ? undefined : { status });
    return {
      id,
      ...(known === undefined ? {} : { status: known.status }),
      ...(entry?.attention === undefined ? {} : { attention: entry.attention, attentionLabel: entry.attentionLabel }),
      until: options.until,
      timedOut,
    };
  }

  function timedOut(): number {
    for (const line of tail.drain()) options.print(line);
    // Without --follow the line is unchanged (#931 changes only the follow loop).
    options.print(JSON.stringify(options.follow ? finalLine(judged, true) : { id, ...(status === undefined ? {} : { status }), timedOut: true }));
    return 3;
  }
}

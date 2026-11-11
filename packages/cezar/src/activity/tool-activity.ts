import type { ActivityTool } from '@open-mercato/cezar-contract';
import { ACTIVITY_RATE_SECONDS, ACTIVITY_TOOL_TITLE_MAX } from '@open-mercato/cezar-contract/activity';
import { isLiveStatus } from '@open-mercato/cezar-contract/run-predicates';
import type { ToolStatus, UiEvent, UiToolItem } from '../core/ui-events.ts';
import type { RunRecord, RunStore } from '../runs/store.ts';
import type { ToolActivitySource } from './read-model.ts';
import { clampText } from './text.ts';

const TERMINAL: ReadonlySet<ToolStatus> = new Set(['completed', 'failed', 'declined']);
/** How many completed tool item ids an entry remembers. */
export const TOOL_ACTIVITY_COMPLETED_IDS = 64;
/** An entry with no event for this long, and no tool in flight, is pruned. */
export const TOOL_ACTIVITY_IDLE_MS = 60_000;

/**
 * What a feed needs from a run store: the run changes it drops runs on, the store's redactor, and
 * a run's current record, read once when an event would create the run's entry.
 */
export interface ToolActivityStore extends Pick<RunStore, 'redactText' | 'getRun'> {
  on(event: 'run', listener: (run: RunRecord) => void): unknown;
  on(event: 'deleted', listener: (runId: string) => void): unknown;
  off(event: 'run', listener: (run: RunRecord) => void): unknown;
  off(event: 'deleted', listener: (runId: string) => void): unknown;
}

/** One run manager's way into the tracker: the UI event sinks of its runs feed it. */
export interface ToolActivityFeed {
  /** One UI event of a run of this store, redacted with the store's own redactor. */
  observe(runId: string, event: UiEvent): void;
  /** The manager is disposed: stop listening, drop this feed's entries, and ignore later events. */
  detach(): void;
}

/** A feed, as the entries it made name it. */
interface FeedOwner {
  /** Whether the run is not live right now: an entry it creates starts marked stopped. */
  stopped(runId: string): boolean;
}

interface RunActivity {
  /** The latest tool item: its id and what the view shows of it. */
  latest?: { itemId: string; tool: ActivityTool };
  /** Tool items seen and not ended yet: a later event of one of them is not a new call. */
  open: Set<string>;
  /**
   * The last `TOOL_ACTIVITY_COMPLETED_IDS` tool items that completed, oldest first. A mapper can
   * complete one item twice (opencode completes a task at its child's idle and again with the task
   * result): a later event of a completed item is not a new call.
   */
  completed: string[];
  /** Tool calls started per second, oldest first; the last bucket is `second`. */
  buckets: number[];
  /** The epoch second of the newest bucket. */
  second: number;
  /** When the run's last tool event arrived, or when it stopped. */
  lastEventAt: number;
  /** The run left the live set: the entry holds no tool from before, only late events after. */
  stopped?: true;
  /** The feed that made the entry; its detach drops it. */
  owner?: FeedOwner;
}

/**
 * The latest tool call and the tool-call rate of every run this process runs (spec
 * 2026-11-05-live-activity-view, Tool activity tracker). It lives in memory only (D6): a restart
 * starts it empty. It stores the title the task thread shows, never a tool's input or output.
 */
export class ToolActivityTracker implements ToolActivitySource {
  private readonly runs = new Map<string, RunActivity>();
  private readonly now: () => number;
  /** The second of the last prune sweep: observe() sweeps at most once a second. */
  private sweptSecond = Number.NEGATIVE_INFINITY;
  private readonly listeners = new Set<() => void>();

  constructor(options: { now?: () => number } = {}) {
    this.now = options.now ?? Date.now;
  }

  /**
   * One UI event of `runId`, as its UI event sink handles it. Only tool items count. The sink sees
   * the event before the run store redacts it, so `redact` is the run store's own redactor (the
   * transcript's policy): a title is redacted first and clamped after, and no part of a secret
   * that the clamp would cut can stay.
   */
  observe(runId: string, event: UiEvent, redact: (text: string) => string): void {
    this.record(undefined, runId, event, redact);
  }

  /** Call `listener` after any change of the latest tool a read shows: a new call, its status, its
   *  end or its title. The activity topics listen while they have subscribers. Returns the release. */
  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  private changed(): void {
    for (const listener of [...this.listeners]) listener();
  }

  private record(owner: FeedOwner | undefined, runId: string, event: UiEvent, redact: (text: string) => string): void {
    if (event.type !== 'item.started' && event.type !== 'item.updated' && event.type !== 'item.completed') return;
    if (event.item.kind !== 'tool') return;
    // Every change of what read() shows replaces the latest tool object: a new call, a status, an
    // end, a title (also of a completed or backgrounded call). One comparison signals them all.
    const before = this.runs.get(runId)?.latest?.tool;
    this.apply(owner, runId, event.type, event.item, redact);
    if (this.runs.get(runId)?.latest?.tool !== before) this.changed();
  }

  private apply(owner: FeedOwner | undefined, runId: string, type: 'item.started' | 'item.updated' | 'item.completed', item: UiToolItem,
    redact: (text: string) => string): void {
    const at = this.now();
    this.sweep(at);
    // Only the completion closes an item: an update to a terminal status may still be followed by it.
    const closes = type === 'item.completed';
    const terminal = closes || TERMINAL.has(item.status);
    const run = this.runs.get(runId);
    if (run) run.lastEventAt = at;
    if (item.background) {
      this.backgrounded(runId, item, at);
      return;
    }
    if (run && repeated(run, item, redact)) return;
    if (!run?.open.has(item.id)) {
      this.started(runId, item, at, { terminal, closes, owner, title: toolTitle(item, redact) });
      return;
    }
    if (closes) {
      run.open.delete(item.id);
      remember(run, item.id);
    }
    const latest = run.latest;
    if (latest?.itemId !== item.id) return;
    // A mapper replaces a placeholder title, or sets the final one only at completion.
    const title = item.title ? { title: toolTitle(item, redact) } : {};
    latest.tool = terminal
      ? { ...latest.tool, ...title, status: item.status, endedAt: latest.tool.endedAt ?? iso(at) }
      : { ...latest.tool, ...title, status: item.status };
  }

  /**
   * The run's latest tool and its rate, the ring shifted to `now`; undefined when it ran no tool
   * or has stopped.
   */
  read(runId: string, now: number): { tool?: ActivityTool; rate: readonly number[] } | undefined {
    const run = this.runs.get(runId);
    if (!run) return undefined;
    if (idle(run, now)) {
      this.runs.delete(runId);
      return undefined;
    }
    if (run.stopped) return undefined;
    shift(run, secondOf(now));
    return { ...(run.latest ? { tool: { ...run.latest.tool } } : {}), rate: [...run.buckets] };
  }

  /** Forget a run: it left the active set. */
  drop(runId: string): void {
    this.runs.delete(runId);
  }

  /**
   * The feed of one run manager over its `store`. A run change out of the live set drops the run's
   * tool activity and leaves a stop marker in its place; a deletion drops the entry. A session can
   * still emit events after the stop (a worker is cancelled before its session shuts down): they
   * land in the marked entry, which read() never shows, and the read model shows tool activity
   * only for a live run anyway. A run change back into the live set (a resume) clears a marked
   * entry, so a resumed run starts empty. A marker with no tool in flight is pruned like any idle
   * entry, after 60 s; an event that would then create a new entry for a run that is still not
   * live creates it marked stopped again, so a resume clears it however late it came.
   */
  attach(store: ToolActivityStore): ToolActivityFeed {
    const owner: FeedOwner = {
      // The held record for a live run: one read, only when an event would create an entry.
      stopped: (runId) => {
        const run = store.getRun(runId);
        return run === undefined || !isLiveStatus(run.status);
      },
    };
    let attached = true;
    const onRun = (run: RunRecord) => {
      if (isLiveStatus(run.status)) {
        if (this.runs.get(run.id)?.stopped) this.runs.delete(run.id);
      } else {
        this.stop(run.id, owner);
      }
    };
    const onDeleted = (runId: string) => this.drop(runId);
    store.on('run', onRun);
    store.on('deleted', onDeleted);
    const redact = (text: string) => store.redactText(text);
    return {
      observe: (runId, event) => {
        if (attached) this.record(owner, runId, event, redact);
      },
      detach: () => {
        if (!attached) return;
        attached = false;
        store.off('run', onRun);
        store.off('deleted', onDeleted);
        for (const [runId, run] of this.runs) if (run.owner === owner) this.runs.delete(runId);
      },
    };
  }

  /** Replace the run's entry with an empty, marked one: the run left the live set. */
  private stop(runId: string, owner: FeedOwner): void {
    const at = this.now();
    this.sweep(at);
    this.runs.set(runId, { open: new Set(), completed: [], buckets: zeros(), second: secondOf(at), lastEventAt: at, stopped: true, owner });
  }

  /** Prune every idle entry, at most once a second. Reads prune the run they read. */
  private sweep(at: number): void {
    const second = secondOf(at);
    if (second === this.sweptSecond) return;
    this.sweptSecond = second;
    for (const [runId, run] of this.runs) if (idle(run, at)) this.runs.delete(runId);
  }

  /** The first event of a tool item: one call, and the latest tool. A tool first seen at its end counts once. */
  private started(runId: string, item: UiToolItem, at: number, { terminal, closes, owner, title }: { terminal: boolean; closes: boolean; owner: FeedOwner | undefined; title: string }): void {
    let run = this.runs.get(runId);
    if (!run) {
      // A late event of a run that is no longer live (its stop marker already idled out) creates an
      // entry marked stopped, so the run's next live transition clears it.
      run = { open: new Set(), completed: [], buckets: zeros(), second: secondOf(at), lastEventAt: at, ...(owner ? { owner } : {}), ...(owner?.stopped(runId) ? { stopped: true as const } : {}) };
      this.runs.set(runId, run);
    }
    shift(run, secondOf(at));
    const newest = ACTIVITY_RATE_SECONDS - 1;
    run.buckets[newest] = (run.buckets[newest] ?? 0) + 1;
    run.latest = {
      itemId: item.id,
      tool: { title, toolKind: item.toolKind, status: item.status, startedAt: iso(at), ...(terminal ? { endedAt: iso(at) } : {}) },
    };
    if (closes) remember(run, item.id);
    else run.open.add(item.id);
  }

  /**
   * A background subagent is not a tool call (the background row of `core/ui-parity.test.ts`
   * marks its item): the item never counts and never becomes the latest tool. When the spawn
   * call was already the latest tool (Claude marks it background only after the call returns),
   * the call has ended: the child runs on its own.
   */
  private backgrounded(runId: string, item: UiToolItem, at: number): void {
    const run = this.runs.get(runId);
    if (!run) return;
    run.open.delete(item.id);
    const latest = run.latest;
    if (latest?.itemId === item.id && latest.tool.endedAt === undefined) {
      latest.tool = { ...latest.tool, status: 'completed', endedAt: iso(at) };
    }
  }
}

/**
 * A later event of a tool item that already completed: it is not a new call. Only a new title of
 * the latest tool counts; its status and times stay as they ended. True when the item was known.
 */
function repeated(run: RunActivity, item: UiToolItem, redact: (text: string) => string): boolean {
  if (!run.completed.includes(item.id)) return false;
  if (run.latest?.itemId === item.id && item.title) run.latest.tool = { ...run.latest.tool, title: toolTitle(item, redact) };
  return true;
}

/** Remember a completed tool item, forgetting the oldest beyond the bound. */
function remember(run: RunActivity, itemId: string): void {
  run.completed.push(itemId);
  if (run.completed.length > TOOL_ACTIVITY_COMPLETED_IDS) run.completed.shift();
}

/** Move the ring forward to `second`: one empty bucket for each second that passed. */
function shift(run: RunActivity, second: number): void {
  const passed = second - run.second;
  if (passed <= 0) return;
  if (passed >= ACTIVITY_RATE_SECONDS) {
    run.buckets.fill(0);
  } else {
    run.buckets.splice(0, passed);
    run.buckets.push(...Array.from({ length: passed }, () => 0));
  }
  run.second = second;
}

/**
 * No tool event for `TOOL_ACTIVITY_IDLE_MS` and no tool in flight: a tool that has not ended
 * (pending or running) keeps its entry however long it runs.
 */
const idle = (run: RunActivity, now: number): boolean =>
  now - run.lastEventAt >= TOOL_ACTIVITY_IDLE_MS && (run.latest === undefined || run.latest.tool.endedAt !== undefined);

const secondOf = (ms: number): number => Math.floor(ms / 1000);
const zeros = (): number[] => Array.from({ length: ACTIVITY_RATE_SECONDS }, () => 0);
const iso = (ms: number): string => new Date(ms).toISOString();
const toolTitle = (item: UiToolItem, redact: (text: string) => string): string => clampText(redact(item.title), ACTIVITY_TOOL_TITLE_MAX);

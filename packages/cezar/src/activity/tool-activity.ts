import type { ActivityTool } from '@open-mercato/cezar-contract';
import { ACTIVITY_RATE_SECONDS, ACTIVITY_TOOL_TITLE_MAX } from '@open-mercato/cezar-contract/activity';
import { isLiveStatus } from '@open-mercato/cezar-contract/run-predicates';
import type { ToolStatus, UiEvent, UiToolItem } from '../core/ui-events.ts';
import type { RunRecord, RunStore } from '../runs/store.ts';
import type { ToolActivitySource } from './read-model.ts';
import { clampText } from './text.ts';

const TERMINAL: ReadonlySet<ToolStatus> = new Set(['completed', 'failed', 'declined']);
/** An entry with no event for this long, and no tool in flight, is pruned. */
export const TOOL_ACTIVITY_IDLE_MS = 60_000;

/** What a feed needs from a run store: the run changes it drops runs on, and the store's redactor. */
export interface ToolActivityStore extends Pick<RunStore, 'redactText'> {
  on(event: 'run', listener: (run: RunRecord) => void): unknown;
  on(event: 'deleted', listener: (runId: string) => void): unknown;
  off(event: 'run', listener: (run: RunRecord) => void): unknown;
  off(event: 'deleted', listener: (runId: string) => void): unknown;
}

/** One run manager's way into the tracker: the UI event sinks of its runs feed it. */
export interface ToolActivityFeed {
  /** One UI event of a run of this store, redacted with the store's own redactor. */
  observe(runId: string, event: UiEvent): void;
  /** The manager is disposed: stop listening, drop the runs this feed fed, and ignore later events. */
  detach(): void;
}

interface RunActivity {
  /** The latest tool item: its id and what the view shows of it. */
  latest?: { itemId: string; tool: ActivityTool };
  /** Tool items seen and not ended yet: a later event of one of them is not a new call. */
  open: Set<string>;
  /** Tool calls started per second, oldest first; the last bucket is `second`. */
  buckets: number[];
  /** The epoch second of the newest bucket. */
  second: number;
  /** When the run's last tool event arrived. */
  lastEventAt: number;
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
    if (event.type !== 'item.started' && event.type !== 'item.updated' && event.type !== 'item.completed') return;
    if (event.item.kind !== 'tool') return;
    const item = event.item;
    const at = this.now();
    this.sweep(at);
    // Only the completion closes an item: an update to a terminal status may still be followed by it.
    const closes = event.type === 'item.completed';
    const terminal = closes || TERMINAL.has(item.status);
    const run = this.runs.get(runId);
    if (run) run.lastEventAt = at;
    if (item.background) {
      this.backgrounded(runId, item, at);
      return;
    }
    if (!run?.open.has(item.id)) {
      this.started(runId, item, at, { terminal, closes, title: toolTitle(item, redact) });
      return;
    }
    if (closes) run.open.delete(item.id);
    const latest = run.latest;
    if (latest?.itemId !== item.id) return;
    // A mapper replaces a placeholder title, or sets the final one only at completion.
    const title = item.title ? { title: toolTitle(item, redact) } : {};
    latest.tool = terminal
      ? { ...latest.tool, ...title, status: item.status, endedAt: latest.tool.endedAt ?? iso(at) }
      : { ...latest.tool, ...title, status: item.status };
  }

  /** The run's latest tool and its rate, the ring shifted to `now`; undefined when it ran no tool. */
  read(runId: string, now: number): { tool?: ActivityTool; rate: readonly number[] } | undefined {
    const run = this.runs.get(runId);
    if (!run) return undefined;
    if (idle(run, now)) {
      this.runs.delete(runId);
      return undefined;
    }
    shift(run, secondOf(now));
    return { ...(run.latest ? { tool: { ...run.latest.tool } } : {}), rate: [...run.buckets] };
  }

  /** Forget a run: it left the active set. */
  drop(runId: string): void {
    this.runs.delete(runId);
  }

  /**
   * The feed of one run manager over its `store`. A run that leaves the live set or is deleted is
   * dropped on that run change. A session can still emit events after the drop (a worker is
   * cancelled before its session shuts down); such an entry is harmless, because the read model
   * shows tool activity only for a live run, and the idle prune removes it.
   */
  attach(store: ToolActivityStore): ToolActivityFeed {
    /** Runs this feed has fed and not dropped yet: detach drops them. */
    const fed = new Set<string>();
    let attached = true;
    const forget = (runId: string) => {
      if (fed.delete(runId)) this.drop(runId);
    };
    const onRun = (run: RunRecord) => {
      if (!isLiveStatus(run.status)) forget(run.id);
    };
    store.on('run', onRun);
    store.on('deleted', forget);
    const redact = (text: string) => store.redactText(text);
    return {
      observe: (runId, event) => {
        if (!attached) return;
        this.observe(runId, event, redact);
        if (this.runs.has(runId)) fed.add(runId);
      },
      detach: () => {
        if (!attached) return;
        attached = false;
        store.off('run', onRun);
        store.off('deleted', forget);
        for (const runId of fed) this.drop(runId);
        fed.clear();
      },
    };
  }

  /** Prune every idle entry, at most once a second. Reads prune the run they read. */
  private sweep(at: number): void {
    const second = secondOf(at);
    if (second === this.sweptSecond) return;
    this.sweptSecond = second;
    for (const [runId, run] of this.runs) if (idle(run, at)) this.runs.delete(runId);
  }

  /** The first event of a tool item: one call, and the latest tool. A tool first seen at its end counts once. */
  private started(runId: string, item: UiToolItem, at: number, { terminal, closes, title }: { terminal: boolean; closes: boolean; title: string }): void {
    let run = this.runs.get(runId);
    if (!run) {
      run = { open: new Set(), buckets: Array.from({ length: ACTIVITY_RATE_SECONDS }, () => 0), second: secondOf(at), lastEventAt: at };
      this.runs.set(runId, run);
    }
    shift(run, secondOf(at));
    const newest = ACTIVITY_RATE_SECONDS - 1;
    run.buckets[newest] = (run.buckets[newest] ?? 0) + 1;
    run.latest = {
      itemId: item.id,
      tool: { title, toolKind: item.toolKind, status: item.status, startedAt: iso(at), ...(terminal ? { endedAt: iso(at) } : {}) },
    };
    if (!closes) run.open.add(item.id);
  }

  /**
   * A background subagent is not a tool call (AGENT_PROTOCOL.md §6): its item never counts and
   * never becomes the latest tool. When the spawn call was already the latest tool (Claude marks
   * it background only after the call returns), the call has ended: the child runs on its own.
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
const iso = (ms: number): string => new Date(ms).toISOString();
const toolTitle = (item: UiToolItem, redact: (text: string) => string): string => clampText(redact(item.title), ACTIVITY_TOOL_TITLE_MAX);

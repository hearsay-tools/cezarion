import type { ActivityTool } from '@open-mercato/cezar-contract';
import { ACTIVITY_RATE_SECONDS, ACTIVITY_TOOL_TITLE_MAX } from '@open-mercato/cezar-contract/activity';
import { isLiveStatus } from '@open-mercato/cezar-contract/run-predicates';
import type { ToolStatus, UiEvent, UiToolItem } from '../core/ui-events.ts';
import type { RunRecord } from '../runs/store.ts';
import type { ToolActivitySource } from './read-model.ts';
import { clampText } from './text.ts';

const TERMINAL: ReadonlySet<ToolStatus> = new Set(['completed', 'failed', 'declined']);

/** The run-change events the tracker drops a run on: a status out of the live set, or deletion. */
export interface ToolActivityRunEvents {
  on(event: 'run', listener: (run: RunRecord) => void): unknown;
  on(event: 'deleted', listener: (runId: string) => void): unknown;
  off(event: 'run', listener: (run: RunRecord) => void): unknown;
  off(event: 'deleted', listener: (runId: string) => void): unknown;
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
}

/**
 * The latest tool call and the tool-call rate of every run this process runs (spec
 * 2026-11-05-live-activity-view, Tool activity tracker). It lives in memory only (D6): a restart
 * starts it empty. It stores the title the task thread shows, never a tool's input or output.
 */
export class ToolActivityTracker implements ToolActivitySource {
  private readonly runs = new Map<string, RunActivity>();
  private readonly now: () => number;

  constructor(options: { now?: () => number } = {}) {
    this.now = options.now ?? Date.now;
  }

  /** One UI event of `runId`, as its UI event sink handles it. Only tool items count. */
  observe(runId: string, event: UiEvent): void {
    if (event.type !== 'item.started' && event.type !== 'item.updated' && event.type !== 'item.completed') return;
    if (event.item.kind !== 'tool') return;
    const item = event.item;
    const at = this.now();
    // Only the completion closes an item: an update to a terminal status may still be followed by it.
    const closes = event.type === 'item.completed';
    const terminal = closes || TERMINAL.has(item.status);
    if (item.background) {
      this.backgrounded(runId, item, at);
      return;
    }
    const run = this.runs.get(runId);
    if (!run?.open.has(item.id)) {
      this.started(runId, item, at, { terminal, closes });
      return;
    }
    if (closes) run.open.delete(item.id);
    const latest = run.latest;
    if (latest?.itemId !== item.id) return;
    // A mapper replaces a placeholder title, or sets the final one only at completion.
    const title = item.title ? { title: toolTitle(item) } : {};
    latest.tool = terminal
      ? { ...latest.tool, ...title, status: item.status, endedAt: latest.tool.endedAt ?? iso(at) }
      : { ...latest.tool, ...title, status: item.status };
  }

  /** The run's latest tool and its rate, the ring shifted to `now`; undefined when it ran no tool. */
  read(runId: string, now: number): { tool?: ActivityTool; rate: readonly number[] } | undefined {
    const run = this.runs.get(runId);
    if (!run) return undefined;
    shift(run, secondOf(now));
    return { ...(run.latest ? { tool: { ...run.latest.tool } } : {}), rate: [...run.buckets] };
  }

  /** Forget a run: it left the active set. */
  drop(runId: string): void {
    this.runs.delete(runId);
  }

  /** Drop each run of `store` that leaves the live set or is deleted, on the run change itself. */
  watch(store: ToolActivityRunEvents): () => void {
    const onRun = (run: RunRecord) => {
      if (!isLiveStatus(run.status)) this.drop(run.id);
    };
    const onDeleted = (runId: string) => this.drop(runId);
    store.on('run', onRun);
    store.on('deleted', onDeleted);
    return () => {
      store.off('run', onRun);
      store.off('deleted', onDeleted);
    };
  }

  /** The first event of a tool item: one call, and the latest tool. A tool first seen at its end counts once. */
  private started(runId: string, item: UiToolItem, at: number, { terminal, closes }: { terminal: boolean; closes: boolean }): void {
    let run = this.runs.get(runId);
    if (!run) {
      run = { open: new Set(), buckets: Array.from({ length: ACTIVITY_RATE_SECONDS }, () => 0), second: secondOf(at) };
      this.runs.set(runId, run);
    }
    shift(run, secondOf(at));
    const newest = ACTIVITY_RATE_SECONDS - 1;
    run.buckets[newest] = (run.buckets[newest] ?? 0) + 1;
    run.latest = {
      itemId: item.id,
      tool: { title: toolTitle(item), toolKind: item.toolKind, status: item.status, startedAt: iso(at), ...(terminal ? { endedAt: iso(at) } : {}) },
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

const secondOf = (ms: number): number => Math.floor(ms / 1000);
const iso = (ms: number): string => new Date(ms).toISOString();
const toolTitle = (item: UiToolItem): string => clampText(item.title, ACTIVITY_TOOL_TITLE_MAX);

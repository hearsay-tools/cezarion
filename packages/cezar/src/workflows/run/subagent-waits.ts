import { randomUUID } from 'node:crypto';
import {
  SUBAGENT_WAIT_CHILD_LIMIT, SUBAGENT_WAIT_DEADLINE_SECONDS, SUBAGENT_WAIT_GRACE_SECONDS,
  type SubagentChild, type SubagentWaitEntry, type SubagentWaitResult, type Wait,
} from '@open-mercato/cezar-contract/waits';
import type { UiEvent } from '../../core/ui-events.ts';
import type { RunnerId } from '../../core/agent-runner.ts';
import type { RunRecord } from '../../runs/store.ts';
import type { ActiveRun } from '../active-run.ts';
import { openWaits } from '../waits.ts';
import type { RunModuleContext } from './types.ts';

/**
 * Cezar's wait on the native subagents a turn left running (hearsay-tools/cezarion#2431). The
 * runner marks such a child's root task item `background: true` and ends it with one
 * `item.completed`; this module counts the live ones per session, opens the `subagent` wait at a
 * turn end instead of a monitoring timer, keeps its children and its deadline current while the
 * run is parked, and wakes the parent once when the last child ended and the runner did not
 * resume the parent itself within a grace.
 */

type SubagentStatus = SubagentChild['status'];
type ChildEvent = { id: string; status: SubagentStatus; background: boolean };

interface SubagentWaitsHost {
  active: ReadonlyMap<string, ActiveRun>;
  isParked(id: string): boolean;
  isAdmitted(id: string): boolean;
  settleWait(id: string, waitId: string, result?: SubagentWaitResult): void;
  armWait(id: string, wait: Wait): void;
  disarmWait(id: string): void;
}

/**
 * The runners whose wire reports a backgrounded native subagent's start and end, so Cezar waits on
 * it (hearsay-tools/cezarion#2431). Pi and Cursor report no child signal, and the OMP and OpenCode
 * parents never end a turn while their children run: their sessions keep the monitoring timer.
 * `waits-parity-cells.testkit.ts` holds each other runner's exemption with its reason.
 */
const NATIVE_SUBAGENT_RUNNERS: ReadonlySet<RunnerId> = new Set(['claude', 'codex']);
export function reportsNativeSubagents(runner: RunnerId | undefined): boolean {
  return runner !== undefined && NATIVE_SUBAGENT_RUNNERS.has(runner);
}

/** The child a UI event reports: a root tool item the runner marks background, with its status. A
 *  nested item (one with a parent) is passive and never counts (harness parity R15). */
export function backgroundChildEvent(event: UiEvent): ChildEvent | undefined {
  if (event.type !== 'item.started' && event.type !== 'item.updated' && event.type !== 'item.completed') return undefined;
  const item = event.item;
  if (item.kind !== 'tool' || item.parentItemId !== undefined) return undefined;
  const status: SubagentStatus = item.status === 'completed' ? 'completed' : item.status === 'failed' ? 'failed'
    : item.status === 'declined' ? 'cancelled' : 'running';
  return { id: item.id, status, background: item.background === true };
}

/** The live children of the session the run holds now. */
export function liveSubagents(state: ActiveRun): number {
  let live = 0;
  for (const child of state.backgroundChildren.values()) if (child.session === state.session && child.status === 'running') live += 1;
  return live;
}

/** The run's open subagent wait, if it has one. */
export function openSubagentWaitOf(run: Pick<RunRecord, 'waits'> | undefined): SubagentWaitEntry | undefined {
  return openWaits(run ?? {}).find((wait): wait is SubagentWaitEntry => wait.kind === 'subagent');
}

export class SubagentWaits {
  /** The grace after the last child ended, by run id. */
  private readonly graces = new Map<string, NodeJS.Timeout>();

  constructor(private readonly context: RunModuleContext, private readonly host: SubagentWaitsHost,
    private readonly graceMs = SUBAGENT_WAIT_GRACE_SECONDS * 1000, private readonly deadlineMs = SUBAGENT_WAIT_DEADLINE_SECONDS * 1000) {}

  /**
   * One UI event of the run's session. A background root task item is tracked from its first event;
   * a later event of a tracked item updates its status, and a terminal one is final, so a duplicate
   * or late end changes nothing. A change while the subagent wait is open is saved in it and moves
   * its deadline; once no child runs, a parked run waits out the grace.
   */
  trackEvent(runId: string, state: ActiveRun, event: UiEvent): void {
    const child = backgroundChildEvent(event);
    if (!child) return;
    const known = state.backgroundChildren.get(child.id);
    if (!known && !child.background) return;
    if (known && (known.status !== 'running' || known.status === child.status)) return;
    state.backgroundChildren.set(child.id, { session: known ? known.session : state.session, status: child.status });
    const wait = openSubagentWaitOf(this.context.store.getRun(runId));
    if (!wait) return;
    this.refreshWait(runId, state, wait);
    if (!liveSubagents(state) && this.host.isParked(runId)) this.armGrace(runId);
  }

  /**
   * The turn end's part (`TurnSettler.endTurn`), before the turn-end rule reads the waits. With live
   * children and nothing that ends or holds the turn (a done, a question, a permission request), it
   * opens the subagent wait, or brings the open one up to date. An open wait whose children all
   * ended while the parent ran is cancelled: the parent saw them end.
   */
  atTurnEnd(runId: string, state: ActiveRun, turn: { sessionOpen: boolean; done: boolean; asks: boolean }): void {
    const wait = openSubagentWaitOf(this.context.store.getRun(runId));
    const live = liveSubagents(state);
    if (wait && !live) { this.supersede(runId, [wait.id]); return; }
    if (!live || !turn.sessionOpen || turn.done || turn.asks || state.pendingHumanAsk || state.pendingPermissions?.size) return;
    if (wait) this.refreshWait(runId, state, wait);
    else this.openSubagentWait(runId, state);
  }

  /** The children the wait saves: the session's own, the running ones first, within the bound. */
  private children(state: ActiveRun): SubagentChild[] {
    const own = [...state.backgroundChildren].filter(([, child]) => child.session === state.session).map(([id, child]) => ({ id, status: child.status }));
    return [...own.filter(child => child.status === 'running'), ...own.filter(child => child.status !== 'running')].slice(0, SUBAGENT_WAIT_CHILD_LIMIT);
  }

  private deadline(): string {
    return new Date(Date.now() + this.deadlineMs).toISOString();
  }

  /** Open the wait. A refused checkpoint (the open-wait bound) leaves the turn end to the timer
   *  alias it would have opened before. */
  private openSubagentWait(runId: string, state: ActiveRun): void {
    const wait: SubagentWaitEntry = { id: randomUUID(), kind: 'subagent', source: 'cezar', via: 'native-subagents', registeredAt: new Date().toISOString(),
      phase: 'open', turnId: state.ciTurnId ?? 'subagents', deadline: this.deadline(), children: this.children(state) };
    try { this.context.store.commitWait(runId, wait); }
    catch (error) { console.warn(`[cez] subagent wait checkpoint failed: ${error instanceof Error ? error.message : String(error)}`); return; }
    this.host.armWait(runId, wait);
  }

  /** Save the children and move the deadline, then re-arm it. */
  private refreshWait(runId: string, state: ActiveRun, wait: SubagentWaitEntry): void {
    const children = this.children(state);
    const next: SubagentWaitEntry = { ...wait, deadline: this.deadline(), children: children.length ? children : wait.children };
    try { this.context.store.commitWait(runId, next); }
    catch (error) { console.warn(`[cez] subagent wait checkpoint failed: ${error instanceof Error ? error.message : String(error)}`); return; }
    this.host.disarmWait(wait.id);
    this.host.armWait(runId, next);
  }

  /** Every child ended: unless the runner starts a parent turn first, the wait resolves `settled`. */
  private armGrace(runId: string): void {
    if (this.graces.has(runId)) return;
    const timer = setTimeout(() => {
      if (this.graces.get(runId) !== timer) return;
      this.graces.delete(runId);
      const state = this.host.active.get(runId);
      const wait = openSubagentWaitOf(this.context.store.getRun(runId));
      if (!state || !wait || liveSubagents(state) || this.context.disposed()) return;
      this.host.settleWait(runId, wait.id, { reason: 'settled' });
    }, this.graceMs);
    timer.unref?.();
    this.graces.set(runId, timer);
  }

  private clearGrace(runId: string): void {
    const timer = this.graces.get(runId);
    if (timer) clearTimeout(timer);
    this.graces.delete(runId);
  }

  /**
   * The runner started a parent turn itself while the run was parked (hearsay-tools/cezarion#2431,
   * owner decision 4): the subagent wait, open or owed, and every open timer close, so no wake
   * input starts a second turn. PR, process, worker and peer waits stay. A wake Cezar admitted
   * starts its own turn, which is not the runner's.
   */
  supersedeOnRunnerResume(runId: string): void {
    if (this.host.isAdmitted(runId)) return;
    const run = this.context.store.getRun(runId);
    const ids = (run?.waits ?? []).filter(wait => (wait.kind === 'subagent' && (wait.phase === 'open' || wait.phase === 'resolved')) ||
      (wait.kind === 'timer' && wait.phase === 'open')).map(wait => wait.id);
    if (ids.length) this.supersede(runId, ids);
    else this.clearGrace(runId);
  }

  private supersede(runId: string, waitIds: readonly string[]): void {
    this.clearGrace(runId);
    try { this.context.store.commitOutcome(runId, { kind: 'cancelled', waitIds, superseded: true }); }
    catch (error) { console.warn(`[cez] wait cancellation failed: ${error instanceof Error ? error.message : String(error)}`); }
    for (const id of waitIds) this.host.disarmWait(id);
  }

  /** The run left the live registry: its session, and the children it held, are gone. An open
   *  subagent wait resolves `interrupted`, so its wake says so, for nothing. */
  afterSessionGone(runId: string): void {
    this.clearGrace(runId);
    if (this.context.disposed()) return;
    const wait = openSubagentWaitOf(this.context.store.getRun(runId));
    if (wait) this.host.settleWait(runId, wait.id, { reason: 'interrupted' });
  }

  /** Whether the session that holds the wait's children is still live. */
  sessionLive(runId: string): boolean {
    return !!this.host.active.get(runId)?.session?.open;
  }

  dispose(): void {
    for (const timer of this.graces.values()) clearTimeout(timer);
    this.graces.clear();
  }
}

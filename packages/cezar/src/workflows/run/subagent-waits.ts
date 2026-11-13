import { logPrefix } from '../../home/display.ts';
import type { WaitEngine } from './wait-engine.ts';
import { WAIT_KINDS } from './wait-kinds.ts';
import { transitionTurnBoundary } from './turn-boundary.ts';
import { ReadonlyMapView } from './readonly-collections.ts';
import {
  SUBAGENT_WAIT_CHILD_LIMIT, SUBAGENT_WAIT_DEADLINE_SECONDS, SUBAGENT_WAIT_GRACE_SECONDS,
  type SubagentChild, type SubagentWaitEntry,
} from '@open-mercato/cezar-contract/waits';
import type { UiEvent, UiToolItem } from '../../core/ui-events.ts';
import type { AgentSession, RunnerId } from '../../core/agent-runner.ts';
import { RUNNER_FACTS } from '../../core/runner-facts.ts';
import type { RunRecord } from '../../runs/store.ts';
import type { ActiveRun } from '../active-run.ts';
import { openWaits } from '../waits.ts';
import type { RunModuleContext } from './types.ts';

/**
 * Squawk's wait on the native subagents a turn left running (hearsay-tools/cezarion#2431). The
 * runner marks such a child's root task item `background: true` and ends it with one
 * `item.completed`; this module counts the live ones per session, opens the `subagent` wait at a
 * turn end instead of a monitoring timer, keeps its children and its deadline current while the
 * run is parked, and wakes the parent once when the last child ended and the runner did not
 * resume the parent itself within a grace.
 */

type SubagentStatus = SubagentChild['status'];
type BackgroundChild = Readonly<{ session: AgentSession | undefined; status: SubagentStatus }>;
let observeBackgroundChild: (group: ChildrenGroup, id: string, child: BackgroundChild) => void;

/** Native subagents a session started in the background (hearsay-tools/cezarion#2431), by the
 * runner's root task item id: the session that holds each, and its last status. */
export class ChildrenGroup {
  #backgroundChildren = new Map<string, BackgroundChild>();
  #view = new ReadonlyMapView(this.#backgroundChildren);
  constructor() { Object.freeze(this); }
  get backgroundChildren(): ReadonlyMap<string, BackgroundChild> { return this.#view; }
  static {
    observeBackgroundChild = (group, id, child) => { group.#backgroundChildren.set(id, Object.freeze(child)); };
  }
}
Object.freeze(ChildrenGroup.prototype);
Object.freeze(ChildrenGroup);
export function createChildrenGroup(): ChildrenGroup { return new ChildrenGroup(); }

/** How long a failed interruption waits before it writes the children's ends again: at most half the deadline, so it comes first. */
const INTERRUPT_RETRY_MS = 60_000;
type ChildEvent = { id: string; status: SubagentStatus; background: boolean };

interface SubagentWaitsHost {
  waitEngine: WaitEngine;
  active: ReadonlyMap<string, ActiveRun>;
  isParked(id: string): boolean;
  isAdmitted(id: string): boolean;
  /** Give a held park for the user its slot back and arm its idle close. */
  releaseHeldPark(id: string, state: ActiveRun): void;
}

/**
 * Whether the runner's wire reports a backgrounded native subagent's start and end, so Squawk waits
 * on it (hearsay-tools/cezarion#2431): its declared `nativeSubagents` is `reported`. A runner whose
 * wire sends no child signal, or whose parent turn never ends while its children run, keeps the
 * monitoring timer. `waits-subagents-parity-cells.testkit.ts` derives its exemptions from the same
 * declaration.
 */
export function reportsNativeSubagents(runner: RunnerId | undefined): boolean {
  return runner !== undefined && RUNNER_FACTS[runner].nativeSubagents === 'reported';
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
  for (const child of state.children.backgroundChildren.values()) if (child.session === state.liveSession.session && child.status === 'running') live += 1;
  return live;
}

/** The run's open subagent wait, if it has one. */
export function openSubagentWaitOf(run: Pick<RunRecord, 'waits'> | undefined): SubagentWaitEntry | undefined {
  return WAIT_KINDS.subagent.select(openWaits(run ?? {}))[0];
}

export class SubagentWaits {
  /** The grace after the last child ended, by run id. */
  private readonly graces = new Map<string, NodeJS.Timeout>();
  /** The retry of an interruption whose transcript write failed, by run id. */
  private readonly retries = new Map<string, NodeJS.Timeout>();

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
    const known = state.children.backgroundChildren.get(child.id);
    if (!known && !child.background) return;
    if (known && (known.status !== 'running' || known.status === child.status)) return;
    observeBackgroundChild(state.children, child.id, { session: known ? known.session : state.liveSession.session, status: child.status });
    // A child that runs again voids the grace: the next time none runs, a full grace starts.
    const live = liveSubagents(state);
    if (live) this.clearGrace(runId);
    const wait = openSubagentWaitOf(this.context.store.getRun(runId));
    if (!wait) { if (!live) this.releaseHeldPark(runId, state); return; }
    // A grace starts only from a saved snapshot, so the settled wait names every child's end.
    if (this.refreshWait(runId, state, wait) && !live && this.host.isParked(runId)) this.armGrace(runId);
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
    if (!live || !turn.sessionOpen || turn.done) return;
    // A question opens the wait too: the children keep running beside it, and the wait carries
    // their deadline and their restart. The question still ranks first for the user.
    if (wait) this.refreshWait(runId, state, wait);
    else if (!state.liveSession.pendingPermissions?.size) this.openSubagentWait(runId, state);
  }

  /** Whether native subagents still run in the run's session: then a park for the user keeps the
   *  session and its slot, so no idle close stops them (hearsay-tools/cezarion#2431). */
  holdsLiveSubagents(runId: string): boolean {
    const state = this.host.active.get(runId);
    return !!state && liveSubagents(state) > 0;
  }

  /** The last child of a park for the user that held its slot for them ended, with no subagent wait
   *  to wake the parent: the park gives the slot back and arms its idle close, as it would have. */
  private releaseHeldPark(runId: string, state: ActiveRun): void {
    if (!state.boundary.heldForSubagents || !this.host.isParked(runId)) return;
    transitionTurnBoundary(state, { kind: 'subagents-changed', phase: 'release', session: state.liveSession.session });
    this.host.releaseHeldPark(runId, state);
  }

  /** The children the wait saves: the session's own, the running ones first, then the latest ends,
   *  within the bound. */
  private children(state: ActiveRun): SubagentChild[] {
    const own = [...state.children.backgroundChildren].filter(([, child]) => child.session === state.liveSession.session).map(([id, child]) => ({ id, status: child.status }));
    const running = own.filter(child => child.status === 'running').slice(0, SUBAGENT_WAIT_CHILD_LIMIT);
    const room = SUBAGENT_WAIT_CHILD_LIMIT - running.length;
    return [...running, ...(room > 0 ? own.filter(child => child.status !== 'running').slice(-room) : [])];
  }


  private deadline(): string {
    return new Date(Date.now() + this.deadlineMs).toISOString();
  }

  /** Open the wait. A refused checkpoint (the open-wait bound) leaves the turn end to the timer
   *  alias it would have opened before. */
  private openSubagentWait(runId: string, state: ActiveRun): void {
    const wait = WAIT_KINDS.subagent.entry(state.waitIdentity.ciTurnId ?? 'subagents', this.deadline(), this.children(state));
    this.host.waitEngine.open(runId, state, wait, { withdraw: false, onCommitFailure: { log: `${logPrefix()} subagent wait checkpoint failed` }, park: false });
  }

  /** Save the children and move the deadline, then re-arm it. False when the checkpoint failed:
   *  the saved wait and its armed deadline stay as they were. */
  private refreshWait(runId: string, state: ActiveRun, wait: SubagentWaitEntry): boolean {
    const children = this.children(state);
    const next: SubagentWaitEntry = { ...wait, deadline: this.deadline(), children: children.length ? children : wait.children };
    return this.host.waitEngine.refresh(runId, wait, next, { log: `${logPrefix()} subagent wait checkpoint failed` });
  }

  /** Every child ended: unless the runner starts a parent turn first, the wait resolves `settled`. */
  private armGrace(runId: string): void {
    if (this.graces.has(runId)) return;
    const timer = setTimeout(() => {
      if (this.graces.get(runId) !== timer) return;
      this.graces.delete(runId);
      const state = this.host.active.get(runId);
      const wait = openSubagentWaitOf(this.context.store.getRun(runId));
      // A parent turn that started in the grace (a human message, another wake) sees the ends
      // itself: its turn end cancels the wait. The saved snapshot must hold every end first.
      if (!state || !wait || liveSubagents(state) || this.context.disposed() || !this.host.isParked(runId)) return;
      if (!this.refreshWait(runId, state, wait)) return;
      this.host.waitEngine.settleWait(runId, wait.id, { reason: 'settled' });
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
   * input starts a second turn. PR, process, worker and peer waits stay. A wake Squawk admitted
   * starts its own turn, which is not the runner's.
   */
  supersedeOnRunnerResume(runId: string): void {
    if (this.host.isAdmitted(runId)) return;
    const run = this.context.store.getRun(runId);
    const ids = (run?.waits ?? []).filter(wait => WAIT_KINDS[wait.kind].runnerResumeCancels.includes(wait.phase)).map(wait => wait.id);
    if (ids.length) this.supersede(runId, ids);
    else this.clearGrace(runId);
  }

  private supersede(runId: string, waitIds: readonly string[]): void {
    this.clearGrace(runId);
    this.host.waitEngine.cancel(runId, waitIds, { onCommitFailure: 'skip', superseded: true });
  }

  /** The run left the live registry: its session, and the children it held, are gone. An open
   *  subagent wait resolves `interrupted`, so its wake says so, for nothing. With no wait open
   *  (a park held beside a question), the children still end in the transcript. */
  afterSessionGone(runId: string, state?: ActiveRun): void {
    this.clearGrace(runId);
    if (this.context.disposed()) return;
    const wait = openSubagentWaitOf(this.context.store.getRun(runId));
    if (wait) this.interrupt(runId, wait.id);
    else if (state && liveSubagents(state) && !this.endStoppedChildren(runId)) this.armRetry(runId);
  }

  /**
   * The session that held the wait's children is gone, so they stopped: they end in the transcript
   * and the wait resolves `interrupted`. A failed transcript write keeps the wait open and tries
   * again, as a worker deadline retries its checkpoint, so the wait never says the children stopped
   * while the activity view still shows one running. A retry skips the children already ended.
   */
  interrupt(runId: string, waitId: string): void {
    this.clearRetry(runId);
    if (!this.endStoppedChildren(runId)) { this.armRetry(runId, waitId); return; }
    this.host.waitEngine.settleWait(runId, waitId, { reason: 'interrupted' });
  }

  /** Write the stopped children's ends again later: through the wait while it is open, or on their
   *  own when no wait held them. */
  private armRetry(runId: string, waitId?: string): void {
    const timer = setTimeout(() => {
      if (this.retries.get(runId) !== timer) return;
      this.retries.delete(runId);
      if (this.context.disposed()) return;
      if (waitId === undefined) { if (!this.endStoppedChildren(runId)) this.armRetry(runId); return; }
      if (openWaits(this.context.store.getRun(runId) ?? {}).some(entry => entry.id === waitId)) this.interrupt(runId, waitId);
    }, Math.min(this.deadlineMs / 2, INTERRUPT_RETRY_MS));
    timer.unref?.();
    this.retries.set(runId, timer);
  }

  private clearRetry(runId: string): void {
    const timer = this.retries.get(runId);
    if (timer) clearTimeout(timer);
    this.retries.delete(runId);
  }

  /**
   * Every background child the transcript still shows running ends as `declined`, so the activity
   * view stops showing it running. The transcript, not the wait's bounded snapshot, names them.
   * The ending event copies the child's last recorded item and its step, because a reader
   * replaces an item by its step and id.
   */
  private endStoppedChildren(runId: string): boolean {
    const last = new Map<string, { item: UiToolItem; stepId: string | undefined }>();
    for (const event of this.context.store.readEvents(runId)) {
      const item = (event as { item?: unknown }).item as UiToolItem | undefined;
      if (item?.kind !== 'tool' || item.parentItemId !== undefined) continue;
      if (!last.has(item.id) && item.background !== true) continue;
      last.set(item.id, { item, stepId: event.stepId });
    }
    let written = true;
    for (const { item, stepId } of last.values()) {
      if (item.status !== 'running' && item.status !== 'pending') continue;
      try { this.context.store.appendEvent(runId, { type: 'item.completed', ...(stepId ? { stepId } : {}), item: { ...item, background: true, status: 'declined' } }); }
      catch (error) { written = false; console.warn(`${logPrefix()} subagent end write failed: ${error instanceof Error ? error.message : String(error)}`); }
    }
    return written;
  }

  /** Whether the session that holds the wait's children is still live. */
  sessionLive(runId: string): boolean {
    return !!this.host.active.get(runId)?.liveSession.session?.open;
  }

  dispose(): void {
    for (const timer of [...this.graces.values(), ...this.retries.values()]) clearTimeout(timer);
    this.graces.clear();
    this.retries.clear();
  }
}

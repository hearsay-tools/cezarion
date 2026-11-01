import type { AgentInput } from '@open-mercato/cezar-contract/delegation';
import { computeWaitingOn, isUsageLimitHold, type HumanWaitEntry, type Wait } from '@open-mercato/cezar-contract/waits';
import type { RunRecord } from '../../runs/store.ts';
import type { RunOutcome } from '../../runs/outcome-commit.ts';
import { rootsAwaitingPeer } from '../../delegation/conversations.ts';
import { hasLiveInboxClaim } from '../../delegation/input.ts';
import { answersQuestion } from '../../delegation/questions.ts';
import { parseUsageLimit } from '../../core/usage-limit.ts';
import { accountHeldFor, sessionlessWakePrompt } from '../run-scheduling.ts';
import { executionAccount } from '../execution-account.ts';
import { chargesBudgetMessage, isMonitoringTimer, openWaits, resolvedWaits, waitInputId, waitResultText } from '../waits.ts';
import { runsAwaitingPeer } from '../wait-scope.ts';
import { transitionVia, type RunExitId } from '../run-states.ts';
import type { ContinueRunOptions } from '../continuation-admission.ts';
import type { ActiveRun } from '../active-run.ts';
import { clearIdleTimer } from './input-timers.ts';
import { canProceedWithRun } from './run-guards.ts';
import * as wakeLedger from './wake-ledger.ts';
import * as stepDecisions from './step-decisions.ts';
import type { RunModuleContext } from './types.ts';
import type { WakeRetries } from './wake-retries.ts';
import type { RunLine } from './run-line.ts';
import type { WaitWatches } from './wait-watches.ts';
import type { WaitRegistry } from './wait-registry.ts';
import type { InboxClaims } from './inbox-claims.ts';
import type { WorkerQuestions } from './worker-questions.ts';
import type { HumanWaits } from './human-waits.ts';

type HumanAnswerBudget = { spent: number };
interface WakeAdmissionHost {
  active: ReadonlyMap<string, ActiveRun>;
  retries: WakeRetries; line: RunLine; waitWatches: WaitWatches; waitRegistry: WaitRegistry;
  inboxClaims: InboxClaims; workerQuestions: WorkerQuestions; humanWaits: HumanWaits;
  isActive(id: string): boolean; move(id: string, exit: RunExitId): unknown;
  recoveringRun(run: RunRecord | string | undefined): boolean;
  continueRun(id: string, opts: ContinueRunOptions, defer: boolean): { ok: boolean; error?: string };
  disarmWait(id: string): void; reconcileWorkerWaits(id?: string): void; releaseSlot(): void;
  parkForUser(id: string, state: ActiveRun, step: string | undefined): void;
  armIdleTimer(id: string, state: ActiveRun): void; flushAgentInputs(id: string): void;
  answerRoutedQuestion(id: string, flush: boolean): void; queueWaitWake(id: string): void;
  retryWaitAdmission(id: string): void; countAutomaticWakes(id: string, budget?: HumanAnswerBudget): number;
  workerExecutionStopped(id: string): boolean; executionBlockedByRootFinish(run: RunRecord): boolean;
}

export class WakeAdmission {
  constructor(private readonly context: RunModuleContext, private readonly host: WakeAdmissionHost,
    private readonly maxAutoContinues: number, private readonly maxWakeDeliveryAttempts: number) {}

  /** A timer, process or peer wait due, or still owed, once the automatic-wake budget is spent
   *  wakes nothing: it is cancelled with the cap note, and the run keeps whatever else it waits on
   *  (hearsay-tools/cezarion#1233, hearsay-tools/cezarion#1446, hearsay-tools/cezarion#1995). */
  cancelAutomaticAtCap(runId: string, waits: readonly Wait[]): void {
    if (!waits.length) return;
    this.context.store.commitOutcome(runId, { kind: 'cancelled', waitIds: waits.map(wait => wait.id) });
    for (const wait of waits) {
      this.host.disarmWait(wait.id);
      this.context.store.appendEvent(runId, { type: 'note', message: wait.kind === 'process' || wait.kind === 'peer'
        ? `automatic ${wait.kind} wake-up cap reached (${this.maxAutoContinues}); ${wait.kind} wait ${wait.id} cancelled`
        : `automatic ${isMonitoringTimer(wait) ? 'monitoring' : 'timer'} wake-up cap reached (${this.maxAutoContinues}); timer ${wait.id} cancelled` });
    }
  }

  /** A parked run whose last wait was cancelled at the budget without a wake waits on the user: a
   *  `budget` human wait opens and is shown (hearsay-tools/cezarion#1234), and the run leaves the
   *  monitoring pool and its slot, as `parkForUser` does. A turn in progress is left to its own
   *  turn end. */
  reparkWithoutWaits(runId: string, state: ActiveRun): void {
    const run = this.context.store.getRun(runId);
    if (!run || run.status !== 'waiting' || !this.host.line.isParked(runId) || state.atTurnBoundary !== state.session || run.waits?.length) return;
    this.host.humanWaits.surfaceHumanWait(runId, state, this.host.humanWaits.openHumanAlias(runId, state, 'budget'));
    this.leaveMonitoringPool(runId);
    this.host.armIdleTimer(runId, state);
  }

  /** The same for a parked run with no live session, as when recovery fires an overdue timer
   *  before any session exists: once no wait is left, the `budget` human wait opens and is shown,
   *  and the user's Continue answers it. */
  waitOnUserWithoutSession(runId: string): void {
    const run = this.context.store.getRun(runId);
    if (!run || run.status !== 'waiting' || this.host.active.has(runId) || run.waits?.length) return;
    this.host.humanWaits.surfaceHumanWait(runId, undefined, this.host.humanWaits.openHumanAlias(runId, undefined, 'budget'));
    this.leaveMonitoringPool(runId);
  }

  /**
   * A session failed, or closed cleanly, while the run still owed wait results
   * (hearsay-tools/cezarion#1233). Count the failed delivery and decide what the closing path does:
   * `park` keeps the run waiting and retries after the backoff (or, with nothing resolved, leaves
   * its open waits to wake it); `settle` fails the run the ordinary way, which a usage limit takes
   * into its own hold and resume without being counted; `capped` fails it at
   * `MAX_WAKE_DELIVERY_ATTEMPTS`. Every settled run keeps its results.
   */
  failedWakeDelivery(runId: string, error: string): 'park' | 'settle' | 'capped' {
    if (!this.owesDelivery(runId)) return 'park';
    if (parseUsageLimit(error)) return 'settle';
    const failures = (this.context.store.getRun(runId)?.waitDeliveryFailures ?? 0) + 1;
    if (failures >= this.maxWakeDeliveryAttempts) {
      // Nothing may wake the settled run: its admission retry goes with the count.
      this.resetWakeDelivery(runId);
      this.host.retries.stopRetry(runId);
      return 'capped';
    }
    this.context.store.commitOutcome(runId, { kind: 'counted', waitDeliveryFailures: failures }, {}, { bestEffort: true });
    this.host.retries.backoff(runId, failures);
    return 'park';
  }

  owesDelivery(runId: string): boolean {
    return wakeLedger.owesDelivery(this.context.store, runId, run => this.owesWake(run));
  }

  /** Apply the pure closing-wake decision without moving delivery counters or timers. */
  closingWakeDecision(runId: string, holdsClosingWakes: boolean, cancelled: boolean, undelivered: string | undefined): 'park' | 'settle' | 'capped' {
    const decision = stepDecisions.closingWakeDecision(holdsClosingWakes, cancelled, undelivered);
    return decision.kind === 'failed-delivery' ? this.failedWakeDelivery(runId, decision.error) : decision.kind;
  }

  /** A delivery, a human or a terminal path ends a run of failed deliveries and its backoff. */
  resetWakeDelivery(runId: string): void {
    this.clearWakeDeliveryFailures(runId);
    this.host.retries.clearWakeBackoff(runId);
  }

  /** An acknowledged wake turn runs: a retry stops unless a wake is still `owed`. Pool membership
   *  changes only at a turn end or a terminal path; a worker park's idle timer belongs to the park,
   *  not to the wake turn. */
  spendWakeAdmission(runId: string, state: ActiveRun, owed: boolean): void {
    if (!owed) { this.host.retries.stopRetry(runId); }
    this.host.line.unpark(runId); clearIdleTimer(state);
    this.host.move(runId, 'resume');
  }

  withFailuresCleared(runId: string, outcomes: RunOutcome[], ids: readonly string[], cleared = false): RunOutcome[] {
    return wakeLedger.withFailuresCleared(this.context.store, runId, outcomes, ids, cleared);
  }

  /** The failure count is on the run record, so a restart keeps it (hearsay-tools/cezarion#1234). */
  clearWakeDeliveryFailures(runId: string): void {
    this.context.store.commitOutcome(runId, { kind: 'counted', waitDeliveryFailures: undefined }, {}, { bestEffort: true });
  }

  automaticWakes(runId: string, beforeHumanReset?: HumanAnswerBudget): number {
    return wakeLedger.automaticWakes(this.context.store, this.host.active, runId, beforeHumanReset);
  }

  /** Spend one automatic wake on the record; returns the count after it. */
  chargeAutomaticWake(runId: string): number {
    const next = (this.context.store.getRun(runId)?.automaticWakes ?? 0) + 1;
    // Best-effort: a refused write never stops the nudge or the cleanup that charges it.
    this.context.store.commitOutcome(runId, { kind: 'charged', automaticWakes: next }, {}, { bestEffort: true });
    return next;
  }

  /**
   * Park a session on its waits (hearsay-tools/cezarion#1233): `waiting`. A CI or
   * timer park keeps its slot in the monitoring pool, so its wake starts at once, and needs no idle
   * timer; a resolved wait with nothing left open is a wake due now and keeps it too. Worker waits
   * rank above CI and timers (hearsay-tools/cezarion#1235): a park on them holds no slot and arms
   * the idle timer, so the session closes after `IDLE_TIMEOUT_MS` and the run stays `waiting` for
   * the next resolution or message to reopen it. Its intent reaches disk before the slot is freed.
   * An open human wait is shown and parks for the user, with no slot (hearsay-tools/cezarion#1234).
   */
  parkOnWaits(runId: string, state: ActiveRun): boolean {
    const run = this.context.store.getRun(runId);
    if (!run?.waits?.length || !state.session?.open || state.cancelled || state.pendingHumanAsk) return false;
    const human = openWaits(run).find((wait): wait is HumanWaitEntry => wait.kind === 'human');
    if (human) {
      this.host.humanWaits.surfaceHumanWait(runId, state, human);
      this.host.parkForUser(runId, state, state.currentStepId);
      return true;
    }
    clearIdleTimer(state);
    const top = computeWaitingOn(run)?.kind;
    const keepsSlot = top === 'pr' || top === 'process' || top === 'timer' || (top === undefined && resolvedWaits(run).length > 0);
    // A park that frees its slot publishes the intent first: a refused write throws and keeps it.
    if (keepsSlot) {
      this.host.move(runId, 'park');
      if (state.currentStepId) this.context.store.updateStep(runId, state.currentStepId, { status: 'waiting' });
    } else transitionVia('park', () => this.context.store.getRun(runId), () => this.context.store.commitParked(runId, state.currentStepId));
    this.host.line.park(runId);
    if (keepsSlot) this.host.line.joinPool(runId); else this.leaveMonitoringPool(runId);
    if (top === 'workers' || top === 'peers') this.host.armIdleTimer(runId, state);
    this.host.queueWaitWake(runId);
    this.host.releaseSlot();
    return true;
  }

  /** Parked with `workers` or `peers` as its top wait (hearsay-tools/cezarion#1235, hearsay-tools/cezarion#1995): the
   *  park holds no slot, so runner activity resumes it as it resumes a monitoring park. */
  parkedOnWorkers(runId: string): boolean {
    const run = this.context.store.getRun(runId);
    return run?.status === 'waiting' && ['workers', 'peers'].includes(computeWaitingOn(run)?.kind ?? '');
  }

  /** Leave the monitoring pool. Only a turn end or a terminal path does; a member's slot
   *  goes back to the workspace. */
  leaveMonitoringPool(runId: string): void {
    if (this.host.line.leavePool(runId)) this.host.releaseSlot();
  }

  /**
   * Queue one wake for every resolved wait of a run and every message it has not received
   * (`owesWake`). A live session takes it only at a turn boundary: a turn in progress, a native
   * question included, picks it up at its own turn end. A monitoring-pool member already holds its
   * slot and is admitted at once; any other live session waits for scheduler admission; a run with
   * no session reopens through a scheduler-owned continuation. A pending question does not hold the
   * wake back: the wake turn delivers the results and the messages beside it, and the question
   * stays answerable (hearsay-tools/cezarion#1235).
   */
  queueWaitWake(runId: string): void {
    const run = this.context.store.getRun(runId);
    const resolved = run ? resolvedWaits(run) : [];
    if (!this.canQueueWaitWake(runId, run)) return;
    const state = this.host.active.get(runId);
    this.restoreWorkerWaitInputs(runId);
    if (state && (!state.session?.open || !this.takesWake(runId, state))) return;
    // Settlement ends the watcher. Keep a bounded-rate wake source until ACK,
    // cancellation or termination, including refusals with no runner-ready callback.
    this.host.retryWaitAdmission(runId);
    if (this.host.line.isAdmitted(runId)) { this.deliverAdmittedWake(runId); return; }
    // A pool member's wake is admitted at once, unless its account is on a usage-limit hold: then
    // it waits in the line, keeping its monitoring slot, until the hold lifts (hearsay-tools/cezarion#1236).
    if (state && this.host.line.inPool(runId) && !this.wakeHeld(run)) {
      this.host.line.removeWake(runId);
      this.host.line.admitWake(runId);
      this.deliverAdmittedWake(runId);
      return;
    }
    if (this.host.line.hasWake(runId)) { this.host.releaseSlot(); return; }
    if (state) {
      this.host.line.enqueueWake(runId, Date.now());
    } else if (!this.host.isActive(runId)) {
      if (!this.queueSessionlessWaitWake(runId, resolved)) return;
    }
    this.host.releaseSlot();
  }

  /** Reject only the same durable and manager-level holds before restoring wake inputs. */
  canQueueWaitWake(runId: string, run: RunRecord | undefined): run is RunRecord {
    // A run on a usage-limit hold is woken by its resume only, which delivers what resolved
    // meanwhile (hearsay-tools/cezarion#1236).
    if (this.context.disposed() || this.host.recoveringRun(run) || !run || isUsageLimitHold(run) || !this.owesWake(run) ||
      !['running', 'waiting', 'queued'].includes(run.status) || !canProceedWithRun(run, () => this.host.workerExecutionStopped(runId), record => this.host.executionBlockedByRootFinish(record))) return false;
    // A failed delivery waits out its backoff; the backoff's own timer queues this wake again.
    if (this.host.retries.inBackoff(runId)) return false;
    return true;
  }

  queueSessionlessWaitWake(runId: string, resolved: ReturnType<typeof resolvedWaits>): boolean {
    // No live session: create a scheduler-owned continuation, never a direct provider call.
    this.host.move(runId, 'park-for-wake');
    const text = sessionlessWakePrompt(resolved);
    const resumed = this.host.continueRun(runId, { text, waitWake: true }, true);
    if (!resumed.ok) {
      const message = `${resolved.length ? 'Wait result' : 'Messages'} retained; continuation unavailable: ${resumed.error ?? 'unknown'}`;
      if (this.host.retries.noteRetained(runId, message)) {
        this.context.store.appendEvent(runId, { type: 'note', message });
      }
      return false;
    }
    this.host.retries.clearRetained(runId);
    this.host.line.markWake(runId, Date.now());
    return true;
  }

  /** Is this run's account on a usage-limit hold that keeps its wake in the line? */
  wakeHeld(run: RunRecord): boolean {
    const holds = this.context.semaphore.accountHolds();
    if (!holds.deadline.size && !holds.inFlight.size) return false;
    return accountHeldFor(this.withExecutionAccount(run), holds, run.runner ?? 'claude');
  }

  /** The run with the account its next turn runs on (`executionAccount`): a live session's step
   *  settings, a queued continuation's account, else its latest session step. Both sides of a hold
   *  read it, so a mixed-runner step is held by the account it ran on (hearsay-tools/cezarion#1236). */
  withExecutionAccount<T extends RunRecord>(run: T): T {
    const live = this.host.active.get(run.id)?.delegationSettings;
    return { ...run, ...executionAccount(run, this.host.line.continuation(run.id), live) };
  }

  /** A worker wait the store upgraded from the old engine as already settled may have had no wake input
   *  queued yet (hearsay-tools/cezarion#1235): the old engine wrote it on its next pass, so its
   *  result is written here, once, before the wake that delivers it. A full inbox waits. */
  restoreWorkerWaitInputs(runId: string): void {
    const run = this.context.store.getRun(runId);
    for (const wait of resolvedWaits(run ?? {})) {
      if (!run || wait.kind !== 'worker' || run.agentInputs?.some(input => input.id === waitInputId(wait))) continue;
      if ((this.context.store.getRun(runId)?.agentInputs ?? []).filter(input => !input.deliveredAt).length >= 32) return;
      this.context.store.commitWait(runId, wait, { id: waitInputId(wait), parentRunId: runId, source: 'lifecycle', createdAt: wait.resolvedAt ?? new Date().toISOString(),
        text: waitResultText(wait, { workerStatus: this.host.waitRegistry.workerStatus }) });
    }
  }

  pendingConversationWakes(run: RunRecord, beforeHumanReset?: HumanAnswerBudget): AgentInput[] {
    return wakeLedger.pendingConversationWakes(run, { routedAnswer: id => this.routedAnswer(id), countAutomaticWakes: (id, budget) => this.host.countAutomaticWakes(id, budget), providerOwnsInboxInput: (id, inputId) => this.host.inboxClaims.providerOwnsInboxInput(id, inputId) }, this.maxAutoContinues, beforeHumanReset);
  }

  /** Peer messages the spent budget keeps from waking the run (spec § 8). A turn in progress takes
   *  them as steering, which charges nothing. A parked run waits on the user instead: Cezar's
   *  `budget` human wait opens and is shown, and a human message resets the budget. */
  holdPeerWakesAtCap(runId: string): void {
    const run = this.context.store.getRun(runId);
    if (!run || this.host.countAutomaticWakes(runId) < this.maxAutoContinues ||
      !run.agentInputs?.some(input => !input.deliveredAt && !hasLiveInboxClaim(input) && chargesBudgetMessage(input))) return;
    const state = this.host.active.get(runId);
    if (state?.session?.open && state.atTurnBoundary !== state.session) { if (!this.host.recoveringRun(runId)) this.host.flushAgentInputs(runId); return; }
    if (run.status === 'waiting') this.host.humanWaits.surfaceHumanWait(runId, state, this.host.humanWaits.openHumanAlias(runId, state, 'budget'));
  }

  /** The parent's reply that answers a worker's pending routed question, still undelivered. */
  routedAnswer(runId: string): AgentInput | undefined {
    const routed = this.host.workerQuestions.routedAsk(runId);
    return routed && this.context.store.getRun(runId)?.agentInputs?.find(input => !input.deliveredAt && answersQuestion(routed.message, input));
  }

  owesWake(run: RunRecord, beforeHumanReset?: HumanAnswerBudget): boolean {
    return wakeLedger.owesWake(run, { routedAnswer: id => this.routedAnswer(id), pendingConversationWakes: (record, budget) => this.pendingConversationWakes(record, budget) }, beforeHumanReset);
  }

  takesWake(runId: string, state: ActiveRun): boolean {
    return wakeLedger.takesWake(runId, state, id => this.routedAnswer(id));
  }

  /** An admitted wake goes to the agent: a parent's answer through the answer seam, everything
   *  else as one submission. */
  deliverAdmittedWake(runId: string): void {
    const state = this.host.active.get(runId);
    const midTurn = !!state && state.atTurnBoundary !== state.session;
    if ((midTurn || !resolvedWaits(this.context.store.getRun(runId) ?? {}).length) && this.routedAnswer(runId)) this.host.answerRoutedQuestion(runId, true);
    else this.host.flushAgentInputs(runId);
  }

  /** An admitted or queued wake whose messages an inbox read took has nothing left to deliver: the
   *  run goes back to its park and gives up the slot the admission reserved. */
  retireEmptyWake(runId: string): void {
    const run = this.context.store.getRun(runId);
    const state = this.host.active.get(runId);
    if (!run || this.owesWake(run) || state?.agentInputFlight) return;
    this.host.line.removeWake(runId);
    if (this.host.line.retireAdmission(runId) && state && run.status === 'waiting' && state.atTurnBoundary === state.session) this.host.line.park(runId);
    this.host.retries.stopRetry(runId);
  }

  /**
   * Cancel every open or resolved wait of a run without waking the agent: stop, Finish, cancel,
   * deletion, DONE and any terminal status. Human input cancels none (hearsay-tools/cezarion#1233).
   * A failed commit leaves the record as a crash would and never stops the disarm, so Stop still
   * reaches the session when the store is closed or broken (hearsay-tools/cezarion#1234).
   */
  cancelOpenWaits(runId: string): void {
    const before = this.context.store.getRun(runId)?.waits ?? [];
    const remaining = (this.context.store.getRun(runId)?.waits ?? []).map(wait => wait.id);
    try { if (remaining.length) this.context.store.commitOutcome(runId, { kind: 'cancelled', waitIds: remaining }); }
    catch (error) { console.warn(`[cez] wait cancellation failed: ${error instanceof Error ? error.message : String(error)}`); }
    for (const wait of before) this.host.disarmWait(wait.id);
    this.disarmRunWaits(runId);
  }

  /** Stop every watch, timer, retry and queued wake a run's waits hold in memory. */
  disarmRunWaits(runId: string): void {
    this.host.waitRegistry.abortRegistrations(runId);
    this.host.waitWatches.disarmRun(runId);
    this.host.retries.forget(runId);
    this.resetWakeDelivery(runId);
    this.host.line.removeWake(runId, this.host.active.has(runId));
    this.host.line.retireAdmission(runId);
  }

  /** A deleted run's row is gone with its waits; only what they armed in memory is left. */
  readonly onRunDeleted = (runId: string): void => {
    this.disarmRunWaits(runId);
    if (!this.context.disposed()) this.host.waitRegistry.resolvePeerWaits(runsAwaitingPeer(runId, () => this.context.store.listRuns()));
    // A peer's open requests to the deleted run settle `deleted` (spec 2026-10-27 § 5): each ledger
    // that holds one is reconciled, live or settled.
    if (this.context.disposed() || process.env.CEZ_DELEGATION !== '1') return;
    try { for (const id of rootsAwaitingPeer(this.context.store, runId)) this.host.reconcileWorkerWaits(id); } catch { /* the next reconcile settles them */ }
  };

  /** A lost runner boundary requeues the wake and ends this pass instead of spinning. */
  admitQueuedWaitWake(runId: string): 'none' | 'handled' | 'deferred' {
    if (this.host.line.hasWake(runId) && this.host.active.has(runId)) {
      this.host.line.removeWake(runId, false);
      const state = this.host.active.get(runId)!;
      const queued = this.context.store.getRun(runId);
      const owed = !!queued && this.owesWake(queued);
      if (owed && this.takesWake(runId, state)) {
        // The wake holds a regular slot from admission until its acknowledgement.
        this.host.line.unpark(runId);
        this.host.line.admitWake(runId);
        this.deliverAdmittedWake(runId);
      } else if (owed) {
        // The runner may lose its boundary between queueing and admission.
        // Retain the wake, but do not spin on it in this pump pass.
        this.host.line.enqueueWake(runId, Date.now(), false);
        this.host.retryWaitAdmission(runId);
        return 'deferred';
      }
      return 'handled';
    }
    return 'none';
  }
}

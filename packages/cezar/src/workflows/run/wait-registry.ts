import { warnRegistrationRefused, type WaitEngine } from './wait-engine.ts';
import { WAIT_KINDS, routeRegistration } from './wait-kinds.ts';
import { registrationIdentity, replayRegistration, repeatRegistration, type RegistrationIdentity } from './wait-registration.ts';
import { workerWaitRequestSchema, type WorkerWait } from '@open-mercato/cezar-contract/delegation';
import { requestWaitRequestSchema, type RequestWaitRequest } from '@open-mercato/cezar-contract/conversations';
import { workerWaitEntryToLegacy } from '@open-mercato/cezar-contract/waits';
import { DelegationPolicyError, requireMessagingAllowed } from '../../delegation/policy.ts';
import { historyDeletionPending, rootFinishRequested, executionBlockedByRootFinish } from './run-guards.ts';
import { assertOwnedWorkerWaitScope, assertRequestWaitScope, peerWaitEntry, peerWaitOf, waitCapacityPolicyError, workerWaitTarget } from '../wait-scope.ts';
import { randomUUID } from 'node:crypto';
import type { RunModuleContext } from './types.ts';
import type { ActiveRun } from '../active-run.ts';
import type { RunRecord } from '../../runs/store.ts';
import type { WorkerWaitRequest } from '@open-mercato/cezar-contract/delegation';
import { squawkAskRequestSchema, squawkWaitRequestSchema, type AskErrorCode, type SquawkAskRequest, type SquawkWaitRequest, type SquawkWaitRequestInput, type WaitErrorCode, type WaitVia, type HumanWaitEntry, type PrWaitEntry, type TimerWaitEntry, type WorkerWaitEntry, type DeadlinedWorkerWaitEntry, type ProcessWaitEntry, type PeerWaitEntry } from '@open-mercato/cezar-contract/waits';

import type { CiWatcherSupervisor } from '../../ci-wait/supervisor.ts';
import { askErrorMessage, waitErrorMessage } from '../../ci-wait/errors.ts';
import { toolSessionRefusal } from './squawk-tools.ts';
import { askCardFields } from './turn-markers.ts';
import { identicalWait, normalizePrUrl, openWaits, timerWaitEntry, prWaitEntry, processWaitEntry } from '../waits.ts';
import { delegationWaitRefusal, workerListTarget } from '../wait-scope.ts';
import { isSessionLeader } from '../../core/session-process.ts';
import { probeProcessWait } from '../../process-wait/supervisor.ts';
import { confineExitFile } from '../../process-wait/exit-file.ts';
import { processStartToken, recordedProcessLive } from '../../delegation/process-liveness.ts';

/** CI identity stays live across registration and rotates at the existing turn boundaries. */
export class WaitGroup {
  #ciTurnId: string | undefined;
  constructor() { Object.freeze(this); }
  get ciTurnId(): string | undefined { return this.#ciTurnId; }
  ensureCiTurn(): string { return this.#ciTurnId ??= randomUUID(); }
  rotateCiTurn(turnId: string): void { this.#ciTurnId = turnId; }
}

Object.freeze(WaitGroup.prototype);
type RegisteredWait = PrWaitEntry | TimerWaitEntry | WorkerWaitEntry | ProcessWaitEntry | PeerWaitEntry;
/** An agent or CLI registration: withdraw Squawk's human waits, commit with its receipt, park at a boundary. */
const OPEN_REGISTERED = (receipt: RegistrationIdentity | undefined) => ({ withdraw: true, receipt, onCommitFailure: 'persistence' as const, park: true });
Object.freeze(WaitGroup);
export function createWaitGroup(): WaitGroup { return new WaitGroup(); }

interface WaitRegistryHost {
  waitEngine: WaitEngine;
  active(id: string): ActiveRun | undefined;
  workerExecutionStopped(id: string): boolean;
  executionBlockedByRootFinish(run: RunRecord): boolean;
  ciSupervisor(): Pick<CiWatcherSupervisor, 'resolve' | 'watch' | 'close'>;
  countAutomaticWakes(id: string): number;
  reconcileWorkerWaits(family?: string): void;
}

export class WaitRegistry {
  readonly ciRegistrations = new Map<string, { runId: string; abort: AbortController; promise: Promise<PrWaitEntry | TimerWaitEntry> }>();
  constructor(private readonly context: RunModuleContext, private readonly host: WaitRegistryHost, private readonly maxAutoContinues: number) {}
  abortRegistrations(runId: string): void {
    for (const [key, registration] of this.ciRegistrations) {
      if (registration.runId !== runId) continue;
      registration.abort.abort(); this.ciRegistrations.delete(key);
    }
  }

  dispose(): void {
    for (const task of this.ciRegistrations.values()) task.abort.abort();
    this.ciRegistrations.clear();
  }
  /** `cez worker wait`: an alias into the wait list, answered in the legacy `WorkerWait` shape
   *  (hearsay-tools/cezarion#1235). */
  registerWorkerWait(parentId: string, request: WorkerWaitRequest): WorkerWait {
    const parsed = workerWaitRequestSchema.parse(request);
    return workerWaitEntryToLegacy(this.registerWorkerListWait(parentId, parsed, 'cez-worker-wait'));
  }

  /**
   * Open a `worker` wait in the list (hearsay-tools/cezarion#1235): on workers the parent owns, or
   * on replies to requests the run sent. It stands beside CI, timer and human waits, up to
   * `WAIT_LIMIT` open ones; the same target and mode return the open wait instead. The family is
   * reconciled at once, so outcomes already in resolve it now, and its deadline is armed.
   * Refusals throw `DelegationPolicyError`: `incompatible_state`, `denied_scope` or
   * `capacity_limit`.
   */
  registerWorkerListWait(runId: string, request: { workerIds?: string[]; requestIds?: string[] | undefined; mode?: WorkerWaitRequest['mode']; timeoutSeconds: number },
    via: 'cezar_wait' | 'cez-worker-wait', registration?: RegistrationIdentity): DeadlinedWorkerWaitEntry {
    this.host.reconcileWorkerWaits();
    this.assertCanRegisterWorkerWait(runId);
    const run = this.context.store.getRun(runId)!;
    const state = this.host.active(runId)!;
    if (!run.delegation || run.delegation.role === 'invalid') throw new DelegationPolicyError('denied_scope', 'Worker scope denied');
    const getRun = (id: string) => this.context.store.getRun(id);
    if (request.workerIds) assertOwnedWorkerWaitScope(runId, run.delegation, request.workerIds, getRun);
    else assertRequestWaitScope(run, run.delegation, request.requestIds ?? [], getRun);
    const repeated = WAIT_KINDS.worker.duplicateWorker(run.waits ?? [], request);
    if (repeated && WAIT_KINDS.worker.hasDeadline(repeated)) return repeatRegistration(this.context.store, runId, repeated, request.timeoutSeconds, registration) as DeadlinedWorkerWaitEntry;
    if (!this.host.waitEngine.hasRoom(run)) throw waitCapacityPolicyError();
    const now = Date.now();
    const target = workerWaitTarget(request, getRun);
    const entry = WAIT_KINDS.worker.entry(request, via, now, state.waitIdentity.ensureCiTurn(), target);
    return this.host.waitEngine.open(runId, state, entry, { withdraw: true, receipt: registration, onCommitFailure: { capacity: waitCapacityPolicyError }, park: true }).wait!;
  }

  /** Squawk waits on live workers or open requests without adding a deadline of its own. */
  registerCompletionWait(runId: string, workerIds: string[], requestIds?: string[]): WorkerWaitEntry | undefined {
    if (!this.host.waitEngine.hasRoom(this.context.store.getRun(runId) ?? {})) return;
    const state = this.host.active(runId)!;
    const ids = workerIds.filter(id => { const worker = this.context.store.getRun(id)?.delegation; return worker?.role === 'worker' && worker.parentRunId === runId; });
    const entry = WAIT_KINDS.worker.completionEntry(state.waitIdentity.ensureCiTurn(),
      workerWaitTarget(requestIds?.length ? { requestIds } : { workerIds: ids }, id => this.context.store.getRun(id)));
    return this.host.waitEngine.open(runId, state, entry, { withdraw: false, park: false }).wait!;
  }

  /** The states no worker wait registers in: refusals throw `incompatible_state`. Waits stand
   *  beside CI, timer and human waits and beside each other (hearsay-tools/cezarion#1235). */
  private assertCanRegisterWorkerWait(runId: string): void {
    const run = this.context.store.getRun(runId);
    const state = this.host.active(runId);
    const refuse = (message: string): never => { throw new DelegationPolicyError('incompatible_state', message); };
    if (!run?.delegation || run.delegation.role === 'invalid') refuse('Worker waits require an owned worker or parent run');
    if (historyDeletionPending(this.context.store, runId)) refuse('History deletion is pending; finish deletion before registering a wait');
    if (executionBlockedByRootFinish(this.context.store, run!)) refuse('Parent finish is pending; a finishing parent cannot register a wait');
    if (!['running', 'waiting'].includes(run!.status) || !state?.liveSession.session?.open || state.liveSession.cancelled) {
      refuse(`Run is ${run!.status} with no available active session; register a wait from an executing parent or worker`);
    }
  }

  /** Both roles can select their own requests without acquiring worker-management authority.
   *  `cez message wait --request`: an alias into the wait list (hearsay-tools/cezarion#1235). */
  registerRequestWait(runId: string, request: RequestWaitRequest): WorkerWait {
    const parsed = requestWaitRequestSchema.parse(request);
    return workerWaitEntryToLegacy(this.registerWorkerListWait(runId, parsed, 'cez-worker-wait'));
  }

  /** `cezar_wait` kind `peer` and `cez message wait --peer` (hearsay-tools/cezarion#1995): checked
   *  and built by `peerWaitEntry`; a peer that already wrote or settled resolves it at once (`armWait`). */
  registerPeerWait(runId: string, request: { peerIds: string[]; timeoutSeconds: number }, via: 'cezar_wait' | 'cez-message-wait', registration?: RegistrationIdentity): PeerWaitEntry {
    this.assertCanRegisterWorkerWait(runId);
    const state = this.host.active(runId)!;
    const entry = peerWaitEntry(this.context.store.getRun(runId)!, request, via, () => state.waitIdentity.ensureCiTurn(), id => this.context.store.getRun(id));
    if (this.context.store.getRun(runId)?.waits?.some(wait => wait.id === entry.id)) {
      return repeatRegistration(this.context.store, runId, entry, request.timeoutSeconds, registration) as PeerWaitEntry;
    }
    // A new peer wait is peer messaging (hearsay-tools/cezarion#2784); an open one keeps running.
    requireMessagingAllowed(this.context.store.getRun(runId)!);
    return this.host.waitEngine.open(runId, state, entry, OPEN_REGISTERED(registration)).wait!;
  }

  /** `cez message cancel-wait` on a peer wait, through the list, as `cancelWorkerWait`; a settled one comes back as it is. */
  cancelPeerWait(runId: string, waitId: string): PeerWaitEntry {
    const run = this.context.store.getRun(runId)!;
    if (peerWaitOf(run, waitId).phase !== 'open') return peerWaitOf(run, waitId);
    if (this.context.disposed() || !['queued', 'running', 'waiting'].includes(run.status) || rootFinishRequested(this.context.store, runId) || historyDeletionPending(this.context.store, runId)) {
      throw new DelegationPolicyError('incompatible_state', 'Parent cannot cancel a peer wait');
    }
    this.host.waitEngine.cancel(runId, [waitId]);
    return peerWaitOf(this.context.store.getRun(runId), waitId);
  }

  /** The checks every wait registration shares: the session that called is the run's current one,
   *  and no root finish blocks it. Refusals throw `{ code }`. */
  private registrationGate(runId: string, generation: string, capabilitySignal?: AbortSignal) {
    const state = this.host.active(runId);
    const refuse = (code: WaitErrorCode | AskErrorCode): never => {
      // Fixed codes only: no tool arguments, credentials or provider diagnostics.
      warnRegistrationRefused(code);
      throw Object.assign(new Error(code === 'autonomous_run' ? askErrorMessage(code) : waitErrorMessage(code)), { code });
    };
    const assertCanRegister = () => {
      const refused = toolSessionRefusal(this.context.store.getRun(runId), state, this.host.active(runId), generation, capabilitySignal, this.context.disposed());
      const run = this.context.store.getRun(runId);
      if (refused || !run || !state) return refuse(refused ?? 'run_missing');
      if (this.host.workerExecutionStopped(runId)) refuse('worker_execution_stopped');
      if (this.host.executionBlockedByRootFinish(run)) refuse('root_finish_pending');
      return { state, run };
    };
    return { refuse, assertCanRegister };
  }

  /**
   * `cezar_ask` (hearsay-tools/cezarion#1234): open the run's human wait with its card. A run holds
   * one: a registration in the turn that opened it replaces its card and keeps its id, and one after
   * the user saw it returns it unchanged. An autonomous run assumes and continues instead, until
   * its automatic wakes are spent.
   */
  async registerAsk(runId: string, request: SquawkAskRequest, generation: string, capabilitySignal?: AbortSignal): Promise<HumanWaitEntry> {
    const card = askCardFields(squawkAskRequestSchema.parse(request));
    const { refuse, assertCanRegister } = this.registrationGate(runId, generation, capabilitySignal);
    const { state: active, run } = assertCanRegister();
    const turnId = active.waitIdentity.ensureCiTurn();
    if (active.boundary.autonomous && this.host.countAutomaticWakes(runId) < this.maxAutoContinues) refuse('autonomous_run');
    // The question this turn's opening answers stays open only until the turn end settles it, so
    // a question asked in that turn is a new one, never the answered one returned
    // (hearsay-tools/cezarion#2397).
    const answering = active.liveSession.session?.open ? active.inputState.openingAnswerAskSeq : undefined;
    const open = WAIT_KINDS.human.duplicateAsk(openWaits(run), answering);
    if (open?.askSeq !== undefined) return open;
    if (!open && !this.host.waitEngine.hasRoom(run)) refuse('capacity');
    const base: HumanWaitEntry = open ?? WAIT_KINDS.human.entry(turnId);
    const { context: _replaced, ...kept } = base;
    return this.host.waitEngine.open(runId, active, { ...kept, ...card }, OPEN_REGISTERED(undefined)).wait!;
  }

  /**
   * Open a CI or timer wait (hearsay-tools/cezarion#1233). Trusted capability callbacks supply run
   * identity; the model supplies only the PR and deadline, or the seconds and note. Refusals throw
   * `{ code }`. An identical registration (same PR; or same seconds and note in the same turn)
   * returns the open wait it repeats.
   */
  async registerWait(runId: string, request: SquawkWaitRequestInput, via: WaitVia, generation: string, capabilitySignal?: AbortSignal): Promise<PrWaitEntry | TimerWaitEntry | WorkerWaitEntry | ProcessWaitEntry | PeerWaitEntry> {
    const parsed = squawkWaitRequestSchema.parse(request);
    const registration = registrationIdentity(parsed);
    const replay = replayRegistration(this.context.store.getRun(runId), registration);
    if (replay) return replay as PrWaitEntry | TimerWaitEntry | WorkerWaitEntry | ProcessWaitEntry | PeerWaitEntry;
    const { refuse, assertCanRegister } = this.registrationGate(runId, generation, capabilitySignal);
    const { state: active, run } = assertCanRegister();
    // hearsay-tools/cezarion#1235, hearsay-tools/cezarion#1995: as `cez worker wait` and `cez message wait`, under the
    // tool's own codes. They answer their own repeat, so they are checked before the capacity below.
    return routeRegistration<RegisteredWait | Promise<RegisteredWait>>(parsed, {
      peer: request => this.registerDelegation(run, refuse,
        () => this.registerPeerWait(runId, { peerIds: request.peer_ids, timeoutSeconds: request.timeout_seconds }, 'cezar_wait', registration)),
      'worker-list': request => this.registerDelegation(run, refuse,
        () => this.registerWorkerListWait(runId, workerListTarget(request), 'cezar_wait', registration)),
      process: request => this.registerProcessWait(runId, active, run, request, via, active.waitIdentity.ensureCiTurn(), registration),
      timer: request => {
        const turnId = active.waitIdentity.ensureCiTurn();
        const repeated = this.repeatOrRefuseFull(runId, run, request, turnId, registration, refuse);
        if (repeated) return repeated;
        this.checkAutomaticWaitAdmission('timer', runId, refuse);
        const wait = timerWaitEntry(request, via, turnId, Date.now());
        return this.host.waitEngine.open(runId, active, wait, OPEN_REGISTERED(registration)).wait!;
      },
      pr: request => {
        const turnId = active.waitIdentity.ensureCiTurn();
        return this.repeatOrRefuseFull(runId, run, request, turnId, registration, refuse)
          ?? this.registerPrWait(runId, active, request, via, generation, turnId, registration, assertCanRegister, refuse, capabilitySignal);
      },
    });
  }

  /** A timer or PR registration that repeats an open wait returns it; otherwise a full list refuses
   *  it. Counted as the store counts them, so a registration accepted here is never refused there. */
  private repeatOrRefuseFull(runId: string, run: RunRecord, request: Extract<SquawkWaitRequest, { kind: 'timer' | 'pr' }>, turnId: string,
    registration: RegistrationIdentity | undefined, refuse: (code: WaitErrorCode) => never): PrWaitEntry | TimerWaitEntry | ProcessWaitEntry | undefined {
    const existing = identicalWait(run.waits ?? [], request, turnId);
    if (existing) return repeatRegistration(this.context.store, runId, existing, WAIT_KINDS[request.kind].requestedTimeout(request), registration) as typeof existing;
    if (!this.host.waitEngine.hasRoom(run)) refuse('capacity');
    return undefined;
  }

  private async registerPrWait(runId: string, active: ActiveRun, pr: Extract<SquawkWaitRequest, { kind: 'pr' }>, via: WaitVia, generation: string, turnId: string,
    registration: RegistrationIdentity | undefined, assertCanRegister: () => unknown, refuse: (code: WaitErrorCode) => never,
    capabilitySignal: AbortSignal | undefined): Promise<PrWaitEntry | TimerWaitEntry> {
    const key = `${runId}\n${normalizePrUrl(pr.pr)}\n${pr.until}\n${pr.wake_on_conflict}`;
    const pending = this.ciRegistrations.get(key);
    if (pending) {
      const wait = await pending.promise;
      return repeatRegistration(this.context.store, runId, wait, pr.timeout_seconds, registration) as typeof wait;
    }
    const abort = new AbortController();
    const signal = capabilitySignal ? AbortSignal.any([abort.signal, capabilitySignal]) : abort.signal;
    const promise = (async () => {
      const assertLookupCurrent = () => {
        assertCanRegister();
        if (signal.aborted) refuse('registration_aborted');
        if (active.waitIdentity.ciTurnId !== turnId) refuse('turn_changed');
      };
      const identity = await this.host.ciSupervisor().resolve(pr.pr, signal).catch(error => {
        assertLookupCurrent();
        throw error;
      });
      assertLookupCurrent();
      // The same PR may have registered while this lookup was in flight under another spelling.
      const repeated = identicalWait(this.context.store.getRun(runId)?.waits ?? [], pr, turnId);
      if (repeated && !WAIT_KINDS.process.is(repeated)) return repeatRegistration(this.context.store, runId, repeated, pr.timeout_seconds, registration) as PrWaitEntry | TimerWaitEntry;
      if (!this.host.waitEngine.hasRoom(this.context.store.getRun(runId) ?? {})) refuse('capacity');
      const wait = prWaitEntry(identity, pr, via, generation, turnId, Date.now());
      return this.host.waitEngine.open(runId, active, wait, OPEN_REGISTERED(registration)).wait!;
    })();
    this.ciRegistrations.set(key, { runId, abort, promise });
    try { return await promise; }
    finally { if (this.ciRegistrations.get(key)?.abort === abort) this.ciRegistrations.delete(key); }
  }

  /** `cezar_wait` kinds `worker`, `request` and `peer` keep the CLI checks under the tool's codes. */
  private registerDelegation<W extends WorkerWaitEntry | PeerWaitEntry>(run: RunRecord, refuse: (code: WaitErrorCode) => never, register: () => W): W {
    if (!run.delegation || run.delegation.role === 'invalid') refuse('denied_scope');
    try { return register(); }
    catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'duplicate_deadline') throw error;
      return refuse(delegationWaitRefusal(error, () => this.host.executionBlockedByRootFinish(run)));
    }
  }

  /** The two automatic kinds share refusal rules, but keep each caller's error policy. */
  private checkAutomaticWaitAdmission(kind: 'timer' | 'process', runId: string, refuse: (code: WaitErrorCode) => never): void {
    const row = WAIT_KINDS[kind];
    if (row.timersDisabled && this.context.semaphore.monitoringWakeIntervalMinutes() === null) refuse('timers_disabled');
    if (row.refusesSpentBudget && this.host.countAutomaticWakes(runId) >= this.maxAutoContinues) refuse('wake_budget_spent');
  }

  /**
   * A process wait (hearsay-tools/cezarion#1446, spec § Process wait decisions). Squawk refuses only
   * what it cannot watch to an end: another user's PID, its own, and an agent session's leader;
   * the agent's shell can already observe any process of its own, so there is no ownership proof.
   * A PID already gone is no error: the command was fast, and the wait resolves at once from its
   * exit file, or as exited.
   */
  private registerProcessWait(runId: string, active: ActiveRun, run: RunRecord, request: Extract<SquawkWaitRequest, { kind: 'process' }>, via: WaitVia, turnId: string, registration?: RegistrationIdentity): ProcessWaitEntry {
    const refuse = (code: WaitErrorCode): never => { throw Object.assign(new Error(waitErrorMessage(code)), { code }); };
    this.checkAutomaticWaitAdmission('process', runId, refuse);
    const roots = this.host.waitEngine.exitFileRoots(runId, run);
    let exitFile: string | undefined;
    if (request.exit_file !== undefined) {
      const confined = confineExitFile(request.exit_file, roots);
      if (!confined.ok) return refuse('exit_file_outside');
      exitFile = confined.path;
    }
    if (request.pid === process.pid || isSessionLeader(request.pid)) refuse('process_not_allowed');
    try { process.kill(request.pid, 0); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'EPERM') refuse('process_not_owned'); }
    const live = recordedProcessLive({ pid: request.pid });
    const startToken = live ? processStartToken(request.pid) : undefined;
    const existing = identicalWait(run.waits ?? [], request, turnId, { ...(startToken === undefined ? {} : { startToken }), ...(exitFile === undefined ? {} : { exitFile }) });
    if (existing && WAIT_KINDS.process.is(existing)) return repeatRegistration(this.context.store, runId, existing, request.timeout_seconds, registration) as ProcessWaitEntry;
    if (!this.host.waitEngine.hasRoom(run)) refuse('capacity');
    const now = Date.now();
    const wait = processWaitEntry(request, via, turnId, now, startToken, exitFile);
    // A PID already gone resolves at once from its exit file, or as exited: no watch arms.
    const settled = live ? {} : { result: probeProcessWait({ pid: wait.pid, deadline: wait.deadline, roots, ...(exitFile === undefined ? {} : { exitFile }) }, now) };
    return this.host.waitEngine.open(runId, active, wait, { ...OPEN_REGISTERED(registration), ...settled }).wait!;
  }

  /**
   * The agent's `cezar_cancel_wait`. An open wait is cancelled with its watch or timer, and no
   * result for it is ever delivered. A resolved wait is already owed: cancelling it is a no-op and
   * its result arrives with the next wake. A settled or unknown id is `not_found`. A human wait the
   * user already sees is theirs to answer (`human_question`); one from this turn can be withdrawn.
   */
  cancelWait(runId: string, waitId: string, generation: string): { cancelled: true } | { cancelled: false; code: 'not_found' | 'already_resolved' | 'human_question' } {
    const state = this.host.active(runId);
    if (this.context.disposed() || !state || state.liveSession.ciGeneration !== generation) {
      throw Object.assign(new Error(waitErrorMessage('generation_mismatch')), { code: 'generation_mismatch' });
    }
    const wait = this.context.store.getRun(runId)?.waits?.find(entry => entry.id === waitId);
    if (!wait) return { cancelled: false, code: 'not_found' };
    if (wait.phase !== 'open') return { cancelled: false, code: 'already_resolved' };
    if (WAIT_KINDS[wait.kind].cancellable === 'unshown' && 'askSeq' in wait && wait.askSeq !== undefined) return { cancelled: false, code: 'human_question' };
    this.host.waitEngine.cancel(runId, [waitId]);
    return { cancelled: true };
  }

}

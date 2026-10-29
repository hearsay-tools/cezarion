import { randomUUID } from 'node:crypto';
import type { RunModuleContext } from './types.ts';
import type { ActiveRun } from '../active-run.ts';
import type { RunRecord } from '../../runs/store.ts';
import type { AgentInput, WorkerWaitRequest } from '@open-mercato/cezar-contract/delegation';
import { cezarAskRequestSchema, cezarWaitRequestSchema, WAIT_LIMIT, type AskErrorCode, type CezarAskRequest, type CezarWaitRequest, type CezarWaitRequestInput, type WaitErrorCode, type WaitVia, type Wait, type HumanWaitEntry, type PrWaitEntry, type TimerWaitEntry, type WorkerWaitEntry, type DeadlinedWorkerWaitEntry, type ProcessWaitEntry, type ProcessWaitResult, type PeerWaitEntry, type PeerWaitResult } from '@open-mercato/cezar-contract/waits';
import type { CiWaitResult } from '@open-mercato/cezar-contract/ci-wait';
import type { CiWatcherSupervisor } from '../../ci-wait/supervisor.ts';
import { askErrorMessage, waitErrorMessage } from '../../ci-wait/errors.ts';
import { toolSessionRefusal } from './cezar-tools.ts';
import { askCardFields } from './turn-markers.ts';
import { chargesBudget, identicalWait, normalizePrUrl, openWaits, waitInputId, waitResultText, timerWaitEntry, prWaitEntry, processWaitEntry, settledWaitEntry } from '../waits.ts';
import { delegationWaitRefusal, isDelegationWait, workerListTarget } from '../wait-scope.ts';
import { isSessionLeader } from '../../core/session-process.ts';
import { probeProcessWait } from '../../process-wait/supervisor.ts';
import { confineExitFile, type ExitFileRoots } from '../../process-wait/exit-file.ts';
import { processStartToken, recordedProcessLive } from '../../delegation/process-liveness.ts';

interface WaitRegistryHost {
  active(id: string): ActiveRun | undefined;
  workerExecutionStopped(id: string): boolean;
  executionBlockedByRootFinish(run: RunRecord): boolean;
  ciSupervisor(): Pick<CiWatcherSupervisor, 'resolve' | 'watch' | 'close'>;
  isParked(id: string): boolean;
  countAutomaticWakes(id: string): number;
  registerPeerWait(id: string, request: { peerIds: string[]; timeoutSeconds: number }, via: 'cezar_wait'): PeerWaitEntry;
  registerWorkerListWait(id: string, request: { workerIds?: string[]; requestIds?: string[] | undefined; mode?: WorkerWaitRequest['mode']; timeoutSeconds: number }, via: 'cezar_wait'): DeadlinedWorkerWaitEntry;
  exitFileRoots(id: string, run: RunRecord): ExitFileRoots;
  disarmWait(id: string): void;
  settleWait(id: string, waitId: string, result?: CiWaitResult | ProcessWaitResult | PeerWaitResult): void;
  withdrawCezarHumanWaits(id: string): void;
  armWait(id: string, wait: Wait): void;
  parkOnWaits(id: string, state: ActiveRun): void;
  cancelAutomaticAtCap(id: string, waits: readonly Wait[]): void;
  reparkWithoutWaits(id: string, state: ActiveRun): void;
  waitOnUserWithoutSession(id: string): void;
  queueWaitWake(id: string): void;
  retryWaitAdmission(id: string): void;
}

export class WaitRegistry {
  readonly ciRegistrations = new Map<string, { runId: string; abort: AbortController; promise: Promise<PrWaitEntry | TimerWaitEntry> }>();
  constructor(private readonly context: RunModuleContext, private readonly host: WaitRegistryHost, private readonly maxAutoContinues: number) {}
  dispose(): void {
    for (const task of this.ciRegistrations.values()) task.abort.abort();
    this.ciRegistrations.clear();
  }
  /** The checks every wait registration shares: the session that called is the run's current one,
   *  and no root finish blocks it. Refusals throw `{ code }`. */
  private registrationGate(runId: string, generation: string, capabilitySignal?: AbortSignal) {
    const state = this.host.active(runId);
    const refuse = (code: WaitErrorCode | AskErrorCode): never => {
      // Fixed codes only: no tool arguments, credentials or provider diagnostics.
      console.warn(`[cez] wait registration refused: ${code}`);
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
  async registerAsk(runId: string, request: CezarAskRequest, generation: string, capabilitySignal?: AbortSignal): Promise<HumanWaitEntry> {
    const card = askCardFields(cezarAskRequestSchema.parse(request));
    const { refuse, assertCanRegister } = this.registrationGate(runId, generation, capabilitySignal);
    const { state: active, run } = assertCanRegister();
    const turnId = active.ciTurnId ??= randomUUID();
    if (active.autonomous && this.host.countAutomaticWakes(runId) < this.maxAutoContinues) refuse('autonomous_run');
    const open = openWaits(run).find((wait): wait is HumanWaitEntry => wait.kind === 'human' && wait.source !== 'cezar');
    if (open?.askSeq !== undefined) return open;
    if (!open && openWaits(run).length >= WAIT_LIMIT) refuse('capacity');
    const base: HumanWaitEntry = open ?? { id: randomUUID(), kind: 'human', source: 'agent', via: 'cezar_ask', registeredAt: new Date().toISOString(), phase: 'open', turnId };
    const { context: _replaced, ...kept } = base;
    return this.openWait(runId, active, { ...kept, ...card });
  }

  /**
   * Open a CI or timer wait (hearsay-tools/cezarion#1233). Trusted capability callbacks supply run
   * identity; the model supplies only the PR and deadline, or the seconds and note. Refusals throw
   * `{ code }`. An identical registration (same PR; or same seconds and note in the same turn)
   * returns the open wait it repeats.
   */
  async registerWait(runId: string, request: CezarWaitRequestInput, via: WaitVia, generation: string, capabilitySignal?: AbortSignal): Promise<PrWaitEntry | TimerWaitEntry | WorkerWaitEntry | ProcessWaitEntry | PeerWaitEntry> {
    const parsed = cezarWaitRequestSchema.parse(request);
    const { refuse, assertCanRegister } = this.registrationGate(runId, generation, capabilitySignal);
    const { state: active, run } = assertCanRegister();
    // hearsay-tools/cezarion#1235, hearsay-tools/cezarion#1995: as `cez worker wait` and `cez message wait`, under the
    // tool's own codes. It answers its own repeat, so it is checked before the capacity below.
    if (isDelegationWait(parsed)) {
      if (!run.delegation || run.delegation.role === 'invalid') refuse('denied_scope');
      try {
        return parsed.kind === 'peer' ? this.host.registerPeerWait(runId, { peerIds: parsed.peer_ids, timeoutSeconds: parsed.timeout_seconds }, 'cezar_wait')
          : this.host.registerWorkerListWait(runId, workerListTarget(parsed), 'cezar_wait');
      } catch (error) { return refuse(delegationWaitRefusal(error, () => this.host.executionBlockedByRootFinish(run))); }
    }
    const turnId = active.ciTurnId ??= randomUUID();
    if (parsed.kind === 'process') return this.registerProcessWait(runId, active, run, parsed, via, turnId);
    const existing = identicalWait(run.waits ?? [], parsed, turnId);
    if (existing) return existing;
    // Counted as the store counts them, so a registration accepted here is never refused there.
    if (openWaits(run).length >= WAIT_LIMIT) refuse('capacity');
    if (parsed.kind === 'timer') {
      if (this.context.semaphore.monitoringWakeIntervalMinutes() === null) refuse('timers_disabled');
      if (this.host.countAutomaticWakes(runId) >= this.maxAutoContinues) refuse('wake_budget_spent');
      const now = Date.now();
      const wait = timerWaitEntry(parsed, via, turnId, now);
      return this.openWait(runId, active, wait);
    }
    const key = `${runId}\n${normalizePrUrl(parsed.pr)}\n${parsed.until}\n${parsed.wake_on_conflict}`;
    const pending = this.ciRegistrations.get(key);
    if (pending) return pending.promise;
    const abort = new AbortController();
    const signal = capabilitySignal ? AbortSignal.any([abort.signal, capabilitySignal]) : abort.signal;
    const promise = (async () => {
      const assertLookupCurrent = () => {
        assertCanRegister();
        if (signal.aborted) refuse('registration_aborted');
        if (active.ciTurnId !== turnId) refuse('turn_changed');
      };
      const identity = await this.host.ciSupervisor().resolve(parsed.pr, signal).catch(error => {
        assertLookupCurrent();
        throw error;
      });
      assertLookupCurrent();
      // The same PR may have registered while this lookup was in flight under another spelling.
      const repeated = identicalWait(this.context.store.getRun(runId)?.waits ?? [], parsed, turnId);
      if (repeated && repeated.kind !== 'process') return repeated;
      if (openWaits(this.context.store.getRun(runId) ?? {}).length >= WAIT_LIMIT) refuse('capacity');
      const now = Date.now();
      const wait = prWaitEntry(identity, parsed, via, generation, turnId, now);
      return this.openWait(runId, active, wait);
    })();
    this.ciRegistrations.set(key, { runId, abort, promise });
    try { return await promise; }
    finally { if (this.ciRegistrations.get(key)?.abort === abort) this.ciRegistrations.delete(key); }
  }

  /**
   * A process wait (hearsay-tools/cezarion#1446, spec § Process wait decisions). Cezar refuses only
   * what it cannot watch to an end: another user's PID, its own, and an agent session's leader;
   * the agent's shell can already observe any process of its own, so there is no ownership proof.
   * A PID already gone is no error: the command was fast, and the wait resolves at once from its
   * exit file, or as exited.
   */
  private registerProcessWait(runId: string, active: ActiveRun, run: RunRecord, request: Extract<CezarWaitRequest, { kind: 'process' }>, via: WaitVia, turnId: string): ProcessWaitEntry {
    const refuse = (code: WaitErrorCode): never => { throw Object.assign(new Error(waitErrorMessage(code)), { code }); };
    if (this.context.semaphore.monitoringWakeIntervalMinutes() === null) refuse('timers_disabled');
    if (this.host.countAutomaticWakes(runId) >= this.maxAutoContinues) refuse('wake_budget_spent');
    const roots = this.host.exitFileRoots(runId, run);
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
    if (existing?.kind === 'process') return existing;
    if (openWaits(run).length >= WAIT_LIMIT) refuse('capacity');
    const now = Date.now();
    const wait = processWaitEntry(request, via, turnId, now, startToken, exitFile);
    const opened = this.openWait(runId, active, wait);
    if (!live) {
      this.host.disarmWait(wait.id);
      this.host.settleWait(runId, wait.id, probeProcessWait({ pid: wait.pid, deadline: wait.deadline, roots, ...(exitFile === undefined ? {} : { exitFile }) }, now));
    }
    return opened;
  }

  /** Commit, arm and (at a boundary) park on a newly registered wait. */
  openWait<W extends Wait>(runId: string, state: ActiveRun, wait: W): W {
    this.host.withdrawCezarHumanWaits(runId);
    try { this.context.store.commitWait(runId, wait); }
    catch { throw Object.assign(new Error(waitErrorMessage('persistence')), { code: 'persistence' }); }
    this.host.armWait(runId, wait);
    if (state.atTurnBoundary === state.session || this.host.isParked(runId)) this.host.parkOnWaits(runId, state);
    // The store keeps the entry it was given; only its phase can have moved since.
    return (this.context.store.getRun(runId)?.waits?.find(entry => entry.id === wait.id) as W | undefined) ?? wait;
  }

  /**
   * The agent's `cezar_cancel_wait`. An open wait is cancelled with its watch or timer, and no
   * result for it is ever delivered. A resolved wait is already owed: cancelling it is a no-op and
   * its result arrives with the next wake. A settled or unknown id is `not_found`. A human wait the
   * user already sees is theirs to answer (`human_question`); one from this turn can be withdrawn.
   */
  cancelWait(runId: string, waitId: string, generation: string): { cancelled: true } | { cancelled: false; code: 'not_found' | 'already_resolved' | 'human_question' } {
    const state = this.host.active(runId);
    if (this.context.disposed() || !state || state.ciGeneration !== generation) {
      throw Object.assign(new Error(waitErrorMessage('generation_mismatch')), { code: 'generation_mismatch' });
    }
    const wait = this.context.store.getRun(runId)?.waits?.find(entry => entry.id === waitId);
    if (!wait) return { cancelled: false, code: 'not_found' };
    if (wait.phase !== 'open') return { cancelled: false, code: 'already_resolved' };
    if (wait.kind === 'human' && wait.askSeq !== undefined) return { cancelled: false, code: 'human_question' };
    this.context.store.commitOutcome(runId, { kind: 'cancelled', waitIds: [waitId] });
    this.host.disarmWait(waitId);
    return { cancelled: true };
  }

  /** Commit an open wait as resolved together with its lifecycle input (id = wait id, or an
   *  upgraded worker wait's `wakeInputId`), then queue the run's wake. A worker wait passes the
   *  entry as reconciled, with its outcomes and `result`. Throws when the checkpoint fails; a wait
   *  no longer open is ignored. */
  resolveWait(runId: string, waitId: string, result?: CiWaitResult | ProcessWaitResult | PeerWaitResult, observed?: WorkerWaitEntry): void {
    const latest = this.context.store.getRun(runId)?.waits?.find(wait => wait.id === waitId);
    if (!latest || latest.phase !== 'open') return;
    const state = this.host.active(runId);
    // The count includes a timer batch still awaiting its acknowledgement.
    if (chargesBudget(latest) && this.host.countAutomaticWakes(runId) >= this.maxAutoContinues) {
      this.host.cancelAutomaticAtCap(runId, [latest]);
      if (state) this.host.reparkWithoutWaits(runId, state);
      else this.host.waitOnUserWithoutSession(runId);
      return;
    }
    const resolvedAt = new Date().toISOString();
    const settled = settledWaitEntry(latest, result, observed, resolvedAt);
    const input: AgentInput = { id: waitInputId(settled), parentRunId: runId, source: 'lifecycle', createdAt: resolvedAt,
      text: waitResultText(settled, { tools: !state?.toolless, workerStatus: this.workerStatus }) };
    this.context.store.commitWait(runId, settled, input);
    try { this.host.queueWaitWake(runId); }
    catch { this.host.retryWaitAdmission(runId); }
  }

  /** A worker's current status, as a worker wait's result names it. */
  readonly workerStatus = (workerId: string): string => this.context.store.getRun(workerId)?.status ?? 'unavailable';

}

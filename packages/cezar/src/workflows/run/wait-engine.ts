import type { Wait, WaitErrorCode, AskErrorCode } from '@open-mercato/cezar-contract/waits';
import type { ActiveRun } from '../active-run.ts';
import type { RunModuleContext } from './types.ts';
import type { RunRecord } from '../../runs/store.ts';
import { assertWaitCapacity, WaitCapacityError } from '../../runs/wait-capacity.ts';
import { waitErrorMessage } from '../../ci-wait/errors.ts';
import { waitCapacityPolicyError } from '../wait-scope.ts';
import { WAIT_KINDS } from './wait-kinds.ts';
import { registrationReceipt, type RegistrationIdentity } from './wait-registration.ts';

export function warnRegistrationRefused(code: WaitErrorCode | AskErrorCode): void {
  console.warn(`[cez] wait registration refused: ${code}`);
}

interface WaitEngineHost {
  withdrawCezarHumanWaits(id: string): void;
  armWait(id: string, wait: Wait): void;
  isParked(id: string): boolean;
  parkOnWaits(id: string, state: ActiveRun): void;
  reconcileWorkerWaits(family?: string): void;
  noticeParkedWorkers(id: string): void;
}

type CapacityPolicy = 'silent' | 'delegation' | ((code: 'capacity') => never);
interface OpenOptions<W extends Wait> {
  withdraw: 'none' | 'first' | 'before-commit';
  existing?: () => W | undefined;
  compare?: CapacityPolicy;
  receipt?: RegistrationIdentity | undefined;
  onCommitFailure: 'persistence' | 'delegation' | 'throw' | { log: string };
  arm: 'watch' | { family: () => string; notice: string } | 'none';
  park: 'boundary' | 'boundary-if-listed' | 'none';
  return: 'stored' | 'recorded-worker' | 'built' | 'none';
}
export type OpenResult<W extends Wait> = { status: 'opened' | 'reused'; wait: W } | { status: 'refused'; wait?: undefined };

/** Executes the ordered steps of wait registration behind the run facade. */
export class WaitEngine {
  constructor(private readonly context: RunModuleContext, private readonly host: WaitEngineHost) {}

  /** Paths with intervening admission checks compare at their original call site. */
  compare(run: Pick<RunRecord, 'waits'>, policy: CapacityPolicy): boolean {
    try { assertWaitCapacity(run); return true; }
    catch (error) {
      if (!(error instanceof WaitCapacityError)) throw error;
      if (policy === 'silent') return false;
      if (policy === 'delegation') throw waitCapacityPolicyError();
      return policy('capacity');
    }
  }

  /** Commit, arm and (at a boundary) park on a newly registered wait. */
  open<W extends Wait>(runId: string, state: ActiveRun | undefined, build: W | (() => W), options: OpenOptions<W>): OpenResult<W> {
    if (options.withdraw === 'first') this.host.withdrawCezarHumanWaits(runId);
    const existing = options.existing?.();
    if (existing) return { status: 'reused', wait: existing };
    if (options.compare && !this.compare(this.context.store.getRun(runId) ?? {}, options.compare)) return { status: 'refused' };
    const wait = typeof build === 'function' ? build() : build;
    if (options.withdraw === 'before-commit') this.host.withdrawCezarHumanWaits(runId);
    if (!this.commit(runId, wait, options)) return { status: 'refused' };
    this.arm(runId, wait, options.arm);
    this.park(runId, state, wait, options.park);
    return { status: 'opened', wait: this.returnedWait(runId, wait, options.return) };
  }

  private commit<W extends Wait>(runId: string, wait: W, options: OpenOptions<W>): boolean {
    try {
      if (options.receipt) this.context.store.commitWait(runId, wait, undefined, registrationReceipt(options.receipt, wait));
      else this.context.store.commitWait(runId, wait);
      return true;
    } catch (error) {
      const policy = options.onCommitFailure;
      if (typeof policy === 'object') {
        console.warn(`${policy.log}: ${error instanceof Error ? error.message : String(error)}`);
        return false;
      }
      if (policy === 'delegation' && error instanceof WaitCapacityError) throw waitCapacityPolicyError();
      if (policy !== 'persistence') throw error;
      if (error instanceof WaitCapacityError) {
        warnRegistrationRefused('capacity');
        throw Object.assign(new Error(waitErrorMessage('capacity')), { code: 'capacity' });
      }
      throw Object.assign(new Error(waitErrorMessage('persistence')), { code: 'persistence' });
    }
  }

  private arm(runId: string, wait: Wait, arm: OpenOptions<Wait>['arm']): void {
    if (arm === 'watch') this.host.armWait(runId, wait);
    else if (typeof arm === 'object') {
      // Outcomes already in resolve it now (or, with every worker destroyed, cancel it); the rest arm it.
      this.host.reconcileWorkerWaits(arm.family());
      // A worker that parked before this wait opened tells the parent now (hearsay-tools/cezarion#1327).
      this.host.noticeParkedWorkers(arm.notice);
    }
  }

  private park(runId: string, state: ActiveRun | undefined, wait: Wait, park: OpenOptions<Wait>['park']): void {
    if (!state || park === 'none') return;
    if (park === 'boundary-if-listed' && !this.context.store.getRun(runId)?.waits?.some(entry => entry.id === wait.id)) return;
    if (state.boundary.atTurnBoundary === state.liveSession.session || this.host.isParked(runId)) this.host.parkOnWaits(runId, state);
  }

  private returnedWait<W extends Wait>(runId: string, wait: W, source: OpenOptions<W>['return']): W {
    if (source === 'built' || source === 'none') return wait;
    const latest = this.context.store.getRun(runId);
    if (source === 'recorded-worker') {
      return (WAIT_KINDS.worker.select([...latest?.waits ?? [], ...latest?.lastWaits ?? []])
        .find(entry => entry.id === wait.id && WAIT_KINDS.worker.hasDeadline(entry)) as W | undefined) ?? wait;
    }
    // The store keeps the entry it was given; only its phase can have moved since.
    return (latest?.waits?.find(entry => entry.id === wait.id) as W | undefined) ?? wait;
  }
}

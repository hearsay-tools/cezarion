import type { Wait } from '@open-mercato/cezar-contract/waits';
import type { ActiveRun } from '../active-run.ts';
import type { RunModuleContext } from './types.ts';
import { WaitCapacityError } from '../../runs/wait-capacity.ts';
import { waitErrorMessage } from '../../ci-wait/errors.ts';
import { registrationReceipt, type RegistrationIdentity } from './wait-registration.ts';

interface WaitEngineHost {
  withdrawCezarHumanWaits(id: string): void;
  armWait(id: string, wait: Wait): void;
  isParked(id: string): boolean;
  parkOnWaits(id: string, state: ActiveRun): void;
}

/** Executes the ordered steps of wait registration behind the run facade. */
export class WaitEngine {
  constructor(private readonly context: RunModuleContext, private readonly host: WaitEngineHost) {}

  /** Commit, arm and (at a boundary) park on a newly registered wait. */
  open<W extends Wait>(runId: string, state: ActiveRun, wait: W, registration?: RegistrationIdentity): W {
    this.host.withdrawCezarHumanWaits(runId);
    try { this.context.store.commitWait(runId, wait, undefined, registrationReceipt(registration, wait)); }
    catch (error) {
      if (error instanceof WaitCapacityError) {
        console.warn('[cez] wait registration refused: capacity');
        throw Object.assign(new Error(waitErrorMessage('capacity')), { code: 'capacity' });
      }
      throw Object.assign(new Error(waitErrorMessage('persistence')), { code: 'persistence' });
    }
    this.host.armWait(runId, wait);
    if (state.boundary.atTurnBoundary === state.liveSession.session || this.host.isParked(runId)) this.host.parkOnWaits(runId, state);
    // The store keeps the entry it was given; only its phase can have moved since.
    return (this.context.store.getRun(runId)?.waits?.find(entry => entry.id === wait.id) as W | undefined) ?? wait;
  }

}

import { logPrefix } from '../../home/display.ts';
import type { WaitEngine } from './wait-engine.ts';
import { WAIT_KINDS } from './wait-kinds.ts';
import { transitionTurnBoundary } from './turn-boundary.ts';
import { randomUUID } from 'node:crypto';
import { type HumanWaitEntry, type WaitVia } from '@open-mercato/cezar-contract/waits';
import type { AskRequest } from '../../core/ask.ts';
import { PROSE_HUMAN_GATE } from '../../runs/transcript-facts.ts';
import type { ActiveRun } from '../active-run.ts';
import { NO_WAIT_NOTE } from '../turn-end.ts';
import { isSquawkHumanWait, openWaits } from '../waits.ts';
import { clearHeldHumanInputTimer, clearUnreadInputTimer } from './input-timers.ts';
import { hasPendingHumanAsk, pendingHumanAskSeq } from './pending-ask-facts.ts';
import { askCardFields, humanWaitCard } from './turn-markers.ts';
import type { RunModuleContext } from './types.ts';

export interface HumanWaitsHost {
  waitEngine: WaitEngine;
  routeWorkerQuestion(runId: string): void;
}

/** Opens, surfaces and withdraws human waits without owning a live session. */
export class HumanWaits {
  constructor(
    private readonly context: RunModuleContext,
    private readonly host: HumanWaitsHost,
    private readonly maxAutoContinues: number,
  ) {}

  /** Ask precedence: the question is pending, and no autonomous nudge goes beside it. Durable
   *  input and waits stay queued until an actual human answer. */
  prepareHumanAsk(state: ActiveRun): void {
    transitionTurnBoundary(state, { kind: 'human-wait-opened', phase: 'prepare', session: state.liveSession.session });
  }

  /** The human gate a human wait without a card raises (live workers with re-checks off):
   * `PROSE_HUMAN_GATE` names it in the transcript. Keep the checkpoint through idle closure/restart
   * and hold worker input until a successful human delivery, just as for a structured ask. */
  raiseHumanGate(runId: string, state: ActiveRun): void {
    this.context.store.appendEvent(runId, { type: 'note', stepId: state.liveSession.currentStepId,
      code: PROSE_HUMAN_GATE, message: 'waiting for a human response to the assistant’s request' });
    this.prepareHumanAsk(state);
    clearUnreadInputTimer(state);
    clearHeldHumanInputTimer(state);
  }

  /** The open human wait nobody has shown the user yet (hearsay-tools/cezarion#1234): one this
   *  turn registered, or one a failure, close or crash caught before its turn end. */
  unsurfacedHumanWait(runId: string): HumanWaitEntry | undefined {
    return WAIT_KINDS.human.select(openWaits(this.context.store.getRun(runId) ?? {})).find(wait => wait.askSeq === undefined);
  }

  /** The human wait this turn end raises: one nobody has seen yet. One registered while a question
   *  is pending waits on that question instead, and raises nothing. */
  turnEndHumanWait(runId: string): HumanWaitEntry | undefined {
    const wait = this.unsurfacedHumanWait(runId);
    if (!wait || !hasPendingHumanAsk(runId, id => pendingHumanAskSeq(this.context.store, id))) return wait;
    this.markHumanWaitSurfaced(runId, wait);
    return undefined;
  }

  /** An alias's human wait, or the one already open: a run holds one. A full list opens none. */
  openHumanAlias(runId: string, state: ActiveRun | undefined, via: WaitVia, card?: AskRequest): HumanWaitEntry | undefined {
    const run = this.context.store.getRun(runId);
    if (!run) return undefined;
    const source = WAIT_KINDS.human.aliasSource(via);
    if (source === 'agent') this.withdrawSquawkHumanWaits(runId);
    const existing = WAIT_KINDS.human.select(openWaits(this.context.store.getRun(runId) ?? run))[0];
    if (existing) return existing;
    if (!this.host.waitEngine.hasRoom(this.context.store.getRun(runId) ?? {})) return undefined;
    const wait = WAIT_KINDS.human.aliasEntry(source, via, state?.waitIdentity.ciTurnId ?? via, card ? askCardFields(card) : undefined);
    return this.host.waitEngine.open(runId, state, wait, { withdraw: false, onCommitFailure: { log: `${logPrefix()} human wait checkpoint failed` }, park: false }).wait;
  }

  /** Record which question a human wait is shown as: the pending card or gate, whose answer settles
   *  it. A card shown in place of the wait's own replaces it. A wait already shown is left alone. */
  markHumanWaitSurfaced(runId: string, wait: HumanWaitEntry, shownCard?: AskRequest): void {
    const askSeq = pendingHumanAskSeq(this.context.store, runId);
    const latest = WAIT_KINDS.human.select(this.context.store.getRun(runId)?.waits ?? []).find(entry => entry.id === wait.id);
    if (askSeq === undefined || !latest || latest.phase !== 'open' || latest.askSeq !== undefined) return;
    const { questions: _questions, context: _context, ...kept } = latest;
    const card = shownCard ?? humanWaitCard(latest);
    try { this.context.store.commitWait(runId, { ...kept, ...(card ? askCardFields(card) : {}), askSeq }); }
    catch (error) { console.warn(`${logPrefix()} human wait checkpoint failed: ${error instanceof Error ? error.message : String(error)}`); }
  }

  /**
   * Show a human wait outside its turn end (hearsay-tools/cezarion#1234): at a boundary, at the
   * budget, or from the failure, close and recovery paths, where no turn end will. A card raises
   * `ask.requested` and goes to a worker's parent; a wait without one raises the human gate. A
   * question already pending is the one it waits on. A wait already shown is left alone. Squawk's
   * own wait is shown as its note instead (`showSquawkHumanWait`).
   */
  surfaceHumanWait(runId: string, state: ActiveRun | undefined, wait = this.unsurfacedHumanWait(runId)): void {
    if (!wait || wait.askSeq !== undefined) return;
    if (wait.source === 'cezar') { this.showSquawkHumanWait(runId, state, wait); return; }
    if (pendingHumanAskSeq(this.context.store, runId) === undefined) {
      const run = this.context.store.getRun(runId);
      const stepId = state?.liveSession.currentStepId ?? run?.currentStepId ?? run?.steps.at(-1)?.id;
      if (wait.questions) {
        this.context.store.appendEvent(runId, { type: 'ask.requested', requestId: randomUUID(), ...askCardFields({ questions: wait.questions, context: wait.context }), ...(stepId ? { stepId } : {}) });
        if (state) this.prepareHumanAsk(state);
      } else if (state) this.raiseHumanGate(runId, state);
      else {
        this.context.store.appendEvent(runId, { type: 'note', ...(stepId ? { stepId } : {}), code: PROSE_HUMAN_GATE, message: 'waiting for a human response to the assistant’s request' });
      }
    } else if (state) transitionTurnBoundary(state, { kind: 'human-wait-opened', phase: 'refresh-question', session: state.liveSession.session, pending: true });
    this.markHumanWaitSurfaced(runId, wait);
    this.host.routeWorkerQuestion(runId);
  }

  /**
   * Squawk's own human wait (`no-wait`, `budget`) is shown as a note, recorded as its `askSeq`, and
   * raises no human gate (hearsay-tools/cezarion#1234). The agent asked nothing: the run waits for
   * the user as the plain park did before these waits, so worker messages still wake it and its
   * wait registrations, `cezar_done` and the user's Finish are not refused. The user's message
   * settles it, and the agent's own wait or question replaces it (`withdrawSquawkHumanWaits`).
   */
  showSquawkHumanWait(runId: string, state: ActiveRun | undefined, wait: HumanWaitEntry, note?: string): void {
    const run = this.context.store.getRun(runId);
    const stepId = state?.liveSession.currentStepId ?? run?.currentStepId ?? run?.steps.at(-1)?.id;
    const shown = this.context.store.appendEvent(runId, { type: 'note', ...(stepId ? { stepId } : {}),
      message: note ?? (wait.via === 'no-wait' ? NO_WAIT_NOTE : wait.via === 'completion' ? 'completion blocked; waiting for you'
        : `automatic-wake budget spent (${this.maxAutoContinues}); waiting for you`) });
    const latest = WAIT_KINDS.human.select(run?.waits ?? []).find(entry => entry.id === wait.id);
    if (!latest || latest.phase !== 'open' || latest.askSeq !== undefined) return;
    try { this.context.store.commitWait(runId, { ...latest, askSeq: shown.seq }); }
    catch (error) { console.warn(`${logPrefix()} human wait checkpoint failed: ${error instanceof Error ? error.message : String(error)}`); }
  }

  /** Squawk waited on the user only because the agent had nothing to wait on: the agent's own wait
   *  or question replaces that wait (hearsay-tools/cezarion#1234). It also ends with the session
   *  that opened it, so a close, an idle close or a failure settles as the plain park did. */
  withdrawSquawkHumanWaits(runId: string): void {
    const ids = openWaits(this.context.store.getRun(runId) ?? {}).filter(isSquawkHumanWait).map(wait => wait.id);
    if (!ids.length) return;
    this.host.waitEngine.cancel(runId, ids, { onCommitFailure: 'skip', log: `${logPrefix()} human wait checkpoint failed` });
  }

  /** Whether a closing session leaves the run waits to park on. Squawk's own human waits end with the
   *  session, even when the store refused their cancellation (`withdrawSquawkHumanWaits`). */
  holdsAgentWaits(runId: string): boolean {
    return (this.context.store.getRun(runId)?.waits ?? []).some(wait => !isSquawkHumanWait(wait));
  }

  /** Read fresh: a boundary the turn end re-enters (Cursor print's ready callback from
   *  `discardQueuedMessages`) may have shown the wait already, and its card stands. */
  humanWaitShown(runId: string, wait: HumanWaitEntry | undefined): boolean {
    return !!wait && WAIT_KINDS.human.select(this.context.store.getRun(runId)?.waits ?? []).some(entry => entry.id === wait.id && entry.askSeq !== undefined) === true;
  }

  /** The turn end raised a card or the gate: record the human wait it shows. */
  recordTurnEndQuestion(runId: string, wait: HumanWaitEntry | undefined, ask: AskRequest | null): void {
    if (wait) this.markHumanWaitSurfaced(runId, wait, ask ?? undefined);
  }
}

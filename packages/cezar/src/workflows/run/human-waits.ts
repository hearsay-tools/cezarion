import { randomUUID } from 'node:crypto';
import { WAIT_LIMIT, type HumanWaitEntry, type WaitVia } from '@open-mercato/cezar-contract/waits';
import type { AskRequest } from '../../core/ask.ts';
import { PROSE_HUMAN_GATE } from '../../runs/transcript-facts.ts';
import type { ActiveRun } from '../active-run.ts';
import { NO_WAIT_NOTE } from '../turn-end.ts';
import { isCezarHumanWait, openWaits } from '../waits.ts';
import { clearHeldHumanInputTimer, clearUnreadInputTimer } from './input-timers.ts';
import { hasPendingHumanAsk, pendingHumanAskSeq } from './pending-ask-facts.ts';
import { askCardFields, humanWaitCard } from './turn-markers.ts';
import type { RunModuleContext } from './types.ts';

export interface HumanWaitsHost {
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
    state.autonomousNudgePending = undefined;
    state.pendingHumanAsk = true;
  }

  /** The human gate a human wait without a card raises (the monitoring line with re-checks off):
   * `PROSE_HUMAN_GATE` names it in the transcript. Keep the checkpoint through idle closure/restart
   * and hold worker input until a successful human delivery, just as for a structured ask. */
  raiseHumanGate(runId: string, state: ActiveRun): void {
    this.context.store.appendEvent(runId, { type: 'note', stepId: state.currentStepId,
      code: PROSE_HUMAN_GATE, message: 'waiting for a human response to the assistant’s request' });
    this.prepareHumanAsk(state);
    clearUnreadInputTimer(state);
    clearHeldHumanInputTimer(state);
  }

  /** The open human wait nobody has shown the user yet (hearsay-tools/cezarion#1234): one this
   *  turn registered, or one a failure, close or crash caught before its turn end. */
  unsurfacedHumanWait(runId: string): HumanWaitEntry | undefined {
    return openWaits(this.context.store.getRun(runId) ?? {}).find((wait): wait is HumanWaitEntry => wait.kind === 'human' && wait.askSeq === undefined);
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
    const source = via === 'budget' || via === 'no-wait' || via === 'completion' ? 'cezar' : 'agent';
    if (source === 'agent') this.withdrawCezarHumanWaits(runId);
    const open = openWaits(this.context.store.getRun(runId) ?? run).find((wait): wait is HumanWaitEntry => wait.kind === 'human');
    if (open || openWaits(this.context.store.getRun(runId) ?? run).length >= WAIT_LIMIT) return open;
    const wait: HumanWaitEntry = { id: randomUUID(), kind: 'human', source, via,
      registeredAt: new Date().toISOString(), phase: 'open', turnId: state?.ciTurnId ?? via, ...(card ? askCardFields(card) : {}) };
    try { this.context.store.commitWait(runId, wait); }
    catch (error) { console.warn(`[cez] human wait checkpoint failed: ${error instanceof Error ? error.message : String(error)}`); return undefined; }
    return wait;
  }

  /** Record which question a human wait is shown as: the pending card or gate, whose answer settles
   *  it. A card shown in place of the wait's own replaces it. A wait already shown is left alone. */
  markHumanWaitSurfaced(runId: string, wait: HumanWaitEntry, shownCard?: AskRequest): void {
    const askSeq = pendingHumanAskSeq(this.context.store, runId);
    const latest = this.context.store.getRun(runId)?.waits?.find((entry): entry is HumanWaitEntry => entry.id === wait.id && entry.kind === 'human');
    if (askSeq === undefined || !latest || latest.phase !== 'open' || latest.askSeq !== undefined) return;
    const { questions: _questions, context: _context, ...kept } = latest;
    const card = shownCard ?? humanWaitCard(latest);
    try { this.context.store.commitWait(runId, { ...kept, ...(card ? askCardFields(card) : {}), askSeq }); }
    catch (error) { console.warn(`[cez] human wait checkpoint failed: ${error instanceof Error ? error.message : String(error)}`); }
  }

  /**
   * Show a human wait outside its turn end (hearsay-tools/cezarion#1234): at a boundary, at the
   * budget, or from the failure, close and recovery paths, where no turn end will. A card raises
   * `ask.requested` and goes to a worker's parent; a wait without one raises the human gate. A
   * question already pending is the one it waits on. A wait already shown is left alone. Cezar's
   * own wait is shown as its note instead (`showCezarHumanWait`).
   */
  surfaceHumanWait(runId: string, state: ActiveRun | undefined, wait = this.unsurfacedHumanWait(runId)): void {
    if (!wait || wait.askSeq !== undefined) return;
    if (wait.source === 'cezar') { this.showCezarHumanWait(runId, state, wait); return; }
    if (pendingHumanAskSeq(this.context.store, runId) === undefined) {
      const run = this.context.store.getRun(runId);
      const stepId = state?.currentStepId ?? run?.currentStepId ?? run?.steps.at(-1)?.id;
      if (wait.questions) {
        this.context.store.appendEvent(runId, { type: 'ask.requested', requestId: randomUUID(), ...askCardFields({ questions: wait.questions, context: wait.context }), ...(stepId ? { stepId } : {}) });
        if (state) this.prepareHumanAsk(state);
      } else if (state) this.raiseHumanGate(runId, state);
      else {
        this.context.store.appendEvent(runId, { type: 'note', ...(stepId ? { stepId } : {}), code: PROSE_HUMAN_GATE, message: 'waiting for a human response to the assistant’s request' });
      }
    } else if (state) state.pendingHumanAsk = true;
    this.markHumanWaitSurfaced(runId, wait);
    this.host.routeWorkerQuestion(runId);
  }

  /**
   * Cezar's own human wait (`no-wait`, `budget`) is shown as a note, recorded as its `askSeq`, and
   * raises no human gate (hearsay-tools/cezarion#1234). The agent asked nothing: the run waits for
   * the user as the plain park did before these waits, so worker messages still wake it and its
   * wait registrations, `cezar_done` and the user's Finish are not refused. The user's message
   * settles it, and the agent's own wait or question replaces it (`withdrawCezarHumanWaits`).
   */
  showCezarHumanWait(runId: string, state: ActiveRun | undefined, wait: HumanWaitEntry, note?: string): void {
    const run = this.context.store.getRun(runId);
    const stepId = state?.currentStepId ?? run?.currentStepId ?? run?.steps.at(-1)?.id;
    const shown = this.context.store.appendEvent(runId, { type: 'note', ...(stepId ? { stepId } : {}),
      message: note ?? (wait.via === 'no-wait' ? NO_WAIT_NOTE : wait.via === 'completion' ? 'completion blocked; waiting for you'
        : `automatic-wake budget spent (${this.maxAutoContinues}); waiting for you`) });
    const latest = run?.waits?.find((entry): entry is HumanWaitEntry => entry.id === wait.id && entry.kind === 'human');
    if (!latest || latest.phase !== 'open' || latest.askSeq !== undefined) return;
    try { this.context.store.commitWait(runId, { ...latest, askSeq: shown.seq }); }
    catch (error) { console.warn(`[cez] human wait checkpoint failed: ${error instanceof Error ? error.message : String(error)}`); }
  }

  /** Cezar waited on the user only because the agent had nothing to wait on: the agent's own wait
   *  or question replaces that wait (hearsay-tools/cezarion#1234). It also ends with the session
   *  that opened it, so a close, an idle close or a failure settles as the plain park did. */
  withdrawCezarHumanWaits(runId: string): void {
    const ids = openWaits(this.context.store.getRun(runId) ?? {}).filter(isCezarHumanWait).map(wait => wait.id);
    if (!ids.length) return;
    try { this.context.store.commitOutcome(runId, { kind: 'cancelled', waitIds: ids }); }
    catch (error) { console.warn(`[cez] human wait checkpoint failed: ${error instanceof Error ? error.message : String(error)}`); }
  }

  /** Whether a closing session leaves the run waits to park on. Cezar's own human waits end with the
   *  session, even when the store refused their cancellation (`withdrawCezarHumanWaits`). */
  holdsAgentWaits(runId: string): boolean {
    return (this.context.store.getRun(runId)?.waits ?? []).some(wait => !isCezarHumanWait(wait));
  }

  /** A valid ask line replaces the card of the human wait its turn registered. It is saved
   *  before the turn end can re-enter a boundary (Cursor print's ready callback from
   *  `discardQueuedMessages`), so a wait shown there shows the later card. */
  latchAskLineCard(runId: string, wait: HumanWaitEntry | undefined, turn: { ask: AskRequest | null; waitCard: boolean }): void {
    if (!wait || !turn.ask || turn.waitCard) return;
    const latest = this.context.store.getRun(runId)?.waits?.find((entry): entry is HumanWaitEntry => entry.id === wait.id && entry.kind === 'human');
    if (!latest || latest.phase !== 'open' || latest.askSeq !== undefined) return;
    const { context: _replaced, ...kept } = latest;
    try { this.context.store.commitWait(runId, { ...kept, ...askCardFields(turn.ask) }); }
    catch (error) { console.warn(`[cez] human wait checkpoint failed: ${error instanceof Error ? error.message : String(error)}`); }
  }

  /** Read fresh: a boundary the turn end re-enters (Cursor print's ready callback from
   *  `discardQueuedMessages`) may have shown the wait already, and its card stands. */
  humanWaitShown(runId: string, wait: HumanWaitEntry | undefined): boolean {
    return !!wait && this.context.store.getRun(runId)?.waits?.some(entry => entry.id === wait.id && entry.kind === 'human' && entry.askSeq !== undefined) === true;
  }

  /** The turn end raised a card or the gate: record the human wait it shows. A turn that registered
   *  none opens the ask line's. */
  recordTurnEndQuestion(runId: string, state: ActiveRun, wait: HumanWaitEntry | undefined, ask: AskRequest | null): void {
    const shown = wait ?? (ask ? this.openHumanAlias(runId, state, 'ask-line', ask) : undefined);
    if (shown) this.markHumanWaitSurfaced(runId, shown, ask ?? undefined);
  }
}

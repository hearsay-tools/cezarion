import { transitionTurnBoundary } from './turn-boundary.ts';
import type { ActiveRun } from '../active-run.ts';

export function clearUnreadInputTimer(state: ActiveRun): void {
  state.inputState.clearUnreadTimer();
}

export function clearHeldHumanInputTimer(state: ActiveRun, resetClock = true): void {
  state.inputState.clearHeldTimer(resetClock);
}

/** #505: the harness accepted input this session has not reported reading yet. */
export function harnessOwesInput(state: ActiveRun | undefined): boolean {
  return !!state?.inputState.unreadInputIds?.size;
}

/** #486: a human follow-up is still queued in the live session and will still be delivered. */
export function harnessHoldsHumanInput(state: ActiveRun): boolean {
  return !state.inputState.heldHumanInputExpired && !!state.liveSession.session?.open && state.liveSession.session.holdsHumanInput();
}

export function clearNoWaitNudgeReplyTimer(state: ActiveRun): void {
  if (state.boundary.noWaitNudgeReplyTimer) {
    clearTimeout(state.boundary.noWaitNudgeReplyTimer);
    transitionTurnBoundary(state, { kind: 'reply-expired', phase: 'cancel', session: state.liveSession.session });
  }
}

export function clearIdleTimer(state: ActiveRun): void {
  if (state.boundary.idleTimer) {
    clearTimeout(state.boundary.idleTimer);
    transitionTurnBoundary(state, { kind: 'idle-expired', phase: 'cancel', session: state.liveSession.session });
  }
  clearNoWaitNudgeReplyTimer(state);
}

export function clearAutosaveTimer(state: ActiveRun): void {
  state.autosave.clearAutosave();
}

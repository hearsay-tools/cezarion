import type { ActiveRun } from '../active-run.ts';

export function clearUnreadInputTimer(state: ActiveRun): void {
  if (state.unreadInputTimer) clearTimeout(state.unreadInputTimer);
  state.unreadInputTimer = undefined;
}

export function clearHeldHumanInputTimer(state: ActiveRun, resetClock = true): void {
  if (state.heldHumanInputTimer) clearTimeout(state.heldHumanInputTimer);
  state.heldHumanInputTimer = undefined;
  if (resetClock) {
    state.heldHumanInputSince = undefined;
    state.heldHumanInputExpired = undefined;
  }
}

/** #505: the harness accepted input this session has not reported reading yet. */
export function harnessOwesInput(state: ActiveRun | undefined): boolean {
  return !!state?.unreadInputIds?.size;
}

/** #486: a human follow-up is still queued in the live session and will still be delivered. */
export function harnessHoldsHumanInput(state: ActiveRun): boolean {
  return !state.heldHumanInputExpired && !!state.session?.open && state.session.holdsHumanInput();
}

export function clearNoWaitNudgeReplyTimer(state: ActiveRun): void {
  if (state.noWaitNudgeReplyTimer) {
    clearTimeout(state.noWaitNudgeReplyTimer);
    state.noWaitNudgeReplyTimer = undefined;
  }
}

export function clearIdleTimer(state: ActiveRun): void {
  if (state.idleTimer) {
    clearTimeout(state.idleTimer);
    state.idleTimer = undefined;
  }
  clearNoWaitNudgeReplyTimer(state);
}

export function clearAutosaveTimer(state: ActiveRun): void {
  if (state.autosaveTimer) {
    clearInterval(state.autosaveTimer);
    state.autosaveTimer = undefined;
  }
}

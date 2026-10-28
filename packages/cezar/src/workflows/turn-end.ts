/**
 * Shared turn-end decision for initial sessions, Continue and late input ACKs. Owed input
 * defers; done and waits take precedence. Every agent step completes only on a done
 * (hearsay-tools/cezarion#1620): a no-wait turn gets bounded nudges, then a human wait; never
 * classify prose.
 *
 * A nudge has a cause. No wait: the turn named neither a wait nor a done. Completion: the agent's
 * done was refused by the completion gate (hearsay-tools/cezarion#1301). Each cause keeps its own
 * order: the completion cause takes its second step before it checks the budget, the no-wait cause
 * checks the budget first, and a nudge the wire refuses ends differently for each (`ifRefused`).
 */

/** What a turn end knows when it decides. */
export type TurnEndFacts = {
  /** The session is still open. A closed one settles elsewhere. */
  sessionOpen: boolean;
  /** `cezar_done` was accepted this turn, or the done line. */
  done: boolean;
  /** The completion gate refused that done. `liveWorkers`: live workers block it. */
  doneRefused?: { liveWorkers: boolean };
  /** A submission still awaits its acknowledgement. */
  inputInFlight: boolean;
  /** Input the harness has not taken, beside any flight: queued, or delivered and still unread. */
  inputQueued: boolean;
  /** The result of delivering owed input at this turn end. Undefined: not tried yet, and the rule
   *  answers `take-input` when it needs it. False when the entry delivers nothing of its own. */
  inputTaken?: boolean | undefined;
  /** An autonomous nudge the wire refused waits for input readiness at this boundary. */
  nudgePending: boolean;
  /** This turn's ask: an ask line, or the card of a human wait it registered. Owed input waits
   *  behind it. */
  turnAsk: boolean;
  /** A native ask still pending in the live session. A done waits behind it. */
  nativeAsk: boolean;
  /** Any question: this turn's ask or human gate, a pending ask, an open human wait. */
  question: boolean;
  /** The agent's own waits: every wait but Cezar's human waits. */
  agentWaits: boolean;
  /** Cezar's own human wait is open (`no-wait`, `budget`, `completion`). */
  cezarHumanWait: boolean;
  /** The session's done completes a workflow step that is not the last, not the task
   *  (hearsay-tools/cezarion#1620). Only the nudge wording reads it. */
  stepScope: boolean;
  /** The turn that just ended answered Cezar's no-wait nudge. */
  noWaitNudgedLastTurn: boolean;
  /** The turn that just ended answered Cezar's completion nudge. */
  completionNudgedLastTurn: boolean;
  autonomous: boolean;
  /** `automaticWakes` reached `MAX_AUTO_CONTINUES`. */
  budgetSpent: boolean;
  /** The session has cezar tools; without them the nudge names the lifecycle markers. */
  tools: boolean;
};

export type NudgeCause = 'no-wait' | 'completion';

/** `refused`: the decision follows a refused done, whose refusal the turn end records as a note. */
export type TurnEndDecision =
  | { kind: 'closed' }
  | { kind: 'take-input'; refused?: true }
  | { kind: 'input'; refused?: true }
  | { kind: 'defer'; keepDone?: true; refused?: true }
  | { kind: 'done' }
  | { kind: 'park'; refused?: true }
  | { kind: 'completion-wait' }
  /** `text` is absent for the completion cause: the refusal message is the nudge. A refused
   *  submission waits for input readiness (autonomous), opens Cezar's no-wait human wait, or parks
   *  for the user (completion). */
  | { kind: 'nudge'; cause: NudgeCause; text?: string; ifRefused: 'readiness' | 'human-wait' | 'park-for-user'; refused?: true }
  | { kind: 'human-wait'; via: 'no-wait' | 'budget' | 'completion'; refused?: true };

export const AUTONOMOUS_NUDGE =
  'Continue working autonomously until the task is fully complete. Do not ask me for confirmation or clarification — make reasonable assumptions and proceed. When everything is done, end the session with your done signal.';

/** The no-wait nudge. It names the wait kinds `cezar_wait` takes. */
export const NO_WAIT_NUDGE =
  'Your turn ended without a wait or done. Call cezar_ask if you need the user, cezar_wait (pr, worker, request, peer, timer or process) if you are waiting on something, or cezar_done if the task is complete. If you owe the user a reply, write it in the same turn.';

/** The no-wait nudge for a session without cezar tools, which was taught the markers. */
export const NO_WAIT_NUDGE_MARKERS =
  'Your turn ended without a wait or done. End your message with a CEZ:ASK line if you need the user, a CEZ:MONITORING line if you are waiting on something, or a CEZ:DONE line if the task is complete. If you owe the user a reply, write it in the same turn.';

/** Appended to a nudge in a session whose done completes a workflow step, not the task
 *  (hearsay-tools/cezarion#1620). Appended, so the nudge keeps its opening words. */
/** A nudge as an earlier workflow step receives it: with the step suffix when `stepScope` holds. */
export function stepScopedNudge(text: string, stepScope: boolean): string {
  return stepScope ? `${text} ${STEP_NUDGE_SUFFIX}` : text;
}

export const STEP_NUDGE_SUFFIX =
  'In this workflow step, the done signal completes this step\'s own work, and Cezar then starts the next step.';

export function decideTurnEnd(facts: TurnEndFacts): TurnEndDecision {
  if (!facts.sessionOpen) return { kind: 'closed' };
  if (facts.doneRefused) {
    // An input still in flight may be the one this turn answered, acknowledged after the turn end
    // (OpenCode HTTP/SSE): the done stays at the boundary, and the acknowledgement decides it.
    if (facts.inputInFlight && !facts.inputQueued && !facts.agentWaits) return { kind: 'defer', keepDone: true };
    // The agent's open waits and owed input come first: the refusal is a note, and the turn end
    // goes on as one without a done.
    if (facts.agentWaits || facts.inputInFlight || facts.inputQueued) return { ...decideWithoutDone({ ...facts, done: false }) as Extract<TurnEndDecision, { refused?: true }>, refused: true };
    // One nudge per cycle: the turn that answered it ended on a refused done again. Cezar waits on
    // the live workers, else on the user; an autonomous run is nudged again instead.
    if (facts.completionNudgedLastTurn && !facts.autonomous) {
      return facts.doneRefused.liveWorkers ? { kind: 'completion-wait' } : { kind: 'human-wait', via: 'completion' };
    }
    if (facts.budgetSpent) return { kind: 'human-wait', via: 'budget' };
    return { kind: 'nudge', cause: 'completion', ifRefused: 'park-for-user' };
  }
  return decideWithoutDone(facts);
}

function decideWithoutDone(facts: TurnEndFacts): TurnEndDecision {
  if (!facts.turnAsk && facts.inputTaken === undefined) return { kind: 'take-input' };
  if (facts.inputTaken) return { kind: 'input' };
  if (facts.done && !facts.nativeAsk && !facts.inputInFlight && !facts.inputQueued) return { kind: 'done' };
  if (facts.nudgePending) return { kind: 'defer' };
  if (facts.question || facts.agentWaits || facts.cezarHumanWait) return { kind: 'park' };
  if (facts.budgetSpent) return { kind: 'human-wait', via: 'budget' };
  // An autonomous run is nudged on every such turn end until the budget is spent.
  const scoped = (text: string) => stepScopedNudge(text, facts.stepScope);
  if (facts.autonomous) return { kind: 'nudge', cause: 'no-wait', text: scoped(AUTONOMOUS_NUDGE), ifRefused: 'readiness' };
  if (facts.noWaitNudgedLastTurn) return { kind: 'human-wait', via: 'no-wait' };
  return { kind: 'nudge', cause: 'no-wait', text: scoped(facts.tools ? NO_WAIT_NUDGE : NO_WAIT_NUDGE_MARKERS), ifRefused: 'human-wait' };
}

/** How a settled turn end left the run. */
export type TurnEndOutcome =
  | { kind: 'nudge'; cause: NudgeCause; autonomous: boolean }
  | { kind: 'readiness' }
  | { kind: 'running' }
  | { kind: 'park'; keepsSlot: boolean }
  | { kind: 'done' };

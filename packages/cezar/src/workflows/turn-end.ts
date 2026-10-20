/**
 * The turn-end rule (spec 2026-10-17-unified-waits, hearsay-tools/cezarion#1234): one decision
 * for both turn-end handlers and the boundary an acknowledgement settles late. Input already on
 * its way defers; done finishes; any open wait parks; a non-final workflow step completes; any
 * other turn end gets one nudge, then a human wait. There is no prose classification.
 */

/** What a turn end knows when it decides. */
export type TurnEndFacts = {
  /** Input already on its way into this session: held human input, unread or in-flight agent
   *  input, an admitted wake. The next turn end decides. */
  inputOwed: boolean;
  /** `cezar_done` was accepted this turn, or the done line. */
  done: boolean;
  /** An open wait of any kind, a pending question, a registered worker wait. */
  waiting: boolean;
  /** The interactive step (the last agent step), or any continuation. */
  finalStep: boolean;
  /** The turn that just ended answered Cezar's no-wait nudge. */
  nudgedLastTurn: boolean;
  autonomous: boolean;
  /** `automaticWakes` reached `MAX_AUTO_CONTINUES`. */
  budgetSpent: boolean;
  /** The session has cezar tools; without them the nudge names the lifecycle markers. */
  tools: boolean;
};

export type TurnEndDecision =
  | { kind: 'defer' }
  | { kind: 'done' }
  | { kind: 'park' }
  | { kind: 'complete-step' }
  | { kind: 'nudge'; text: string }
  | { kind: 'human-wait'; via: 'no-wait' | 'budget' };

export const AUTONOMOUS_NUDGE =
  'Continue working autonomously until the task is fully complete. Do not ask me for confirmation or clarification — make reasonable assumptions and proceed. When everything is done, end the session with your done signal.';

/** The no-wait nudge. It names the wait kinds `cezar_wait` takes. */
export const NO_WAIT_NUDGE =
  'Your turn ended without a wait or done. Call cezar_ask if you need the user, cezar_wait (ci, worker or timer) if you are waiting on something, or cezar_done if the task is complete. If you owe the user a reply, write it in the same turn.';

/** The no-wait nudge for a session without cezar tools, which was taught the markers. */
export const NO_WAIT_NUDGE_MARKERS =
  'Your turn ended without a wait or done. End your message with a CEZ:ASK line if you need the user, a CEZ:MONITORING line if you are waiting on something, or a CEZ:DONE line if the task is complete. If you owe the user a reply, write it in the same turn.';

export function decideTurnEnd(facts: TurnEndFacts): TurnEndDecision {
  if (facts.inputOwed) return { kind: 'defer' };
  if (facts.done) return { kind: 'done' };
  if (facts.waiting) return { kind: 'park' };
  if (!facts.finalStep) return { kind: 'complete-step' };
  if (facts.budgetSpent) return { kind: 'human-wait', via: 'budget' };
  // An autonomous run is nudged on every such turn end until the budget is spent.
  if (facts.autonomous) return { kind: 'nudge', text: AUTONOMOUS_NUDGE };
  if (facts.nudgedLastTurn) return { kind: 'human-wait', via: 'no-wait' };
  return { kind: 'nudge', text: facts.tools ? NO_WAIT_NUDGE : NO_WAIT_NUDGE_MARKERS };
}

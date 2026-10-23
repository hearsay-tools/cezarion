import { describe, expect, it } from 'vitest';
import { AUTONOMOUS_NUDGE, decideTurnEnd, NO_WAIT_NUDGE, NO_WAIT_NUDGE_MARKERS, turnEndHeartbeat, type TurnEndDecision, type TurnEndFacts, type TurnEndOutcome } from './turn-end.ts';

/** A quiet final turn end whose owed input was already tried: nothing taken, nothing owed. */
const quiet: TurnEndFacts = {
  sessionOpen: true, done: false, inputInFlight: false, inputQueued: false, inputTaken: false, nudgePending: false,
  turnAsk: false, nativeAsk: false, question: false, agentWaits: false, cezarHumanWait: false, finalStep: true,
  noWaitNudgedLastTurn: false, completionNudgedLastTurn: false, autonomous: false, budgetSpent: false, tools: true,
};
const live = { doneRefused: { liveWorkers: true }, done: true };
const settled = { doneRefused: { liveWorkers: false }, done: true };
const noWaitNudge: TurnEndDecision = { kind: 'nudge', cause: 'no-wait', text: NO_WAIT_NUDGE, ifRefused: 'human-wait' };
const autonomousNudge: TurnEndDecision = { kind: 'nudge', cause: 'no-wait', text: AUTONOMOUS_NUDGE, ifRefused: 'readiness' };
const completionNudge: TurnEndDecision = { kind: 'nudge', cause: 'completion', ifRefused: 'park-for-user' };

describe('decideTurnEnd decides both nudge causes (hearsay-tools/cezarion#1234, hearsay-tools/cezarion#1525)', () => {
  it.each<[string, Partial<TurnEndFacts>, TurnEndDecision]>([
    // Every entry
    ['a closed session settles nothing', { sessionOpen: false, done: true, autonomous: true }, { kind: 'closed' }],
    ['owed input is tried first', { inputTaken: undefined }, { kind: 'take-input' }],
    ['this turn\'s ask keeps owed input back', { inputTaken: undefined, turnAsk: true, question: true }, { kind: 'park' }],
    ['input taken runs as the next turn', { inputTaken: true }, { kind: 'input' }],
    ['input taken outranks a done', { inputTaken: true, done: true }, { kind: 'input' }],
    // Done
    ['done finishes', { done: true }, { kind: 'done' }],
    ['done outranks an open wait', { done: true, agentWaits: true, question: true }, { kind: 'done' }],
    ['done waits behind a native ask', { done: true, nativeAsk: true, question: true }, { kind: 'park' }],
    ['done waits behind input in flight', { done: true, inputInFlight: true }, noWaitNudge],
    ['done waits behind queued input', { done: true, inputQueued: true }, noWaitNudge],
    // No-wait cause
    ['a refused autonomous nudge defers to input readiness', { nudgePending: true }, { kind: 'defer' }],
    ['readiness outranks an open wait', { nudgePending: true, agentWaits: true }, { kind: 'defer' }],
    ['an open agent wait parks', { agentWaits: true }, { kind: 'park' }],
    ['a question parks', { question: true }, { kind: 'park' }],
    ['Cezar\'s own human wait parks', { cezarHumanWait: true }, { kind: 'park' }],
    ['waiting outranks a non-final step', { agentWaits: true, finalStep: false }, { kind: 'park' }],
    ['a non-final step with no wait completes', { finalStep: false }, { kind: 'complete-step' }],
    ['a non-final step completes even with the budget spent', { finalStep: false, budgetSpent: true }, { kind: 'complete-step' }],
    ['no wait gets the nudge', {}, noWaitNudge],
    ['no wait without cezar tools gets the marker nudge', { tools: false }, { ...noWaitNudge, text: NO_WAIT_NUDGE_MARKERS }],
    ['a second no-wait turn end opens the no-wait human wait', { noWaitNudgedLastTurn: true }, { kind: 'human-wait', via: 'no-wait' }],
    ['a spent budget opens the budget human wait', { budgetSpent: true }, { kind: 'human-wait', via: 'budget' }],
    ['no wait checks the budget before the second step', { budgetSpent: true, noWaitNudgedLastTurn: true }, { kind: 'human-wait', via: 'budget' }],
    ['an autonomous run gets the autonomous nudge', { autonomous: true }, autonomousNudge],
    ['an autonomous nudge repeats', { autonomous: true, noWaitNudgedLastTurn: true }, autonomousNudge],
    ['an autonomous run with the budget spent opens the budget human wait', { autonomous: true, budgetSpent: true }, { kind: 'human-wait', via: 'budget' }],
    ['a completion nudge last turn does not count for no wait', { completionNudgedLastTurn: true }, noWaitNudge],
    // Completion cause
    ['a refused done with only input in flight keeps the done for the acknowledgement', { ...live, inputInFlight: true }, { kind: 'defer', keepDone: true }],
    ['a refused done beside an open agent wait parks on it', { ...live, agentWaits: true }, { kind: 'park', refused: true }],
    ['a refused done beside input in flight and queued input takes the input', { ...live, inputInFlight: true, inputQueued: true, inputTaken: undefined }, { kind: 'take-input', refused: true }],
    ['a refused done beside queued input that is taken runs it', { ...live, inputQueued: true, inputTaken: true }, { kind: 'input', refused: true }],
    ['a refused done is never a done', { ...live, inputQueued: true }, { ...noWaitNudge, refused: true }],
    ['a refused done withdraws Cezar\'s human wait and nudges', { ...live, cezarHumanWait: true }, completionNudge],
    ['a refused done gets the completion nudge', live, completionNudge],
    ['a refused done by settled workers gets the completion nudge', settled, completionNudge],
    ['owed input is not tried before the refusal decides', { ...live, inputTaken: undefined }, completionNudge],
    ['a second refused done with live workers parks on the completion wait', { ...live, completionNudgedLastTurn: true }, { kind: 'completion-wait' }],
    ['a second refused done by settled workers parks for the user', { ...settled, completionNudgedLastTurn: true }, { kind: 'human-wait', via: 'completion' }],
    ['completion takes its second step before the budget', { ...live, completionNudgedLastTurn: true, budgetSpent: true }, { kind: 'completion-wait' }],
    ['a spent budget opens the budget human wait for a refused done', { ...live, budgetSpent: true }, { kind: 'human-wait', via: 'budget' }],
    ['an autonomous refused done is nudged again', { ...live, completionNudgedLastTurn: true, autonomous: true }, completionNudge],
    ['an autonomous refused done with the budget spent opens the budget human wait', { ...live, completionNudgedLastTurn: true, autonomous: true, budgetSpent: true }, { kind: 'human-wait', via: 'budget' }],
    ['a no-wait nudge last turn does not count for completion', { ...live, noWaitNudgedLastTurn: true }, completionNudge],
  ])('%s', (_name, facts, decision) => {
    expect(decideTurnEnd({ ...quiet, ...facts })).toEqual(decision);
  });

  it('a refused submission ends differently for each cause', () => {
    expect(decideTurnEnd(quiet)).toMatchObject({ ifRefused: 'human-wait' });
    expect(decideTurnEnd({ ...quiet, autonomous: true })).toMatchObject({ ifRefused: 'readiness' });
    expect(decideTurnEnd({ ...quiet, ...live })).toMatchObject({ ifRefused: 'park-for-user' });
  });

  it('the nudges name only tools and kinds that exist in this phase', () => {
    expect(NO_WAIT_NUDGE).toBe('Your turn ended without a wait or done. Call cezar_ask if you need the user, cezar_wait (ci, worker or timer) if you are waiting on something, or cezar_done if the task is complete. If you owe the user a reply, write it in the same turn.');
    expect(NO_WAIT_NUDGE_MARKERS.startsWith('Your turn ended without a wait or done. ')).toBe(true);
    for (const marker of ['CEZ:ASK', 'CEZ:MONITORING', 'CEZ:DONE']) expect(NO_WAIT_NUDGE_MARKERS).toContain(marker);
    expect(NO_WAIT_NUDGE_MARKERS).not.toContain('cezar_');
  });
});

describe('turnEndHeartbeat gives one word per outcome (hearsay-tools/cezarion#1525)', () => {
  it.each<[TurnEndOutcome, string | undefined]>([
    [{ kind: 'nudge', cause: 'completion', autonomous: false }, 'running (completion nudge)'],
    [{ kind: 'nudge', cause: 'completion', autonomous: true }, 'running (completion nudge)'],
    [{ kind: 'nudge', cause: 'no-wait', autonomous: true }, 'running (autonomous nudge)'],
    [{ kind: 'nudge', cause: 'no-wait', autonomous: false }, 'running (no-wait nudge)'],
    [{ kind: 'readiness' }, 'running (awaiting input readiness)'],
    [{ kind: 'running' }, 'running'],
    [{ kind: 'park', keepsSlot: true }, 'monitoring'],
    [{ kind: 'park', keepsSlot: false }, 'waiting'],
    [{ kind: 'done' }, undefined],
  ])('%o writes %s', (outcome, word) => {
    expect(turnEndHeartbeat(outcome)).toBe(word);
  });
});

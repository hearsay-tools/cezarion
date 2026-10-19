import { describe, expect, it } from 'vitest';
import { AUTONOMOUS_NUDGE, decideTurnEnd, NO_WAIT_NUDGE, NO_WAIT_NUDGE_MARKERS, type TurnEndDecision, type TurnEndFacts } from './turn-end.ts';

const quiet: TurnEndFacts = {
  inputOwed: false, done: false, waiting: false, finalStep: true, nudgedLastTurn: false,
  autonomous: false, budgetSpent: false, tools: true,
};

describe('decideTurnEnd follows the spec\'s three branches (hearsay-tools/cezarion#1234)', () => {
  it.each<[string, Partial<TurnEndFacts>, TurnEndDecision]>([
    ['input already owed defers', { inputOwed: true }, { kind: 'defer' }],
    ['done with input owed defers', { inputOwed: true, done: true }, { kind: 'defer' }],
    ['done finishes', { done: true }, { kind: 'done' }],
    ['done outranks an open wait', { done: true, waiting: true }, { kind: 'done' }],
    ['an open wait parks', { waiting: true }, { kind: 'park' }],
    ['waiting outranks a non-final step', { waiting: true, finalStep: false }, { kind: 'park' }],
    ['a non-final step with no wait completes', { finalStep: false }, { kind: 'complete-step' }],
    ['a non-final step completes even with the budget spent', { finalStep: false, budgetSpent: true }, { kind: 'complete-step' }],
    ['no wait gets the nudge', {}, { kind: 'nudge', text: NO_WAIT_NUDGE }],
    ['no wait without cezar tools gets the marker nudge', { tools: false }, { kind: 'nudge', text: NO_WAIT_NUDGE_MARKERS }],
    ['a second no-wait turn end opens the no-wait human wait', { nudgedLastTurn: true }, { kind: 'human-wait', via: 'no-wait' }],
    ['a spent budget opens the budget human wait', { budgetSpent: true }, { kind: 'human-wait', via: 'budget' }],
    ['a spent budget outranks the second no-wait turn end', { budgetSpent: true, nudgedLastTurn: true }, { kind: 'human-wait', via: 'budget' }],
    ['an autonomous run gets the autonomous nudge', { autonomous: true }, { kind: 'nudge', text: AUTONOMOUS_NUDGE }],
    ['an autonomous nudge repeats', { autonomous: true, nudgedLastTurn: true }, { kind: 'nudge', text: AUTONOMOUS_NUDGE }],
    ['an autonomous run with the budget spent opens the budget human wait', { autonomous: true, budgetSpent: true }, { kind: 'human-wait', via: 'budget' }],
  ])('%s', (_name, facts, decision) => {
    expect(decideTurnEnd({ ...quiet, ...facts })).toEqual(decision);
  });

  it('the nudges name only tools and kinds that exist in this phase', () => {
    expect(NO_WAIT_NUDGE).toBe('Your turn ended without a wait or done. Call cezar_ask if you need the user, cezar_wait (ci or timer) if you are waiting on something, or cezar_done if the task is complete. If you owe the user a reply, write it in the same turn.');
    expect(NO_WAIT_NUDGE_MARKERS.startsWith('Your turn ended without a wait or done. ')).toBe(true);
    for (const marker of ['CEZ:ASK', 'CEZ:MONITORING', 'CEZ:DONE']) expect(NO_WAIT_NUDGE_MARKERS).toContain(marker);
    expect(NO_WAIT_NUDGE_MARKERS).not.toContain('cezar_');
  });
});

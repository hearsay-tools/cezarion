import { describe, expect, it } from 'vitest';
import { REPLAY_CASES, mismatch, replayDecision, scriptedEngine } from './replay-set.testkit.ts';

describe('the voice replay set', () => {
  it('covers the cases the issue names', () => {
    const names = REPLAY_CASES.map((c) => c.name);
    expect(new Set(names).size).toBe(names.length);
    const actions = new Set(REPLAY_CASES.map((c) => c.expect.action));
    expect([...actions].sort()).toEqual(['answer', 'none', 'open', 'tell']);
    const reasons = REPLAY_CASES.flatMap((c) => (c.expect.action === 'none' ? [c.expect.reason] : []));
    expect(new Set(reasons)).toEqual(new Set(['unclear', 'unsupported', 'no-open-task', 'stale-context']));
  });

  it.each(REPLAY_CASES.map((c) => [c.name, c] as const))('%s', async (_name, replay) => {
    const { decision } = await replayDecision(replay, scriptedEngine(replay.scripted));
    expect(mismatch(replay.expect, decision)).toBeUndefined();
  });

  it('reports a mismatch in words', () => {
    expect(mismatch({ action: 'tell', text: 'a' }, { action: 'tell', decisionId: 'd', runId: 'r', text: 'b', confidence: 1 })).toBe(
      'expected text "a", got "b"',
    );
    expect(mismatch({ action: 'none', reason: 'unclear' }, { action: 'tell', decisionId: 'd', runId: 'r', text: 'b', confidence: 1 })).toBe(
      'expected none, got tell',
    );
  });
});

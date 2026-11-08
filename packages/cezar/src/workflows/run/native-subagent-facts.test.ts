import { describe, expect, it, vi } from 'vitest';
import { reportsNativeSubagents } from './subagent-waits.ts';

// Swap the declarations of codex and pi, so the test proves the subagent wait reads the declared
// `nativeSubagents` and not the runner id (hearsay-tools/cezarion#2991).
vi.mock('../../core/runner-facts.ts', async (load) => {
  const actual = await load<typeof import('../../core/runner-facts.ts')>();
  return { ...actual, RUNNER_FACTS: {
    ...actual.RUNNER_FACTS,
    codex: { ...actual.RUNNER_FACTS.codex, nativeSubagents: 'unreported' },
    pi: { ...actual.RUNNER_FACTS.pi, nativeSubagents: 'reported' },
  } };
});

describe('native subagent waits follow the runner\'s declaration', () => {
  it('waits on children only for a runner whose wire reports them', () => {
    expect(reportsNativeSubagents('pi')).toBe(true);
    expect(reportsNativeSubagents('codex')).toBe(false);
    expect(reportsNativeSubagents(undefined)).toBe(false);
  });
});

import { describe, expect, it } from 'vitest';
import { STEP_KIND, STEP_STATUS, makeRunRecord, makeStepState } from '@open-mercato/cezar-contract/test-factories.testkit';
import { sessionAffinity } from './continuation-admission.ts';

// hearsay-tools/squawk#3337: a provider-error retry of a mixed-runner root keeps the held step's runner.
describe('sessionAffinity', () => {
  const step = makeStepState({ id: 'review', kind: STEP_KIND.agent, status: STEP_STATUS.failed, sessionId: 'claude-session', backend: 'claude' });
  const run = makeRunRecord({ runner: 'codex', steps: [step] });

  it('resumes the held step on its own runner for a provider retry', () => {
    expect(sessionAffinity(run, { retryRunner: 'claude' }, undefined, step, false)).toEqual({ originalRunner: 'claude', targetRunner: 'claude', resume: true });
  });

  it('resumes on the held step\'s own account for a provider retry', () => {
    const owned = makeStepState({ ...step, profileId: 'work-account' });
    const pinned = { ...run, agentProfile: 'personal', steps: [owned] };
    expect(sessionAffinity(pinned, { retryRunner: 'claude' }, undefined, owned, false)).toMatchObject({ targetRunner: 'claude', resume: true });
    expect(sessionAffinity(pinned, {}, undefined, owned, false)).toMatchObject({ resume: false });
  });

  it('keeps the run runner for any other Continue', () => {
    expect(sessionAffinity(run, {}, undefined, step, false)).toEqual({ originalRunner: 'codex', targetRunner: 'codex', resume: false });
  });
});

import { describe, expect, it } from 'vitest';
import {
  acceptedWorkerIdentitySchema, workerExecutionIdentitySchema, workerStepIdentity, WorkerIdentityError,
  type AcceptedWorkerIdentity,
} from './execution-identity.ts';

const claude = { provider: 'claude' as const, profileId: 'default', homePath: '/home/x/.claude', claudeLayout: { kind: 'relocated' as const } };
const codex = { provider: 'codex' as const, profileId: 'work', homePath: '/home/x/codex-work' };
const runLevel = { kind: 'accepted' as const, account: claude, grants: { allowedTools: ['Read'] }, model: 'opus', effort: 'high' };

describe('per-step worker identity (#452)', () => {
  it('still loads evidence written before per-step entries existed and answers every step with the run-level view', () => {
    const identity = workerExecutionIdentitySchema.parse(JSON.parse(JSON.stringify(runLevel))) as AcceptedWorkerIdentity;
    expect(identity).not.toHaveProperty('steps');
    for (const stepId of ['task', 'inspect', 'continue-3']) {
      expect(workerStepIdentity(identity, stepId)).toEqual({ account: claude, grants: { allowedTools: ['Read'] }, model: 'opus', effort: 'high' });
    }
  });
  it('pins one account, model, effort and grant set per agent step', () => {
    const identity = acceptedWorkerIdentitySchema.parse({ ...runLevel, steps: [
      { stepId: 'implement', account: codex, grants: { allowedTools: [] }, model: 'gpt-5.1-codex' },
      { stepId: 'review', account: claude, grants: { allowedTools: ['Read'], bashAllowlist: ['git diff'] }, model: 'opus', effort: 'high' },
    ] });
    expect(workerStepIdentity(identity, 'implement')).toEqual({ account: codex, grants: { allowedTools: [] }, model: 'gpt-5.1-codex' });
    expect(workerStepIdentity(identity, 'review')).toMatchObject({ account: claude, effort: 'high', grants: { bashAllowlist: ['git diff'] } });
    // Explicit entries are authority: a step the acceptance never saw has no identity to run under.
    expect(() => workerStepIdentity(identity, 'verify')).toThrow(WorkerIdentityError);
  });
  it('rejects a step entry with unknown keys or a missing grant record', () => {
    expect(acceptedWorkerIdentitySchema.safeParse({ ...runLevel, steps: [{ stepId: 'a', account: claude, grants: {}, extra: 1 }] }).success).toBe(false);
    expect(acceptedWorkerIdentitySchema.safeParse({ ...runLevel, steps: [{ stepId: 'a', account: claude }] }).success).toBe(false);
    expect(acceptedWorkerIdentitySchema.safeParse({ ...runLevel, steps: [] }).success).toBe(false);
  });
});

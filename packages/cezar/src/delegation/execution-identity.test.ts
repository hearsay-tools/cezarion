import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  acceptedWorkerIdentitySchema, boundWorkerAccountEnv, captureWorkerAccount, workerAccountBindingSchema,
  workerExecutionIdentitySchema, workerStepIdentity, WorkerIdentityError,
  type AcceptedWorkerIdentity,
} from './execution-identity.ts';
import type { ResolvedAgentProfile } from '../workspace/agent-profiles.ts';

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

describe('pi and omp worker accounts (hearsay-tools/cezarion#1283)', () => {
  let root: string;
  beforeEach(() => { root = realpathSync(mkdtempSync(join(tmpdir(), 'cez-worker-account-'))); });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  const profile = (provider: 'pi' | 'omp', id: string, path: string): ResolvedAgentProfile =>
    ({ id, provider, label: id, configDir: path, path, isDefault: id === 'default' });

  it('pins a pi account to its folder and spawns it there', () => {
    const dir = join(root, 'pi-work'); mkdirSync(dir);
    const binding = captureWorkerAccount(profile('pi', 'work', dir))!;
    expect(binding).toEqual({ provider: 'pi', profileId: 'work', homePath: dir });
    expect(boundWorkerAccountEnv(binding)).toEqual({ PI_CODING_AGENT_DIR: dir });
  });

  it('keeps a symlinked omp profile\'s NAME — its realpath would select no profile at all', () => {
    // omp selects `<root>/profiles/<name>` by name and follows the entry itself; pinning the
    // entry's target would emit nothing and run the worker on the DEFAULT omp login.
    const target = join(root, 'elsewhere'); mkdirSync(target);
    const profiles = join(root, 'home', '.omp', 'profiles'); mkdirSync(profiles, { recursive: true });
    symlinkSync(target, join(profiles, 'work'));
    const binding = captureWorkerAccount(profile('omp', 'work', join(profiles, 'work')))!;
    expect(binding).toEqual({ provider: 'omp', profileId: 'work', homePath: join(profiles, 'work') });
    expect(boundWorkerAccountEnv(binding)).toEqual({ OMP_PROFILE: 'work' });
  });

  it('spawns the discovered omp account bare, like every default', () => {
    const agent = join(root, 'home', '.omp', 'agent'); mkdirSync(agent, { recursive: true });
    const binding = captureWorkerAccount(profile('omp', 'default', agent))!;
    expect(binding.homePath).toBe(agent);
    expect(boundWorkerAccountEnv(binding)).toEqual({});
  });

  it('refuses a named omp binding that names no profile rather than running it on the default', () => {
    const dir = join(root, 'omp-work'); mkdirSync(dir);
    expect(() => boundWorkerAccountEnv({ provider: 'omp', profileId: 'work', homePath: dir })).toThrow(WorkerIdentityError);
  });

  it('still loads pi and omp evidence accepted before they could carry accounts, and spawns it bare', () => {
    for (const provider of ['pi', 'omp'] as const) {
      const legacy = workerAccountBindingSchema.parse({ provider, profileId: 'default' });
      expect(boundWorkerAccountEnv(legacy)).toEqual({});
    }
    // A NAMED account always pins its home, and Claude and Codex never had a home-less form.
    expect(workerAccountBindingSchema.safeParse({ provider: 'pi', profileId: 'work' }).success).toBe(false);
    expect(workerAccountBindingSchema.safeParse({ provider: 'codex', profileId: 'default' }).success).toBe(false);
  });
});

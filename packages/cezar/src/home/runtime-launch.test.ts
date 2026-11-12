import { testHome } from './test-home.testkit.ts';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { runtimeHomes } from './runtime-isolation.testkit.ts';
import { RunStore } from '../runs/store.ts';
import { RunManager } from '../workflows/run.ts';
import { acquireInertCiResources } from '../ci-wait/inert-ci-resources.testkit.ts';
import { QUICK_TASK_WORKFLOW } from '../workflows/types.ts';
import { createActiveRun } from '../workflows/active-run.ts';
import { atTaskHead, atStepOpen, atContinue, narrowReviewConfig, narrowTitleConfig } from '../workflows/run/launch-read-resolver.ts';
import { selectDelegationExecutionSettings } from '../delegation/execution-settings.ts';
import { WorkspaceSemaphore } from '../workspace/semaphore.ts';
import { AGENT_MODELS_LOCKED_ERROR } from '../core/agent-model-policy.ts';
import { workerIdentity } from '../delegation/execution-identity.ts';
import { createRunner } from '../core/runner-factory.ts';

it('keeps accepted run pins on the selected model policy through RunManager', () => {
  const { root, selected } = runtimeHomes();
  const store = RunStore.open(join(root, 'runs'));
  const manager = new RunManager(store, root, { acquireCiResources: acquireInertCiResources, createRunner, home: selected, semaphore: new WorkspaceSemaphore({ home: testHome(), initial: { maxParallel: 0 } }) });
  try {
    const run = manager.startRun(QUICK_TASK_WORKFLOW, { task: 'Test isolation', model: 'sonnet', effort: 'high' });
    expect(run.model).toBeUndefined();
    expect(run.effort).toBeUndefined();
  } finally { manager.dispose(); store.close(); }
});

it('keeps launch config, fresh-step and Continue decisions on the selected Home', async () => {
  const { root, selected } = runtimeHomes();
  const store = RunStore.open(join(root, 'runs'));
  try {
    const run = store.createRun({ title: 'Home', task: 'Home', workflow: 'quick-task', effort: 'high', steps: [] });
    const state = createActiveRun({ cwd: root, pendingHumanAsk: false, autonomous: false });
    const step = { id: 'first', effort: 'high' };
    expect(atTaskHead.defaultRunner(await atTaskHead.config(root, selected))).toBe('codex');
    expect(await atStepOpen.model(store, root, run.id, state, step, { task: 'Home' }, 'claude', undefined, selected)).toBe(AGENT_MODELS_LOCKED_ERROR);
    expect(atContinue.effort(root, run, step, undefined, selected)).toBe(AGENT_MODELS_LOCKED_ERROR);
    expect(atContinue.effort(root, run, step, undefined, testHome())).toEqual({ effort: 'high' });
    // These type-only views keep the complete config object and its machine defaults.
    expect(await narrowTitleConfig(root, selected)).toMatchObject({ defaultRunner: 'codex' });
    expect(await narrowReviewConfig(root, selected)).toMatchObject({ defaultRunner: 'codex' });
  } finally { store.close(); }
});

it('resolves the fresh step account from the run context Home', async () => {
  const { root, selected } = runtimeHomes();
  const store = RunStore.open(join(root, 'runs'));
  try {
    const run = store.createRun({ title: 'Home', task: 'Home', workflow: 'quick-task', steps: [] });
    const selectedEnv = await atStepOpen.agentEnvForStep({ store, repoRoot: root, dataDir: root, home: selected }, {
      workerStep: () => undefined, agentEnv: () => ({}),
    } as Parameters<typeof atStepOpen.agentEnvForStep>[1], run.id, 'claude');
    expect(selectedEnv.env.CLAUDE_CONFIG_DIR).toBe(join(root, 'selected-account'));
  } finally { store.close(); }
});

it('uses selected model policy when accepting delegation execution settings', async () => {
  const { root, selected } = runtimeHomes();
  const parent = { cwd: root, runner: 'claude' as const, agentProfile: 'default', model: 'sonnet',
    accountBinding: { provider: 'claude' as const, profileId: 'default' } };
  await expect(selectDelegationExecutionSettings(root, parent, {}, undefined, selected)).rejects.toThrow(AGENT_MODELS_LOCKED_ERROR);
});

it('uses selected accounts when delegation selects a new account', async () => {
  const { root, selected } = runtimeHomes();
  const parent = { cwd: root, runner: 'claude' as const, agentProfile: 'default', accountBinding: { provider: 'claude' as const, profileId: 'default' } };
  const result = await selectDelegationExecutionSettings(root, parent, { agentProfile: 'work' }, undefined, selected);
  expect(result.accountBinding).toMatchObject({ profileId: 'work', homePath: join(root, 'selected-account') });
});

it.each(['run', 'step'] as const)('validates accepted worker %s pins against the selected model policy', scope => {
  const { root, selected } = runtimeHomes();
  const account = { provider: 'claude', profileId: 'work', homePath: join(root, 'selected-account'), claudeLayout: { kind: 'relocated' } };
  const pin = scope === 'run' ? { model: 'sonnet' } : {};
  const identity = { kind: 'accepted', account, grants: {}, ...pin,
    ...(scope === 'step' ? { steps: [{ stepId: 'first', account, grants: {}, model: 'sonnet' }] } : {}) };
  const store = { getRun: () => ({ delegation: { role: 'worker' }, runner: 'claude', agentProfile: 'work', ...pin }),
    readWorkerIdentity: () => identity } as unknown as RunStore;
  expect(() => workerIdentity(store, root, 'worker', 'first', selected)).toThrow(AGENT_MODELS_LOCKED_ERROR);
  expect(workerIdentity(store, root, 'worker', 'first', testHome())).toBe(identity);
});

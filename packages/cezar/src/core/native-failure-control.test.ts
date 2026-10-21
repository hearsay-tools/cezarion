import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFailureControl } from '../../scripts/mock-failure-control.mjs';
import { RUNNER_IDS, type RunnerId } from './agent-runner.ts';
import { driveSeam, HARNESS_ADAPTERS, waitFor } from './harness-parity.testkit.ts';

// These tests exercise the native mocks as test infrastructure: ignoring a configured
// control would make wait recovery tests silently run the success scenario.
const roots: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture(config: unknown) {
  const root = mkdtempSync(join(tmpdir(), 'cez-native-failure-')); roots.push(root);
  const path = join(root, 'failure.json');
  writeFileSync(path, JSON.stringify(config));
  return {
    path,
    held: () => existsSync(`${path}.held`),
    release: () => writeFileSync(`${path}.released`, ''),
    lift: () => writeFileSync(`${path}.lifted`, ''),
  };
}
function run(runner: RunnerId, path: string, prompt: string) {
  // driveSeam supplies a fresh cwd and native subprocess on every call. The
  // absolute control path must retain state independently of either lifetime.
  return driveSeam(runner, 'baseline', { spec: { userPrompt: prompt,
    env: { CEZ_MOCK_FAILURE_CONTROL: path, CEZ_HANDOFF_FILE: '', CEZ_TODOS_FILE: '', CEZ_MOCK_ARGS_FILE: '' } } });
}
function expectFailure(observation: Awaited<ReturnType<typeof run>>) {
  expect(observation.v1.filter(event => event.type === 'error')).not.toHaveLength(0);
}
function expectSuccess(observation: Awaited<ReturnType<typeof run>>) {
  expect(observation.v1.filter(event => event.type === 'error')).toEqual([]);
  expect(observation.v1.some(event => event.type === 'turn-end')).toBe(true);
}

describe.each(RUNNER_IDS)('%s native failure control', runner => {
  it('holds the native failure until release and consumes it once across subprocesses', async () => {
    const control = fixture({ mode: 'gated-once' });
    expectSuccess(await run(runner, control.path, 'inspect the working tree'));
    expect(control.held()).toBe(false);
    const observation = await driveSeam(runner, 'provider-error', {
      spec: { env: { CEZ_MOCK_FAILURE_CONTROL: control.path, CEZ_HANDOFF_FILE: '', CEZ_TODOS_FILE: '', CEZ_MOCK_ARGS_FILE: '' } },
      whileOpen: async (_session, { v1 }) => {
        try {
          await waitFor(control.held);
          expect(v1.filter(event => event.type === 'error')).toEqual([]);
        } finally { control.release(); }
        await waitFor(() => v1.some(event => event.type === 'error'));
      },
    });
    expectFailure(observation);
    expectSuccess(await run(runner, control.path, HARNESS_ADAPTERS[runner].scenarios['provider-error']!));
    expectSuccess(await run(runner, control.path, 'Resume to receive the queued CI observation.'));
  });

  it('keeps matching failures across subprocesses until lift, without affecting another fixture', async () => {
    const config = { mode: 'persistent', opening: 'deliver fixture result', failure: 'provider' };
    const control = fixture(config), other = fixture(config);
    expectSuccess(await run(runner, control.path, 'inspect the working tree'));
    expectFailure(await run(runner, control.path, 'deliver fixture result'));
    expectFailure(await run(runner, control.path, 'deliver fixture result'));
    control.lift();
    expectSuccess(await run(runner, control.path, 'deliver fixture result'));
    expectFailure(await run(runner, other.path, 'deliver fixture result'));
  });

  it('fails clearly when a configured control file is missing', async () => {
    const control = fixture({ mode: 'persistent', opening: 'deliver fixture result', failure: 'provider' });
    rmSync(control.path);
    const observation = await run(runner, control.path, 'inspect the working tree');
    expectFailure(observation);
    expect(JSON.stringify(observation)).toContain('CEZ_MOCK_FAILURE_CONTROL');
  });

  if (runner !== 'claude') it('rejects a Claude-only failure mode instead of silently succeeding', async () => {
    const control = fixture({ mode: 'persistent', opening: 'deliver usage result', failure: 'usage-limit' });
    const observation = await run(runner, control.path, 'deliver usage result');
    expectFailure(observation);
    expect(JSON.stringify(observation)).toContain('CEZ_MOCK_FAILURE_CONTROL');
  });
});

it('keeps a Pi echo scenario from holding or consuming a later provider failure', async () => {
  const control = fixture({ mode: 'gated-once' });
  const echo = await driveSeam('pi', 'baseline', {
    spec: { userPrompt: 'mock:agent-echo mock:provider-error',
      env: { CEZ_MOCK_FAILURE_CONTROL: control.path, CEZ_HANDOFF_FILE: '', CEZ_TODOS_FILE: '', CEZ_MOCK_ARGS_FILE: '' } },
    whileOpen: async (_session, { v1 }) => {
      try {
        await waitFor(() => control.held() || v1.some(event => event.type === 'turn-end'));
        expect(control.held(), 'the echo scenario must finish before the failure gate is considered').toBe(false);
      } finally {
        // Release a broken implementation so its native subprocess can close.
        if (control.held()) control.release();
      }
    },
  });
  expectSuccess(echo);
  const failure = await driveSeam('pi', 'provider-error', {
    spec: { env: { CEZ_MOCK_FAILURE_CONTROL: control.path, CEZ_HANDOFF_FILE: '', CEZ_TODOS_FILE: '', CEZ_MOCK_ARGS_FILE: '' } },
    whileOpen: async (_session, { v1 }) => {
      try {
        await waitFor(control.held);
        expect(v1.filter(event => event.type === 'error')).toEqual([]);
      } finally { control.release(); }
      await waitFor(() => v1.some(event => event.type === 'error'));
    },
  });
  expectFailure(failure);
});

it('lets only one matching run claim a released fixture-wide failure', async () => {
  const control = fixture({ mode: 'gated-once' });
  vi.stubEnv('CEZ_MOCK_FAILURE_CONTROL', control.path);
  const first = readFailureControl().failureFor('mock:provider-error');
  const second = readFailureControl().failureFor('Resume to receive the queued CI observation.');
  expect(control.held()).toBe(true);
  control.release();
  expect((await Promise.all([first, second])).filter(Boolean)).toEqual(['provider']);
});

describe('Claude native failure modes', () => {
  it('keeps the usage-limit envelope until lifted', async () => {
    const control = fixture({ mode: 'persistent', opening: 'deliver usage result', failure: 'usage-limit' });
    const observation = await run('claude', control.path, 'deliver usage result');
    expectFailure(observation);
    expect(JSON.stringify(observation)).toContain('Claude AI usage limit reached');
    control.lift();
    expectSuccess(await run('claude', control.path, 'deliver usage result'));
  });

  it('exits without a provider result in unread mode', async () => {
    const control = fixture({ mode: 'persistent', opening: 'deliver unread result', failure: 'unread' });
    const observation = await run('claude', control.path, 'deliver unread result');
    expectFailure(observation);
    expect(JSON.stringify(observation)).toContain('code 1');
    // The retained U14m cells also assert durable delivery and recovery for this exit.
  });
});

it.each([
  '{', null,
  { mode: 'persistent', opening: '', failure: 'provider' },
  { mode: 'persistent', opening: 'deliver', failure: 'typo' },
  { mode: 'typo' },
])('rejects an invalid configured control: %j', async config => {
  const control = fixture(config);
  if (typeof config === 'string') writeFileSync(control.path, config);
  const observation = await run('claude', control.path, 'inspect the working tree');
  expectFailure(observation);
  expect(JSON.stringify(observation)).toContain('CEZ_MOCK_FAILURE_CONTROL');
});

it.each(['', 'relative.json'])('rejects a non-absolute control path: %j', async path => {
  const observation = await run('claude', path, 'inspect the working tree');
  expectFailure(observation);
  expect(JSON.stringify(observation)).toContain('CEZ_MOCK_FAILURE_CONTROL');
});

import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFailureControl } from '../../scripts/mock-failure-control.mjs';
import { createDeliveryControl } from '../../scripts/mock-delivery-control.mjs';
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

describe.each(['opencode', 'codex', 'omp', 'pi'] as const)('%s native failure steering', runner => {
  it.each([true, false])('preserves native steering and provider failure (failing: %s)', async failing => {
    const opening = 'deliver fixture result';
    const control = fixture({ mode: 'persistent', opening, failure: 'provider' });
    if (!failing) control.lift();
    const delivery = createDeliveryControl(join(control.path, '..'), { kind: 'hold-response', match: opening });
    const wire = join(control.path, '..', 'wire.ndjson');
    const consumed: string[] = [];
    const observation = await driveSeam(runner, 'baseline', {
      spec: { userPrompt: opening, env: { CEZ_MOCK_FAILURE_CONTROL: control.path,
        CEZ_MOCK_DELIVERY_CONTROL: delivery.path, CEZ_MOCK_WIRE_FILE: wire,
        CEZ_HANDOFF_FILE: '', CEZ_TODOS_FILE: '', CEZ_MOCK_ARGS_FILE: '' } },
      sessionOptions: { onAgentInputConsumed: ids => consumed.push(...ids) },
      whileOpen: async (session, { v1 }) => {
        try {
          await waitFor(delivery.held);
          let acknowledgement: false | Promise<void> = false;
          await waitFor(() => {
            acknowledgement = session.sendAgentMessage([{ type: 'text', text: 'queued worker progress' }], ['unread-progress']);
            return acknowledgement !== false;
          });
          if (acknowledgement) await acknowledgement;
        } finally { delivery.release(); }
        await waitFor(() => v1.some(event => event.type === 'turn-end') && (!failing || v1.some(event => event.type === 'error')));
      },
    });
    if (failing) {
      expectFailure(observation);
      // Pi and OMP drain steering into another model call even after a provider error.
      expect(consumed).toEqual(runner === 'pi' || runner === 'omp' ? ['unread-progress'] : []);
      expect(observation.v1.filter(event => event.type === 'text').map(event => event.text).join('')).not.toContain('queued worker progress');
      if (runner === 'pi' || runner === 'omp') expectFailedDrain(wire, runner);
    } else {
      expectSuccess(observation);
      expect(consumed).toEqual(['unread-progress']);
    }
  });
});

/** Native error follows the drained user message; OMP also owes every admitted prompt a result. */
function expectFailedDrain(path: string, runner: 'pi' | 'omp') {
  const records = readFileSync(path, 'utf8').trim().split('\n').map(line => {
    return JSON.parse(line) as { channel: string; data: string };
  });
  const frames = records.filter(row => row.channel === 'stdout').map(row => {
    return JSON.parse(row.data) as {
      type: string; id?: string; status?: string;
      message?: { role?: string; content?: { text?: string }[]; stopReason?: string };
    };
  });
  const drained = frames.findIndex(frame => frame.type === 'message_end' && frame.message?.role === 'user' && frame.message.content?.some(part => part.text === 'queued worker progress'));
  expect(drained).toBeGreaterThan(-1);
  expect(frames.slice(drained + 1).some(frame => frame.type === 'message_end' && frame.message?.stopReason === 'error')).toBe(true);
  if (runner === 'omp') {
    const results = frames.filter(frame => frame.type === 'prompt_result');
    expect(results.map(frame => frame.status)).toEqual(['error', 'error']);
    expect(new Set(results.map(frame => frame.id)).size).toBe(2);
  }
}

describe.each(RUNNER_IDS)('%s native failure control', runner => {
  it('holds the native failure until release and consumes it once across subprocesses', async () => {
    const control = fixture({ mode: 'gated-once' });
    expectSuccess(await run(runner, control.path, 'inspect the working tree'));
    expect(control.held()).toBe(false);
    const observation = await driveSeam(runner, 'provider-error-controlled', {
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
    expectSuccess(await run(runner, control.path, HARNESS_ADAPTERS[runner].scenarios['provider-error-controlled']!));
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

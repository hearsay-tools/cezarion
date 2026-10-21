import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentSession } from '../core/agent-runner.ts';
import { RUNNER_IDS } from '../core/agent-runner.ts';
import { HARNESS_ADAPTERS } from '../core/harness-parity.testkit.ts';
import { GithubCiClient } from '../ci-wait/github.ts';
import { CiWatcherSupervisor } from '../ci-wait/supervisor.ts';
import { readPersistedRuns } from '../runs/run-store.testkit.ts';
import { manager, store, restart, root, until, useWorkerWaitFixture } from './worker-wait.testkit.ts';
import { ciNativeMessages } from './waits-parity.testkit.ts';
import { QUICK_TASK_WORKFLOW } from './types.ts';
import { ciWatchRequest } from './waits.ts';

const resources = vi.hoisted(() => ({ github: undefined as GithubCiClient | undefined, toolless: false }));
vi.mock('../ci-wait/resources.ts', async importOriginal => {
  const original = await importOriginal<typeof import('../ci-wait/resources.ts')>();
  return { acquireCiResources(workspace: object) {
    const shared = original.acquireCiResources(workspace);
    if (!resources.github) return shared;
    const supervisor = new CiWatcherSupervisor({ github: resources.github });
    return { ...shared, supervisor, ...(resources.toolless ? { controller: async () => undefined } : {}), release() { supervisor.close(); shared.release(); } };
  } };
});
const pr = 'https://github.com/acme/repo/pull/12';
const open = (id: string) => store.getRun(id)?.waits?.find(wait => wait.kind === 'ci');
const last = (id: string) => store.getRun(id)?.lastWaits?.find(wait => wait.kind === 'ci');
const active = (id: string) => (manager as unknown as { active: Map<string, { session: AgentSession; ciGeneration: string }> }).active.get(id);
const disk = (id: string) => readPersistedRuns(join(root, '.ai/cezar')).find(row => row.id === id);

// R81–R83 deliberately use the real metadata parser/supervisor. A synthetic
// `conflicting` result would test storage but pass with the missing detector.
describe('native conflict observation durability and wake parity', { timeout: 35_000 }, () => {
  useWorkerWaitFixture();
  afterEach(() => { resources.github = undefined; resources.toolless = false; vi.restoreAllMocks(); });
  for (const runner of RUNNER_IDS) for (const mode of ['fresh', 'continued', 'recovered'] as const) {
    const cell = mode === 'fresh' ? 'R81' : mode === 'continued' ? 'R82' : 'R83';
    it(`${runner} ${cell} delivers one committed conflict observation in ${mode} mode`, async () => {
      process.env.CEZ_DRY_RUN = '0';
      process.env[HARNESS_ADAPTERS[runner].binEnv] = HARNESS_ADAPTERS[runner].mockBin;
      process.env.CEZ_MOCK_ARGS_FILE = join(root, 'args');
      process.env.CEZ_MOCK_STDIN_FILE = join(root, 'stdin');
      const gate = join(root, 'release-checks'), log = join(root, 'gh-queries.ndjson');
      resources.github = new GithubCiClient({ command: { file: process.execPath,
        args: [fileURLToPath(new URL('./ci-conflict-gh.testkit.mjs', import.meta.url)), gate, log] } });
      const supervisor = new CiWatcherSupervisor({ github: resources.github });
      Object.assign(manager, { ciSupervisor: supervisor });
      const run = manager.startRun(QUICK_TASK_WORKFLOW, { runner, task: HARNESS_ADAPTERS[runner].scenarios.baseline! });
      await until(() => store.getRun(run.id)?.status === 'waiting');
      if (mode === 'continued') {
        active(run.id)!.session.end();
        await until(() => !manager.isActive(run.id));
        expect(manager.continueRun(run.id, { text: HARNESS_ADAPTERS[runner].scenarios.baseline! }).ok).toBe(true);
        await until(() => store.getRun(run.id)?.status === 'waiting' && !!active(run.id)?.session.open);
      }
      const wait = await manager.registerWait(run.id, { kind: 'ci', pr, timeout_seconds: 120 }, 'cezar_wait', active(run.id)!.ciGeneration);
      if (mode === 'recovered') {
        resources.toolless = true; // Missing tool controller must not prevent saved-input delivery.
        await restart();
        expect(manager.isActive(run.id)).toBe(false);
        expect(open(run.id)?.id).toBe(wait.id);
      }
      // Read the committed row at precisely the boundary before queueing a wake.
      // Hold admission so a crash/restart can also exercise an owed saved input.
      const engine = manager as unknown as { queueWaitWake(id: string): void; resolveWait(id: string, waitId: string, result: unknown): void };
      let committed: ReturnType<typeof disk>;
      const wake = vi.spyOn(engine, 'queueWaitWake').mockImplementation(id => {
        if (id === run.id && open(id)?.phase === 'resolved') committed = disk(id);
      });
      const commit = store.commitWait.bind(store);
      let rejected = false;
      let failedCheckpoint: ReturnType<typeof disk>;
      const checkpoint = vi.spyOn(store, 'commitWait').mockImplementation((id, entry, input) => {
        if (id === run.id && entry.id === wait.id && entry.phase === 'resolved' && !rejected) {
          rejected = true;
          failedCheckpoint = disk(id);
          throw new Error('injected checkpoint failure');
        }
        return commit(id, entry, input);
      });
      writeFileSync(gate, '');
      await until(() => open(run.id)?.phase === 'resolved');
      expect(rejected).toBe(true);
      expect(failedCheckpoint.waits.find((item: { id: string }) => item.id === wait.id).phase).toBe('open');
      expect(failedCheckpoint.agentInputs?.some((item: { id: string }) => item.id === wait.id) ?? false).toBe(false);
      checkpoint.mockRestore();
      expect(open(run.id)).toMatchObject({ result: { outcome: 'conflicting', mergeable: 'CONFLICTING', mergeStateStatus: 'DIRTY' } });
      expect(committed.waits.find((entry: { id: string }) => entry.id === wait.id)).toMatchObject({ phase: 'resolved', result: { outcome: 'conflicting' } });
      expect(committed.agentInputs.filter((input: { id: string }) => input.id === wait.id)).toHaveLength(1);
      expect(committed.agentInputs.find((input: { id: string }) => input.id === wait.id).deliveredAt).toBeUndefined();
      expect(committed.agentInputs.find((input: { id: string }) => input.id === wait.id).text).toContain('conflicting');
      expect(store.getRun(run.id)?.waits?.some(entry => entry.kind === 'timer')).toBe(false);
      expect(store.getRun(run.id)?.delegation).toBeUndefined();
      if (mode !== 'recovered') expect(manager.cancelWait(run.id, wait.id, active(run.id)!.ciGeneration)).toEqual({ cancelled: false, code: 'already_resolved' });
      const result = open(run.id)!.result;
      engine.resolveWait(run.id, wait.id, result); // Duplicate callback cannot enqueue another input.
      expect(disk(run.id).agentInputs.filter((input: { id: string }) => input.id === wait.id)).toHaveLength(1);
      wake.mockRestore();
      if (mode === 'recovered') {
        // A clean PR on reboot must not reclassify the already committed observation.
        writeFileSync(gate + '.clean', '');
        await restart();
      } else engine.queueWaitWake(run.id);
      await until(() => !!last(run.id)?.deliveredAt);
      await until(() => ciNativeMessages(runner, root).some(text => text.includes(`CI wait observation ${wait.id}`)));
      const prompts = ciNativeMessages(runner, root).filter(text => text.includes(`CI wait observation ${wait.id}`));
      expect(prompts).toHaveLength(1);
      expect(prompts[0]).toContain('conflicting');
      expect(prompts[0]).toContain('not merge approval');
      expect(last(run.id)).toMatchObject({ id: wait.id, result: { outcome: 'conflicting', mergeable: 'CONFLICTING' } });
      expect(store.getRun(run.id)?.agentInputs?.filter(input => input.id === wait.id && input.deliveredAt)).toHaveLength(1);
      expect(existsSync(log)).toBe(true);
      expect(readFileSync(log, 'utf8')).toContain('headRefOid');
      supervisor.close();
    });
  }
  for (const runner of RUNNER_IDS) {
    it(`${runner} R84 cancellation prevents a late conflict observation from waking`, async () => {
      process.env.CEZ_DRY_RUN = '0';
      process.env[HARNESS_ADAPTERS[runner].binEnv] = HARNESS_ADAPTERS[runner].mockBin;
      process.env.CEZ_MOCK_ARGS_FILE = join(root, 'args');
      process.env.CEZ_MOCK_STDIN_FILE = join(root, 'stdin');
      const gate = join(root, 'release-checks'), log = join(root, 'gh-queries.ndjson');
      const github = new GithubCiClient({ command: { file: process.execPath,
        args: [fileURLToPath(new URL('./ci-conflict-gh.testkit.mjs', import.meta.url)), gate, log] } });
      const supervisor = new CiWatcherSupervisor({ github });
      Object.assign(manager, { ciSupervisor: supervisor });
      const run = manager.startRun(QUICK_TASK_WORKFLOW, { runner, task: HARNESS_ADAPTERS[runner].scenarios.baseline! });
      await until(() => store.getRun(run.id)?.status === 'waiting');
      const generation = active(run.id)!.ciGeneration;
      const wait = await manager.registerWait(run.id, { kind: 'ci', pr, timeout_seconds: 120 }, 'cezar_wait', generation);
      if (wait.kind !== 'ci') throw new Error('Expected a CI wait');
      await until(() => existsSync(log) && readFileSync(log, 'utf8').includes('name,state,link,bucket'));
      expect(manager.cancelWait(run.id, wait.id, generation)).toEqual({ cancelled: true });
      // Cancellation has committed before the external check command can complete.
      expect(disk(run.id).lastWaits.find((entry: { id: string }) => entry.id === wait.id)).toMatchObject({ phase: 'cancelled' });
      writeFileSync(gate, '');
      const request = ciWatchRequest(wait);
      // Reap the cancelled in-flight query before obtaining a genuine late conflict.
      await supervisor.watch(request, new AbortController().signal);
      const late = await supervisor.watch(request, new AbortController().signal);
      expect(late).toMatchObject({ outcome: 'conflicting', mergeable: 'CONFLICTING' });
      const engine = manager as unknown as { resolveWait(id: string, waitId: string, result: unknown): void };
      engine.resolveWait(run.id, wait.id, late);
      expect(open(run.id)).toBeUndefined();
      expect(store.getRun(run.id)?.agentInputs?.some(input => input.id === wait.id) ?? false).toBe(false);
      expect(ciNativeMessages(runner, root).filter(text => text.includes(`CI wait observation ${wait.id}`))).toHaveLength(0);
      supervisor.close();
    });
  }

});

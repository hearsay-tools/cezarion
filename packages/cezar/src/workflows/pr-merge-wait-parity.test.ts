import { runInternals } from './run-internals.testkit.ts';
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

// Control only the supervisor's 30-second probe, keeping abort behavior and the real native
// runner processes. Releasing the held probes stands for the merge loop's next poll.
const probes = vi.hoisted(() => new Set<{ resume(): void }>());
vi.mock('node:timers/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:timers/promises')>();
  return { ...actual, setTimeout: (ms: number, value: unknown, options?: { signal?: AbortSignal }) => {
    if (ms !== 30_000) return actual.setTimeout(ms, value, options);
    return new Promise((resolve, reject) => {
      const signal = options?.signal;
      const cleanup = () => { probes.delete(probe); signal?.removeEventListener('abort', abort); };
      const probe = { resume: () => { cleanup(); resolve(value); } };
      const abort = () => { cleanup(); reject(signal?.reason); };
      if (signal?.aborted) { reject(signal.reason); return; }
      probes.add(probe); signal?.addEventListener('abort', abort, { once: true });
    });
  } };
});
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
const open = (id: string) => store.getRun(id)?.waits?.find(wait => wait.kind === 'pr');
const last = (id: string) => store.getRun(id)?.lastWaits?.find(wait => wait.kind === 'pr');
const active = (id: string) => (manager as unknown as { active: Map<string, { session: AgentSession; ciGeneration: string }> }).active.get(id);
const disk = (id: string) => readPersistedRuns(join(root, '.ai/cezar')).find(row => row.id === id);
const mergeReads = (log: string) => existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(line => line.includes('state,mergedAt')).length : 0;

// R97–R99 (hearsay-tools/cezarion#1425): a merge wait polls the real metadata parser over a native
// gh wire. Green checks do not end it; GitHub's merge does, with one committed, delivered input.
describe('native PR merge wait parity', { timeout: 35_000 }, () => {
  useWorkerWaitFixture();
  afterEach(() => { resources.github = undefined; resources.toolless = false; for (const probe of [...probes]) probe.resume(); vi.restoreAllMocks(); });
  for (const runner of RUNNER_IDS) for (const mode of ['fresh', 'continued', 'recovered'] as const) {
    const cell = mode === 'fresh' ? 'R97' : mode === 'continued' ? 'R98' : 'R99';
    it(`${runner} ${cell} delivers one committed merge observation in ${mode} mode`, async () => {
      process.env.CEZ_DRY_RUN = '0';
      process.env[HARNESS_ADAPTERS[runner].binEnv] = HARNESS_ADAPTERS[runner].mockBin;
      process.env.CEZ_MOCK_ARGS_FILE = join(root, 'args');
      process.env.CEZ_MOCK_STDIN_FILE = join(root, 'stdin');
      const gate = join(root, 'pr'), log = join(root, 'gh-queries.ndjson');
      resources.github = new GithubCiClient({ command: { file: process.execPath,
        args: [fileURLToPath(new URL('./ci-merge-gh.testkit.mjs', import.meta.url)), gate, log] } });
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
      const wait = await manager.registerWait(run.id, { kind: 'pr', pr, until: 'merge', timeout_seconds: 120 }, 'cezar_wait', active(run.id)!.ciGeneration);
      if (mode === 'recovered') {
        resources.toolless = true; // A missing tool controller must not prevent saved-input delivery.
        await restart();
        expect(manager.isActive(run.id)).toBe(false);
        expect(open(run.id)).toMatchObject({ id: wait.id, until: 'merge' });
      }
      // Green checks: the next poll still finds the PR open, so the wait stays open.
      await until(() => mergeReads(log) >= 1 && probes.size > 0);
      writeFileSync(gate + '.passed', '');
      const before = mergeReads(log);
      for (const probe of [...probes]) probe.resume();
      await until(() => mergeReads(log) > before && probes.size > 0);
      expect(open(run.id)).toMatchObject({ id: wait.id, phase: 'open' });
      // The committed row at the wake boundary already holds the result and its input.
      const engine = runInternals(manager).wakeAdmission;
      const queue = engine.queueWaitWake.bind(engine);
      let committed: ReturnType<typeof disk>;
      const wake = vi.spyOn(engine, 'queueWaitWake').mockImplementation(id => { if (id === run.id && !committed) committed = disk(id); queue(id); });
      writeFileSync(gate + '.merged', '');
      for (const probe of [...probes]) probe.resume();
      await until(() => !!last(run.id)?.deliveredAt);
      expect(wake).toHaveBeenCalled();
      expect(committed.waits.find((entry: { id: string }) => entry.id === wait.id)).toMatchObject({ phase: 'resolved', result: { outcome: 'merged' } });
      expect(committed.agentInputs.filter((input: { id: string }) => input.id === wait.id)).toHaveLength(1);
      expect(last(run.id)).toMatchObject({ id: wait.id, until: 'merge', result: { outcome: 'merged', mergedAt: '2026-10-23T09:00:00Z', mergeCommitSha: 'b'.repeat(40) } });
      runInternals(manager).waitRegistry.resolveWait(run.id, wait.id, last(run.id)!.result); // A duplicate callback cannot enqueue another input.
      await until(() => ciNativeMessages(runner, root).some(text => text.includes(`PR wait observation ${wait.id}`)));
      const prompts = ciNativeMessages(runner, root).filter(text => text.includes(`PR wait observation ${wait.id}`));
      expect(prompts).toHaveLength(1);
      expect(prompts[0]).toContain('(until merge)');
      expect(prompts[0]).toContain('"outcome":"merged"');
      expect(store.getRun(run.id)?.agentInputs?.filter(input => input.id === wait.id)).toHaveLength(1);
      // A merge wait reads the PR's state only, never its checks.
      expect(readFileSync(log, 'utf8')).not.toContain('name,state,link,bucket');
      supervisor.close();
    });
  }
});

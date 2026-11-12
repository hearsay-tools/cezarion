import { testHome } from '../home/test-home.testkit.ts';
import { WaitEngine } from './run/wait-engine.ts';
import type { CiWaitResult } from '@open-mercato/cezar-contract/ci-wait';
import { WAIT_KIND, WAIT_PHASE } from '@open-mercato/cezar-contract/test-factories.testkit';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parityRunners } from '../core/parity-classes.testkit.ts';
import { HARNESS_ADAPTERS } from '../core/harness-parity.testkit.ts';
import { GithubCiClient } from '../ci-wait/github.ts';
import { CiWatcherSupervisor } from '../ci-wait/supervisor.ts';
import { acquireCiResources } from '../ci-wait/resources.ts';
import { readPersistedRuns } from '../runs/run-store.testkit.ts';
import { manager, store, restart, root, semaphore, toolGenerationOf, until, useWorkerWaitFixture, work } from './worker-wait.testkit.ts';
import { ciNativeMessages } from './waits-parity.testkit.ts';
import { QUICK_TASK_WORKFLOW } from './types.ts';
import { noRunners } from '../core/runners-under-test.testkit.ts';

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
const resources = { github: undefined as GithubCiClient | undefined,
  supervisor: undefined as CiWatcherSupervisor | undefined, replay: async (_result?: CiWaitResult) => {} };
/** Pass to `useWorkerWaitFixture`: the real CI resources, with a supervisor the test chooses per restart. */
function acquireReplayCiResources(workspace: object) {
  const shared = acquireCiResources(workspace);
  // Each restart owns a fresh supervisor. The initial fixture chooses its wire later.
  let selected = resources.github ? new CiWatcherSupervisor({ github: resources.github }) : undefined;
  const current = () => selected ??= resources.supervisor!;
  // The manager holds this forwarding boundary before the test chooses its GitHub wire.
  const supervisor = {
    resolve: (...args: Parameters<CiWatcherSupervisor['resolve']>) => current().resolve(...args),
    watch: (...args: Parameters<CiWatcherSupervisor['watch']>) => {
      const result = current().watch(...args).then(value => value);
      const then = result.then.bind(result);
      vi.spyOn(result, 'then').mockImplementation((fulfilled, rejected) => {
        resources.replay = async override => { if (override) await fulfilled?.(override); else await then(fulfilled, rejected); };
        return then(fulfilled, rejected);
      });
      return result;
    },
    close() {},
  };
  return { ...shared, supervisor, release() { selected?.close(); shared.release(); } };
}
const pr = 'https://github.com/acme/repo/pull/12';
const open = (id: string) => store.getRun(id)?.waits?.find(wait => wait.kind === 'pr');
const last = (id: string) => store.getRun(id)?.lastWaits?.find(wait => wait.kind === 'pr');
const disk = (id: string) => readPersistedRuns(join(root, '.ai/cezar')).find(row => row.id === id);
const mergeReads = (log: string) => existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(line => line.includes('state,mergedAt')).length : 0;

// This module case reaches the registry guard itself. A settled wait must return
// before it reads a live session or queues another input; every host read is a fault.
function assertIgnoredResolution(runId: string, waitId: string, result: CiWaitResult): void {
  type Host = ConstructorParameters<typeof WaitEngine>[1];
  const host: Host = new Proxy(Object.create(null), {
    get(_target, property) { throw new Error(`Settled wait consulted ${String(property)}`); },
  });
  const registry = new WaitEngine({ createRunner: noRunners, home: testHome(), store, repoRoot: root, dataDir: join(root, '.ai/cezar'), semaphore, work, disposed: () => false }, host, 10);
  const before = structuredClone(store.getRun(runId));
  registry.resolveWait(runId, waitId, result);
  expect(store.getRun(runId)).toEqual(before);
}

// R97–R99 (hearsay-tools/cezarion#1425): a merge wait polls the real metadata parser over a native
// gh wire. Green checks do not end it; GitHub's merge does, with one committed, delivered input.
describe('native PR merge wait parity', { timeout: 35_000 }, () => {
  useWorkerWaitFixture({ acquireCiResources: acquireReplayCiResources });
  afterEach(() => { resources.github = undefined; for (const probe of [...probes]) probe.resume(); vi.restoreAllMocks(); });
  for (const mode of ['fresh', 'continued', 'recovered'] as const) for (const runner of parityRunners('pr-merge-wait', mode === 'fresh' ? 'R97' : mode === 'continued' ? 'R98' : 'R99')) {
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
      resources.supervisor = supervisor;
      const run = manager.startRun(QUICK_TASK_WORKFLOW, { runner, task: HARNESS_ADAPTERS[runner].scenarios.baseline! });
      await until(() => store.getRun(run.id)?.status === 'waiting');
      if (mode === 'continued') {
        [...work.liveSessions].find(session => session.open)!.end();
        await until(() => !manager.isActive(run.id));
        expect(manager.continueRun(run.id, { text: HARNESS_ADAPTERS[runner].scenarios.baseline! }).ok).toBe(true);
        await until(() => store.getRun(run.id)?.status === 'waiting' && manager.isActive(run.id) && [...work.liveSessions].some(session => session.open));
      }
      const wait = await manager.registerWait(run.id, { kind: WAIT_KIND.pr, pr, until: 'merge', timeout_seconds: 120 }, 'cezar_wait', toolGenerationOf(run.id));
      if (mode === 'recovered') {
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
      expect(open(run.id)).toMatchObject({ id: wait.id, phase: WAIT_PHASE.open });
      // The committed row at the wake boundary already holds the result and its input.
      const commit = store.commitWait.bind(store);
      let committed: ReturnType<typeof disk>;
      const checkpoint = vi.spyOn(store, 'commitWait').mockImplementation((id, entry, input) => {
        const result = commit(id, entry, input);
        if (id === run.id && entry.id === wait.id && entry.phase === 'resolved') {
          committed = disk(id);
          if (entry.kind === 'pr' && entry.result) assertIgnoredResolution(id, wait.id, entry.result);
        }
        return result;
      });
      writeFileSync(gate + '.merged', '');
      for (const probe of [...probes]) probe.resume();
      await until(() => committed !== undefined);
      assertIgnoredResolution(run.id, wait.id, committed.waits.find((entry: { id: string }) => entry.id === wait.id).result);
      await until(() => !!last(run.id)?.deliveredAt);
      expect(checkpoint).toHaveBeenCalled();
      expect(committed.waits.find((entry: { id: string }) => entry.id === wait.id)).toMatchObject({ phase: WAIT_PHASE.resolved, result: { outcome: 'merged' } });
      expect(committed.agentInputs.filter((input: { id: string }) => input.id === wait.id)).toHaveLength(1);
      expect(last(run.id)).toMatchObject({ id: wait.id, until: 'merge', result: { outcome: 'merged', mergedAt: '2026-10-23T09:00:00Z', mergeCommitSha: 'b'.repeat(40) } });
      await resources.replay(); // A duplicate supervisor callback cannot enqueue another input.
      assertIgnoredResolution(run.id, wait.id, committed.waits.find((entry: { id: string }) => entry.id === wait.id).result);
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

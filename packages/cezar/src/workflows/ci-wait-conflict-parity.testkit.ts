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

// R81–R83 deliberately use the real metadata parser/supervisor. A synthetic
// `conflicting` result would test storage but pass with the missing detector.
export const CONFLICT_ROWS = { fresh: 'R81', continued: 'R82', recovered: 'R83' } as const;
export const GROUPS = { fresh: parityRunners('ci-wait-conflict', 'R81'), continued: parityRunners('ci-wait-conflict', 'R82'), recovered: parityRunners('ci-wait-conflict', 'R83') };
export function registerGroup(mode: keyof typeof GROUPS) {
describe('native conflict observation durability and wake parity', { timeout: 35_000 }, () => {
  useWorkerWaitFixture({ acquireCiResources: acquireReplayCiResources });
  afterEach(() => { resources.github = undefined; vi.restoreAllMocks(); });
  for (const runner of GROUPS[mode]) {
    const cell = CONFLICT_ROWS[mode];
    it(`${runner} ${cell} delivers one committed conflict observation in ${mode} mode`, async () => {
      process.env.CEZ_DRY_RUN = '0';
      process.env[HARNESS_ADAPTERS[runner].binEnv] = HARNESS_ADAPTERS[runner].mockBin;
      process.env.CEZ_MOCK_ARGS_FILE = join(root, 'args');
      process.env.CEZ_MOCK_STDIN_FILE = join(root, 'stdin');
      const gate = join(root, 'release-checks'), log = join(root, 'gh-queries.ndjson');
      resources.github = new GithubCiClient({ command: { file: process.execPath,
        args: [fileURLToPath(new URL('./ci-conflict-gh.testkit.mjs', import.meta.url)), gate, log] } });
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
      const wait = await manager.registerWait(run.id, { kind: WAIT_KIND.pr, pr, timeout_seconds: 120 }, 'cezar_wait', toolGenerationOf(run.id));
      if (mode === 'recovered') {
        await restart();
        expect(manager.isActive(run.id)).toBe(false);
        expect(open(run.id)?.id).toBe(wait.id);
      }
      // Read the committed row at precisely the boundary before queueing a wake.
      // Save this checkpoint so recovery can replay the owed input before any delivery.
      let committed: ReturnType<typeof disk>;
      const commit = store.commitWait.bind(store);
      let rejected = false;
      let failedCheckpoint: ReturnType<typeof disk>;
      const checkpoint = vi.spyOn(store, 'commitWait').mockImplementation((id, entry, input) => {
        if (id === run.id && entry.id === wait.id && entry.phase === 'resolved' && !rejected) {
          rejected = true;
          failedCheckpoint = disk(id);
          throw new Error('injected checkpoint failure');
        }
        const result = commit(id, entry, input);
        if (id === run.id && entry.id === wait.id && entry.phase === 'resolved') {
          committed = disk(id);
          if (entry.kind === 'pr' && entry.result) assertIgnoredResolution(id, wait.id, entry.result);
          if (mode !== 'recovered') expect(manager.cancelWait(id, wait.id, toolGenerationOf(id))).toEqual({ cancelled: false, code: 'already_resolved' });
        }
        return result;
      });
      writeFileSync(gate, '');
      await until(() => committed !== undefined);
      expect(rejected).toBe(true);
      expect(failedCheckpoint.waits.find((item: { id: string }) => item.id === wait.id).phase).toBe('open');
      expect(failedCheckpoint.agentInputs?.some((item: { id: string }) => item.id === wait.id) ?? false).toBe(false);
      checkpoint.mockRestore();
      expect(committed.waits.find((entry: { id: string }) => entry.id === wait.id)).toMatchObject({ result: { outcome: 'conflicting', mergeable: 'CONFLICTING', mergeStateStatus: 'DIRTY' } });
      expect(committed.waits.find((entry: { id: string }) => entry.id === wait.id)).toMatchObject({ phase: WAIT_PHASE.resolved, result: { outcome: 'conflicting' } });
      expect(committed.agentInputs.filter((input: { id: string }) => input.id === wait.id)).toHaveLength(1);
      expect(committed.agentInputs.find((input: { id: string }) => input.id === wait.id).deliveredAt).toBeUndefined();
      expect(committed.agentInputs.find((input: { id: string }) => input.id === wait.id).text).toContain('conflicting');
      expect(store.getRun(run.id)?.waits?.some(entry => entry.kind === 'timer') ?? false).toBe(false);
      expect(store.getRun(run.id)?.delegation).toBeUndefined();
      await resources.replay(); // Duplicate supervisor callback cannot enqueue another input.
      assertIgnoredResolution(run.id, wait.id, committed.waits.find((entry: { id: string }) => entry.id === wait.id).result);
      expect(disk(run.id).agentInputs.filter((input: { id: string }) => input.id === wait.id)).toHaveLength(1);
      if (mode === 'recovered') {
        // A clean PR on reboot must not reclassify the already committed observation.
        writeFileSync(gate + '.clean', '');
        await restart(false, [committed]);
      }
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

});
}

import childProcess, { type ChildProcess, type SpawnOptions } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import * as worktrees from '../git-worktree.ts';
import { RUNNER_IDS } from './agent-runner.ts';
import { withOwnedInputRun, waitFor } from './harness-parity.testkit.ts';

// The hang guard for a fixture step that runs a native mock turn or a real save, sized like
// driveRun's 30 s settle bound in harness-parity.test.ts. Pinned to one CPU beside eight busy
// loops, the first park took up to 7.7 s and R25's first Finish up to 8.2 s, and one Finish
// went past the 10 s waitFor default (hearsay-tools/cezarion#1322).
const FIXTURE_STEP_MS = 30_000;

// Real native frames on every HARNESS_ADAPTERS runner. Registered as R24/R25
// in the parity guard; no wire exemption exists for filesystem cleanup.
describe('harness parity — autosave cleanup (#495)', () => {
  for (const backend of RUNNER_IDS) {
    for (const continuation of [false, true]) {
      it(`${backend} ${continuation ? 'R25 continuation' : 'R24 initial'} retains reuse guard until Git termination`, async () => {
        vi.stubEnv('CEZ_DELEGATION', '1');
        const save = worktrees.autosaveCommit;
        const saves: Promise<unknown>[] = [];
        // The stubbed 700 ms budget is for the intercepted Git below, not for the real
        // saves before it. On a loaded host, R25's first Finish runs a real final save
        // that can outlive 500 ms. The kill that follows has 200 ms to prove termination,
        // and an unproven one keeps the cleanup blocker by design
        // (hearsay-tools/cezarion#934). The run settles and `isActive` turns false, but
        // Continue is refused with "termination not confirmed" until Git is gone
        // (hearsay-tools/cezarion#1095). So the earlier saves run with the product
        // budget, and only the intercepted phase gets the shorter one.
        let budget: { timeoutMs: number; killGraceMs: number; confirmMs: number } | undefined;
        vi.spyOn(worktrees, 'autosaveCommit').mockImplementation((dir, reason, options) => {
          const task = save(dir, reason, { ...options, ...budget });
          saves.push(task);
          return task;
        });
        vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        try {
          await withOwnedInputRun(backend, 'baseline', async ({ store, manager, runId }) => {
            manager.enqueueOwnedRun(runId);
            // bound: FIXTURE_STEP_MS, for the native mock's first turn; the predicate is the run parking.
            await waitFor(() => store.getRun(runId)?.status === 'waiting', FIXTURE_STEP_MS);
            if (continuation) {
              manager.finish(runId);
              // bound: FIXTURE_STEP_MS, for the first Finish and its real final save under the product budget.
              await waitFor(() => !manager.isActive(runId), FIXTURE_STEP_MS);
              expect(manager.continueRun(runId, { text: 'mock:baseline' }).ok).toBe(true);
              // bound: FIXTURE_STEP_MS, for the continuation's turn; the predicate is the run parking again.
              await waitFor(() => manager.isActive(runId) && store.getRun(runId)?.status === 'waiting', FIXTURE_STEP_MS);
            }
            const dir = store.getRun(runId)!.worktreePath!;
            writeFileSync(join(dir, 'progress.txt'), 'recover me\n');
            // The intercepted Git is the next save's `status --porcelain`. Its spawn starts a
            // process that never exits, with autosave's own options (cwd, process group,
            // environment), and every other Git call runs real Git. Before
            // hearsay-tools/cezarion#1322 a Node shim on PATH stood in for every Git call and
            // booted Node for each one. R25's save waited behind more than ten of them, and
            // the stubbed 500 ms budget could kill the intercepted shim before it wrote its
            // pid, so the wait for that pid could never pass.
            const spawn = childProcess.spawn;
            let git: ChildProcess | undefined;
            let obscure = true;
            const kill = process.kill.bind(process);
            const probe = vi.spyOn(process, 'kill').mockImplementation((pid, signal) => {
              // While obscure, keep the intercepted Git in an unproven state:
              // EPERM on the group probe, and no TERM/KILL delivery. SIGKILL can
              // otherwise leave a /proc zombie that autosave treats as proof of
              // death, skipping the blocked-cleanup note (hearsay-tools/cezarion#950).
              // Its pid is known from the spawn, so no signal reaches it during startup.
              if (obscure && git?.pid !== undefined && pid === -git.pid) {
                if (signal === 0) throw Object.assign(new Error('unreadable'), { code: 'EPERM' });
                return true;
              }
              return kill(pid, signal);
            });
            const intercept = vi.spyOn(childProcess, 'spawn').mockImplementation(((...args: unknown[]) => {
              const [command, argv, options] = args;
              if (git || command !== 'git' || !Array.isArray(argv) || !argv.includes('status') || !argv.includes('--porcelain')) {
                return Reflect.apply(spawn, childProcess, args);
              }
              git = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], options as SpawnOptions);
              return git;
            }) as typeof spawn);
            // autosave-git.ts imports `spawn` by name; this republishes the spy to it.
            syncBuiltinESMExports();
            budget = { timeoutMs: 500, killGraceMs: 100, confirmMs: 100 };
            try {
              expect(manager.finish(runId)).toBe(true);
              // bound: hang guard from Finish to the intercepted spawn: the session end, the
              // turn-end diff stat and the save's start, all with real Git (hearsay-tools/cezarion#950).
              // Pinned beside eight busy loops it took under 1 s.
              await waitFor(() => git !== undefined);
              // bound: hang guard; the stubbed budget reports the blocked cleanup 700 ms after the spawn.
              await waitFor(() => store.readEvents(runId).some(event => event.type === 'note' && String(event.message).includes('termination not confirmed')));
              // bound: hang guard for the run settling while the blocked save keeps its cleanup hold.
              await waitFor(() => !manager.isActive(runId));
              expect(store.readWorkerExecution(runId)?.phase).toBe('complete');
              expect(manager.claimForPublish(runId)).toBeNull();
              expect(manager.claimWorktreeReclaim(runId)).toBeNull();
              expect(manager.continueRun(runId, { text: 'another writer' }).ok).toBe(false);
              expect(readFileSync(join(dir, 'progress.txt'), 'utf8')).toBe('recover me\n');
            } finally {
              obscure = false;
              intercept.mockRestore();
              syncBuiltinESMExports();
              // Also reaps the old unbounded implementation during mutation tests.
              git?.kill('SIGKILL');
              probe.mockRestore();
              // Each save settles on autosave's own proof that its Git process group is gone.
              await Promise.allSettled(saves);
              // bound: hang guard; the run already settled above unless an earlier step failed.
              await waitFor(() => !manager.isActive(runId));
            }
            expect(store.readWorkerExecution(runId)?.phase).toBe('complete');
            expect(store.readEvents(runId).some(event => event.type === 'note' && String(event.message).includes('autosave failed'))).toBe(true);
            expect(readFileSync(join(dir, 'progress.txt'), 'utf8')).toBe('recover me\n');
          });
        } finally { vi.restoreAllMocks(); vi.unstubAllEnvs(); }
      }, 60_000);
    }
  }
});

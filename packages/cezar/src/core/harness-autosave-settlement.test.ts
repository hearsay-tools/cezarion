import { runInternals } from '../workflows/run-internals.testkit.ts';
import childProcess, { execFileSync, spawn, type ChildProcess, type ExecFileOptions, type SpawnOptions } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { setTimeout as realSetTimeout } from 'node:timers';
import { describe, expect, it, vi } from 'vitest';
import * as worktrees from '../git-worktree.ts';
import { RunStore } from '../runs/store.ts';
import { RunManager } from '../workflows/run.ts';
import { RUNNER_IDS, type RunnerId } from './agent-runner.ts';
import { HARNESS_ADAPTERS, withOwnedInputRun, withoutTaskScenario, waitFor } from './harness-parity.testkit.ts';
import { readPid, requirePid } from '../pid-file.testkit.ts';

// bound: native mock turns and real saves use the same 30 s per-step guard as R24/R25
// (hearsay-tools/cezarion#1322); their measured pinned-load startup exceeded 10 s.
const FIXTURE_STEP_MS = 30_000;

// hearsay-tools/cezarion#934: native provider failures and Stop must settle
// independently of the retained worktree-writer proof. Registered as R61–R66.
// hearsay-tools/cezarion#958: the retained holder is Git's detached descendant;
// an unrelated process churning in the worktree is neither named nor signalled.

/** A Continue cell reopens its settled session. The cancelled cell's pending question is the worker's
 *  own, so its parent's answer reopens it (hearsay-tools/cezarion#2410); the others continue it. */
async function reopenSettled(fixture: { store: RunStore; manager: RunManager; runId: string; answer: (text: string) => Promise<string> },
  backend: RunnerId, outcome: 'failed' | 'cancelled' | 'success', prompt: string): Promise<void> {
  if (outcome === 'cancelled') {
    withoutTaskScenario(fixture.store, fixture.runId);
    await fixture.answer(`Library: Vitest. ${HARNESS_ADAPTERS[backend].scenarios.done!}`);
    return;
  }
  expect(fixture.manager.continueRun(fixture.runId, { text: outcome === 'failed' ? prompt : 'mock:baseline' }).ok).toBe(true);
}

describe('harness parity — settlement during blocked autosave', () => {
  for (const backend of RUNNER_IDS) {
    for (const continuation of [false, true]) {
      for (const outcome of ['failed', 'cancelled', 'success'] as const) {
        const row = (outcome === 'failed' ? 61 : outcome === 'cancelled' ? 63 : 65) + Number(continuation);
        it(`${backend} R${row} ${continuation ? 'Continue' : 'fresh'} ${outcome} settles with a detached Git holder`, async () => {
          vi.stubEnv('CEZ_DELEGATION', '1');
          const save = worktrees.autosaveCommit;
          // Only the intercepted save gets the stubbed budget. A Continue cell's first
          // Finish/idle close saves through real Git; at 500 ms that save can time out
          // on a loaded host and retain an unproven-termination blocker, which refuses
          // the Continue below (hearsay-tools/cezarion#1095, same as R25).
          let budget: { timeoutMs: number; killGraceMs: number; confirmMs: number } | undefined;
          vi.spyOn(worktrees, 'autosaveCommit').mockImplementation((dir, reason, options) =>
            save(dir, reason, { ...options, ...budget }));
          vi.spyOn(console, 'warn').mockImplementation(() => undefined);
          try {
            const hasTail = continuation && outcome === 'cancelled';
            await withOwnedInputRun(backend, hasTail ? 'ask-snapshot' : 'baseline', async ({ store, manager, runId, repoRoot, adoptContext, answer }) => {
              if (continuation || outcome !== 'failed') {
                manager.enqueueOwnedRun(runId);
                // bound: the native mock must park before Finish or Continue can act.
                await waitFor(() => store.getRun(runId)?.status === 'waiting', FIXTURE_STEP_MS);
                if (hasTail) {
                  // bound: wait for the native ASK snapshot to reach the parent before expiring the
                  // continuation (hearsay-tools/cezarion#2410).
                  await waitFor(() => store.transcriptFacts(runId).pendingAsk?.routedMessageId !== undefined, FIXTURE_STEP_MS);
                  expect(store.getRun(runId)?.steps.map(step => step.status)).toEqual(['waiting', 'pending']);
                }
                if (continuation) {
                  if (outcome === 'cancelled') {
                    const state = (manager as unknown as { active: Map<string, { idleTimer: NodeJS.Timeout & { _onTimeout(): void } }> }).active.get(runId)!;
                    const expire = state.idleTimer._onTimeout;
                    clearTimeout(state.idleTimer);
                    expire();
                  } else manager.finish(runId);
                  // bound: the first Finish saves through real Git under the product budget.
                  await waitFor(() => !manager.isActive(runId), FIXTURE_STEP_MS);
                }
              }
              const bin = mkdtempSync(join(tmpdir(), 'cez-settlement-git-'));
              let replacement: { store: RunStore; manager: RunManager } | undefined;
              let unrelated: ReturnType<typeof spawn> | undefined;
              let unrelatedExit: Promise<unknown> | undefined;
              let holder: number | undefined;
              let saveTask: Promise<unknown> | undefined;
              const intercepted = vi.mocked(worktrees.autosaveCommit).getMockImplementation()!;
              vi.mocked(worktrees.autosaveCommit).mockImplementation((...args) => {
                saveTask = intercepted(...args);
                return saveTask as ReturnType<typeof save>;
              });
              // Intercept only autosave's status spawn. Real Git handles every other call;
              // the old PATH shim booted Node for all pre-save Git commands, consuming the
              // pid guard before this save even started (hearsay-tools/cezarion#1385).
              const nativeSpawn = childProcess.spawn;
              let git: ChildProcess | undefined;
              let gitExit: Promise<unknown> | undefined;
              const interceptSpawn = vi.spyOn(childProcess, 'spawn').mockImplementation(((...args: unknown[]) => {
                const [command, argv, options] = args;
                if (git || command !== 'git' || !Array.isArray(argv) || !argv.includes('status') || !argv.includes('--porcelain')) {
                  return Reflect.apply(nativeSpawn, childProcess, args);
                }
                git = nativeSpawn(process.execPath, ['-e', `
const fs = require('node:fs');
// A real detached descendant inherits autosave's marker, cwd and environment.
const holder = require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(`setInterval(() => { if (require('node:fs').existsSync(${JSON.stringify(join(bin, 'move'))})) process.chdir(${JSON.stringify(bin)}); }, 10)`)}], { detached: true, stdio: 'ignore' });
holder.unref();
fs.writeFileSync(${JSON.stringify(join(bin, 'holder'))}, String(holder.pid));
const timer = setInterval(() => {
  if (fs.existsSync(${JSON.stringify(join(bin, 'exit'))})) { clearInterval(timer); process.exit(0); }
}, 5);`], options as SpawnOptions);
                gitExit = new Promise(resolve => git!.once('exit', resolve));
                return git;
              }) as typeof spawn);
              // Keep the execFile-based index-writer check (hearsay-tools/cezarion#1080).
              // Once the intercepted save starts, hold add -N's completion until release,
              // so its following diff runs beside that save. Before spawn, let Git finish:
              // R66's settleSuccess diff must complete before final autosave can start.
              // Every call still runs real Git. Observe both the held
              // add and the later diff: neither may use the worktree's real index.
              let releaseIndex!: () => void;
              const indexReleased = new Promise<void>(resolve => { releaseIndex = resolve; });
              const exec = childProcess.execFile;
              const interceptExec = vi.spyOn(childProcess, 'execFile').mockImplementation(((...args: unknown[]) => {
                const [command, argv, options] = args;
                const callback = args.at(-1);
                if (command !== 'git' || !Array.isArray(argv) || typeof callback !== 'function') return Reflect.apply(exec, childProcess, args);
                const add = argv.includes('add') && argv.includes('-N');
                const diff = argv.includes('diff');
                const checkIndex = () => {
                  if ((add || diff) && !(options as ExecFileOptions).env?.GIT_INDEX_FILE && existsSync(join(bin, 'exit'))) {
                    writeFileSync(join(bin, 'unexpected-writer'), 'index mutation: ' + argv.join(' '));
                  }
                };
                const wrapped = (...result: unknown[]) => {
                  if (add && git) void indexReleased.then(() => { checkIndex(); callback(...result); });
                  else { checkIndex(); callback(...result); }
                };
                return Reflect.apply(exec, childProcess, [...args.slice(0, -1), wrapped]);
              }) as typeof exec);
              syncBuiltinESMExports();
              budget = { timeoutMs: 500, killGraceMs: 100, confirmMs: 100 };
              // bound: only the intercepted command's 500 ms deadline is shortened. Start
              // its budget after the holder PID handshake, never against Node startup.
              // The per-step handshake guard below bounds a broken fixture; clearTimeout
              // retains the real handle and still cancels this deadline on completion.
              const deadlineClock = vi.spyOn(globalThis, 'setTimeout').mockImplementation(((callback: (...args: unknown[]) => void, ms?: number, ...args: unknown[]) => {
                if (ms !== budget!.timeoutMs || !git) return realSetTimeout(callback, ms, ...args);
                let ready = false;
                const timer = realSetTimeout(() => {
                  if (!ready) {
                    ready = readPid(join(bin, 'holder')) !== undefined;
                    timer.refresh();
                  } else callback(...args);
                }, ms);
                return timer;
              }) as typeof setTimeout);
              try {
                const prompt = HARNESS_ADAPTERS[backend].scenarios['provider-error']!;
                if (continuation) {
                  await reopenSettled({ store, manager, runId, answer }, backend, outcome, prompt);
                  if (outcome === 'success') {
                    // bound: the continued native turn must park before Finish.
                    await waitFor(() => store.getRun(runId)?.status === 'waiting', FIXTURE_STEP_MS);
                  }
                } else if (outcome === 'failed') {
                  store.updateRun(runId, { task: prompt });
                  manager.enqueueOwnedRun(runId);
                }
                if (outcome !== 'failed' && !(continuation && outcome === 'cancelled')) expect(manager.finish(runId)).toBe(true);
                // bound: fixture startup ends when the real detached holder publishes a complete PID.
                await waitFor(() => readPid(join(bin, 'holder')) !== undefined, FIXTURE_STEP_MS);
                if (hasTail) expect(store.getRun(runId)?.steps.slice(0, 2).map(step => step.status)).toEqual(['done', 'pending']);
                const dir = store.getRun(runId)!.worktreePath!;
                writeFileSync(join(dir, 'progress.txt'), 'recover me\n');
                holder = requirePid(join(bin, 'holder'));
                // The fixture scopes /proc to processes it has seen in its tree; enumerate
                // once while Git still parents the holder, as a real host always lists it.
                readdirSync('/proc');
                // Parent-owned work in the worktree that keeps starting new processes (Squeal, agent tools).
                unrelated = spawn(process.execPath, ['-e', `
for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(signal, () => require('node:fs').writeFileSync(${JSON.stringify(join(bin, 'signalled'))}, signal));
setInterval(() => require('node:child_process').spawn(process.execPath, ['-e', 'setTimeout(() => {}, 40)'], { stdio: 'ignore' }), 20);`], { cwd: dir, stdio: 'ignore' });
                unrelatedExit = new Promise(resolve => unrelated!.once('exit', resolve));
                writeFileSync(join(bin, 'exit'), 'exit');
                releaseIndex();
                const gitPid = git!.pid!;
                // bound: observe the Git leader's actual exit after releasing it.
                await waitFor(() => { try { process.kill(gitPid, 0); return false; } catch { return true; } });
                if (outcome === 'cancelled') expect(manager.cancel(runId)).toBe(true);
                // bound: the first blocked report can precede the first holder poll under load ("process
                // inspection pending; retained cwd holder PIDs: none", seen in the full suite at load
                // 30+); the refusal below quotes the latest report, so wait for the one naming the holder.
                await waitFor(() => store.readEvents(runId).some(event => event.type === 'note' && String(event.message).includes('termination not confirmed') &&
                  String(event.message).includes(`holder PIDs: ${holder}`)), 5000);
                // bound: wait for settlement and the real turn-end diff stat. Independence
                // from cleanup is proven by the live holder below, not by elapsed time.
                await waitFor(() => !manager.isActive(runId), FIXTURE_STEP_MS);
                expect(outcome === 'success' ? ['done', 'review'] : [outcome]).toContain(store.getRun(runId)?.status);
                expect(store.getRun(runId)?.stopping).toBeUndefined();
                expect(store.readWorkerExecution(runId)?.phase).toBe('complete');
                const refusal = manager.continueRun(runId, { text: 'another writer' });
                expect(refusal.ok).toBe(false);
                expect(refusal.error).toContain(String(holder));
                expect(refusal.error).not.toContain(String(unrelated.pid));
                expect(manager.claimForPublish(runId)).toBeNull();
                expect(manager.claimWorktreeReclaim(runId)).toBeNull();
                expect(manager.claimForBranchCleanup([runId])).toBeNull();
                expect(() => process.kill(holder!, 0)).not.toThrow();
                expect(unrelated.exitCode).toBeNull();
                expect(existsSync(join(bin, 'signalled'))).toBe(false);
                expect(readFileSync(join(dir, 'progress.txt'), 'utf8')).toBe('recover me\n');
                expect(existsSync(join(bin, 'unexpected-writer'))).toBe(false);
                expect(existsSync(join(dir, 'unexpected-tail'))).toBe(false);
                if (!continuation && outcome === 'failed') {
                  writeFileSync(join(bin, 'move'), 'move');
                  // bound: the holder must move its real cwd before replacement-manager recovery.
                  await waitFor(() => readlinkSync(`/proc/${holder!}/cwd`) === bin);
                  manager.dispose(); store.close();
                  const reopened = RunStore.open(join(repoRoot, '.ai/cezar'), { keepLive: true });
                  replacement = { store: reopened, manager: new RunManager(reopened, repoRoot) };
                  await adoptContext(replacement);
                  expect(replacement.manager.continueRun(runId, { text: 'after replacement' }).ok).toBe(false);
                  expect(replacement.manager.claimForPublish(runId)).toBeNull();
                  expect(replacement.manager.claimWorktreeReclaim(runId)).toBeNull();
                  expect(replacement.manager.claimForBranchCleanup([runId])).toBeNull();
                }
              } finally {
                deadlineClock.mockRestore();
                writeFileSync(join(bin, 'exit'), 'exit');
                releaseIndex();
                unrelated?.kill('SIGKILL');
                await unrelatedExit;
                git?.kill('SIGKILL');
                await gitExit;
                // A failed handshake must still reap any holder the leader already spawned.
                holder ??= readPid(join(bin, 'holder'));
                if (holder) {
                  try { process.kill(holder, 'SIGKILL'); } catch { /* gone */ }
                  // bound: reap the owned holder before releasing its durable cleanup hold.
                  await waitFor(() => { try { process.kill(holder!, 0); return false; } catch { return true; } });
                }
                await saveTask;
                if (replacement) {
                  // bound: replacement-manager recovery must remove the persisted cleanup proof.
                  await waitFor(() => !existsSync(join(repoRoot, '.ai/cezar/runs', `${runId}.autosave-cleanup.json`)));
                  const release = replacement.manager.claimForPublish(runId);
                  expect(release).not.toBeNull(); release?.();
                }
                // bound: Finish must settle before fixture process interception is removed.
                await waitFor(() => !manager.isActive(runId), FIXTURE_STEP_MS);
                interceptExec.mockRestore();
                interceptSpawn.mockRestore();
                syncBuiltinESMExports();
                rmSync(bin, { recursive: true, force: true });
              }
              if (!replacement) {
                // bound: wait for autosave's cleanup confirmation after the holder exits.
                await waitFor(() => store.readEvents(runId).some(event => event.type === 'note' && String(event.message).includes('cleanup confirmed')));
              }
              if (!replacement) {
                const release = manager.claimForPublish(runId);
                expect(release).not.toBeNull(); release?.();
              }
            }, continuation && outcome === 'cancelled' ? { workflowDef: {
              name: 'cleanup-tail', source: 'file', path: 'cleanup-tail.yaml', steps: [
                { id: 'first', prompt: '{{task}}', runner: backend },
                { id: 'tail', command: 'touch unexpected-tail' },
              ],
            } } : {});
          } finally { vi.restoreAllMocks(); vi.unstubAllEnvs(); }
        }, 60_000);
      }
    }
  }
});

// hearsay-tools/cezarion#958: processes merely born in the worktree during the final
// save (Squeal's Vitest workers, agent tools) are not Git's. Registered as R67–R68.
describe('harness parity — final autosave beside unrelated process churn', () => {
  for (const backend of RUNNER_IDS) {
    for (const continuation of [false, true]) {
      const row = continuation ? 68 : 67;
      it(`${backend} R${row} ${continuation ? 'Continue' : 'fresh'} Finish commits without holding cleanup`, async () => {
        vi.stubEnv('CEZ_DELEGATION', '1');
        const save = worktrees.autosaveCommit;
        const saves: ReturnType<typeof save>[] = [];
        const settled = new Set<ReturnType<typeof save>>();
        let onSaveStart: (() => void) | undefined;
        vi.spyOn(worktrees, 'autosaveCommit').mockImplementation((dir, reason, options) => {
          // This cell exercises attribution, not a Git timeout. Real saves, including
          // the Continue setup save, keep their normal command and cleanup budgets.
          onSaveStart?.();
          const task = save(dir, reason, options);
          saves.push(task);
          void task.then(() => settled.add(task), () => settled.add(task));
          return task;
        });
        vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        try {
          await withOwnedInputRun(backend, 'baseline', async ({ store, manager, runId }) => {
            manager.enqueueOwnedRun(runId);
            await waitFor(() => store.getRun(runId)?.status === 'waiting');
            if (continuation) {
              manager.finish(runId);
              await waitFor(() => !manager.isActive(runId));
              await Promise.allSettled(saves);
              expect(manager.continueRun(runId, { text: 'mock:baseline' }).ok).toBe(true);
              await waitFor(() => manager.isActive(runId) && store.getRun(runId)?.status === 'waiting');
            }
            const dir = store.getRun(runId)!.worktreePath!;
            const signalled = join(mkdtempSync(join(tmpdir(), 'cez-unrelated-')), 'signalled');
            let births = 0;
            let birthsAtSaveStart = 0;
            const unrelated = spawn(process.execPath, ['-e', `
for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(signal, () => require('node:fs').writeFileSync(${JSON.stringify(signalled)}, signal));
// Keep creating children, but let each one exit before starting the next. A 20 ms
// interval queues Node boots faster than one contended CPU can run them (hearsay-tools/cezarion#1308).
function churn() {
  const child = require('node:child_process').spawn(process.execPath, ['-e', "process.send('born'); setTimeout(() => {}, 40)"], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
  child.on('message', message => process.send(message));
  child.once('exit', churn);
}
churn();`], { cwd: dir, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
            unrelated.on('message', () => { births++; });
            const unrelatedExit = new Promise(resolve => unrelated.once('exit', resolve));
            try {
              await waitFor(() => births > 0);
              writeFileSync(join(dir, 'progress.txt'), 'save me\n');
              saves.length = 0;
              onSaveStart = () => { birthsAtSaveStart = births; };
              expect(manager.finish(runId)).toBe(true);
              // bound: with CPU 1 and two busy loops, the bounded-churn save took
              // 5.076 s (hearsay-tools/cezarion#1308). Allow 30 s for real Git and
              // process attribution, then guard registry release separately below.
              await waitFor(() => saves.length > 0 && saves.every(task => settled.has(task)), 30_000);
              expect(await Promise.all(saves)).toContain('committed');
              expect(births).toBeGreaterThan(birthsAtSaveStart);
              await waitFor(() => !manager.isActive(runId));
              const notes = store.readEvents(runId).filter(event => event.type === 'note').map(event => String(event.message));
              expect(notes.filter(note => /autosave (failed|unsuccessful)|termination not confirmed|cleanup/.test(note))).toEqual([]);
              expect(execFileSync('git', ['show', 'HEAD:progress.txt'], { cwd: dir, encoding: 'utf8' })).toBe('save me\n');
              expect(runInternals(manager).worktreeAutosave.autosaveCleanupBlocker(runId)).toBeUndefined();
              const release = manager.claimForPublish(runId);
              expect(release).not.toBeNull(); release?.();
              expect(unrelated.exitCode).toBeNull();
              expect(existsSync(signalled)).toBe(false);
            } finally {
              unrelated.kill('SIGKILL');
              await unrelatedExit;
              rmSync(dirname(signalled), { recursive: true, force: true });
            }
          });
        } finally { vi.restoreAllMocks(); vi.unstubAllEnvs(); }
      }, 60_000);
    }
  }
});

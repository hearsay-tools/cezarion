import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { setTimeout as realSetTimeout } from 'node:timers';
import { describe, expect, it, vi } from 'vitest';
import * as worktrees from '../git-worktree.ts';
import { RunStore } from '../runs/store.ts';
import { RunManager } from '../workflows/run.ts';
import { RUNNER_IDS } from './agent-runner.ts';
import { HARNESS_ADAPTERS, withOwnedInputRun, waitFor } from './harness-parity.testkit.ts';
import { killFromPidFile, requirePid, writePidSource } from '../pid-file.testkit.ts';

const realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();

// hearsay-tools/cezarion#934: native provider failures and Stop must settle
// independently of the retained worktree-writer proof. Registered as R61–R66.
// hearsay-tools/cezarion#958: the retained holder is Git's detached descendant;
// an unrelated process churning in the worktree is neither named nor signalled.
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
            await withOwnedInputRun(backend, hasTail ? 'ask-snapshot' : 'baseline', async ({ store, manager, runId, repoRoot, adoptContext }) => {
              if (continuation || outcome !== 'failed') {
                manager.enqueueOwnedRun(runId);
                await waitFor(() => store.getRun(runId)?.status === 'waiting');
                if (hasTail) {
                  await waitFor(() => !!store.transcriptFacts(runId).pendingAsk?.fallback);
                  expect(store.getRun(runId)?.steps.map(step => step.status)).toEqual(['waiting', 'pending']);
                }
                if (continuation) {
                  if (outcome === 'cancelled') {
                    const state = (manager as unknown as { active: Map<string, { idleTimer: NodeJS.Timeout & { _onTimeout(): void } }> }).active.get(runId)!;
                    const expire = state.idleTimer._onTimeout;
                    clearTimeout(state.idleTimer);
                    expire();
                  } else manager.finish(runId);
                  await waitFor(() => !manager.isActive(runId));
                }
              }
              const bin = mkdtempSync(join(tmpdir(), 'cez-settlement-git-'));
              const path = process.env.PATH;
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
              writeFileSync(join(bin, 'git'), `#!${process.execPath}\n
const fs = require('node:fs');
const args = process.argv.slice(2);
const released = () => fs.existsSync(${JSON.stringify(join(bin, 'exit'))});
// hearsay-tools/cezarion#1080: the turn-end diff stat starts its \`add -N\` beside the
// blocked save. At load 34-43 that fake Git booted after the release (cursor R64 in the
// #902 gate, unit run 3). Hold every intent-to-add up to that point so the race is
// deterministic, then flag any command that writes the worktree's REAL index after the
// release: \`add -N\`, and \`diff\`, which refreshes the index it reads. A private
// GIT_INDEX_FILE is not the worktree's index.
if (args.includes('add') && args.includes('-N')) {
  const until = Date.now() + 1000;
  while (!released() && Date.now() < until) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
}
if (((args.includes('add') && args.includes('-N')) || args.includes('diff')) && !process.env.GIT_INDEX_FILE && released()) {
  fs.writeFileSync(${JSON.stringify(join(bin, 'unexpected-writer'))}, 'index mutation: ' + args.join(' '));
}
if (args.includes('status') && args.includes('--porcelain')) {
  // Reproduce startup delayed past the 500 ms command budget (hearsay-tools/cezarion#1216).
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 800);
  // Born after the holder baseline in a session of its own, outside Git's group.
  const holder = require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(`setInterval(() => { if (require('node:fs').existsSync(${JSON.stringify(join(bin, 'move'))})) process.chdir(${JSON.stringify(bin)}); }, 10)`)}], { detached: true, stdio: 'ignore' });
  holder.unref();
  fs.writeFileSync(${JSON.stringify(join(bin, 'holder'))}, String(holder.pid));
  ${writePidSource(join(bin, 'pid'))}
  const timer = setInterval(() => {
    if (fs.existsSync(${JSON.stringify(join(bin, 'exit'))})) {
      clearInterval(timer); process.exit(0);
    }
  }, 5);
} else {
  const r = require('node:child_process').spawnSync(${JSON.stringify(realGit)}, args, {stdio:'inherit'});
  process.exit(r.status ?? 1);
}
`, { mode: 0o755 });
              process.env.PATH = `${bin}:${path}`;
              budget = { timeoutMs: 500, killGraceMs: 100, confirmMs: 100 };
              // hearsay-tools/cezarion#1216: an 800 ms shim startup reproduces R63's
              // missing pid: the 500 ms command deadline kills Node before it writes it.
              // Gate only that deadline on the holder handshake, not runner/poll timers.
              // Keep the same timer handle so autosave's clearTimeout still cancels it.
              // The existing 10 s precondition bound also limits a missing handshake.
              const startupDeadline = Date.now() + 10_000;
              const deadlineClock = vi.spyOn(globalThis, 'setTimeout').mockImplementation(((callback: (...args: unknown[]) => void, ms?: number, ...args: unknown[]) => {
                if (ms !== budget!.timeoutMs) return realSetTimeout(callback, ms, ...args);
                let ready = existsSync(join(bin, 'pid'));
                const timer = realSetTimeout(() => {
                  if (!ready && Date.now() < startupDeadline) {
                    ready = existsSync(join(bin, 'pid'));
                    timer.refresh();
                  } else callback(...args);
                }, ms);
                return timer;
              }) as typeof setTimeout);
              try {
                const prompt = HARNESS_ADAPTERS[backend].scenarios['provider-error']!;
                if (continuation) {
                  expect(manager.continueRun(runId, { text: outcome === 'failed' ? prompt : outcome === 'cancelled' ? `Library: Vitest. ${HARNESS_ADAPTERS[backend].scenarios.done!}` : 'mock:baseline' }).ok).toBe(true);
                  if (outcome === 'success') await waitFor(() => store.getRun(runId)?.status === 'waiting');
                } else if (outcome === 'failed') {
                  store.updateRun(runId, { task: prompt });
                  manager.enqueueOwnedRun(runId);
                }
                if (outcome !== 'failed' && !(continuation && outcome === 'cancelled')) expect(manager.finish(runId)).toBe(true);
                await waitFor(() => existsSync(join(bin, 'pid')));
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
                const gitPid = requirePid(join(bin, 'pid'));
                await waitFor(() => { try { process.kill(gitPid, 0); return false; } catch { return true; } });
                if (outcome === 'cancelled') expect(manager.cancel(runId)).toBe(true);
                // The first blocked report can precede the first holder poll under load ("process
                // inspection pending; retained cwd holder PIDs: none", seen in the full suite at load
                // 30+); the refusal below quotes the latest report, so wait for the one naming the holder.
                await waitFor(() => store.readEvents(runId).some(event => event.type === 'note' && String(event.message).includes('termination not confirmed') &&
                  String(event.message).includes(`holder PIDs: ${holder}`)), 5000);
                // No custom bound here (hearsay-tools/cezarion#1095). Settlement still waits for the
                // turn-end diff stat (`execution.turns`), and that stat runs four or five Git
                // processes through this fake's Node shim after the release above. At load ~50 those
                // boots outran the old 3 s bound. Independence from the holder is proven by the
                // holder still being alive at the assertions below, since it lives until `finally`,
                // not by how fast settlement is.
                await waitFor(() => !manager.isActive(runId));
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
                process.env.PATH = path;
                unrelated?.kill('SIGKILL');
                await unrelatedExit;
                if (holder) {
                  try { process.kill(holder, 'SIGKILL'); } catch { /* gone */ }
                  await waitFor(() => { try { process.kill(holder!, 0); return false; } catch { return true; } });
                }
                killFromPidFile(join(bin, 'pid'));
                await saveTask;
                if (replacement) {
                  await waitFor(() => !existsSync(join(repoRoot, '.ai/cezar/runs', `${runId}.autosave-cleanup.json`)));
                  const release = replacement.manager.claimForPublish(runId);
                  expect(release).not.toBeNull(); release?.();
                }
                await waitFor(() => !manager.isActive(runId));
                rmSync(bin, { recursive: true, force: true });
              }
              if (!replacement) await waitFor(() => store.readEvents(runId).some(event => event.type === 'note' && String(event.message).includes('cleanup confirmed')));
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
              expect(manager.autosaveCleanupBlocker(runId)).toBeUndefined();
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

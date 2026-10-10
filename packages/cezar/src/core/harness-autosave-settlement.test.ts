import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readlinkSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import * as worktrees from '../git-worktree.ts';
import { RunStore } from '../runs/store.ts';
import { RunManager } from '../workflows/run.ts';
import { RUNNER_IDS } from './agent-runner.ts';
import { HARNESS_ADAPTERS, withOwnedInputRun, waitFor } from './harness-parity.testkit.ts';

const realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();

// hearsay-tools/cezarion#934: native provider failures and Stop must settle
// independently of the retained worktree-writer proof. Registered as R61–R66.
describe('harness parity — settlement during blocked autosave', () => {
  for (const backend of RUNNER_IDS) {
    for (const continuation of [false, true]) {
      for (const outcome of ['failed', 'cancelled', 'success'] as const) {
        const row = (outcome === 'failed' ? 61 : outcome === 'cancelled' ? 63 : 65) + Number(continuation);
        it(`${backend} R${row} ${continuation ? 'Continue' : 'fresh'} ${outcome} settles with an unrelated holder`, async () => {
          vi.stubEnv('CEZ_DELEGATION', '1');
          const save = worktrees.autosaveCommit;
          vi.spyOn(worktrees, 'autosaveCommit').mockImplementation((dir, reason, options) =>
            save(dir, reason, { ...options, timeoutMs: 500, killGraceMs: 100, confirmMs: 100 }));
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
              let holder: ReturnType<typeof spawn> | undefined;
              let holderExit: Promise<unknown> | undefined;
              let saveTask: Promise<unknown> | undefined;
              const intercepted = vi.mocked(worktrees.autosaveCommit).getMockImplementation()!;
              vi.mocked(worktrees.autosaveCommit).mockImplementation((...args) => {
                saveTask = intercepted(...args);
                return saveTask as ReturnType<typeof save>;
              });
              writeFileSync(join(bin, 'git'), `#!${process.execPath}\n
const fs = require('node:fs');
const args = process.argv.slice(2);
if (args.includes('add') && args.includes('-N') && fs.existsSync(${JSON.stringify(join(bin, 'exit'))})) {
  fs.writeFileSync(${JSON.stringify(join(bin, 'unexpected-writer'))}, 'index mutation');
}
if (args.includes('status') && args.includes('--porcelain')) {
  fs.writeFileSync(${JSON.stringify(join(bin, 'pid'))}, String(process.pid));
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
                // Parent-owned, outside Git's group, born after the holder baseline.
                holder = spawn(process.execPath, ['-e', `setInterval(() => { if (require('node:fs').existsSync(${JSON.stringify(join(bin, 'move'))})) process.chdir(${JSON.stringify(bin)}); }, 10)`], { cwd: dir, stdio: 'ignore' });
                holderExit = new Promise(resolve => holder!.once('exit', resolve));
                writeFileSync(join(bin, 'exit'), 'exit');
                const gitPid = Number(readFileSync(join(bin, 'pid'), 'utf8'));
                await waitFor(() => { try { process.kill(gitPid, 0); return false; } catch { return true; } });
                if (outcome === 'cancelled') expect(manager.cancel(runId)).toBe(true);
                await waitFor(() => store.readEvents(runId).some(event => event.type === 'note' && String(event.message).includes('termination not confirmed')), 5000);
                await waitFor(() => !manager.isActive(runId), 3000);
                expect(outcome === 'success' ? ['done', 'review'] : [outcome]).toContain(store.getRun(runId)?.status);
                expect(store.getRun(runId)?.stopping).toBeUndefined();
                expect(store.readWorkerExecution(runId)?.phase).toBe('complete');
                const refusal = manager.continueRun(runId, { text: 'another writer' });
                expect(refusal.ok).toBe(false);
                expect(refusal.error).toContain(String(holder.pid));
                expect(manager.claimForPublish(runId)).toBeNull();
                expect(manager.claimWorktreeReclaim(runId)).toBeNull();
                expect(manager.claimForBranchCleanup([runId])).toBeNull();
                expect(() => process.kill(holder!.pid!, 0)).not.toThrow();
                expect(readFileSync(join(dir, 'progress.txt'), 'utf8')).toBe('recover me\n');
                expect(existsSync(join(bin, 'unexpected-writer'))).toBe(false);
                expect(existsSync(join(dir, 'unexpected-tail'))).toBe(false);
                if (!continuation && outcome === 'failed') {
                  writeFileSync(join(bin, 'move'), 'move');
                  await waitFor(() => readlinkSync(`/proc/${holder!.pid}/cwd`) === bin);
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
                process.env.PATH = path;
                holder?.kill('SIGKILL');
                await holderExit;
                if (existsSync(join(bin, 'pid'))) {
                  try { process.kill(Number(readFileSync(join(bin, 'pid'), 'utf8')), 'SIGKILL'); } catch { /* gone */ }
                }
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

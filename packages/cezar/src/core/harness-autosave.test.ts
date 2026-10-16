import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import * as worktrees from '../git-worktree.ts';
import { RUNNER_IDS } from './agent-runner.ts';
import { withOwnedInputRun, waitFor } from './harness-parity.testkit.ts';
import { killFromPidFile, readPid, writePidSource } from '../pid-file.testkit.ts';

const realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
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
            await waitFor(() => store.getRun(runId)?.status === 'waiting');
            if (continuation) {
              manager.finish(runId);
              await waitFor(() => !manager.isActive(runId));
              expect(manager.continueRun(runId, { text: 'mock:baseline' }).ok).toBe(true);
              await waitFor(() => manager.isActive(runId) && store.getRun(runId)?.status === 'waiting');
            }
            const dir = store.getRun(runId)!.worktreePath!;
            writeFileSync(join(dir, 'progress.txt'), 'recover me\n');
            const bin = mkdtempSync(join(tmpdir(), 'cez-parity-git-'));
            const path = process.env.PATH;
            let obscure = true;
            const kill = process.kill.bind(process);
            const probe = vi.spyOn(process, 'kill').mockImplementation((pid, signal) => {
              const file = join(bin, 'pid');
              // While obscure, keep the intercepted Git in an unproven state:
              // EPERM on the group probe, and no TERM/KILL delivery. SIGKILL can
              // otherwise leave a /proc zombie that autosave treats as proof of
              // death, skipping the blocked-cleanup note (hearsay-tools/cezarion#950).
              const git = readPid(file);
              if (git !== undefined && pid === -git && obscure) {
                if (signal === 0) throw Object.assign(new Error('unreadable'), { code: 'EPERM' });
                return true;
              }
              return kill(pid, signal);
            });
            writeFileSync(join(bin, 'git'), `#!${process.execPath}\n
const fs = require('node:fs');
const args = process.argv.slice(2);
if (args.includes('status') && args.includes('--porcelain')) {
  process.on('SIGTERM', () => {});
  ${writePidSource(join(bin, 'pid'))}
  setInterval(() => {}, 1000);
} else {
  const r = require('node:child_process').spawnSync(${JSON.stringify(realGit)}, args, {stdio:'inherit'});
  process.exit(r.status ?? 1);
}
`, { mode: 0o755 });
            process.env.PATH = `${bin}:${path}`;
            budget = { timeoutMs: 500, killGraceMs: 100, confirmMs: 100 };
            try {
              expect(manager.finish(runId)).toBe(true);
              // Under load the stubbed 700ms Git budget is not the wait: reaching
              // autosave from finish is (hearsay-tools/cezarion#950). Wait for the
              // intercepted Git spawn first, then for the blocked-cleanup note.
              await waitFor(() => existsSync(join(bin, 'pid')));
              await waitFor(() => store.readEvents(runId).some(event => event.type === 'note' && String(event.message).includes('termination not confirmed')));
              await waitFor(() => !manager.isActive(runId));
              expect(store.readWorkerExecution(runId)?.phase).toBe('complete');
              expect(manager.claimForPublish(runId)).toBeNull();
              expect(manager.claimWorktreeReclaim(runId)).toBeNull();
              expect(manager.continueRun(runId, { text: 'another writer' }).ok).toBe(false);
              expect(readFileSync(join(dir, 'progress.txt'), 'utf8')).toBe('recover me\n');
            } finally {
              process.env.PATH = path;
              obscure = false;
              // Also reaps the old unbounded implementation during mutation tests.
              killFromPidFile(join(bin, 'pid'), 'SIGKILL', kill);
              probe.mockRestore();
              await Promise.allSettled(saves);
              await waitFor(() => !manager.isActive(runId));
              rmSync(bin, { recursive: true, force: true });
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

import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import * as worktrees from '../git-worktree.ts';
import { RUNNER_IDS } from './agent-runner.ts';
import { withOwnedInputRun, waitFor } from './harness-parity.testkit.ts';

const realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
// Real native frames on every HARNESS_ADAPTERS runner. Registered as R24/R25
// in the parity guard; no wire exemption exists for filesystem cleanup.
describe('harness parity — autosave cleanup (#495)', () => {
  for (const backend of RUNNER_IDS) {
    for (const continuation of [false, true]) {
      it(`${backend} ${continuation ? 'R25 continuation' : 'R24 initial'} retains reuse guard until Git termination`, async () => {
        vi.stubEnv('CEZ_DELEGATION', '1');
        const save = worktrees.autosaveCommit;
        vi.spyOn(worktrees, 'autosaveCommit').mockImplementation((dir, reason, options) =>
          save(dir, reason, { ...options, timeoutMs: 500, killGraceMs: 100, confirmMs: 100 }));
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
              if (signal === 0 && existsSync(file) && pid === -Number(readFileSync(file, 'utf8')) && obscure) {
                throw Object.assign(new Error('unreadable'), { code: 'EPERM' });
              }
              return kill(pid, signal);
            });
            writeFileSync(join(bin, 'git'), `#!${process.execPath}\n
const fs = require('node:fs');
const args = process.argv.slice(2);
if (args.includes('status') && args.includes('--porcelain')) {
  process.on('SIGTERM', () => {});
  fs.writeFileSync(${JSON.stringify(join(bin, 'pid'))}, String(process.pid));
  setInterval(() => {}, 1000);
} else {
  const r = require('node:child_process').spawnSync(${JSON.stringify(realGit)}, args, {stdio:'inherit'});
  process.exit(r.status ?? 1);
}
`, { mode: 0o755 });
            process.env.PATH = `${bin}:${path}`;
            try {
              expect(manager.finish(runId)).toBe(true);
              await waitFor(() => store.readEvents(runId).some(event => event.type === 'note' && String(event.message).includes('termination not confirmed')), 5000);
              expect(manager.isActive(runId)).toBe(true);
              expect(store.readWorkerExecution(runId)?.phase).not.toBe('complete');
              expect(manager.continueRun(runId, { text: 'another writer' }).ok).toBe(false);
              expect(readFileSync(join(dir, 'progress.txt'), 'utf8')).toBe('recover me\n');
            } finally {
              process.env.PATH = path;
              obscure = false;
              // Also reaps the old unbounded implementation during mutation tests.
              if (existsSync(join(bin, 'pid'))) {
                try { kill(Number(readFileSync(join(bin, 'pid'), 'utf8')), 'SIGKILL'); } catch { /* gone */ }
              }
              probe.mockRestore();
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

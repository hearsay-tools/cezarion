import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { readHandoff } from '../handoff.ts';
import { RUNNER_IDS } from './agent-runner.ts';
import { withOwnedInputRun, waitFor } from './harness-parity.testkit.ts';

const FOREIGN = 'fix/1004-x';
const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// hearsay-tools/cezarion#1004, on every HARNESS_ADAPTERS native wire: an agent
// that checks another branch out in its task worktree must not find
// `cezar autosave` on it when the session settles. Registered as R77 (initial
// run, `run finalize`) and R78 (Continue, `turn end`; its first settle also
// pins the positive cell, a commit on the task branch) in the parity guard.
describe('harness parity — autosave on an agent-checked-out branch (#1004)', () => {
  for (const backend of RUNNER_IDS) {
    for (const continuation of [false, true]) {
      it(`${backend} ${continuation ? 'R78 continuation turn end' : 'R77 initial run finalize'} leaves work on another branch uncommitted and reports it`, async () => {
        vi.stubEnv('CEZ_DELEGATION', '1');
        try {
          await withOwnedInputRun(backend, 'baseline', async ({ repoRoot, store, manager, runId }) => {
            const dataDir = join(repoRoot, '.ai/cezar');
            const notes = () => store.readEvents(runId).flatMap(event => event.type === 'note' ? [String(event.message)] : []);
            manager.enqueueOwnedRun(runId);
            await waitFor(() => store.getRun(runId)?.status === 'waiting');
            const { worktreePath: dir, branch: taskBranch } = store.getRun(runId)!;
            const git = (args: string[]) => execFileSync('git', args, { cwd: dir!, encoding: 'utf8' }).trim();
            expect(taskBranch).toMatch(/^cez\//);
            if (continuation) {
              writeFileSync(join(dir!, 'first.txt'), 'commit me\n');
              manager.finish(runId);
              await waitFor(() => !manager.isActive(runId));
              expect(git(['log', '-1', '--format=%s', taskBranch!])).toBe('cezar autosave (run finalize)');
              const sha = git(['rev-parse', '--short', taskBranch!]);
              const committed = `run finalize: cezar autosave committed ${sha} on ${taskBranch}; to fold it into your own commits while it is HEAD, run \`git reset --soft ${sha}~1\``;
              expect(readHandoff(dataDir, runId)).toContain(committed);
              expect(notes()).toContain(committed);
              expect(manager.continueRun(runId, { text: 'mock:baseline' }).ok).toBe(true);
              await waitFor(() => manager.isActive(runId) && store.getRun(runId)?.status === 'waiting');
            }
            git(['checkout', '-q', '-b', FOREIGN]);
            const tip = git(['rev-parse', 'HEAD']);
            writeFileSync(join(dir!, 'progress.txt'), 'keep me uncommitted\n');

            expect(manager.finish(runId)).toBe(true);
            await waitFor(() => !manager.isActive(runId));

            expect(git(['rev-parse', FOREIGN])).toBe(tip);
            expect(git(['status', '--porcelain']).split('\n')).toContain('?? progress.txt');
            const reason = continuation ? 'turn end' : 'run finalize';
            const skipped = new RegExp(`${escape(reason)}: \\d+ changed path\\(s\\) left uncommitted on ${escape(FOREIGN)}; ` +
              `cezar does not autosave on a branch other than the task branch ${escape(taskBranch!)}`);
            expect(readHandoff(dataDir, runId)).toMatch(skipped);
            expect(notes().some(message => skipped.test(message))).toBe(true);
          });
        } finally { vi.restoreAllMocks(); vi.unstubAllEnvs(); }
      }, 60_000);
    }
  }
});

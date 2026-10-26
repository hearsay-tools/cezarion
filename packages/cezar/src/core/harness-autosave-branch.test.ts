import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { readHandoff } from '../handoff.ts';
import { AUTOSAVE_INTERVAL_MS } from '../workflows/run.ts';
import { RUNNER_IDS } from './agent-runner.ts';
import { withOwnedInputRun, waitFor } from './harness-parity.testkit.ts';

const FOREIGN = 'fix/1004-x';
const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** Text of one `## Header` section of the handoff, up to the next `## ` header. */
const section = (text: string, header: string) => {
  const start = text.indexOf(`${header}\n`);
  if (start < 0) return '';
  const rest = text.slice(start + header.length + 1);
  const next = rest.indexOf('\n## ');
  return next >= 0 ? rest.slice(0, next) : rest;
};
/** The autosave lines of cezar's records block, newest first (hearsay-tools/cezarion#1809). */
const autosaveLines = (text: string) => section(text, '### Autosave').split('\n').filter(line => line.startsWith('- ')).join('\n');

// hearsay-tools/cezarion#1004, on every HARNESS_ADAPTERS native wire: an agent
// that checks another branch out in its task worktree must not find
// `cezar autosave` on it when the session settles. Registered as R78 (initial
// run, `run finalize`) and R79 (Continue, `turn end`; its first settle also
// pins the positive cell, a commit on the task branch, and its periodic case
// a timer commit that leaves the turn-end flush nothing to save) in the parity
// guard.
describe('harness parity — autosave on an agent-checked-out branch (#1004)', () => {
  for (const backend of RUNNER_IDS) {
    for (const continuation of [false, true]) {
      it(`${backend} ${continuation ? 'R79 continuation turn end' : 'R78 initial run finalize'} leaves work on another branch uncommitted and reports it`, async () => {
        vi.stubEnv('CEZ_DELEGATION', '1');
        try {
          await withOwnedInputRun(backend, 'baseline', async ({ repoRoot, store, manager, runId }) => {
            const dataDir = join(repoRoot, '.ai/cezar');
            const notes = () => store.readEvents(runId).flatMap(event => event.type === 'note' ? [String(event.message)] : []);
            // The report is in cezar's records block; the Progress log stays the agent's summary.
            const autosave = () => autosaveLines(readHandoff(dataDir, runId));
            const progress = () => section(readHandoff(dataDir, runId), '## Progress log');
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
              expect(autosave()).toContain(committed);
              expect(progress()).not.toContain(committed);
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
            expect(autosave()).toMatch(skipped);
            expect(progress()).not.toMatch(skipped);
            expect(notes().some(message => skipped.test(message))).toBe(true);
          });
        } finally { vi.restoreAllMocks(); vi.unstubAllEnvs(); }
      }, 60_000);
    }

    // Review on hearsay-tools/cezarion#1111: the timer commits the last work, so the
    // Continue's turn-end flush finds a clean tree and reports nothing; the timer's own
    // coalesced handoff line is what a resumed session reads.
    it(`${backend} R79 continuation periodic commit followed by a clean turn end is reported`, async () => {
      vi.stubEnv('CEZ_DELEGATION', '1');
      vi.stubEnv('CEZ_AUTOSAVE', '1');
      const intervals = vi.spyOn(globalThis, 'setInterval');
      try {
        await withOwnedInputRun(backend, 'baseline', async ({ repoRoot, store, manager, runId }) => {
          const dataDir = join(repoRoot, '.ai/cezar');
          const notes = () => store.readEvents(runId).flatMap(event => event.type === 'note' ? [String(event.message)] : []);
          const autosave = () => autosaveLines(readHandoff(dataDir, runId));
          const progress = () => section(readHandoff(dataDir, runId), '## Progress log');
          manager.enqueueOwnedRun(runId);
          await waitFor(() => store.getRun(runId)?.status === 'waiting');
          const { worktreePath: dir, branch: taskBranch } = store.getRun(runId)!;
          const git = (args: string[]) => execFileSync('git', args, { cwd: dir!, encoding: 'utf8' }).trim();
          expect(manager.finish(runId)).toBe(true);
          await waitFor(() => !manager.isActive(runId));
          intervals.mockClear();
          expect(manager.continueRun(runId, { text: 'mock:baseline' }).ok).toBe(true);
          await waitFor(() => manager.isActive(runId) && store.getRun(runId)?.status === 'waiting');
          // The Continue's own timer, fired by hand instead of after 90 s.
          const tick = intervals.mock.calls.filter(call => call[1] === AUTOSAVE_INTERVAL_MS).at(-1)?.[0];
          expect(tick).toBeTypeOf('function');
          writeFileSync(join(dir!, 'periodic.txt'), 'commit me\n');
          (tick as () => void)();
          await waitFor(() => autosave().includes('periodic: '));
          expect(git(['log', '-1', '--format=%s', taskBranch!])).toBe('cezar autosave (periodic)');
          const sha = git(['rev-parse', '--short', taskBranch!]);

          expect(manager.finish(runId)).toBe(true);
          await waitFor(() => !manager.isActive(runId));

          // The turn-end flush had nothing to save, so the periodic line is still the newest.
          expect(git(['rev-parse', '--short', taskBranch!])).toBe(sha);
          const periodic = `periodic: 1 cezar autosave commit(s) on ${taskBranch}, first ${sha}, latest ${sha}; ` +
            `to fold the latest into your own commits while it is HEAD, run \`git reset --soft ${sha}~1\``;
          expect(autosave().split('\n').filter(Boolean)[0]).toMatch(new RegExp(`^- \\S+ — ${escape(periodic)}$`));
          expect(store.getRun(runId)?.handoffRecords?.autosave[0]).toMatchObject({ note: periodic, periodic: { count: 1, first: sha, latest: sha } });
          expect(progress()).not.toContain('periodic');
          expect(notes().filter(message => message.includes('periodic'))).toEqual([]);
        });
      } finally { vi.restoreAllMocks(); vi.unstubAllEnvs(); }
    }, 60_000);
  }
});

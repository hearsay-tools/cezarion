import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { RUNNER_IDS } from './agent-runner.ts';
import { WORKTREE_SETUP_CRITERIA, driveRun } from './harness-parity.testkit.ts';

/**
 * R58 (hearsay-tools/cezarion#917, spec `.ai/specs/2026-10-07-worktree-setup.md`): a task
 * whose project declares `worktreeSetup` runs it in its isolated worktree, and the paragraph that
 * says so reaches the opening message on every runner's own native mock wire.
 */
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

const readOrEmpty = (path: string) => { try { return readFileSync(path, 'utf8'); } catch { return ''; } };

describe('harness parity — worktree setup note (#917)', () => {
  expect(WORKTREE_SETUP_CRITERIA.map((row) => row.id)).toEqual(['R58']);

  for (const backend of RUNNER_IDS) {
    it(`${backend} R58 delivers the worktree setup note in the opening message`, async () => {
      const wire = mkdtempSync(join(tmpdir(), `cez-r58-${backend}-`));
      dirs.push(wire);
      const argsFile = join(wire, 'args.ndjson');
      const stdinFile = join(wire, 'stdin.ndjson');
      const obs = await driveRun(backend, 'baseline', (record) => record?.status === 'waiting', 30_000, undefined, {
        worktree: true,
        env: { CEZ_MOCK_ARGS_FILE: argsFile, CEZ_MOCK_STDIN_FILE: stdinFile },
        beforeStart: ({ repoRoot }) => {
          mkdirSync(join(repoRoot, '.ai/cezar'), { recursive: true });
          writeFileSync(join(repoRoot, '.ai/cezar', 'config.json'), JSON.stringify({ worktreeSetup: { commands: ['echo r58-setup'] } }));
        },
      });
      const traffic = readOrEmpty(argsFile) + readOrEmpty(stdinFile);
      expect(obs.record?.worktreeSetup?.status).toBe('done');
      expect(traffic).toContain('Cezar prepared this worktree before your session started');
      expect(traffic).toContain('r58-setup');
    }, 60_000);
  }
});

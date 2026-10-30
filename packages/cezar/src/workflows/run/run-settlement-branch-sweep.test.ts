import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, it, vi } from 'vitest';
import { RunStore } from '../../runs/store.ts';
import { createFixtureManager, removeFixtureRepo } from '../fixture-cleanup.testkit.ts';
import { runInternals } from '../run-internals.testkit.ts';

/** The post-terminal trigger of the branch sweep (hearsay-tools/cezarion#2268): every retention
 *  pass hands the sweep its keep-count, which turns it off at 0. */
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await removeFixtureRepo(root);
  vi.unstubAllEnvs();
});

function fixture(retention?: number) {
  const root = mkdtempSync(join(tmpdir(), 'cez-settlement-sweep-')); roots.push(root);
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root });
  execFileSync('git', ['-c', 'user.name=test', '-c', 'user.email=test@local', 'commit', '--allow-empty', '-qm', 'base'], { cwd: root });
  if (retention !== undefined) {
    mkdirSync(join(root, '.ai/cezar'), { recursive: true });
    writeFileSync(join(root, '.ai/cezar/config.json'), JSON.stringify({ worktreeRetention: retention }));
  }
  vi.stubEnv('CEZ_DRY_RUN', '1');
  return { root, store: RunStore.open(join(root, '.ai/cezar')) };
}

it.each([3, 0])('hands the sweep the keep-count %i after each retention pass', async (keep) => {
  const { root, store } = fixture(keep);
  const sweepBranches = vi.fn();
  const manager = createFixtureManager(store, root, { sweepBranches });
  await runInternals(manager).runSettlement.enforceRetention();
  expect(sweepBranches).toHaveBeenCalledExactlyOnceWith(keep);
});

it('runs no sweep for a manager without one (`cez run`, tests)', async () => {
  const { root, store } = fixture(3);
  const manager = createFixtureManager(store, root);
  await expect(runInternals(manager).runSettlement.enforceRetention()).resolves.toBeUndefined();
});

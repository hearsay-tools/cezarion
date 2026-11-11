import { testHome } from '../../home/test-home.testkit.ts';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, it, vi } from 'vitest';
import { RunStore } from '../../runs/store.ts';
import { createFixtureManager, removeFixtureRepo, unused } from '../fixture-no-runner.testkit.ts';
import { RunSettlement } from './run-settlement.ts';
import { TrackedWork } from './tracked-work.ts';
import { WorkspaceSemaphore } from '../../workspace/semaphore.ts';
import { noRunners } from '../../core/runners-under-test.testkit.ts';

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

/** Unit-test retention where it lives; public completion also runs other settlement work. */
function settlement(root: string, store: RunStore, sweepBranches?: (keep: number) => void) {
  const work = new TrackedWork();
  const semaphore = new WorkspaceSemaphore({ home: testHome() });
  createFixtureManager(store, root, { home: testHome(), work, semaphore });
  const context = { createRunner: noRunners, home: testHome(), store, repoRoot: root, dataDir: join(root, '.ai/cezar'), work, semaphore, disposed: () => false, sweepBranches };
  const host = unused<ConstructorParameters<typeof RunSettlement>[9]>('RunSettlement.host', { claimWorktreeReclaim: () => null, preview: undefined });
  return new RunSettlement(context, unused('HumanWaits'), unused('WorkerQuestions'), unused('WorktreeAutosave'),
    unused('TurnBookkeeper'), unused('RunLine'), unused('AutoResumeScheduler'), unused('WorkerExecutions'),
    unused('CompletionGateHost'), host, '', '');
}

it.each([3, 0])('hands the sweep the keep-count %i after each retention pass', async (keep) => {
  const { root, store } = fixture(keep);
  const sweepBranches = vi.fn();
  await settlement(root, store, sweepBranches).enforceRetention();
  expect(sweepBranches).toHaveBeenCalledExactlyOnceWith(keep);
});

it('runs no sweep for a manager without one (`cez run`, tests)', async () => {
  const { root, store } = fixture(3);
  await expect(settlement(root, store).enforceRetention()).resolves.toBeUndefined();
});

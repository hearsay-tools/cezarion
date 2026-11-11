import { projectPaths } from '../project-paths.ts';
import { STEP_KIND } from '@open-mercato/cezar-contract/test-factories.testkit';
import { scopeFixtureProcesses } from './process-scope.testkit.ts';
import { copyWorkspaceSeed } from './workspace-seed.testkit.ts';
import { syncBuiltinESMExports } from 'node:module';
import { drainFixtureManagers } from '../workflows/fixture-claude.testkit.ts';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, vi } from 'vitest';
import type { WorkerWorkspace } from '@open-mercato/cezar-contract';
import { RunStore } from '../runs/store.ts';
import type { RunManager } from '../workflows/run.ts';

beforeEach(() => scopeFixtureProcesses());
afterEach(() => { vi.restoreAllMocks(); syncBuiltinESMExports(); });

export const roots: string[] = [];
export const stores: RunStore[] = [];
export const managers: RunManager[] = [];
export function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}
export async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'cez-owned-workspace-'));
  roots.push(root);
  await copyWorkspaceSeed(root);
  const first = git(root, 'rev-parse', 'HEAD');
  const parentPath = join(root, 'parent');
  git(root, 'worktree', 'add', '-qb', 'parent', parentPath);
  await writeFile(join(parentPath, 'tracked.txt'), 'committed');
  git(parentPath, 'commit', '-qam', 'two');
  const second = git(parentPath, 'rev-parse', 'HEAD');
  await writeFile(join(parentPath, 'tracked.txt'), 'dirty');
  await writeFile(join(parentPath, 'untracked.txt'), 'private');
  return { root, parentPath, first, second };
}
export function durableRun(root: string, workspace: WorkerWorkspace) {
  const store = RunStore.open(projectPaths(root).write);
  stores.push(store);
  const parent = store.createRun({ title: 'parent', task: 'parent', workflow: 'quick-task', steps: [] });
  store.updateRun(parent.id, { delegation: { role: 'root', permissions: ['spawn'], receipts: [] } });
  store.flush();
  const run = store.createOwnedRun({ title: 'worker', task: 'worker', workflow: 'quick-task', steps: [{ id: 'task', name: 'Do the task', kind: STEP_KIND.agent }] }, parent.id, randomUUID(), {
    role: 'worker', parentRunId: parent.id, permissions: [], workspace,
  }, 'a'.repeat(64));
  return { run, store };
}
export function receiptPath(root: string, workspace: WorkerWorkspace) {
  return join(root, '.git', 'cezar-owned-workspaces', `${workspace.resourceId}.json`);
}
afterEach(async () => {
  for (const root of roots) await drainFixtureManagers(root);
  for (const manager of managers.splice(0)) manager.dispose();
  for (const store of stores.splice(0)) store.flush();
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

// Real git init/worktree/branch per cell. Isolated cases finish in 0.3-0.9s; under
// shard load they overrun Vitest's 5s default (hearsay-tools/cezarion#948). Some CI
// runners also run the first ~3 minutes of Vitest shard 3/3 2-20x slower across every
// file; there the cases took 5-15.7s and timed out at 15s (runs 38364071255,
// 38703103918, 38704816191; hearsay-tools/cezarion#1059). Twice that peak.
export const WORKSPACE_TEST_TIMEOUT_MS = 30_000;


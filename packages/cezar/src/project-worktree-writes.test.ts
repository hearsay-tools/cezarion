import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { makeRunRecord, RUN_STATUS } from '@open-mercato/cezar-contract/test-factories.testkit';
import { autosaveCommit } from './autosave-commit.ts';
import { testHome } from './home/test-home.testkit.ts';
import { seedRuns } from './runs/run-store.testkit.ts';
import { RunStore } from './runs/store.ts';
import { collectChanges, commitAll, createOrSwitchBranch, pushCurrentBranch } from './server/git-changes.ts';
import { RunManager } from './workflows/run.ts';
import { runGroupedCommand } from './workflows/grouped-command.ts';
import { runWorktreeSetup } from './worktree-setup.ts';
import { withWorktreeFiles } from './worktree-manifest.ts';

let root: string, worktree: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'fallback-worktree-'));
  mkdirSync(join(root, '.ai/cezar'), { recursive: true }); // Keep the worktree in fallback data.
  worktree = join(root, '.ai/squawk/worktrees/task');
  mkdirSync(worktree, { recursive: true });
});
afterEach(() => { vi.restoreAllMocks(); rmSync(root, { recursive: true, force: true }); });
const refusal = /\.ai\/squawk.*binary that migrated/;
const git = (...args: string[]) => execFileSync('git', ['-C', worktree, ...args], { encoding: 'utf8' }).trim();

it('refuses Continue before claiming or copying a fallback family; record-only edits work after explicit adoption', () => {
  const source = join(root, '.ai/squawk');
  const run = makeRunRecord({ status: RUN_STATUS.done, worktreePath: worktree });
  seedRuns(source, [run]);
  const store = RunStore.open(join(root, '.ai/cezar'), { keepLive: true });
  const createRunner = vi.fn(() => { throw new Error('must not launch'); });
  const manager = new RunManager(store, root, { createRunner, home: testHome() });
  try {
    expect(manager.continueRun(run.id)).toEqual({ ok: false, error: expect.stringMatching(refusal) });
    expect(createRunner).not.toHaveBeenCalled();
    expect(existsSync(join(root, '.ai/cezar/runs.db'))).toBe(false);
    expect(store.updateRun(run.id, { title: 'automatic edit' })).toBeUndefined();
    expect(store.adoptFallbackFamily(run.id)).toBe(true);
    store.updateRun(run.id, { title: 'record-only edit' });
    store.flush();
    expect(store.getRun(run.id)?.title).toBe('record-only edit');
    expect(manager.continueRun(run.id).error).toMatch(refusal);
  } finally { manager.dispose(); store.close(); }
});

it('skips autosave once and refuses explicit Git writes while Changes remains readable without staging', async () => {
  git('init', '-q', '-b', 'main');
  writeFileSync(join(worktree, 'tracked'), 'original');
  git('add', '.');
  git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'fixture');
  const head = git('rev-parse', 'HEAD');
  writeFileSync(join(worktree, 'tracked'), 'changed');
  writeFileSync(join(worktree, 'untracked'), 'untracked');
  const status = git('status', '--porcelain');
  const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
  expect(await autosaveCommit(worktree, 'run finalize')).toBe('skipped');
  expect(info).toHaveBeenCalledTimes(1);
  expect(info.mock.calls[0]?.[0]).toMatch(/skipped 1.*\.ai\/squawk/);
  for (const result of [await commitAll(worktree, 'unsafe'), await createOrSwitchBranch(worktree, 'unsafe'), await pushCurrentBranch(worktree)]) {
    expect(result).toMatchObject({ ok: false, error: expect.stringMatching(refusal) });
  }
  const changes = await collectChanges(worktree, 'HEAD');
  expect(changes.ok && changes.changes.files.map(file => file.path).sort()).toEqual(['tracked', 'untracked']);
  expect(git('rev-parse', 'HEAD')).toBe(head);
  expect(git('status', '--porcelain')).toBe(status);
  expect(readFileSync(join(worktree, 'tracked'), 'utf8')).toBe('changed');
});

it('refuses setup, workflow checks and provisioned files before executing a writer', async () => {
  const command = 'touch must-not-exist';
  const common = { cwd: worktree, env: process.env, setInterrupt: () => undefined };
  const result = await runWorktreeSetup({ ...common, plan: { kind: 'commands', commands: [command], timeoutSeconds: 1 },
    isCancelled: () => false, onCommandResult: () => { throw new Error('must not run'); } });
  expect(result).toMatchObject({ status: 'invalid', issue: expect.stringMatching(refusal) });
  expect(await runGroupedCommand({ ...common, command, keep: 'head', cap: 100 })).toMatchObject({ spawnError: expect.stringMatching(refusal) });
  await expect(withWorktreeFiles(worktree, 'skills', {}, false, async () => { throw new Error('must not provision'); })).rejects.toThrow(refusal);
  expect(existsSync(join(worktree, 'must-not-exist'))).toBe(false);
});

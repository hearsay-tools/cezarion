import childProcess, { execFileSync } from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { fixture } from './service.testkit.ts';

const git = (root: string, ...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
function snapshot(root: string) {
  const sha = git(root, 'rev-parse', 'HEAD');
  return {
    commit: git(root, 'cat-file', '-p', 'HEAD').replace(/^(author|committer) (.*) \d+ [+-]\d+$/gm, '$1 $2 <time>'),
    refs: git(root, 'show-ref').replaceAll(sha, '<head>'),
    configKeys: git(root, 'config', '--local', '--name-only', '--list').split('\n').sort(),
    worktrees: git(root, 'worktree', 'list', '--porcelain').replaceAll(root, '<root>').replaceAll(sha, '<head>'),
    files: git(root, 'ls-tree', '-r', 'HEAD'),
  };
}

it('copies an equivalent empty base without repeating Git setup and isolates every copy', async () => {
  const old = mkdtempSync(join(tmpdir(), 'cez-service-old-seed-'));
  const first = fixture();
  let second: ReturnType<typeof fixture> | undefined;
  let third: ReturnType<typeof fixture> | undefined;
  try {
    git(old, 'init', '-q', '-b', 'main');
    git(old, 'config', 'gc.auto', '0');
    git(old, 'config', 'maintenance.auto', 'false');
    git(old, '-c', 'user.name=test', '-c', 'user.email=test@local', 'commit', '--allow-empty', '-qm', 'base');
    expect(snapshot(first.root)).toEqual(snapshot(old));
    const spawn = vi.spyOn(childProcess, 'execFileSync');
    syncBuiltinESMExports();
    try {
      second = fixture();
      expect(spawn.mock.calls.filter(([command]) => command === 'git')).toEqual([]);
    } finally {
      spawn.mockRestore();
      syncBuiltinESMExports();
    }
    git(first.root, 'config', 'seed.changed', 'true');
    writeFileSync(join(first.root, 'only-first'), 'changed');
    git(first.root, 'add', 'only-first');
    git(first.root, '-c', 'user.name=test', '-c', 'user.email=test@local', 'commit', '-qm', 'changed');
    third = fixture();
    expect(snapshot(second.root)).toEqual(snapshot(old));
    expect(snapshot(third.root)).toEqual(snapshot(old));
    expect(existsSync(join(second.root, 'only-first'))).toBe(false);
    expect(existsSync(join(third.root, 'only-first'))).toBe(false);
    expect(git(second.root, 'status', '--porcelain', '--untracked-files=no')).toBe('');
    expect(git(third.root, 'status', '--porcelain', '--untracked-files=no')).toBe('');
  } finally {
    await third?.close();
    await second?.close();
    await first.close();
    rmSync(old, { recursive: true, force: true });
  }
});

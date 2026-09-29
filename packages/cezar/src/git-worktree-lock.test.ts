import { execFile } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, expect, it } from 'vitest';
import { createWorktree, pruneOrphans, removeWorktree } from './git-worktree.ts';
import { withWorktreeMutation } from './git-worktree-lock.ts';
import { readMutationClaim } from './git-worktree-lock-helper.ts';

const exec = promisify(execFile);
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true, maxRetries: 10 }); });
async function repo() {
  const root = await mkdtemp(join(tmpdir(), 'cezar-worktree-lock-'));
  roots.push(root);
  await exec('git', ['init', '-q', '-b', 'main', root]);
  await exec('git', ['-c', 'user.name=test', '-c', 'user.email=test@local', 'commit', '--allow-empty', '-qm', 'base'], { cwd: root });
  return root;
}

it('serializes concurrent creations through linked checkouts and symlink aliases', async () => {
  const root = await repo();
  const linked = join(root, 'linked');
  await exec('git', ['worktree', 'add', '-qb', 'linked', linked], { cwd: root });
  const alias = join(root, 'alias');
  await symlink(linked, alias, process.platform === 'win32' ? 'junction' : 'dir');
  const results = await Promise.all(Array.from({ length: 8 }, (_, i) => createWorktree([root, linked, alias][i % 3]!, `task000${i}-parallel`, 'main')));
  expect(new Set(results.map(result => result.path)).size).toBe(8);
  for (const result of results) {
    expect((await exec('git', ['branch', '--show-current'], { cwd: result.path })).stdout.trim()).toBe(result.branch);
  }
}, 15_000);

it('does not block an unrelated Git common directory', async () => {
  const first = await repo();
  const second = await repo();
  let release!: () => void;
  let entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const held = withWorktreeMutation(first, async () => { entered(); await new Promise<void>(resolve => { release = resolve; }); });
  await started;
  try {
    const result = await createWorktree(second, 'separate0000', 'main');
    expect(result.branch).toBe('cez/separate');
  } finally { release(); await held; }
});

it('surfaces genuine Git add failures and releases the lock for the next caller', async () => {
  const root = await repo();
  await expect(createWorktree(root, 'invalid00000', 'missing-ref')).rejects.toThrow(/git worktree add failed:.*invalid reference/s);
  await expect(createWorktree(root, 'valid0000000', 'main')).resolves.toMatchObject({ branch: 'cez/valid000' });
});

it('fails creation closed and preserves cleanup targets when coordination is unavailable', async () => {
  const root = await repo();
  const result = await createWorktree(root, 'preserve0000', 'main');
  const claims = join(root, '.git/cezar-worktree-mutations');
  await rm(claims, { recursive: true });
  await writeFile(claims, 'unavailable directory');
  await expect(createWorktree(root, 'another00000', 'main')).rejects.toThrow('coordination failed');
  await removeWorktree(root, result.path, result.branch);
  await expect(pruneOrphans(root, new Set())).resolves.toEqual([]);
  expect((await exec('git', ['branch', '--show-current'], { cwd: result.path })).stdout.trim()).toBe(result.branch);
});

it('recovers a dead keeper claim without manual state repair', async () => {
  const root = await repo();
  await expect(withWorktreeMutation(root, async git => {
    const directory = join(root, '.git/cezar-worktree-mutations');
    const [name] = await readdir(directory);
    const claim = JSON.parse(await readFile(join(directory, name!), 'utf8')) as { pid: number };
    process.kill(claim.pid, 'SIGKILL');
    // A command submitted to a lost keeper must fail, never run uncoordinated.
    await git(root, ['status', '--porcelain']);
  })).rejects.toThrow();
  await expect(createWorktree(root, 'recovery0000', 'main')).resolves.toMatchObject({ branch: 'cez/recovery' });
  expect(await readdir(join(root, '.git/cezar-worktree-mutations'))).toEqual([]);
});

it('reports failure to spawn the keeper instead of hanging cleanup', async () => {
  const root = await repo();
  const original = process.execPath;
  process.execPath = join(root, 'missing-node');
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await expect(Promise.race([
      createWorktree(root, 'spawn0000000', 'main'),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('keeper failure was not reported')), 2000); }),
    ])).rejects.toThrow(/ENOENT/);
  } finally { clearTimeout(timer); process.execPath = original; }
}, 5000);

it('can launch the source helper when the caller runs outside the repository', async () => {
  const root = await repo();
  const source = new URL('./git-worktree.ts', import.meta.url).href;
  const loader = import.meta.resolve('tsx');
  const script = `const { createWorktree } = await import(${JSON.stringify(source)}); await createWorktree(${JSON.stringify(root)}, 'outside00000', 'main');`;
  await expect(exec(process.execPath, ['--import', loader, '--input-type=module', '-e', script], { cwd: root })).resolves.toMatchObject({ stderr: '' });
});

it('does not reclaim a Windows keeper that became busy between reading its claim and dying', async () => {
  const root = await repo();
  const path = join(root, 'claim.json');
  await writeFile(path, JSON.stringify({ pid: 12345, ticket: 1, gitRunning: false }));
  await expect(readMutationClaim(path, 'win32', () => {
    writeFileSync(path, JSON.stringify({ pid: 12345, ticket: 1, gitRunning: true }));
    throw Object.assign(new Error('dead keeper'), { code: 'ESRCH' });
  })).rejects.toThrow('cannot prove');
  expect(JSON.parse(await readFile(path, 'utf8')).gitRunning).toBe(true);
});

it('recovers an idle dead Windows keeper after confirming its final claim', async () => {
  const root = await repo();
  const path = join(root, 'claim.json');
  await writeFile(path, JSON.stringify({ pid: 12345, ticket: 1, gitRunning: false }));
  await expect(readMutationClaim(path, 'win32', () => {
    throw Object.assign(new Error('dead keeper'), { code: 'ESRCH' });
  })).resolves.toBeUndefined();
  await expect(readFile(path)).rejects.toMatchObject({ code: 'ENOENT' });
});

it.each(['win32', 'linux'] as const)('retains claims when the %s process probe is inconclusive', async platform => {
  const root = await repo();
  const path = join(root, 'claim.json');
  const claim = { pid: 12345, ticket: 1, gitRunning: false };
  await writeFile(path, JSON.stringify(claim));
  await expect(readMutationClaim(path, platform, () => {
    throw Object.assign(new Error('not permitted'), { code: 'EPERM' });
  })).resolves.toEqual(claim);
  expect(JSON.parse(await readFile(path, 'utf8'))).toEqual(claim);
});

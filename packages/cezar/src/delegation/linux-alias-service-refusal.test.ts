import { expect, it, vi } from 'vitest';

const f = vi.hoisted(() => {
  const workerId = 'b12898b9-8bf7-4c24-85e3-5ecf2b4d469e', parentId = '91c3ce3c-ec49-4baa-8f17-76e2514c0080';
  const generation = 'a32898b9-8bf7-4c24-85e3-5ecf2b4d469e', resourceId = 'ff04f7e5-25b8-4f57-9050-895fe33fc6e6';
  const boot = 'deffb118-419a-4586-af9e-748667bd30c8', repo = '/virtual/repo', path = `/virtual/repo/.ai/cezar/worktrees/${workerId}`;
  const sha = 'a'.repeat(40), common = '/virtual/repo/.git', gitDir = '/virtual/repo/.git/worktrees/worker';
  const workspace = { ownerRunId: workerId, resourceId, kind: 'owned-isolated', path, branch: `cez/${workerId.slice(0, 8)}`, baselineSha: sha };
  const receipt = `${common}/cezar-owned-workspaces/${resourceId}.json`, marker = `${gitDir}/cezar-owned-resource`;
  const mounts = Array.from({ length: 10000 }, (_, i) => `${i + 2} 1 8:1 /other /mount${i} rw - ext4 /dev/root rw`).join('\n') + '\n';
  return { workerId, parentId, generation, resourceId, boot, repo, path, sha, common, gitDir, workspace, receipt, marker, mounts,
    rootMount: '1 0 8:1 / / rw - ext4 /dev/root rw\n', files: new Map<number, { data: Buffer; offset: number }>(), nextFd: 10,
    removed: [] as string[], gitMutations: [] as string[], keeperCalls: [] as { cwd: string; args: string[] }[], budgetFailure: '' };
});
const missing = () => Object.assign(new Error('missing'), { code: 'ENOENT' });
vi.mock('node:fs', async original => {
  const actual = await original<typeof import('node:fs')>();
  const stat = (big = false, file = false) => ({ dev: big ? 2049n : 2049, ino: big ? 123n : 123, mode: 0o100600, size: 1,
    birthtimeMs: 1, mtimeMs: 1, ctimeMs: 1, isDirectory: () => !file, isSymbolicLink: () => false, isFile: () => file });
  const exists = (path: string) => path === '/' || path === '/tmp' || path === '/virtual' || path === f.repo || path === f.path ||
    path.startsWith(`${f.repo}/.ai`) && !path.includes('/tmp/') && !path.includes('/t/') || path.startsWith('/proc/');
  return { ...actual, lstatSync: (path: string, options?: { bigint?: boolean }) => { if (!exists(path)) throw missing(); return stat(!!options?.bigint); },
    statSync: (_path: string, options?: { bigint?: boolean }) => stat(!!options?.bigint), realpathSync: (path: string) => path,
    readFileSync: (path: string) => { if (path === '/proc/self/mountinfo') return f.rootMount; throw missing(); },
    existsSync: (path: string) => exists(path), readdirSync: () => [],
    readlinkSync: (path: string) => path.endsWith('/ns/mnt') ? 'mnt' : path.endsWith('/root') ? '/' : '/unrelated',
    opendirSync: (path: string) => { const names = path === '/proc' ? ['101', '102', '103', '104', '105', '106'] : path === `/proc/${process.pid}/task` ? [String(process.pid)] : path.match(/^\/proc\/\d+\/task$/) ? [path.split('/')[2]!] : []; let i = 0;
      return { readSync: () => i < names.length ? { name: names[i++] } : null, closeSync: () => {} }; },
    openSync: (path: string) => {
      if (/^\/proc\/\d+$/.test(path)) return 7;
      if (!path.startsWith('/proc/')) throw missing();
      const content = path.endsWith('/mountinfo') ? (path.includes('/fd/7/') ? f.mounts : f.rootMount)
        : path.endsWith('/maps') ? '1-2 r--p 0 08:01 42 /unrelated/file\n' : '';
      const fd = f.nextFd++; f.files.set(fd, { data: Buffer.from(content), offset: 0 }); return fd;
    },
    fstatSync: (_fd: number, options?: { bigint?: boolean }) => stat(!!options?.bigint),
    readSync: (fd: number, buffer: Buffer, offset: number, length: number) => { const file = f.files.get(fd)!; const count = Math.min(length, file.data.length - file.offset); file.data.copy(buffer, offset, file.offset, file.offset + count); file.offset += count; return count; },
    closeSync: (fd: number) => { f.files.delete(fd); }, rmSync: (path: string) => { f.removed.push(path); }, unlinkSync: (path: string) => { f.removed.push(path); },
  };
});
vi.mock('node:fs/promises', async original => {
  const actual = await original<typeof import('node:fs/promises')>();
  const info = (file = false, size = 1) => ({ dev: 2049, ino: 123, mode: file ? 0o100600 : 0o40700, size, isDirectory: () => !file, isFile: () => file, isSymbolicLink: () => false });
  const content = (path: string) => path === f.receipt ? JSON.stringify({ workspace: f.workspace, gitDir: f.gitDir }) : path === f.marker ? f.resourceId : undefined;
  const lstat = async (path: string) => { const text = content(path); if (text !== undefined) return info(true, text.length); if (path.includes('.cleanup.json') || path.includes('/tmp/') || path.includes('/t/')) throw missing(); return info(); };
  return { ...actual, lstat, realpath: async (path: string) => path, chmod: async () => {}, readdir: async () => { throw missing(); },
    open: async (path: string) => { const text = content(path); return { fd: 9, stat: async () => info(text !== undefined, text?.length), close: async () => {},
      read: async (buffer: Buffer) => { const bytes = Buffer.from(text ?? ''); bytes.copy(buffer); return { bytesRead: bytes.length, buffer }; } }; },
    rm: async (path: string) => { f.removed.push(path); }, unlink: async (path: string) => { f.removed.push(path); },
  };
});
vi.mock('node:child_process', async original => {
  const actual = await original<typeof import('node:child_process')>();
  return { ...actual, execFile: (_cmd: string, args: string[], options: { cwd: string }, callback: (err: null, out: string, stderr: string) => void) => {
    const output = args.includes('--git-common-dir') ? f.common : args.includes('--absolute-git-dir') ? f.gitDir : args.includes('--show-toplevel') ? f.path
      : args.includes('--porcelain') ? `worktree ${f.path}\0` : f.sha;
    if (args.includes('remove') || args.includes('delete')) f.gitMutations.push(args.join(' '));
    callback(null, output, '');
  }, spawn: () => { throw Error('unexpected process spawn'); }, spawnSync: () => { throw Error('unexpected process spawn'); } };
});
// The mutation keeper is a process boundary; this fake supplies its Git IPC response.
vi.mock('../git-worktree-lock.ts', async original => ({ ...await original<typeof import('../git-worktree-lock.ts')>(),
  withWorktreeMutation: async (_root: string, operation: (git: (cwd: string, args: string[]) => Promise<unknown>) => Promise<unknown>) => operation(async (cwd, args) => {
    f.keeperCalls.push({ cwd, args: [...args] });
    f.gitMutations.push(`${cwd}: ${args.join(' ')}`);
    throw new Error('unexpected keeper Git invocation');
  }) }));
vi.mock('../detached-process.ts', async original => ({ ...await original<typeof import('../detached-process.ts')>(), linuxBootId: () => f.boot, processStartToken: () => `${f.boot}:100` }));

import { RUN_STATUS } from '@open-mercato/cezar-contract/test-factories.testkit';
import { DelegationService } from './service.ts';
import { AliasWorkBudget } from './linux-alias-model.ts';
import { agentTmpDirLocations } from '../runs/agent-tmpdir.ts';
import { withWorktreeMutation } from '../git-worktree-lock.ts';
import type { WorkerAliasRetention } from '../runs/worker-execution.ts';

it('records and refuses both keeper deletion commands', async () => {
  for (const args of [['worktree', 'remove', f.path], ['update-ref', '-d', `refs/heads/${f.workspace.branch}`]]) {
    await expect(withWorktreeMutation(f.repo, git => git(f.repo, args))).rejects.toThrow('unexpected keeper Git invocation');
    expect(f.keeperCalls.at(-1)).toEqual({ cwd: f.repo, args });
    expect(f.gitMutations.at(-1)).toBe(`${f.repo}: ${args.join(' ')}`);
  }
  f.keeperCalls.length = 0; f.gitMutations.length = 0;
});

it('retains service resources and prior pending when real preprocessing exhausts', async () => {
  const roots = [f.path, ...agentTmpDirLocations(`${f.repo}/.ai/cezar`, f.workerId)];
  let pending: WorkerAliasRetention | undefined = { generation: f.generation, resourceId: f.resourceId, bootId: f.boot,
    roots: roots.map((path, i) => ({ path, identity: i ? null : { dev: '8:1', ino: '123' } })), processes: [], pending: [{ pid: 101, start: '100' }] };
  let worker = { id: f.workerId, status: RUN_STATUS.review, delegation: { role: 'worker', parentRunId: f.parentId, workspace: f.workspace } };
  const store = { getRun: (id: string) => id === f.workerId ? worker : undefined, readWorkerExecution: () => ({ generation: f.generation, phase: 'complete', aliasRetention: pending }),
    readWorkerProcesses: () => 'absent', readWorkerResult: () => undefined, readEventsAsync: async () => [],
    commitDelegation: (updates: { delegation: typeof worker.delegation }[]) => { worker = { ...worker, delegation: updates[0]!.delegation }; },
    commitWorkerResult: () => {}, commitWorkerAliasRetention: (_id: string, _gen: string, _resource: string, value: WorkerAliasRetention | undefined) => { pending = value; } };
  const manager = { requestActiveWorkerStop: vi.fn(), requestWorkerStop: vi.fn(), awaitRunTermination: vi.fn() };
  const project = { id: 'project', root: f.repo, store, manager };
  const service = new DelegationService();
  const internal = service as unknown as { projects: Map<string, unknown>; commonDirs: Map<string, Promise<string>>; destroyAttempt: (p: unknown, id: string, check: () => unknown, mode: string) => Promise<{ state: string; remaining: string[]; error?: string }> };
  internal.projects.set(project.id, project); internal.commonDirs.set(project.id, Promise.resolve(f.common));
  const kill = vi.spyOn(process, 'kill').mockImplementation(() => true);
  const spend = AliasWorkBudget.prototype.spend;
  let exhaustedAt = '';
  const charge = vi.spyOn(AliasWorkBudget.prototype, 'spend').mockImplementation(function (this: AliasWorkBudget, amount = 1) {
    try { return spend.call(this, amount); } catch (error) { exhaustedAt ||= new Error().stack ?? ''; throw error; }
  });
  try {
    const result = await internal.destroyAttempt(project, f.workerId, () => worker, 'manual');
    expect(result.error).toContain('alias scan work exceeds bounds');
    expect(result).toMatchObject({ state: 'incomplete', remaining: ['process', 'worktree', 'branch'] });
    expect(kill).not.toHaveBeenCalled(); expect(f.removed).toEqual([]); expect(f.gitMutations).toEqual([]); expect(f.keeperCalls).toEqual([]);
    expect(pending?.pending).toEqual([{ pid: 101, start: '100' }]); expect(manager.requestWorkerStop).not.toHaveBeenCalled();
    expect(exhaustedAt).toContain('indexAliasMounts');
    const reopened = new DelegationService() as unknown as typeof internal;
    reopened.projects.set(project.id, project); reopened.commonDirs.set(project.id, Promise.resolve(f.common));
    const retry = await reopened.destroyAttempt(project, f.workerId, () => worker, 'manual');
    expect(retry).toMatchObject({ state: 'incomplete', remaining: ['process', 'worktree', 'branch'] });
    expect(pending?.pending).toEqual([{ pid: 101, start: '100' }]);
    expect(kill).not.toHaveBeenCalled(); expect(f.removed).toEqual([]); expect(f.gitMutations).toEqual([]); expect(f.keeperCalls).toEqual([]);
  } finally { charge.mockRestore(); kill.mockRestore(); }
});

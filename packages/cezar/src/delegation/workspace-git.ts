/** Owned-workspace Git primitives: the lowest layer under the workspace record, create/check and removal modules. */
import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { open, realpath } from 'node:fs/promises';
import { join, normalize } from 'node:path';
import type { WorkerWorkspace } from '@open-mercato/cezar-contract';

// Git for Windows emits forward slashes even for native absolute paths.
export function worktreeEntries(listed: string): string[] {
  return listed.split('\0').map(entry => entry.startsWith('worktree ') ? `worktree ${normalize(entry.slice(9))}` : entry);
}

export async function branchLog(repoRoot: string, workspace: WorkerWorkspace) {
  const common = await gitCommonDir(repoRoot);
  const path = join(common, 'logs/refs/heads', workspace.branch);
  if (await realpath(path) !== path) throw new Error('Branch reflog redirected');
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size > 4 * 1024 * 1024) throw new Error('Branch reflog unavailable');
    const content = await file.readFile();
    if (content.length !== info.size) throw new Error('Branch reflog changed while reading');
    return { file: { dev: info.dev, ino: info.ino, birthtimeMs: info.birthtimeMs }, content };
  } finally { await file.close(); }
}

export function git(cwd: string, args: string[], index?: string, maxBuffer = 32 * 1024 * 1024) {
  return new Promise<{ ok: boolean; stdout: string; overflow: boolean }>((done) => {
    execFile('git', args, {
      cwd, encoding: 'utf8', timeout: 30_000, maxBuffer,
      ...(index ? { env: { ...process.env, GIT_INDEX_FILE: index } } : {}),
    }, (error, stdout) => done({
      ok: !error, stdout: stdout ?? '', overflow: error?.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER',
    }));
  });
}
export async function checkedGit(cwd: string, args: string[], index?: string): Promise<string> {
  const result = await git(cwd, args, index);
  if (!result.ok) throw new Error(`Owned workspace Git ${args[0]} failed`);
  return result.stdout.trim();
}
/** The repository's shared Git directory (where refs, reflogs and linked-worktree admin dirs live), resolved. */
export async function gitCommonDir(cwd: string): Promise<string> {
  return realpath(await checkedGit(cwd, ['rev-parse', '--path-format=absolute', '--git-common-dir']));
}
export async function liveGitDir(repoRoot: string, workspace: WorkerWorkspace): Promise<string> {
  if (await realpath(workspace.path) !== workspace.path) throw new Error('Owned workspace path is redirected');
  const rootCommon = await gitCommonDir(repoRoot);
  if (await gitCommonDir(workspace.path) !== rootCommon) throw new Error('Owned workspace repository changed');
  const top = await realpath(await checkedGit(workspace.path, ['rev-parse', '--show-toplevel']));
  if (top !== workspace.path) throw new Error('Owned workspace is no longer a Git worktree');
  const listed = await checkedGit(repoRoot, ['worktree', 'list', '--porcelain', '-z']);
  if (!worktreeEntries(listed).includes(`worktree ${workspace.path}`)) throw new Error('Owned workspace registration missing');
  const gitDir = await realpath(await checkedGit(workspace.path, ['rev-parse', '--absolute-git-dir']));
  // Linked worktrees have a distinct administrative directory, never the main index.
  if (gitDir === rootCommon) throw new Error('Owned workspace points at the main repository');
  return gitDir;
}

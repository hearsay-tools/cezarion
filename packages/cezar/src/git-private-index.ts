import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { git, type GitResult } from './git-command.ts';
import { copyGitIndex } from './git-index-copy.ts';
import { fallbackProjectWriteError } from './project-paths.ts';

export type LiveIndexCheck = () => string | undefined;
export type DiffRefusal = { error: string };

export type IndexGit = (args: string[]) => Promise<GitResult>;

/**
 * Read through a private index copy. Try OS temp, then the Git directory; if neither is
 * writable, check beforeLiveIndex before the real-index fallback. Always remove scratch state.
 */
export async function withPrivateIndex<T, Refusal = never>(
  worktreePath: string,
  read: (git: IndexGit) => Promise<T>,
  beforeLiveIndex?: () => Refusal | undefined,
): Promise<T | Refusal> {
  const real = await git(worktreePath, ['rev-parse', '--path-format=absolute', '--git-path', 'index']);
  const realIndex = real.ok ? real.stdout.trim() : '';
  let scratch: string | undefined;
  for (const parent of [tmpdir(), ...(realIndex ? [dirname(realIndex)] : [])]) {
    try {
      scratch = await mkdtemp(join(parent, 'cez-diff-index-'));
      break;
    } catch { /* Not writable: try the next location. */ }
  }
  if (!scratch) {
    const blocked = beforeLiveIndex?.();
    if (blocked !== undefined) return blocked;
    const refusal = fallbackProjectWriteError(worktreePath);
    if (refusal) throw new Error(refusal);
    return read((args) => git(worktreePath, args));
  }
  try {
    const index = join(scratch, 'index');
    const indexed: IndexGit = (args) => git(worktreePath, args, { env: { GIT_INDEX_FILE: index } });
    let seeded = false;
    if (realIndex) {
      try { await copyGitIndex(realIndex, index); seeded = true; } catch { /* No index yet: seed from HEAD. */ }
    }
    if (!seeded) await indexed(['read-tree', 'HEAD']);
    return await read(indexed);
  } finally {
    await rm(scratch, { recursive: true, force: true }).catch(() => undefined);
  }
}

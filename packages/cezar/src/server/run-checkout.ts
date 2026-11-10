import { existsSync } from 'node:fs';
import type { RunRecord } from '../runs/store.ts';

export const worktreeOf = (run: RunRecord): string | null =>
  run.worktreePath && existsSync(run.worktreePath) ? run.worktreePath : null;
export const workingDirectoryOf = (run: RunRecord, repoRoot: string): string | null =>
  run.worktree === false
    ? repoRoot
    : worktreeOf(run);
export const NO_WORKTREE = 'no worktree — this task ran directly in the repo working tree';

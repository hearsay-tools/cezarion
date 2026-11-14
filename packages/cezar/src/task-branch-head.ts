import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { shellQuote } from './core/shell-env.ts';

const run = promisify(execFile);

async function git(cwd: string, args: string[]): Promise<{ code: number; stdout: string }> {
  try {
    const { stdout } = await run('git', args, { cwd, encoding: 'utf8', timeout: 30_000 });
    return { code: 0, stdout: String(stdout).trim() };
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    return { code: typeof code === 'number' ? code : -1, stdout: '' };
  }
}

/**
 * The refusal for a task or worker worktree whose HEAD is not on the branch the task owns, or
 * `undefined` while it is. Worker destroy and draft-PR publish both refuse with it and change
 * nothing: the agent decides where its work belongs (hearsay-tools/squawk#910,
 * hearsay-tools/squawk#1110). A HEAD that cannot be read refuses too.
 */
export async function headLeftTaskBranch(worktree: string, branch: string): Promise<string | undefined> {
  const head = await git(worktree, ['symbolic-ref', '-q', 'HEAD']);
  if (head.code === 0 && head.stdout === `refs/heads/${branch}`) return undefined;
  const fix = `Keep the work you need on ${branch}, run git -C ${shellQuote(worktree)} switch ${shellQuote(branch)}, then retry.`;
  if (head.code === 0) return `Worktree HEAD is on ${head.stdout.replace(/^refs\/heads\//, '')}, not on its task branch ${branch}. ${fix}`;
  // Exit 1 under -q is a detached HEAD; anything else is a failed read.
  const sha = head.code === 1 ? await git(worktree, ['rev-parse', '--short', 'HEAD']) : undefined;
  if (sha?.code === 0) return `Worktree HEAD is detached at ${sha.stdout}, not on its task branch ${branch}. ${fix}`;
  return `Worktree HEAD in ${worktree} could not be read, so it may not be on its task branch ${branch}. Check the worktree, then retry.`;
}

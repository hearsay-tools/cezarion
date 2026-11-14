import { productEnv } from '../core/product-env.ts';
import { execFile } from 'node:child_process';
import { gitEnv } from '../git-command.ts';
import { promisify } from 'node:util';
import type { RepoPullBranchesResponse, RepoPullConfirmation, RepoPullError, RepoPullInput, RepoPullResponse } from '@open-mercato/cezar-contract';
import { isSafeGitRef } from '../git-refs.ts';

const exec = promisify(execFile);
const mutating = new Set<string>();

/** Shared with branch switching: a cockpit action must not change HEAD during a pull. */
export function claimRepoGitMutation(root: string): (() => void) | null {
  if (mutating.has(root)) return null;
  mutating.add(root);
  return () => { mutating.delete(root); };
}

async function git(root: string, args: string[]): Promise<string> {
  const { stdout } = await exec('git', args, {
    cwd: root,
    encoding: 'utf8',
    timeout: 60_000,
    maxBuffer: 1024 * 1024,
    env: gitEnv({ GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never', GIT_MERGE_AUTOEDIT: 'no', GIT_EDITOR: 'true' }),
  });
  return stdout.trim();
}

function reason(error: unknown): string {
  const failure = error as { stderr?: string; killed?: boolean; message?: string };
  if (failure.killed) return 'Git pull timed out. Check the repository and remote, then try again.';
  const lines = (failure.stderr || failure.message || 'Git operation failed').split(/[\r\n]+/).map((line) => line.trim()).filter(Boolean);
  // Fetch progress often precedes the actual refusal. Prefer Git's error/fatal line.
  return (lines.find((line) => /^(fatal|error):/i.test(line)) ?? lines[0] ?? 'Git operation failed').slice(0, 500);
}

export async function localPullBranches(root: string): Promise<RepoPullBranchesResponse | Pick<RepoPullError, 'error'>> {
  try {
    const out = await git(root, ['for-each-ref', '--format=%(refname:strip=2)', 'refs/heads/']);
    return { branches: out ? out.split('\n').sort((a, b) => a.localeCompare(b)) : [] };
  } catch (error) {
    return { error: reason(error) };
  }
}

type PullResult = { ok: true; value: RepoPullResponse } | { ok: false; value: RepoPullError };

/**
 * Pull only in this project's checkout. All risk checks precede checkout/fetch; confirmation
 * never forces a checkout, stashes work, or overrides Git's refusal to overwrite local files.
 * A different chosen branch remains checked out if the subsequent pull fails.
 */
export async function pullRepoCheckout(
  root: string,
  input: RepoPullInput,
  baseBranch: string | null | undefined,
  hasActiveRuns: () => boolean,
): Promise<PullResult> {
  const release = claimRepoGitMutation(root);
  if (!release) return { ok: false, value: { error: 'A Git operation is already in progress for this repository.' } };
  try {
    const current = await git(root, ['symbolic-ref', '--quiet', '--short', 'HEAD']).catch(() => '');
    const branch = input.branch ?? baseBranch ?? current;
    if (!isSafeGitRef(branch) || /[\r\n\0]/.test(branch)) {
      return { ok: false, value: { error: 'Choose a valid local branch to pull.' } };
    }
    // Full refs prevent checkout shorthand (@{-1}) from silently selecting another branch.
    await git(root, ['check-ref-format', `refs/heads/${branch}`]);
    try {
      await git(root, ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`]);
    } catch {
      return { ok: false, value: { error: `Local branch does not exist: ${branch}` } };
    }
    if (!(await git(root, ['remote']))) {
      return { ok: false, value: { error: 'No remote configured. Add a remote before pulling.' } };
    }
    const upstream = await git(root, ['for-each-ref', '--format=%(upstream)', `refs/heads/${branch}`]);
    if (!upstream) {
      return { ok: false, value: { error: `No upstream configured for ${branch}. Set its tracking branch before pulling.` } };
    }
    const dirty = !!(await git(root, ['status', '--porcelain', '--untracked-files=all', '--ignore-submodules=none']));
    const risks: RepoPullConfirmation['risks'] = [];
    if (hasActiveRuns()) risks.push('active_runs');
    if (dirty) risks.push('dirty_tree');
    if (risks.length && !input.confirm) {
      return { ok: false, value: { error: 'Confirm the repository risks before pulling.', branch, risks } };
    }
    if (productEnv('DRY_RUN') === '1') {
      return { ok: true, value: { branch, pulled: true, summary: 'Dry run: pull simulated.' } };
    }
    if (branch !== current) await git(root, ['switch', '--no-guess', branch]);
    // The CLI flag overrides pull.autoStash as well as merge/rebase.autoStash on every
    // supported Git version. Preserve the repo's merge/ff/rebase policy, never stash edits.
    const output = await git(root, ['pull', '--no-autostash']);
    return { ok: true, value: { branch, pulled: true, summary: output.split(/[\r\n]+/)[0]?.slice(0, 500) || 'Pull completed.' } };
  } catch (error) {
    return { ok: false, value: { error: reason(error) } };
  } finally {
    release();
  }
}

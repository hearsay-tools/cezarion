import { inspectGeneration } from './delegation/process-liveness.ts';
import { execFile } from 'node:child_process';
import { autosaveGit, type AutosaveOptions } from './autosave-git.ts';
import { workerWorkspaceSchema } from '@open-mercato/cezar-contract/delegation';
import { existsSync, realpathSync, type Dirent } from 'node:fs';
import { lstat, mkdir, mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { resolveTaskDiffBase } from './git-diff-base.ts';
import { copyGitIndex } from './git-index-copy.ts';
import { isSafeGitRef } from './git-refs.ts';
import { withWorktreeMutation, type WorktreeGit } from './git-worktree-lock.ts';

/**
 * Git worktree per task (spec 006). Each run gets its own branch
 * `cez/<id8>` checked out into `.ai/cezar/worktrees/<runId>` so agents never
 * touch the user's working tree. Pattern ported from github-janitor's
 * `git.ts` (createWorktree / autosaveCommit), minus the bare clone — we're
 * already inside a working copy. Everything degrades: helpers never throw
 * except `createWorktree`, whose failure the caller turns into a note.
 */

/** Repo-relative home of all task worktrees (gitignored via .ai/cezar/.gitignore). */
export const WORKTREES_DIR = '.ai/cezar/worktrees';

export const DIFF_CAP = 400_000;

interface GitResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}

interface RegisteredWorktree {
  path: string;
  branch?: string;
}

/** Run git, never throw — degradation is the caller's policy. */
function git(cwd: string, args: string[], timeout?: number, env?: NodeJS.ProcessEnv): Promise<GitResult> {
  return new Promise((resolve) => {
    execFile(
      'git',
      args,
      { cwd, maxBuffer: 32 * 1024 * 1024, encoding: 'utf8', timeout, ...(env ? { env } : {}) },
      (err, stdout, stderr) => resolve({ ok: !err, stdout: stdout ?? '', stderr: stderr ?? '' }),
    );
  });
}

export function branchFor(runId: string): string {
  return `cez/${runId.slice(0, 8)}`;
}

/**
 * Resolve a worktree base without throwing. Prefer local only when it contains origin’s base;
 * otherwise prefer origin. Keep this rule aligned with freshestBaseRef.
 */
export async function resolveBaseRef(repoRoot: string, base: string): Promise<string | null> {
  if (!isSafeGitRef(base)) return null;
  const verify = (ref: string) =>
    git(repoRoot, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]).then((r) => r.ok);
  const [hasLocal, hasRemote] = await Promise.all([verify(base), verify(`origin/${base}`)]);
  if (hasLocal && hasRemote) {
    // `--is-ancestor origin/<base> <base>` succeeds iff local is equal-or-ahead.
    const localCurrent = await git(repoRoot, ['merge-base', '--is-ancestor', `origin/${base}`, base]);
    return localCurrent.ok ? base : `origin/${base}`;
  }
  if (hasLocal) return base;
  if (hasRemote) return `origin/${base}`;
  return null;
}

export function worktreePathFor(repoRoot: string, runId: string): string {
  return join(repoRoot, WORKTREES_DIR, runId);
}

export interface WorktreeInfo {
  path: string;
  branch: string;
  /** Branch name the worktree was forked from (commit sha when HEAD was detached). */
  baseBranch: string;
}

/** Parse `git worktree list --porcelain` without assuming paths contain no spaces. */
async function registeredWorktrees(repoRoot: string): Promise<RegisteredWorktree[]> {
  const res = await git(repoRoot, ['worktree', 'list', '--porcelain']);
  if (!res.ok) return [];
  const worktrees: RegisteredWorktree[] = [];
  let current: RegisteredWorktree | undefined;
  for (const line of res.stdout.split('\n')) {
    if (line.startsWith('worktree ')) {
      if (current) worktrees.push(current);
      current = { path: line.slice('worktree '.length) };
    } else if (current && line.startsWith('branch ')) {
      current.branch = line.slice('branch '.length);
    } else if (!line && current) {
      worktrees.push(current);
      current = undefined;
    }
  }
  if (current) worktrees.push(current);
  return worktrees;
}

function worktreeInfo(path: string, branch: string, baseBranch: string): WorktreeInfo {
  return { path, branch, baseBranch };
}

/** Git canonicalizes symlinked path prefixes (macOS `/var` → `/private/var`). */
function canonicalPath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

/**
 * Establish the task worktree idempotently. Reuse registered worktrees or surviving task
 * branches; never delete a non-empty unregistered path. New branches use --no-track.
 */
export async function createWorktree(
  repoRoot: string,
  runId: string,
  baseBranch: string,
  options: { freshOnly?: boolean } = {},
): Promise<WorktreeInfo> {
  return withWorktreeMutation(repoRoot, git => createWorktreeLocked(repoRoot, runId, baseBranch, options, git));
}

async function createWorktreeLocked(
  repoRoot: string, runId: string, baseBranch: string,
  options: { freshOnly?: boolean }, git: WorktreeGit,
): Promise<WorktreeInfo> {
  let base = baseBranch;
  if (!base || base === 'HEAD') {
    // Detached HEAD — pin the base to the current commit so the record and
    // later diffs stay meaningful.
    const head = await git(repoRoot, ['rev-parse', 'HEAD']);
    if (!head.ok) throw new Error(`git rev-parse HEAD failed: ${head.stderr.trim()}`);
    base = head.stdout.trim();
  }
  // Dash-guard (#431): `base` is spliced in as a positional git operand; an
  // option-like value would be argument injection.
  if (!isSafeGitRef(base)) throw new Error(`refusing option-like base ref: ${base}`);
  const branch = branchFor(runId);
  const absolutePath = join(canonicalPath(repoRoot), WORKTREES_DIR, runId);
  const branchRef = `refs/heads/${branch}`;

  if (options.freshOnly) {
    // Owned workers cannot inherit the legacy adoption/prune behavior. Even a stale
    // registration or an empty directory is a collision, not proof of ownership.
    const listed = await git(repoRoot, ['worktree', 'list', '--porcelain', '-z'], 30_000);
    if (!listed.ok) throw new Error('cannot verify existing worktree registrations');
    const paths = listed.stdout.split('\0').filter((entry) => entry.startsWith('worktree '));
    if (paths.some((entry) => canonicalPath(entry.slice(9)) === canonicalPath(absolutePath))) {
      throw new Error('owned worktree registration already exists');
    }
    const pathExists = await lstat(absolutePath).then(() => true, (err: NodeJS.ErrnoException) => {
      if (err.code === 'ENOENT') return false;
      throw err;
    });
    const branchExists = await git(repoRoot, ['show-ref', '--verify', '--quiet', branchRef], 30_000);
    if (pathExists || branchExists.ok) throw new Error('owned worktree path or branch already exists');
    await mkdir(dirname(absolutePath), { recursive: true });
    // Reserve the previously absent path exclusively; Git accepts our empty directory.
    await mkdir(absolutePath);
    const created = await git(repoRoot, ['worktree', 'add', '--no-track', '-b', branch, absolutePath, base], 30_000);
    if (!created.ok) throw new Error(`git worktree add failed: ${created.stderr.trim()}`);
    return worktreeInfo(absolutePath, branch, base);
  }

  const protection = await ownedCleanupProtection(repoRoot);
  if (protection.uncertain || protection.paths.has(absolutePath) || protection.branches.has(branch)) throw new Error('Owned worktree requires verified provisioning');
  // A missing directory can leave stale administrative metadata behind.
  // Prune first so the checks below describe the filesystem as it exists now.
  if (protection.paths.size === 0) await git(repoRoot, ['worktree', 'prune']);
  const canonicalTarget = canonicalPath(absolutePath);
  let registered = await registeredWorktrees(repoRoot);
  let atPath = registered.find((item) => canonicalPath(item.path) === canonicalTarget);
  if (atPath) {
    if (atPath.branch !== branchRef) {
      throw new Error(
        `managed worktree path is registered to ${atPath.branch ?? 'a detached HEAD'}, expected ${branchRef}`,
      );
    }
    return worktreeInfo(atPath.path, branch, base);
  }

  // If the directory survived but its administrative entry did not, let Git
  // repair it. This is non-destructive; an unrepairable non-empty directory is
  // preserved and reported instead of being recursively removed.
  if (existsSync(absolutePath)) {
    await git(repoRoot, ['worktree', 'repair', absolutePath]);
    registered = await registeredWorktrees(repoRoot);
    atPath = registered.find((item) => canonicalPath(item.path) === canonicalTarget);
    if (atPath) {
      if (atPath.branch !== branchRef) {
        throw new Error(
          `managed worktree path is registered to ${atPath.branch ?? 'a detached HEAD'}, expected ${branchRef}`,
        );
      }
      return worktreeInfo(atPath.path, branch, base);
    }
    const entries = await readdir(absolutePath).catch(() => ['unreadable']);
    if (entries.length > 0) {
      throw new Error(`managed worktree path already exists and could not be repaired: ${absolutePath}`);
    }
  }

  const branchExists = await git(repoRoot, ['show-ref', '--verify', '--quiet', branchRef]);
  if (branchExists.ok) {
    // The task branch may still be checked out after its directory was moved.
    // Reuse only a path whose basename is the full run id; a same-prefix UUID
    // collision must fail rather than point two tasks at one worktree.
    const byBranch = registered.find((item) => item.branch === branchRef);
    if (byBranch) {
      if (basename(byBranch.path) !== runId) {
        throw new Error(`task branch ${branch} is already checked out at ${byBranch.path}`);
      }
      return worktreeInfo(byBranch.path, branch, base);
    }
    const attach = await git(repoRoot, ['worktree', 'add', absolutePath, branch]);
    if (!attach.ok) {
      throw new Error(`git worktree reattach failed: ${attach.stderr.trim() || attach.stdout.trim()}`);
    }
    return worktreeInfo(absolutePath, branch, base);
  }

  const create = await git(repoRoot, ['worktree', 'add', '--no-track', '-b', branch, absolutePath, base]);
  if (!create.ok) {
    throw new Error(`git worktree add failed: ${create.stderr.trim() || create.stdout.trim()}`);
  }
  return worktreeInfo(absolutePath, branch, base);
}

/**
 * Best-effort on-disk size of a worktree directory in bytes, via POSIX
 * `du -sk` (kibibytes → bytes). Returns `null` when `du` is unavailable —
 * including all of Windows, where `du` is not a command — or on any error.
 * Never throws and never blocks: worktree retention is count-based, so a null
 * size only blanks the panel's size column, it does not affect reclamation.
 */
export function worktreeSizeBytes(path: string): Promise<number | null> {
  return new Promise((resolve) => {
    execFile('du', ['-sk', path], { encoding: 'utf8' }, (err, stdout) => {
      if (err) {
        resolve(null);
        return;
      }
      const kib = Number.parseInt(stdout.trim().split(/\s+/)[0] ?? '', 10);
      resolve(Number.isFinite(kib) ? kib * 1024 : null);
    });
  });
}

/** Remove a task worktree and optionally its branch. Best effort — never throws.
 *  Owned worker paths are refused unless `reclaimOwnedDirectory` is set and no
 *  branch is passed (retention #575: directory only, receipts and branch kept). */
/** Ownership receipts survive a missing run index and a replaced directory.
 * Unreadable/malformed evidence disables generic deletion instead of granting it. */
export async function ownedCleanupProtection(repoRoot: string): Promise<{ paths: Set<string>; branches: Set<string>; uncertain: boolean }> {
  const paths = new Set<string>(); const branches = new Set<string>();
  try {
    const common = await git(repoRoot, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
    if (!common.ok) return { paths, branches, uncertain: true };
    const root = common.stdout.trim();
    const receipts = join(root, 'cezar-owned-workspaces');
    const directory = await lstat(receipts).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return undefined; throw error;
    });
    if (directory && (!directory.isDirectory() || directory.isSymbolicLink())) return { paths, branches, uncertain: true };
    const entries = await readdir(receipts).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return []; throw error;
    });
    for (const entry of entries) {
      if (!entry.endsWith('.json')) continue;
      const path = join(receipts, entry); const info = await lstat(path);
      if (!info.isFile() || info.isSymbolicLink() || info.size > 16_384) return { paths, branches, uncertain: true };
      const receipt: unknown = JSON.parse(await readFile(path, 'utf8'));
      if (!receipt || typeof receipt !== 'object' || !('workspace' in receipt)) return { paths, branches, uncertain: true };
      const parsed = workerWorkspaceSchema.safeParse(receipt.workspace);
      if (!parsed.success) return { paths, branches, uncertain: true };
      const workspace = parsed.data;
      if (workspace.branch !== branchFor(workspace.ownerRunId) ||
          !workspace.path.endsWith(join(WORKTREES_DIR, workspace.ownerRunId)) ||
          entry.replace(/(?:\.cleanup)?\.json$/, '') !== workspace.resourceId) return { paths, branches, uncertain: true };
      paths.add(workspace.path); branches.add(workspace.branch);
    }
    // A provisioning crash can leave the administrative marker before its receipt.
    const admins = await readdir(join(root, 'worktrees')).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return []; throw error;
    });
    for (const admin of admins) {
      const dir = join(root, 'worktrees', admin);
      const marker = await lstat(join(dir, 'cezar-owned-resource')).catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return undefined; throw error;
      });
      if (marker) {
        paths.add(dirname((await readFile(join(dir, 'gitdir'), 'utf8')).trim()));
        const head = (await readFile(join(dir, 'HEAD'), 'utf8')).trim();
        if (head.startsWith('ref: refs/heads/')) branches.add(head.slice('ref: refs/heads/'.length));
      }
    }
    return { paths, branches, uncertain: false };
  } catch { return { paths, branches, uncertain: true }; }
}

export type RemoveWorktreeOptions = {
  reclaimOwnedDirectory?: boolean;
  onlyClean?: boolean;
  /** Runs once every check that can decline the removal has passed, right before git removes
   *  the checkout (#781: the run's preview is released here). A declined removal never calls it. */
  beforeRemove?: () => Promise<void>;
  /** Fresh generation/resource authorization, after all awaits and before destructive Git. */
  assertCurrent?: () => void;
};

export async function removeWorktree(
  repoRoot: string,
  worktreePath: string,
  branch?: string,
  opts?: RemoveWorktreeOptions,
): Promise<void> {
  await withWorktreeMutation(repoRoot, git => removeWorktreeLocked(repoRoot, worktreePath, branch, opts, git)).catch(() => undefined);
}

async function removeWorktreeLocked(
  repoRoot: string, worktreePath: string, branch: string | undefined,
  opts: RemoveWorktreeOptions | undefined, git: WorktreeGit,
): Promise<void> {
  const beforeRemove = async () => {
    await opts?.beforeRemove?.().catch(() => undefined);
    opts?.assertCurrent?.();
    if (protection.paths.has(worktreePath) && inspectGeneration({ paths: [worktreePath] }).liveness !== 'gone') {
      throw new Error('Owned worktree may still be held by a process');
    }
  };
  const protection = await ownedCleanupProtection(repoRoot);
  // Directory-only retention (#575) may reclaim a finished owned-worker checkout
  // while keeping its branch and receipts. Unowned deletion still refuses owned
  // paths, and a branch argument never deletes an owned ref.
  const reclaimOwnedDirectory = opts?.reclaimOwnedDirectory === true && branch === undefined;
  if (protection.uncertain) return;
  if (protection.paths.has(worktreePath) && !reclaimOwnedDirectory) return;
  if (branch !== undefined && protection.branches.has(branch)) return;
  if (reclaimOwnedDirectory && protection.paths.has(worktreePath)) {
    const listed = await git(repoRoot, ['worktree', 'list', '--porcelain', '-z']);
    if (!listed.ok) return;
    const registered = listed.stdout.split(' ').some(
      (entry) => entry.startsWith('worktree ') && canonicalPath(entry.slice(9)) === canonicalPath(worktreePath),
    );
    if (!registered) return;
  }
  // Reclaim keeps the branch and calls the work recoverable, which holds only for what a REF keeps:
  // staged, unstaged and untracked files, and commits made on a detached HEAD, exist in this
  // checkout alone. So the HEAD must be reachable from a branch or remote-tracking ref, and the
  // removal is git's own unforced one — git refuses a dirty tree at the moment it removes, which a
  // status read beforehand cannot promise against an editor saving in between. Any refusal keeps
  // the directory: no forced fallback, no `rm`. Ignored files (build output) never block it.
  if (opts?.onlyClean) {
    const head = await git(worktreePath, ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}']);
    const sha = head.stdout.trim();
    if (!head.ok || !sha) return;
    const kept = await git(repoRoot, ['for-each-ref', '--contains', sha, '--count=1', '--format=%(refname)', 'refs/heads', 'refs/remotes']);
    if (!kept.ok || kept.stdout.trim() === '') return;
    // The refusal git would give a dirty tree, read first so a declined removal costs nothing
    // (`beforeRemove` stops the run's preview). git still has the last word at removal time.
    const status = await git(worktreePath, ['status', '--porcelain']);
    if (!status.ok || status.stdout.trim() !== '') return;
    await beforeRemove();
    const removed = await git(repoRoot, ['worktree', 'remove', worktreePath]);
    if (!removed.ok) return;
    if (protection.paths.size === 0) await git(repoRoot, ['worktree', 'prune']);
    return;
  }
  await beforeRemove();
  await git(repoRoot, ['worktree', 'remove', '--force', worktreePath]);
  // Owned-path reclaim must not `rm` a receipt path that is no longer a git
  // worktree — the directory may have been replaced with unrelated files.
  // For owned resources Git already removed the exact checkout. Never recursively delete a
  // path recreated after that operation (possibly by another execution/controller).
  if (reclaimOwnedDirectory && protection.paths.has(worktreePath)) return;
  await rm(worktreePath, { recursive: true, force: true }).catch(() => undefined);
  if (protection.paths.size === 0) await git(repoRoot, ['worktree', 'prune']);
  if (branch) await git(repoRoot, ['branch', '-D', branch]);
}

/**
 * Autosave reason. Only periodic saves are opt-in. Turn-end, finalization and timer saves
 * require the task branch; pre-PR saves follow current HEAD.
 */
export type AutosaveReason = 'periodic' | 'turn end' | 'run finalize' | 'pre-PR';

/**
 * Structured autosave outcome. Pre-PR must report refused/failed saves. A task-branch mismatch
 * skips; an unfinished merge, cherry-pick or revert refuses a guarded save.
 */
export type AutosaveResult = 'committed' | 'nothing-to-do' | 'refused' | 'failed' | 'skipped';

/**
 * The facts behind a `committed` or `skipped` save, for the caller's report
 * (hearsay-tools/cezarion#1004). `branch` is HEAD's branch name, `null` on a
 * detached HEAD; `sha` is the short hash of the autosave commit, `null` when
 * the commit landed but its hash could not be read back.
 */
export type AutosaveOutcome =
  | { result: 'committed'; sha: string | null; branch: string | null }
  | { result: 'skipped'; branch: string | null; changedPaths: number };

export interface AutosaveCommitOptions extends AutosaveOptions {
  /** The task's own branch (`cez/<id8>`). Given, the save commits only while HEAD is
   *  `refs/heads/<taskBranch>`, and writes that ref by compare-and-swap; on any other
   *  branch or a detached HEAD it returns `skipped` and leaves the working tree alone,
   *  and the index too unless HEAD moves while it saves. */
  taskBranch?: string;
  /** Receives the facts behind a `committed` or `skipped` result. Never called otherwise. */
  onOutcome?: (outcome: AutosaveOutcome) => void;
}

/**
 * Leftover merge-conflict markers, anchored at line start as git writes them.
 * All three must appear *in order*: a bare `=======` line is ordinary Markdown
 * (a setext heading underline), and any of the three alone — or the pair
 * `<<<<<<<`/`>>>>>>>` in either order — occurs legitimately in checked-in
 * patch fixtures and in docs that demonstrate conflict markers. Requiring the
 * full ordered triple is what separates a real conflict from a file that
 * merely talks about one.
 */
const CONFLICT_START = /^<{7}(?:\s|$)/;
const CONFLICT_MID = /^={7}(?:\s|$)/;
const CONFLICT_END = /^>{7}(?:\s|$)/;

/**
 * Largest file the marker scan will read. Autosave runs as often as every 90 s,
 * and decoding a large tracked file into a JS string each time is a real memory
 * cost for a check that only ever looks at a few marker lines. Oversized files
 * are skipped, which fails *open* — consistent with the rest of this guard,
 * where a false negative costs noise and a false positive costs the recovery
 * point.
 */
const MARKER_SCAN_MAX_BYTES = 2_000_000;

/** Does this file carry a complete, ordered conflict hunk? */
function hasConflictMarkers(text: string): boolean {
  let want: 0 | 1 | 2 = 0; // 0: `<<<<<<<`, 1: `=======`, 2: `>>>>>>>`
  for (const line of text.split('\n')) {
    if (want === 0) {
      if (CONFLICT_START.test(line)) want = 1;
    } else if (want === 1) {
      if (CONFLICT_MID.test(line)) want = 2;
    } else if (CONFLICT_END.test(line)) {
      return true;
    }
  }
  return false;
}

/** Serialize all autosave entry points, including periodic/final flush overlap. */
const autosaves = new Map<string, Promise<AutosaveResult>>();

/**
 * Stage and commit everything in the worktree as a "cezar autosave" commit
 * (janitor pattern) — the agent's progress is recoverable from the `cez/<id8>`
 * branch history. Quietly a no-op when nothing changed. With `taskBranch`, a
 * worktree whose HEAD the agent moved to another branch (or detached) is left
 * uncommitted instead: an autosave commit there lands in the agent's own PR
 * history (hearsay-tools/cezarion#1004).
 *
 * The message carries `reason` so the opt-in periodic timer and the always-on
 * flushes are distinguishable in `git log`; the `cezar autosave` prefix is kept
 * so existing log greps still match.
 *
 * Refuses to commit a worktree that is mid-merge or still carries conflict
 * markers: the incident behind #471 was an autosave capturing a half-resolved
 * merge, and a blind `git add -A` would do it again.
 */
export async function autosaveCommit(dir: string, reason: AutosaveReason, options: AutosaveCommitOptions = {}): Promise<AutosaveResult> {
  let key = resolve(dir);
  try { key = realpathSync(dir); } catch { /* Missing/unreadable dir fails through Git. */ }
  const previous = autosaves.get(key);
  const task = (async () => {
    if (previous) await previous;
    return save();
  })();
  autosaves.set(key, task);
  try { return await task; }
  finally { if (autosaves.get(key) === task) autosaves.delete(key); }

  async function save(): Promise<AutosaveResult> {
    const git = (cwd: string, args: string[]) => autosaveGit(cwd, args, options);
    const status = await git(dir, ['status', '--porcelain']);
    if (!status.ok) return 'failed';
    if (!status.stdout.trim()) return 'nothing-to-do';
    const { taskBranch, onOutcome } = options;
    const report = (outcome: AutosaveOutcome) => {
      try { onOutcome?.(outcome); } catch { /* Reporting must not change what the save did. */ }
    };
    // HEAD's symbolic ref, `null` on a detached HEAD, `undefined` when the read failed.
    const readHead = async (): Promise<string | null | undefined> => {
      // Exit 1 under -q is a detached HEAD; anything else is a failed read.
      const ref = await git(dir, ['symbolic-ref', '-q', 'HEAD']);
      if (!ref.ok && ref.code !== 1) return undefined;
      return ref.ok ? ref.stdout.trim() : null;
    };
    const branchName = (head: string | null) => head?.startsWith('refs/heads/') ? head.slice('refs/heads/'.length) : head;
    // HEAD is not the task branch: the work stays uncommitted, reported with the paths status saw.
    const skip = (head: string | null): 'skipped' => {
      report({ result: 'skipped', branch: branchName(head), changedPaths: status.stdout.split('\n').filter(Boolean).length });
      return 'skipped';
    };
    let head: string | null = null;
    if (taskBranch !== undefined || onOutcome) {
      const read = await readHead();
      if (read === undefined) return 'failed';
      head = read;
    }
    const branch = branchName(head);
    if (taskBranch !== undefined && head !== `refs/heads/${taskBranch}`) return skip(head);
    const unresolved = await unresolvedConflicts(dir, status.stdout);
    if (unresolved) {
      // Losing one recovery point beats poisoning the branch with a commit that
      // does not build. For the periodic and turn-end flushes the next one picks
      // the work up once the merge resolves; the pre-PR flush has no next one,
      // which is why callers get `refused` rather than a bare `false`.
      console.warn(`[cezar] skipping ${reason} autosave in ${dir}: ${unresolved}`);
      return 'refused';
    }
    // A resolved merge, cherry-pick or revert the agent has not concluded: `git commit`
    // would conclude it under `cezar autosave`. The agent concludes it with its own
    // message; the next flush picks the work up (hearsay-tools/cezarion#1004). Asked of
    // Git, not looked up as files: only MERGE_HEAD is always a file. CHERRY_PICK_HEAD and
    // REVERT_HEAD are root refs in the ref backend, which a reftable repository keeps in
    // its reftable stack, so a file check would miss them there.
    const pendingOperation = async (): Promise<'refused' | 'failed' | null> => {
      for (const pending of ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD']) {
        const found = await git(dir, ['rev-parse', '--verify', '-q', pending]);
        if (found.ok) {
          console.warn(`[cezar] skipping ${reason} autosave in ${dir}: ${pending} is set, the operation is not concluded`);
          return 'refused';
        }
        if (found.code !== 1) return 'failed';
      }
      return null;
    };
    if (taskBranch !== undefined) {
      // Checked before staging too, so a pending operation's index stays as the agent left it.
      const pending = await pendingOperation();
      if (pending) return pending;
    }
    if (!(await git(dir, ['add', '-A'])).ok) return 'failed';
    // Commit as the CURRENT git user, so the branch's commits (and any PR opened from it) are
    // attributed to the real author and pass CLA / attribution checks. The old hardcoded
    // `cezar <cezar@local>` identity made every autosave look like a non-GitHub user. Fall back to
    // that identity ONLY when the machine has no git identity configured — otherwise `git commit`
    // would fail and the autosave (the run's recovery point) would be lost.
    const name = await git(dir, ['config', 'user.name']);
    if (!name.ok && name.code !== 1) return 'failed';
    const email = await git(dir, ['config', 'user.email']);
    if (!email.ok && email.code !== 1) return 'failed';
    const identityArgs = (name.ok && name.stdout.trim() && email.ok && email.stdout.trim())
      ? []
      : ['-c', 'user.name=cezar', '-c', 'user.email=cezar@local'];
    const message = `cezar autosave (${reason})`;
    if (taskBranch === undefined) {
      const commit = await git(dir, [
        ...identityArgs,
        'commit',
        '--no-verify',
        '-m',
        message,
      ]);
      if (!commit.ok) return 'failed';
      if (onOutcome) {
        // The commit already landed: a failed read loses the sha, never the report.
        const sha = await git(dir, ['rev-parse', '--short', 'HEAD']);
        report({ result: 'committed', sha: (sha.ok && sha.stdout.trim()) || null, branch });
      }
      return 'committed';
    }
    // The task branch is written by compare-and-swap, never through HEAD: the agent can
    // check another branch out after the `symbolic-ref` check above, and `git commit`
    // resolves HEAD again at its own start, so the save landed on the agent's branch
    // (review on hearsay-tools/cezarion#1111). `update-ref <ref> <new> <old>` moves the
    // branch only while it still points at the tip read here (an unborn one: while it
    // still does not exist); a moved branch fails the save and the next flush retries.
    // Unlike the porcelain this runs no prepare-commit-msg or post-commit hook
    // (`--no-verify` already skipped pre-commit and commit-msg), and the reflog entry
    // reads `cezar autosave (<reason>)` without the `commit: ` prefix. commit-tree
    // stopped reading commit.gpgSign in Git 2.9 (its release notes tell scripts to read
    // it and pass -S), so it is read here: a user who signs every commit still does.
    const ref = `refs/heads/${taskBranch}`;
    const tip = await git(dir, ['rev-parse', '--verify', '-q', ref]);
    if (!tip.ok && tip.code !== 1) return 'failed';
    const parent = tip.ok ? tip.stdout.trim() : '';
    const written = await git(dir, ['write-tree']);
    const tree = written.stdout.trim();
    if (!written.ok || !tree) return 'failed';
    if (parent) {
      // Dirty when status looked, identical once staged: nothing to save.
      const parentTree = await git(dir, ['rev-parse', '--verify', '-q', `${parent}^{tree}`]);
      if (!parentTree.ok) return 'failed';
      if (parentTree.stdout.trim() === tree) return 'nothing-to-do';
    }
    const sign = await git(dir, ['config', '--type=bool', 'commit.gpgsign']);
    if (!sign.ok && sign.code !== 1) return 'failed';
    const created = await git(dir, [
      ...identityArgs,
      'commit-tree',
      ...(sign.ok && sign.stdout.trim() === 'true' ? ['-S'] : []),
      tree,
      ...(parent ? ['-p', parent] : []),
      '-m',
      message,
    ]);
    const sha = created.stdout.trim();
    if (!created.ok || !sha) return 'failed';
    // The save is not atomic against the agent's own Git commands. It guarantees that no
    // ref other than refs/heads/<taskBranch> moves, and that no merge, cherry-pick or
    // revert Git has recorded as pending (its MERGE_HEAD, CHERRY_PICK_HEAD or REVERT_HEAD
    // written) by this recheck is committed: the check before `add -A` cannot see one that
    // starts after it, and the save would record that operation's content without its
    // ancestry (review round 4 on hearsay-tools/cezarion#1004). An operation that starts
    // after `write-tree` cannot be in this tree; one recorded before it is still pending
    // here, unless the agent also concluded it, which moved the branch and fails the
    // compare-and-swap, or aborted it within those few commands, whose content the save
    // then still records. A Git command still running during the save is not excluded:
    // `git merge` publishes the merged index before it writes MERGE_HEAD, so a save in
    // between records that content single-parent, as `git add -A && git commit` always
    // did (review round 5 reproduced the same result on main). The save also commits only
    // when HEAD names the task branch at both of its reads, before `add -A` and here after
    // `write-tree`, so a checkout between them skips it (review round 2 on
    // hearsay-tools/cezarion#1111). A checkout away and back again between the reads is not
    // excluded, nor is one still running, which writes the new index and working tree
    // before it moves HEAD, so a save in between commits the other branch's files onto the
    // task branch, as `git add -A && git commit` on main does. A refusal or a skip here
    // leaves what `add -A` staged in the index, as every failure after it does.
    const moved = await readHead();
    if (moved === undefined) return 'failed';
    if (moved !== ref) return skip(moved);
    const late = await pendingOperation();
    if (late) return late;
    if (!(await git(dir, ['update-ref', '-m', message, ref, sha, parent])).ok) return 'failed';
    if (onOutcome) {
      // The commit already landed: a failed read loses the sha, never the report.
      const short = await git(dir, ['rev-parse', '--short', sha]);
      report({ result: 'committed', sha: (short.ok && short.stdout.trim()) || null, branch: taskBranch });
    }
    return 'committed';
  }
}

/**
 * Is the worktree mid-merge or still carrying conflict markers? Returns a
 * human-readable reason, or `null` when it is safe to autosave.
 *
 * Two independent checks, because they catch different failures: porcelain `U`
 * codes catch an *unresolved* merge, while the marker scan catches the worse
 * case — someone ran `git add` on a file they had not finished resolving, which
 * clears the `U` code but leaves `<<<<<<<` in the text.
 */
async function unresolvedConflicts(dir: string, porcelain: string): Promise<string | null> {
  const entries = porcelain.split('\n').filter(Boolean);
  const unmerged = entries.filter((line) => {
    const xy = line.slice(0, 2);
    // Unmerged per `git status` docs: any side U, plus the AA / DD collisions.
    return xy.includes('U') || xy === 'AA' || xy === 'DD';
  });
  const firstUnmerged = unmerged[0];
  if (firstUnmerged) {
    return `${unmerged.length} unmerged path(s), e.g. ${firstUnmerged.slice(3)}`;
  }
  // Deleted paths have no content to scan. Untracked (`??`) ones are skipped
  // even though `git add -A` will commit them: a conflict always lands in a
  // tracked file, whereas an untracked fixture or doc that legitimately
  // contains marker-shaped lines would otherwise wedge every autosave. False
  // negatives here cost noise; false positives would cost the recovery point.
  const candidates = entries
    .filter((line) => !line.startsWith('D ') && !line.startsWith(' D') && !line.startsWith('??'))
    .map((line) => {
      // A rename reads `old -> new`; the new path is what gets committed.
      const raw = line.slice(3).trim();
      const path = raw.includes(' -> ') ? (raw.split(' -> ')[1] ?? raw) : raw;
      return unquotePath(path);
    });
  for (const path of candidates) {
    // Read the working tree, not the index: this runs before `git add -A`, so
    // the on-disk copy is what would be committed. Binary files decode to
    // mojibake rather than throwing, but cannot match the anchored marker
    // pattern; unreadable paths (races, symlinks) are skipped, not fatal.
    let text: string;
    try {
      const full = join(dir, path);
      if ((await stat(full)).size > MARKER_SCAN_MAX_BYTES) continue;
      text = await readFile(full, 'utf8');
    } catch {
      continue;
    }
    if (hasConflictMarkers(text)) {
      return `leftover conflict markers in ${path}`;
    }
  }
  return null;
}

/**
 * Undo `git status --porcelain` path quoting. Git quotes a path containing a
 * space or a non-ASCII byte, escaping the latter as octal — `café.txt` reads
 * back as `"caf\303\251.txt"`. Stripping the quotes alone leaves those escapes
 * literal, so the file would not open and a real conflict in it would go
 * unnoticed. Decoding the octal bytes as UTF-8 restores the actual name.
 */
function unquotePath(path: string): string {
  if (!path.startsWith('"') || !path.endsWith('"')) return path;
  const inner = path.slice(1, -1);
  const bytes: number[] = [];
  for (let i = 0; i < inner.length; i += 1) {
    if (inner[i] !== '\\') {
      bytes.push(...Buffer.from(inner[i] as string, 'utf8'));
      continue;
    }
    const next = inner[i + 1] as string | undefined;
    if (next === undefined) break;
    const octal = inner.slice(i + 1, i + 4);
    if (/^[0-7]{3}$/.test(octal)) {
      bytes.push(parseInt(octal, 8));
      i += 3;
      continue;
    }
    // C-style single-character escapes git also emits.
    const simple: Record<string, number> = { n: 10, t: 9, r: 13, '"': 34, '\\': 92 };
    const escaped = simple[next];
    if (escaped === undefined) bytes.push(...Buffer.from(next, 'utf8'));
    else bytes.push(escaped);
    i += 1;
  }
  return Buffer.from(bytes).toString('utf8');
}

type IndexGit = (args: string[]) => Promise<GitResult>;

/**
 * Read through a private index copy. Try OS temp, then the Git directory; if neither is
 * writable, retain the real-index fallback. Always remove scratch state.
 */
async function withPrivateIndex<T>(worktreePath: string, read: (git: IndexGit) => Promise<T>): Promise<T> {
  const real = await git(worktreePath, ['rev-parse', '--path-format=absolute', '--git-path', 'index']);
  const realIndex = real.ok ? real.stdout.trim() : '';
  let scratch: string | undefined;
  for (const parent of [tmpdir(), ...(realIndex ? [dirname(realIndex)] : [])]) {
    try {
      scratch = await mkdtemp(join(parent, 'cez-diff-index-'));
      break;
    } catch { /* Not writable: try the next location. */ }
  }
  if (!scratch) return read((args) => git(worktreePath, args));
  try {
    const index = join(scratch, 'index');
    const env = { ...process.env, GIT_INDEX_FILE: index };
    const indexed: IndexGit = (args) => git(worktreePath, args, undefined, env);
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

/**
 * Whole-branch committed, uncommitted and untracked diff against the merge-base. Preserve this
 * anchor for the protected text endpoint and conservative settlement checks.
 */
export async function worktreeDiff(
  worktreePath: string,
  baseBranch: string,
  cap = DIFF_CAP,
): Promise<string> {
  if (!isSafeGitRef(baseBranch)) return '(diff failed: refusing option-like base ref)';
  return withPrivateIndex(worktreePath, async (git) => {
    await git(['add', '-N', '.']); // intent-to-add (private index, #1080): untracked files show up
    const mergeBase = await git(['merge-base', baseBranch, 'HEAD']);
    const base = mergeBase.ok && mergeBase.stdout.trim() ? mergeBase.stdout.trim() : baseBranch;
    const res = await git(['diff', base]);
    if (!res.ok) return `(diff failed: ${res.stderr.trim() || 'unknown git error'})`;
    if (res.stdout.length > cap) return `${res.stdout.slice(0, cap)}\n… (diff truncated)`;
    return res.stdout;
  });
}

/**
 * Whole-branch diff --stat for variant comparisons. Includes committed work; returns an empty
 * string on failure.
 */
export async function worktreeDiffStat(
  worktreePath: string,
  baseBranch: string,
): Promise<string> {
  if (!isSafeGitRef(baseBranch)) return '';
  return withPrivateIndex(worktreePath, async (git) => {
    await git(['add', '-N', '.']); // intent-to-add (private index, #1080): untracked files show up
    const mergeBase = await git(['merge-base', baseBranch, 'HEAD']);
    const base = mergeBase.ok && mergeBase.stdout.trim() ? mergeBase.stdout.trim() : baseBranch;
    const res = await git(['diff', '--stat', base]);
    return res.ok ? res.stdout.trim() : '';
  });
}

/** Aggregate diff numbers (#389) — the shape stored on `RunRecord.diffStat`. */
export interface DiffStat {
  adds: number;
  dels: number;
  files: number;
  /** Set only when the numbers were narrowed to what this run did on a branch it checked
   *  out into its worktree, because HEAD had been repointed off the task's branch (#751).
   *  Absent — never `false` — on a normal run, so the persisted shape is unchanged for
   *  every task that behaved. */
  repointed?: boolean;
}

/**
 * Parse `git diff --shortstat` output — " 3 files changed, 10 insertions(+),
 * 2 deletions(-)". Every part is optional: insertions-only and deletions-only
 * diffs omit the other counter, and an empty diff prints nothing at all
 * (→ all zeros). The wording is stable porcelain English — git does not
 * localize `--shortstat` — so matching the words is safe.
 */
export function parseShortstat(s: string): DiffStat {
  const files = /(\d+) files? changed/.exec(s);
  const adds = /(\d+) insertions?\(\+\)/.exec(s);
  const dels = /(\d+) deletions?\(-\)/.exec(s);
  return {
    files: files ? Number(files[1]) : 0,
    adds: adds ? Number(adds[1]) : 0,
    dels: dels ? Number(dels[1]) : 0,
  };
}

/**
 * Aggregate task diff numbers, using resolveTaskDiffBase with the run’s branch and start time.
 * Set repointed only when narrowed. Return null on git failure; an empty diff is all zeros.
 */
export async function worktreeShortstat(
  worktreePath: string,
  baseBranch: string,
  opts: { taskBranch?: string; runStartedAt?: string } = {},
): Promise<DiffStat | null> {
  if (!isSafeGitRef(baseBranch)) return null;
  // Private index (#1080): this runs at every turn end, beside the turn-end autosave.
  return withPrivateIndex(worktreePath, async (git) => {
    await git(['add', '-N', '.']); // intent-to-add: untracked files show up
    // `resolveTaskDiffBase` may compare two anchors with `git diff --shortstat`, so it
    // reads the private index too.
    const { base, repointedHead } = await resolveTaskDiffBase(git, baseBranch, opts);
    const res = await git(['diff', '--shortstat', base]);
    if (!res.ok) return null;
    // The key stays ABSENT (not `false`) on a normal run: `diffStat` is persisted in
    // `runs.json` and served on the runs API, so the un-narrowed shape must keep
    // round-tripping byte-identically.
    return { ...parseShortstat(res.stdout), ...(repointedHead ? { repointed: true } : {}) };
  });
}

/**
 * Startup reconcile: `git worktree prune` + remove every directory under
 * `.ai/cezar/worktrees/` whose run id is no longer in the store (and its
 * branch). Returns the removed run ids for the boot log. Never throws.
 */
export async function pruneOrphans(
  repoRoot: string,
  validIds: ReadonlySet<string>,
): Promise<string[]> {
  return withWorktreeMutation(repoRoot, git => pruneOrphansLocked(repoRoot, validIds, git)).catch(() => []);
}

async function pruneOrphansLocked(repoRoot: string, validIds: ReadonlySet<string>, git: WorktreeGit): Promise<string[]> {
  const protection = await ownedCleanupProtection(repoRoot);
  if (protection.uncertain) return [];
  if (protection.paths.size === 0) await git(repoRoot, ['worktree', 'prune']);
  let entries: Dirent[];
  try {
    entries = await readdir(join(repoRoot, WORKTREES_DIR), { withFileTypes: true });
  } catch {
    return []; // no worktrees dir yet
  }
  const removed: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || validIds.has(entry.name) || protection.paths.has(worktreePathFor(repoRoot, entry.name))) continue;
    await removeWorktreeLocked(repoRoot, worktreePathFor(repoRoot, entry.name), branchFor(entry.name), undefined, git);
    removed.push(entry.name);
  }
  return removed;
}

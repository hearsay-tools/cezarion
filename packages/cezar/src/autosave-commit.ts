import { logPrefix } from './home/display.ts';
import { fallbackProjectWriteError } from './project-paths.ts';
import { autosaveGit, type AutosaveOptions } from './autosave-git.ts';
import { realpathSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';

/**
 * Autosave reason. Only periodic saves are opt-in. Every caller passes the task branch when the
 * run has one; draft-PR publish refuses before its pre-PR save when HEAD left it.
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

type AutosaveGitFn = (cwd: string, args: string[]) => ReturnType<typeof autosaveGit>;

/** HEAD's symbolic ref, `null` on a detached HEAD, `undefined` when the read failed. */
async function readAutosaveHead(dir: string, git: AutosaveGitFn): Promise<string | null | undefined> {
  // Exit 1 under -q is a detached HEAD; anything else is a failed read.
  const ref = await git(dir, ['symbolic-ref', '-q', 'HEAD']);
  if (!ref.ok && ref.code !== 1) return undefined;
  return ref.ok ? ref.stdout.trim() : null;
}

function autosaveBranchName(head: string | null): string | null {
  return head?.startsWith('refs/heads/') ? head.slice('refs/heads/'.length) : head;
}

function reportAutosave(onOutcome: AutosaveCommitOptions['onOutcome'], outcome: AutosaveOutcome): void {
  try { onOutcome?.(outcome); } catch { /* Reporting must not change what the save did. */ }
}

// HEAD is not the task branch: the work stays uncommitted, reported with the paths status saw.
function skipAutosave(head: string | null, status: string, onOutcome: AutosaveCommitOptions['onOutcome']): 'skipped' {
  reportAutosave(onOutcome, { result: 'skipped', branch: autosaveBranchName(head), changedPaths: status.split('\n').filter(Boolean).length });
  return 'skipped';
}

/** A resolved merge, cherry-pick or revert the agent has not concluded: `git commit`
 * would conclude it under `cezar autosave`. The agent concludes it with its own
 * message; the next flush picks the work up (hearsay-tools/cezarion#1004). Asked of
 * Git, not looked up as files: only MERGE_HEAD is always a file. CHERRY_PICK_HEAD and
 * REVERT_HEAD are root refs in the ref backend, which a reftable repository keeps in
 * its reftable stack, so a file check would miss them there. */
async function pendingAutosaveOperation(dir: string, reason: AutosaveReason, git: AutosaveGitFn): Promise<'refused' | 'failed' | null> {
  for (const pending of ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD']) {
    const found = await git(dir, ['rev-parse', '--verify', '-q', pending]);
    if (found.ok) {
      console.warn(`${logPrefix()} skipping ${reason} autosave in ${dir}: ${pending} is set, the operation is not concluded`);
      return 'refused';
    }
    if (found.code !== 1) return 'failed';
  }
  return null;
}

/** Commit as the CURRENT git user, so the branch's commits (and any PR opened from it) are
 * attributed to the real author and pass CLA / attribution checks. The old hardcoded
 * `cezar <cezar@local>` identity made every autosave look like a non-GitHub user. Fall back to
 * that identity ONLY when the machine has no git identity configured — otherwise `git commit`
 * would fail and the autosave (the run's recovery point) would be lost. */
async function autosaveIdentityArgs(dir: string, git: AutosaveGitFn): Promise<string[] | 'failed'> {
  const name = await git(dir, ['config', 'user.name']);
  if (!name.ok && name.code !== 1) return 'failed';
  const email = await git(dir, ['config', 'user.email']);
  if (!email.ok && email.code !== 1) return 'failed';
  return (name.ok && name.stdout.trim() && email.ok && email.stdout.trim())
    ? [] : ['-c', 'user.name=cezar', '-c', 'user.email=cezar@local'];
}

async function commitAutosaveOnHead(
  dir: string, identityArgs: string[], message: string, branch: string | null,
  onOutcome: AutosaveCommitOptions['onOutcome'], git: AutosaveGitFn,
): Promise<AutosaveResult> {
  const commit = await git(dir, [...identityArgs, 'commit', '--no-verify', '-m', message]);
  if (!commit.ok) return 'failed';
  if (onOutcome) {
    // The commit already landed: a failed read loses the sha, never the report.
    const sha = await git(dir, ['rev-parse', '--short', 'HEAD']);
    reportAutosave(onOutcome, { result: 'committed', sha: (sha.ok && sha.stdout.trim()) || null, branch });
  }
  return 'committed';
}

/** The task branch is written by compare-and-swap, never through HEAD: the agent can
 * check another branch out after the `symbolic-ref` check in `readAutosaveHead`, and `git commit`
 * resolves HEAD again at its own start, so the save landed on the agent's branch
 * (review on hearsay-tools/cezarion#1111). `update-ref <ref> <new> <old>` moves the
 * branch only while it still points at the tip read here (an unborn one: while it
 * still does not exist); a moved branch fails the save and the next flush retries.
 * Unlike the porcelain this runs no prepare-commit-msg or post-commit hook
 * (`--no-verify` already skipped pre-commit and commit-msg), and the reflog entry
 * reads `cezar autosave (<reason>)` without the `commit: ` prefix. commit-tree
 * stopped reading commit.gpgSign in Git 2.9 (its release notes tell scripts to read
 * it and pass -S), so it is read here: a user who signs every commit still does. */
async function writeAutosaveCommit(
  dir: string, taskBranch: string, identityArgs: string[], message: string, git: AutosaveGitFn,
): Promise<{ sha: string; parent: string } | 'failed' | 'nothing-to-do'> {
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
  return { sha, parent };
}

async function publishAutosaveCommit(
  dir: string, taskBranch: string, sha: string, parent: string, message: string, status: string,
  onOutcome: AutosaveCommitOptions['onOutcome'], reason: AutosaveReason, git: AutosaveGitFn,
): Promise<AutosaveResult> {
  const ref = `refs/heads/${taskBranch}`;
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
  const moved = await readAutosaveHead(dir, git);
  if (moved === undefined) return 'failed';
  if (moved !== ref) return skipAutosave(moved, status, onOutcome);
  const late = await pendingAutosaveOperation(dir, reason, git);
  if (late) return late;
  if (!(await git(dir, ['update-ref', '-m', message, ref, sha, parent])).ok) return 'failed';
  if (onOutcome) {
    // The commit already landed: a failed read loses the sha, never the report.
    const short = await git(dir, ['rev-parse', '--short', sha]);
    reportAutosave(onOutcome, { result: 'committed', sha: (short.ok && short.stdout.trim()) || null, branch: taskBranch });
  }
  return 'committed';
}

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
  if (fallbackProjectWriteError(dir)) {
    console.info(`${logPrefix()} Autosave skipped 1 read-only fallback worktree under .ai/squawk/.`);
    return 'skipped';
  }
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
    const git: AutosaveGitFn = (cwd, args) => autosaveGit(cwd, args, options);
    const status = await git(dir, ['status', '--porcelain']);
    if (!status.ok) return 'failed';
    if (!status.stdout.trim()) return 'nothing-to-do';
    const { taskBranch, onOutcome } = options;
    let head: string | null = null;
    if (taskBranch !== undefined || onOutcome) {
      const read = await readAutosaveHead(dir, git);
      if (read === undefined) return 'failed';
      head = read;
    }
    const branch = autosaveBranchName(head);
    if (taskBranch !== undefined && head !== `refs/heads/${taskBranch}`) return skipAutosave(head, status.stdout, onOutcome);
    const unresolved = await unresolvedConflicts(dir, status.stdout);
    if (unresolved) {
      // Losing one recovery point beats poisoning the branch with a commit that
      // does not build. For the periodic and turn-end flushes the next one picks
      // the work up once the merge resolves; the pre-PR flush has no next one,
      // which is why callers get `refused` rather than a bare `false`.
      console.warn(`${logPrefix()} skipping ${reason} autosave in ${dir}: ${unresolved}`);
      return 'refused';
    }
    if (taskBranch !== undefined) {
      // Checked before staging too, so a pending operation's index stays as the agent left it.
      const pending = await pendingAutosaveOperation(dir, reason, git);
      if (pending) return pending;
    }
    if (!(await git(dir, ['add', '-A'])).ok) return 'failed';
    const identityArgs = await autosaveIdentityArgs(dir, git);
    if (identityArgs === 'failed') return 'failed';
    const message = `cezar autosave (${reason})`;
    if (taskBranch === undefined) {
      return commitAutosaveOnHead(dir, identityArgs, message, branch, onOutcome, git);
    }
    const written = await writeAutosaveCommit(dir, taskBranch, identityArgs, message, git);
    if (written === 'failed' || written === 'nothing-to-do') return written;
    return publishAutosaveCommit(dir, taskBranch, written.sha, written.parent, message, status.stdout, onOutcome, reason, git);
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

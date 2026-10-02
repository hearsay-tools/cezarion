import { execFile } from 'node:child_process';
import { readdir, stat } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { promisify } from 'node:util';
import { isSafeGitRef } from '../git-refs.ts';

const exec = promisify(execFile);

export interface RepoInfo {
  root: string;
  branch: string;
  remote?: string;
}

export interface StatusEntry {
  status: string;
  path: string;
}

export interface LogEntry {
  hash: string;
  subject: string;
  author: string;
  when: string;
  /** Committer date, strict ISO 8601 (`%cI`) — what the cockpit groups by day. */
  at: string;
}

/** A log row plus its full parent SHAs — what `source` attribution reads (issue 08 §B5). The
 *  parents never reach the wire: the route maps them away. */
export interface LogEntryWithParents extends LogEntry {
  parents: string[];
}

/** `GET /repo` `tracking` (issue 08 §B1). */
export interface RepoTracking {
  ref: string;
  ahead: number;
  behind: number;
  fetchedAt: string | null;
}

async function git(root: string, args: string[]): Promise<string> {
  const { stdout } = await exec('git', args, { cwd: root, maxBuffer: 10 * 1024 * 1024 });
  return stdout;
}

/** Null when `dir` isn't inside a git repository. */
export async function getRepoInfo(dir: string): Promise<RepoInfo | null> {
  try {
    const root = (await git(dir, ['rev-parse', '--show-toplevel'])).trim();
    const branch = (await git(root, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim();
    let remote: string | undefined;
    try {
      remote = (await git(root, ['remote', 'get-url', 'origin'])).trim() || undefined;
    } catch {
      // No remote named `origin` — fall back to the first configured remote,
      // so repos whose only remote is named e.g. `github` or `upstream` still
      // get forge detection. Truly remote-less repos land in the inner catch.
      try {
        const names = (await git(root, ['remote'])).split('\n').map((n) => n.trim()).filter(Boolean);
        if (names[0]) {
          remote = (await git(root, ['remote', 'get-url', names[0]])).trim() || undefined;
        }
      } catch {
        // no remotes at all — local-only repo
      }
    }
    return { root, branch, remote };
  } catch {
    return null;
  }
}

/** The current commit, pinned as a full SHA. Null outside a repository or before its first commit. */
export async function getHeadCommit(root: string): Promise<string | null> {
  try {
    return (await git(root, ['rev-parse', '--verify', 'HEAD^{commit}'])).trim() || null;
  } catch {
    return null;
  }
}

export async function getStatus(root: string): Promise<StatusEntry[]> {
  const out = await git(root, ['status', '--porcelain', '--untracked-files=all']);
  return out
    .split('\n')
    .filter(Boolean)
    .map((line) => ({ status: line.slice(0, 2).trim() || '??', path: line.slice(3) }));
}

/** Working-tree diff vs HEAD (staged + unstaged), capped for the GUI. */
export async function getDiff(root: string, cap = 400_000): Promise<string> {
  const diff = await git(root, ['diff', 'HEAD']);
  if (diff.length > cap) return `${diff.slice(0, cap)}\n… (diff truncated)`;
  return diff;
}

/** Local + origin branch names, deduped (origin/x counts as x), sorted.
 *  Feeds the Repo tab's base-branch picker. */
export async function getBranches(root: string): Promise<string[]> {
  const names = new Set<string>();
  try {
    const local = await git(root, ['branch', '--list', '--format=%(refname:short)']);
    for (const line of local.split('\n')) {
      const name = line.trim();
      if (name) names.add(name);
    }
  } catch {
    // no branches — empty list
  }
  try {
    const remote = await git(root, ['branch', '-r', '--list', '--format=%(refname:short)']);
    for (const line of remote.split('\n')) {
      const name = line.trim();
      if (!name || name.includes('HEAD')) continue;
      names.add(name.replace(/^origin\//, ''));
    }
  } catch {
    // no remotes — local only
  }
  return [...names].filter((n) => !n.startsWith('cez/')).sort((a, b) => a.localeCompare(b));
}

/** One commit — message + stat + patch — for the Repo view's expandable rows. */
export async function getCommit(root: string, sha: string, cap = 200_000): Promise<string> {
  if (!/^[0-9a-f]{4,40}$/i.test(sha)) return '(not a commit hash)';
  const out = await git(root, ['show', '--stat', '--patch', '--no-color', sha]);
  if (out.length > cap) return `${out.slice(0, cap)}\n… (diff truncated)`;
  return out;
}

export async function getLog(root: string, count = 20): Promise<LogEntry[]> {
  return (await getLogWithParents(root, count)).map(({ parents: _parents, ...entry }) => entry);
}

export async function getLogWithParents(root: string, count = 20): Promise<LogEntryWithParents[]> {
  const out = await git(root, [
    'log',
    `-${count}`,
    '--pretty=format:%h%x1f%s%x1f%an%x1f%cr%x1f%cI%x1f%P',
  ]);
  return out
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [hash = '', subject = '', author = '', when = '', at = '', parents = ''] = line.split('\x1f');
      return { hash, subject, author, when, at, parents: parents.split(' ').filter(Boolean) };
    });
}

/**
 * The base branch against its upstream, as of the LAST FETCH (issue 08 §B1). Reads refs only —
 * never `fetch`, never the network — so it is as fresh as whatever last fetched, which is usually
 * an agent (agents fetch, they never pull). Null when the base has no upstream or git cannot say;
 * never throws.
 */
export async function getTracking(root: string, base: string): Promise<RepoTracking | null> {
  if (!isSafeGitRef(base)) return null;
  try {
    const ref = (await git(root, ['for-each-ref', '--format=%(upstream:short)', `refs/heads/${base}`])).trim();
    if (!ref) return null;
    const counts = (await git(root, ['rev-list', '--left-right', '--count', `refs/heads/${base}...${ref}`])).trim();
    const [ahead, behind] = counts.split(/\s+/).map(Number);
    if (!Number.isFinite(ahead) || !Number.isFinite(behind)) return null;
    return { ref, ahead: ahead as number, behind: behind as number, fetchedAt: await lastFetchedAt(root) };
  } catch {
    return null;
  }
}

/** The newest `FETCH_HEAD` mtime in the repository. Each linked worktree writes its OWN
 *  (`<common>/worktrees/<name>/FETCH_HEAD`), and agents fetch from task worktrees, so the main
 *  checkout's alone would say "never fetched" right after an agent refreshed `origin/main`. */
async function lastFetchedAt(root: string): Promise<string | null> {
  try {
    const common = (await git(root, ['rev-parse', '--git-common-dir'])).trim();
    const dir = isAbsolute(common) ? common : join(root, common);
    const linked = await readdir(join(dir, 'worktrees')).catch(() => [] as string[]);
    const files = [join(dir, 'FETCH_HEAD'), ...linked.map((name) => join(dir, 'worktrees', name, 'FETCH_HEAD'))];
    const times = await Promise.all(files.map((file) => stat(file).then((s) => s.mtimeMs, () => null)));
    const newest = Math.max(...times.filter((t): t is number => t !== null));
    return Number.isFinite(newest) ? new Date(newest).toISOString() : null;
  } catch {
    return null;
  }
}

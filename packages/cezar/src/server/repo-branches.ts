/**
 * Server-owned branch classification and cleanup policy. Reclassify before deletion:
 * active/other are protected; merged/empty allow bulk; not-landed/orphan require one typed
 * confirmation. Forge failure leaves ancestry evidence with unknown PR state.
 */
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join as joinPath, resolve as resolvePath } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { z } from 'zod';
import type { BranchClass, BranchPrState, RepoBranchCountsResponse, RepoBranchEntry, RepoBranchesResponse } from '@open-mercato/cezar-contract';
import { isSafeGitRef } from '../git-refs.ts';
import { withWorktreeMutation } from '../git-worktree-lock.ts';
import { ownedCleanupProtection, parseShortstat } from '../git-worktree.ts';
import { loadConfig } from '../config.ts';
import type { BranchOwner, RunStatus, RunStore } from '../runs/store.ts';
import type { RunManager } from '../workflows/run.ts';
import { fetchGithubRefStatus, GH_REF_STATUS_MAX, refNumberFromUrl, type ReferenceStatus } from './github.ts';
import { getBranches, getRepoInfo, type LogEntryWithParents } from './git.ts';

const exec = promisify(execFile);

interface GitResult { ok: boolean; stdout: string; stderr: string }

/** How many `git` processes this module runs at once, across every repository and request. A
 *  repository with thousands of branches otherwise gets one process per branch at the same
 *  moment (hearsay-tools/cezarion#2029). */
const GIT_CONCURRENCY = 6;
let gitRunning = 0;
const gitWaiters: Array<() => void> = [];

async function gitSlot(): Promise<() => void> {
  if (gitRunning < GIT_CONCURRENCY) gitRunning++;
  else await new Promise<void>((resolve) => gitWaiters.push(resolve));
  // A released slot passes straight to the next waiter, so `gitRunning` never drops under it.
  return () => {
    const next = gitWaiters.shift();
    if (next) next();
    else gitRunning--;
  };
}

async function git(cwd: string, args: string[]): Promise<GitResult> {
  const release = await gitSlot();
  try {
    return await new Promise((resolve) => {
      execFile('git', args, { cwd, maxBuffer: 32 * 1024 * 1024, encoding: 'utf8' }, (err, stdout, stderr) =>
        resolve({ ok: !err, stdout: stdout ?? '', stderr: stderr ?? '' }),
      );
    });
  } finally {
    release();
  }
}

const TASK_PREFIX = 'cez/';
const FINISHED: ReadonlySet<RunStatus> = new Set<RunStatus>(['done', 'failed', 'cancelled']);
const FULL_SHA = /^[0-9a-f]{40}$/;

// ---- the forge seam ------------------------------------------------------------------------

export interface ForgePr {
  number: number;
  url: string;
  headRefName: string;
  /** The branch the PR targets, and its head commit — at merge time, for a merged PR. Together
   *  they are what proves a merged PR landed THIS tip on THIS base. */
  baseRefName: string;
  headRefOid: string;
  /** The commit the merge put on the base (a squash commit, or the merge commit), null until merged. */
  mergeCommitOid: string | null;
  state: BranchPrState;
}

/**
 * What the classifier asks GitHub. Both calls degrade to `available: false` instead of throwing;
 * the classifier then falls back to ancestry and reports `prStateKnown: false`.
 */
export interface BranchForge {
  /** States of the PRs runs CREATED (`pullRequestUrl`), by number — the ref-status cache. */
  prStates(repoRoot: string, numbers: number[]): Promise<{ available: boolean; states: Record<number, BranchPrState> }>;
  /** Every PR of the repository — one cached list. It names each branch with no
   *  `pullRequestUrl`, and carries the base and head that a `merged` verdict is checked against. */
  listPrs(repoRoot: string): Promise<{ available: boolean; prs: ForgePr[] }>;
}

function prStateOf(status: ReferenceStatus): BranchPrState {
  if (status === 'merged') return 'merged';
  if (status === 'closed') return 'closed';
  if (status === 'draft') return 'draft';
  return 'open';
}

const ghPrListSchema = z.array(
  z.object({
    number: z.number(),
    url: z.string(),
    headRefName: z.string(),
    baseRefName: z.string(),
    headRefOid: z.string(),
    mergeCommit: z.object({ oid: z.string() }).nullable().optional(),
    state: z.string(),
    isDraft: z.boolean().optional(),
  }),
);

const PR_LIST_TTL_MS = 60_000;
const PR_LIST_LIMIT = 500;
const prListCache = new Map<string, { at: number; value: { available: boolean; prs: ForgePr[] } }>();

/** The default forge: the existing ref-status cache for created PRs, plus one `gh pr list` per
 *  minute per repository for everything else. `CEZ_DRY_RUN=1` never shells out. */
export const githubBranchForge: BranchForge = {
  async prStates(repoRoot, numbers) {
    const states: Record<number, BranchPrState> = {};
    for (let i = 0; i < numbers.length; i += GH_REF_STATUS_MAX) {
      const data = await fetchGithubRefStatus(repoRoot, { prs: numbers.slice(i, i + GH_REF_STATUS_MAX) });
      if (!data.available) return { available: false, states };
      for (const [n, status] of Object.entries(data.prs)) states[Number(n)] = prStateOf(status);
    }
    return { available: true, states };
  },
  async listPrs(repoRoot) {
    if (process.env.CEZ_DRY_RUN === '1') return { available: true, prs: [] };
    const hit = prListCache.get(repoRoot);
    if (hit && Date.now() - hit.at < PR_LIST_TTL_MS) return hit.value;
    let value: { available: boolean; prs: ForgePr[] };
    try {
      const { stdout } = await exec(
        'gh',
        ['pr', 'list', '--state', 'all', '--limit', String(PR_LIST_LIMIT), '--json', 'number,headRefName,baseRefName,headRefOid,mergeCommit,state,isDraft,url'],
        { cwd: repoRoot, timeout: 15_000, maxBuffer: 16 * 1024 * 1024 },
      );
      const rows = ghPrListSchema.parse(JSON.parse(stdout));
      value = {
        available: true,
        prs: rows.map((row) => ({
          number: row.number,
          url: row.url,
          headRefName: row.headRefName,
          baseRefName: row.baseRefName,
          headRefOid: row.headRefOid,
          mergeCommitOid: row.mergeCommit?.oid ?? null,
          state: row.state === 'MERGED' ? 'merged' : row.state === 'CLOSED' ? 'closed' : row.isDraft ? 'draft' : 'open',
        })),
      };
    } catch {
      value = { available: false, prs: [] };
    }
    prListCache.set(repoRoot, { at: Date.now(), value });
    return value;
  },
};

/** Test-only: forget cached `gh pr list` answers. */
export function __clearPrListCacheForTests(): void {
  prListCache.clear();
}

// ---- classification ------------------------------------------------------------------------

export interface ClassifyInput {
  /** Repository top level (`RepoInfo.root`). */
  root: string;
  /** Every run that owns a branch (`RunStore.listBranchOwners`): the few fields read here. */
  runs: readonly BranchOwner[];
  /** The run manager's liveness — a run can be live while its record still says `done`. */
  isActive: (runId: string) => boolean;
  /** `config.baseBranch`, when the repo sets one. */
  configuredBase?: string | undefined;
  /** The main checkout's branch (`RepoInfo.branch`). */
  currentBranch: string;
  /** Whether the repo has a remote at all; without one the forge is not asked. */
  hasRemote: boolean;
  forge: BranchForge;
  /** Claims the runs owning a branch for the length of its delete, or returns null when one is in
   *  use (`RunManager.claimForBranchCleanup`). Absent, a delete trusts the classification alone. */
  claimRuns?: (runIds: readonly string[]) => (() => void) | null;
}

/** The project a classification reads: its root, its runs and the run manager's liveness. */
export interface ClassifyProject {
  root: string;
  store: Pick<RunStore, 'listBranchOwners'>;
  manager: Pick<RunManager, 'isActive' | 'claimForBranchCleanup'>;
}

/** What the branch classifier reads for one project, or null outside a repository. */
export async function classifyInputFor(project: ClassifyProject, forge: BranchForge): Promise<ClassifyInput | null> {
  const info = await getRepoInfo(project.root);
  if (!info) return null;
  const config = await loadConfig(project.root);
  return {
    root: info.root,
    runs: project.store.listBranchOwners(),
    isActive: (id) => project.manager.isActive(id),
    configuredBase: config.baseBranch,
    currentBranch: info.branch,
    hasRemote: Boolean(info.remote),
    forge,
    claimRuns: (ids) => project.manager.claimForBranchCleanup(ids),
  };
}

export interface Classification {
  payload: RepoBranchesResponse;
  /** The base as a commit, or null when it did not resolve (everything is then "not on base"). */
  baseSha: string | null;
  /** The fully qualified ref `baseSha` was read from, or null for a pinned sha — what a delete
   *  verifies is unchanged in the same ref transaction. */
  baseFullRef: string | null;
  /** Branch name → tip sha at classification time. */
  tips: Map<string, string>;
}

/** `symbolic`: the ref is an alias (`git symbolic-ref`) for another, so its name is not what a
 *  delete would remove. */
interface HeadRow { name: string; sha: string; at: string; subject: string; symbolic: boolean }

async function localHeads(root: string): Promise<HeadRow[]> {
  const res = await git(root, [
    'for-each-ref',
    'refs/heads',
    '--format=%(refname:lstrip=2)%00%(objectname)%00%(committerdate:iso-strict)%00%(symref)%00%(subject)',
  ]);
  if (!res.ok) return [];
  return res.stdout
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [name = '', sha = '', at = '', symref = '', ...rest] = line.split('\0');
      return { name, sha, at, subject: rest.join('\0'), symbolic: symref !== '' };
    })
    .filter((row) => row.name && row.sha);
}

/** Commits on each branch that the base cannot reach. One `for-each-ref` on git ≥ 2.41
 *  (`%(ahead-behind:…)`); a `rev-list --count` per branch otherwise. */
async function aheadCounts(root: string, heads: HeadRow[], baseSha: string | null): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (baseSha) {
    const batch = await git(root, ['for-each-ref', 'refs/heads', `--format=%(refname:lstrip=2)%00%(ahead-behind:${baseSha})`]);
    if (batch.ok) {
      for (const line of batch.stdout.split('\n')) {
        const [name = '', counts = ''] = line.split('\0');
        const ahead = Number(counts.split(' ')[0]);
        if (name && counts && Number.isFinite(ahead)) out.set(name, ahead);
      }
    }
  }
  await Promise.all(
    heads
      .filter((head) => !out.has(head.name))
      .map(async (head) => {
        const res = await git(root, ['rev-list', '--count', baseSha ? `${baseSha}..${head.sha}` : head.sha]);
        const n = Number(res.stdout.trim());
        // An unreadable count is never "0" — that would read as merged and become bulk-deletable.
        out.set(head.name, res.ok && Number.isFinite(n) ? n : Number.POSITIVE_INFINITY);
      }),
  );
  return out;
}

async function checkedOutBranches(root: string): Promise<Set<string>> {
  const res = await git(root, ['worktree', 'list', '--porcelain']);
  const out = new Set<string>();
  for (const line of res.stdout.split('\n')) {
    if (line.startsWith('branch refs/heads/')) out.add(line.slice('branch refs/heads/'.length));
  }
  return out;
}

/** The branch a run owns: its recorded `branch`, or `cez/<id8>` for an old worktree run — the
 *  store's `branch` column already says which (`encodeRunRow`). */
function runBranch(run: BranchOwner): string | undefined {
  return run.branch;
}

function isFinished(run: BranchOwner): boolean {
  return FINISHED.has(run.status) || run.archived === true;
}

function creationSha(sha: string, subject: string): string | null {
  return sha && /^branch: Created from /.test(subject) ? sha : null;
}

/** Refs per bulk reflog read: keeps the argument list far under any platform's limit. */
const REFLOG_CHUNK = 256;

/**
 * Where each run forked: a pinned sha, or the branch's creation entry in its reflog. Only an entry
 * git wrote as a creation counts: once older entries expire, the oldest SURVIVING one can be a task
 * commit, and reading that as the fork point would call committed work "empty".
 *
 * One `git log -g` per chunk of branches, never one per branch (hearsay-tools/cezarion#2029). git
 * walks every named reflog and prints each entry once, in date order, so entries are matched by
 * their `refs/heads/<name>@{n}` selector, and the oldest is the highest `n`. A ref with no reflog
 * prints nothing: no fork point. A chunk that fails (a branch deleted since it was listed) is read
 * again one branch at a time, and a single branch that still fails has no fork point.
 */
export async function forkPoints(
  root: string,
  wanted: ReadonlyArray<{ run: BranchOwner; branch: string }>,
  chunkSize = REFLOG_CHUNK,
): Promise<Map<string, string | null>> {
  const out = new Map<string, string | null>();
  const walk: Array<{ run: BranchOwner; branch: string }> = [];
  for (const item of wanted) {
    if (item.run.baseBranch && FULL_SHA.test(item.run.baseBranch)) out.set(item.branch, item.run.baseBranch);
    else walk.push(item);
  }
  const chunks: Array<typeof walk> = [];
  for (let i = 0; i < walk.length; i += chunkSize) chunks.push(walk.slice(i, i + chunkSize));
  await Promise.all(chunks.map(async (chunk) => {
    const res = await git(root, ['log', '-g', '--format=%gD%x1f%H%x1f%gs', ...chunk.map((item) => `refs/heads/${item.branch}`), '--']);
    if (!res.ok && chunk.length > 1) {
      for (const [branch, fork] of await forkPoints(root, chunk, 1)) out.set(branch, fork);
      return;
    }
    const oldest = new Map<string, { n: number; sha: string; subject: string }>();
    for (const line of res.stdout.split('\n')) {
      const [selector = '', sha = '', ...rest] = line.split('\x1f');
      // `@{` cannot appear in a ref name, so the last one starts the selector's index. The index
      // form is git's default; only an explicit `--date` prints a date there.
      const at = selector.lastIndexOf('@{');
      const n = Number(selector.slice(at + 2, -1));
      if (at < 0 || !selector.startsWith('refs/heads/') || !Number.isInteger(n)) continue;
      const branch = selector.slice('refs/heads/'.length, at);
      const seen = oldest.get(branch);
      if (!seen || n > seen.n) oldest.set(branch, { n, sha, subject: rest.join('\x1f') });
    }
    for (const { branch } of chunk) {
      const entry = oldest.get(branch);
      out.set(branch, entry ? creationSha(entry.sha, entry.subject) : null);
    }
  }));
  return out;
}

/**
 * The base as a FULLY QUALIFIED ref and its commit. `freshestBaseRef`'s rule (origin/<base> when
 * the local branch is behind it), but never through an unqualified name: git resolves `main` to a
 * tag `refs/tags/main` before `refs/heads/main`, and a tag at an unlanded tip would make its work
 * read as merged — bulk-deletable. A pinned sha stays a sha.
 */
async function resolveBase(root: string, base: string): Promise<{ ref: string; fullRef: string | null; sha: string | null }> {
  const at = async (ref: string) => {
    const res = await git(root, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
    return res.ok ? res.stdout.trim() || null : null;
  };
  if (FULL_SHA.test(base)) return { ref: base, fullRef: null, sha: await at(base) };
  // A detached main checkout with no configured base: `RepoInfo.branch` is the literal `HEAD`, which
  // names no branch. The base is then the checkout's commit, and a delete verifies HEAD still holds
  // it (`--no-deref`: a HEAD switched back onto a branch is symbolic again, and refuses).
  if (base === 'HEAD') {
    const sha = (await git(root, ['symbolic-ref', '-q', 'HEAD'])).ok ? null : await at('HEAD');
    return { ref: 'HEAD', fullRef: sha ? 'HEAD' : null, sha };
  }
  if (!isSafeGitRef(base)) return { ref: base, fullRef: null, sha: null };
  const name = base.startsWith('origin/') ? base.slice('origin/'.length) : base;
  // A symbolic base is an alias for some other branch — possibly one about to be deleted — and a
  // `--no-deref` verify of the alias protects nothing it points at. It resolves to nothing, so
  // every branch reads "not on base": the safe direction.
  const direct = async (ref: string) => ((await git(root, ['symbolic-ref', '-q', ref])).ok ? null : at(ref));
  const local = base.startsWith('origin/') ? null : await direct(`refs/heads/${name}`);
  const remote = await direct(`refs/remotes/origin/${name}`);
  // Exits 0 iff local is equal to or ahead of origin — local then carries unpushed base commits.
  if (local && (!remote || (await git(root, ['merge-base', '--is-ancestor', remote, local])).ok)) {
    return { ref: name, fullRef: `refs/heads/${name}`, sha: local };
  }
  if (remote) return { ref: `origin/${name}`, fullRef: `refs/remotes/origin/${name}`, sha: remote };
  return { ref: base, fullRef: null, sha: null };
}

/** A local or remote-tracking ref OUTSIDE `excluded` (full ref names) that also reaches `sha`, with
 *  its own tip — the witness a delete verifies in its transaction — or null when none does. */
async function retainingRef(
  run: (args: string[]) => Promise<GitResult>,
  sha: string,
  excluded: ReadonlySet<string>,
): Promise<{ ref: string; sha: string } | null> {
  const res = await run(['for-each-ref', '--contains', sha, '--format=%(refname)%00%(objectname)%00%(symref)', 'refs/heads', 'refs/remotes']);
  if (!res.ok) return null;
  for (const line of res.stdout.split('\n')) {
    const [ref = '', tip = '', symref = ''] = line.split('\0');
    // Never an alias (origin/HEAD, a symbolic branch): it may point at the very branch being
    // deleted, and a `--no-deref` verify of its name protects nothing it points at.
    if (ref && tip && !symref && !excluded.has(ref)) return { ref, sha: tip };
  }
  return null;
}

/** The PR a row SHOWS: one at the branch's current tip first, then an open one, then the newest.
 *  A reused branch keeps its old merged PR in the list; showing that over the open PR carrying the
 *  current work would file the row under "No pull request" and offer a duplicate. Display only —
 *  the `merged` verdict reads every PR on its own terms. */
function pickPr(prs: ForgePr[], tip: string): ForgePr | null {
  const rank = (pr: ForgePr) =>
    (pr.headRefOid === tip ? 4 : 0) + (pr.state === 'open' || pr.state === 'draft' ? 2 : pr.state === 'merged' ? 1 : 0);
  return [...prs].sort((a, b) => rank(b) - rank(a) || b.number - a.number)[0] ?? null;
}

/** Three-dot diff stats by repository, attribute state, base sha and tip sha. The diff pins the
 *  options a checkout's config can change for a commit-to-commit stat (rename detection and its
 *  limit, at git's default of 1000, the algorithm, external and textconv drivers). The attribute
 *  files git reads (`info/attributes`, the root `.gitattributes`, the global attributes file) are
 *  part of the key, and an entry expires after `DIFF_STAT_TTL_MS`, which bounds what no key part
 *  sees, such as a nested `.gitattributes`. Bounded, oldest first out. */
const DIFF_STAT_CACHE_MAX = 5_000;
const DIFF_STAT_TTL_MS = 5 * 60_000;
const diffStatCache = new Map<string, { at: number; value: NonNullable<RepoBranchEntry['diffStat']> }>();
const DIFF_STAT_ARGS = ['diff', '--shortstat', '--find-renames', '-l1000', '--diff-algorithm=myers', '--no-ext-diff', '--no-textconv'];

/** A hash of the attribute files that decide how a path diffs in this checkout. */
async function attributeState(root: string): Promise<string> {
  const [local, global] = await Promise.all([
    git(root, ['rev-parse', '--git-path', 'info/attributes']),
    git(root, ['config', '--path', '--get', 'core.attributesFile']),
  ]);
  const files = [
    local.ok ? resolvePath(root, local.stdout.trim()) : '',
    joinPath(root, '.gitattributes'),
    global.ok ? global.stdout.trim() : joinPath(process.env.XDG_CONFIG_HOME || joinPath(homedir(), '.config'), 'git', 'attributes'),
  ];
  const contents = await Promise.all(files.map((file) => readFile(file, 'utf8').catch(() => '')));
  return createHash('sha256').update(JSON.stringify(contents)).digest('hex');
}

/** The diff stat of `<baseSha>...<tip>` in `root`. The attribute state is read once per reader,
 *  that is once per scan, and only when a stat is asked for. */
function diffStatReader(root: string, baseSha: string | null): (tip: string) => Promise<RepoBranchEntry['diffStat']> {
  let state: Promise<string> | undefined;
  return async (tip) => {
    if (!baseSha) return null;
    state ??= attributeState(root);
    const key = `${root}\0${await state}\0${baseSha}\0${tip}`;
    const hit = diffStatCache.get(key);
    if (hit && Date.now() - hit.at < DIFF_STAT_TTL_MS) return hit.value;
    const res = await git(root, [...DIFF_STAT_ARGS, `${baseSha}...${tip}`]);
    if (!res.ok) return null;
    const stat = parseShortstat(res.stdout);
    const value = { additions: stat.adds, deletions: stat.dels };
    diffStatCache.delete(key);
    diffStatCache.set(key, { at: Date.now(), value });
    if (diffStatCache.size > DIFF_STAT_CACHE_MAX) diffStatCache.delete(diffStatCache.keys().next().value as string);
    return value;
  };
}

export interface ClassifyOptions {
  /** Compute each not-landed row's diff stat (the default). Off for the counts and for a delete,
   *  which read none. */
  diffStats?: boolean;
}

export async function classifyBranches(input: ClassifyInput, options?: ClassifyOptions): Promise<Classification> {
  const { root } = input;
  const base = input.configuredBase ?? input.currentBranch;
  const { ref: baseRef, fullRef: baseFullRef, sha: baseSha } = await resolveBase(root, base);

  const [heads, checkedOut, protection] = await Promise.all([
    localHeads(root),
    checkedOutBranches(root),
    ownedCleanupProtection(root),
  ]);
  const ahead = await aheadCounts(root, heads, baseSha);

  const runsByBranch = new Map<string, BranchOwner[]>();
  for (const run of input.runs) {
    const branch = runBranch(run);
    if (!branch) continue;
    runsByBranch.set(branch, [...(runsByBranch.get(branch) ?? []), run]);
  }
  const liveRun = (run: BranchOwner) => input.isActive(run.id) || !isFinished(run);
  const representative = (runs: BranchOwner[] | undefined): BranchOwner | undefined =>
    runs?.find(liveRun) ?? runs?.slice().sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))[0];

  interface Draft { head: HeadRow; run?: BranchOwner; cls: BranchClass | null; ahead: number }
  const drafts: Draft[] = heads.map((head) => {
    const runs = runsByBranch.get(head.name);
    const run = representative(runs);
    const task = head.name.startsWith(TASK_PREFIX);
    const count = ahead.get(head.name) ?? Number.POSITIVE_INFINITY;
    const inUse =
      head.name === input.currentBranch ||
      head.name === base ||
      checkedOut.has(head.name) ||
      protection.branches.has(head.name) ||
      (task && protection.uncertain) ||
      (runs?.some(liveRun) ?? false);
    // A symbolic alias is never a task branch, whatever its name says: deleting it by name would
    // follow it to the branch it points at, which was classified (and protected) on its own.
    const cls: BranchClass | null = inUse ? 'active' : task && !head.symbolic ? null : 'other';
    return { head, ...(run ? { run } : {}), cls, ahead: count };
  });

  // Empty before merged: a run whose branch still sits on its fork point never committed.
  const emptyCandidates = drafts.filter((d) => d.cls === null && d.run);
  const forks = await forkPoints(root, emptyCandidates.map((d) => ({ run: d.run as BranchOwner, branch: d.head.name })));
  await Promise.all(
    emptyCandidates
      .map(async (d) => {
        if (forks.get(d.head.name) !== d.head.sha) return;
        if (d.ahead === 0 || (await retainingRef((args) => git(root, args), d.head.sha, new Set([`refs/heads/${d.head.name}`]))) !== null) d.cls = 'empty';
      }),
  );
  for (const d of drafts) if (d.cls === null && d.ahead === 0) d.cls = 'merged';

  // PR state only decides the rows ancestry left open; everything else is display.
  const pending = drafts.filter((d) => d.cls === null);
  const prByBranch = new Map<string, RepoBranchEntry['pr']>();
  let prStateKnown = true;
  const mergedByPr = new Set<string>();
  const taskRows = drafts.filter((d) => d.head.name.startsWith(TASK_PREFIX));
  if (pending.length > 0) {
    if (!input.hasRemote) {
      prStateKnown = false;
    } else {
      const created = new Map<number, { url: string; branch: string }>();
      const needList: Draft[] = [];
      for (const d of taskRows) {
        const url = d.run?.pullRequestUrl;
        const n = url ? refNumberFromUrl(url) : null;
        if (url && n !== null) created.set(n, { url, branch: d.head.name });
        else needList.push(d);
      }
      const states = created.size > 0
        ? await input.forge.prStates(root, [...created.keys()])
        : { available: true, states: {} as Record<number, BranchPrState> };
      if (!states.available) prStateKnown = false;
      for (const [n, { url, branch }] of created) {
        const state = states.states[n];
        if (state) prByBranch.set(branch, { number: n, url, state });
      }
      // A merged state alone proves nothing (below), so the list is also needed whenever a
      // created PR reports merged — it carries the base and head the verdict is checked against.
      // A SETTLED recorded PR can also be obsolete: the branch was reused and a newer PR carries
      // its current work, so the list is read for those rows' display as well.
      const settled = (state: BranchPrState | undefined) => state === 'merged' || state === 'closed';
      const recordedSettled = pending.filter((d) => created.size > 0 && settled(prByBranch.get(d.head.name)?.state));
      const list = needList.length > 0 || recordedSettled.length > 0
        ? await input.forge.listPrs(root)
        : { available: true, prs: [] as ForgePr[] };
      if (!list.available) prStateKnown = false;
      const byHead = new Map<string, ForgePr[]>();
      for (const pr of list.prs) byHead.set(pr.headRefName, [...(byHead.get(pr.headRefName) ?? []), pr]);
      for (const d of [...needList, ...recordedSettled]) {
        const pr = pickPr(byHead.get(d.head.name) ?? [], d.head.sha);
        const recorded = prByBranch.get(d.head.name);
        // A recorded PR is replaced only by one that is open, or that sits at the current tip.
        if (!pr || (recorded && pr.number !== recorded.number && pr.headRefOid !== d.head.sha && settled(pr.state))) continue;
        prByBranch.set(d.head.name, { number: pr.number, url: pr.url, state: pr.state });
      }
      // A merged PR lands the tip only when it targeted this base, merged this very commit, AND its
      // merge is on the base as this classification reads it: one into another branch, a branch
      // that gained commits after its PR merged, or a base reset (or never fetched) past the merge
      // all leave work the base lacks, and `merged` would make that work bulk-deletable.
      const onBase = async (sha: string | null) =>
        !!sha && !!baseSha && FULL_SHA.test(sha) && (await git(root, ['merge-base', '--is-ancestor', sha, baseSha])).ok;
      for (const d of pending) {
        for (const pr of byHead.get(d.head.name) ?? []) {
          if (pr.state !== 'merged' || pr.baseRefName !== base.replace(/^origin\//, '') || pr.headRefOid !== d.head.sha) continue;
          if (await onBase(pr.mergeCommitOid)) {
            mergedByPr.add(d.head.name);
            break;
          }
        }
      }
    }
  }
  for (const d of pending) {
    if (mergedByPr.has(d.head.name)) d.cls = 'merged';
    else d.cls = d.run ? 'not-landed' : 'orphan';
  }

  const statOf = diffStatReader(root, baseSha);
  const branches: RepoBranchEntry[] = await Promise.all(
    drafts.map(async (d) => {
      const cls = d.cls as BranchClass;
      const stat = options?.diffStats !== false && (cls === 'not-landed' || cls === 'orphan')
        ? await statOf(d.head.sha)
        : null;
      return {
        name: d.head.name,
        class: cls,
        runId: d.run?.id ?? null,
        title: d.run ? d.run.title ?? d.run.id : null,
        runStatus: d.run?.status ?? null,
        ahead: Number.isFinite(d.ahead) ? d.ahead : 0,
        lastCommit: { sha: d.head.sha, subject: d.head.subject, at: d.head.at },
        diffStat: stat,
        pr: prByBranch.get(d.head.name) ?? null,
      };
    }),
  );
  branches.sort((a, b) => (a.lastCommit.at < b.lastCommit.at ? 1 : a.lastCommit.at > b.lastCommit.at ? -1 : a.name.localeCompare(b.name)));

  const count = (...classes: BranchClass[]) => branches.filter((b) => classes.includes(b.class)).length;
  return {
    payload: {
      base: baseRef,
      prStateKnown,
      branches,
      counts: { notLanded: count('not-landed', 'orphan'), cleanup: count('merged', 'empty') },
    },
    baseSha,
    baseFullRef,
    tips: new Map(heads.map((h) => [h.name, h.sha])),
  };
}

// ---- the cache -----------------------------------------------------------------------------

/** PR state can change with no local ref moving (a merge on GitHub), so the cache also ages out
 *  on the forge's own cadence. */
const BRANCHES_TTL_MS = 60_000;
/** The latest scan per repository. `full` carries diff stats; a `counts` scan does not, so it
 *  answers only the counts route. */
const branchesCache = new Map<string, { key: string; at: number; full: boolean; value: RepoBranchesResponse }>();
/** Per repository: the end of the scan queue, so one scan runs at a time. */
const scanTail = new Map<string, Promise<unknown>>();
/** Scans running or queued, by repository, kind and state key: an equal request joins one. */
const scansInFlight = new Map<string, Promise<RepoBranchesResponse>>();

/** What the answer depends on, hashed: every local and remote-tracking ref, the registered
 *  worktrees, the configured base, and the run fields the classes read. */
async function stateKey(input: ClassifyInput): Promise<string> {
  const [refs, worktrees] = await Promise.all([
    git(input.root, ['for-each-ref', '--format=%(objectname) %(refname)', 'refs/heads', 'refs/remotes']),
    git(input.root, ['worktree', 'list', '--porcelain']),
  ]);
  const runs = input.runs.map((r) => [
    r.id, r.status, r.archived, r.branch, r.baseBranch, r.pullRequestUrl, r.title, input.isActive(r.id),
  ]);
  return createHash('sha256')
    .update(JSON.stringify([refs.stdout, worktrees.stdout, input.configuredBase, input.currentBranch, input.hasRemote, runs]))
    .digest('hex');
}

function cachedScan(root: string, key: string, full: boolean): RepoBranchesResponse | null {
  const hit = branchesCache.get(root);
  return hit && hit.key === key && (hit.full || !full) && Date.now() - hit.at < BRANCHES_TTL_MS ? hit.value : null;
}

/**
 * The classification for `key`, from the cache, from an equal scan already running or queued, or
 * from a new scan queued behind the repository's current one. A burst of requests thus runs at
 * most one scan at a time per repository, and equal requests share it (hearsay-tools/cezarion#2029).
 */
async function scan(input: ClassifyInput, full: boolean): Promise<RepoBranchesResponse> {
  const { root } = input;
  const key = await stateKey(input);
  const cached = cachedScan(root, key, full);
  if (cached) return cached;
  const id = (kind: string) => `${root}\0${kind}\0${key}`;
  const joined = scansInFlight.get(id('full')) ?? (full ? undefined : scansInFlight.get(id('counts')));
  if (joined) return joined;
  const run = (scanTail.get(root) ?? Promise.resolve()).then(async () => {
    // The scan ahead of this one may have answered it.
    const ready = cachedScan(root, key, full);
    if (ready) return ready;
    const { payload } = await classifyBranches(input, { diffStats: full });
    // A counts scan never replaces a full answer for the same state.
    if (full || !cachedScan(root, key, true)) branchesCache.set(root, { key, at: Date.now(), full, value: payload });
    return payload;
  });
  const tail = run.catch(() => undefined);
  scanTail.set(root, tail);
  scansInFlight.set(id(full ? 'full' : 'counts'), run);
  void tail.then(() => {
    scansInFlight.delete(id(full ? 'full' : 'counts'));
    if (scanTail.get(root) === tail) scanTail.delete(root);
  });
  return run;
}

/** `GET /repo/branches`: the classification, cached on the refs state. */
export function readRepoBranches(input: ClassifyInput): Promise<RepoBranchesResponse> {
  return scan(input, true);
}

/** `GET /repo/branches/counts`: the classification's counts, with no diff stat per branch, and
 *  the All branches count — `GET /repo`'s names plus every local branch, as the list joins them. */
export async function readRepoBranchCounts(input: ClassifyInput): Promise<RepoBranchCountsResponse> {
  const [{ base, prStateKnown, counts, branches }, switchable] = await Promise.all([scan(input, false), getBranches(input.root)]);
  const names = new Set([...switchable, ...branches.map((entry) => entry.name)]);
  return { base, prStateKnown, counts, allBranches: names.size };
}

/** Drop the cached classification — after any mutation this server makes. */
export function forgetRepoBranches(root: string): void {
  branchesCache.delete(root);
  for (const key of diffStatCache.keys()) if (key.startsWith(`${root}\0`)) diffStatCache.delete(key);
}

// ---- deletion ------------------------------------------------------------------------------

export interface DeleteBranchesResult {
  deleted: string[];
  refused: Array<{ name: string; reason: string }>;
  dropped?: Array<{ sha: string; subject: string }>;
}

const DROPPED_CAP = 100;

/**
 * Delete from fresh classification under mutation and cleanup claims. Verify base and tip
 * atomically; recheck checkout/receipt protection. Retention refs must be outside this request.
 * Unlanded work requires a single exact-name confirmation. Never throw.
 */
export async function deleteBranches(
  input: ClassifyInput,
  requested: string[],
  confirm?: string,
): Promise<DeleteBranchesResult> {
  const names = [...new Set(requested)];
  const { payload, tips, baseSha, baseFullRef } = await classifyBranches(input, { diffStats: false });
  const byName = new Map(payload.branches.map((b) => [b.name, b]));
  const alone = names.length === 1;
  const refused: DeleteBranchesResult['refused'] = [];
  const candidates: Array<{ name: string; tip: string; drops: boolean; keptElsewhere?: true }> = [];
  for (const name of names) {
    const entry = byName.get(name);
    const tip = tips.get(name);
    if (!entry || !tip) {
      refused.push({ name, reason: 'no such local branch' });
      continue;
    }
    switch (entry.class) {
      case 'active':
        refused.push({ name, reason: 'in use — a live or reviewable task, a checkout, or the base branch' });
        break;
      case 'other':
        refused.push({ name, reason: 'not a cezar task branch' });
        break;
      case 'not-landed':
      case 'orphan':
        if (!alone) refused.push({ name, reason: `has ${entry.ahead} commit(s) not on ${payload.base} — delete it on its own, with confirmation` });
        else if (confirm !== name) refused.push({ name, reason: 'type the branch name to confirm deleting work that is not on the base' });
        else candidates.push({ name, tip, drops: true });
        break;
      case 'merged':
        candidates.push({ name, tip, drops: false });
        break;
      case 'empty':
        // Ahead of the base yet empty: another ref holds its commits, which must outlive this delete.
        candidates.push({ name, tip, drops: false, ...(entry.ahead > 0 ? { keptElsewhere: true as const } : {}) });
        break;
    }
  }
  const deleted: string[] = [];
  let dropped: DeleteBranchesResult['dropped'];
  // Claimed before the lock and held through the ref transaction, so no Continue is admitted
  // between the verdict and the delete.
  const releases: Array<() => void> = [];
  for (const candidate of [...candidates]) {
    if (!input.claimRuns) break;
    const owners = input.runs.filter((run) => runBranch(run) === candidate.name).map((run) => run.id);
    const release = input.claimRuns(owners);
    if (release) {
      releases.push(release);
      continue;
    }
    candidates.splice(candidates.indexOf(candidate), 1);
    refused.push({ name: candidate.name, reason: 'its task is running or being continued — try again once it settles' });
  }
  if (candidates.length > 0) {
    try {
      await withWorktreeMutation(input.root, async (lockedGit) => {
        const protection = await ownedCleanupProtection(input.root);
        const checkedOut = await checkedOutBranches(input.root);
        const requestedRefs = new Set(candidates.map((c) => `refs/heads/${c.name}`));
        for (const candidate of candidates) {
          const { name } = candidate;
          if (protection.uncertain || protection.branches.has(name)) {
            refused.push({ name, reason: 'owned by a delegated workspace' });
            continue;
          }
          if (checkedOut.has(name)) {
            refused.push({ name, reason: 'checked out in a worktree' });
            continue;
          }
          const witness = candidate.keptElsewhere ? await retainingRef((args) => lockedGit(input.root, args), candidate.tip, requestedRefs) : null;
          if (candidate.keptElsewhere && !witness) {
            refused.push({ name, reason: `its commits are not on ${payload.base} and only branches in this request keep them — delete it on its own, with confirmation` });
            continue;
          }
          let commits: Array<{ sha: string; subject: string }> | undefined;
          if (candidate.drops) {
            const log = await lockedGit(input.root, [
              'log', `-${DROPPED_CAP}`, '--format=%H%x1f%s', baseSha ? `${baseSha}..${candidate.tip}` : candidate.tip,
            ]);
            commits = log.stdout.split('\n').filter(Boolean).map((line) => {
              const [sha = '', subject = ''] = line.split('\x1f');
              return { sha, subject };
            });
          }
          // Not `git branch -D`: a squash-merged branch is not an ancestor of the base, and only a
          // ref transaction can make "the base did not move" — and, for an empty branch, "the ref
          // that keeps its commits did not move" — part of the same atomic step.
          const transaction = [
            ...(baseFullRef && baseSha ? [`verify ${baseFullRef} ${baseSha}`] : []),
            ...(witness ? [`verify ${witness.ref} ${witness.sha}`] : []),
            `delete refs/heads/${name} ${candidate.tip}`,
          ].join('\n') + '\n';
          // `--no-deref`, and a symbolic ref refused outright: the transaction may only ever remove the
          // exact ref that was classified and named, never one an alias points at.
          if ((await lockedGit(input.root, ['symbolic-ref', '-q', `refs/heads/${name}`])).ok) {
            refused.push({ name, reason: 'not a cezar task branch' });
            continue;
          }
          const res = await lockedGit(input.root, ['update-ref', '--no-deref', '--stdin'], undefined, transaction);
          if (!res.ok) {
            refused.push({ name, reason: `it, ${payload.base} or the branch that keeps its commits changed since it was classified — refresh and try again` });
            continue;
          }
          // What `branch -D` also drops; absent for most task branches, so a failure is expected.
          await lockedGit(input.root, ['config', '--remove-section', `branch.${name}`]);
          deleted.push(name);
          if (commits) dropped = commits;
        }
      });
    } catch {
      const done = new Set([...deleted, ...refused.map((r) => r.name)]);
      for (const { name } of candidates) {
        if (!done.has(name)) refused.push({ name, reason: 'the repository is busy — try again' });
      }
    }
    forgetRepoBranches(input.root);
  }
  for (const release of releases) release();
  return { deleted, refused, ...(dropped ? { dropped } : {}) };
}

// ---- log attribution -----------------------------------------------------------------------

export interface LogSource { runId: string; title: string; prNumber: number | null }

const MERGE_PR = /^Merge pull request #(\d+) from [^/\s]+\/(\S+)/;
const MERGE_BRANCH = /^Merge (?:remote-tracking )?branch '([^']+)'/;
const SQUASH_PR = /\(#(\d+)\)\s*$/;

/**
 * Best-effort task attribution for base-branch commits (issue 08 §B5). A merge commit maps its
 * second parent to a run by `branch` (through any ref still pointing at it, else the branch its
 * subject names); a squash commit maps its trailing `(#123)` to a run by `pullRequestUrl`.
 * Commits nothing maps stay unattributed — `null` in the returned list, never a guess.
 */
export async function attributeLog(
  root: string,
  entries: readonly LogEntryWithParents[],
  runs: readonly BranchOwner[],
): Promise<Array<LogSource | null>> {
  if (runs.length === 0) return entries.map(() => null);
  const byBranch = new Map<string, BranchOwner>();
  const byPr = new Map<number, BranchOwner>();
  for (const run of runs) {
    const branch = runBranch(run);
    if (branch) byBranch.set(branch, run);
    const n = run.pullRequestUrl ? refNumberFromUrl(run.pullRequestUrl) : null;
    if (n !== null) byPr.set(n, run);
  }
  // One scan, shared by every entry: the entries are attributed concurrently, so the cache holds
  // the PROMISE — a map published before it was filled let later merge rows read it empty.
  let tips: Promise<Map<string, string[]>> | undefined;
  const refsAt = async (sha: string): Promise<string[]> => {
    tips ??= git(root, ['for-each-ref', '--format=%(objectname) %(refname:lstrip=2)', 'refs/heads', 'refs/remotes']).then((res) => {
      const map = new Map<string, string[]>();
      for (const line of res.stdout.split('\n')) {
        const [objectname = '', ref = ''] = line.split(' ');
        if (objectname && ref) map.set(objectname, [...(map.get(objectname) ?? []), ref.replace(/^[^/]+\/(?=cez\/)/, '')]);
      }
      return map;
    });
    return (await tips).get(sha) ?? [];
  };
  const source = (run: BranchOwner, prNumber: number | null): LogSource => ({
    runId: run.id,
    title: run.title ?? run.id,
    prNumber: prNumber ?? (run.pullRequestUrl ? refNumberFromUrl(run.pullRequestUrl) : null),
  });
  return Promise.all(
    entries.map(async (entry) => {
      const mergePr = MERGE_PR.exec(entry.subject);
      const prNumber = mergePr ? Number(mergePr[1]) : null;
      if (entry.parents.length >= 2) {
        // What the merge itself recorded comes first — the PR a task opened, then the branch the
        // subject names. A ref at the second parent is only a fallback: a later task branched at
        // that tip points there too, without having produced any of the work.
        if (prNumber !== null && byPr.has(prNumber)) return source(byPr.get(prNumber) as BranchOwner, prNumber);
        const named = mergePr?.[2] ?? MERGE_BRANCH.exec(entry.subject)?.[1];
        const run = named ? byBranch.get(named.replace(/^origin\//, '')) : undefined;
        if (run) return source(run, prNumber);
        for (const ref of await refsAt(entry.parents[1] as string)) {
          const atTip = byBranch.get(ref);
          if (atTip) return source(atTip, prNumber);
        }
        return null;
      }
      const squash = SQUASH_PR.exec(entry.subject);
      if (squash) {
        const run = byPr.get(Number(squash[1]));
        if (run) return source(run, Number(squash[1]));
      }
      return null;
    }),
  );
}

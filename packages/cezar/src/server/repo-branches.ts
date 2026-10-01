/**
 * Branch classification and safe cleanup for the Git view (issue 08 §A/§B).
 *
 * Every local branch is classified once, here, and the cockpit only renders the answer:
 * `active` (in use — never deletable), `not-landed` / `orphan` (work that exists nowhere else on
 * the base — deletable one at a time, with a typed confirmation), `merged` / `empty` (safe — bulk),
 * `other` (the user's own branches — never touched from this surface). The invariant the Cleanup
 * page states — "nothing here can delete work that is not on main" — is enforced by
 * `deleteBranches` re-classifying at delete time and trusting nothing the client says.
 *
 * Git is read with a never-throwing runner (the git-worktree helper discipline). The forge is an
 * injectable seam so the classifier is testable against real temp repositories without `gh`; the
 * default one degrades to `available: false` — ancestry-only classification, `prStateKnown:
 * false` — whenever GitHub cannot answer.
 */
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { z } from 'zod';
import type { BranchClass, BranchPrState, RepoBranchEntry, RepoBranchesResponse } from '@open-mercato/cezar-contract';
import { isSafeGitRef } from '../git-refs.ts';
import { withWorktreeMutation } from '../git-worktree-lock.ts';
import { branchFor, ownedCleanupProtection, parseShortstat } from '../git-worktree.ts';
import type { RunRecord, RunStatus } from '../runs/store.ts';
import { fetchGithubRefStatus, GH_REF_STATUS_MAX, refNumberFromUrl, type ReferenceStatus } from './github.ts';
import type { LogEntryWithParents } from './git.ts';

const exec = promisify(execFile);

interface GitResult { ok: boolean; stdout: string; stderr: string }

function git(cwd: string, args: string[]): Promise<GitResult> {
  return new Promise((resolve) => {
    execFile('git', args, { cwd, maxBuffer: 32 * 1024 * 1024, encoding: 'utf8' }, (err, stdout, stderr) =>
      resolve({ ok: !err, stdout: stdout ?? '', stderr: stderr ?? '' }),
    );
  });
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
  runs: readonly RunRecord[];
  /** The run manager's liveness — a run can be live while its record still says `done`. */
  isActive: (runId: string) => boolean;
  /** `config.baseBranch`, when the repo sets one. */
  configuredBase?: string | undefined;
  /** The main checkout's branch (`RepoInfo.branch`). */
  currentBranch: string;
  /** Whether the repo has a remote at all; without one the forge is not asked. */
  hasRemote: boolean;
  forge: BranchForge;
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

interface HeadRow { name: string; sha: string; at: string; subject: string }

async function localHeads(root: string): Promise<HeadRow[]> {
  const res = await git(root, [
    'for-each-ref',
    'refs/heads',
    '--format=%(refname:short)%00%(objectname)%00%(committerdate:iso-strict)%00%(subject)',
  ]);
  if (!res.ok) return [];
  return res.stdout
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [name = '', sha = '', at = '', subject = ''] = line.split('\0');
      return { name, sha, at, subject };
    })
    .filter((row) => row.name && row.sha);
}

/** Commits on each branch that the base cannot reach. One `for-each-ref` on git ≥ 2.41
 *  (`%(ahead-behind:…)`); a `rev-list --count` per branch otherwise. */
async function aheadCounts(root: string, heads: HeadRow[], baseSha: string | null): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (baseSha) {
    const batch = await git(root, ['for-each-ref', 'refs/heads', `--format=%(refname:short)%00%(ahead-behind:${baseSha})`]);
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

/** The branch a run owns: its recorded `branch`, or `cez/<id8>` for an old worktree run. */
function runBranch(run: RunRecord): string | undefined {
  return run.branch ?? (run.worktreePath ? branchFor(run.id) : undefined);
}

function isFinished(run: RunRecord): boolean {
  return FINISHED.has(run.status) || run.archived === true;
}

/** Where the run forked: a pinned sha, or the branch's creation entry in its reflog. Only an entry
 *  git wrote as a creation counts: once older entries expire, the oldest SURVIVING one can be a
 *  task commit, and reading that as the fork point would call committed work "empty". */
async function forkPoint(root: string, run: RunRecord, branch: string): Promise<string | null> {
  if (run.baseBranch && FULL_SHA.test(run.baseBranch)) return run.baseBranch;
  const res = await git(root, ['log', '-g', '--format=%H%x1f%gs', `refs/heads/${branch}`]);
  const oldest = res.ok ? res.stdout.trim().split('\n').filter(Boolean).at(-1) : undefined;
  const [sha = '', subject = ''] = oldest?.split('\x1f') ?? [];
  return sha && /^branch: Created from /.test(subject) ? sha : null;
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
  if (!isSafeGitRef(base)) return { ref: base, fullRef: null, sha: null };
  const name = base.startsWith('origin/') ? base.slice('origin/'.length) : base;
  const local = base.startsWith('origin/') ? null : await at(`refs/heads/${name}`);
  const remote = await at(`refs/remotes/origin/${name}`);
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
  const res = await run(['for-each-ref', '--contains', sha, '--format=%(refname)%00%(objectname)', 'refs/heads', 'refs/remotes']);
  if (!res.ok) return null;
  for (const line of res.stdout.split('\n')) {
    const [ref = '', tip = ''] = line.split('\0');
    // A symbolic ref (origin/HEAD) cannot be verified by its own name in a transaction.
    if (ref && tip && !excluded.has(ref) && !ref.endsWith('/HEAD')) return { ref, sha: tip };
  }
  return null;
}

function pickPr(prs: ForgePr[]): ForgePr | null {
  const rank = (pr: ForgePr) => (pr.state === 'merged' ? 3 : pr.state === 'open' || pr.state === 'draft' ? 2 : 1);
  return [...prs].sort((a, b) => rank(b) - rank(a) || b.number - a.number)[0] ?? null;
}

export async function classifyBranches(input: ClassifyInput): Promise<Classification> {
  const { root } = input;
  const base = input.configuredBase ?? input.currentBranch;
  const { ref: baseRef, fullRef: baseFullRef, sha: baseSha } = await resolveBase(root, base);

  const [heads, checkedOut, protection] = await Promise.all([
    localHeads(root),
    checkedOutBranches(root),
    ownedCleanupProtection(root),
  ]);
  const ahead = await aheadCounts(root, heads, baseSha);

  const runsByBranch = new Map<string, RunRecord[]>();
  for (const run of input.runs) {
    const branch = runBranch(run);
    if (!branch) continue;
    runsByBranch.set(branch, [...(runsByBranch.get(branch) ?? []), run]);
  }
  const liveRun = (run: RunRecord) => input.isActive(run.id) || !isFinished(run);
  const representative = (runs: RunRecord[] | undefined): RunRecord | undefined =>
    runs?.find(liveRun) ?? runs?.slice().sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))[0];

  interface Draft { head: HeadRow; run?: RunRecord; cls: BranchClass | null; ahead: number }
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
    const cls: BranchClass | null = inUse ? 'active' : task ? null : 'other';
    return { head, ...(run ? { run } : {}), cls, ahead: count };
  });

  // Empty before merged: a run whose branch still sits on its fork point never committed.
  await Promise.all(
    drafts
      .filter((d) => d.cls === null && d.run)
      .map(async (d) => {
        const fork = await forkPoint(root, d.run as RunRecord, d.head.name);
        if (fork !== d.head.sha) return;
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
      const createdMerged = pending.some((d) => prByBranch.get(d.head.name)?.state === 'merged');
      const list = needList.length > 0 || createdMerged
        ? await input.forge.listPrs(root)
        : { available: true, prs: [] as ForgePr[] };
      if (!list.available) prStateKnown = false;
      const byHead = new Map<string, ForgePr[]>();
      for (const pr of list.prs) byHead.set(pr.headRefName, [...(byHead.get(pr.headRefName) ?? []), pr]);
      for (const d of needList) {
        const pr = pickPr(byHead.get(d.head.name) ?? []);
        if (pr) prByBranch.set(d.head.name, { number: pr.number, url: pr.url, state: pr.state });
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

  const branches: RepoBranchEntry[] = await Promise.all(
    drafts.map(async (d) => {
      const cls = d.cls as BranchClass;
      let diffStat: RepoBranchEntry['diffStat'] = null;
      if ((cls === 'not-landed' || cls === 'orphan') && baseSha) {
        const res = await git(root, ['diff', '--shortstat', `${baseSha}...${d.head.sha}`]);
        if (res.ok) {
          const stat = parseShortstat(res.stdout);
          diffStat = { additions: stat.adds, deletions: stat.dels };
        }
      }
      return {
        name: d.head.name,
        class: cls,
        runId: d.run?.id ?? null,
        title: d.run ? d.run.title ?? d.run.id : null,
        runStatus: d.run?.status ?? null,
        ahead: Number.isFinite(d.ahead) ? d.ahead : 0,
        lastCommit: { sha: d.head.sha, subject: d.head.subject, at: d.head.at },
        diffStat,
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
const branchesCache = new Map<string, { key: string; at: number; value: RepoBranchesResponse }>();

/** What the answer depends on, hashed: every local and remote-tracking ref, the registered
 *  worktrees, the configured base, and the run fields the classes read. */
async function stateKey(input: ClassifyInput): Promise<string> {
  const [refs, worktrees] = await Promise.all([
    git(input.root, ['for-each-ref', '--format=%(objectname) %(refname)', 'refs/heads', 'refs/remotes']),
    git(input.root, ['worktree', 'list', '--porcelain']),
  ]);
  const runs = input.runs.map((r) => [
    r.id, r.status, r.archived, r.branch, r.baseBranch, r.pullRequestUrl, r.title, r.worktreePath, input.isActive(r.id),
  ]);
  return createHash('sha256')
    .update(JSON.stringify([refs.stdout, worktrees.stdout, input.configuredBase, input.currentBranch, input.hasRemote, runs]))
    .digest('hex');
}

/** `GET /repo/branches`: the classification, cached on the refs state. */
export async function readRepoBranches(input: ClassifyInput): Promise<RepoBranchesResponse> {
  const key = await stateKey(input);
  const hit = branchesCache.get(input.root);
  if (hit && hit.key === key && Date.now() - hit.at < BRANCHES_TTL_MS) return hit.value;
  const { payload } = await classifyBranches(input);
  branchesCache.set(input.root, { key, at: Date.now(), value: payload });
  return payload;
}

/** Drop the cached classification — after any mutation this server makes. */
export function forgetRepoBranches(root: string): void {
  branchesCache.delete(root);
}

// ---- deletion ------------------------------------------------------------------------------

export interface DeleteBranchesResult {
  deleted: string[];
  refused: Array<{ name: string; reason: string }>;
  dropped?: Array<{ sha: string; subject: string }>;
}

const DROPPED_CAP = 100;

/**
 * Delete local branches — only what a FRESH classification says is safe. `merged` and `empty`
 * delete in bulk; `not-landed`/`orphan` only alone and with `confirm` equal to the branch name;
 * `active` and `other` never. The delete itself runs under the worktree mutation lock and
 * re-checks what could have changed since classifying (a checkout, an owned receipt), refusing
 * owned refs exactly as `removeWorktree` does. Each delete is one `update-ref` transaction that
 * also verifies the base and the tip are still the commits the verdict was read against: a base
 * reset while this waited on GitHub or the lock would otherwise turn a merged branch into the
 * only copy of its work. An `empty` branch whose tip only another ref keeps needs that ref to sit
 * OUTSIDE this request, or two such branches would vouch for each other and both go. Never throws.
 */
export async function deleteBranches(
  input: ClassifyInput,
  requested: string[],
  confirm?: string,
): Promise<DeleteBranchesResult> {
  const names = [...new Set(requested)];
  const { payload, tips, baseSha, baseFullRef } = await classifyBranches(input);
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
          const res = await lockedGit(input.root, ['update-ref', '--stdin'], undefined, transaction);
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
  runs: readonly RunRecord[],
): Promise<Array<LogSource | null>> {
  if (runs.length === 0) return entries.map(() => null);
  const byBranch = new Map<string, RunRecord>();
  const byPr = new Map<number, RunRecord>();
  for (const run of runs) {
    const branch = runBranch(run);
    if (branch) byBranch.set(branch, run);
    const n = run.pullRequestUrl ? refNumberFromUrl(run.pullRequestUrl) : null;
    if (n !== null) byPr.set(n, run);
  }
  let tips: Map<string, string[]> | undefined;
  const refsAt = async (sha: string): Promise<string[]> => {
    if (!tips) {
      tips = new Map();
      const res = await git(root, ['for-each-ref', '--format=%(objectname) %(refname:short)', 'refs/heads', 'refs/remotes']);
      for (const line of res.stdout.split('\n')) {
        const [objectname = '', ref = ''] = line.split(' ');
        if (objectname && ref) tips.set(objectname, [...(tips.get(objectname) ?? []), ref.replace(/^[^/]+\/(?=cez\/)/, '')]);
      }
    }
    return tips.get(sha) ?? [];
  };
  const source = (run: RunRecord, prNumber: number | null): LogSource => ({
    runId: run.id,
    title: run.title ?? run.id,
    prNumber: prNumber ?? (run.pullRequestUrl ? refNumberFromUrl(run.pullRequestUrl) : null),
  });
  return Promise.all(
    entries.map(async (entry) => {
      const mergePr = MERGE_PR.exec(entry.subject);
      const prNumber = mergePr ? Number(mergePr[1]) : null;
      if (entry.parents.length >= 2) {
        for (const ref of await refsAt(entry.parents[1] as string)) {
          const run = byBranch.get(ref);
          if (run) return source(run, prNumber);
        }
        const named = mergePr?.[2] ?? MERGE_BRANCH.exec(entry.subject)?.[1];
        const run = named ? byBranch.get(named.replace(/^origin\//, '')) : undefined;
        if (run) return source(run, prNumber);
        if (prNumber !== null && byPr.has(prNumber)) return source(byPr.get(prNumber) as RunRecord, prNumber);
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

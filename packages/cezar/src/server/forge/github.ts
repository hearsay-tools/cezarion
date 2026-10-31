import { defined } from '../../core/defined.ts';
import { activeWorkflowRunsArgs, parseActiveWorkflowRuns } from '../../ci-wait/github.ts';
import type { ArchivePullRequestIdentity, MergedPullRequest } from '@open-mercato/cezar-contract/runs';
import { exactLineIndex, nextLineIndex } from '@open-mercato/cezar-contract/handoff';
import { pullRequestKey } from '../../runs/pull-requests.ts';
import { matchesGithubPullRequest, mergedPullRequestObservations } from '../../merge-observations.ts';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { z } from 'zod';
import { GITHUB_COMMENT_COUNTS_MAX, GITHUB_SEARCH_MAX, REFERENCE_STATUS_MAX, type GithubCommentCountsData, type GithubItemResponse, type GithubProject, type GithubProjectsData } from '@open-mercato/cezar-contract/github';
import { fetchIssueProjects, fetchRepositoryProjects, fetchViewerLogin } from './github-filters.ts';
import { fetchGithubMergeRequirements, type GithubMergeRequirements } from './github-merge-requirements.ts';
import { autosaveCommit } from '../../git-worktree.ts';
import { refNumberFromUrl } from '@open-mercato/cezar-contract/run-search';
import type {
  DraftPrInput,
  DraftPrOutcome,
  ForgeAvailability,
  ForgeComment,
  ForgeCommentsData,
  ForgeDriver,
  ForgeItem,
  ForgeListOptions,
  ForgeMergeInput,
  ForgeMergeMethod,
  ForgeMergeResult,
  ForgePrCheck,
  ForgePrMergeState,
  ForgePrMergeStateResult,
  ForgePrStatus,
  ForgePrDiffResult,
  ForgeRefKind,
  ForgeSearchData,
  ForgeTimelineEvent,
  ForgeTimelineEventKind,
} from './types.ts';

/**
 * The GitHub forge driver — all `gh`-CLI logic in one place, moved here from
 * `src/server/github.ts` (tab listing) and `src/server/pr.ts` (draft PRs)
 * behind the `ForgeDriver` seam. Those modules remain as thin delegates.
 * `/api/github`'s response shape is this driver's serialization and is
 * protected by BACKWARD_COMPATIBILITY.md — additive changes only.
 */

const exec = promisify(execFile);

export const GH_PR_DIFF_FILE_CAP = 300;
export const GH_PR_PATCH_CAP = 512 * 1024;
export const GH_PR_DIFF_JSON_CAP = 4 * 1024 * 1024;

const ghPrFileSchema = z.object({
  filename: z.string().min(1),
  previous_filename: z.string().optional(),
  status: z.enum(['added', 'modified', 'removed', 'renamed', 'copied', 'changed']),
  additions: z.number().int().nonnegative(),
  deletions: z.number().int().nonnegative(),
  patch: z.string().optional(),
});
const ghPrHeadSchema = z.object({ headRefOid: z.string().regex(/^[0-9a-f]{40}$/i) });

export class GithubPrNotFoundError extends Error {}

const prDiffCache = new Map<string, { at: number; data: ForgePrDiffResult }>();

export type PrFilesPageRunner = (page: number) => Promise<string>;

/** Fetch no more than the three GitHub pages represented by the public 300-file response cap. */
export async function fetchPrFilePages(runPage: PrFilesPageRunner): Promise<unknown[]> {
  const rows: unknown[] = [];
  for (let page = 1; page <= GH_PR_DIFF_FILE_CAP / 100; page++) {
    const next = z.array(z.unknown()).parse(JSON.parse(await runPage(page)));
    rows.push(...next);
    if (next.length < 100) break;
  }
  return rows;
}

export async function fetchGithubPrDiff(
  repoRoot: string,
  number: number,
  refresh = false,
): Promise<ForgePrDiffResult> {
  if (process.env.CEZ_DRY_RUN === '1') return mockGithubPrDiff(number);
  try {
    const head = ghPrHeadSchema.parse(
      JSON.parse(await gh(repoRoot, ['pr', 'view', String(number), '--json', 'headRefOid'])),
    ).headRefOid;
    const key = `${repoRoot}\0${number}\0${head}`;
    const hit = prDiffCache.get(key);
    if (!refresh && hit && Date.now() - hit.at < CACHE_MS) return hit.data;
    const rows = z.array(ghPrFileSchema).parse(
      await fetchPrFilePages((page) =>
        gh(repoRoot, ['api', `repos/{owner}/{repo}/pulls/${number}/files?per_page=100&page=${page}`], 30_000),
      ),
    );
    const limited = rows.slice(0, GH_PR_DIFF_FILE_CAP);
    // A full third page may have a successor. Without fetching a 301st file, conservatively call
    // the response partial rather than claiming completeness we cannot prove.
    let responseTruncated = rows.length >= GH_PR_DIFF_FILE_CAP;
    const reasons: string[] = responseTruncated ? [`Only the first ${GH_PR_DIFF_FILE_CAP} files are shown.`] : [];
    const files = limited.map((row) => {
      let patch = row.patch;
      let truncated = false;
      let patchUnavailableReason: 'binary' | 'too-large' | 'not-provided' | undefined;
      if (patch !== undefined && Buffer.byteLength(patch, 'utf8') > GH_PR_PATCH_CAP) {
        patch = undefined;
        truncated = true;
        patchUnavailableReason = 'too-large';
        responseTruncated = true;
      } else if (patch === undefined) {
        patchUnavailableReason = row.additions === 0 && row.deletions === 0 ? 'binary' : 'not-provided';
      }
      return {
        path: row.filename,
        ...(row.previous_filename ? { previousPath: row.previous_filename } : {}),
        status: row.status,
        additions: row.additions,
        deletions: row.deletions,
        ...(patch !== undefined ? { patch } : {}),
        ...(patchUnavailableReason ? { patchUnavailableReason } : {}),
        ...(truncated ? { truncated: true } : {}),
      };
    });
    let kept = files;
    while (
      kept.length > 0 &&
      Buffer.byteLength(JSON.stringify({ available: true, number, headSha: head, files: kept }), 'utf8') >
        GH_PR_DIFF_JSON_CAP
    ) {
      kept = kept.slice(0, -1);
      responseTruncated = true;
    }
    if (kept.length < files.length) reasons.push('The response size limit omitted some files.');
    if (files.some((file) => file.truncated)) reasons.push('One or more patches exceeded the per-file limit.');
    const data: ForgePrDiffResult = {
      available: true,
      number,
      headSha: head,
      files: kept,
      additions: rows.reduce((sum, row) => sum + row.additions, 0),
      deletions: rows.reduce((sum, row) => sum + row.deletions, 0),
      truncated: responseTruncated,
      ...(reasons.length ? { reason: reasons.join(' ') } : {}),
    };
    prDiffCache.set(key, { at: Date.now(), data });
    while (prDiffCache.size > 50) prDiffCache.delete(prDiffCache.keys().next().value!);
    return data;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (/HTTP 404|Could not resolve to a PullRequest|no pull requests found/i.test(message)) {
      throw new GithubPrNotFoundError(`Pull request #${number} was not found`);
    }
    return {
      available: false,
      reason: /ENOENT/.test(message)
        ? 'gh CLI not found — install it and run `gh auth login`'
        : firstLine(message),
    };
  }
}

function mockGithubPrDiff(number: number): ForgePrDiffResult {
  return {
    available: true,
    number,
    headSha: '0123456789abcdef0123456789abcdef01234567',
    additions: 15,
    deletions: 4,
    truncated: true,
    reason: 'One or more patches were not provided by GitHub.',
    files: [
      { path: 'src/session.ts', status: 'modified', additions: 8, deletions: 3, patch: '@@ -1,3 +1,4 @@\n-old\n+new\n context' },
      { path: 'src/new-name.ts', previousPath: 'src/old-name.ts', status: 'renamed', additions: 7, deletions: 1, patch: '@@ -1 +1 @@\n-old name\n+new name' },
      { path: 'assets/logo.png', status: 'modified', additions: 0, deletions: 0, patchUnavailableReason: 'binary' },
      { path: 'generated/output.txt', status: 'modified', additions: 0, deletions: 0, patchUnavailableReason: 'too-large', truncated: true },
    ],
  };
}

/** One GitHub issue or pull request, flattened for the cockpit's GitHub tab. */
export type GithubItem = ForgeItem;

export type GithubData = import('@open-mercato/cezar-contract').GithubData;

// `gh … --json` output — validated at the boundary, extras stripped.
const ghAuthor = z.object({ login: z.string() }).nullish();
// `color` is the 6-hex GitHub label color (no `#`), '' when gh omits it.
const ghLabel = z.object({ name: z.string(), color: z.string().default('') });
const ghIssueSchema = z.object({
  number: z.number(),
  title: z.string(),
  author: ghAuthor,
  createdAt: z.string(),
  labels: z.array(ghLabel).default([]),
  assignees: z.array(z.object({ login: z.string() })).default([]),
  body: z.string().nullish(),
  url: z.string(),
});
// One check run's `gh --json statusCheckRollup` entry — every field optional/nullish because
// gh's shape varies by check provider (exported so #400's unit tests can build fixtures).
export const ghCheckRunSchema = z.object({
  state: z.string().nullish(),
  status: z.string().nullish(),
  conclusion: z.string().nullish(),
});
const ghStatusCheckRollup = z.array(ghCheckRunSchema).nullish();

// The list tier no longer requests `statusCheckRollup` (#664) — it is hydrated lazily per
// on-screen PR row (`fetchGithubChecks`). `checks` is set to `null` on list rows; the schema
// keeps no rollup field because the list call never asks for it.
const ghPrSchema = ghIssueSchema.extend({
  isDraft: z.boolean().default(false),
  additions: z.number().default(0),
  deletions: z.number().default(0),
});
const ghPrViewSchema = z.object({
  number: z.number(),
  url: z.string(),
  state: z.string().default('OPEN'),
  mergedAt: z.unknown().optional(),
  isDraft: z.boolean().default(false),
  statusCheckRollup: ghStatusCheckRollup,
});

const mergeCheckSchema = z.object({
  name: z.string().optional(),
  context: z.string().optional(),
  targetUrl: z.string().nullish(),
  state: z.string().nullish(),
  status: z.string().nullish(),
  conclusion: z.string().nullish(),
  detailsUrl: z.string().nullish(),
});
const mergePrSchema = z.object({
  number: z.number(),
  title: z.string(),
  url: z.string(),
  state: z.string(),
  mergedAt: z.unknown().optional(),
  isDraft: z.boolean().default(false),
  headRefName: z.string(),
  baseRefName: z.string(),
  headRefOid: z.string().regex(/^[0-9a-f]{40}$/),
  mergeable: z.string().nullish(),
  mergeStateStatus: z.string().nullish(),
  reviewDecision: z.string().nullish(),
  statusCheckRollup: z.array(mergeCheckSchema).nullish(),
});
const repoMergePolicySchema = z.object({
  allow_merge_commit: z.boolean().default(false),
  allow_squash_merge: z.boolean().default(false),
  allow_rebase_merge: z.boolean().default(false),
  merge_commit_title: z.string().nullish(),
  squash_merge_commit_title: z.string().nullish(),
});
const ghMergeResultSchema = z.object({
  merged: z.boolean(),
  message: z.string().nullish(),
  sha: z.string().nullish(),
});

/** Exported for unit tests (#400) — collapses a zod-validated `statusCheckRollup` array down to
 *  the single enum the GitHub tab (list rows + detail badge) renders. */
export function rollupToChecks(rollup: z.infer<typeof ghStatusCheckRollup>): GithubItem['checks'] {
  if (!rollup || rollup.length === 0) return null;
  const states = rollup.map((r) => (r.conclusion || r.state || r.status || '').toUpperCase());
  if (states.some((s) => ['FAILURE', 'ERROR', 'TIMED_OUT', 'ACTION_REQUIRED'].includes(s))) return 'failing';
  if (states.some((s) => ['PENDING', 'IN_PROGRESS', 'QUEUED', 'EXPECTED', ''].includes(s))) return 'pending';
  return 'passing';
}

// Keep account-directory and host selection attached to shared work. Never key by owner/name:
// separate local roots (including different remotes/accounts) must not share results.
function githubContext(repoRoot: string) {
  const env = { GH_HOST: process.env.GH_HOST, GH_CONFIG_DIR: process.env.GH_CONFIG_DIR };
  return { key: JSON.stringify([repoRoot, env.GH_HOST, env.GH_CONFIG_DIR]), env };
}
type GithubContext = ReturnType<typeof githubContext>;

async function gh(repoRoot: string, args: string[], timeout = 15_000, signal?: AbortSignal, context?: GithubContext): Promise<string> {
  const { stdout } = await exec('gh', args, {
    cwd: repoRoot,
    ...(context ? { env: { ...process.env, ...context.env } } : {}),
    timeout,
    maxBuffer: 50 * 1024 * 1024,
    ...(signal ? { signal } : {}),
  });
  return stdout;
}

// ---- GraphQL plumbing ----------------------------------------------------

/** Runs a GraphQL query — injected so pagination is unit-testable without shelling to `gh`.
 *  Number variables reach GitHub typed (`-F`), strings raw (`-f`): see `ghGraphqlArgs`. */
export type GraphqlRunner = (query: string, variables: Record<string, string | number>) => Promise<string>;

/** `gh api graphql` argv. `-f` sends every value as a String, and GitHub rejects a String where
 *  the query declares `Int!` ("Could not coerce value to Int", open-mercato/cezar#1366), so a
 *  number goes through `-F`. A string never does: `-F` would read `@file` and coerce
 *  `true`/numerals, which is not what an opaque cursor or a login means. */
export function ghGraphqlArgs(query: string, variables: Record<string, string | number> = {}): string[] {
  const args = ['api', 'graphql', '-f', `query=${query}`];
  for (const [key, value] of Object.entries(variables)) {
    args.push(typeof value === 'number' ? '-F' : '-f', `${key}=${value}`);
  }
  return args;
}

/** `owner/name` → `{ owner, name }`, or null when the handle isn't a clean two-part slug. */
export function parseOwnerName(nameWithOwner: string): { owner: string; name: string } | null {
  const [owner, name, ...rest] = nameWithOwner.trim().split('/');
  return owner && name && rest.length === 0 ? { owner, name } : null;
}

// Paged open lists defer comment counts; hydrate them through the counts route after paint.

/** GitHub GraphQL rejects `first` above 100 (EXCESSIVE_PAGINATION); larger limits walk pages. */
export const GH_GRAPHQL_PAGE_MAX = 100;

export type ListSide = 'issues' | 'pullRequests';

// Labels up to 100, which is what `gh issue list --json labels` read before the GraphQL page.
const LIST_NODE_FIELDS = 'number title author { login } createdAt url body labels(first: 100) { nodes { name color } }';
const listQuery = (side: ListSide): string => `
query ($owner: String!, $name: String!, $first: Int!, $after: String) {
  repository(owner: $owner, name: $name) {
    ${side}(first: $first, after: $after, states: OPEN, orderBy: {field: CREATED_AT, direction: DESC}) {
      totalCount
      pageInfo { hasNextPage endCursor }
      nodes { ${LIST_NODE_FIELDS} ${side === 'issues' ? 'assignees(first: 20) { nodes { login } }' : 'isDraft additions deletions'} }
    }
  }
}`;

/** A GraphQL connection (`{ nodes }`) read as the flat array `gh … --json` used to return. */
const connectionOf = <T extends z.ZodType>(item: T) =>
  z.object({ nodes: z.array(item.nullable()).default([]) }).nullish()
    .transform((connection) => (connection?.nodes ?? []).filter((node): node is NonNullable<typeof node> => node != null));

const ghListNodeSchema = z.object({
  number: z.number(),
  title: z.string(),
  author: ghAuthor,
  createdAt: z.string(),
  url: z.string(),
  body: z.string().nullish(),
  labels: connectionOf(ghLabel),
  assignees: connectionOf(z.object({ login: z.string() })),
  isDraft: z.boolean().nullish(),
  additions: z.number().nullish(),
  deletions: z.number().nullish(),
});
export type ListNode = z.infer<typeof ghListNodeSchema>;

const ghListConnectionSchema = z.object({
  totalCount: z.number().int().nonnegative(),
  pageInfo: z.object({ hasNextPage: z.boolean(), endCursor: z.string().nullish() }),
  nodes: z.array(ghListNodeSchema.nullable()),
});

function parseListConnection(out: string, side: ListSide): z.infer<typeof ghListConnectionSchema> {
  const parsed = JSON.parse(out) as { data?: { repository?: Record<string, unknown> | null }; errors?: Array<{ message?: string }> };
  const message = parsed.errors?.map((e) => e.message).filter(Boolean).join(' ');
  if (message) throw new Error(message);
  if (!parsed.data?.repository) throw new Error('GitHub did not resolve this repository');
  return ghListConnectionSchema.parse(parsed.data.repository[side]);
}

/**
 * One side of the open list: up to `limit` rows from `cursor`, in requests of at most
 * `GH_GRAPHQL_PAGE_MAX`. `nextCursor` is where the rows stop, or `null` once the side is
 * exhausted. `done` asks for `first: 0`, which still answers `totalCount`, so an exhausted side
 * keeps a fresh total without ever restarting from its first page (open-mercato/cezar#1366
 * restarted it while the other side paged).
 */
export async function fetchListConnection(
  run: GraphqlRunner,
  owner: string,
  name: string,
  side: ListSide,
  limit: number,
  cursor?: string,
  done = false,
): Promise<{ totalCount: number; nodes: ListNode[]; nextCursor: string | null }> {
  const query = listQuery(side);
  if (done) {
    const page = parseListConnection(await run(query, { owner, name, first: 0 }), side);
    return { totalCount: page.totalCount, nodes: [], nextCursor: null };
  }
  const nodes: ListNode[] = [];
  let after = cursor;
  for (;;) {
    const first = Math.min(GH_GRAPHQL_PAGE_MAX, limit - nodes.length);
    const page = parseListConnection(await run(query, { owner, name, first, ...(after ? { after } : {}) }), side);
    const rows = page.nodes.filter((node): node is ListNode => node !== null);
    nodes.push(...rows);
    const next = page.pageInfo.hasNextPage ? page.pageInfo.endCursor ?? null : null;
    // An empty page that claims more would loop forever; read it as the end of the side.
    if (next === null || rows.length === 0) return { totalCount: page.totalCount, nodes, nextCursor: null };
    if (next === after) throw new Error('GitHub list cursor did not advance');
    // A short page with more behind it still ends this request: the cursor resumes it exactly.
    if (nodes.length >= limit || rows.length < first) return { totalCount: page.totalCount, nodes, nextCursor: next };
    after = next;
  }
}

/* Reads degrade to `available: false` with a hint — never an error (plan rule
   7): no `gh`, no remote, offline all land on the same quiet path. A short
   cache keeps tab switches from hammering the GitHub API; a cached fetch with
   a bigger limit than asked serves fine (it's a superset). Keyed by repository/host/account context
   (multi-project workspace, step 2.6) plus the page asked for: one project's — possibly private —
   issues/PRs must never be served under another project's scope, and page 2 is never page 1.
   Bounded like `commentsCache` so an unbounded workspace can't grow it without limit. */
let listRequestOrder = 0;
/** Per context, the order of the newest page-1 refresh. A refresh drops the context's later
 *  pages (their cursors were cut from the old first page), and a later page that started before
 *  it may answer its caller but never re-enters the cache. Bounded with `listCache`. */
const listRefreshOrder = new Map<string, number>();
const listCache = new Map<string, {
  contextKey: string; order: number; at: number; limit: number; data: GithubData; projects: Promise<GithubProjectsData>;
}>();
const LIST_CACHE_MAX = 50;
const CACHE_MS = 60_000;
/** Which page key holds a projects generation, so `fetchGithubProjects` never scans the cache.
 *  Installed and evicted in step with `listCache`, so it shares its bound. */
const projectGenerations = new Map<string, string>();
/** Board discovery (the `projectsV2` walk) per context: page 2 pays for membership only. A
 *  failed discovery is dropped, so the next page or refresh asks again. */
const repositoryProjectsCache = new Map<string, { at: number; projects: Promise<GithubProject[]> }>();

function dropListEntry(key: string): void {
  const generation = listCache.get(key)?.data.projectsGeneration;
  if (generation && projectGenerations.get(generation) === key) projectGenerations.delete(generation);
  listCache.delete(key);
}

function discoverRepositoryProjects(contextKey: string, refresh: boolean, start: () => Promise<GithubProject[]>): Promise<GithubProject[]> {
  const hit = repositoryProjectsCache.get(contextKey);
  if (!refresh && hit && Date.now() - hit.at < CACHE_MS) return hit.projects;
  const projects = start();
  const entry = { at: Date.now(), projects };
  repositoryProjectsCache.delete(contextKey);
  repositoryProjectsCache.set(contextKey, entry);
  projects.catch(() => {
    if (repositoryProjectsCache.get(contextKey) === entry) repositoryProjectsCache.delete(contextKey);
  });
  while (repositoryProjectsCache.size > LIST_CACHE_MAX) {
    const oldest = repositoryProjectsCache.keys().next().value;
    if (oldest === undefined) break;
    repositoryProjectsCache.delete(oldest);
  }
  return projects;
}
export const GH_MAX_LIMIT = 1000;

/** Where one list page starts on each side. A done side answered `nextCursor: null` already. */
export type GithubPageRequest = Pick<ForgeListOptions, 'issuesCursor' | 'prsCursor' | 'issuesDone' | 'prsDone'>;

function listPageKey(contextKey: string, page: GithubPageRequest): string {
  return JSON.stringify([contextKey, page.issuesCursor ?? null, page.prsCursor ?? null, !!page.issuesDone, !!page.prsDone]);
}

export async function fetchGithub(repoRoot: string, refresh = false, limit = 30, page: GithubPageRequest = {}): Promise<GithubData> {
  if (process.env.CEZ_DRY_RUN === '1') return mockGithubPage(limit, page);
  const context = githubContext(repoRoot);
  const capped = Math.min(Math.max(limit, 1), GH_MAX_LIMIT);
  const key = listPageKey(context.key, page);
  const hit = listCache.get(key);
  if (!refresh && hit && Date.now() - hit.at < CACHE_MS && hit.limit >= capped) {
    return hit.data;
  }
  const order = ++listRequestOrder;
  if (refresh && !page.issuesCursor && !page.prsCursor && !page.issuesDone && !page.prsDone) {
    listRefreshOrder.delete(context.key);
    listRefreshOrder.set(context.key, order);
    while (listRefreshOrder.size > LIST_CACHE_MAX) {
      const oldest = listRefreshOrder.keys().next().value;
      if (oldest === undefined) break;
      listRefreshOrder.delete(oldest);
    }
    for (const [cached, entry] of [...listCache]) {
      if (entry.contextKey === context.key && cached !== key) dropListEntry(cached);
    }
  }
  try {
    // No `statusCheckRollup` (#664): it is hydrated lazily per on-screen PR row via
    // `fetchGithubChecks`. A big aggregate list still gets a little more wall clock.
    const timeout = capped > 100 ? 30_000 : 15_000;
    const ownerName = await resolveRepoHandleStrict(repoRoot, context);
    if (!ownerName) return { available: false, reason: 'Could not resolve this repository on GitHub.', issues: [], prs: [] };
    const runGraphql: GraphqlRunner = (query, variables) =>
      gh(repoRoot, ghGraphqlArgs(query, variables), timeout, undefined, context);
    // Optional project queries have one shared wall-clock budget. A missing scope, a cap,
    // or malformed metadata must never turn an otherwise working list into unavailable.
    const deadline = Date.now() + 15_000;
    const projectGraphql: GraphqlRunner = (query, variables) => {
      const remaining = deadline - Date.now();
      if (remaining <= 0) return Promise.reject(new Error('Project lookup timed out'));
      return gh(repoRoot, ghGraphqlArgs(query, variables), Math.min(remaining, 8_000), undefined, context);
    };
    const firstPage = !page.issuesCursor && !page.prsCursor && !page.issuesDone && !page.prsDone;
    const issueSide = fetchListConnection(runGraphql, ownerName.owner, ownerName.name, 'issues', capped, page.issuesCursor, page.issuesDone);
    const projectLookup = fetchIssueProjects(projectGraphql, ownerName.owner, ownerName.name,
      async () => (await issueSide).nodes.map((node) => node.number),
      () => discoverRepositoryProjects(context.key, refresh,
        () => fetchRepositoryProjects(projectGraphql, ownerName.owner, ownerName.name)));
    const [issuesPage, prsPage, viewerLogin] = await Promise.all([
      issueSide,
      fetchListConnection(runGraphql, ownerName.owner, ownerName.name, 'pullRequests', capped, page.prsCursor, page.prsDone),
      // The viewer is the same on every page; only the first one asks.
      firstPage
        ? fetchViewerLogin((query) => gh(repoRoot, ghGraphqlArgs(query), 8_000, undefined, context))
        : Promise.resolve(undefined),
    ]);
    // One repo-wide label→color map, filled as we flatten each item's labels.
    const labelColors: Record<string, string> = {};
    const recordColor = (l: { name: string; color: string }) => {
      if (l.color && !labelColors[l.name]) labelColors[l.name] = l.color;
    };
    const issues = issuesPage.nodes.map(
      (i): GithubItem => {
        i.labels.forEach(recordColor);
        return {
          kind: 'issue',
          number: i.number,
          title: i.title,
          author: i.author?.login ?? '?',
          createdAt: i.createdAt,
          labels: i.labels.map((l) => l.name),
          body: (i.body ?? '').slice(0, 8_000),
          url: i.url,
          comments: 0,
          assignees: i.assignees.map(a => a.login),
        };
      },
    );
    const prs = prsPage.nodes.map(
      (p): GithubItem => {
        p.labels.forEach(recordColor);
        const isDraft = p.isDraft ?? false;
        return {
          kind: 'pr',
          number: p.number,
          title: p.title,
          author: p.author?.login ?? '?',
          createdAt: p.createdAt,
          labels: [...p.labels.map((l) => l.name), ...(isDraft ? ['draft'] : [])],
          body: (p.body ?? '').slice(0, 8_000),
          url: p.url,
          comments: 0,
          isDraft,
          additions: p.additions ?? 0,
          deletions: p.deletions ?? 0,
          // Hydrated lazily by `fetchGithubChecks` for on-screen rows (#664) — the list no
          // longer pays for the CI rollup of every open PR.
          checks: null,
        };
      },
    );
    // Only verified values from the same repository may survive a refresh.
    const previous = hit?.data.repo === `${ownerName.owner}/${ownerName.name}` ? hit.data : undefined;
    for (const issue of issues) {
      const known = previous?.issues.find(row => row.number === issue.number)?.projectIds;
      if (known !== undefined) issue.projectIds = known;
    }
    const generation = randomUUID();
    const data: GithubData = {
      available: true,
      repo: `${ownerName.owner}/${ownerName.name}`,
      syncedAt: new Date().toISOString(),
      issues,
      prs,
      labelColors,
      ...(viewerLogin ? { viewerLogin } : {}),
      projectsState: 'refreshing',
      projectsGeneration: generation,
      ...(previous?.projects ? { projects: previous.projects } : {}),
      issuesTotal: issuesPage.totalCount,
      prsTotal: prsPage.totalCount,
      issuesNextCursor: issuesPage.nextCursor,
      prsNextCursor: prsPage.nextCursor,
      commentsDeferred: true,
    };
    const projects = projectLookup.then((result): GithubProjectsData => {
      const metadata: GithubProjectsData = 'membership' in result
        ? { generation, state: 'ready', projects: result.projects, membership: result.membership }
        : { generation, state: 'unavailable', reason: result.projectsReason };
      const current = listCache.get(key);
      if (current?.data.projectsGeneration === generation) {
        current.data = {
          ...current.data,
          projectsState: metadata.state,
          ...(metadata.state === 'ready' ? {
            projects: metadata.projects,
            issues: current.data.issues.map(issue => ({ ...issue, projectIds: metadata.membership?.[issue.number] ?? [] })),
          } : { projectsReason: metadata.reason }),
        };
      }
      return metadata;
    });
    // Concurrent refreshes may finish in reverse order. An older list must not evict
    // the newer generation (and invalidate the newer client's metadata follow-up).
    if ((listCache.get(key)?.order ?? -1) < order && order >= (listRefreshOrder.get(context.key) ?? 0)) {
      dropListEntry(key); // re-insert so this key becomes the newest
      listCache.set(key, { contextKey: context.key, order, at: Date.now(), limit: capped, data, projects });
      projectGenerations.set(generation, key);
    }
    while (listCache.size > LIST_CACHE_MAX) {
      const oldest = listCache.keys().next().value;
      if (oldest === undefined) break;
      dropListEntry(oldest);
    }
    return data;
  } catch (err) {
    return { available: false, reason: ghFailureReason(err), issues: [], prs: [] };
  }
}

/** A `gh` failure as one readable line. GitHub's own words come on stderr; the Node message
 *  starts with the whole argv, and a GraphQL argv is a multi-line query, so its first line is
 *  a fragment of that query rather than the reason (open-mercato/cezar#1366). */
export function ghFailureReason(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  if (/ENOENT/.test(message)) return 'gh CLI not found — install it and run `gh auth login`';
  const failure = (err ?? {}) as { stderr?: unknown; killed?: unknown; signal?: unknown };
  const stderr = typeof failure.stderr === 'string' ? failure.stderr : '';
  if (stderr.trim()) {
    const lines = stderr.split('\n').map((line) => line.trim()).filter(Boolean);
    return lines.find((line) => !/^Command failed:/i.test(line)) ?? lines[0]!;
  }
  if (failure.killed === true || typeof failure.signal === 'string') return 'GitHub did not answer in time. Refresh to try again.';
  // Without stderr, everything after "Command failed:" is the argv, which is query text.
  if (/^Command failed:/i.test(message)) return 'GitHub request failed. Refresh to try again.';
  return message.split('\n').map((line) => line.trim()).find(Boolean) ?? 'gh failed';
}

/** Bounded lookup already started by the list. Never launch work for an expired generation. */
export async function fetchGithubProjects(repoRoot: string, generation: string): Promise<GithubProjectsData> {
  const key = projectGenerations.get(generation);
  const entry = key === undefined ? undefined : listCache.get(key);
  // A generation from another repository, host or account never resolves here, even when
  // its UUID is known: the context is part of what the generation was issued for.
  if (!entry || entry.contextKey !== githubContext(repoRoot).key || entry.data.projectsGeneration !== generation) {
    return { generation, state: 'unavailable', reason: 'Project metadata expired. Refresh to try again.' };
  }
  return entry.projects;
}

function firstLine(s: string): string {
  return s.split('\n').find((l) => l.trim().length > 0)?.trim() ?? 'gh failed';
}

// On-demand cross-state search stays separate from the hot open list.

/** Hits per search. `gh search`'s own default is 30; 50 matches the page size the incremental-
 *  loading spec settled on and keeps one search to a single `gh` round-trip. */
export const GH_SEARCH_MAX = GITHUB_SEARCH_MAX;

/** The `--json` field set each search path requests. Neither path asks for `additions`/`deletions`
 *  or `statusCheckRollup` — the same reason the list tier stopped (#664), those are the expensive
 *  per-PR lookups.
 *
 *  `isDraft` is added for PRs only, and that is a hard requirement rather than a nicety: `gh search
 *  issues` does not define the field at all and rejects the whole call with `Unknown JSON field:
 *  "isDraft"`, which would turn every text query on the Issues tab into the "could not be searched"
 *  degrade. `gh {issue,pr} view` is the opposite — it tolerates the field for both kinds — so only
 *  the search path needs to discriminate. */
const SEARCH_FIELDS = 'number,title,author,createdAt,labels,body,url';

/** `gh search {prs,issues} --json` field list for `kind`. See `SEARCH_FIELDS` on why `isDraft`
 *  cannot be sent to the issues search. */
function searchJsonFields(kind: 'issue' | 'pr'): string {
  return kind === 'pr'
    ? `${SEARCH_FIELDS},isDraft,commentsCount`
    : `${SEARCH_FIELDS},assignees,commentsCount`;
}

/** `gh search issues|prs` returns `commentsCount` where the list tier gets its counts from a
 *  separate GraphQL walk. Same value, different spelling — normalized into `ForgeItem.comments`. */
const ghSearchHitSchema = ghIssueSchema.extend({
  assignees: z.array(z.object({ login: z.string() })).optional(),
  isDraft: z.boolean().default(false),
  commentsCount: z.number().default(0),
});

/** `gh {issue,pr} view <n> --json …` — the exact-number path. Shares `ghIssueSchema`'s core;
 *  `isDraft`/`additions`/`deletions` are PR-only and default harmlessly for issues. */
const ghViewHitSchema = ghIssueSchema.extend({
  state: z.string().optional(),
  mergedAt: z.unknown().optional(),
  assignees: z.array(z.object({ login: z.string() })).optional(),
  isDraft: z.boolean().default(false),
  additions: z.number().default(0),
  deletions: z.number().default(0),
});

/** Flatten one validated hit into the `ForgeItem` the tab's rows already render. `checks: null`
 *  is what the list tier ships too since #664 — the glyph hydrates lazily via `/api/github/checks`
 *  — so a searched row and a listed row are indistinguishable to the UI. */
function toSearchItem(
  kind: 'issue' | 'pr',
  hit: (z.infer<typeof ghSearchHitSchema> | z.infer<typeof ghViewHitSchema>) & { commentsCount: number },
  labelColors: Record<string, string>,
): ForgeItem {
  for (const label of hit.labels) {
    if (label.color && !labelColors[label.name]) labelColors[label.name] = label.color;
  }
  const item: ForgeItem = {
    kind,
    number: hit.number,
    title: hit.title,
    author: hit.author?.login ?? '?',
    createdAt: hit.createdAt,
    labels: hit.labels.map((l) => l.name),
    body: (hit.body ?? '').slice(0, 8_000),
    url: hit.url,
    comments: hit.commentsCount,
    ...(kind === 'issue' && hit.assignees ? { assignees: hit.assignees.map(a => a.login) } : {}),
  };
  if (kind === 'pr') {
    item.isDraft = hit.isDraft;
    // Draft is a label on list rows as well as a flag — keep the parity so filtering by the
    // `draft` chip behaves the same on a searched row.
    if (hit.isDraft) item.labels = [...item.labels, 'draft'];
    if ('additions' in hit) item.additions = hit.additions;
    if ('deletions' in hit) item.deletions = hit.deletions;
    item.checks = null;
  }
  return item;
}

/** `gh {pr,issue} view <n>` diagnostics that name the REQUESTED item as absent. A bare
 *  "not found" / 404 or "Could not resolve to a Repository" also fails a view, but says the
 *  repository (or auth) is the problem, not that the number does not exist. */
const MISSING_ITEM_RE =
  /could not resolve to an? (?:pullrequest|issue|issueorpullrequest|pull request|issue or pull request)\b|no (?:pull requests|issues) found/i;

/** The exact `gh view` call plus its parse. `null` only for a confirmed-missing item; anything
 *  else (transport, auth, repository, unparseable output) throws. */
async function viewGithubHit(
  repoRoot: string,
  kind: 'issue' | 'pr',
  number: number,
): Promise<z.infer<typeof ghViewHitSchema> | null> {
  try {
    const out = await gh(repoRoot, [
      kind === 'pr' ? 'pr' : 'issue',
      'view',
      String(number),
      '--json',
      kind === 'pr' ? `${SEARCH_FIELDS},isDraft,additions,deletions,state,mergedAt` : `${SEARCH_FIELDS},assignees`,
    ]);
    const hit = ghViewHitSchema.parse(JSON.parse(out));
    if (kind === 'pr' && hit.state === 'MERGED') {
      const handle = await resolveRepoHandle(repoRoot);
      if (handle) mergedPullRequestObservations.observe({ owner: handle.owner, repo: handle.name, number }, hit);
    }
    return hit;
  } catch (err) {
    if (MISSING_ITEM_RE.test(err instanceof Error ? err.message : String(err))) return null;
    throw err;
  }
}

/** `view` exposes comment bodies rather than a count. Read the single issue resource
 *  (PRs share this endpoint) instead of paginating a potentially enormous thread.
 *  gh resolves placeholders in repoRoot, just as it resolves the preceding view call. */
async function finishViewHit(
  repoRoot: string,
  kind: 'issue' | 'pr',
  number: number,
  hit: z.infer<typeof ghViewHitSchema>,
  labelColors: Record<string, string>,
): Promise<ForgeItem> {
  const commentsCount = z.number().int().nonnegative().parse(JSON.parse(await gh(repoRoot,
    ['api', `repos/{owner}/{repo}/issues/${number}`, '--jq', '.comments'], 8_000)));
  return toSearchItem(kind, { ...hit, commentsCount }, labelColors);
}

/**
 * One issue or PR by number, in any state (#692). `null` when `gh` confirms the item is absent;
 * throws on every other failure. `labelColors` is an optional out-param.
 */
export async function viewGithubItem(
  repoRoot: string,
  kind: 'issue' | 'pr',
  number: number,
  labelColors: Record<string, string> = {},
): Promise<ForgeItem | null> {
  const hit = await viewGithubHit(repoRoot, kind, number);
  return hit ? finishViewHit(repoRoot, kind, number, hit, labelColors) : null;
}

/**
 * Search any state: exact numbers try a direct lookup, then text fallback; text search omits
 * state restriction. Return availability and a reason on failure instead of throwing.
 */
export async function searchGithubItems(
  repoRoot: string,
  kind: 'issue' | 'pr',
  query: string,
  limit = GH_SEARCH_MAX,
): Promise<ForgeSearchData> {
  const trimmed = query.trim();
  if (trimmed === '') return { available: true, items: [] };
  const capped = Math.min(Math.max(limit, 1), GH_SEARCH_MAX);
  if (process.env.CEZ_DRY_RUN === '1') {
    const mock = mockGithub();
    const pool = kind === 'issue' ? mock.issues : mock.prs;
    const queryText = trimmed.toLowerCase();
    const numeric = queryText.replace(/^#/, '');
    const idOnly = /^\d+$/.test(numeric);
    // The fixture obeys `limit` and flags `truncated` on the live path's own rule (#838). The
    // catalog is a handful of rows, so the cap never bites in the demo itself — but offline mode
    // is the only place anyone developing without `gh` exercises cap-and-truncate at all, and a
    // dry-run that returned the whole pool unflagged would hide a regression in it.
    const items = pool
      .filter((item) => idOnly
        ? String(item.number).includes(numeric)
        : `#${item.number} ${item.title} ${item.author} ${item.body}`.toLowerCase().includes(queryText))
      .slice(0, capped)
      // Search rows defer checks to the same hydration endpoint as live results. Copy rather
      // than mutate: the mock checks endpoint still reads the fixture's passing/failing values.
      .map(item => item.kind === 'pr' ? { ...item, checks: null } : item);
    return { available: true, items, truncated: items.length >= capped };
  }
  const labelColors: Record<string, string> = {};
  const numeric = trimmed.replace(/^#/, '');
  try {
    if (/^\d+$/.test(numeric)) {
      // `Number()` before interpolation: the regex already guarantees digits, but the number is
      // user input reaching an argv, so it is normalized rather than passed through verbatim.
      const number = Number(numeric);
      // Any failure of the exact view call or its parse (and a missing number) falls through to
      // the text search below. The comment count is outside that guard: its failure reports
      // unavailable rather than an invented zero.
      let hit: z.infer<typeof ghViewHitSchema> | null = null;
      try {
        hit = await viewGithubHit(repoRoot, kind, number);
      } catch {
        // fall through
      }
      if (hit) {
        const item = await finishViewHit(repoRoot, kind, number, hit, labelColors);
        return await hydrateSearchProjects(repoRoot, kind, { available: true, items: [item], labelColors });
      }
    }
    // The memoized handle first (usually a hit). Its `null` is deliberately ambiguous — it swallows
    // "gh is missing" and "no remote" alike — so on a miss, ask once more directly and let the real
    // failure reach the catch below, where it becomes the same honest hint the list tier gives.
    // Only a genuinely unparseable slug reaches the "no remote" reason.
    const handle =
      (await resolveRepoHandle(repoRoot)) ??
      parseOwnerName(
        await gh(repoRoot, ['repo', 'view', '--json', 'nameWithOwner', '--jq', '.nameWithOwner']),
      );
    if (!handle) {
      return { available: false, reason: 'no GitHub remote to search', items: [] };
    }
    const out = await gh(repoRoot, [
      'search',
      kind === 'pr' ? 'prs' : 'issues',
      '--repo',
      `${handle.owner}/${handle.name}`,
      '--limit',
      String(capped),
      '--json',
      searchJsonFields(kind),
      // End-of-flags, then the query: `gh` parses a leading `-`/`--` as a flag otherwise, so a
      // flag-shaped query would degrade the tab to "GitHub could not be searched: unknown flag",
      // and the exact text `--web` would match `gh search`'s own `-w, --web` and open a browser
      // on the cockpit's host. Behind `--` it is search text, which is all the box ever means.
      '--',
      trimmed,
    ]);
    const hits = z.array(ghSearchHitSchema).parse(JSON.parse(out));
    // Older gh/GHES search treats repeated repo qualifiers as OR. Never hydrate a foreign
    // hit's number with this repository's memberships or expose it as a local detail row.
    const prefix = `/${handle.owner}/${handle.name}/${kind === 'pr' ? 'pull' : 'issues'}/`.toLowerCase();
    if (hits.some(hit => {
      try { return new URL(hit.url).pathname.toLowerCase() !== `${prefix}${hit.number}`; }
      catch { return true; }
    })) return { available: false, reason: 'GitHub returned results outside this repository. Remove repository qualifiers and try again.', items: [] };
    return await hydrateSearchProjects(repoRoot, kind, {
      available: true,
      items: hits.map((hit) => toSearchItem(kind, hit, labelColors)),
      truncated: hits.length >= capped,
      labelColors,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const reason = /ENOENT/.test(message)
      ? 'gh CLI not found — install it and run `gh auth login`'
      : firstLine(message);
    return { available: false, reason, items: [] };
  }
}

/** The list's metadata window contains only open issues. Search must look up its own window,
 * including closed issues, with the same bounds and unknown-on-failure semantics (#90). */
async function hydrateSearchProjects(
  repoRoot: string, kind: 'issue' | 'pr', data: ForgeSearchData,
): Promise<ForgeSearchData> {
  if (kind !== 'issue' || data.items.length === 0) return data;
  const handle = await resolveRepoHandle(repoRoot);
  if (!handle) return { ...data, projectsReason: 'Project boards unavailable for this repository.' };
  const deadline = Date.now() + 15_000;
  const run: GraphqlRunner = (query, variables) => {
    const remaining = deadline - Date.now();
    if (remaining <= 0) return Promise.reject(new Error('Project lookup timed out'));
    const args = ghGraphqlArgs(query, variables);
    return gh(repoRoot, args, Math.min(remaining, 8_000));
  };
  const projects = await fetchIssueProjects(run, handle.owner, handle.name, data.items.map(item => item.number));
  if ('projectsReason' in projects) return { ...data, projectsReason: projects.projectsReason };
  return { ...data, items: data.items.map(item => ({ ...item, projectIds: projects.membership[item.number] ?? [] })) };
}

/** The dry-run catalog, paged like the real list: numeric offset cursors per side, done flags
 *  honored, exact totals, and counts deferred to the counts route (hearsay-tools/cezarion#1183). */
function mockGithubPage(limit: number, page: GithubPageRequest): GithubData {
  const full = mockGithub();
  const side = (rows: GithubItem[], cursor: string | undefined, done: boolean | undefined) => {
    const start = done ? rows.length : Number(cursor ?? 0);
    const slice = rows.slice(start, start + Math.max(limit, 1));
    const end = start + slice.length;
    return { rows: slice.map((row) => ({ ...row, comments: 0 })), next: end < rows.length ? String(end) : null };
  };
  const issues = side(full.issues, page.issuesCursor, page.issuesDone);
  const prs = side(full.prs, page.prsCursor, page.prsDone);
  const firstPage = !page.issuesCursor && !page.prsCursor && !page.issuesDone && !page.prsDone;
  const { viewerLogin, ...rest } = full;
  return {
    ...rest,
    ...(firstPage && viewerLogin ? { viewerLogin } : {}),
    issues: issues.rows,
    prs: prs.rows,
    issuesTotal: full.issues.length,
    prsTotal: full.prs.length,
    issuesNextCursor: issues.next,
    prsNextCursor: prs.next,
    commentsDeferred: true,
  };
}

/** CEZ_DRY_RUN=1 — a small fixed catalog so the GitHub tab is demoable offline. */
function mockGithub(): GithubData {
  const mk = (over: Partial<GithubItem> & Pick<GithubItem, 'kind' | 'number' | 'title' | 'body'>): GithubItem => ({
    author: 'mock',
    createdAt: new Date(Date.now() - over.number * 3_600_000).toISOString(),
    labels: [],
    url: `https://github.com/mock/repo/${over.kind === 'pr' ? 'pull' : 'issues'}/${over.number}`,
    comments: 0,
    ...over,
  });
  return {
    available: true,
    repo: 'mock/repo',
    viewerLogin: 'octocat',
    projects: [{ id: 'mock-delivery', title: 'Delivery', url: 'https://github.com/users/mock/projects/1' }],
    syncedAt: new Date().toISOString(),
    issues: [
      mk({ kind: 'issue', assignees: ['octocat'], projectIds: ['mock-delivery'], number: 142, title: 'Login form drops session on refresh', labels: ['bug', 'auth'], comments: 3, body: 'Repro: log in, hit reload — you land back on /login. The session cookie is set correctly, but the client store rehydrates before the cookie check resolves, so the auth guard redirects.' }),
      mk({ kind: 'issue', assignees: ['ada'], projectIds: [], number: 139, title: 'Add --json flag to cez CLI output', labels: ['enhancement', 'cli'], comments: 1, body: 'For scripting it would help if `cez list` and `cez status` could emit machine-readable JSON instead of the table view.' }),
      mk({ kind: 'issue', assignees: [], projectIds: ['mock-delivery'], number: 135, title: 'Flaky e2e: worktree cleanup race on cancel', labels: ['bug', 'flaky-test'], comments: 6, body: 'Cancelling a run while the agent holds a file lock leaves a dangling worktree. The next run on the same branch then fails with "worktree already exists".' }),
    ],
    prs: [
      mk({ kind: 'pr', number: 128, title: 'Fix flaky auth test in CI', labels: ['tests'], checks: 'passing', additions: 6, deletions: 3, body: 'Loosens the timing assertion in refresh.test.ts to a realistic budget.' }),
      mk({ kind: 'pr', number: 124, title: 'Rate limit /api/runs', labels: ['server', 'draft'], isDraft: true, checks: 'failing', additions: 118, deletions: 7, comments: 4, body: 'Draft: token-bucket middleware on the runs router. Still needs the config surface and README docs before review.' }),
    ],
    labelColors: {
      bug: 'd73a4a',
      auth: '5319e7',
      enhancement: 'a2eeef',
      cli: '0e8a16',
      'flaky-test': 'fbca04',
      tests: 'c5def5',
      server: '1d76db',
      draft: '6a737d',
    },
  };
}

// ---- comment threads (#499 Phase 2) ----------------------------------------
// A lazy per-thread fetch behind `GET /api/github/comments/:kind/:number`: the
// conversation comments (issues endpoint — GitHub serves PR conversation
// comments there too), plus submitted reviews for PRs, normalized into one
// chronological `ForgeComment[]`. Its own bounded 60 s cache keeps an open
// detail view from re-fetching on every focus. Degrades to `available: false`
// exactly like the list fetch — never a 5xx.

const ghCommentUser = z.object({ login: z.string(), avatar_url: z.string().nullish() }).nullish();
const ghIssueCommentSchema = z.object({
  id: z.number(),
  user: ghCommentUser,
  created_at: z.string(),
  body: z.string().nullish(),
  html_url: z.string(),
});
const ghReviewSchema = z.object({
  id: z.number(),
  user: ghCommentUser,
  body: z.string().nullish(),
  state: z.string(),
  submitted_at: z.string().nullish(),
  html_url: z.string(),
});

// ---- timeline events (#525) -------------------------------------------------
// The thread's non-comment history — commits, label changes, assignments, merges, force-pushes,
// cross-references. Sourced from `/issues/{n}/timeline`, which returns comments AND events in one
// chronological stream, so the `commented` rows keep flowing through `normalizeComments` unchanged
// and `comments[]` keeps its existing shape.

/** The event kinds rendered in v1 — an allowlist, so a new GitHub event type is dropped rather
 *  than rendered and can never crash or clutter the thread. Real timelines carry plenty that
 *  github.com itself doesn't surface (`subscribed`, `mentioned`, `review_requested`).
 *
 *  `reviewed` is deliberately absent: timeline `reviewed` rows DO carry a body and would work,
 *  but `/pulls/{n}/reviews` is already normalized, chipped and empty-body-filtered, so sourcing
 *  both would render every review twice. */
export const TIMELINE_EVENT_KINDS = new Set<ForgeTimelineEventKind>([
  'committed',
  'labeled',
  'unlabeled',
  'assigned',
  'unassigned',
  'merged',
  'closed',
  'reopened',
  'head_ref_force_pushed',
  'cross-referenced',
  'renamed',
]);

/** Events get their OWN cap, independent of `THREAD_ENTRY_CAP`. A combined cap would mean a
 *  thread with 150 comments and 100 events returns ~120 comments — silently removing contents
 *  from a §2-protected response. */
export const TIMELINE_EVENT_CAP = 200;
/** `gh api --paginate` has no page limit, so the timeline fetch hand-rolls a bounded loop. */
export const TIMELINE_MAX_PAGES = 10;
/** ONE budget shared by every page. `gh()`'s timeout is per invocation, so ten pages at the 15 s
 *  default would put the ceiling at 150 s — an order of magnitude worse than the single
 *  `--paginate` spawn this replaces. The loop tracks a deadline and passes what's left. */
export const TIMELINE_BUDGET_MS = 15_000;
/** Never spawn a page that cannot finish. A bare `remaining <= 0` guard catches only the exact
 *  boundary; the realistic case is 300 ms left, which spawns `gh` with a 300 ms timeout, throws,
 *  and is indistinguishable from a real endpoint failure. */
export const TIMELINE_MIN_PAGE_MS = 2_000;
/** `committed` messages are trimmed to their first line, then this. */
const COMMIT_MESSAGE_CAP = 120;

/** One timeline row. `event` stays a loose `z.string()` so unknown kinds parse and are dropped by
 *  the allowlist rather than throwing the whole page. Extras are stripped by default — notably
 *  `author.email`, which is read for nothing and must not reach the wire type. */
export const ghTimelineEventSchema = z.object({
  event: z.string(),
  id: z.number().nullish(),
  node_id: z.string().nullish(),
  created_at: z.string().nullish(),
  actor: z.object({ login: z.string(), avatar_url: z.string().nullish() }).nullish(),
  url: z.string().nullish(),
  html_url: z.string().nullish(),
  // `committed`
  sha: z.string().nullish(),
  message: z.string().nullish(),
  author: z.object({ name: z.string().nullish(), date: z.string().nullish() }).nullish(),
  // `labeled` / `unlabeled`
  label: z.object({ name: z.string(), color: z.string().nullish() }).nullish(),
  // `assigned` / `unassigned`
  assignee: z.object({ login: z.string() }).nullish(),
  // `renamed`
  rename: z.object({ from: z.string().nullish(), to: z.string().nullish() }).nullish(),
  // `cross-referenced`
  source: z
    .object({
      issue: z
        .object({
          number: z.number().nullish(),
          title: z.string().nullish(),
          html_url: z.string().nullish(),
          pull_request: z.unknown().nullish(),
        })
        .nullish(),
    })
    .nullish(),
});

const REVIEW_STATE: Record<string, ForgeComment['reviewState']> = {
  APPROVED: 'approved',
  CHANGES_REQUESTED: 'changes_requested',
  COMMENTED: 'commented',
  DISMISSED: 'dismissed',
};

/** First 200 thread entries, then `truncated`; each body sliced to 8 000 chars (same cap as
 *  item bodies). */
export const THREAD_ENTRY_CAP = 200;
const COMMENT_BODY_CAP = 8_000;

/** `gh api …/issues/{n}/comments` JSON → `ForgeComment[]`. Exported for unit tests. */
export function normalizeComments(raw: unknown): ForgeComment[] {
  return z.array(ghIssueCommentSchema).parse(raw).map((c) => defined({
    id: c.id,
    author: c.user?.login ?? '?',
    avatarUrl: c.user?.avatar_url ?? undefined,
    createdAt: c.created_at,
    body: (c.body ?? '').slice(0, COMMENT_BODY_CAP),
    kind: 'comment' as const,
    url: c.html_url,
  }));
}

/** `gh api …/pulls/{n}/reviews` JSON → `ForgeComment[]`. Reviews with an empty body AND state
 *  COMMENTED/PENDING carry no signal in a flat thread and are dropped; the rest map to
 *  `kind: 'review'` (Q4). Exported for unit tests. */
export function normalizeReviews(raw: unknown): ForgeComment[] {
  return z
    .array(ghReviewSchema)
    .parse(raw)
    .filter((r) => {
      const state = r.state.toUpperCase();
      const emptyBody = (r.body ?? '').trim().length === 0;
      return !(emptyBody && (state === 'COMMENTED' || state === 'PENDING'));
    })
    .map((r) => defined({
      id: r.id,
      author: r.user?.login ?? '?',
      avatarUrl: r.user?.avatar_url ?? undefined,
      createdAt: r.submitted_at ?? '',
      body: (r.body ?? '').slice(0, COMMENT_BODY_CAP),
      kind: 'review' as const,
      reviewState: REVIEW_STATE[r.state.toUpperCase()],
      url: r.html_url,
    }));
}

/**
 * `gh api …/issues/{n}/timeline` JSON → `ForgeTimelineEvent[]`, plus whether the cap fired.
 *
 * Returns `truncated` rather than just the array because the caller has no other way to learn it:
 * `events.length === TIMELINE_EVENT_CAP` is ambiguous on a thread with exactly that many.
 *
 * Three details here are load-bearing and were verified against a real timeline, not assumed:
 *
 * 1. **`committed` rows return `created_at: null`** — the real timestamp is at `author.date`.
 *    Mapping `created_at` naively yields `createdAt: null` on every commit, which string-sorts to
 *    the top and silently reorders the entire thread.
 * 2. **`committed` carries a git author, not a GitHub actor** — a name, no login, no avatar.
 * 3. **The cap keeps the NEWEST events — `slice(-cap)`**, the opposite of the neighbouring
 *    `mergeThread`, which head-slices. The timeline arrives oldest-first, so `slice(0, cap)` would
 *    retain 200 stale day-one `labeled` rows and discard the merge and the recent commits — the
 *    exact rows #525 asks for.
 *
 * Exported for unit tests.
 */
export function normalizeEvents(
  raw: unknown,
  cap = TIMELINE_EVENT_CAP,
): { events: ForgeTimelineEvent[]; truncated: boolean } {
  const rows = z.array(ghTimelineEventSchema).parse(raw);
  const mapped: ForgeTimelineEvent[] = [];

  rows.forEach((row, index) => {
    const kind = row.event as ForgeTimelineEventKind;
    if (!TIMELINE_EVENT_KINDS.has(kind)) return; // unknown//noise → dropped, never rendered

    // Per-kind timestamp resolution — see (1) above.
    const rawAt = kind === 'committed' ? row.author?.date : row.created_at;
    if (!rawAt) return; // no resolvable timestamp → drop, rather than merge at an arbitrary spot
    // `author.date` arrives with a numeric offset (`+02:00`); normalize so the string compare the
    // thread sorts by stays correct across zones.
    const parsedAt = new Date(rawAt);
    if (Number.isNaN(parsedAt.getTime())) return;
    const createdAt = parsedAt.toISOString();

    // Per-kind actor resolution — see (2) above.
    const actor = (kind === 'committed' ? row.author?.name : row.actor?.login) ?? '?';

    // Identity: `sha` sits ahead of `node_id` deliberately. `committed` rows carry both, and a
    // node_id-first order would key commits by an opaque `C_kwDO…` blob instead of the SHA, which
    // is the natural, debuggable identifier and is already the rollup key. The bare-index fallback
    // reaches only `cross-referenced`, the one kind with no identity at all — as a general scheme
    // it would be wrong, since the id becomes the React key and an index over the post-sort array
    // shifts for every row below an insertion, remounting them on each 60 s refetch.
    const identity = row.id ?? row.sha ?? row.node_id ?? index;

    const event: ForgeTimelineEvent = {
      id: `evt-${identity}`,
      kind,
      actor,
      createdAt,
    };
    // A git author has no avatar, so `committed` deliberately carries none.
    if (kind !== 'committed' && row.actor?.avatar_url) event.avatarUrl = row.actor.avatar_url;

    switch (kind) {
      case 'committed': {
        // Enforce the full-40-hex invariant the rollup query depends on rather than assuming it:
        // `oid` rejects anything else, and a malformed value embedded in the batched query would
        // cost the whole chunk its glyphs instead of just this commit.
        if (row.sha && /^[0-9a-f]{40}$/i.test(row.sha)) event.sha = row.sha;
        if (row.message) event.message = (row.message.split('\n')[0] ?? '').slice(0, COMMIT_MESSAGE_CAP);
        if (row.html_url) event.url = row.html_url;
        break;
      }
      case 'labeled':
      case 'unlabeled': {
        if (row.label) {
          event.label = { name: row.label.name };
          if (row.label.color) event.label.color = row.label.color;
        }
        break;
      }
      case 'assigned':
      case 'unassigned': {
        if (row.assignee?.login) event.subject = row.assignee.login;
        break;
      }
      case 'renamed': {
        if (row.rename?.to) event.subject = row.rename.to;
        break;
      }
      case 'cross-referenced': {
        const issue = row.source?.issue;
        if (issue?.number != null) event.refNumber = issue.number;
        if (issue?.title) event.refTitle = issue.title;
        if (issue) event.refIsPr = Boolean(issue.pull_request);
        if (issue?.html_url) event.url = issue.html_url;
        break;
      }
      default:
        break;
    }

    mapped.push(event);
  });

  const truncated = mapped.length > cap;
  // slice(-cap), NOT slice(0, cap) — see (3) above.
  return { events: truncated ? mapped.slice(-cap) : mapped, truncated };
}

/** Merge comment/review lists chronologically (oldest first) and apply the entry cap. Exported
 *  for unit tests. */
export function mergeThread(
  parts: ForgeComment[][],
  cap = THREAD_ENTRY_CAP,
): { comments: ForgeComment[]; truncated: boolean } {
  const all = parts.flat().sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const truncated = all.length > cap;
  return { comments: truncated ? all.slice(0, cap) : all, truncated };
}

// Per-thread cache: keyed `repoRoot␀kind#number` (the root scopes the key — two projects each
// having a PR #42 must not collide; step 2.6), same 60 s TTL as the list cache but BOUNDED — a
// long browsing session can't grow it without limit (Map preserves insertion order → oldest
// first).
const commentsCache = new Map<string, { at: number; data: ForgeCommentsData }>();
const COMMENTS_CACHE_MAX = 50;

function cacheComments(key: string, data: ForgeCommentsData): void {
  commentsCache.delete(key); // re-insert so this key becomes the newest
  commentsCache.set(key, { at: Date.now(), data });
  while (commentsCache.size > COMMENTS_CACHE_MAX) {
    const oldest = commentsCache.keys().next().value;
    if (oldest === undefined) break;
    commentsCache.delete(oldest);
  }
}

/** Test-only: drop the per-thread cache so cases don't leak state into each other. */
export function __clearCommentsCacheForTests(): void {
  commentsCache.clear();
}

// Single-item cache (#692): same key shape, TTL and LRU bound as `commentsCache`. Only a real
// answer (an item or a confirmed absence) is cached, never an unavailable one.
const itemCache = new Map<string, { at: number; data: Extract<GithubItemResponse, { available: true }> }>();

function itemCacheKey(repoRoot: string, kind: 'issue' | 'pr', number: number): string {
  return `${repoRoot}\0${kind}#${number}`;
}

export function forgetGithubItem(repoRoot: string, kind: 'issue' | 'pr', number: number): void {
  itemCache.delete(itemCacheKey(repoRoot, kind, number));
}

/** Test-only: drop the single-item cache. */
export function __clearGithubItemCacheForTests(): void {
  itemCache.clear();
}

export async function fetchGithubItem(
  repoRoot: string,
  kind: 'issue' | 'pr',
  number: number,
  refresh = false,
): Promise<GithubItemResponse> {
  if (process.env.CEZ_DRY_RUN === '1') {
    const mock = mockGithub();
    const item = (kind === 'issue' ? mock.issues : mock.prs).find((i) => i.number === number);
    return item
      ? { available: true, item, labelColors: mock.labelColors ?? {} }
      : { available: true, item: null };
  }
  const key = itemCacheKey(repoRoot, kind, number);
  const hit = itemCache.get(key);
  if (!refresh && hit && Date.now() - hit.at < CACHE_MS) return hit.data;
  try {
    const forge = await detectGithub(repoRoot);
    if (!forge.available) return { available: false, reason: forge.reason ?? 'GitHub is unavailable' };
    const labelColors: Record<string, string> = {};
    const item = await viewGithubItem(repoRoot, kind, number, labelColors);
    const data: Extract<GithubItemResponse, { available: true }> = {
      available: true, item, ...(item ? { labelColors } : {}),
    };
    itemCache.delete(key); // re-insert so this key becomes the newest
    itemCache.set(key, { at: Date.now(), data });
    while (itemCache.size > COMMENTS_CACHE_MAX) {
      const oldest = itemCache.keys().next().value;
      if (oldest === undefined) break;
      itemCache.delete(oldest);
    }
    return data;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      available: false,
      reason: /ENOENT/.test(message)
        ? 'gh CLI not found — install it and run `gh auth login`'
        : firstLine(message),
    };
  }
}

const TIMELINE_PER_PAGE = 100;

// The repo handle for the per-commit checks query (#525 Phase 2). Memoized per repoRoot — stable
// in practice, and keyed per root rather than globally for multi-project forward-compatibility.
// `null` is a cached permanent negative for malformed identity. Local absence is not cached (#102).
// Network, authentication and timeout failures are deliberately NOT cached: caching them would
// disable glyphs until process restart on one transient failure.
type RepoHandle = { owner: string; name: string } | null;
const repoHandleCache = new Map<string, RepoHandle>();
type RepoDiscoveryFlight = {
  controller: AbortController;
  promise: Promise<RepoHandle>;
  owners: number;
};
const repoDiscoveryFlights = new Map<string, RepoDiscoveryFlight>();

/** Each subscriber owns a lease, not the subprocess. Only the last cancellation aborts it.
 * Keep the rejecting promise intact so strict callers retain gh's diagnostic. */
function sharedRepoHandle(repoRoot: string, signal?: AbortSignal, context = githubContext(repoRoot)): Promise<RepoHandle> {
  if (signal?.aborted) return Promise.reject(signal.reason);
  const memo = repoHandleCache.get(context.key);
  if (memo !== undefined) return Promise.resolve(memo);
  let flight = repoDiscoveryFlights.get(context.key);
  if (!flight) {
    const controller = new AbortController();
    const created: RepoDiscoveryFlight = {
      controller, owners: 0,
      promise: gh(repoRoot, ['repo', 'view', '--json', 'nameWithOwner', '--jq', '.nameWithOwner'], 15_000, controller.signal, context)
        .then(parseOwnerName),
    };
    created.promise = created.promise.then(handle => {
      // A disposed owner may complete late; it must not overwrite a replacement discovery.
      if (!controller.signal.aborted && repoDiscoveryFlights.get(context.key) === created) {
        repoHandleCache.set(context.key, handle);
      }
      return handle;
    }).finally(() => {
      if (repoDiscoveryFlights.get(context.key) === created) repoDiscoveryFlights.delete(context.key);
    });
    flight = created;
    repoDiscoveryFlights.set(context.key, flight);
  }
  const owned = flight;
  owned.owners++;
  return new Promise((resolve, reject) => {
    let released = false;
    const release = () => {
      if (released) return false;
      released = true;
      signal?.removeEventListener('abort', cancel);
      if (--owned.owners === 0 && repoDiscoveryFlights.get(context.key) === owned) {
        repoDiscoveryFlights.delete(context.key);
        owned.controller.abort();
      }
      return true;
    };
    const cancel = () => { if (release()) reject(signal?.reason); };
    signal?.addEventListener('abort', cancel, { once: true });
    owned.promise.then(
      handle => { if (release()) resolve(handle); },
      error => { if (release()) reject(error); },
    );
  });
}

/** Test-only: drop the memoized repo handles. */
export function __clearRepoHandleCacheForTests(): void {
  repoHandleCache.clear();
  for (const flight of repoDiscoveryFlights.values()) flight.controller.abort();
  repoDiscoveryFlights.clear();
}

/** Internal discovery outcome: callers that own a lifecycle can retry only transient failures. */
export type RepoHandleDiscovery =
  | { status: 'resolved'; handle: { owner: string; name: string } }
  | { status: 'unknown' }
  | { status: 'retryable' }
  | { status: 'cancelled' };

/** Local absence cannot improve through network retries. Authentication, timeouts and remote
 * errors deliberately stay retryable, including 404s for temporarily inaccessible repositories. */
function isPermanentRepoFailure(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if ('code' in error && error.code === 'ENOENT') return true;
  const stderr = 'stderr' in error && typeof error.stderr === 'string' ? error.stderr : '';
  return /not a git repository|no git remotes found|none of the git remotes configured for this repository point to a known GitHub host/i.test(`${error.message}\n${stderr}`);
}

/** Share the existing memo with ordinary discovery, but retain failure classification (#102).
 * An aborted owner must never publish its late result into this shared cache. */
export async function discoverRepoHandle(repoRoot: string, signal?: AbortSignal): Promise<RepoHandleDiscovery> {
  const context = githubContext(repoRoot);
  if (signal?.aborted) return { status: 'cancelled' };
  try {
    const handle = await sharedRepoHandle(repoRoot, signal, context);
    if (signal?.aborted) return { status: 'cancelled' };
    return handle ? { status: 'resolved', handle } : { status: 'unknown' };
  } catch (error) {
    if (signal?.aborted) return { status: 'cancelled' };
    if (isPermanentRepoFailure(error)) {
      // Do not replace a successful discovery another caller completed while this one failed.
      const recovered = repoHandleCache.get(context.key);
      if (recovered) return { status: 'resolved', handle: recovered };
      // The live arming loop stops on unknown. Do not memoize local failures here: later cold
      // index/status requests must still discover an installed gh or a newly added remote.
      return { status: 'unknown' };
    }
    return { status: 'retryable' };
  }
}

/** Compatible fail-open lookup for existing API and cold-index callers. */
export async function resolveRepoHandle(
  repoRoot: string,
  signal?: AbortSignal,
): Promise<{ owner: string; name: string } | null> {
  const result = await discoverRepoHandle(repoRoot, signal);
  return result.status === 'resolved' ? result.handle : null;
}

/** What the bounded timeline page loop returns. `stoppedShort` means "the timeline may have more
 *  rows than we fetched" and has exactly three causes — the page cap, the budget floor, and a
 *  failure on page ≥ 2. All three shorten the `commented` stream the same way, so all three feed
 *  `truncated` and arm the comments top-up; the cause does not change the remedy. A short page is
 *  the one exit that does NOT set it: that is the timeline genuinely ending. */
type TimelinePages = { rows: unknown[]; stoppedShort: boolean };

/**
 * Walk `/issues/{n}/timeline` under ONE shared time budget.
 *
 * `gh api --paginate` is not used here: it pages *"until there are no more pages of results"* and
 * exposes no page-limit flag, so the only way to bound the walk is to hand-roll it. The cap that
 * `paginateCounts` gets comes from being a JS cursor loop, not from a `gh` flag.
 *
 * The budget is a **total**, not a per-page allowance. `gh()` takes its timeout per invocation, so
 * ten sequential spawns at the 15 s default would put the ceiling at 150 s — an order of magnitude
 * worse than the single `--paginate` spawn this replaces. The loop tracks a deadline and passes
 * each page whatever remains.
 *
 * Exported for unit tests; `run` is injected so the loop is testable without shelling out.
 */
export async function fetchTimelinePages(
  run: (page: number, timeoutMs: number) => Promise<string>,
  opts: { maxPages?: number; budgetMs?: number; minPageMs?: number; now?: () => number } = {},
): Promise<TimelinePages> {
  const maxPages = opts.maxPages ?? TIMELINE_MAX_PAGES;
  const budgetMs = opts.budgetMs ?? TIMELINE_BUDGET_MS;
  const minPageMs = opts.minPageMs ?? TIMELINE_MIN_PAGE_MS;
  const now = opts.now ?? Date.now;

  const deadline = now() + budgetMs;
  const rows: unknown[] = [];
  let stoppedShort = false;
  let page = 1;

  for (; page <= maxPages; page++) {
    const remaining = deadline - now();
    // Never spawn a page that cannot finish. A bare `remaining <= 0` guard catches only the exact
    // boundary; the realistic case is 300 ms left, which spawns gh with a 300 ms timeout, throws,
    // and looks indistinguishable from a real endpoint failure.
    if (remaining < minPageMs) {
      stoppedShort = true;
      break;
    }
    let parsed: unknown[];
    try {
      parsed = z.array(z.unknown()).parse(JSON.parse(await run(page, remaining)));
    } catch (err) {
      // Page 1 rethrows so the caller's inner catch can decide whether substitution helps —
      // nothing was fetched, so there is nothing to lose. A failure on any later page keeps the
      // pages already in hand: discarding nine good pages to re-fetch comments-only is strictly
      // worse than what the loop already holds.
      if (page === 1) throw err;
      stoppedShort = true;
      break;
    }
    rows.push(...parsed);
    if (parsed.length < TIMELINE_PER_PAGE) break; // short page — the real end of the timeline
  }
  if (page > maxPages) stoppedShort = true; // fell out on the page cap

  return { rows, stoppedShort };
}

/** SHAs per rollup query. Aliases resolve independently, so a chunk that fails costs only its own
 *  glyphs — but an unbounded alias list would eventually blow the query size limit. */
export const COMMIT_CHECKS_CHUNK = 50;

/** One aliased `object(oid:)` per SHA. `oid` requires a FULL 40-char SHA in both literal and
 *  variable form (`Could not coerce value "babda63" to GitObjectID`), which constrains fixtures
 *  rather than production data — the timeline always supplies full SHAs. */
function commitChecksQuery(shas: string[]): string {
  const aliases = shas
    .map((sha, i) => `    c${i}: object(oid: "${sha}") { ... on Commit { statusCheckRollup { state } } }`)
    .join('\n');
  return `query ($owner: String!, $name: String!) {\n  repository(owner: $owner, name: $name) {\n${aliases}\n  }\n}`;
}

const ghCommitChecksSchema = z.record(
  z.string(),
  z.object({ statusCheckRollup: z.object({ state: z.string().nullish() }).nullish() }).nullish(),
);

/**
 * Rolled-up CI state per commit SHA, as a `sha → checks` map.
 *
 * Batched and aliased so a 40-commit PR costs one subprocess, not forty. Verified against the live
 * API: each alias resolves independently and an unknown SHA comes back `null` rather than erroring
 * the batch, so partial results degrade cleanly.
 *
 * Degrades to an empty map on any failure — exactly as `fetchCommentCounts` does for counts. The
 * caller then leaves `checks` **absent**, which the UI renders as no glyph. Exported for tests;
 * `runGraphql` is injected so this is testable without shelling out.
 */
export async function fetchCommitChecks(
  runGraphql: GraphqlRunner,
  owner: string,
  name: string,
  shas: string[],
  chunkSize = COMMIT_CHECKS_CHUNK,
): Promise<Record<string, ForgeTimelineEvent['checks']>> {
  const out: Record<string, ForgeTimelineEvent['checks']> = {};
  if (shas.length === 0) return out;

  for (let i = 0; i < shas.length; i += chunkSize) {
    const chunk = shas.slice(i, i + chunkSize);
    try {
      const raw = JSON.parse(await runGraphql(commitChecksQuery(chunk), { owner, name })) as {
        data?: { repository?: unknown };
      };
      const repository = ghCommitChecksSchema.parse(raw?.data?.repository ?? {});
      chunk.forEach((sha, index) => {
        const node = repository[`c${index}`];
        if (!node) return; // unknown SHA → alias resolved null; leave `checks` absent
        // Adapt the single rollup state into the array shape `rollupToChecks` expects, so the
        // existing FAILURE/PENDING/SUCCESS vocabulary is reused rather than duplicated.
        out[sha] = node.statusCheckRollup
          ? rollupToChecks([{ state: node.statusCheckRollup.state, status: null, conclusion: null }])
          : null; // no CI configured — distinct from absent
      });
    } catch {
      // A failed chunk costs only its own glyphs; the rest still resolve.
    }
  }
  return out;
}

// Hydrate checks on demand in a batched query; failure leaves absent glyphs without failing the list.

/** The single enum a PR row's checks glyph renders (never `undefined` on the wire). */
export type ChecksGlyph = 'passing' | 'failing' | 'pending' | null;

export type GithubChecksData =
  | { available: true; checks: Record<number, ChecksGlyph> }
  | { available: false; reason: string };

/** PR numbers per checks query. Aliases resolve independently (a failed chunk costs only its own
 *  glyphs); bounded so an unbounded number list can't blow the query size limit. Also the route's
 *  hard cap on how many PRs one request may ask about. */
export const GH_CHECKS_MAX = 100;

/** One aliased `pullRequest(number:)` per PR; the rolled-up CI state lives on the head commit. */
function prChecksQuery(numbers: number[]): string {
  const aliases = numbers
    .map(
      (n, i) =>
        `    p${i}: pullRequest(number: ${n}) { commits(last: 1) { nodes { commit { statusCheckRollup { state } } } } }`,
    )
    .join('\n');
  return `query ($owner: String!, $name: String!) {\n  repository(owner: $owner, name: $name) {\n${aliases}\n  }\n}`;
}

const ghPrChecksSchema = z.record(
  z.string(),
  z
    .object({
      commits: z.object({
        nodes: z.array(
          z.object({
            commit: z.object({
              statusCheckRollup: z.object({ state: z.string().nullish() }).nullish(),
            }),
          }),
        ),
      }),
    })
    .nullish(),
);

/**
 * Rolled-up CI state per PR number, as a `number → glyph` map.
 *
 * Batched and aliased so a 100-PR window costs one subprocess, not a hundred. Each alias resolves
 * independently and an unknown number comes back `null` (alias resolved null → left absent), so
 * partial results degrade cleanly. Degrades to an empty map on any failure — exactly as
 * `fetchCommitChecks` does. Exported for tests; `runGraphql` is injected so this is testable
 * without shelling out.
 */
export async function fetchPrChecks(
  runGraphql: GraphqlRunner,
  owner: string,
  name: string,
  numbers: number[],
  chunkSize = GH_CHECKS_MAX,
): Promise<Record<number, ChecksGlyph>> {
  const out: Record<number, ChecksGlyph> = {};
  if (numbers.length === 0) return out;

  for (let i = 0; i < numbers.length; i += chunkSize) {
    const chunk = numbers.slice(i, i + chunkSize);
    try {
      const raw = JSON.parse(await runGraphql(prChecksQuery(chunk), { owner, name })) as {
        data?: { repository?: unknown };
      };
      const repository = ghPrChecksSchema.parse(raw?.data?.repository ?? {});
      chunk.forEach((number, index) => {
        const node = repository[`p${index}`];
        if (!node) return; // unknown PR → alias resolved null; leave the glyph absent
        const rollup = node.commits.nodes[0]?.commit.statusCheckRollup;
        // Adapt the single rollup state into the array shape `rollupToChecks` expects, reusing the
        // FAILURE/PENDING/SUCCESS vocabulary rather than duplicating it.
        out[number] = rollup
          ? rollupToChecks([{ state: rollup.state, status: null, conclusion: null }]) ?? null
          : null; // no CI configured — distinct from absent
      });
    } catch {
      // A failed chunk costs only its own glyphs; the rest still resolve.
    }
  }
  return out;
}

const itemDetailSchema = z.object({
  body: z.string().nullish(),
  additions: z.number().int().nonnegative().optional(),
  deletions: z.number().int().nonnegative().optional(),
});

/** One item's body (and a PR's diffstat), or `undefined` on any failure. */
async function fetchItemDetail(repoRoot: string, kind: 'issue' | 'pr', number: number): Promise<ForgeCommentsData['detail']> {
  try {
    const out = await gh(repoRoot, [kind, 'view', String(number), '--json', kind === 'pr' ? 'body,additions,deletions' : 'body']);
    const parsed = itemDetailSchema.parse(JSON.parse(out));
    return {
      body: (parsed.body ?? '').slice(0, COMMENT_BODY_CAP),
      ...(kind === 'pr' && parsed.additions !== undefined ? { additions: parsed.additions } : {}),
      ...(kind === 'pr' && parsed.deletions !== undefined ? { deletions: parsed.deletions } : {}),
    };
  } catch {
    return undefined;
  }
}

// Per-item comment counts (hearsay-tools/cezarion#1183): the list defers them, and the cockpit
// asks for its loaded rows after paint. Keyed `context␀kind␀number`, same TTL and bound as checks.
const commentCountsCache = new Map<string, { at: number; count: number }>();
const commentCountsSchema = z.object({
  data: z.object({
    repository: z.record(z.string(), z.object({ comments: z.object({ totalCount: z.number().int().nonnegative() }) }).nullable()),
  }),
});

/**
 * Comment counts for the given issue or PR numbers, in one aliased GraphQL query. A number GitHub
 * does not know is absent (unknown), never 0. Degrades to `{ available: false, reason }` — never a
 * throw. Numbers are de-duplicated, validated and capped at `GITHUB_COMMENT_COUNTS_MAX`.
 */
export async function fetchGithubCommentCounts(
  repoRoot: string, kind: 'issue' | 'pr', numbers: number[], refresh = false,
): Promise<GithubCommentCountsData> {
  if (process.env.CEZ_DRY_RUN === '1') return mockGithubCommentCounts(kind, numbers);
  const context = githubContext(repoRoot);
  const wanted = [...new Set(numbers)].filter((n) => Number.isSafeInteger(n) && n > 0).slice(0, GITHUB_COMMENT_COUNTS_MAX);
  const counts: Record<number, number> = {};
  const misses: number[] = [];
  const now = Date.now();
  const keyOf = (n: number) => `${context.key}\0${kind}\0${n}`;
  for (const n of wanted) {
    const hit = commentCountsCache.get(keyOf(n));
    if (!refresh && hit && now - hit.at < CACHE_MS) counts[n] = hit.count;
    else misses.push(n);
  }
  if (misses.length === 0) return { available: true, counts };
  try {
    const handle = await resolveRepoHandleStrict(repoRoot, context);
    if (!handle) return { available: false, reason: 'Could not resolve this repository on GitHub.' };
    // Integers only in the aliases; owner and name travel as variables.
    const fields = misses.map((n) => `n${n}: issueOrPullRequest(number: ${n}) {
      ... on Issue { comments { totalCount } }
      ... on PullRequest { comments { totalCount } }
    }`).join('\n');
    // A number GitHub does not know comes back NOT_FOUND and makes `gh` exit 1 with the rest of
    // the batch on stdout; `refStatusGraphql` keeps that partial answer.
    const raw = await refStatusGraphql(repoRoot, context)(
      `query($owner: String!, $name: String!) { repository(owner: $owner, name: $name) { ${fields} } }`,
      { owner: handle.owner, name: handle.name },
    );
    const rows = commentCountsSchema.parse(JSON.parse(raw)).data.repository;
    for (const n of misses) {
      const count = rows[`n${n}`]?.comments.totalCount;
      if (count === undefined) continue; // unknown number: absent, and asked again next time
      counts[n] = count;
      commentCountsCache.delete(keyOf(n));
      commentCountsCache.set(keyOf(n), { at: now, count });
    }
    while (commentCountsCache.size > CHECKS_CACHE_MAX) {
      const oldest = commentCountsCache.keys().next().value;
      if (oldest === undefined) break;
      commentCountsCache.delete(oldest);
    }
    return { available: true, counts };
  } catch (err) {
    return { available: false, reason: ghFailureReason(err) };
  }
}

/** CEZ_DRY_RUN=1 — the catalog's own counts, so the offline list shows its badges. */
function mockGithubCommentCounts(kind: 'issue' | 'pr', numbers: number[]): GithubCommentCountsData {
  const rows = kind === 'pr' ? mockGithub().prs : mockGithub().issues;
  const counts: Record<number, number> = {};
  for (const n of numbers) {
    const row = rows.find((item) => item.number === n);
    if (row) counts[n] = row.comments;
  }
  return { available: true, counts };
}

// Per-PR checks cache: keyed `repoRoot␀number`, same 60 s TTL as the list cache but BOUNDED. Lets
// a repeated visible-window hydration within a minute serve cached glyphs instead of re-querying.
const checksCache = new Map<string, { at: number; glyph: ChecksGlyph }>();
const CHECKS_CACHE_MAX = 500;

/** Test hook — the per-PR checks cache would otherwise leak state across cases in one process. */
export function __clearChecksCacheForTests(): void {
  checksCache.clear();
}

/**
 * Lazy checks glyphs for the given PR numbers (route-facing). Resolves the repo handle once,
 * serves fresh cache entries, queries only the misses, and degrades to `{ available: false,
 * reason }` when `gh` or the handle is unavailable — never a throw, never a 5xx (plan rule 7).
 * Numbers are de-duplicated, validated, and capped at `GH_CHECKS_MAX`.
 */
export async function fetchGithubChecks(repoRoot: string, numbers: number[]): Promise<GithubChecksData> {
  if (process.env.CEZ_DRY_RUN === '1') return mockGithubChecks(numbers);
  const wanted = [...new Set(numbers)].filter((n) => Number.isInteger(n) && n > 0).slice(0, GH_CHECKS_MAX);
  const checks: Record<number, ChecksGlyph> = {};
  const misses: number[] = [];
  const now = Date.now();
  for (const n of wanted) {
    const hit = checksCache.get(`${repoRoot}\0${n}`);
    if (hit && now - hit.at < CACHE_MS) checks[n] = hit.glyph;
    else misses.push(n);
  }
  if (misses.length === 0) return { available: true, checks };
  try {
    const repoOut = await gh(repoRoot, ['repo', 'view', '--json', 'nameWithOwner', '--jq', '.nameWithOwner']);
    const ownerName = parseOwnerName(repoOut);
    if (!ownerName) return { available: false, reason: 'repository handle unavailable' };
    const runGraphql: GraphqlRunner = (query, variables) => {
      const args = ghGraphqlArgs(query, variables);
      return gh(repoRoot, args);
    };
    const fetched = await fetchPrChecks(runGraphql, ownerName.owner, ownerName.name, misses);
    for (const n of misses) {
      // Absent (unknown/closed PR) caches as `null` so a nonexistent number isn't re-queried.
      const glyph: ChecksGlyph = n in fetched ? fetched[n]! : null;
      checks[n] = glyph;
      checksCache.set(`${repoRoot}\0${n}`, { at: now, glyph });
    }
    while (checksCache.size > CHECKS_CACHE_MAX) {
      const oldest = checksCache.keys().next().value;
      if (oldest === undefined) break;
      checksCache.delete(oldest);
    }
    return { available: true, checks };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      available: false,
      reason: /ENOENT/.test(message)
        ? 'gh CLI not found — install it and run `gh auth login`'
        : firstLine(message),
    };
  }
}

/** CEZ_DRY_RUN=1 — glyphs straight from the mock catalog so the offline demo shows checks. */
function mockGithubChecks(numbers: number[]): GithubChecksData {
  const byNumber = new Map(mockGithub().prs.map((p) => [p.number, (p.checks ?? null) as ChecksGlyph]));
  const checks: Record<number, ChecksGlyph> = {};
  for (const n of numbers) checks[n] = byNumber.get(n) ?? null;
  return { available: true, checks };
}

// ---- reference status (task chips) -----------------------------------------
// The task tables paint a PR/issue chip per row and, until this seam existed, had nothing to
// paint it WITH: `RunRecord` stores the number and the URL, never the state, so a merged PR and
// an abandoned one looked identical. This is the batched read behind those chips — one aliased
// GraphQL query for a whole table, mirroring `fetchPrChecks` in shape, cache and degrade.
//
// Deliberately NOT `prMergeState`: that answers "may I press Merge on THIS one" and costs a
// request (plus a merge-policy lookup) per PR. A table needs a glyph per row, not a merge gate.

/** Where a referenced PR or issue stands. Mirrored by `referenceStatusSchema` in the contract —
 *  see there for why PR `closed` and issue `completed` are separate words. */
export type ReferenceStatus =
  | 'draft'
  | 'review-required'
  | 'changes-requested'
  | 'checks-pending'
  | 'checks-failing'
  | 'ready'
  | 'merged'
  | 'closed'
  | 'open'
  | 'completed'
  | 'not-planned';

export type GithubRefStatusData =
  | {
      available: true;
      prs: Record<number, ReferenceStatus>;
      issues: Record<number, ReferenceStatus>;
      /** The OPEN pull requests among them that do not merge into their base — the second axis,
       *  never folded into a status. Optional on the wire, and absent means "nothing is known"
       *  rather than "no conflicts"; see `conflicts` in the contract. */
      conflicts?: number[];
      /** When to ask again, or `null` when nothing here can change. See `recheckAfterMs` in the
       *  contract for why the SERVER answers this. */
      recheckAfterMs: number | null;
    }
  | { available: false; reason: string; recheckAfterMs: number | null };

/** Numbers per kind in one ref-status query — the same bound, and for the same reasons, as
 *  `GH_CHECKS_MAX`: aliases resolve independently, and the query size stays finite. Taken from the
 *  contract rather than restated, because the cockpit caps its batches by the same number and a
 *  client that guessed high would have every chip in a batch 400 instead of losing its tail. */
export const GH_REF_STATUS_MAX = REFERENCE_STATUS_MAX;

/** A requested reviewer, as either connection spells them. `login` covers `User` and `Bot`, `slug`
 *  covers `Team`; `reviewerKey` folds them into one comparable string. */
const reviewerRefSchema = z
  .object({
    __typename: z.string().nullish(),
    login: z.string().nullish(),
    slug: z.string().nullish(),
  })
  .nullish();

/** One reviewer as a comparable key, or `null` when GitHub named nobody we can match on — which
 *  must never compare equal to another unnamed reviewer, hence `null` rather than a shared "". */
function reviewerKey(ref: z.infer<typeof reviewerRefSchema>): string | null {
  const name = ref?.login ?? ref?.slug;
  return name ? `${ref?.__typename ?? '?'}:${name}` : null;
}

const ghRefStatusPrSchema = z
  .object({
    state: z.string(),
    url: z.unknown().optional(),
    mergedAt: z.unknown().optional(),
    isDraft: z.boolean().nullish(),
    reviewDecision: z.string().nullish(),
    /** `MERGEABLE` | `CONFLICTING` | `UNKNOWN` — GitHub computes it in the background, so
     *  `UNKNOWN` is normal on a PR that was just pushed and must never read as "clean". */
    mergeable: z.string().nullish(),
    commits: z
      .object({
        nodes: z.array(
          z.object({
            commit: z.object({
              committedDate: z.string().nullish(),
              /** `totalCount` says whether the head is a merge; the first parent is the branch's
               *  previous tip, which is the newest commit that is actual WORK when it is. */
              parents: z
                .object({
                  totalCount: z.number(),
                  nodes: z.array(z.object({ committedDate: z.string().nullish() }).nullish()).nullish(),
                })
                .nullish(),
              statusCheckRollup: z.object({ state: z.string().nullish() }).nullish(),
            }),
          }),
        ),
      })
      .nullish(),
    reviews: z.object({ nodes: z.array(z.object({ submittedAt: z.string().nullish() })) }).nullish(),
    /** Who is on the hook RIGHT NOW. The reviewers are carried, not just the count, because a
     *  request's date has to be matched to a request that still stands — see `reviewRequestedAt`. */
    reviewRequests: z
      .object({
        totalCount: z.number(),
        nodes: z.array(z.object({ requestedReviewer: reviewerRefSchema }).nullish()).nullish(),
      })
      .nullish(),
    timelineItems: z
      .object({
        nodes: z
          .array(z.object({ createdAt: z.string().nullish(), requestedReviewer: reviewerRefSchema }).nullish())
          .nullish(),
      })
      .nullish(),
  })
  .nullish();

type GhRefStatusPr = NonNullable<z.infer<typeof ghRefStatusPrSchema>>;

/**
 * When was the newest STILL-STANDING review request made?
 *
 * The two connections answer different halves and neither answers both: `reviewRequests` says who
 * is on the hook right now but carries no date, while a `ReviewRequestedEvent` carries the date and
 * survives the request being withdrawn. Reading the newest event on its own therefore dates a
 * request that may no longer exist — and a request added after a review and then removed would make
 * a live rejection read as answered, which is the exact bug the precedence above exists to fix.
 * Matching the two by reviewer is what keeps the date attached to a request that is really there.
 *
 * `null` when nothing matches, which the precedence reads as an undated request and treats
 * conservatively: the review stands rather than being dismissed on a guess.
 */
function standingReviewRequestedAt(
  requests: GhRefStatusPr['reviewRequests'],
  timeline: GhRefStatusPr['timelineItems'],
): string | null {
  const standing = new Set<string>();
  for (const node of requests?.nodes ?? []) {
    const key = reviewerKey(node?.requestedReviewer);
    if (key) standing.add(key);
  }
  if (standing.size === 0) return null;
  let newest: string | null = null;
  for (const node of timeline?.nodes ?? []) {
    if (!node?.createdAt) continue;
    const key = reviewerKey(node.requestedReviewer);
    if (!key || !standing.has(key)) continue;
    if (!newest || isAfter(node.createdAt, newest)) newest = node.createdAt;
  }
  return newest;
}

const ghRefStatusIssueSchema = z.object({ state: z.string(), stateReason: z.string().nullish() }).nullish();

// The aliases hold two DIFFERENT shapes, so the record stays unvalidated here and each alias is
// parsed by its own schema below. A union at this level would be wrong, not merely loose: zod
// strips unknown keys, so a PR node matched by the issue arm would come back with `isDraft` and
// `commits` silently removed.
const ghRefStatusSchema = z.record(z.string(), z.unknown());

/**
 * Query issueOrPullRequest once per number and use __typename for the actual kind. Include
 * branch-work and review timestamps for freshness decisions.
 */
function refStatusQuery(numbers: number[]): string {
  const aliases = numbers
    .map(
      (n, i) =>
        `    r${i}: issueOrPullRequest(number: ${n}) { __typename ... on PullRequest { url mergedAt state isDraft reviewDecision mergeable commits(last: 1) { nodes { commit { committedDate parents(first: 1) { totalCount nodes { committedDate } } statusCheckRollup { state } } } } reviews(last: 1, states: CHANGES_REQUESTED) { nodes { submittedAt } } reviewRequests(first: 20) { totalCount nodes { requestedReviewer { __typename ... on User { login } ... on Bot { login } ... on Team { slug } } } } timelineItems(last: 20, itemTypes: [REVIEW_REQUESTED_EVENT]) { nodes { ... on ReviewRequestedEvent { createdAt requestedReviewer { __typename ... on User { login } ... on Bot { login } ... on Team { slug } } } } } } ... on Issue { state stateReason } }`,
    )
    .join('\n');
  return `query ($owner: String!, $name: String!) {\n  repository(owner: $owner, name: $name) {\nnameWithOwner\n${aliases}\n  }\n}`;
}

/**
 * Derive whose action is pending: terminal, draft, pending checks, current requested changes,
 * failing checks, review, then ready. Use dated review/work evidence; mergeability remains a
 * separate axis.
 */
export function derivePrReferenceStatus(pr: {
  state: string;
  isDraft?: boolean | null | undefined;
  reviewDecision?: string | null | undefined;
  checks: ChecksGlyph;
  /** ISO-8601 commit date of the head commit. `committedDate`, not a push time: GitHub's
   *  `pushedDate` is deprecated and comes back null on new PRs. */
  headCommittedAt?: string | null | undefined;
  /** How many parents the head commit has. 2+ means a MERGE — "Update branch" pulling the base in,
   *  not work on the review. See `answered` below. Absent reads as an ordinary commit: the push
   *  rule is the common path and must not switch off on a field GitHub declined to send. */
  headParentCount?: number | null | undefined;
  /** ISO-8601 `committedDate` of the head's FIRST parent, which on a merge is the branch's previous
   *  tip — the newest commit that is actual work. Only read when the head is a merge. */
  headFirstParentCommittedAt?: string | null | undefined;
  /** ISO-8601 `submittedAt` of the most recent CHANGES_REQUESTED review, when there is one. */
  changesRequestedAt?: string | null | undefined;
  /** Is a reviewer currently ON THE HOOK — `reviewRequests.totalCount > 0`? True after the author
   *  clicks re-request, which is the one thing that says so while `reviewDecision` still reads
   *  `CHANGES_REQUESTED` — but also true of a reviewer asked long ago who never looked, hence
   *  `reviewRequestedAt`. */
  reviewRequested?: boolean | null;
  /** ISO-8601 `createdAt` of the most recent `ReviewRequestedEvent`, which is WHEN the standing
   *  request was made. Only a request younger than the review can be an answer to it. */
  reviewRequestedAt?: string | null;
}): ReferenceStatus {
  const state = pr.state.toUpperCase();
  if (state === 'MERGED') return 'merged';
  if (state === 'CLOSED') return 'closed';
  if (pr.isDraft) return 'draft';
  if (pr.checks === 'pending') return 'checks-pending';

  const decision = (pr.reviewDecision ?? '').toUpperCase();
  const changesRequested = decision === 'CHANGES_REQUESTED';
  // Has the author already answered the review — by asking for another look, or by pushing?
  // A standing request counts as the ask only if it POSTDATES the review; one made before it is a
  // reviewer who has not got to the PR yet, and on a PR where someone else rejected it that
  // request would otherwise mask the rejection indefinitely. With no review date at all it still
  // counts — that is the empty-`reviews` case above, where it is the only signal there is.
  const reRequested =
    pr.reviewRequested === true && (!pr.changesRequestedAt || isAfter(pr.reviewRequestedAt, pr.changesRequestedAt));
  // A push counts as the answer, judged by the newest commit that is actual WORK. GitHub's "Update
  // branch" button (and this cockpit's own "Resolve conflicts") writes `Merge branch 'main' into
  // <branch>` dated NOW, newer than any review while addressing none of it: the click people make
  // reflexively on a stale PR must not wipe a rejection off the chip. Two parents is what tells
  // that commit apart from work.
  //
  // Which is why a merge is not simply DISQUALIFYING: it is transparent. Reading only the head
  // would let a merge landing on top of a genuine fix erase that fix's answer and flip the chip
  // back to red, blaming an author who already responded — the same misattribution this whole
  // function exists to prevent, just pointed the other way. The merge's FIRST parent is the
  // branch's previous tip, so it carries the date of the work the merge sat on top of.
  const workCommittedAt =
    (pr.headParentCount ?? 1) < 2 ? pr.headCommittedAt : pr.headFirstParentCommittedAt;
  const pushed = isAfter(workCommittedAt, pr.changesRequestedAt);
  const answered = reRequested || pushed;
  if (changesRequested && !answered) return 'changes-requested';
  if (pr.checks === 'failing') return 'checks-failing';
  // `APPROVED` is the forge saying the review requirement IS MET, and it outranks a pending
  // request: a reviewer left on the list after someone else approved is a courtesy ask, not an
  // unmet gate. (A repo needing two approvals reports `REVIEW_REQUIRED` until it has both, so
  // `APPROVED` never arrives early.) Without this, an approved, green, mergeable pull request
  // reads "waiting for review" for as long as anyone stays listed — which is indefinitely.
  if (decision === 'APPROVED') return 'ready';
  if (changesRequested || decision === 'REVIEW_REQUIRED' || pr.reviewRequested === true) {
    return 'review-required';
  }
  return 'ready';
}

/**
 * Whether this pull request's branch merges into its base — the OTHER axis, kept out of
 * `derivePrReferenceStatus` on purpose (see `conflicts` in the contract).
 *
 * Three values, and the third is the one that matters. GitHub does not store mergeability; it
 * COMPUTES it when asked, and answers `UNKNOWN` while the background job runs — which is the
 * normal answer for the first seconds after every push, and therefore for exactly the moment a
 * cockpit is most likely to be looking. `UNKNOWN` means *we were not told*, never *it is clean*,
 * and the caller must be able to tell those apart: it is what decides how soon to ask again
 * (`refStatusTtl`), and answering it as "not conflicting" with a one-minute TTL is precisely how a
 * conflicting pull request came to sit there wearing "Ready to merge".
 *
 * `undefined` for anything the question does not apply to: an issue, and a merged or closed pull
 * request (GitHub says `UNKNOWN` for those too, forever, and a terminal PR has no conflict left to
 * resolve — a merged PR wearing a conflict chip is a lie the state alone rules out).
 */
export type Mergeability = 'mergeable' | 'conflicting' | 'unknown';

export function mergeabilityOf(state: string, mergeable: string | null | undefined): Mergeability | undefined {
  if (state.toUpperCase() !== 'OPEN') return undefined;
  switch (mergeable?.toUpperCase()) {
    case 'MERGEABLE':
      return 'mergeable';
    case 'CONFLICTING':
      return 'conflicting';
    default:
      // Includes a field GitHub omitted entirely: not being told is not being told.
      return 'unknown';
  }
}

/** Did `later` happen AFTER `earlier` — a commit, or a re-request, landing past the review?
 *  Unparseable or missing dates answer `false`, which is the conservative direction for both
 *  callers: they only ever use a `true` to demote a review, so no answer must keep the review
 *  current rather than silently dismiss one. */
function isAfter(later?: string | null, earlier?: string | null): boolean {
  const a = later ? Date.parse(later) : NaN;
  const b = earlier ? Date.parse(earlier) : NaN;
  return Number.isFinite(a) && Number.isFinite(b) && a > b;
}

/**
 * An issue's two signals as one word. `NOT_PLANNED` is kept apart from `completed` because they
 * are opposite outcomes — "we did it" vs "we won't" — and a task whose issue was declined must
 * not read as a task that landed.
 */
export function deriveIssueReferenceStatus(issue: {
  state: string;
  stateReason?: string | null | undefined;
}): ReferenceStatus {
  if (issue.state.toUpperCase() !== 'CLOSED') return 'open';
  return (issue.stateReason ?? '').toUpperCase() === 'NOT_PLANNED' ? 'not-planned' : 'completed';
}

/** What one number turned out to be, and where it stands. `kind` is the forge's answer, not the
 *  caller's guess — see `refStatusQuery`. */
export interface ResolvedReference {
  kind: 'pr' | 'issue';
  status: ReferenceStatus;
  /** Where this pull request stands on the OTHER axis, or absent when the question does not
   *  apply (an issue, a merged or closed PR). Deliberately not folded into `status`; see
   *  `mergeabilityOf`, and `conflicts` in the contract. `unknown` is kept as a value rather than
   *  collapsed into "not conflicting", because it is the difference between an answer and a
   *  question GitHub has not finished answering. */
  mergeable?: Mergeability;
}

/**
 * The outcome of one batched lookup. `failed` is what separates *this number is not in the
 * repository* from *we could not ask about this number* — an absence and a failure, which look
 * identical in a `number → status` map and mean opposite things to a reader ("that reference is
 * bogus" vs "GitHub is down"). Keeping them apart is what stops a transient error being cached,
 * and shown, as "not found".
 */
export interface RefStatusBatch {
  resolved: Record<number, ResolvedReference>;
  /** Numbers whose chunk threw. Nothing is known about them either way. */
  failed: number[];
  /** First failure's message, for the payload's `reason`. */
  reason?: string;
}

/**
 * Status per NUMBER, resolved to whatever that number actually is.
 *
 * Batched and aliased like `fetchPrChecks`: one subprocess per chunk, each alias resolving
 * independently, and a number the forge does not have simply staying absent from `resolved` (its
 * chip then renders neutral, as it did before this seam existed). A failed chunk costs only its
 * own numbers, and says so rather than letting them look absent. Exported for tests; `runGraphql`
 * is injected so this is testable without shelling out.
 */
export async function fetchRefStatuses(
  runGraphql: GraphqlRunner,
  owner: string,
  name: string,
  numbers: number[],
  chunkSize = GH_REF_STATUS_MAX,
): Promise<RefStatusBatch> {
  const out: RefStatusBatch = { resolved: {}, failed: [] };
  if (numbers.length === 0) return out;

  for (let i = 0; i < numbers.length; i += chunkSize) {
    const chunk = numbers.slice(i, i + chunkSize);
    try {
      const raw = JSON.parse(await runGraphql(refStatusQuery(chunk), { owner, name })) as {
        data?: { repository?: unknown };
        errors?: unknown;
      };
      const repository = ghRefStatusSchema.parse(raw?.data?.repository ?? {});
      chunk.forEach((number, index) => {
        const node = repository[`r${index}`] as { __typename?: string } | null | undefined;
        // Absent alias → the number is not in this repository at all. Left out of the map, which
        // is what the route reports as "not found" and the chip paints as neutral.
        if (!node) return;
        if (node.__typename === 'PullRequest') {
          const pr = ghRefStatusPrSchema.parse(node);
          if (!pr) return;
          if ((!raw.errors || (Array.isArray(raw.errors) && raw.errors.length === 0)) &&
            typeof repository.nameWithOwner === 'string' && repository.nameWithOwner.toLowerCase() === `${owner}/${name}`.toLowerCase()) {
            mergedPullRequestObservations.observe({ owner, repo: name, number }, { ...pr, number });
          }
          const head = pr.commits?.nodes[0]?.commit;
          const rollup = head?.statusCheckRollup;
          const mergeability = mergeabilityOf(pr.state, pr.mergeable);
          out.resolved[number] = {
            kind: 'pr',
            status: derivePrReferenceStatus({
              state: pr.state,
              isDraft: pr.isDraft,
              reviewDecision: pr.reviewDecision,
              // Adapt the single rollup state into the array shape `rollupToChecks` expects,
              // reusing the FAILURE/PENDING/SUCCESS vocabulary rather than duplicating it.
              checks: rollup ? rollupToChecks([{ state: rollup.state, status: null, conclusion: null }]) ?? null : null,
              headCommittedAt: head?.committedDate,
              // Two parents = "Update branch", which is dated now and answers nothing on its own —
              // so the first parent's date, the work it sat on top of, is carried with it.
              headParentCount: head?.parents?.totalCount,
              headFirstParentCommittedAt: head?.parents?.nodes?.[0]?.committedDate,
              // `reviews(last: 1, states: CHANGES_REQUESTED)` — the timestamp only. WHETHER changes
              // are requested stays `reviewDecision`'s answer, which is the one that accounts for
              // dismissed and superseded reviews.
              changesRequestedAt: pr.reviews?.nodes[0]?.submittedAt,
              reviewRequested: (pr.reviewRequests?.totalCount ?? 0) > 0,
              // WHEN that standing request was made. `reviewRequests` carries no date of its own,
              // and without one an old request looks exactly like a re-request.
              reviewRequestedAt: standingReviewRequestedAt(pr.reviewRequests, pr.timelineItems),
            }),
            // The tri-state, not a boolean: `unknown` has to survive as far as the cache, which
            // is what decides to ask again in seconds rather than in a minute.
            ...(mergeability ? { mergeable: mergeability } : {}),
          };
        } else if (node.__typename === 'Issue') {
          const issue = ghRefStatusIssueSchema.parse(node);
          if (!issue) return;
          out.resolved[number] = { kind: 'issue', status: deriveIssueReferenceStatus(issue) };
        }
      });
    } catch (err) {
      // A failed chunk costs only its own numbers; the rest still resolve. They are recorded as
      // FAILED rather than left absent, so nothing downstream mistakes them for "no such number".
      out.failed.push(...chunk);
      out.reason ??= firstLine(err instanceof Error ? err.message : String(err));
    }
  }
  return out;
}

// Per-reference cache: keyed `repoRoot␀number` — by NUMBER, not by kind, because the kind is now
// something the forge answers rather than something the caller asserts. Same 60 s TTL and bounded
// shape as the checks cache; `null` is a cached "this repository has no such number", so a
// transcript-scraped number from another repo is not re-queried on every table repaint.
//
// `unknownSince` is when this reference FIRST came back with its mergeability still being
// computed, carried across refreshes so the fast recheck below is bounded to that first window
// rather than restarting on every answer that is still `unknown`.
const refStatusCache = new Map<
  string,
  { at: number; resolved: ResolvedReference | null; unknownSince?: number }
>();
const REF_STATUS_CACHE_MAX = 500;

/** Test-only: drop the per-reference cache so cases don't leak state into each other. */
export function __clearRefStatusCacheForTests(): void {
  refStatusCache.clear();
  refStatusFlights.clear();
}

/** Test-only: warm the cache the way the lazy route would have, so a reader can be tested
 *  without a forge behind it. */
export function __seedRefStatusCacheForTests(
  repoRoot: string,
  entries: Array<[number, ResolvedReference]>,
): void {
  for (const [number, resolved] of entries) {
    refStatusCache.set(refStatusKey(repoRoot, number), { at: Date.now(), resolved });
  }
}

/**
 * Invalidate one reference after a known mutation. Let the next forge read establish status
 * rather than caching a guessed result.
 */
export function forgetRefStatus(repoRoot: string, number: number): void {
  refStatusCache.delete(refStatusKey(repoRoot, number));
  refStatusFlights.delete(refStatusKey(repoRoot, number));
}

/**
 * Everything the cache ALREADY knows about these numbers. Never spawns `gh`, never awaits.
 *
 * This is what lets a status ride along with the rows that carry the references, instead of the
 * cockpit fetching it separately a moment later: the run index reads whatever is warm and ships
 * it, and a cold entry is simply absent — the lazy `/github/ref-status` route stays the thing that
 * actually goes and asks.
 *
 * Because it cannot cost anything, the caller may pass a SUPERSET of the numbers it will really
 * display. That matters: deciding which of a run's references a chip shows is the cockpit's rule
 * (#407, #526), deliberately not duplicated server-side, and a cache read does not need to know —
 * it can look up every number a run mentions and let the client pick.
 */
export function readCachedRefStatuses(
  repoRoot: string,
  numbers: Iterable<number>,
): { prs: Record<number, ReferenceStatus>; issues: Record<number, ReferenceStatus> } {
  const out = { prs: {} as Record<number, ReferenceStatus>, issues: {} as Record<number, ReferenceStatus> };
  const now = Date.now();
  for (const number of new Set(numbers)) {
    const hit = refStatusCache.get(refStatusKey(repoRoot, number));
    if (!hit || !hit.resolved || now - hit.at >= refStatusTtl(hit.resolved, hit.unknownSince, now)) continue;
    out[hit.resolved.kind === 'pr' ? 'prs' : 'issues'][number] = hit.resolved.status;
  }
  return out;
}

// The `#N` in a forge URL. Defined beside the run search matcher, which reads it too (#864).
export { refNumberFromUrl } from '@open-mercato/cezar-contract/run-search';

/** A closed issue or an abandoned PR can be REOPENED, so this is long rather than forever — but
 *  it is the rare event, and re-asking a hundred settled references every minute to catch it is
 *  the wrong trade. */
const REF_STATUS_CLOSED_TTL = 10 * 60_000;
/** A merged pull request is merged forever: GitHub has no un-merge. Capped at a day only so a
 *  long-lived server eventually re-reads rather than trusting a value from another era. */
const REF_STATUS_MERGED_TTL = 24 * 60 * 60_000;

/**
 * How long a cached answer stays fresh — by how changeable that answer IS.
 *
 * One TTL for everything gets both ends wrong: it re-asks about a merged PR (which cannot change)
 * every minute, and it is the only thing standing between a running CI job and a stale chip. What
 * a reader wants rechecked is precisely what is still moving.
 *
 * A number the repository does not have keeps the short TTL: it is usually a wrong number, but it
 * is also what a reference to a not-yet-created PR looks like, and re-asking is cheap.
 */
function refStatusTtl(entry: ResolvedReference | null, unknownSince?: number, now = Date.now()): number {
  if (!entry) return CACHE_MS;
  // Mergeability GitHub has not finished computing is not an answer to cache for a minute. It is
  // the normal reply for the first seconds after a push, and holding it that long is what let a
  // conflicting pull request read "Ready to merge" until the page was reloaded. Ask again in
  // seconds instead — and only while it is still plausibly being computed, so a repository that
  // answers `UNKNOWN` indefinitely settles back to the ordinary cadence rather than spawning `gh`
  // every few seconds forever.
  if (
    entry.mergeable === 'unknown' &&
    unknownSince !== undefined &&
    now - unknownSince < MERGEABILITY_UNKNOWN_WINDOW_MS
  ) {
    return MERGEABILITY_UNKNOWN_TTL_MS;
  }
  switch (entry.status) {
    case 'merged':
      return REF_STATUS_MERGED_TTL;
    case 'closed':
    case 'completed':
    case 'not-planned':
      return REF_STATUS_CLOSED_TTL;
    default:
      return CACHE_MS;
  }
}

/** How long a status can be trusted to stay put — `null` when it can never change again. The
 *  cadence half of `refStatusTtl`, and deliberately the same function: a value the cache would
 *  still be serving is a value there is no point asking for, and a value it would NOT serve —
 *  mergeability still being computed — is one the cockpit should come back for just as soon. */
function refStatusRecheckAfter(entry: ResolvedReference | null, unknownSince?: number, now = Date.now()): number | null {
  if (entry?.status === 'merged') return null; // GitHub has no un-merge
  return refStatusTtl(entry, unknownSince, now);
}

/** How long the WHOLE answer holds — the soonest any single reference in it could differ. `null`
 *  only when every one of them is immutable, which is what tells the cockpit to stop scheduling.
 *  Taking the per-reference values rather than the entries, because one of them may be on the fast
 *  mergeability cadence and the batch has to travel at the speed of its most impatient member. */
function batchRecheckAfter(rechecks: (number | null)[]): number | null {
  let soonest: number | null = null;
  for (const after of rechecks) {
    if (after === null) continue;
    soonest = soonest === null ? after : Math.min(soonest, after);
  }
  return soonest;
}

/**
 * How long a still-computing mergeability holds, and for how long that fast cadence applies.
 *
 * Five seconds because that is the shape of the thing being waited for: GitHub kicks off the
 * merge-base computation when asked and usually has it by the next request. Bounded to a minute
 * because a value that is STILL unknown after that is not a computation in flight any more — it is
 * a repository that will not answer, and re-asking it every five seconds forever costs a `gh`
 * subprocess a second for nothing.
 */
const MERGEABILITY_UNKNOWN_TTL_MS = 5_000;
const MERGEABILITY_UNKNOWN_WINDOW_MS = 60_000;

/** A forge that could not be reached is worth retrying, and worth not hammering: a workspace with
 *  no `gh` installed would otherwise spawn a subprocess a minute, forever, to be told the same
 *  thing. Five minutes is the same order as the cockpit's own reconnect cadence. */
const REF_STATUS_RETRY_MS = 5 * 60_000;

/**
 * Use failed gh GraphQL stdout only when it contains usable data.repository. Preserve successful
 * aliases in partial responses; rethrow malformed or unresolved-repository failures.
 */
function refStatusGraphql(repoRoot: string, context = githubContext(repoRoot)): GraphqlRunner {
  return async (query, variables) => {
    const args = ghGraphqlArgs(query, variables);
    try {
      return await gh(repoRoot, args, 15_000, undefined, context);
    } catch (err) {
      const stdout = (err as { stdout?: unknown }).stdout;
      if (typeof stdout === 'string' && hasResolvedRepository(stdout)) return stdout;
      throw err;
    }
  };
}

/**
 * The repo handle, memoized in the same map `resolveRepoHandle` uses — but rethrowing instead of
 * answering `null`.
 *
 * The memo is the point: without it every recheck tick spawned a second subprocess to re-learn an
 * `owner/name` that changes approximately never, doubling the cost of the one query that actually
 * carries information. The difference from `resolveRepoHandle` is the failure: this route turns a
 * `gh` error into the payload's `reason` — "gh CLI not found — install it and run `gh auth login`"
 * is what the chip's tooltip now shows a user — and a `null` would erase which failure it was.
 */
async function resolveRepoHandleStrict(repoRoot: string, context = githubContext(repoRoot)): Promise<{ owner: string; name: string } | null> {
  return sharedRepoHandle(repoRoot, undefined, context);
}

/** Is this a reply we can still read aliases out of? `repository: null` says the handle did not
 *  resolve, which is a real failure and must not be read as "the numbers are all missing". */
function hasResolvedRepository(stdout: string): boolean {
  try {
    const parsed = JSON.parse(stdout) as { data?: { repository?: unknown } };
    const repository = parsed?.data?.repository;
    return typeof repository === 'object' && repository !== null;
  } catch {
    return false;
  }
}

type RefStatusResult = { resolved: ResolvedReference | null; unknownSince?: number } | { reason: string };
// Ownership is per reference, before discovery starts. Overlapping requests join just the
// numbers they need; extra numbers form their own batch without a batching timer or new delay.
// At capacity, untracked work answers its callers without caching: it has no ownership token
// to protect publication against invalidation or newer requests. Retained ownership is at most 500.
const refStatusFlights = new Map<string, Promise<RefStatusResult>>();

async function sharedRefStatusMisses(repoRoot: string, numbers: number[], context: GithubContext): Promise<Array<[number, RefStatusResult]>> {
  const pending = new Map<number, Promise<RefStatusResult>>();
  const owned: number[] = [];
  for (const n of numbers) {
    const flight = refStatusFlights.get(refStatusKey(repoRoot, n, context));
    if (flight) pending.set(n, flight);
    else owned.push(n);
  }
  if (owned.length) {
    const batch = (async () => {
      const handle = await resolveRepoHandleStrict(repoRoot, context);
      if (!handle) throw new Error('repository handle unavailable');
      return fetchRefStatuses(refStatusGraphql(repoRoot, context), handle.owner, handle.name, owned);
    })();
    for (const n of owned) {
      const key = refStatusKey(repoRoot, n, context);
      const tracked = refStatusFlights.size < REF_STATUS_CACHE_MAX;
      const promise: Promise<RefStatusResult> = batch.then(result => {
        if (result.failed.includes(n)) return { reason: result.reason ?? 'GitHub could not be reached' };
        // Date fresh results at arrival; keep the original unknown-mergeability retry window.
        const storedAt = Date.now();
        const entry = result.resolved[n] ?? null;
        const unknownSince = entry?.mergeable === 'unknown'
          ? (refStatusCache.get(key)?.unknownSince ?? storedAt) : undefined;
        const value = { resolved: entry, ...(unknownSince === undefined ? {} : { unknownSince }) };
        if (tracked && refStatusFlights.get(key) === promise) {
          refStatusCache.set(key, { at: storedAt, ...value });
          while (refStatusCache.size > REF_STATUS_CACHE_MAX) refStatusCache.delete(refStatusCache.keys().next().value!);
        }
        return value;
      }).finally(() => {
        if (refStatusFlights.get(key) === promise) refStatusFlights.delete(key);
      });
      if (tracked) refStatusFlights.set(key, promise);
      pending.set(n, promise);
    }
  }
  return Promise.all(numbers.map(async n => [n, await pending.get(n)!] as [number, RefStatusResult]));
}

/**
 * Route-facing reference status. Resolves the repo handle once, serves fresh cache entries,
 * queries only the misses, and degrades to `{ available: false, reason }` when `gh` or the handle
 * is unavailable — never a throw, never a 5xx.
 *
 * The two request lists are merged into ONE set of numbers: issues and pull requests share a
 * repository's numbering space, so a number is one thing and asking about it twice would be asking
 * the same question twice. What comes back is filed by what each number turned out to BE, which is
 * why a chip whose kind the cockpit guessed wrong still gets the right status.
 */
export async function fetchGithubRefStatus(
  repoRoot: string,
  input: { prs?: number[]; issues?: number[] },
): Promise<GithubRefStatusData> {
  const context = githubContext(repoRoot);
  const asPrs = sanitizeRefNumbers(input.prs);
  const asIssues = sanitizeRefNumbers(input.issues);
  if (process.env.CEZ_DRY_RUN === '1') return mockGithubRefStatus(asPrs, asIssues);
  const wanted = [...new Set([...asPrs, ...asIssues])];

  const resolved = { prs: {} as Record<number, ReferenceStatus>, issues: {} as Record<number, ReferenceStatus> };
  // How soon each reference in the answer could differ — what the batch's cadence is the minimum
  // of. Per reference rather than per batch because mergeability still being computed is worth
  // coming back for in seconds while everything else holds for a minute.
  const rechecks: (number | null)[] = [];
  // The second axis, and a list rather than a map because it is nearly always empty: only the
  // pull requests the forge actively called CONFLICTING are named (see `mergeabilityOf`).
  const conflicts: number[] = [];
  const file = (number: number, entry: ResolvedReference | null, unknownSince?: number) => {
    rechecks.push(refStatusRecheckAfter(entry, unknownSince));
    if (!entry) return;
    resolved[entry.kind === 'pr' ? 'prs' : 'issues'][number] = entry.status;
    if (entry.mergeable === 'conflicting') conflicts.push(number);
  };
  const misses: number[] = [];
  const now = Date.now();
  for (const n of wanted) {
    const hit = refStatusCache.get(refStatusKey(repoRoot, n, context));
    if (!hit || now - hit.at >= refStatusTtl(hit.resolved, hit.unknownSince, now)) misses.push(n);
    else file(n, hit.resolved, hit.unknownSince);
  }
  if (misses.length === 0) {
    return {
      available: true,
      prs: resolved.prs,
      issues: resolved.issues,
      conflicts,
      recheckAfterMs: batchRecheckAfter(rechecks),
    };
  }
  try {
    const entries = await sharedRefStatusMisses(repoRoot, misses, context);
    let failure: string | undefined;
    for (const [n, result] of entries) {
      if ('reason' in result) failure ??= result.reason;
      else file(n, result.resolved, result.unknownSince);
    }
    // Anything unasked makes the whole answer `unavailable`, deliberately. The alternative is a
    // payload where a number we could not reach is indistinguishable from one that does not exist,
    // and the cockpit would paint "not found on this repository" over a perfectly good PR — the
    // exact defect this route was reported for. The successes are cached either way, so the next
    // request costs only the numbers that failed and usually answers in full.
    if (failure !== undefined) {
      return {
        available: false,
        reason: failure,
        recheckAfterMs: REF_STATUS_RETRY_MS,
      };
    }
    return {
      available: true,
      prs: resolved.prs,
      issues: resolved.issues,
      conflicts,
      recheckAfterMs: batchRecheckAfter(rechecks),
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      available: false,
      reason: /ENOENT/.test(message)
        ? 'gh CLI not found — install it and run `gh auth login`'
        : firstLine(message),
      recheckAfterMs: REF_STATUS_RETRY_MS,
    };
  }
}

/** NUL separator, as everywhere else here: two projects each having a #42 must not collide. */
function refStatusKey(repoRoot: string, number: number, context = githubContext(repoRoot)): string {
  return `${context.key}\0#${number}`;
}

function sanitizeRefNumbers(numbers: number[] | undefined): number[] {
  return [...new Set(numbers ?? [])].filter((n) => Number.isInteger(n) && n > 0).slice(0, GH_REF_STATUS_MAX);
}

/** CEZ_DRY_RUN=1 — statuses derived from the mock catalog so the offline demo paints real chips. */
function mockGithubRefStatus(prs: number[], issues: number[]): GithubRefStatusData {
  const catalog = mockGithub();
  const byPr = new Map(catalog.prs.map((p) => [p.number, p]));
  const byIssue = new Set(catalog.issues.map((i) => i.number));
  const out: GithubRefStatusData = { available: true, prs: {}, issues: {}, recheckAfterMs: CACHE_MS };
  for (const n of prs) {
    const pr = byPr.get(n);
    if (pr) {
      out.prs[n] = derivePrReferenceStatus({
        state: 'OPEN',
        isDraft: pr.isDraft,
        reviewDecision: null,
        checks: (pr.checks ?? null) as ChecksGlyph,
      });
    }
  }
  for (const n of issues) if (byIssue.has(n)) out.issues[n] = 'open';
  return out;
}

/**
 * The conversation thread for one issue/PR, lazily. `{owner}`/`{repo}` in the gh api paths are
 * filled from the worktree's remote by gh itself, so no extra handle lookup. Everything degrades:
 * gh missing/offline → `{ available: false, reason }`, a 404 → a "not found" hint — never a throw.
 *
 * Since #525 the thread is sourced from `/issues/{n}/timeline`, which returns comments AND events
 * in one stream: `commented` rows go through the unchanged `normalizeComments`, the rest through
 * `normalizeEvents`. `comments[]` therefore keeps its exact pre-#525 shape, contents and cap
 * (BACKWARD_COMPATIBILITY.md) — see the top-up below for the one case that needed defending.
 */
export async function fetchGithubComments(
  repoRoot: string,
  kind: 'issue' | 'pr',
  number: number,
  refresh = false,
): Promise<ForgeCommentsData> {
  if (process.env.CEZ_DRY_RUN === '1') return mockGithubComments(kind, number);
  // NUL separator: cannot appear in a filesystem path, so roots can never alias.
  const key = `${repoRoot}\0${kind}#${number}`;
  const hit = commentsCache.get(key);
  if (!refresh && hit && Date.now() - hit.at < CACHE_MS) return hit.data;
  // PR conversation comments live on the issues endpoint too — always use it for the body thread.
  const legacyComments = () =>
    gh(repoRoot, ['api', `repos/{owner}/{repo}/issues/${number}/comments`, '--paginate']);
  // The detail tier (hearsay-tools/cezarion#1183): the list no longer has to carry a body, so
  // the pane asks for it here, in parallel with the thread. It is attached only to a thread
  // that loaded, and a failed view never costs the thread.
  const detail = fetchItemDetail(repoRoot, kind, number);
  try {
    let commentRows: unknown[] = [];
    let events: ForgeTimelineEvent[] | undefined;
    let eventsTruncated = false;
    let stoppedShort = false;

    try {
      const pages = await fetchTimelinePages((page, timeoutMs) =>
        gh(
          repoRoot,
          [
            'api',
            '-H',
            'Accept: application/vnd.github+json',
            `repos/{owner}/{repo}/issues/${number}/timeline?per_page=${TIMELINE_PER_PAGE}&page=${page}`,
          ],
          timeoutMs,
        ),
      );
      stoppedShort = pages.stoppedShort;
      commentRows = pages.rows.filter(
        (r) => (r as { event?: unknown } | null)?.event === 'commented',
      );
      const normalized = normalizeEvents(pages.rows);
      events = normalized.events;
      eventsTruncated = normalized.truncated;

      // Comments top-up. The two ENTRY caps are independent, but the FETCH budget is not: today's
      // call is an unbounded --paginate over a comments-only endpoint, so every comment is fetched
      // and mergeThread picks the oldest 200 from the complete set. Under the timeline those same
      // 200 slots are filled from at most 1000 rows in which events compete with comments — so on
      // a 1500-row thread with 250 interleaved comments, comments[] would return ~167 where today
      // it returns 200. Same §2 defect class as a combined entry cap, arriving via the source set.
      //
      // The trigger deliberately over-fires: it cannot distinguish "comments were cut off" from
      // "this thread just has few comments", because the second is only knowable by fetching them.
      // So on an event-heavy thread with 30 comments it re-fetches 30 complete comments. Accepted
      // — it fires only past ~1000 timeline rows, behind the 60 s LRU, and the alternative is a §2
      // regression. In the other direction the threshold is provably sound: with ≥200 commented
      // rows already in the oldest-first prefix, mergeThread's oldest-200 cut lies inside it.
      if (stoppedShort && commentRows.length < THREAD_ENTRY_CAP) {
        // Its OWN nested catch. The inner handler's remedy is the fallback — which is this very
        // call — and the outer handler returns { available: false, comments: [] }, emptying a
        // thread that was about to render. So a thrown top-up is swallowed: keep the commented
        // rows the timeline already returned and carry on. That is at worst the short list the
        // safeguard existed to avoid, never worse than not having attempted it.
        try {
          commentRows = z.array(z.unknown()).parse(JSON.parse(await legacyComments()));
        } catch {
          // keep the timeline's own commented rows
        }
      }
    } catch (timelineErr) {
      // Scoped INSIDE the existing outer catch on purpose: the outer handler's /404|not found/i
      // branch would otherwise turn a timeline 404 into an empty thread. ENOENT is the one failure
      // the fallback cannot rescue — nothing will work, and a second spawn fails identically.
      const message = timelineErr instanceof Error ? timelineErr.message : String(timelineErr);
      if (/ENOENT/.test(message)) throw timelineErr;
      // Every other endpoint-level failure substitutes the legacy comments call. It is a
      // substitution, not a retry — a different endpoint, which typically still answers. (A 403
      // attaches to the token rather than the endpoint, so it cannot succeed either; not
      // special-cased, since rate-limit replies are immediate and it costs one fast spawn.)
      commentRows = z.array(z.unknown()).parse(JSON.parse(await legacyComments()));
      events = undefined;
    }

    // Per-commit CI (#525 Phase 2). One extra subprocess per opened thread that contains commits,
    // behind the same 60 s LRU — a per-thread-open cost, not per-render. Every failure path here
    // leaves `checks` ABSENT rather than null, so commits simply render unglyphed: the fetch
    // degrades to "no data" and the render decides what absence looks like.
    const commitShas = (events ?? []).flatMap((e) => (e.kind === 'committed' && e.sha ? [e.sha] : []));
    if (commitShas.length > 0) {
      const handle = await resolveRepoHandle(repoRoot);
      if (handle) {
        const runGraphql: GraphqlRunner = (query, variables) => {
          const args = ghGraphqlArgs(query, variables);
          return gh(repoRoot, args);
        };
        const checks = await fetchCommitChecks(runGraphql, handle.owner, handle.name, commitShas);
        for (const event of events ?? []) {
          if (event.kind !== 'committed' || !event.sha) continue;
          if (event.sha in checks) {
            delete event.checks;
            Object.assign(event, defined({ checks: checks[event.sha] }));
          }
        }
      }
    }

    const parts: ForgeComment[][] = [normalizeComments(commentRows)];
    if (kind === 'pr') {
      const reviewsOut = await gh(repoRoot, ['api', `repos/{owner}/{repo}/pulls/${number}/reviews`, '--paginate']);
      parts.push(normalizeReviews(JSON.parse(reviewsOut)));
    }
    const { comments, truncated } = mergeThread(parts);
    const data: ForgeCommentsData = defined({
      available: true as const,
      comments,
      // OR-folded exactly as before, so the pre-existing >200-comments trigger is preserved
      // rather than replaced.
      truncated: truncated || eventsTruncated || stoppedShort || undefined,
    });
    if (events) data.events = events;
    const itemDetail = await detail;
    if (itemDetail) data.detail = itemDetail;
    cacheComments(key, data);
    return data;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const reason = /ENOENT/.test(message)
      ? 'gh CLI not found — install it and run `gh auth login`'
      : /404|not found/i.test(message)
        ? 'not found on GitHub — it may be closed or deleted'
        : firstLine(message);
    return { available: false, reason, comments: [] };
  }
}

/** CEZ_DRY_RUN=1 — a small fixed thread (one image-bearing comment, plus a review for PRs) so
 *  the whole feature is demoable and e2e-testable offline. */
function mockGithubComments(kind: 'issue' | 'pr', number?: number): ForgeCommentsData {
  const base = Date.now() - 3_600_000;
  const at = (offset: number) => new Date(base + offset).toISOString();
  const comments: ForgeComment[] = [
    {
      id: 1,
      author: 'ada',
      avatarUrl: 'https://avatars.githubusercontent.com/u/1?v=4',
      createdAt: at(0),
      body: 'Thanks for the report — I can reproduce. Which browser were you on?\n\n```\nchrome 126, macOS\n```',
      kind: 'comment',
      url: 'https://github.com/mock/repo/issues/1#issuecomment-1',
    },
    {
      id: 2,
      author: 'lin',
      createdAt: at(600_000),
      body: 'Here is the failing screen:\n\n![failure](https://avatars.githubusercontent.com/u/2?v=4)',
      kind: 'comment',
      url: 'https://github.com/mock/repo/issues/1#issuecomment-2',
    },
  ];
  if (kind === 'pr') {
    comments.push({
      id: 3,
      author: 'grace',
      avatarUrl: 'https://avatars.githubusercontent.com/u/3?v=4',
      createdAt: at(1_200_000),
      body: 'Looks good overall — please add a regression test before this lands.',
      kind: 'review',
      reviewState: 'changes_requested',
      url: 'https://github.com/mock/repo/pull/1#pullrequestreview-3',
    });
  }

  // Timeline events (#525) so the whole feature is demoable and e2e-testable offline. Deliberately
  // covers the cases that are easy to get wrong rather than one of each: a multi-commit run by ONE
  // author (exercises the client-side grouping) with MIXED check states (passing/failing/pending
  // plus one `null` = no CI configured), a label change, a cross-reference, and — for PRs — a
  // merge. SHAs are full 40-char because the rollup query's `oid` rejects abbreviated ones, and a
  // fixture that cheated there would not survive being pasted into a real query.
  const sha = (seed: string) => seed.repeat(40).slice(0, 40);
  const events: ForgeTimelineEvent[] = [
    {
      id: 'evt-100',
      kind: 'labeled',
      actor: 'ada',
      avatarUrl: 'https://avatars.githubusercontent.com/u/1?v=4',
      createdAt: at(300_000),
      label: { name: 'bug', color: 'd73a4a' },
    },
    {
      id: `evt-${sha('a')}`,
      kind: 'committed',
      actor: 'Lin Zhao',
      createdAt: at(900_000),
      sha: sha('a'),
      message: 'fix(session): keep the refresh token on reload',
      checks: 'passing',
    },
    {
      id: `evt-${sha('b')}`,
      kind: 'committed',
      actor: 'Lin Zhao',
      createdAt: at(960_000),
      sha: sha('b'),
      message: 'test(session): cover the reload path',
      checks: 'failing',
    },
    {
      id: `evt-${sha('c')}`,
      kind: 'committed',
      actor: 'Lin Zhao',
      createdAt: at(1_020_000),
      sha: sha('c'),
      message: 'chore: appease the linter',
      checks: 'pending',
    },
    {
      id: `evt-${sha('d')}`,
      kind: 'committed',
      actor: 'Lin Zhao',
      createdAt: at(1_080_000),
      sha: sha('d'),
      message: 'docs: note the new behavior',
      checks: null, // no CI configured — renders no glyph, distinct from absent
    },
    {
      id: 'evt-101',
      kind: 'cross-referenced',
      actor: 'grace',
      avatarUrl: 'https://avatars.githubusercontent.com/u/3?v=4',
      createdAt: at(1_500_000),
      refNumber: 42,
      refTitle: 'Session handling rewrite',
      refIsPr: true,
      url: 'https://github.com/mock/repo/pull/42',
    },
  ];
  if (kind === 'pr') {
    events.push({
      id: 'evt-102',
      kind: 'merged',
      actor: 'grace',
      avatarUrl: 'https://avatars.githubusercontent.com/u/3?v=4',
      createdAt: at(1_800_000),
    });
  }

  // The detail tier (hearsay-tools/cezarion#1183): the catalog row's own body and diffstat.
  const row = number === undefined ? undefined
    : (kind === 'pr' ? mockGithub().prs : mockGithub().issues).find((item) => item.number === number);
  const detail = row ? {
    body: row.body ?? '',
    ...(kind === 'pr' ? { additions: row.additions ?? 0, deletions: row.deletions ?? 0 } : {}),
  } : undefined;
  return { available: true, comments, events, ...(detail ? { detail } : {}) };
}

// ---- draft-PR creation (review gate, spec 009) ------------------------------
// Final autosave-commit → `git push -u origin cez/<id8>` → `gh pr create
// --draft`, all executed in the task worktree (gh picks the repo up from the
// worktree's remote). Every failure maps to a one-line human error — the GUI
// shows it as a toast plus the manual `git merge <branch>` fallback. Never throws.

const PR_URL_RE = /https:\/\/github\.com\/[^/\s]+\/[^/\s]+\/pull\/\d+/;
const PUSH_TIMEOUT_MS = 60_000;
const PROGRESS_LINES_MAX = 10;

export async function createDraftPr(input: DraftPrInput): Promise<DraftPrOutcome> {
  const { run } = input;
  const worktree = run.worktreePath;
  const branch = run.branch;
  if (!worktree || !branch) {
    return { ok: false, error: 'this task has no worktree/branch to publish' };
  }

  // Final autosave: the branch must hold everything before it leaves the box.
  // This is the LAST flush — unlike the turn-end and run-finalize ones there is
  // no later autosave to pick the work up, so a refusal (conflicted tree) or a
  // failed commit has to stop the publish instead of silently opening a PR from
  // a branch that is missing the run's final state.
  const saved = await autosaveCommit(worktree, 'pre-PR');
  if (saved === 'refused') {
    return {
      ok: false,
      error: 'worktree has unresolved merge conflicts — resolve them, then publish again',
    };
  }
  if (saved === 'failed') {
    return { ok: false, error: 'could not commit the final changes — check git status in the worktree' };
  }

  // DRY-RUN (CEZ_DRY_RUN=1): no push, no gh — simulate success with a fake PR
  // URL so the whole review → PR flow is testable without GitHub.
  if (process.env.CEZ_DRY_RUN === '1') {
    return { ok: true, url: 'https://github.com/open-mercato/demo/pull/777', dryRun: true };
  }

  const remote = await execTool(['remote', 'get-url', 'origin'], worktree, 'git');
  if (!remote.ok || !remote.stdout.trim()) {
    return { ok: false, error: 'no git remote — add one (git remote add origin <url>) or merge the branch locally' };
  }

  const push = await execTool(['push', '-u', 'origin', branch], worktree, 'git', PUSH_TIMEOUT_MS);
  if (!push.ok) {
    return { ok: false, error: `git push failed — ${tail(push.stderr) || 'unknown error'}` };
  }

  const body = buildPrBody(input.handoffText, run.task);
  // Target the branch the worktree forked from (config `baseBranch`) — without
  // --base, gh aims at the repo default (main) even when work started on
  // develop. `origin/x` normalizes to `x`; a raw sha (detached-HEAD fork
  // point) can't be a PR base, so gh falls back to the default branch.
  const prBase = run.baseBranch?.replace(/^origin\//, '');
  const baseArgs = prBase && !/^[0-9a-f]{7,40}$/i.test(prBase) ? ['--base', prBase] : [];
  const pr = await execTool(
    ['pr', 'create', '--draft', '--head', branch, ...baseArgs, '--title', run.title, '--body', body],
    worktree,
    'gh',
    PUSH_TIMEOUT_MS,
  );
  if (!pr.ok) {
    if (pr.notFound) {
      return { ok: false, error: 'gh not found — install the GitHub CLI and run `gh auth login`, or merge the branch locally' };
    }
    const hint = /auth|log ?in|credential/i.test(pr.stderr) ? ' (try `gh auth login`)' : '';
    return { ok: false, error: `gh pr create failed — ${tail(pr.stderr) || 'unknown error'}${hint}` };
  }

  // gh prints the PR URL on stdout; some versions echo it to stderr instead.
  const match = PR_URL_RE.exec(`${pr.stdout}\n${pr.stderr}`);
  if (!match) {
    return { ok: false, error: 'gh pr create returned no PR URL — check `gh pr list` manually' };
  }
  return { ok: true, url: match[0], dryRun: false };
}

/**
 * PR body from the handoff journal: the "## Goal" section (task text as
 * fallback) + the first ~10 lines of "## Progress log" (newest first) +
 * the cezar footer.
 */
export function buildPrBody(handoffText: string, task: string): string {
  const goal = section(handoffText, '## Goal') || task.trim();
  const progress = section(handoffText, '## Progress log').split('\n').filter((l) => l.trim()).slice(0, PROGRESS_LINES_MAX).join('\n');
  const parts = ['## Goal', '', goal];
  if (progress) parts.push('', '## Progress log', '', progress);
  parts.push('', '---', '', '🤖 made with cezar');
  return parts.join('\n');
}

/** Text of one `## Header` section, up to the next `## ` header, with LF line endings. The header
 *  is a whole line (hearsay-tools/cezarion#1147), so a Goal that quotes one is never taken for it. */
function section(text: string, header: string): string {
  const start = exactLineIndex(text, header);
  if (start < 0) return '';
  const rest = text.slice(nextLineIndex(text, start)).replaceAll('\r\n', '\n');
  const next = rest.indexOf('\n## ');
  return (next >= 0 ? rest.slice(0, next) : rest).trim();
}

/** Last 3 stderr lines, pipe-joined — enough context, toast-sized. */
function tail(stderr: string): string {
  return stderr.trim().split('\n').slice(-3).join(' | ').slice(0, 300);
}

interface ExecResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  /** True when the binary itself is missing (ENOENT). */
  notFound: boolean;
}

function execTool(args: string[], cwd: string, bin: string, timeoutMs = 30_000): Promise<ExecResult> {
  return new Promise((resolve) => {
    execFile(
      bin,
      args,
      {
        cwd,
        timeout: timeoutMs,
        maxBuffer: 4 * 1024 * 1024,
        encoding: 'utf8',
        // Nobody can answer a prompt here: git opens /dev/tty directly, so
        // piped stdio is not enough to stop it. Without this a `git push` that
        // cannot authenticate hangs for the whole timeout and surfaces as a
        // blank one-minute stall instead of git's own "could not read Username".
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
      },
      (err, stdout, stderr) =>
        resolve({
          ok: !err,
          stdout: stdout ?? '',
          stderr: stderr ?? '',
          notFound: err?.code === 'ENOENT',
        }),
    );
  });
}

// ---- the driver -------------------------------------------------------------

/**
 * Cached availability probe so `GET /api/health` never pays a full listing. Keyed by repo root:
 * every registered project reads its own slot, so the boot project's constant health refresh can't
 * evict another project's answer (a single slot made `GET /automations` flap between "still being
 * checked" and available). One in-flight probe per root dedupes a burst of reads.
 */
const DETECT_CACHE_MAX = 64;
const detectCache = new Map<string, { at: number; result: ForgeAvailability }>();
const detectInflight = new Map<string, Promise<ForgeAvailability>>();

async function probeGithub(repoRoot: string): Promise<ForgeAvailability> {
  let result: ForgeAvailability;
  try {
    await gh(repoRoot, ['repo', 'view', '--json', 'nameWithOwner'], 5_000);
    result = { available: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    result = {
      available: false,
      reason: /ENOENT/.test(message)
        ? 'gh CLI not found — install it and run `gh auth login`'
        : firstLine(message),
    };
  }
  detectCache.delete(repoRoot); // re-insert so Map order tracks recency
  detectCache.set(repoRoot, { at: Date.now(), result });
  while (detectCache.size > DETECT_CACHE_MAX) {
    const oldest = detectCache.keys().next().value;
    if (oldest === undefined) break;
    detectCache.delete(oldest);
  }
  return result;
}

async function detectGithub(repoRoot: string): Promise<ForgeAvailability> {
  if (process.env.CEZ_DRY_RUN === '1') return { available: true };
  const hit = detectCache.get(repoRoot);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.result;
  const pending = detectInflight.get(repoRoot);
  if (pending) return pending;
  const probe = probeGithub(repoRoot).finally(() => detectInflight.delete(repoRoot));
  detectInflight.set(repoRoot, probe);
  return probe;
}

/**
 * Non-blocking availability for `GET /api/health` (#major-health-latency): serves the last-known
 * probe immediately (stale-while-revalidate) and only returns `null` on a cold start, before the
 * first probe has ever warmed the cache. It NEVER shells out to `gh` on the request that reads it,
 * so health stays under the bookmarklet's 800 ms port budget (a `gh repo view` round-trip is
 * ~500–650 ms on its own). `null` is contract-safe — the whole `forge` field is additive, so
 * "unknown until warm" is a valid answer.
 *
 * Serving the stale value while revalidating is what keeps the GitHub nav item from flickering:
 * without it, every time the 60 s cache expired this returned `null` for one 5 s health poll,
 * dropping `forge.available` and blinking the sidebar item out until the background probe warmed.
 */
export function detectGithubCached(repoRoot: string): ForgeAvailability | null {
  if (process.env.CEZ_DRY_RUN === '1') return { available: true };
  const hit = detectCache.get(repoRoot);
  const cached = hit?.result ?? null;
  const fresh = hit !== undefined && Date.now() - hit.at < CACHE_MS;
  if (!fresh) {
    void detectGithub(repoRoot).catch(() => {}); // revalidate off the request path
  }
  return cached; // last-known value while revalidating; null only until the first probe warms
}

const mergeStateCache = new Map<string, { at: number; value: ForgePrMergeStateResult }>();
const mergeInflight = new Set<string>();
const MERGE_CACHE_MS = 15_000;

function mergeCheckState(check: z.infer<typeof mergeCheckSchema>): ForgePrCheck['state'] {
  const value = (check.conclusion || check.state || check.status || '').toUpperCase();
  if (['SUCCESS', 'NEUTRAL', 'SKIPPED'].includes(value)) return 'passing';
  if (['FAILURE', 'ERROR', 'TIMED_OUT', 'ACTION_REQUIRED', 'CANCELLED'].includes(value)) return 'failing';
  if (['PENDING', 'IN_PROGRESS', 'QUEUED', 'EXPECTED', 'WAITING', 'REQUESTED'].includes(value)) return 'pending';
  return 'unknown';
}

export function normalizeMergeState(
  raw: unknown,
  policyRaw: unknown,
  requirements: GithubMergeRequirements = {
    readable: false,
    requiredChecks: [],
  },
): ForgePrMergeState {
  const pr = mergePrSchema.parse(raw);
  const policy = repoMergePolicySchema.parse(policyRaw);
  const state: ForgePrMergeState['state'] =
    pr.state.toUpperCase() === 'MERGED' ? 'merged' : pr.state.toUpperCase() === 'CLOSED' ? 'closed' : 'open';
  const mergeable: ForgePrMergeState['mergeable'] =
    pr.mergeable?.toUpperCase() === 'MERGEABLE'
      ? 'mergeable'
      : pr.mergeable?.toUpperCase() === 'CONFLICTING'
        ? 'conflicting'
        : 'unknown';
  const reviewDecision: ForgePrMergeState['reviewDecision'] =
    pr.reviewDecision?.toUpperCase() === 'APPROVED'
      ? 'approved'
      : pr.reviewDecision?.toUpperCase() === 'CHANGES_REQUESTED'
        ? 'changes-requested'
        : pr.reviewDecision?.toUpperCase() === 'REVIEW_REQUIRED'
          ? 'review-required'
          : !pr.reviewDecision?.trim() && requirements.readable && requirements.requiredApprovingReviews === 0
            ? 'not-required'
            : 'unknown';
  const checks: ForgePrCheck[] = (pr.statusCheckRollup ?? []).map((check) => {
    const name = check.name ?? check.context ?? 'Check';
    const url = check.detailsUrl ?? check.targetUrl;
    return {
      name,
      state: mergeCheckState(check),
      required: requirements.readable ? requirements.requiredChecks.includes(name) : null,
      ...(url?.startsWith('https://') || url?.startsWith('http://') ? { url } : {}),
    };
  });
  if (requirements.readable) {
    for (const name of requirements.requiredChecks) {
      if (!checks.some((check) => check.name === name)) checks.push({ name, state: 'pending', required: true });
    }
  }
  const methods: ForgeMergeMethod[] = [];
  const methodAllowed = (method: ForgeMergeMethod) => requirements.allowedMergeMethods?.includes(method) ?? true;
  if (policy.allow_squash_merge && methodAllowed('squash')) methods.push('squash');
  if (policy.allow_merge_commit && methodAllowed('merge')) methods.push('merge');
  if (policy.allow_rebase_merge && methodAllowed('rebase')) methods.push('rebase');
  const defaultMethod =
    policy.squash_merge_commit_title && methods.includes('squash')
      ? 'squash'
      : policy.merge_commit_title && methods.includes('merge')
        ? 'merge'
        : methods[0] ?? null;
  const blockers: ForgePrMergeState['blockers'] = [];
  let eligibility: ForgePrMergeState['eligibility'] = 'ready';
  if (state !== 'open') {
    eligibility = 'terminal';
    blockers.push({ code: 'terminal', message: state === 'merged' ? 'This pull request is merged.' : 'This pull request is closed.' });
  } else if (pr.isDraft) {
    eligibility = 'blocked';
    blockers.push({ code: 'draft', message: 'Mark the pull request ready for review before merging.' });
  } else if (mergeable === 'conflicting') {
    eligibility = 'blocked';
    blockers.push({ code: 'conflicts', message: 'Conflicts must be resolved before merging.' });
  } else if (checks.some((check) => check.state === 'failing')) {
    eligibility = 'blocked';
    blockers.push({ code: 'checks-failing', message: 'One or more checks are failing.' });
  } else if (reviewDecision === 'changes-requested' || reviewDecision === 'review-required') {
    eligibility = 'blocked';
    blockers.push({ code: 'reviews', message: reviewDecision === 'changes-requested' ? 'Changes were requested.' : 'A required review is missing.' });
  } else if ((requirements.unresolvedThreads ?? 0) > 0) {
    eligibility = 'blocked';
    blockers.push({ code: 'review-threads', message: 'Required review threads must be resolved before merging.' });
  } else if (
    reviewDecision === 'unknown' || !requirements.readable ||
    (requirements.requiresThreadResolution && requirements.unresolvedThreads == null) ||
    checks.some((check) => check.required === true && check.state === 'unknown')
  ) {
    eligibility = 'unknown';
    blockers.push({
      code: 'rules-unknown',
      message: 'GitHub could not confirm review and branch-protection requirements.',
    });
  } else if (checks.some((check) => check.state === 'pending') || pr.mergeStateStatus?.toUpperCase() === 'UNSTABLE') {
    eligibility = 'pending';
    blockers.push({ code: 'pending', message: 'Checks or GitHub mergeability are still pending.' });
  // GitHub's aggregate still enforces other rules and required check provider identities.
  } else if (
    mergeable !== 'mergeable' ||
    !['CLEAN', 'HAS_HOOKS'].includes(pr.mergeStateStatus?.toUpperCase() ?? '') ||
    methods.length === 0
  ) {
    eligibility = 'unknown';
    blockers.push({ code: 'unknown', message: 'GitHub could not confirm every merge requirement.' });
  }
  const canMerge = eligibility === 'ready';
  const canOverride =
    !canMerge &&
    state === 'open' &&
    !pr.isDraft &&
    mergeable !== 'conflicting' &&
    methods.length > 0;
  return {
    number: pr.number,
    title: pr.title,
    url: pr.url,
    state,
    isDraft: pr.isDraft,
    headRef: pr.headRefName,
    baseRef: pr.baseRefName,
    headSha: pr.headRefOid,
    mergeable,
    reviewDecision,
    checks,
    methods,
    defaultMethod,
    eligibility,
    blockers,
    canMerge,
    canOverride,
  };
}

async function fetchPrMergeState(
  repoRoot: string,
  repoRef: GithubRepoRef | null,
  number: number,
  refresh = false,
): Promise<ForgePrMergeStateResult> {
  if (process.env.CEZ_DRY_RUN === '1') {
    return {
      available: true,
      mergeState: normalizeMergeState(
        {
          number,
          title: 'Dry-run pull request',
          url: `https://github.com/mock/repo/pull/${number}`,
          state: 'OPEN',
          isDraft: false,
          headRefName: 'feat/dry-run',
          baseRefName: 'main',
          headRefOid: '0123456789abcdef0123456789abcdef01234567',
          mergeable: 'MERGEABLE',
          mergeStateStatus: 'CLEAN',
          reviewDecision: 'APPROVED',
          statusCheckRollup: [{ name: 'test', conclusion: 'SUCCESS', detailsUrl: 'https://github.com/mock/repo/actions' }],
        },
        { allow_merge_commit: true, allow_squash_merge: true, allow_rebase_merge: true },
        { readable: true, requiredChecks: ['test'] },
      ),
    };
  }
  if (!repoRef) return { available: false, reason: 'GitHub remote could not be resolved' };
  const key = `${repoRoot}:${number}`;
  const hit = mergeStateCache.get(key);
  if (!refresh && hit && Date.now() - hit.at < MERGE_CACHE_MS) return hit.value;
  try {
    const prOut = await gh(repoRoot, [
      'pr', 'view', String(number), '--json',
      'number,title,url,state,isDraft,headRefName,baseRefName,headRefOid,mergeable,mergeStateStatus,reviewDecision,statusCheckRollup,mergedAt',
    ]);
    const parsedPr = mergePrSchema.parse(JSON.parse(prOut));
    if (!matchesGithubPullRequest({ ...repoRef, number }, parsedPr)) return { available: false, reason: 'GitHub returned a different pull request.' };
    mergedPullRequestObservations.observe({ ...repoRef, number }, parsedPr);
    const [policyOut, requirements] = await Promise.all([
      gh(repoRoot, ['api', `repos/${repoRef.owner}/${repoRef.repo}`]),
      fetchGithubMergeRequirements((args) => gh(repoRoot, args), repoRef.owner, repoRef.repo, parsedPr.baseRefName, number),
    ]);
    const value: ForgePrMergeStateResult = {
      available: true,
      mergeState: normalizeMergeState(parsedPr, JSON.parse(policyOut), requirements),
    };
    mergeStateCache.set(key, { at: Date.now(), value });
    return value;
  } catch (error) {
    return { available: false, reason: firstLine(error instanceof Error ? error.message : String(error)) };
  }
}

export function evictGithubProjectCaches(repoRoot: string): void {
  const contextKey = githubContext(repoRoot).key;
  listCache.forEach((entry, key) => {
    if (entry.contextKey === contextKey) dropListEntry(key);
  });
  repositoryProjectsCache.delete(contextKey);
  commentCountsCache.forEach((_value, key) => {
    if (key.startsWith(`${contextKey}\0`)) commentCountsCache.delete(key);
  });
  mergeStateCache.forEach((_value, key) => {
    if (key.startsWith(`${repoRoot}:`)) mergeStateCache.delete(key);
  });
  commentsCache.forEach((_value, key) => {
    if (key.startsWith(`${repoRoot}\0`)) commentsCache.delete(key);
  });
  itemCache.forEach((_value, key) => {
    if (key.startsWith(`${repoRoot}\0`)) itemCache.delete(key);
  });
}

async function mergePullRequest(
  repoRoot: string,
  repoRef: GithubRepoRef | null,
  number: number,
  input: ForgeMergeInput,
): Promise<ForgeMergeResult> {
  const key = `${repoRoot}:${number}`;
  if (mergeInflight.has(key)) return { merged: false, status: 409, error: 'A merge is already in progress.', code: 'concurrent' };
  mergeInflight.add(key);
  try {
    if (input.canProceed?.() === false) return { merged: false, status: 409, error: 'Automatic merging was cancelled.', code: 'cancelled' };
    const fresh = await fetchPrMergeState(repoRoot, repoRef, number, true);
    if (input.canProceed?.() === false) return { merged: false, status: 409, error: 'Automatic merging was cancelled.', code: 'cancelled' };
    if (!fresh.available) return { merged: false, status: 502, error: fresh.reason };
    const current = fresh.mergeState;
    if (current.headSha !== input.expectedHeadSha) {
      return { merged: false, status: 409, error: 'The pull request head changed. Review the new commits before merging.', code: 'stale-head', current };
    }
    if (input.expectedHeadRef !== undefined && current.headRef !== input.expectedHeadRef) {
      return { merged: false, status: 409, error: 'The pull request branch changed.', code: 'stale-branch', current };
    }
    if (input.requirePassingChecks && (current.checks.length === 0 || current.checks.some(check => check.state !== 'passing'))) {
      return { merged: false, status: 409, error: 'Automatic merging requires at least one check and every current-head check passing.', code: 'checks-not-passing', current };
    }
    if (!current.methods.includes(input.method)) {
      return { merged: false, status: 409, error: 'That merge method is no longer enabled.', code: 'disabled-method', current };
    }
    if (!mergePreflightAllowed(current, !input.requirePassingChecks && input.overrideRules)) {
      return { merged: false, status: 409, error: current.blockers[0]?.message ?? 'The pull request is not eligible to merge.', code: current.eligibility, current };
    }
    if (input.requirePassingChecks && process.env.CEZ_DRY_RUN !== '1') {
      if (!repoRef) return { merged: false, status: 404, error: 'GitHub repository not found.' };
      const active = parseActiveWorkflowRuns(await gh(repoRoot, activeWorkflowRunsArgs({
        repository: `${repoRef.owner}/${repoRef.repo}`, headSha: current.headSha,
      })));
      if (input.canProceed?.() === false) return { merged: false, status: 409, error: 'Automatic merging was cancelled.', code: 'cancelled' };
      if (active) return { merged: false, status: 409, error: 'Waiting for active CI workflows on the current PR head.', code: 'checks-active', current };
    }
    if (process.env.CEZ_DRY_RUN === '1') {
      evictGithubProjectCaches(repoRoot);
      return { merged: true, number, url: current.url, method: input.method, mergeCommitSha: 'abcdef0123456789abcdef0123456789abcdef01' };
    }
    if (!repoRef) return { merged: false, status: 404, error: 'GitHub repository not found.' };
    if (input.canProceed?.() === false) return { merged: false, status: 409, error: 'Automatic merging was cancelled.', code: 'cancelled' };
    const out = await gh(repoRoot, [
      'api', '--method', 'PUT', `repos/${repoRef.owner}/${repoRef.repo}/pulls/${number}/merge`,
      '-f', `merge_method=${input.method}`, '-f', `sha=${input.expectedHeadSha}`,
    ]);
    // Once GitHub accepted the mutation, report its real outcome even if intent changed in flight.
    const result = ghMergeResultSchema.parse(JSON.parse(out));
    if (!result.merged) return { merged: false, status: 409, error: result.message ?? 'GitHub refused the merge.', code: 'github-blocked', current };
    evictGithubProjectCaches(repoRoot);
    return { merged: true, number, url: current.url, method: input.method, ...(result.sha ? { mergeCommitSha: result.sha } : {}) };
  } catch (error) {
    const message = firstLine(error instanceof Error ? error.message : String(error));
    const status = /403|permission|forbidden/i.test(message) ? 403 : /404|not found/i.test(message) ? 404 : 502;
    return { merged: false, status, error: status === 403 ? 'GitHub permission denied.' : status === 404 ? 'Pull request or repository not found.' : 'GitHub could not complete the merge.' };
  } finally {
    mergeInflight.delete(key);
  }
}

export function mergePreflightAllowed(current: ForgePrMergeState, overrideRules = false): boolean {
  return current.canMerge || (overrideRules && current.canOverride);
}

/** gh has no compare-and-swap ready operation. Check ownership immediately before marking ready,
 * then refresh again; the later merge has its own head guard and GitHub's atomic SHA check. */
async function readyPullRequest(
  repoRoot: string,
  repoRef: GithubRepoRef | null,
  number: number,
  input: { expectedHeadSha: string; expectedHeadRef: string; canProceed?: () => boolean },
): Promise<ForgePrMergeStateResult> {
  if (!Number.isSafeInteger(number) || number < 1 || !/^[0-9a-f]{40}$/.test(input.expectedHeadSha) || !input.expectedHeadRef) {
    return { available: false, reason: 'A valid pull request, head SHA and task branch are required.' };
  }
  const key = `${repoRoot}:${number}`;
  if (mergeInflight.has(key)) return { available: false, reason: 'A pull request mutation is already in progress.' };
  mergeInflight.add(key);
  try {
    if (input.canProceed?.() === false) return { available: false, reason: 'Marking the pull request ready was cancelled.' };
    const dryRun = process.env.CEZ_DRY_RUN === '1';
    if (!dryRun) {
      if (!repoRef) return { available: false, reason: 'GitHub remote could not be resolved' };
      const pr = mergePrSchema.pick({ number: true, url: true, state: true, isDraft: true, headRefName: true, headRefOid: true }).parse(JSON.parse(await gh(repoRoot, [
        'pr', 'view', String(number), '--json', 'number,url,state,isDraft,headRefName,headRefOid',
      ])));
      if (input.canProceed?.() === false) return { available: false, reason: 'Marking the pull request ready was cancelled.' };
      if (!matchesGithubPullRequest({ ...repoRef, number }, pr)) return { available: false, reason: 'GitHub returned a different pull request.' };
      if (pr.headRefOid !== input.expectedHeadSha) return { available: false, reason: 'The pull request head changed.' };
      if (pr.headRefName !== input.expectedHeadRef) return { available: false, reason: 'The pull request branch changed.' };
      if (pr.state !== 'OPEN') return { available: false, reason: 'The pull request is no longer open.' };
      if (pr.isDraft) {
        if (input.canProceed?.() === false) return { available: false, reason: 'Marking the pull request ready was cancelled.' };
        await gh(repoRoot, ['pr', 'ready', String(number), '--repo', `github.com/${repoRef.owner}/${repoRef.repo}`]);
        evictGithubProjectCaches(repoRoot);
        if (input.canProceed?.() === false) return { available: false, reason: 'Marking the pull request ready was cancelled.' };
      }
    }
    const fresh = await fetchPrMergeState(repoRoot, repoRef, number, true);
    if (input.canProceed?.() === false) return { available: false, reason: 'Marking the pull request ready was cancelled.' };
    if (fresh.available && fresh.mergeState.headSha !== input.expectedHeadSha) return { available: false, reason: 'The pull request head changed.' };
    if (fresh.available && fresh.mergeState.headRef !== input.expectedHeadRef) return { available: false, reason: 'The pull request branch changed.' };
    return fresh;
  } catch {
    return { available: false, reason: 'GitHub could not mark the pull request ready for review.' };
  } finally {
    mergeInflight.delete(key);
  }
}

/** owner/repo parsed out of the origin remote — feeds `viewUrl`. */
export interface GithubRepoRef {
  owner: string;
  repo: string;
}

const GH_PR_STATES: Record<string, ForgePrStatus['state']> = {
  MERGED: 'merged',
  CLOSED: 'closed',
};

export function createGithubDriver(repoRoot: string, repoRef: GithubRepoRef | null): ForgeDriver {
  return {
    kind: 'github',

    list: (opts) => fetchGithub(repoRoot, opts?.refresh, opts?.limit, opts),
    projects: (generation) => fetchGithubProjects(repoRoot, generation),
    item: (kind, number, opts) => fetchGithubItem(repoRoot, kind, number, opts?.refresh),
    comments: (kind, number, opts) => fetchGithubComments(repoRoot, kind, number, opts?.refresh),
    commentCounts: (kind, numbers, opts) => fetchGithubCommentCounts(repoRoot, kind, numbers, opts?.refresh),
    checks: (numbers) => fetchGithubChecks(repoRoot, numbers),
    refStatus: (input) => fetchGithubRefStatus(repoRoot, input),
    cachedRefStatuses: (numbers) => readCachedRefStatuses(repoRoot, numbers),
    branchPushed: (numbers) => {
      for (const number of numbers) forgetRefStatus(repoRoot, number);
    },

    detect: () => detectGithub(repoRoot),
    detectCached: () => detectGithubCached(repoRoot),

    listIssues: async (opts) => (await fetchGithub(repoRoot, opts?.refresh, opts?.limit, opts)).issues,

    listPRs: async (opts) => (await fetchGithub(repoRoot, opts?.refresh, opts?.limit, opts)).prs,

    // The open-only list tier's escape hatch (#730) — this is the only path that can reach a
    // closed or merged item.
    searchItems: (kind, query, opts) => searchGithubItems(repoRoot, kind, query, opts?.limit),

    viewItem: (kind, number) => viewGithubItem(repoRoot, kind, number),

    prDiff: (number, opts) => fetchGithubPrDiff(repoRoot, number, opts?.refresh),

    createPR: (input) => createDraftPr(input),

    // Null covers everything from "no PR yet" to "gh missing" — the callers
    // (Create PR → View PR flip) treat all of it as "nothing to link".
    prStatus: async (branch) => {
      if (process.env.CEZ_DRY_RUN === '1') return null;
      try {
        const out = await gh(repoRoot, ['pr', 'view', branch, '--json', 'number,url,state,isDraft,statusCheckRollup,mergedAt']);
        const pr = ghPrViewSchema.parse(JSON.parse(out));
        if (repoRef) mergedPullRequestObservations.observe({ ...repoRef, number: pr.number }, pr);
        return {
          number: pr.number,
          url: pr.url,
          state: GH_PR_STATES[pr.state.toUpperCase()] ?? 'open',
          isDraft: pr.isDraft,
          checks: rollupToChecks(pr.statusCheckRollup) ?? null,
        };
      } catch {
        return null;
      }
    },

    prMergeState: (number, opts) => fetchPrMergeState(repoRoot, repoRef, number, opts?.refresh),

    readyPR: (number, input) => readyPullRequest(repoRoot, repoRef, number, input),

    mergePR: (number, input) => mergePullRequest(repoRoot, repoRef, number, input),

    viewUrl: (kind: ForgeRefKind, ref: string | number): string | null => {
      if (!repoRef) return null;
      const base = `https://github.com/${repoRef.owner}/${repoRef.repo}`;
      // Branch names may contain '/' — encode per segment, keep the slashes.
      const path = String(ref).split('/').map(encodeURIComponent).join('/');
      switch (kind) {
        case 'repo':
          return base;
        case 'issue':
          return `${base}/issues/${path}`;
        case 'pr':
          return `${base}/pull/${path}`;
        case 'branch':
          return `${base}/tree/${path}`;
        case 'commit':
          return `${base}/commit/${path}`;
      }
    },
  };
}

/** A missing alias must not poison unrelated families. Discard partial data and requery only
 * unaffected aliases once; archive authority still comes from an error-free response. */
async function mergedPullRequestChunk(runGraphql: GraphqlRunner, initial: ArchivePullRequestIdentity[]): Promise<unknown> {
  let chunk = initial;
  for (let attempt = 0; attempt < 2 && chunk.length; attempt++) {
    const query = `query($owner: String!, $name: String!) { repository(owner: $owner, name: $name) { nameWithOwner ${chunk.map(pr => `pr${pr.number}: pullRequest(number: ${pr.number}) { number url state mergedAt }`).join(' ')} } }`;
    let response: unknown;
    let failure: unknown;
    try {
      response = JSON.parse(await runGraphql(query, { owner: chunk[0]!.owner, name: chunk[0]!.repo }));
    } catch (error) {
      // gh exits 1 on GraphQL errors, with the structured envelope on stdout. Neither stderr
      // nor timeout/abort output is evidence that one particular alias was missing.
      const rejected = z.object({ code: z.literal(1), stdout: z.string() }).safeParse(error);
      if (!rejected.success) throw error;
      try { response = JSON.parse(rejected.data.stdout); } catch { throw error; }
      failure = error;
    }
    const partial = z.object({
      errors: z.array(z.object({ type: z.literal('NOT_FOUND'), path: z.tuple([z.literal('repository'), z.string()]) })).nonempty(),
      data: z.object({ repository: z.object({ nameWithOwner: z.string() }) }),
    }).safeParse(response);
    const aliases = new Set(chunk.map(pr => `pr${pr.number}`));
    if (attempt === 0 && partial.success &&
      partial.data.data.repository.nameWithOwner.toLowerCase() === `${chunk[0]!.owner}/${chunk[0]!.repo}`.toLowerCase() &&
      partial.data.errors.every(error => aliases.has(error.path[1]))) {
      const missing = new Set(partial.data.errors.map(error => error.path[1]));
      chunk = chunk.filter(pr => !missing.has(`pr${pr.number}`));
      continue;
    }
    if (failure) throw failure;
    return response;
  }
  return undefined;
}

/** Strict archive authority: no partial GraphQL success, redirects, guessed identity or date. */
export async function fetchMergedPullRequests(runGraphql: GraphqlRunner, identities: readonly ArchivePullRequestIdentity[]): Promise<MergedPullRequest[]> {
  const repositories = new Map<string, ArchivePullRequestIdentity[]>();
  for (const identity of new Map(identities.map(pr => [pullRequestKey(pr), pr])).values()) {
    const key = `${identity.owner}/${identity.repo}`;
    repositories.set(key, [...(repositories.get(key) ?? []), identity]);
  }
  const merged: MergedPullRequest[] = [];
  for (const [repository, prs] of repositories) {
    for (let offset = 0; offset < prs.length; offset += 25) {
      const chunk = prs.slice(offset, offset + 25);
      const response = await mergedPullRequestChunk(runGraphql, chunk);
      const parsed = z.object({ errors: z.array(z.unknown()).optional(), data: z.object({ repository: z.object({ nameWithOwner: z.string() }).passthrough().nullable() }) }).safeParse(response);
      if (!parsed.success || parsed.data.errors?.length || parsed.data.data.repository?.nameWithOwner.toLowerCase() !== repository.toLowerCase()) continue;
      for (const pr of chunk) {
        const fact = mergedPullRequestObservations.observe(pr, parsed.data.data.repository[`pr${pr.number}`]);
        if (fact) merged.push(fact);
      }
    }
  }
  return merged;
}

export async function lookupMergedPullRequests(repoRoot: string, identities: ArchivePullRequestIdentity[], signal: AbortSignal): Promise<MergedPullRequest[]> {
  signal.throwIfAborted();
  if (process.env.CEZ_DRY_RUN === '1') return [];
  const unique = [...new Map(identities.map(pr => [pullRequestKey(pr), pr])).values()];
  const known = unique.flatMap(pr => mergedPullRequestObservations.get(pr) ?? []);
  const missing = unique.filter(pr => !mergedPullRequestObservations.get(pr));
  if (missing.length === 0) return known;
  const context = githubContext(repoRoot);
  const fetched = await fetchMergedPullRequests(async (query, variables) => {
    const args = ['api', 'graphql', '--hostname', 'github.com', '-f', `query=${query}`];
    for (const [key, value] of Object.entries(variables)) args.push('-f', `${key}=${value}`);
    return gh(repoRoot, args, 15_000, signal, context);
  }, missing);
  return [...known, ...fetched];
}

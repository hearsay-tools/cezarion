/**
 * What branch classification asks GitHub: the states of the PRs runs created, and every PR whose
 * head is one of the branches still in question. The second is asked per head, never as one
 * newest-first list, so a branch merged long ago keeps its evidence however many PRs came after it
 * (hearsay-tools/cezarion#2268). A head GitHub did not answer in full is reported, never read as
 * "no PR".
 */
import { z } from 'zod';
import type { BranchPrState } from '@open-mercato/cezar-contract';
import { ghGraphqlArgs, resolveRepoHandle, type GraphqlRunner } from './forge/github.ts';
import { resolveForgeRoot, GH_REF_STATUS_MAX, type ForgeFactory, type ReferenceStatus } from './forge/index.ts';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);

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

/** The PRs of some heads. `incomplete` names each head whose PRs GitHub did not return in full:
 *  its batch failed, or it has more PRs than one page holds. `available` is false once any batch
 *  failed: GitHub did not answer, which a classification must report as unknown PR state. */
export interface HeadPrs {
  available: boolean;
  prs: ForgePr[];
  incomplete: ReadonlySet<string>;
}

/**
 * What the classifier asks GitHub. Both calls degrade to `available: false` instead of throwing;
 * the classifier then falls back to ancestry and reports `prStateKnown: false`.
 */
export interface BranchForge {
  /** States of the PRs runs CREATED (`pullRequestUrl`), by number — the ref-status cache. */
  prStates(repoRoot: string, numbers: number[]): Promise<{ available: boolean; states: Record<number, BranchPrState> }>;
  /** Every PR whose head is one of `heads`, with the base and head a `merged` verdict is checked
   *  against. */
  prsForHeads(repoRoot: string, heads: readonly string[]): Promise<HeadPrs>;
}

function prStateOf(status: ReferenceStatus): BranchPrState {
  if (status === 'merged') return 'merged';
  if (status === 'closed') return 'closed';
  if (status === 'draft') return 'draft';
  return 'open';
}

const prNodeSchema = z.object({
  number: z.number(),
  url: z.string(),
  headRefName: z.string(),
  baseRefName: z.string(),
  headRefOid: z.string(),
  mergeCommit: z.object({ oid: z.string() }).nullable().optional(),
  state: z.string(),
  isDraft: z.boolean().optional(),
});
const headConnectionSchema = z.object({
  pageInfo: z.object({ hasNextPage: z.boolean() }),
  nodes: z.array(prNodeSchema),
});
const headReplySchema = z.object({
  data: z.object({ repository: z.record(z.string(), headConnectionSchema.nullable()).nullable() }),
});

/** Heads per GraphQL query, and PRs per head: GitHub caps a connection page at 100. */
export const HEADS_PER_QUERY = 50;
const PRS_PER_HEAD = 100;
const HEAD_TTL_MS = 60_000;
const HEAD_CACHE_MAX = 20_000;

function headQuery(count: number): string {
  const vars = Array.from({ length: count }, (_, i) => `$h${i}: String!`).join(', ');
  const fields = Array.from({ length: count }, (_, i) =>
    `h${i}: pullRequests(headRefName: $h${i}, first: ${PRS_PER_HEAD}, states: [OPEN, CLOSED, MERGED]) { pageInfo { hasNextPage } nodes { number url headRefName baseRefName headRefOid mergeCommit { oid } state isDraft } }`,
  ).join('\n    ');
  return `query ($owner: String!, $name: String!, ${vars}) {\n  repository(owner: $owner, name: $name) {\n    ${fields}\n  }\n}`;
}

function toForgePr(row: z.infer<typeof prNodeSchema>): ForgePr {
  return {
    number: row.number,
    url: row.url,
    headRefName: row.headRefName,
    baseRefName: row.baseRefName,
    headRefOid: row.headRefOid,
    mergeCommitOid: row.mergeCommit?.oid ?? null,
    state: row.state === 'MERGED' ? 'merged' : row.state === 'CLOSED' ? 'closed' : row.isDraft ? 'draft' : 'open',
  };
}

/** One query for up to `HEADS_PER_QUERY` heads. A head comes back complete with its PRs, or is
 *  named incomplete; a failed or unreadable reply makes every head of the batch incomplete and
 *  the batch `failed`. */
export async function fetchHeadBatch(
  run: GraphqlRunner,
  owner: string,
  name: string,
  heads: readonly string[],
): Promise<{ complete: Map<string, ForgePr[]>; incomplete: string[]; failed: boolean }> {
  const variables: Record<string, string> = { owner, name };
  heads.forEach((head, i) => { variables[`h${i}`] = head; });
  const complete = new Map<string, ForgePr[]>();
  let repository: Record<string, z.infer<typeof headConnectionSchema> | null> | null = null;
  try {
    repository = headReplySchema.parse(JSON.parse(await run(headQuery(heads.length), variables))).data.repository;
  } catch {
    // An unreadable reply answers nothing, like no reply.
  }
  // `repository: null` says the handle did not resolve: GitHub answered none of these heads.
  if (!repository) return { complete, incomplete: [...heads], failed: true };
  const found = repository;
  const incomplete: string[] = [];
  heads.forEach((head, i) => {
    const connection = found[`h${i}`];
    if (!connection || connection.pageInfo.hasNextPage) incomplete.push(head);
    else complete.set(head, connection.nodes.map(toForgePr).filter((pr) => pr.headRefName === head));
  });
  return { complete, incomplete, failed: false };
}

export interface GithubBranchForgeDeps {
  forgeFactory?: ForgeFactory;
  graphql?: (repoRoot: string) => GraphqlRunner;
  handle?: (repoRoot: string) => Promise<{ owner: string; name: string } | null>;
}

function defaultGraphql(repoRoot: string): GraphqlRunner {
  return async (query, variables) => {
    const { stdout } = await exec('gh', ghGraphqlArgs(query, variables), { cwd: repoRoot, timeout: 30_000, maxBuffer: 16 * 1024 * 1024 });
    return stdout;
  };
}

const headCache = new Map<string, { at: number; prs: ForgePr[] }>();

/** The default forge: the ref-status cache for created PRs, and per-head GraphQL lookups with a
 *  one-minute cache per head. `CEZ_DRY_RUN=1` never shells out. */
export function createGithubBranchForge(deps: GithubBranchForgeDeps = {}): BranchForge {
  const graphql = deps.graphql ?? defaultGraphql;
  const handleOf = deps.handle ?? ((root: string) => resolveRepoHandle(root));
  return {
    async prStates(repoRoot, numbers) {
      const states: Record<number, BranchPrState> = {};
      for (let i = 0; i < numbers.length; i += GH_REF_STATUS_MAX) {
        const data = await resolveForgeRoot(repoRoot, deps.forgeFactory).refStatus({ prs: numbers.slice(i, i + GH_REF_STATUS_MAX) });
        if (!data.available) return { available: false, states };
        for (const [n, status] of Object.entries(data.prs)) states[Number(n)] = prStateOf(status);
      }
      return { available: true, states };
    },
    async prsForHeads(repoRoot, heads) {
      const wanted = [...new Set(heads)];
      if (process.env.CEZ_DRY_RUN === '1' || wanted.length === 0) return { available: true, prs: [], incomplete: new Set() };
      const prs: ForgePr[] = [];
      const misses: string[] = [];
      const now = Date.now();
      for (const head of wanted) {
        const hit = headCache.get(`${repoRoot}\0${head}`);
        if (hit && now - hit.at < HEAD_TTL_MS) prs.push(...hit.prs);
        else misses.push(head);
      }
      if (misses.length === 0) return { available: true, prs, incomplete: new Set() };
      const handle = await handleOf(repoRoot).catch(() => null);
      if (!handle) return { available: false, prs: [], incomplete: new Set(wanted) };
      const run = graphql(repoRoot);
      const incomplete = new Set<string>();
      let failed = false;
      for (let i = 0; i < misses.length; i += HEADS_PER_QUERY) {
        const batch = await fetchHeadBatch(run, handle.owner, handle.name, misses.slice(i, i + HEADS_PER_QUERY));
        failed ||= batch.failed;
        for (const head of batch.incomplete) incomplete.add(head);
        for (const [head, found] of batch.complete) {
          prs.push(...found);
          headCache.delete(`${repoRoot}\0${head}`);
          headCache.set(`${repoRoot}\0${head}`, { at: Date.now(), prs: found });
        }
      }
      while (headCache.size > HEAD_CACHE_MAX) headCache.delete(headCache.keys().next().value as string);
      return { available: !failed, prs, incomplete };
    },
  };
}

export const githubBranchForge: BranchForge = createGithubBranchForge();

/** Test-only: forget cached per-head answers. */
export function __clearPrListCacheForTests(): void {
  headCache.clear();
}

import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { __clearPrListCacheForTests, createGithubBranchForge, fetchHeadBatch, HEADS_PER_QUERY } from './repo-branch-forge.ts';
import { classifyBranches, githubBranchForge } from './repo-branches.ts';
import { commit, git, owners, runRecord, taskBranch } from './repo-branches.testkit.ts';

const node = (n: number, head: string, extra: Record<string, unknown> = {}) => ({
  number: n, url: `https://github.com/acme/demo/pull/${n}`, headRefName: head, baseRefName: 'main',
  headRefOid: 'a'.repeat(40), mergeCommit: { oid: 'b'.repeat(40) }, state: 'MERGED', isDraft: false, ...extra,
});

describe('per-head PR lookup (hearsay-tools/cezarion#2268)', () => {
  afterEach(() => {
    __clearPrListCacheForTests();
    vi.unstubAllEnvs();
  });

  it('passes heads as variables, and names a head incomplete when its PRs need another page', async () => {
    let seen: { query: string; variables: Record<string, string | number> } | undefined;
    const result = await fetchHeadBatch(async (query, variables) => {
      seen = { query, variables };
      return JSON.stringify({ data: { repository: {
        h0: { pageInfo: { hasNextPage: false }, nodes: [node(4, 'fix/"quoted"'), node(5, 'other')] },
        h1: { pageInfo: { hasNextPage: true }, nodes: [node(6, 'cez/busy')] },
      } } });
    }, 'acme', 'demo', ['fix/"quoted"', 'cez/busy']);
    expect(seen?.query).not.toContain('quoted');
    expect(seen?.variables).toMatchObject({ owner: 'acme', name: 'demo', h0: 'fix/"quoted"', h1: 'cez/busy' });
    // A node for some other head is never filed under this one.
    expect(result.complete.get('fix/"quoted"')?.map((pr) => pr.number)).toEqual([4]);
    expect(result.incomplete).toEqual(['cez/busy']);
  });

  it('names every head of a failed or unreadable batch incomplete', async () => {
    const heads = ['a', 'b'];
    expect((await fetchHeadBatch(async () => { throw new Error('rate limited'); }, 'o', 'n', heads)).incomplete).toEqual(heads);
    expect((await fetchHeadBatch(async () => 'not json', 'o', 'n', heads)).incomplete).toEqual(heads);
    expect((await fetchHeadBatch(async () => JSON.stringify({ data: { repository: null } }), 'o', 'n', heads)).incomplete).toEqual(heads);
  });

  it('asks in batches, serves a repeat from the cache, and is unavailable without a repository handle', async () => {
    vi.stubEnv('CEZ_DRY_RUN', '');
    const queries: string[][] = [];
    const forge = createGithubBranchForge({
      handle: async () => ({ owner: 'acme', name: 'demo' }),
      graphql: () => async (_query, variables) => {
        const heads = Object.entries(variables).filter(([key]) => /^h\d+$/.test(key)).map(([, value]) => String(value));
        queries.push(heads);
        return JSON.stringify({ data: { repository: Object.fromEntries(heads.map((head, i) => [`h${i}`, { pageInfo: { hasNextPage: false }, nodes: [node(i + 1, head)] }])) } });
      },
    });
    const heads = Array.from({ length: HEADS_PER_QUERY * 2 + 20 }, (_, i) => `cez/${String(i).padStart(8, '0')}`);
    const first = await forge.prsForHeads('/repo', heads);
    expect(queries.map((batch) => batch.length)).toEqual([HEADS_PER_QUERY, HEADS_PER_QUERY, 20]);
    expect(first.prs).toHaveLength(heads.length);
    expect(first.incomplete.size).toBe(0);
    const again = await forge.prsForHeads('/repo', heads);
    expect(queries).toHaveLength(3);
    expect(again.prs).toHaveLength(heads.length);

    const noHandle = createGithubBranchForge({ handle: async () => null, graphql: () => async () => { throw new Error('never asked'); } });
    expect(await noHandle.prsForHeads('/other', ['cez/x'])).toEqual({ available: false, prs: [], incomplete: new Set(['cez/x']) });
  });
});

/**
 * The regression this lookup replaced: one newest-first `gh pr list` of 500 PRs, read as the whole
 * history. A squash-merged branch whose PR is older than the newest 500 lost its only merge evidence
 * and stayed `not-landed` for good. A `gh` on PATH serves a repository of 600 PRs whichever way
 * the forge asks.
 */
describe('the default forge, against a repository with more than 500 PRs', () => {
  let root: string;
  let bin: string;

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'cez-forge-history-'));
    bin = mkdtempSync(join(tmpdir(), 'cez-forge-bin-'));
    await git(root, 'init', '-q', '-b', 'main');
    await commit(root, 'base.txt', 'base');
  });

  afterEach(() => {
    __clearPrListCacheForTests();
    vi.unstubAllEnvs();
    rmSync(root, { recursive: true, force: true });
    rmSync(bin, { recursive: true, force: true });
  });

  it('finds the merged PR of a branch older than the newest 500', async () => {
    const tip = await taskBranch(root, 'cez/oldest01', 1);
    const squash = await commit(root, 'squash.txt', 'Squash the oldest (#1)');
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, 'gh'), FAKE_GH);
    chmodSync(join(bin, 'gh'), 0o755);
    vi.stubEnv('PATH', `${bin}${delimiter}${process.env.PATH ?? ''}`);
    vi.stubEnv('CEZ_DRY_RUN', '');
    vi.stubEnv('FAKE_GH_HEAD', 'cez/oldest01');
    vi.stubEnv('FAKE_GH_TIP', tip);
    vi.stubEnv('FAKE_GH_MERGE', squash);

    const { payload } = await classifyBranches({
      root, runs: owners([runRecord('oldest01-1', 'done')]), isActive: () => false,
      currentBranch: 'main', hasRemote: true, forge: githubBranchForge,
    });
    expect(payload.branches.find((b) => b.name === 'cez/oldest01')?.class).toBe('merged');
    expect(payload.prStateKnown).toBe(true);
  });
});

/** 600 PRs, number 1 the oldest: the merged PR of `FAKE_GH_HEAD`. Answers `repo view`, `pr list` (newest
 *  first, up to `--limit`) and per-head GraphQL. */
const FAKE_GH = `#!/usr/bin/env node
const args = process.argv.slice(2);
const TOTAL = 600;
const pr = (n) => n === 1
  ? { number: 1, url: 'https://github.com/acme/demo/pull/1', headRefName: process.env.FAKE_GH_HEAD, baseRefName: 'main', headRefOid: process.env.FAKE_GH_TIP, mergeCommit: { oid: process.env.FAKE_GH_MERGE }, state: 'MERGED', isDraft: false }
  : { number: n, url: 'https://github.com/acme/demo/pull/' + n, headRefName: 'feat/n' + n, baseRefName: 'main', headRefOid: '0'.repeat(40), mergeCommit: null, state: 'CLOSED', isDraft: false };
if (args[0] === 'repo' && args[1] === 'view') { console.log('acme/demo'); process.exit(0); }
if (args[0] === 'pr' && args[1] === 'list') {
  const limit = Number(args[args.indexOf('--limit') + 1]);
  const out = [];
  for (let n = TOTAL; n > TOTAL - limit && n > 0; n--) out.push(pr(n));
  console.log(JSON.stringify(out));
  process.exit(0);
}
if (args[0] === 'api' && args[1] === 'graphql') {
  const repository = {};
  for (let i = 2; i < args.length; i += 2) {
    const [key, ...rest] = args[i + 1].split('=');
    if (!/^h\\d+$/.test(key)) continue;
    const head = rest.join('=');
    const nodes = [];
    for (let n = 1; n <= TOTAL; n++) if (pr(n).headRefName === head) nodes.push(pr(n));
    repository[key] = { pageInfo: { hasNextPage: false }, nodes };
  }
  console.log(JSON.stringify({ data: { repository } }));
  process.exit(0);
}
process.exit(1);
`;

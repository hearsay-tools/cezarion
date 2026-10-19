'use strict';

const { execFileSync } = require('node:child_process');
const { isDeepStrictEqual } = require('node:util');
const { VERSION } = require('./merge-recommendation-policy.cjs');
const SHA = /^[a-f0-9]{40}$/;
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

class Gh {
  constructor({ execute = execFileSync } = {}) { this.execute = execute; this.requests = 0; this.started = Date.now(); }
  async api(method, endpoint, body) {
    if (++this.requests > 1200 || Date.now() - this.started > 20 * 60 * 1000) throw new Error('GitHub request/time budget exhausted.');
    const args = ['api', endpoint, '--method', method];
    if (body !== undefined) args.push('--input', '-');
    let raw;
    try { raw = this.execute('gh', args, { encoding: 'utf8', timeout: 30000, maxBuffer: 4 * 1024 * 1024,
      input: body === undefined ? undefined : JSON.stringify(body), stdio: ['pipe', 'pipe', 'pipe'] }); }
    catch { throw new Error(`GitHub ${method} failed: ${endpoint.split('?')[0]}`); }
    const result = JSON.parse(raw);
    if (result?.errors) throw new Error('GitHub returned GraphQL errors.');
    return result;
  }
  async graphql(query, variables) { return (await this.api('POST', 'graphql', { query, variables })).data; }
  async pages(endpoint, key) {
    const all = []; let expected;
    for (let page = 1; page <= 20; page++) {
      const data = await this.api('GET', `${endpoint}${endpoint.includes('?') ? '&' : '?'}per_page=100&page=${page}`);
      if (data?.incomplete_results === true) throw new Error('Incomplete GitHub search evidence.');
      const rows = key ? data?.[key] : data;
      if (!Array.isArray(rows)) throw new Error('Invalid GitHub page.');
      if (key) {
        if (!Number.isSafeInteger(data.total_count) || data.total_count < 0
          || (expected !== undefined && expected !== data.total_count)) throw new Error('Inconsistent GitHub pagination.');
        expected = data.total_count;
      }
      all.push(...rows);
      if (rows.length < 100) {
        if (expected !== undefined && expected !== all.length) throw new Error('Incomplete GitHub evidence.');
        return all;
      }
    }
    throw new Error('GitHub pagination limit reached; evidence incomplete.');
  }
}

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', timeout: 30000, maxBuffer: 4 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
}

function readPinnedDiff({ cwd = process.cwd(), baseSha, headSha, fetch = false, repository }) {
  if (!SHA.test(baseSha) || !SHA.test(headSha)) throw new Error('Invalid diff SHA.');
  if (fetch) {
    if (!REPOSITORY.test(repository || '')) throw new Error('Invalid repository.');
    git(cwd, ['fetch', '--no-tags', `https://github.com/${repository}.git`, baseSha, headSha]);
  }
  // Every content read shares one pin. Worktree attributes and external diff
  // drivers cannot change a report that names committed objects.
  const pinnedGit = args => git(cwd, [`--attr-source=${headSha}`, ...args]);
  const mergeBase = pinnedGit(['merge-base', baseSha, headSha]).trim();
  const options = ['--no-ext-diff', '--no-textconv', '--no-renames'];
  const stats = pinnedGit(['diff', ...options, '--numstat', '-z', mergeBase, headSha, '--']).split('\0').filter(Boolean);
  const statuses = pinnedGit(['diff', ...options, '--name-status', '-z', mergeBase, headSha, '--']).split('\0');
  const statusByPath = new Map();
  for (let i = 0; i < statuses.length - 1; i += 2) statusByPath.set(statuses[i + 1], ({ M: 'modified', A: 'added', D: 'removed', T: 'typechange' })[statuses[i]] || 'unknown');
  const files = stats.map(row => {
    const [add, del, ...parts] = row.split('\t');
    return { path: parts.join('\t'), additions: /^\d+$/.test(add) ? Number(add) : null,
      deletions: /^\d+$/.test(del) ? Number(del) : null };
  });
  const modes = ref => new Map(pinnedGit(['ls-tree', '-z', ref, '--', ...files.map(f => f.path)]).split('\0').filter(Boolean)
    .map(row => { const tab = row.indexOf('\t'); return [row.slice(tab + 1), row.slice(0, 6)]; }));
  const before = modes(mergeBase), after = modes(headSha);
  for (const f of files) Object.assign(f, { status: statusByPath.get(f.path), mode: after.get(f.path) || null,
    modeChanged: before.has(f.path) && before.get(f.path) !== after.get(f.path) });
  const diff = pinnedGit(['diff', ...options, '--unified=8', mergeBase, headSha, '--']);
  if (Buffer.byteLength(diff) > 1024 * 1024) throw new Error('Diff exceeds the complete-evidence limit.');
  return { files, diff, mergeBase };
}

async function collectSnapshot({ gh, repository, number, defaultBranch, policyCommit, trusted, cwd, diffReader = readPinnedDiff }) {
  if (!REPOSITORY.test(repository) || !Number.isSafeInteger(number) || number < 1) throw new Error('Invalid repository or PR number.');
  const prefix = `repos/${repository}`;
  const pr = await gh.api('GET', `${prefix}/pulls/${number}`);
  const s = { repository, number, policyVersion: VERSION, policyCommit, trusted, complete: false,
    title: pr.title, body: pr.body || '', headSha: pr.head?.sha, baseSha: null,
    state: pr.merged_at ? 'merged' : pr.state, draft: pr.draft, sameRepository: pr.head?.repo?.full_name === repository,
    targetDefault: pr.base?.ref === defaultBranch, mergeable: pr.mergeable, mergeState: pr.mergeable_state,
    files: [], diff: '', requiredChecks: [], checks: [], openThreads: null, reviewDecision: 'UNKNOWN' };
  if (pr.changed_files > 5 || pr.additions + pr.deletions > 150) {
    // Metadata alone can reject a large PR; it can never authorize one.
    s.sizeExceeded = true; return s;
  }
  if (s.state === 'closed' || s.state === 'merged') return s;
  try {
    const liveBase = async () => {
      const ref = await gh.api('GET', `${prefix}/git/ref/heads/${encodeURIComponent(defaultBranch)}`);
      if (!SHA.test(ref?.object?.sha || '')) throw new Error('Live target ref unavailable.');
      return ref.object.sha;
    };
    s.baseSha = await liveBase();
    const { files, diff } = diffReader({ cwd, repository, baseSha: s.baseSha, headSha: s.headSha, fetch: true });
    s.files = files; s.diff = diff;
    const complete = files.length === pr.changed_files && files.every(f => Number.isSafeInteger(f.additions) && Number.isSafeInteger(f.deletions))
      && files.reduce((n, f) => n + f.additions, 0) === pr.additions
      && files.reduce((n, f) => n + f.deletions, 0) === pr.deletions && s.body.length <= 12000;
    const readiness = async () => {
      const rules = await gh.pages(`${prefix}/rules/branches/${encodeURIComponent(defaultBranch)}`);
      const requiredChecks = rules.filter(r => r.type === 'required_status_checks')
        .flatMap(r => r.parameters?.required_status_checks || []).map(c => ({ name: c.context, appId: c.integration_id }));
      const rows = await gh.pages(`${prefix}/commits/${s.headSha}/check-runs`, 'check_runs');
      const checks = rows.map(c => ({ id: c.id, name: c.name, headSha: c.head_sha, appId: c.app?.id, status: c.status, conclusion: c.conclusion }));
      let cursor = null, openThreads = 0;
      for (let page = 0; page < 20; page++) {
        const data = await gh.graphql(`query($owner:String!,$repo:String!,$number:Int!,$cursor:String){repository(owner:$owner,name:$repo){pullRequest(number:$number){reviewDecision reviewThreads(first:100,after:$cursor){nodes{isResolved}pageInfo{hasNextPage endCursor}}}}}`,
          { owner: repository.split('/')[0], repo: repository.split('/')[1], number, cursor });
        const pull = data?.repository?.pullRequest, threads = pull?.reviewThreads;
        if (!Array.isArray(threads?.nodes) || threads.nodes.some(n => typeof n.isResolved !== 'boolean')) throw new Error('Review evidence incomplete.');
        openThreads += threads.nodes.filter(n => !n.isResolved).length;
        if (threads.pageInfo?.hasNextPage === false) return { requiredChecks, checks, openThreads, reviewDecision: pull.reviewDecision };
        if (!threads.pageInfo?.endCursor || threads.pageInfo.endCursor === cursor) throw new Error('Review pagination incomplete.');
        cursor = threads.pageInfo.endCursor;
      }
      throw new Error('Review pagination limit reached; evidence incomplete.');
    };
    const initialReadiness = await readiness();
    Object.assign(s, initialReadiness);
    // Pagination can race a new review thread, check rerun or rule change while
    // the head stays fixed. Require a second matching complete readiness read.
    const finalReadiness = await readiness();
    Object.assign(s, finalReadiness);
    // PR metadata's base.sha is historical. Re-read the live target and PR only
    // after all potentially slow evidence pages, immediately before returning.
    const finalPr = await gh.api('GET', `${prefix}/pulls/${number}`);
    const final = { headSha: finalPr.head?.sha, baseSha: await liveBase(),
      state: finalPr.merged_at ? 'merged' : finalPr.state, draft: finalPr.draft,
      sameRepository: finalPr.head?.repo?.full_name === repository,
      targetDefault: finalPr.base?.ref === defaultBranch,
      mergeable: finalPr.mergeable, mergeState: finalPr.mergeable_state };
    if (!isDeepStrictEqual(initialReadiness, finalReadiness)
      || Object.entries(final).some(([key, value]) => s[key] !== value)) {
      Object.assign(s, final);
      s.error = 'The PR revision or readiness changed during evidence collection.';
    } else s.complete = complete && s.openThreads !== null;
  } catch { s.complete = false; s.error = 'Required GitHub or pinned Git evidence is unavailable.'; }
  return s;
}

async function observeFollowups(gh, repository, number) {
  const data = await gh.graphql(`query($owner:String!,$repo:String!,$number:Int!){repository(owner:$owner,name:$repo){pullRequest(number:$number){merged closingIssuesReferences(first:20){nodes{number state}pageInfo{hasNextPage}}timelineItems(last:20,itemTypes:[CROSS_REFERENCED_EVENT]){nodes{... on CrossReferencedEvent{source{... on PullRequest{number title url merged}}}}pageInfo{hasPreviousPage}}}}}`,
    { owner: repository.split('/')[0], repo: repository.split('/')[1], number });
  const pr = data?.repository?.pullRequest;
  if (!pr) throw new Error('Follow-up evidence unavailable.');
  const warnings = [];
  if (pr.merged) {
    for (const issue of pr.closingIssuesReferences?.nodes || []) if (issue.state === 'OPEN') warnings.push(`Closing issue is open: https://github.com/${repository}/issues/${issue.number}`);
    for (const event of pr.timelineItems?.nodes || []) if (event.source?.merged) warnings.push(`Linked merged follow-up (not proven corrective): ${event.source.url}`);
  }
  if (pr.closingIssuesReferences?.pageInfo?.hasNextPage || pr.timelineItems?.pageInfo?.hasPreviousPage) warnings.push('Follow-up evidence is bounded to 20 closing issues and 20 latest cross-references.');
  return warnings.slice(0, 5);
}

module.exports = { Gh, git, REPOSITORY, readPinnedDiff, collectSnapshot, observeFollowups };

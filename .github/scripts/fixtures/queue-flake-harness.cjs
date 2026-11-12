'use strict';

// A fake GitHub API for report-queue-flakes.cjs: one merge-group CI run, its jobs and
// artifacts, the merge group's tree, the labels, and the issues and comments it writes.
const assert = require('node:assert/strict');
const { zip } = require('./queue-flake-zip.cjs');

const OWNER = 'hearsay-tools';
const REPO = 'squawk';
const SHA = 'a'.repeat(40);
const BOT = { login: 'github-actions[bot]', type: 'Bot' };
const VITEST_FIRST = 'Run server and cockpit unit suites with Squeal recording';
const VITEST_RERUN = 'Rerun server and cockpit unit suites with Squeal recording';

function shardJob(id, name, first, rerun, rerunConclusion) {
  return { id, name, conclusion: rerunConclusion === 'failure' ? 'failure' : 'success', steps: [
    { number: 1, name: 'Set up job', conclusion: 'success' },
    // A failed `continue-on-error` step reads `success` in the jobs API.
    { number: 7, name: first, conclusion: 'success' },
    { number: 8, name: 'Reset Vitest\'s results cache for the rerun', conclusion: rerunConclusion === 'skipped' ? 'skipped' : 'success' },
    { number: 10, name: rerun, conclusion: rerunConclusion },
  ] };
}
const vitestJob = (shard, rerun = 'success') => shardJob(100 + shard, `Vitest shard ${shard}/4`, VITEST_FIRST, VITEST_RERUN, rerun);
const browserJob = (shard, rerun = 'success') => shardJob(200 + shard, `Cockpit browser E2E shard ${shard}/4`, 'Run cockpit browser E2E', 'Rerun cockpit browser E2E', rerun);
const listArchive = (names) => zip([{ name: 'failed-test-files.txt', data: names.map((name) => `${name}\n`).join('') }]);

function run(id = 501) {
  return {
    id, run_attempt: 1, name: 'CI', path: '.github/workflows/ci.yml', event: 'merge_group', status: 'completed',
    conclusion: 'success', head_sha: SHA, head_branch: `gh-readonly-queue/main/pr-3300-${'b'.repeat(40)}`,
    head_repository: { full_name: `${OWNER}/${REPO}` }, created_at: '2026-11-12T01:00:00Z',
  };
}

function apiError(status) { return Object.assign(new Error(`secret ${status}`), { status }); }

function filterIssues(issues, args) {
  return issues.filter((issue) => issue.labels.includes(args.labels) && issue.user.login === args.creator
    && (args.state === 'all' || issue.state === args.state) && (!args.since || issue.updated_at >= args.since));
}

const artifactList = (state) => Object.entries(state.artifacts).map(([name, bytes], index) => ({ id: 9000 + index, name, bytes }));

function routes(state) {
  return {
    'GET /repos/{owner}/{repo}/actions/runs/{run_id}/attempts/{attempt_number}/jobs': (args) => {
      assert.equal(args.run_id, state.run.id); assert.equal(args.attempt_number, state.run.run_attempt);
      return state.jobs;
    },
    'GET /repos/{owner}/{repo}/labels/{name}': (args) => {
      if (!state.labels.includes(args.name)) throw apiError(404);
      return { name: args.name };
    },
    'GET /repos/{owner}/{repo}/actions/runs/{run_id}/artifacts': (args) => artifactList(state)
      .filter((artifact) => artifact.name === args.name)
      .map(({ id, name, bytes }) => ({ id, name, expired: false, size_in_bytes: bytes.length, workflow_run: { id: state.run.id } })),
    'GET /repos/{owner}/{repo}/actions/artifacts/{artifact_id}/{archive_format}': (args) => {
      assert.equal(args.archive_format, 'zip'); assert.equal(args.request.redirect, 'manual');
      return { headers: { location: `https://blob.example/${args.artifact_id}` } };
    },
    'GET /repos/{owner}/{repo}/git/trees/{tree_sha}': (args) => {
      assert.equal(args.tree_sha, SHA); assert.equal(args.recursive, '1');
      return { sha: SHA, truncated: state.truncated, tree: state.tree.map((path) => ({ path, type: 'blob', mode: '100644' })) };
    },
    'GET /repos/{owner}/{repo}/issues': (args) => { assert.equal(args.per_page, 100); return filterIssues(state.issues, args); },
    'GET /repos/{owner}/{repo}/issues/{issue_number}/comments': (args) => state.comments.filter((comment) => comment.issue_number === args.issue_number),
    'POST /repos/{owner}/{repo}/issues': (args) => {
      if (state.failCreate) throw apiError(500);
      const issue = { number: state.issues.length + 1, state: 'open', user: BOT, updated_at: '2026-11-12T01:20:00Z', title: args.title, body: args.body, labels: args.labels };
      state.issues.push(issue);
      if (state.loseCreate) { state.loseCreate = false; throw apiError(502); }
      return issue;
    },
    'POST /repos/{owner}/{repo}/issues/{issue_number}/comments': (args) => {
      const comment = { id: state.comments.length + 1, issue_number: args.issue_number, user: BOT, body: args.body };
      state.comments.push(comment);
      return comment;
    },
  };
}

function harness({ jobs = [vitestJob(2)], artifacts, tree } = {}) {
  const names = ['packages/cezar/src/runs/manager.test.ts'];
  const state = {
    run: run(), jobs, labels: ['flake-report', 'flaky-test'], truncated: false, issues: [], comments: [],
    artifacts: artifacts ?? { 'failed-test-files-vitest-shard-2': listArchive(names) },
    tree: tree ?? [...names, 'packages/web/src/board.test.tsx', 'packages/web/e2e/specs/board.spec.ts', 'README.md'],
    blobs: {},
  };
  const calls = [];
  const fetches = [];
  const table = routes(state);
  const request = async (route, args) => {
    calls.push([route, args]);
    assert.equal(args.owner, OWNER); assert.equal(args.repo, REPO);
    const handler = table[route];
    if (!handler) throw new Error(`unexpected route ${route}`);
    const result = handler(args);
    if (route.includes('{archive_format}')) return { status: 302, headers: result.headers, data: '' };
    return { status: 200, headers: {}, data: structuredClone(result) };
  };
  const github = {
    request,
    paginate: async (route, args) => { assert.equal(args.per_page, 100); return (await request(route, args)).data; },
  };
  // `state.blobs[name] = null` makes blob storage answer 404 for that artifact.
  const fetchImpl = async (url, options) => {
    fetches.push([String(url), options]);
    assert.equal(options.headers, undefined, 'no token goes to blob storage');
    const artifact = artifactList(state).find((item) => `https://blob.example/${item.id}` === String(url));
    if (state.blobs[artifact.name] === null) return new Response(null, { status: 404 });
    return new Response(artifact.bytes);
  };
  const messages = [];
  const event = () => ({ action: 'completed', workflow_run: structuredClone(state.run) });
  const options = () => ({ github, owner: OWNER, repo: REPO, event: event(), fetchImpl, log: (message) => messages.push(message) });
  return { state, calls, fetches, messages, options, writes: () => calls.filter(([route]) => route.startsWith('POST ')) };
}

module.exports = { harness, vitestJob, browserJob, listArchive, run, SHA, OWNER, REPO };

'use strict';
const { mergeQueueAdmission } = require('./merge-queue-admission.cjs');
const SHA = 'a'.repeat(40), BASE = 'b'.repeat(40), HEAD = 'c'.repeat(40);
function fixture(fork = false) {
  const headRepo = fork ? 'fork/r' : 'o/r';
  const s = {
    group: { head_sha: SHA, base_sha: BASE, base_ref: 'refs/heads/main', head_ref: 'refs/heads/gh-readonly-queue/main/pr-7' },
    rules: [{ type: 'merge_queue', parameters: { merge_method: 'SQUASH', max_entries_to_build: 1,
      min_entries_to_merge: 1, max_entries_to_merge: 1, grouping_strategy: 'ALLGREEN', check_response_timeout_minutes: 45 } },
    { type: 'required_status_checks', parameters: { required_status_checks: ['Unit, build, E2E, and package', 'Automated Code Review'].map(context => ({ context, integration_id: 15368 })) } },
    { type: 'pull_request', parameters: { required_review_thread_resolution: true } }],
    entry: { id: 'entry', position: 1, headCommit: { oid: SHA }, baseCommit: { oid: BASE }, pullRequest: { number: 7, headRefOid: HEAD } },
    pr: { number: 7, state: 'open', draft: false, base: { ref: 'main', repo: { full_name: 'o/r' } }, head: { sha: HEAD, ref: 'feature', repo: { full_name: headRepo } } },
    run: { id: 20, run_attempt: 1, workflow_id: 3, path: '.github/workflows/ci.yml', event: 'pull_request_target',
      repository: { full_name: 'o/r' }, head_repository: { full_name: headRepo }, head_sha: HEAD, head_branch: 'feature',
      status: 'completed', conclusion: 'success', pull_requests: [{ number: 7, head: { sha: HEAD }, base: { ref: 'main' } }] },
    jobs: ['Unit, build, E2E, and package', 'Automated Code Review'].map((name, i) => ({ id: i + 1, name, status: 'completed', conclusion: 'success' })),
    threads: [], calls: [],
  };
  const github = { request: async (route, args) => {
    s.calls.push(route); s.onRead?.(route, args);
    if (s.fail) throw new Error('API unavailable');
    let data;
    if (route.endsWith('/rules/branches/{branch}')) data = s.rules;
    else if (route === 'POST /graphql') data = args.query.includes('mergeQueue(')
      ? { data: { repository: { mergeQueue: { entries: { nodes: s.entries ?? [s.entry], pageInfo: { hasNextPage: false } } } } } }
      : { data: { repository: { pullRequest: { reviewThreads: { nodes: s.threads, pageInfo: { hasNextPage: args.variables.cursor ? false : !!s.nextThreads, endCursor: s.nextThreads ? 'next' : null } } } } } };
    else if (route.endsWith('/pulls/{pull_number}')) data = s.pr;
    else if (route.endsWith('/workflows/{workflow_id}')) data = { id: 3, path: '.github/workflows/ci.yml', state: 'active' };
    else if (route.endsWith('/workflows/{workflow_id}/runs')) data = { total_count: s.runs?.length ?? 1, workflow_runs: s.runs ?? [s.run] };
    else if (route.endsWith('/runs/{run_id}/jobs')) data = { total_count: s.jobs.length, jobs: s.jobs };
    else if (route.endsWith('/runs/{run_id}')) data = s.run;
    else throw new Error(`unexpected ${route}`);
    return { data: structuredClone(data) };
  } };
  return { s, github, run: () => mergeQueueAdmission({ github, owner: 'o', repo: 'r', group: s.group }) };
}
module.exports = { fixture, SHA, BASE, HEAD };

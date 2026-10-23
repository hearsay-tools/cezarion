'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
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
  return { s, run: () => mergeQueueAdmission({ github, owner: 'o', repo: 'r', group: s.group }) };
}
for (const fork of [false, true]) test(`valid reviewed native head admitted (fork=${fork})`, async () => {
  const h = fixture(fork); assert.equal((await h.run()).pullNumber, 7);
});
for (const [label, mutate] of Object.entries({
  'missing entry': s => { s.entries = []; },
  'duplicate entry': s => { s.entries = [s.entry, s.entry]; },
  'wrong combined SHA': s => { s.entry.headCommit.oid = HEAD; },
  'wrong base': s => { s.entry.baseCommit.oid = HEAD; },
  'second entry': s => { s.entry.position = 2; },
  'changed PR head': s => { s.pr.head.sha = SHA; },
  'draft': s => { s.pr.draft = true; },
  'closed': s => { s.pr.state = 'closed'; },
  'wrong target': s => { s.pr.base.ref = 'release'; },
  'parallel builds': s => { s.rules[0].parameters.max_entries_to_build = 2; },
  'multi merge': s => { s.rules[0].parameters.max_entries_to_merge = 2; },
  'missing rule': s => { s.rules = []; },
  'foreign Actions integration': s => { s.rules[1].parameters.required_status_checks[0].integration_id = 2; },
  'thread protection disabled': s => { s.rules[2].parameters.required_review_thread_resolution = false; },
  'unresolved thread': s => { s.threads = [{ id: 't', isResolved: false }]; },
  'dispatch review': s => { s.run.event = 'workflow_dispatch'; },
  'foreign workflow': s => { s.run.workflow_id = 4; },
  'foreign repository': s => { s.run.repository.full_name = 'evil/r'; },
  'foreign head': s => { s.run.head_repository.full_name = 'evil/r'; },
  'wrong attribution': s => { s.run.pull_requests[0].number = 8; },
  'newer failed run': s => { s.runs = [s.run, { ...s.run, id: 21, conclusion: 'failure' }]; },
  'pending native review': s => { s.run.status = 'in_progress'; },
  'skipped review job': s => { s.jobs[1].conclusion = 'skipped'; },
  'missing review job': s => { s.jobs.pop(); },
  'duplicate review': s => { s.jobs.push({ ...s.jobs[1], id: 3 }); },
  'API failure': s => { s.fail = true; },
})) test(`admission fails closed: ${label}`, async () => {
  const h = fixture(); mutate(h.s); await assert.rejects(h.run);
});
test('a later paginated unresolved thread blocks admission', async () => {
  const h = fixture(); h.s.nextThreads = true;
  h.s.onRead = (route, args) => { if (args.variables?.cursor) h.s.threads = [{ id: 'later', isResolved: false }]; };
  await assert.rejects(h.run, /Unresolved/);
});
for (const target of ['queue', 'head', 'attempt']) test(`final reread rejects moving ${target}`, async () => {
  const h = fixture(); let reads = 0;
  h.s.onRead = route => {
    const match = target === 'queue' ? route === 'POST /graphql' : target === 'head' ? route.endsWith('/pulls/{pull_number}') : route.endsWith('/runs/{run_id}');
    if (match && ++reads === 2) {
      if (target === 'queue') h.s.entry.id = 'new';
      if (target === 'head') h.s.pr.head.sha = SHA;
      if (target === 'attempt') h.s.run.run_attempt++;
    }
  };
  await assert.rejects(h.run);
});

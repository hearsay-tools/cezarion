'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { prTestProof, PR_TEST_JOBS } = require('./pr-test-proof.cjs');
const { attestationName } = require('./pr-test-input.cjs');
const { fixture: admissionFixture, SHA, BASE, HEAD } = require('./merge-queue.testkit.cjs');
function fixture() {
  const h = admissionFixture(); const { s } = h;
  s.pr.base.sha = BASE;
  s.jobs.push(...[...PR_TEST_JOBS, attestationName(BASE, HEAD)].map((name, i) => ({ id: 10 + i, name, status: 'completed', conclusion: 'success' })));
  s.hasNextPage = false; s.main = BASE;
  s.commits = { [SHA]: { sha: SHA, tree: { sha: HEAD }, parents: [{ sha: BASE }] }, [HEAD]: { sha: HEAD, tree: { sha: HEAD } } };
  const github = { request: async (route, args) => {
    if (route.endsWith('/git/ref/{ref}') || route.endsWith('/git/commits/{commit_sha}')) {
      s.onRead?.(route, args);
      if (s.gitError) throw new Error('private git API error');
      return { data: structuredClone(route.endsWith('/git/ref/{ref}') ? { object: { sha: s.main } } : s.commits[args.commit_sha]) };
    }
    const response = await h.github.request(route, args);
    if (route === 'POST /graphql' && args.query.includes('mergeQueue(')) response.data.data.repository.mergeQueue.entries.pageInfo.hasNextPage = s.hasNextPage;
    return response;
  } };
  const options = { github, owner: 'o', repo: 'r', eventName: 'merge_group', group: s.group };
  return { s, options, run: () => prTestProof(options) };
}
test('reuses only complete attested native suites for the single unchanged queue entry', async () => {
  const h = fixture(); const result = await h.run();
  assert.equal(result.verified, true); assert.equal(result.runId, 20); assert.equal(result.attempt, 1);
  assert.equal(result.base, BASE); assert.equal(result.head, HEAD);
  assert.match(result.url, /actions\/runs\/20\/attempts\/1$/);
});
for (const [name, mutate] of Object.entries({
  'more entries': s => { s.hasNextPage = true; },
  'unknown pagination': s => { s.hasNextPage = undefined; },
  'no queue entry': s => { s.entries = []; },
  'multiple entry records': s => { s.entries = [s.entry, s.entry]; },
  'wrong queue head': s => { s.entry.headCommit.oid = BASE; },
  'wrong queue base': s => { s.entry.baseCommit.oid = SHA; },
  'main advanced': s => { s.main = HEAD; },
  'PR base changed': s => { s.pr.base.sha = SHA; },
  'fork': s => { s.pr.head.repo.full_name = 'fork/r'; s.run.head_repository.full_name = 'fork/r'; },
  'different tree': s => { s.commits[SHA].tree.sha = BASE; },
  'wrong queue parent': s => { s.commits[SHA].parents[0].sha = HEAD; },
  'missing source commit': s => { delete s.commits[HEAD]; },
  'wrong source identity': s => { s.commits[HEAD].sha = BASE; },
  'no source tree': s => { s.commits[HEAD].tree = {}; },
  'no attestation': s => { s.jobs.pop(); },
  'wrong attested base': s => { s.jobs.at(-1).name = attestationName(SHA, HEAD); },
  'wrong attested head': s => { s.jobs.at(-1).name = attestationName(BASE, SHA); },
  'failed attestation': s => { s.jobs.at(-1).conclusion = 'failure'; },
  'duplicate attestation': s => { s.jobs.push({ ...s.jobs.at(-1), id: 999 }); },
  'missing shard': s => { s.jobs.splice(3, 1); },
  'duplicate shard': s => { s.jobs.push({ ...s.jobs[2], id: 999 }); },
  'skipped shard': s => { s.jobs[2].conclusion = 'skipped'; },
  'failed shard': s => { s.jobs[3].conclusion = 'failure'; },
  'pending shard': s => { s.jobs[3].status = 'in_progress'; },
  'newer failed native run': s => { s.runs = [s.run, { ...s.run, id: 21, conclusion: 'failure' }]; },
  'queued native run': s => { s.run.status = 'queued'; s.run.conclusion = null; },
  'dispatch source': s => { s.run.event = 'workflow_dispatch'; },
  'foreign workflow': s => { s.run.workflow_id = 99; },
  'foreign repository': s => { s.run.repository.full_name = 'evil/r'; },
  'wrong PR association': s => { s.run.pull_requests[0].number = 9; },
  'unresolved review': s => { s.threads = [{ id: 'thread', isResolved: false }]; },
  'rules changed': s => { s.rules[0].parameters.max_entries_to_build = 2; },
  'API error': s => { s.fail = true; },
  'git API error': s => { s.gitError = true; },
})) test(`full queue test fallback: ${name}`, async () => {
  const h = fixture(); mutate(h.s); assert.equal((await h.run()).verified, false);
});
for (const target of ['main', 'entry', 'head', 'attempt', 'newer-run', 'pagination']) test(`proof reread catches moving ${target}`, async () => {
  const h = fixture(); let count = 0;
  h.s.onRead = route => {
    const matching = target === 'main' ? route.endsWith('/git/ref/{ref}')
      : ['entry', 'pagination'].includes(target) ? route === 'POST /graphql'
        : ['head'].includes(target) ? route.endsWith('/pulls/{pull_number}') : route.endsWith('/runs/{run_id}');
    if (matching && ++count === (['entry', 'pagination'].includes(target) ? 4 : 3)) {
      if (target === 'main') h.s.main = HEAD;
      if (target === 'entry') h.s.entry.id = 'changed';
      if (target === 'pagination') h.s.hasNextPage = true;
      if (target === 'head') h.s.pr.head.sha = BASE;
      if (target === 'attempt') h.s.run.run_attempt++;
      if (target === 'newer-run') h.s.runs = [h.s.run, { ...h.s.run, id: 21, conclusion: 'failure' }];
    }
  };
  // Main has two reads; every other case moves at the final proof/admission boundary.
  if (target === 'main') {
    let reads = 0; h.s.onRead = route => { if (route.endsWith('/git/ref/{ref}') && ++reads === 2) h.s.main = HEAD; };
  }
  assert.equal((await h.run()).verified, false);
});
for (const eventName of ['push', 'pull_request_target', 'workflow_dispatch']) test(`${eventName} cannot reuse native suites`, async () => {
  const h = fixture(); h.options.eventName = eventName;
  assert.equal((await h.run()).verified, false); assert.equal(h.s.calls.length, 0);
});
test('a shared bounded deadline covers nested admission requests', async () => {
  const h = fixture(); let time = 0;
  h.options.now = () => { time += 11000; return time; };
  assert.equal((await h.run()).verified, false); assert.ok(h.s.calls.length < 10);
});

test('completed required suites can be reused while optional publication is still running', async () => {
  const h = fixture(); h.s.run.status = 'in_progress'; h.s.run.conclusion = null;
  assert.equal((await h.run()).verified, true);
  h.s.jobs[2].status = 'in_progress';
  assert.equal((await h.run()).verified, false);
});

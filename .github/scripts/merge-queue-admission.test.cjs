'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { fixture, SHA, BASE, HEAD } = require('./merge-queue.testkit.cjs');
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

test('final admission keeps rejecting an in-progress workflow even when required gates passed', async () => {
  const h = fixture(); h.s.run.status = 'in_progress'; h.s.run.conclusion = null;
  await assert.rejects(h.run, /has not passed/);
});

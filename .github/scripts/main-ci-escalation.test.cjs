'use strict';

// Guards the 60-minute owner mention and the missing Squeal ref warning
// (hearsay-tools/cezarion#3293).
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const yaml = require('yaml');
const { escalateMainCiFailures, MARKER } = require('./main-ci-escalation.cjs');
const { squealRefWarning } = require('./squeal-ref-warning.cjs');

const repoRoot = path.join(__dirname, '..', '..');
const workflow = (name) => yaml.parse(fs.readFileSync(path.join(repoRoot, '.github', 'workflows', name), 'utf8'));
const NOW = Date.parse('2026-11-12T12:00:00Z');
const minutesAgo = (m) => new Date(NOW - m * 60000).toISOString();

// A fake GitHub: open issues carry their comments; closed ones never come back from the list.
function fake({ issues, admins = [{ login: 'wjarka', type: 'User', permissions: { admin: true } }] }) {
  const posted = [];
  const github = {
    async paginate(route, args) {
      if (route.includes('/collaborators')) { assert.equal(args.permission, 'admin'); return admins; }
      if (route.includes('/comments')) return issues.find((i) => i.number === args.issue_number).comments ?? [];
      assert.equal(args.labels, 'main-ci-failure');
      assert.equal(args.state, 'open');
      return issues.filter((i) => i.state !== 'closed');
    },
    async request(route, args) {
      assert.match(route, /^POST .*comments$/);
      posted.push(args);
      issues.find((i) => i.number === args.issue_number).comments = [...(issues.find((i) => i.number === args.issue_number).comments ?? []), { body: args.body }];
    },
  };
  return { github, posted };
}
const run = (f) => escalateMainCiFailures({ github: f.github, owner: 'o', repo: 'r', now: NOW });

test('a summary open for 60 minutes gets one owner mention, and a later run adds none', async () => {
  const f = fake({ issues: [{ number: 1, created_at: minutesAgo(60) }, { number: 2, created_at: minutesAgo(59) }] });
  assert.deepEqual((await run(f)).mentioned, [1]);
  assert.match(f.posted[0].body, /^@wjarka /);
  assert.ok(f.posted[0].body.includes(MARKER));
  assert.deepEqual((await run(f)).mentioned, []);
  assert.equal(f.posted.length, 1);
});

test('a closed summary gets no mention', async () => {
  const f = fake({ issues: [{ number: 3, created_at: minutesAgo(600), state: 'closed' }] });
  assert.deepEqual((await run(f)).mentioned, []);
  assert.equal(f.posted.length, 0);
});

test('a pull request with the label is never mentioned', async () => {
  const f = fake({ issues: [{ number: 4, created_at: minutesAgo(600), pull_request: {} }] });
  assert.deepEqual((await run(f)).mentioned, []);
});

test('no admin to mention fails before any write', async () => {
  const f = fake({ issues: [{ number: 5, created_at: minutesAgo(600) }], admins: [{ login: 'bot', type: 'Bot', permissions: { admin: true } }] });
  await assert.rejects(run(f), /No repository admin/);
  assert.equal(f.posted.length, 0);
});

test('the Squeal ref warning appears only when the ref is missing', async () => {
  const sha = 'a'.repeat(40);
  const ask = (impl) => squealRefWarning({ github: { request: impl }, owner: 'o', repo: 'r', sha });
  assert.equal((await ask(async (route, args) => { assert.equal(args.ref, `squeal/${sha}`); return {}; })).warning, undefined);
  const missing = await ask(async () => { throw Object.assign(new Error('x'), { status: 404 }); });
  assert.equal(missing.state, 'missing');
  assert.ok(missing.warning.includes(`refs/squeal/${sha}`));
  assert.equal((await ask(async () => { throw Object.assign(new Error('x'), { status: 500 }); })).state, 'unknown');
  assert.equal((await squealRefWarning({ github: {}, owner: 'o', repo: 'r', sha: 'nope' })).state, 'invalid');
});

test('the escalation workflow is scheduled, default-branch only and holds only issue write', () => {
  const wf = workflow('main-ci-escalation.yml');
  assert.ok(wf.on.schedule.length > 0);
  assert.ok('workflow_dispatch' in wf.on);
  assert.deepEqual(wf.permissions, {});
  const job = wf.jobs.escalate;
  assert.deepEqual(job.permissions, { contents: 'read', issues: 'write' });
  assert.match(job.if, /default_branch/);
  assert.equal(wf.concurrency['cancel-in-progress'], false);
  assert.equal(job.steps.find((s) => s.uses?.startsWith('actions/checkout@')).with.ref, '${{ github.sha }}');
});

test('the Squeal ref check runs on main pushes only, reads only, and is not required', () => {
  const { jobs } = workflow('ci.yml');
  const job = jobs['squeal-ref-check'];
  assert.equal(job.if, "github.event_name == 'push' && github.ref == 'refs/heads/main'");
  assert.deepEqual(job.permissions, { contents: 'read' });
  assert.equal(job['continue-on-error'], undefined);
  // A warning-only job never turns the push run red: each step continues on error instead.
  const work = job.steps.filter((s) => s.id);
  assert.deepEqual(work.map((s) => s.id), ['checkout', 'check']);
  for (const s of work) assert.equal(s['continue-on-error'], true, s.name);
  // A suppressed failure still warns: the last step runs on any outcome but success.
  const last = job.steps.at(-1);
  assert.match(last.if, /^always\(\)/);
  assert.match(last.if, /steps\.checkout\.outcome != 'success'/);
  assert.match(last.if, /steps\.check\.outcome != 'success'/);
  assert.match(last.run, /::warning::/);
  const needs = (id) => [].concat(jobs[id].needs ?? []);
  for (const id of Object.keys(jobs)) assert.ok(!needs(id).includes('squeal-ref-check'), `${id} must not need it`);
});

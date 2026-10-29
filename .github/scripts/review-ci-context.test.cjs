'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { reviewCiContext } = require('./review-ci-context.cjs');
const head = 'a'.repeat(40);
const base = { ref: 'main', repo: { full_name: 'o/r' } };
function fixture() {
  const env = { HEAD_SHA: head, PR_NUMBER: '7', GITHUB_REPOSITORY: 'o/r', GITHUB_EVENT_NAME: 'pull_request_target',
    GITHUB_WORKFLOW_REF: 'o/r/.github/workflows/ci.yml@refs/heads/main', GITHUB_RUN_ID: '42', GITHUB_RUN_ATTEMPT: '2',
    REVIEW_PREFLIGHT_RESULT: 'success', REVIEW_CALLER_RUN_ID: '42', REVIEW_CALLER_ATTEMPT: '2', REVIEW_CALLER_HEAD: head };
  const event = { pull_request: { number: 7, head: { sha: head, ref: 'feature', repo: { full_name: 'o/r' } }, base } };
  const run = { id: 42, run_attempt: 2, event: 'pull_request_target', path: '.github/workflows/ci.yml',
    repository: { full_name: 'o/r' }, head_repository: { full_name: 'o/r' }, head_branch: 'feature', head_sha: head, pull_requests: [event.pull_request], status: 'in_progress', conclusion: null };
  const f = { env, event, run, live: { ...event.pull_request, state: 'open' }, jobs: [], preflight: [
    { name: 'Review preflight', status: 'completed', conclusion: 'success', run_attempt: 1 },
  ], calls: [], latest: 42 };
  f.gh = args => {
    f.calls.push(args);
    if (f.error) throw new Error('API unavailable');
    if (args[0] === 'run') return JSON.stringify(f.latest ? [{ databaseId: f.latest, headSha: head, event: 'pull_request_target' }] : []);
    const route = args.at(-1);
    if (route.endsWith('/pulls/7')) return JSON.stringify(f.live);
    if (route.endsWith('/runs/42')) return JSON.stringify(f.run);
    if (route.includes('filter=latest')) return JSON.stringify([{ total_count: f.preflight.length, jobs: f.preflight }]);
    if (route.includes('/attempts/2/jobs')) return JSON.stringify({ total_count: f.total ?? f.jobs.length, jobs: f.jobs });
    throw new Error(`Unexpected API route: ${route}`);
  };
  return f;
}
test('native context binds trusted caller and current head while heavy tests remain pending', () => {
  const f = fixture(); f.run.pull_requests = [];
  const text = reviewCiContext(f);
  assert.match(text, /Preflight: success/);
  assert.match(text, /Heavy verification: pending behind review/);
  assert.match(text, /Run: 42\nAttempt: 2/);
  assert.ok(f.calls.every(args => args[0] === 'api'), 'no earlier-run search or CI polling');
});
for (const [key, value] of Object.entries({ GITHUB_EVENT_NAME: 'push', GITHUB_WORKFLOW_REF: 'o/r/.github/workflows/evil.yml@refs/heads/main',
  REVIEW_PREFLIGHT_RESULT: 'skipped', REVIEW_CALLER_RUN_ID: '41', REVIEW_CALLER_ATTEMPT: '1', REVIEW_CALLER_HEAD: 'b'.repeat(40) })) {
  test(`native context rejects forged ${key}`, () => {
    const f = fixture(); f.env[key] = value;
    assert.throws(() => reviewCiContext(f), /provenance/);
    assert.equal(f.calls.length, 0);
  });
}
for (const patch of [{ path: '.github/workflows/evil.yml' }, { event: 'workflow_dispatch' }, { run_attempt: 1 },
  { repository: { full_name: 'evil/r' } }, { head_sha: 'b'.repeat(40) }, { head_branch: 'other' }, { head_repository: { full_name: 'evil/r' } }, { id: 41 }, { status: 'completed' }]) {
  test(`native context rejects mismatched official metadata ${JSON.stringify(patch)}`, () => {
    const f = fixture(); Object.assign(f.run, patch);
    assert.throws(() => reviewCiContext(f), /evidence|attempt changed/);
  });
}
for (const preflight of [[], [{ name: 'Review preflight', status: 'completed', conclusion: 'failure' }],
  [{ name: 'Review preflight', status: 'in_progress', conclusion: null }]]) {
  test(`native context refuses unavailable preflight ${JSON.stringify(preflight)}`, () => {
    const f = fixture(); f.preflight = preflight;
    assert.throws(() => reviewCiContext(f), /preflight did not succeed/);
  });
}
test('live head drift, event forgery and API failure cannot supply preflight evidence', () => {
  const f = fixture(); f.live.head = { sha: 'b'.repeat(40) };
  assert.throws(() => reviewCiContext(f), /head changed/);
  const forged = fixture(); forged.event.pull_request.number = 8;
  assert.throws(() => reviewCiContext(forged), /provenance/);
  const offline = fixture(); offline.error = true;
  assert.throws(() => reviewCiContext(offline), /API unavailable/);
});
for (const conclusion of ['success', 'failure', 'cancelled', null]) {
  test(`manual review retains current attempt ${conclusion} without waiting`, () => {
    const f = fixture(); f.env.GITHUB_EVENT_NAME = 'workflow_dispatch';
    f.run.status = conclusion ? 'completed' : 'in_progress'; f.run.conclusion = conclusion;
    f.jobs = [{ name: 'Unit, build, E2E, and package', status: f.run.status, conclusion }];
    const text = reviewCiContext(f);
    assert.match(text, new RegExp(`conclusion: ${conclusion || ''}\\n`));
    assert.match(text, /Attempt: 2/);
    assert.ok(f.calls.some(args => args.at(-1).includes('/attempts/2/jobs')));
    assert.ok(f.calls.every(args => !args.at(-1).includes('/attempts/1/')));
  });
}
test('manual context reports missing current-attempt verification as pending even if the run succeeded', () => {
  const f = fixture(); f.env.GITHUB_EVENT_NAME = 'workflow_dispatch';
  f.run.status = 'completed'; f.run.conclusion = 'success';
  assert.match(reviewCiContext(f), /status: pending\nconclusion: \n/);
  f.run.conclusion = 'cancelled';
  assert.match(reviewCiContext(f), /Workflow conclusion: cancelled/);
  f.latest = null;
  assert.match(reviewCiContext(f), /status: pending/);
});

function blockedFixture() {
  const f = fixture(); f.env.GITHUB_EVENT_NAME = 'workflow_dispatch';
  f.run.status = 'completed'; f.run.conclusion = 'failure';
  f.jobs = [
    { name: 'Review preflight', conclusion: 'success' },
    { name: 'Automated Code Review', conclusion: 'failure' },
    { name: 'Unit, build, E2E, and package', conclusion: 'failure' },
    { name: 'Unit, build, and package', conclusion: 'skipped' },
    ...[1, 2, 3].map(shard => ({ name: `Vitest shard ${shard}/3`, conclusion: 'skipped' })),
    ...[1, 2, 3, 4].map(shard => ({ name: `Cockpit browser E2E shard ${shard}/4`, conclusion: 'skipped' })),
  ].map(job => ({ ...job, status: 'completed' }));
  return f;
}

test('manual context distinguishes review-blocked verification from failed tests', () => {
  const f = blockedFixture();
  const text = reviewCiContext(f);
  assert.match(text, /Heavy verification: not started: blocked by review/);
  assert.match(text, /Verification aggregate: failure/);
  assert.match(text, /Workflow conclusion: failure/);
  assert.match(text, /Run: 42\nAttempt: 2/);
  assert.doesNotMatch(text, /## Failed jobs/);
});

test('manual context recognizes skipped matrices before shard expansion', () => {
  const f = blockedFixture();
  f.jobs = f.jobs.filter(job => !/shard/.test(job.name));
  f.jobs.push(...['Vitest shard /3', 'Cockpit browser E2E shard /4']
    .map(name => ({ name, status: 'completed', conclusion: 'skipped' })));
  assert.match(reviewCiContext(f), /Heavy verification: not started: blocked by review/);
});

test('manual context never hides actual heavy outcomes behind a failed review', () => {
  for (const name of ['Unit, build, and package', 'Vitest shard 2/3', 'Cockpit browser E2E shard 3/4']) {
    for (const conclusion of ['failure', 'timed_out', 'cancelled', 'success', null]) {
      const f = blockedFixture();
      Object.assign(f.jobs.find(job => job.name === name), {
        conclusion, status: conclusion ? 'completed' : 'in_progress',
      });
      const text = reviewCiContext(f);
      assert.doesNotMatch(text, /blocked by review/, `${name}: ${conclusion}`);
      assert.match(text, /## Failed jobs/);
      assert.match(text, /conclusion: failure/);
    }
  }
});

test('manual context needs complete review-blocked evidence and rejects cancellation', () => {
  const original = blockedFixture();
  for (const name of ['Review preflight', 'Automated Code Review', 'Unit, build, E2E, and package',
    'Unit, build, and package', 'Vitest shard', 'Cockpit browser E2E shard',
    'Vitest shard 2/3', 'Cockpit browser E2E shard 3/4']) {
    const f = blockedFixture();
    f.jobs = original.jobs.filter(job => !job.name.startsWith(name));
    assert.doesNotMatch(reviewCiContext(f), /blocked by review/, name);
  }
  for (const name of ['Review preflight', 'Automated Code Review', 'Unit, build, E2E, and package']) {
    const f = blockedFixture();
    f.jobs.find(job => job.name === name).conclusion = 'cancelled';
    assert.doesNotMatch(reviewCiContext(f), /blocked by review/, name);
  }
  const cancelled = blockedFixture(); cancelled.run.conclusion = 'cancelled';
  assert.doesNotMatch(reviewCiContext(cancelled), /blocked by review/);
});

test('manual context fails on incomplete jobs and API failure', () => {
  const f = fixture(); f.env.GITHUB_EVENT_NAME = 'workflow_dispatch'; f.total = 201;
  assert.throws(() => reviewCiContext(f), /Incomplete/);
  f.error = true;
  assert.throws(() => reviewCiContext(f), /API unavailable/);
});

test('native context refuses a changed attempt or cancellation during collection', () => {
  for (const update of [{ run_attempt: 3 }, { status: 'completed', conclusion: 'cancelled' }]) {
    const f = fixture(); const gh = f.gh; let reads = 0;
    f.gh = args => {
      if (args.at(-1).endsWith('/runs/42') && ++reads === 2) Object.assign(f.run, update);
      return gh(args);
    };
    assert.throws(() => reviewCiContext(f), /run changed/);
  }
});
test('manual context never falls back from a new failed run to an older success', () => {
  const f = fixture(); f.env.GITHUB_EVENT_NAME = 'workflow_dispatch';
  f.run.status = 'completed'; f.run.conclusion = 'failure';
  f.jobs = [{ name: 'Unit, build, E2E, and package', status: 'completed', conclusion: 'failure' }];
  const gh = f.gh;
  f.gh = args => args[0] === 'run' ? JSON.stringify([
    { databaseId: 41, headSha: head, event: 'pull_request_target' }, { databaseId: 42, headSha: head, event: 'pull_request_target' },
    { databaseId: 43, headSha: head, event: 'pull_request' },
  ]) : gh(args);
  assert.match(reviewCiContext(f), /conclusion: failure/);
  assert.ok(!f.calls.some(args => args.at(-1).includes('/runs/41')));
});
test('manual context refuses a new attempt that appears while reading jobs', () => {
  const f = fixture(); f.env.GITHUB_EVENT_NAME = 'workflow_dispatch';
  const gh = f.gh; let reads = 0;
  f.gh = args => {
    if (args.at(-1).endsWith('/runs/42') && ++reads === 2) f.run.run_attempt = 3;
    return gh(args);
  };
  assert.throws(() => reviewCiContext(f), /attempt changed/);
});

'use strict';

// Behaviour of the merge-queue flake reporter (docs/sdlc/ci.md § Flake reports from the merge
// queue; hearsay-tools/cezarion#3291) against a fake GitHub API.
const assert = require('node:assert/strict');
const test = require('node:test');
const { reportQueueFlakes, MARK } = require('./report-queue-flakes.cjs');
const { harness, vitestJob, browserJob, listArchive, SHA } = require('./fixtures/queue-flake-harness.cjs');

const MANAGER = 'packages/cezar/src/runs/manager.test.ts';
const BOARD = 'packages/web/src/board.test.tsx';
const SPEC = 'packages/web/e2e/activity.e2e.ts';
const KEY = 'hearsay-tools/squawk:501:1';

test('a shard that passed only on its rerun files one flake-report issue that names its files', async () => {
  const h = harness();
  assert.deepEqual(await reportQueueFlakes(h.options()), { flakes: 1, reported: 1 });
  assert.equal(h.state.issues.length, 1);
  const [issue] = h.state.issues;
  assert.deepEqual(issue.labels, ['flake-report'], 'no main-ci-failure label: the repair automation never takes it');
  assert.equal(issue.title, 'Flaky test in the merge queue: manager.test.ts');
  for (const text of [MARK.report, MARK.occurrence(KEY), MARK.file(MANAGER), `\`${MANAGER}\``,
    '[Vitest shard 2/8](https://github.com/hearsay-tools/squawk/actions/runs/501/job/102)',
    `https://github.com/hearsay-tools/squawk/commit/${SHA}`, 'hearsay-tools/squawk#3300', '`flaky-test`']) {
    assert.ok(issue.body.includes(text), text);
  }
  assert.ok(h.fetches.length === 1 && h.fetches[0][0].startsWith('https://blob.example/'));
});

test('one merge group with several flaked shards files one issue that names every file', async () => {
  const h = harness({
    jobs: [vitestJob(1, 'skipped'), vitestJob(2), browserJob(3), vitestJob(4, 'failure')],
    artifacts: {
      'failed-test-files-vitest-shard-2': listArchive([MANAGER, BOARD]),
      'failed-test-files-cockpit-browser-shard-3': listArchive([SPEC]),
      'failed-test-files-vitest-shard-4': listArchive(['packages/web/src/never.test.ts']),
    },
  });
  assert.deepEqual(await reportQueueFlakes(h.options()), { flakes: 2, reported: 1 });
  const [issue] = h.state.issues;
  assert.equal(issue.title, 'Flaky test in the merge queue: manager.test.ts and 2 more');
  for (const name of [MANAGER, BOARD, SPEC]) assert.ok(issue.body.includes(MARK.file(name)), name);
  assert.ok(issue.body.includes('Cockpit browser E2E shard 3/8'));
  assert.ok(!issue.body.includes('never.test.ts'), 'a shard that failed its rerun too is a failure, not a flake');
});

test('the eighth shard of each suite reports, and a run from before eight shards still reports', async () => {
  const h = harness({
    jobs: [vitestJob(8), browserJob(8), { ...vitestJob(3), id: 303, name: 'Vitest shard 3/4' }],
    artifacts: {
      'failed-test-files-vitest-shard-8': listArchive([MANAGER]),
      'failed-test-files-cockpit-browser-shard-8': listArchive([SPEC]),
      'failed-test-files-vitest-shard-3': listArchive([BOARD]),
    },
  });
  assert.deepEqual(await reportQueueFlakes(h.options()), { flakes: 3, reported: 1 });
  const [issue] = h.state.issues;
  for (const name of [MANAGER, SPEC, BOARD]) assert.ok(issue.body.includes(MARK.file(name)), name);
  for (const shard of ['Vitest shard 8/8', 'Cockpit browser E2E shard 8/8', 'Vitest shard 3/4']) assert.ok(issue.body.includes(shard), shard);
});

test('a later merge group that flakes on a reported file comments on that issue', async () => {
  const h = harness();
  await reportQueueFlakes(h.options());
  h.state.run.id = 502;
  assert.deepEqual(await reportQueueFlakes(h.options()), { flakes: 1, reported: 1 });
  assert.equal(h.state.issues.length, 1);
  assert.equal(h.state.comments.length, 1);
  assert.equal(h.state.comments[0].issue_number, 1);
  assert.ok(h.state.comments[0].body.includes(MARK.occurrence('hearsay-tools/squawk:502:1')));
  assert.ok(h.state.comments[0].body.includes(`\`${MANAGER}\``));
});

test('a repeat with a reported and a new file comments for one and files the other', async () => {
  const h = harness();
  await reportQueueFlakes(h.options());
  h.state.run.id = 502;
  h.state.artifacts['failed-test-files-vitest-shard-2'] = listArchive([MANAGER, BOARD]);
  assert.deepEqual(await reportQueueFlakes(h.options()), { flakes: 1, reported: 2 });
  assert.equal(h.state.comments.length, 1);
  assert.ok(!h.state.comments[0].body.includes(BOARD));
  assert.equal(h.state.issues.length, 2);
  assert.ok(h.state.issues[1].body.includes(MARK.file(BOARD)) && !h.state.issues[1].body.includes(MARK.file(MANAGER)));
});

test('a closed report, or one a person wrote, does not take the repeat', async () => {
  const h = harness();
  await reportQueueFlakes(h.options());
  h.state.issues[0].state = 'closed';
  h.state.issues.push({ number: 2, state: 'open', user: { login: 'someone' }, labels: ['flake-report'], updated_at: '2026-11-12T01:30:00Z', body: `${MARK.report}\n${MARK.file(MANAGER)}` });
  h.state.run.id = 502;
  await reportQueueFlakes(h.options());
  assert.equal(h.state.comments.length, 0);
  assert.equal(h.state.issues.length, 3);
});

test('a retry of the same run attempt writes nothing twice, after a lost create response too', async () => {
  const h = harness();
  h.state.loseCreate = true;
  await assert.rejects(reportQueueFlakes(h.options()));
  assert.equal(h.state.issues.length, 1);
  assert.deepEqual(await reportQueueFlakes(h.options()), { flakes: 1, reported: 0 });
  await reportQueueFlakes(h.options());
  h.state.run.id = 502;
  await reportQueueFlakes(h.options());
  h.state.run.id = 502;
  assert.deepEqual(await reportQueueFlakes(h.options()), { flakes: 1, reported: 0 });
  assert.equal(h.state.issues.length, 1);
  assert.equal(h.state.comments.length, 1);
});

// Each attempt overwrites the shard's artifact under the same name, and the artifact API names
// no attempt. Only an artifact created while the flaked job ran belongs to that attempt.
test('a replay of an earlier attempt never quotes a later attempt\'s files', async () => {
  const h = harness();
  const second = structuredClone(h.state.jobs);
  second[0].started_at = '2026-11-12T02:05:00Z';
  second[0].completed_at = '2026-11-12T02:40:00Z';
  h.state.run.run_attempt = 2;
  h.state.jobs = second;
  h.state.artifacts['failed-test-files-vitest-shard-2'] = listArchive([BOARD]);
  h.state.artifactTimes['failed-test-files-vitest-shard-2'] = '2026-11-12T02:20:00Z';
  await reportQueueFlakes(h.options());
  assert.ok(h.state.issues[0].body.includes(MARK.file(BOARD)));
  h.state.run.run_attempt = 1;
  h.state.jobs = harness().state.jobs;
  await reportQueueFlakes(h.options());
  assert.equal(h.state.issues.length, 2);
  const replay = h.state.issues[1].body;
  assert.ok(replay.includes(MARK.occurrence(KEY)));
  assert.ok(!replay.includes(BOARD), 'the second attempt\'s file stays out of the first attempt\'s report');
  assert.match(replay, /No failed-file list from this run attempt/);
});

test('a replay after the commented report closed writes nothing again', async () => {
  const h = harness();
  await reportQueueFlakes(h.options());
  h.state.run.id = 502;
  await reportQueueFlakes(h.options());
  h.state.issues[0].state = 'closed';
  assert.deepEqual(await reportQueueFlakes(h.options()), { flakes: 1, reported: 0 });
  assert.equal(h.state.issues.length, 1);
  assert.equal(h.state.comments.length, 1);
});

test('a replay that lost the artifact after its attempt commented files no nameless duplicate', async () => {
  const h = harness();
  await reportQueueFlakes(h.options());
  h.state.run.id = 502;
  await reportQueueFlakes(h.options());
  delete h.state.artifacts['failed-test-files-vitest-shard-2'];
  assert.deepEqual(await reportQueueFlakes(h.options()), { flakes: 1, reported: 0 });
  assert.equal(h.state.issues.length, 1);
  assert.equal(h.state.comments.length, 1);
});

test('a replay after a comment landed and the new report failed files only the report', async () => {
  const h = harness();
  await reportQueueFlakes(h.options());
  h.state.run.id = 502;
  h.state.artifacts['failed-test-files-vitest-shard-2'] = listArchive([MANAGER, BOARD]);
  h.state.failCreate = true;
  await assert.rejects(reportQueueFlakes(h.options()));
  assert.equal(h.state.comments.length, 1);
  h.state.failCreate = false;
  assert.deepEqual(await reportQueueFlakes(h.options()), { flakes: 1, reported: 1 });
  assert.equal(h.state.comments.length, 1);
  assert.equal(h.state.issues.length, 2);
  assert.ok(h.state.issues[1].body.includes(MARK.file(BOARD)) && !h.state.issues[1].body.includes(MARK.file(MANAGER)));
});

test('a name that is not a test file in the merge group\'s tree is dropped', async () => {
  const h = harness({
    artifacts: { 'failed-test-files-vitest-shard-2': listArchive([MANAGER, 'packages/cezar/src/gone.test.ts', 'README.md', 'src/`x`.test.ts']) },
  });
  await reportQueueFlakes(h.options());
  const { body } = h.state.issues[0];
  assert.ok(body.includes(MARK.file(MANAGER)));
  for (const dropped of ['gone.test.ts', 'README.md', '`x`']) assert.ok(!body.includes(dropped), dropped);
  assert.match(body, /3 names dropped/);
});

test('without usable names the report is filed without names and says why', async () => {
  const cases = [
    ['no artifact', {}, /No failed-file list from this run attempt/],
    ['a malformed artifact', { 'failed-test-files-vitest-shard-2': Buffer.from('not a zip') }, /failed-file list was malformed/],
    ['an empty list', { 'failed-test-files-vitest-shard-2': listArchive([]) }, /before any test file finished/],
    ['only foreign names', { 'failed-test-files-vitest-shard-2': listArchive(['packages/cezar/src/gone.test.ts']) }, /1 name dropped/],
  ];
  for (const [label, artifacts, note] of cases) {
    const h = harness({ artifacts });
    assert.deepEqual(await reportQueueFlakes(h.options()), { flakes: 1, reported: 1 }, label);
    const [issue] = h.state.issues;
    assert.equal(issue.title, 'Flaky merge-queue shard without test names: Vitest shard 2/8', label);
    assert.match(issue.body, note, label);
    assert.ok(!issue.body.includes('cez-flake-file'), label);
  }
});

test('an expired artifact or an oversized tree also files the report without names', async () => {
  const gone = harness();
  gone.state.blobs['failed-test-files-vitest-shard-2'] = null;
  await reportQueueFlakes(gone.options());
  assert.match(gone.state.issues[0].body, /No failed-file list from this run attempt/);
  const big = harness();
  big.state.truncated = true;
  await reportQueueFlakes(big.options());
  assert.match(big.state.issues[0].body, /tree was too large/);
  assert.ok(!big.state.issues[0].body.includes('cez-flake-file'));
});

test('a report names at most 50 files and says how many it left out', async () => {
  const names = Array.from({ length: 60 }, (_, i) => `packages/cezar/src/f${String(i).padStart(2, '0')}.test.ts`);
  const h = harness({ artifacts: { 'failed-test-files-vitest-shard-2': listArchive(names) }, tree: names });
  await reportQueueFlakes(h.options());
  assert.equal((h.state.issues[0].body.match(/cez-flake-file/g) ?? []).length, 50);
  assert.match(h.state.issues[0].body, /10 more names left out/);
});

test('with a label missing the job fails visibly before it writes anything', async () => {
  for (const missing of ['flake-report', 'flaky-test']) {
    const h = harness();
    h.state.labels = h.state.labels.filter((label) => label !== missing);
    await assert.rejects(reportQueueFlakes(h.options()), (error) => error.visible === true && error.message.includes(`\`${missing}\``));
    assert.equal(h.writes().length, 0, missing);
  }
});

test('a merge group without a flake reads no label, artifact or issue and writes nothing', async () => {
  for (const jobs of [[vitestJob(1, 'skipped'), browserJob(1, 'skipped')], [vitestJob(2, 'failure')], []]) {
    const h = harness({ jobs });
    assert.deepEqual(await reportQueueFlakes(h.options()), { flakes: 0, reported: 0 });
    assert.deepEqual(h.calls.map(([route]) => route), ['GET /repos/{owner}/{repo}/actions/runs/{run_id}/attempts/{attempt_number}/jobs']);
  }
});

test('only a completed merge-group CI run of this repository is read', async () => {
  const patches = [
    { event: 'push' }, { event: 'pull_request_target' }, { name: 'Nightly' }, { path: '.github/workflows/nightly.yml' },
    { head_repository: { full_name: 'attacker/squawk' } }, { status: 'in_progress' }, { head_branch: 'main' },
  ];
  for (const patch of patches) {
    const h = harness();
    Object.assign(h.state.run, patch);
    assert.deepEqual(await reportQueueFlakes(h.options()), { flakes: 0, reported: 0 }, JSON.stringify(patch));
    assert.equal(h.calls.length, 0, JSON.stringify(patch));
  }
  const h = harness();
  h.state.run.head_sha = 'not-a-sha';
  await assert.rejects(reportQueueFlakes(h.options()), /Invalid merge-group run/);
});

test('a job name or a step name outside the CI shards is not read as a flake', async () => {
  const forged = { ...vitestJob(2), name: 'Vitest shard 2/8 extra' };
  const renamed = vitestJob(3);
  renamed.steps[3].name = 'Rerun something else';
  const h = harness({ jobs: [forged, renamed] });
  assert.deepEqual(await reportQueueFlakes(h.options()), { flakes: 0, reported: 0 });
});

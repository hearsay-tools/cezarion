const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { publish } = require('./mutants-comment.cjs');
const { MARKER } = require('./mutants-report.cjs');
const { fakeGithub, BOT } = require('./mutants-github.testkit.cjs');

const HEAD_1 = '1'.repeat(40);
const HEAD_2 = '2'.repeat(40);
const HEAD_3 = '3'.repeat(40);

const mutant = (over = {}) => ({ file: 'packages/contract/src/attention.ts', line: 85, column: 48, mutator: 'ConditionalExpression', original: 'a', replacement: 'b', status: 'Survived', ...over });
const pack = (over = {}) => ({
  name: 'contract', state: 'completed', reason: '', changedLines: 4, relatedTests: 4, durationMs: 9000,
  counts: { killed: 0, survived: 1, noCoverage: 0, timeout: 0, error: 0, ignored: 0 }, mutants: [mutant()], omitted: 0, ...over,
});
const artifact = (head, packages) => ({ version: 1, state: 'ran', head, stryker: '10.1.1', packages });
const noLines = head => ({ version: 1, state: 'no-mutable-lines', head, stryker: '10.1.1', packages: [] });

const pr = (head, over = {}) => ({ number: 7, state: 'open', head: { sha: head }, base: { ref: 'main' }, ...over });
const run = (head, over = {}) => ({ event: 'pull_request', conclusion: 'success', head_sha: head, html_url: 'https://github.com/o/r/actions/runs/9', pull_requests: [], ...over });
const context = workflowRun => ({ repo: { owner: 'o', repo: 'r' }, payload: { workflow_run: workflowRun } });
const core = { info() {}, warning() {} };

function withArtifact(t, content) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mutants-comment-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  if (content !== undefined) fs.writeFileSync(path.join(dir, 'mutants.json'), typeof content === 'string' ? content : JSON.stringify(content));
  return dir;
}

const go = (github, workflowRun, dir) => publish({ github, context: context(workflowRun), core, dir });
const bodies = github => github.state.comments.map(c => c.body);

test('one comment across pushes: the first run creates it and every later run updates that comment', async t => {
  const github = fakeGithub({ pulls: [pr(HEAD_1)] });
  await go(github, run(HEAD_1), withArtifact(t, artifact(HEAD_1, [pack({ mutants: [mutant({ original: 'first-push-code' })] })])));
  github.state.pulls[0] = pr(HEAD_2);
  await go(github, run(HEAD_2), withArtifact(t, artifact(HEAD_2, [pack({ mutants: [mutant({ original: 'second-push-code' })] })])));
  assert.deepEqual(github.state.writes, ['create', 'update']);
  assert.equal(github.state.comments.length, 1);
  assert.match(bodies(github)[0], /second-push-code/);
  assert.doesNotMatch(bodies(github)[0], /first-push-code/);
  assert.match(bodies(github)[0], /`2222222`/);
  assert.ok(bodies(github)[0].startsWith(MARKER));
});

test('a later push with no mutable lines rewrites the comment and shows nothing from the earlier push', async t => {
  const github = fakeGithub({ pulls: [pr(HEAD_1)] });
  await go(github, run(HEAD_1), withArtifact(t, artifact(HEAD_1, [pack({ mutants: [mutant({ original: 'stale-survivor' })] })])));
  github.state.pulls[0] = pr(HEAD_2);
  await go(github, run(HEAD_2), withArtifact(t, noLines(HEAD_2)));
  assert.deepEqual(github.state.writes, ['create', 'update']);
  assert.match(bodies(github)[0], /No product source line changed in `2222222`/);
  assert.doesNotMatch(bodies(github)[0], /stale-survivor|survived/);
});

test('a later push skipped over the budget rewrites the comment with the reason, not the earlier survivors', async t => {
  const github = fakeGithub({ pulls: [pr(HEAD_1)] });
  await go(github, run(HEAD_1), withArtifact(t, artifact(HEAD_1, [pack({ mutants: [mutant({ original: 'stale-survivor' })] })])));
  github.state.pulls[0] = pr(HEAD_2);
  const skipped = pack({ state: 'skipped', reason: '264 test files import the changed files, over the budget of 150', counts: pack().counts, mutants: [] });
  await go(github, run(HEAD_2), withArtifact(t, artifact(HEAD_2, [skipped])));
  assert.equal(github.state.comments.length, 1);
  assert.match(bodies(github)[0], /Skipped: 264 test files import the changed files/);
  assert.doesNotMatch(bodies(github)[0], /stale-survivor/);
});

test('a push with no mutable lines posts nothing when no comment exists', async t => {
  const github = fakeGithub({ pulls: [pr(HEAD_1)] });
  await go(github, run(HEAD_1), withArtifact(t, noLines(HEAD_1)));
  assert.deepEqual(github.state.writes, []);
});

test('a first run skipped over the budget still posts, so the gap is visible', async t => {
  const github = fakeGithub({ pulls: [pr(HEAD_1)] });
  const skipped = pack({ state: 'skipped', reason: 'too big', mutants: [] });
  await go(github, run(HEAD_1), withArtifact(t, artifact(HEAD_1, [skipped])));
  assert.deepEqual(github.state.writes, ['create']);
});

test('a failed or timed-out job replaces an existing report and never creates a comment', async t => {
  const github = fakeGithub({ pulls: [pr(HEAD_1)] });
  await go(github, run(HEAD_1, { conclusion: 'failure' }), withArtifact(t));
  assert.deepEqual(github.state.writes, []);
  await go(github, run(HEAD_1), withArtifact(t, artifact(HEAD_1, [pack({ mutants: [mutant({ original: 'stale-survivor' })] })])));
  github.state.pulls[0] = pr(HEAD_2);
  await go(github, run(HEAD_2, { conclusion: 'timed_out' }), withArtifact(t));
  assert.deepEqual(github.state.writes, ['create', 'update']);
  assert.match(bodies(github)[0], /did not finish for `2222222`/);
  assert.doesNotMatch(bodies(github)[0], /stale-survivor/);
});

test('a run that a newer push cancelled touches nothing, not even the API', async t => {
  const github = fakeGithub({ pulls: [pr(HEAD_1)] });
  await go(github, run(HEAD_1, { conclusion: 'cancelled' }), withArtifact(t));
  assert.deepEqual(github.state.writes, []);
  assert.equal(github.state.reads, 0);
});

test('an artifact that is missing, not JSON, the wrong shape or too large reads as unreadable', async t => {
  const hostile = { ...artifact(HEAD_1, [pack()]), version: 9 };
  for (const content of [undefined, 'not json', JSON.stringify(hostile), JSON.stringify([1]), 'x'.repeat(2_000_000)]) {
    const github = fakeGithub({ pulls: [pr(HEAD_1)], comments: [{ id: 1, issue_number: 7, body: `${MARKER} old`, user: { login: BOT } }] });
    await go(github, run(HEAD_1), withArtifact(t, content));
    assert.deepEqual(github.state.writes, ['update'], String(content).slice(0, 20));
    assert.match(github.state.comments[0].body, /could not be read/);
  }
});

test('the body is built from the validated fields only, so extra artifact fields never reach the comment', async t => {
  const github = fakeGithub({ pulls: [pr(HEAD_1)] });
  const dirty = { ...artifact(HEAD_1, [pack()]), body: '@everyone buy now', packages: [{ ...pack(), note: '@everyone' }] };
  await go(github, run(HEAD_1), withArtifact(t, dirty));
  assert.doesNotMatch(bodies(github)[0], /everyone/);
});

test('a head that moved on, a closed PR or a run from another event writes nothing', async t => {
  const dir = withArtifact(t, artifact(HEAD_1, [pack()]));
  const moved = fakeGithub({ pulls: [pr(HEAD_2)] });
  await go(moved, run(HEAD_1), dir);
  const closed = fakeGithub({ pulls: [pr(HEAD_1, { state: 'closed' })] });
  await go(closed, run(HEAD_1), dir);
  const push = fakeGithub({ pulls: [pr(HEAD_1)] });
  await go(push, run(HEAD_1, { event: 'push' }), dir);
  for (const github of [moved, closed, push]) assert.deepEqual(github.state.writes, []);
});

test('the PR comes from the API, by the run payload when it lists one and by the head commit otherwise', async t => {
  const dir = withArtifact(t, artifact(HEAD_1, [pack()]));
  const listed = fakeGithub({ pulls: [pr(HEAD_1, { number: 7 }), pr(HEAD_3, { number: 8 })] });
  await go(listed, run(HEAD_1, { pull_requests: [{ number: 7 }] }), dir);
  assert.equal(listed.state.comments[0].issue_number, 7);
  const fork = fakeGithub({ pulls: [pr(HEAD_3, { number: 8 })] });
  await go(fork, run(HEAD_3, { pull_requests: [] }), withArtifact(t, artifact(HEAD_3, [pack()])));
  assert.equal(fork.state.comments[0].issue_number, 8);
});

test('only the bot\'s own marked comment is updated; a person who pasted the marker is left alone', async t => {
  const impostor = { id: 1, issue_number: 7, body: `${MARKER} look at me`, user: { login: 'mallory' } };
  const github = fakeGithub({ pulls: [pr(HEAD_1)], comments: [impostor] });
  await go(github, run(HEAD_1), withArtifact(t, artifact(HEAD_1, [pack()])));
  assert.deepEqual(github.state.writes, ['create']);
  assert.equal(github.state.comments[0].body, impostor.body);
  assert.equal(github.state.comments.length, 2);
});

'use strict';

// Pins the merge-queue flake reporter's workflow (docs/sdlc/ci.md § Flake reports from the merge
// queue; hearsay-tools/cezarion#3291): trusted code only, never the queued commit; the shard
// jobs, steps and artifacts it reads match ci.yml; and its entry point fails visibly.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { runInNewContext } = require('node:vm');
const yaml = require('yaml');
const { SHARD_KINDS } = require('./report-queue-flakes.cjs');
const { REQUIRED_QUEUE_JOBS } = require('./queue-ci-proof.cjs');
const { harness } = require('./fixtures/queue-flake-harness.cjs');

const root = path.resolve(__dirname, '../..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const workflow = () => yaml.parse(read('.github/workflows/report-queue-flakes.yml'));
const ci = () => yaml.parse(read('.github/workflows/ci.yml'));
const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;
const REPORTER = ['.github/scripts/report-queue-flakes.cjs', '.github/scripts/queue-flake-artifact.cjs'];

test('the job starts only after a merge-group CI run, with a narrow token and one write lock', () => {
  const w = workflow();
  assert.deepEqual(w.on, { workflow_run: { workflows: ['CI'], types: ['completed'] } });
  assert.deepEqual(w.permissions, {});
  assert.deepEqual(w.jobs.report.permissions, { actions: 'read', contents: 'read', issues: 'write' });
  assert.deepEqual(w.concurrency, { group: 'queue-flake-reports', queue: 'max', 'cancel-in-progress': false });
  const runs = (event) => runInNewContext(w.jobs.report.if.replaceAll('==', '==='), { github: { event: { workflow_run: { event } } } });
  assert.deepEqual(['merge_group', 'push', 'pull_request_target', 'workflow_dispatch'].map(runs), [true, false, false, false]);
});

test('the job has no checkout of the queued commit and runs none of its code', () => {
  const { steps } = workflow().jobs.report;
  assert.deepEqual(steps.map((step) => step.uses?.split('@')[0]), ['actions/checkout', 'actions/github-script']);
  assert.ok(steps.every((step) => step.run === undefined), 'no shell step');
  assert.deepEqual(steps[0].with, { ref: '${{ github.sha }}', 'persist-credentials': false });
  // The YAML without its comments: nothing names the queued commit, its branch or another download path.
  const code = yaml.stringify(workflow());
  assert.doesNotMatch(code, /head_sha|head_branch|head_commit|pull_request|download-artifact|secrets\.|npm |node /);
  const { script } = steps[1].with;
  assert.deepEqual([...script.matchAll(/require\('([^']+)'\)/g)].map((match) => match[1]), ['./.github/scripts/report-queue-flakes.cjs']);
  for (const file of REPORTER) {
    const source = read(file);
    const required = [...source.matchAll(/require\('([^']+)'\)/g)].map((match) => match[1]);
    assert.ok(required.every((name) => ['node:path', 'node:zlib', './queue-flake-artifact.cjs'].includes(name)), `${file}: ${required}`);
    assert.doesNotMatch(source, /child_process|\beval\(|new Function|node:vm|writeFile|mkdtemp/, file);
  }
});

test('the job sits outside the CI run and the queue roster, so the entry\'s verdict stays the same', () => {
  assert.doesNotMatch(read('.github/workflows/ci.yml'), /report-queue-flakes|Report Merge Queue Flakes/);
  assert.ok(!REQUIRED_QUEUE_JOBS.some((name) => /flake|report/i.test(name)));
});

test('the shard jobs, steps and artifacts the reporter reads are the ones ci.yml runs', () => {
  const { jobs } = ci();
  for (const kind of SHARD_KINDS) {
    const job = jobs[kind.job];
    const step = (id) => job.steps.find((item) => item.id === id);
    assert.match(job.name, new RegExp(`^${kind.title} \\$\\{\\{ matrix\\.shard \\}\\}/\\d+$`), kind.job);
    assert.equal(step(kind.firstId).name, kind.first, kind.job);
    assert.equal(step(kind.rerunId).name, kind.rerun, kind.job);
    // The rerun runs only after a failed first run, which the jobs API reads as `success`.
    assert.match(String(step(kind.firstId)['continue-on-error']), /merge_group/, kind.job);
    assert.match(step(kind.rerunId).if, new RegExp(`steps\\.${kind.firstId}\\.outcome == 'failure'`), kind.job);
    assert.ok(job.steps.some((item) => item.with?.name === `${kind.artifact}\${{ matrix.shard }}`), kind.job);
    for (const shard of job.strategy.matrix.shard) {
      const name = job.name.replace('${{ matrix.shard }}', shard);
      assert.ok(kind.pattern.test(name), name);
      assert.ok(REQUIRED_QUEUE_JOBS.includes(name), `${name} is a queue shard`);
    }
  }
});

async function execute(h) {
  const { script } = workflow().jobs.report.steps[1].with;
  const summary = [];
  const errors = [];
  const core = { info: () => {}, setFailed: (message) => errors.push(message), summary: { addRaw: (message) => { summary.push(message); return core.summary; }, write: async () => {} } };
  const options = h.options();
  const load = (file) => {
    const module = require(path.resolve(root, file));
    return { reportQueueFlakes: (args) => module.reportQueueFlakes({ ...args, fetchImpl: options.fetchImpl }) };
  };
  await new AsyncFunction('require', 'github', 'context', 'core', script)(load, options.github, { repo: { owner: options.owner, repo: options.repo }, payload: options.event }, core);
  return { errors, summary: summary.join('') };
}

test('the entry point reports success, a missing label by name, and API errors without their text', async () => {
  const ok = harness();
  const done = await execute(ok);
  assert.deepEqual(done.errors, []);
  assert.match(done.summary, /1 flaked shard\(s\), 1 new write\(s\)/);
  const unlabelled = harness();
  unlabelled.state.labels = ['flaky-test'];
  const missing = await execute(unlabelled);
  assert.equal(missing.errors.length, 1);
  assert.match(missing.errors[0], /`flake-report` is missing/);
  const broken = harness();
  broken.state.failCreate = true;
  const failed = await execute(broken);
  assert.equal(failed.errors.length, 1);
  assert.match(failed.errors[0], /Flake reporting failed/);
  assert.doesNotMatch(JSON.stringify(failed), /secret/);
});

test('reports queued behind the one lock file one issue for one run attempt', async () => {
  const h = harness();
  let lock = Promise.resolve();
  const enqueue = () => {
    const next = lock.then(() => execute(h));
    lock = next;
    return next;
  };
  const results = await Promise.all([enqueue(), enqueue(), enqueue()]);
  assert.ok(results.every((result) => result.errors.length === 0));
  assert.equal(h.state.issues.length, 1);
  assert.equal(h.state.comments.length, 0);
});

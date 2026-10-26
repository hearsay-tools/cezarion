const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const yaml = require('yaml');
const { REQUIRED_QUEUE_JOBS } = require('./queue-ci-proof.cjs');
const { DEFAULT_BUDGET } = require('./mutants-scope.cjs');
const { MARKER } = require('./mutants-report.cjs');
const { EVIDENCE, REPORT } = require('./mutants-run.cjs');
const { fakeGithub } = require('./mutants-github.testkit.cjs');

const root = path.resolve(__dirname, '../..');
const workflowsDir = path.join(root, '.github/workflows');
const read = name => fs.readFileSync(path.join(workflowsDir, name), 'utf8');
const REPORT_FILE = 'mutation-report.yml';
const COMMENT_FILE = 'mutation-report-comment.yml';
const reportSource = read(REPORT_FILE);
const commentSource = read(COMMENT_FILE);
const report = yaml.parse(reportSource);
const comment = yaml.parse(commentSource);
// The YAML without its comments, so a header that says "write" does not count as a write scope.
const reportCode = yaml.stringify(report);
const commentCode = yaml.stringify(comment);
const reportJob = report.jobs.mutants;
const commentJob = comment.jobs.comment;
const uses = job => job.steps.filter(step => step.uses).map(step => step.uses);
const step = (job, name) => job.steps.find(item => item.name === name);

test('both workflows say in their header that they are advisory and never block a merge', () => {
  for (const source of [reportSource, commentSource]) {
    const header = source.split('\n').slice(0, 12).filter(line => line.startsWith('#')).join(' ');
    assert.match(header, /Advisory/);
    assert.match(header, /never blocks a merge/);
  }
});

test('the pull request job has a read-only token, no secrets, a bounded run time and one run per pull request', () => {
  assert.deepEqual(Object.keys(report.on), ['pull_request']);
  assert.deepEqual(report.on.pull_request.branches, ['main']);
  assert.deepEqual(report.permissions, { contents: 'read' });
  assert.equal(reportJob.permissions, undefined);
  assert.doesNotMatch(reportCode, /pull_request_target|secrets\.|id-token|write|continue-on-error/);
  assert.equal(report.concurrency.group, 'mutation-report-${{ github.event.pull_request.number }}');
  assert.equal(report.concurrency['cancel-in-progress'], true);
  const minutes = reportJob['timeout-minutes'];
  assert.ok(minutes > DEFAULT_BUDGET.deadlineMinutes && minutes <= 60, `${minutes} minutes must outlast the ${DEFAULT_BUDGET.deadlineMinutes} minute deadline and stay within an hour`);
});

test('the pull request job checks out the merge revision without credentials and pins every action', () => {
  const checkout = reportJob.steps.find(item => item.uses?.startsWith('actions/checkout@'));
  assert.equal(checkout.with['persist-credentials'], false);
  assert.equal(checkout.with.ref, undefined, 'the default merge revision, so HEAD^1 is the base');
  assert.equal(checkout.with['fetch-depth'], 2);
  for (const action of [...uses(reportJob), ...uses(commentJob)]) assert.match(action, /^[\w.-]+\/[\w.-]+@[0-9a-f]{40}$/, action);
});

test('the pull request job installs and mutates only when the scope step found a product line, and always uploads', () => {
  const gated = ['Install dependencies', 'Build server dependencies', 'Mutate the changed lines'];
  for (const name of gated) assert.equal(step(reportJob, name).if, "steps.scope.outputs.has_work == 'true'", name);
  assert.equal(step(reportJob, 'Find the changed product lines').id, 'scope');
  assert.equal(step(reportJob, 'Find the changed product lines').run, 'node .github/scripts/mutants-run.cjs scope');
  assert.equal(step(reportJob, 'Mutate the changed lines').run, 'node .github/scripts/mutants-run.cjs run');
  const upload = step(reportJob, 'Upload the mutation evidence');
  assert.equal(upload.if, 'always()');
  assert.equal(upload.with.name, 'mutation-report');
  assert.equal(upload.with.path, `${EVIDENCE}/`);
});

test('the comment job holds the only write token, runs no pull request code and runs no shell', () => {
  assert.deepEqual(comment.on.workflow_run.workflows, [report.name]);
  assert.deepEqual(comment.on.workflow_run.types, ['completed']);
  assert.deepEqual(Object.keys(comment.on), ['workflow_run']);
  assert.deepEqual(comment.permissions, {});
  assert.deepEqual(commentJob.permissions, { actions: 'read', contents: 'read', 'pull-requests': 'write' });
  assert.equal((commentCode.match(/write/g) || []).length, 1, 'one write scope, in the comment workflow only');
  assert.ok(commentJob.steps.every(item => item.run === undefined), 'no shell step');
  const checkout = commentJob.steps[0];
  assert.equal(checkout.with.ref, '${{ github.sha }}');
  assert.equal(checkout.with['persist-credentials'], false);
  assert.match(commentJob.if, /workflow_run\.event == 'pull_request'/);
  assert.match(commentJob.if, /workflow_run\.conclusion != 'cancelled'/);
  assert.equal(commentJob['timeout-minutes'] <= 10, true);
  assert.doesNotMatch(commentCode, /pull_request_target/);
});

test('the comment job reads the artifact the pull request job uploads, from the run that triggered it', () => {
  const download = step(commentJob, 'Download the mutation evidence');
  assert.equal(download.with.name, step(reportJob, 'Upload the mutation evidence').with.name);
  assert.equal(download.with['run-id'], '${{ github.event.workflow_run.id }}');
  assert.equal(download['continue-on-error'], true);
  assert.equal(step(commentJob, 'Post or update the comment').env.ARTIFACT_DIR, download.with.path);
});

test('no required check, queue entry, failure reporter or other workflow depends on the mutation workflows', () => {
  const ciSource = read('ci.yml');
  const ci = yaml.parse(ciSource);
  assert.doesNotMatch(ciSource, /mutation|mutant|stryker/i);
  assert.ok(!ci.jobs.verify.needs.some(id => /mutation|mutant/i.test(id)), 'verify does not wait for it');
  for (const name of [reportJob.name, commentJob.name, report.name, comment.name]) assert.ok(!REQUIRED_QUEUE_JOBS.includes(name), name);
  for (const file of fs.readdirSync(workflowsDir).filter(name => /\.ya?ml$/.test(name))) {
    const listed = yaml.parse(read(file)).on?.workflow_run?.workflows ?? [];
    for (const name of [report.name, comment.name]) {
      assert.ok(!listed.includes(name) || file === COMMENT_FILE, `${file} must not wait for ${name}`);
    }
  }
});

test('the posting step drives the real script: two pushes to one pull request leave one marked comment', async t => {
  const script = step(commentJob, 'Post or update the comment').with.script;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mutation-workflow-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const previous = process.env.ARTIFACT_DIR;
  process.env.ARTIFACT_DIR = dir;
  t.after(() => { if (previous === undefined) delete process.env.ARTIFACT_DIR; else process.env.ARTIFACT_DIR = previous; });
  const heads = ['4'.repeat(40), '5'.repeat(40)];
  const github = fakeGithub({ pulls: [{ number: 3, state: 'open', head: { sha: heads[0] }, base: { ref: 'main' } }] });
  const pack = { name: 'contract', state: 'completed', reason: '', changedLines: 1, relatedTests: 1, durationMs: 1,
    counts: { killed: 0, survived: 1, noCoverage: 0, timeout: 0, error: 0, ignored: 0 }, omitted: 0,
    mutants: [{ file: 'packages/contract/src/a.ts', line: 1, column: 1, mutator: 'BlockStatement', status: 'Survived', original: 'a', replacement: 'b' }] };
  const AsyncFunction = (async () => {}).constructor;
  for (const [index, head] of heads.entries()) {
    github.state.pulls[0].head.sha = head;
    fs.writeFileSync(path.join(dir, 'mutants.json'), JSON.stringify({ version: 1, state: 'ran', head, stryker: '10.1.1', packages: [pack] }));
    const context = { repo: { owner: 'o', repo: 'r' }, payload: { workflow_run: { event: 'pull_request', conclusion: 'success', head_sha: head, id: 1, html_url: 'u', pull_requests: [] } } };
    await new AsyncFunction('require', 'github', 'context', 'core', 'process', script)(
      p => require(path.resolve(root, p)), github, context, { info() {}, warning() {} }, process);
    assert.equal(github.state.comments.length, 1, `after push ${index + 1}`);
  }
  assert.deepEqual(github.state.writes, ['create', 'update']);
  assert.ok(github.state.comments[0].body.startsWith('<!-- cezar-mutation-report -->'));
  assert.equal(MARKER, '<!-- cezar-mutation-report -->');
  assert.match(github.state.comments[0].body, /`5555555`/);
});

test('Stryker runs with the Vitest runner only, in place, with no TypeScript checker, and its report path matches the job', () => {
  const stryker = JSON.parse(fs.readFileSync(path.join(root, 'stryker.config.json'), 'utf8'));
  assert.equal(stryker.testRunner, 'vitest');
  assert.deepEqual(stryker.plugins, ['@stryker-mutator/vitest-runner']);
  assert.equal(stryker.checkers, undefined, 'the TypeScript checker needs the compiler API that TypeScript 7 lacks');
  assert.equal(stryker.inPlace, true);
  assert.equal(stryker.vitest.pool, 'forks');
  assert.ok(fs.existsSync(path.join(root, stryker.vitest.configFile)));
  assert.equal(stryker.jsonReporter.fileName, REPORT.split(path.sep).join('/'));
});

test('the Stryker packages are pinned to one exact version, and their output stays out of Git', () => {
  const { devDependencies } = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const core = devDependencies['@stryker-mutator/core'];
  assert.match(core, /^\d+\.\d+\.\d+$/);
  assert.equal(devDependencies['@stryker-mutator/vitest-runner'], core);
  assert.equal(Object.keys(devDependencies).filter(name => name.startsWith('@stryker-mutator/')).length, 2);
  const ignored = fs.readFileSync(path.join(root, '.gitignore'), 'utf8').split('\n');
  for (const pattern of ['.stryker-tmp/', '/reports/', '/mutation-evidence/', '/stryker-setup-*.js']) assert.ok(ignored.includes(pattern), pattern);
});

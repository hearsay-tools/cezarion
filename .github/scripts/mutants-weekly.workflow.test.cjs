const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const yaml = require('yaml');
const { REQUIRED_QUEUE_JOBS } = require('./queue-ci-proof.cjs');
const { RESULTS_ARTIFACT, WORKFLOW_FILE, artifactName, marker } = require('./mutants-weekly.cjs');
const { fakeGithub } = require('./mutants-github.testkit.cjs');

const root = path.resolve(__dirname, '../..');
const workflowsDir = path.join(root, '.github/workflows');
const read = name => fs.readFileSync(path.join(workflowsDir, name), 'utf8');
const source = read(WORKFLOW_FILE);
const workflow = yaml.parse(source);
// The YAML without its comments, so a header that says "write" does not count as a write scope.
const code = yaml.stringify(workflow);
const { plan, measure, report } = workflow.jobs;
const step = (job, name) => job.steps.find(item => item.name === name);
const HEAD = 'c'.repeat(40);

test('the weekly workflow says in its header that it is advisory and never blocks a merge', () => {
  const header = source.split('\n').slice(0, 12).filter(line => line.startsWith('#')).join(' ');
  assert.match(header, /Advisory/);
  assert.match(header, /never blocks a merge/);
  assert.match(header, /not measured/);
});

test('it runs on Saturday at 03:41 UTC and by hand, on the default branch only, one run at a time', () => {
  assert.deepEqual(Object.keys(workflow.on).sort(), ['schedule', 'workflow_dispatch']);
  assert.deepEqual(workflow.on.schedule, [{ cron: '41 3 * * 6' }]);
  assert.equal(plan.if, "github.ref == format('refs/heads/{0}', github.event.repository.default_branch)");
  assert.deepEqual(measure.needs, 'plan');
  assert.deepEqual(report.needs, ['plan', 'measure']);
  assert.equal(workflow.concurrency.group, 'mutants-weekly');
  assert.equal(workflow.concurrency['cancel-in-progress'], false);
});

test('only the report job has a write scope, and it runs no shell step', () => {
  assert.deepEqual(workflow.permissions, {});
  assert.deepEqual(plan.permissions, { contents: 'read' });
  assert.deepEqual(measure.permissions, { contents: 'read' });
  assert.deepEqual(report.permissions, { actions: 'read', contents: 'read', issues: 'write' });
  assert.equal((code.match(/write/g) || []).length, 1, 'one write scope');
  assert.doesNotMatch(code, /secrets\.|id-token|pull_request/);
  assert.ok(report.steps.every(item => item.run === undefined), 'no shell step in the report job');
  const checkout = report.steps[0];
  assert.equal(checkout.with.ref, '${{ github.sha }}');
  assert.equal(checkout.with['persist-credentials'], false);
});

test('every action is pinned to a full commit SHA, and every checkout drops its credentials', () => {
  for (const job of [plan, measure, report]) {
    for (const item of job.steps.filter(entry => entry.uses)) {
      assert.match(item.uses, /^[\w.-]+\/[\w.-]+@[0-9a-f]{40}$/, item.uses);
      if (item.uses.startsWith('actions/checkout@')) assert.equal(item.with['persist-credentials'], false);
    }
  }
  assert.equal(step(plan, 'Check out main with its history').with['fetch-depth'], 0);
});

test('the plan job writes the matrix and uploads the plan', () => {
  assert.equal(step(plan, 'Choose the files').run, 'node .github/scripts/mutants-weekly.cjs plan --out mutants-weekly-plan');
  assert.equal(step(plan, 'Choose the files').id, 'plan');
  for (const output of ['matrix', 'head', 'count']) assert.equal(plan.outputs[output], `\${{ steps.plan.outputs.${output} }}`);
  const upload = step(plan, 'Upload the plan');
  assert.equal(upload.with.name, 'mutants-weekly-plan');
  assert.equal(upload.with.path, 'mutants-weekly-plan/');
});

test('the measure job runs one file per matrix job at the planned head, eight at a time, with a 120 minute step limit', () => {
  assert.equal(measure.if, "needs.plan.outputs.count != '0'");
  assert.equal(measure.strategy['fail-fast'], false);
  assert.equal(measure.strategy['max-parallel'], 8);
  assert.equal(measure.strategy.matrix, '${{ fromJSON(needs.plan.outputs.matrix) }}');
  assert.equal(step(measure, 'Check out the planned head').with.ref, '${{ needs.plan.outputs.head }}');
  const run = step(measure, 'Measure the file');
  assert.equal(run['timeout-minutes'], 120);
  assert.ok(measure['timeout-minutes'] > 120 && measure['timeout-minutes'] <= 150, 'the step limit fires first');
  assert.equal(run.env.FILE, '${{ matrix.file }}');
  assert.match(run.run, /node \.github\/scripts\/mutants-file\.cjs "\$FILE" --out "\$RUNNER_TEMP\/mutants-file\/result\.json"/);
  assert.doesNotMatch(run.run, /\$\{\{/, 'the path reaches the shell through the environment only');
  const upload = step(measure, 'Upload the result');
  assert.equal(upload.if, 'always()');
  assert.equal(upload.with.name, '${{ matrix.artifact }}');
  assert.equal(upload.with['if-no-files-found'], 'ignore');
  assert.equal(upload.with['retention-days'], 90);
});

test('the report job runs after every measure outcome, reads this run\'s artifacts and keeps the combined results for 90 days', () => {
  assert.equal(report.if, "always() && needs.plan.result == 'success'");
  assert.equal(step(report, 'Download the plan').with.name, 'mutants-weekly-plan');
  const files = step(report, 'Download the results');
  assert.equal(files.with.pattern, 'mutants-weekly-file-*');
  assert.equal(files['continue-on-error'], true);
  assert.ok(artifactName('packages/cezar/src/a.ts').startsWith('mutants-weekly-file-'));
  const publish = step(report, 'Update the issues and the summary');
  assert.equal(publish.env.PLAN_DIR, step(report, 'Download the plan').with.path);
  assert.equal(publish.env.FILES_DIR, files.with.path);
  const upload = step(report, 'Upload the combined results');
  assert.equal(upload.if, 'always()');
  assert.equal(upload.with.name, RESULTS_ARTIFACT);
  assert.equal(upload.with.path, publish.env.OUT_DIR);
  assert.equal(upload.with['retention-days'], 90);
});

test('no required check, queue entry, failure reporter or other workflow depends on the weekly workflow', () => {
  const ciSource = read('ci.yml');
  assert.doesNotMatch(ciSource, /mutants-weekly|Weekly mutation/i);
  for (const name of [workflow.name, ...Object.values(workflow.jobs).map(job => job.name)]) assert.ok(!REQUIRED_QUEUE_JOBS.includes(name), name);
  for (const file of fs.readdirSync(workflowsDir).filter(name => /\.ya?ml$/.test(name))) {
    const listed = yaml.parse(read(file)).on?.workflow_run?.workflows ?? [];
    assert.ok(!listed.includes(workflow.name), `${file} must not wait for ${workflow.name}`);
  }
});

test('the publishing step drives the real script: a miss opens one issue and a re-run updates it', async t => {
  const script = step(report, 'Update the issues and the summary').with.script;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mutants-weekly-workflow-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  // A file at this checkout's head, so the deleted-file sweep leaves its issue open.
  const file = 'packages/cezar/src/task-cli/cli.ts';
  const env = { PLAN_DIR: path.join(dir, 'plan'), FILES_DIR: path.join(dir, 'files'), OUT_DIR: path.join(dir, 'out') };
  const previous = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]));
  Object.assign(process.env, env);
  t.after(() => { for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
  fs.mkdirSync(env.PLAN_DIR);
  fs.writeFileSync(path.join(env.PLAN_DIR, 'plan.json'), JSON.stringify({ version: 1, head: HEAD, since: 'x', cap: 64, cut: [], skipped: [],
    selected: [{ file, reason: 'target', lines: 0, artifact: artifactName(file) }] }));
  fs.mkdirSync(path.join(env.FILES_DIR, artifactName(file)), { recursive: true });
  fs.writeFileSync(path.join(env.FILES_DIR, artifactName(file), 'result.json'), JSON.stringify({ version: 2, file, head: HEAD, tier: 'logic', score: 50, rawScore: 50,
    counts: {}, survivors: [], guards: [], staleEquivalent: [], ambiguousEquivalent: [], multipleEquivalent: [], targets: [{ name: 'logic score', pass: false }] }));
  const github = fakeGithub();
  const core = { warning() {}, info() {}, notice() {}, summary: { addRaw() { return this; }, async write() {} } };
  const context = { repo: { owner: 'o', repo: 'r' }, runId: 9, serverUrl: 'https://github.test' };
  const AsyncFunction = (async () => {}).constructor;
  for (let run = 0; run < 2; run++) {
    await new AsyncFunction('require', 'github', 'context', 'core', 'process', script)(p => require(path.resolve(root, p)), github, context, core, process);
  }
  assert.equal(github.state.issues.length, 1);
  assert.ok(github.state.issues[0].body.startsWith(marker(file)));
  assert.deepEqual(github.state.writes, ['issue.create', 'issue.update']);
  assert.ok(fs.existsSync(path.join(env.OUT_DIR, 'results.json')));
});

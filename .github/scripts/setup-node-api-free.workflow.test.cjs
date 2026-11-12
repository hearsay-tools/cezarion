// Guards Node setup without GitHub API calls (docs/sdlc/ci.md § Node setup without GitHub API
// calls): actions/setup-node reads the actions/node-versions manifest through the GitHub API
// whenever a version is missing from the tool cache, and always for lts/* or check-latest.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const yaml = require('yaml');

const dir = path.resolve(__dirname, '../workflows');
const ACTION = '.github/actions/node-dist';
// The one job that follows lts/*: the release-candidate install leg (nightly and releases).
const LTS_JOB = 'release-candidate-tests.yml install';
// The only contents-write job, which runs no repository code (ci-squeal-results.workflow.test.cjs).
const NO_REPO_CODE = 'ci.yml squeal-publish';

const setups = fs.readdirSync(dir).filter((file) => /\.ya?ml$/.test(file)).flatMap((file) => {
  const workflow = yaml.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
  return Object.entries(workflow.jobs ?? {}).flatMap(([id, job]) => (job.steps ?? [])
    .filter((step) => step.uses?.startsWith('actions/setup-node@'))
    .map((step) => ({ name: `${file} ${id}`, job, step })));
});

const versionOf = (step) => step.with?.['node-version'] ?? step.with?.['node-version-file'];

test('every workflow sets up Node from an exact version, never lts/* or check-latest', () => {
  assert.ok(setups.length > 40, 'the scan found the workflows');
  for (const { name, step } of setups.filter(({ name }) => name !== LTS_JOB)) {
    assert.ok(versionOf(step), name);
    assert.doesNotMatch(String(versionOf(step)), /lts|latest|\*|^\d+$/, name);
    assert.equal(step.with['check-latest'], undefined, name);
  }
});

test('setup-node never gets the repository token, so a tool-cache miss spends no API quota', () => {
  for (const { name, step } of setups.filter(({ name }) => name !== LTS_JOB)) {
    assert.equal(step.with.token, '', name);
  }
  const lts = setups.find(({ name }) => name === LTS_JOB);
  assert.deepEqual(lts.job.strategy.matrix.node, ['24.21.0', 'lts/*']);
  assert.equal(lts.step.with['check-latest'], "${{ matrix.node == 'lts/*' }}");
  assert.equal(lts.step.with.token, "${{ matrix.node == 'lts/*' && github.token || '' }}");
});

test('the node-dist action installs the same exact version into the tool cache first', () => {
  for (const { name, job, step } of setups.filter(({ name }) => name !== NO_REPO_CODE)) {
    const at = job.steps.indexOf(step);
    const installs = job.steps.slice(0, at).filter((s) => s.uses?.endsWith(`/${ACTION}`));
    assert.equal(installs.length, 1, name);
    const [install] = installs;
    const version = versionOf(step);
    if (version === '${{ steps.node.outputs.node-version }}') assert.equal(install.id, 'node', name);
    else assert.equal(versionOf(install), version, name);
    if (name === LTS_JOB) assert.equal(install.if, "matrix.node != 'lts/*'");
    else assert.equal(install.if, step.if, name);
  }
  const publish = setups.find(({ name }) => name === NO_REPO_CODE);
  assert.equal(publish.job.steps.some((s) => s.uses?.endsWith(`/${ACTION}`)), false, 'the write job runs no repository code');
});

test('a checkout that holds the action precedes each node-dist step', () => {
  for (const { name, job, step } of setups.filter(({ name }) => name !== NO_REPO_CODE)) {
    const steps = job.steps.slice(0, job.steps.indexOf(step));
    const install = steps.find((s) => s.uses?.endsWith(`/${ACTION}`));
    const root = install.uses.slice(2, -ACTION.length - 1) || '.';
    const checkout = steps.slice(0, steps.indexOf(install)).filter((s) => s.uses?.startsWith('actions/checkout@'))
      .find((s) => (s.with?.path ?? '.') === root);
    assert.ok(checkout, `${name}: checks out ${root} before ${install.uses}`);
    const sparse = checkout.with?.['sparse-checkout'];
    if (sparse) assert.ok(sparse.split('\n').map((line) => line.trim()).includes(ACTION), `${name}: sparse checkout holds the action`);
  }
});

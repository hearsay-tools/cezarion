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
// A checkout of any other ref can predate the action (a merge-group base, a PR merge ref, a
// release or nightly candidate): the action then runs only when that tree holds it, and the
// previous setup-node step is the fallback.
const OWN_COMMIT = new Set([undefined, '${{ github.sha }}', '${{ github.event.merge_group.head_sha }}']);
const GUARD = "hashFiles('.github/actions/node-dist/action.yml') != ''";
const FALLBACK = "hashFiles('.github/actions/node-dist/action.yml') == ''";

const jobs = fs.readdirSync(dir).filter((file) => /\.ya?ml$/.test(file)).flatMap((file) => {
  const workflow = yaml.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
  return Object.entries(workflow.jobs ?? {}).map(([id, job]) => ({ name: `${file} ${id}`, job }));
});
const setups = jobs.flatMap(({ name, job }) => (job.steps ?? [])
  .filter((step) => step.uses?.startsWith('actions/setup-node@') && step.if !== FALLBACK)
  .map((step) => ({ name, job, step })));
const isInstall = (step) => step.uses?.endsWith(`/${ACTION}`);
const checkoutBefore = (steps, at, root) => steps.slice(0, at)
  .filter((s) => s.uses?.startsWith('actions/checkout@') && (s.with?.path ?? '.') === root).pop();
const rootOf = (install) => install.uses.slice(2, -ACTION.length - 1) || '.';

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
    const installs = job.steps.slice(0, at).filter(isInstall);
    assert.equal(installs.length, 1, name);
    const [install] = installs;
    const version = versionOf(step);
    if (version === '${{ steps.node.outputs.node-version }}') assert.equal(install.id, 'node', name);
    else assert.equal(versionOf(install), version, name);
    if (name === LTS_JOB) assert.equal(install.if, "matrix.node != 'lts/*'");
    else assert.equal(install.if, step.if, `${name}: setup-node runs exactly when the install does`);
  }
  const publish = setups.find(({ name }) => name === NO_REPO_CODE);
  assert.equal(publish.job.steps.some((s) => s.uses?.endsWith(`/${ACTION}`)), false, 'the write job runs no repository code');
});

test('a checkout that holds the action precedes each node-dist step', () => {
  for (const { name, job, step } of setups.filter(({ name }) => name !== NO_REPO_CODE)) {
    const steps = job.steps.slice(0, job.steps.indexOf(step));
    const install = steps.find(isInstall);
    const root = rootOf(install);
    const checkout = checkoutBefore(steps, steps.indexOf(install), root);
    assert.ok(checkout, `${name}: checks out ${root} before ${install.uses}`);
    const sparse = checkout.with?.['sparse-checkout'];
    if (sparse) assert.ok(sparse.split('\n').map((line) => line.trim()).includes(ACTION), `${name}: sparse checkout holds the action`);
  }
});

test('after a checkout of another commit, node-dist runs only if that tree holds it, else the previous setup', () => {
  let guarded = 0;
  for (const { name, job } of jobs) {
    const steps = job.steps ?? [];
    steps.forEach((install, at) => {
      if (!isInstall(install)) return;
      const ref = checkoutBefore(steps, at, rootOf(install))?.with?.ref;
      const setupAt = steps.findIndex((s, i) => i > at && s.uses?.startsWith('actions/setup-node@'));
      if (OWN_COMMIT.has(ref)) {
        assert.notEqual(install.if, GUARD, `${name}: the workflow's own commit holds the action`);
        assert.equal(steps.some((s) => s.if === FALLBACK), false, `${name}: no fallback after a checkout of the workflow's own commit`);
        return;
      }
      guarded += 1;
      assert.equal(rootOf(install), '.', `${name}: only the workspace checkout can predate the action`);
      assert.equal(install.if, GUARD, `${name}: node-dist runs only when ${ref} holds it`);
      assert.equal(steps[setupAt].if, GUARD, name);
      const fallbacks = steps.filter((s) => s.if === FALLBACK);
      assert.equal(fallbacks.length, 1, `${name}: one fallback`);
      const [fallback] = fallbacks;
      assert.ok(steps.indexOf(fallback) > setupAt, name);
      assert.match(fallback.uses, /^actions\/setup-node@/, name);
      assert.equal(fallback.with.token, undefined, `${name}: the fallback is the previous step, unchanged`);
      for (const key of ['cache', 'cache-dependency-path', 'registry-url', 'package-manager-cache']) {
        assert.equal(fallback.with[key], steps[setupAt].with[key], `${name}: ${key}`);
      }
    });
  }
  assert.ok(guarded >= 15, 'the merge-group base gates, PR merge refs, release and nightly candidates are guarded');
});

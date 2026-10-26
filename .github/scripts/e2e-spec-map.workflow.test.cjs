const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const yaml = require('yaml');
const { REQUIRED_QUEUE_JOBS, VERIFY, REVIEW } = require('./queue-ci-proof.cjs');

// hearsay-tools/cezarion#1816: the workflow that builds the spec map for `npm run test:e2e:affected`.
const root = path.resolve(__dirname, '../..');
const source = fs.readFileSync(path.join(root, '.github/workflows/e2e-spec-map.yml'), 'utf8');
const workflow = yaml.parse(source);
const { capture, merge } = workflow.jobs;
const step = (job, name) => job.steps.find(item => item.name === name);

test('the map refreshes on pushes to main, on demand, and on pull requests that change the capture', () => {
  assert.deepEqual(Object.keys(workflow.on), ['push', 'pull_request', 'workflow_dispatch']);
  assert.deepEqual(workflow.on.push.branches, ['main']);
  for (const pattern of ['packages/web/**', 'packages/api-client/**', 'packages/contract/**', 'pnpm-lock.yaml', '.github/workflows/e2e-spec-map.yml']) {
    assert.ok(workflow.on.push.paths.includes(pattern), pattern);
  }
  assert.deepEqual(workflow.on.pull_request.paths, ['packages/web/e2e/spec-map/**', '.github/workflows/e2e-spec-map.yml']);
  // A push run is never cancelled: concurrency coalesces waiting pushes into the newest one.
  assert.equal(workflow.concurrency['cancel-in-progress'], "${{ github.event_name == 'pull_request' }}");
});

test('the workflow is neither a required check nor part of the merge queue', () => {
  assert.equal(workflow.on.merge_group, undefined);
  assert.equal(workflow.on.pull_request_target, undefined);
  const names = Object.values(workflow.jobs).map(job => job.name.replace('${{ matrix.shard }}', '1'));
  for (const name of names) {
    assert.ok(!REQUIRED_QUEUE_JOBS.includes(name), name);
    assert.notEqual(name, VERIFY);
    assert.notEqual(name, REVIEW);
  }
  // No other workflow waits on it or calls it.
  const others = fs.readdirSync(path.join(root, '.github/workflows')).filter(name => name !== 'e2e-spec-map.yml');
  for (const name of others) {
    assert.doesNotMatch(fs.readFileSync(path.join(root, '.github/workflows', name), 'utf8'), /e2e-spec-map|E2E spec map/, name);
  }
});

test('each job reads the repository and nothing else, with pinned actions and no secrets', () => {
  assert.deepEqual(workflow.permissions, {});
  for (const job of [capture, merge]) assert.deepEqual(job.permissions, { contents: 'read' });
  assert.doesNotMatch(source, /secrets\.|id-token|github\.token|GITHUB_TOKEN|continue-on-error/);
  const actions = [capture, merge].flatMap(job => job.steps.filter(item => item.uses));
  for (const { uses } of actions) assert.match(uses, /^[\w-]+\/[\w-]+@[0-9a-f]{40}$/, uses);
  for (const checkout of actions.filter(({ uses }) => uses.startsWith('actions/checkout@'))) {
    assert.equal(checkout.with['persist-credentials'], false);
    assert.equal(checkout.with.ref, undefined, 'map the event commit, never an interpolated ref');
  }
});

test('two capture shards build evidence that the merge job validates before publishing', () => {
  assert.deepEqual(capture.strategy.matrix.shard, [1, 2]);
  assert.equal(capture.strategy['fail-fast'], false);
  const suite = step(capture, 'Run the browser suite with V8 function logs').run;
  assert.match(suite, /--config packages\/web\/e2e\/spec-map\/vitest\.config\.ts --shard="\$SHARD\/2"/);
  assert.match(suite, /--outputFile\.json="\$RUNNER_TEMP\/spec-map\/results\.json"/);
  assert.match(step(capture, 'Build the cockpit again with source maps').run, /VITE_CEZ_E2E=1 npm run build -w @open-mercato\/cezar-web -- \\\n\s+--outDir "\$RUNNER_TEMP\/spec-map\/sourcemaps" --emptyOutDir --sourcemap hidden/);
  // `partial` refuses source maps whose JavaScript differs from the served bundle.
  const partial = step(capture, 'Turn the logs into evidence').run;
  assert.match(partial, /build-map\.ts partial/);
  assert.match(partial, /--served \.ai\/qa\/build\/cezar\/web\/dist/);
  assert.match(fs.readFileSync(path.join(root, '.ai/scripts/build-e2e.sh'), 'utf8'), /OUT="\$REPO_ROOT\/\.ai\/qa\/build\/cezar"/);
  assert.equal(merge.needs, 'capture');
  const merged = step(merge, 'Merge the evidence');
  assert.equal(merged.env.COMMIT, '${{ github.sha }}');
  assert.match(merged.run, /--expect packages\/web\/src\/routes\/task-thread\/markdown\.tsx=packages\/web\/e2e\/artifact-project-links\.e2e\.ts/);
  for (const file of ['packages/web/e2e/spec-map/build-map.ts', 'packages/web/e2e/spec-map/vitest.config.ts', 'packages/web/src/routes/task-thread/markdown.tsx', 'packages/web/e2e/artifact-project-links.e2e.ts']) {
    assert.ok(fs.existsSync(path.join(root, file)), file);
  }
  const upload = step(merge, 'Upload the spec map');
  assert.equal(upload.with.name, 'e2e-spec-map');
  assert.equal(upload.with['if-no-files-found'], 'error');
  assert.match(upload.with.path, /\/e2e-spec-map\.json$/);
  // The selector downloads this artifact by workflow file and artifact name.
  const selector = fs.readFileSync(path.join(root, 'scripts/e2e-affected.mjs'), 'utf8');
  assert.match(selector, /const WORKFLOW = 'e2e-spec-map\.yml';/);
  assert.match(selector, /const ARTIFACT = 'e2e-spec-map';/);
});

function runStep(run, files, extraPath) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cez-spec-map-workflow-'));
  try {
    for (const [file, text] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
      fs.writeFileSync(path.join(dir, file), text, { mode: 0o755 });
    }
    const PATH = extraPath ? `${path.join(dir, 'bin')}:${process.env.PATH}` : process.env.PATH;
    return spawnSync('bash', ['-e', '-o', 'pipefail', '-c', run], {
      cwd: dir, env: { ...process.env, PATH, SHARD: '1', RUNNER_TEMP: dir }, encoding: 'utf8', timeout: 10_000,
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('failing specs do not stop the capture: their evidence is marked incomplete', () => {
  const run = step(capture, 'Run the browser suite with V8 function logs').run;
  const result = runStep(run, { 'bin/npm': '#!/bin/sh\necho "1 failed"\nexit 1\n' }, true);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /The browser suite exited 1\./);
});

test('the capture stops when the test environment has no browser', () => {
  const run = step(capture, 'Boot the test environment').run;
  const boot = '#!/bin/sh\nexit 0\n';
  const descriptor = installed => JSON.stringify({ browser: { installed, notes: 'no Chrome here' } });
  const without = runStep(run, { '.ai/scripts/test-env-up.sh': boot, '.ai/qa/test-env.json': descriptor(false) });
  assert.equal(without.status, 1);
  assert.match(without.stderr, /no Chrome here/);
  const withBrowser = runStep(run, { '.ai/scripts/test-env-up.sh': boot, '.ai/qa/test-env.json': descriptor(true) });
  assert.equal(withBrowser.status, 0, withBrowser.stderr);
});

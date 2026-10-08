const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { runInNewContext } = require('node:vm');
const yaml = require('yaml');

const root = path.resolve(__dirname, '../..');
const source = fs.readFileSync(path.join(root, '.github/workflows/transcript-facts-responsiveness.yml'), 'utf8');
const workflow = yaml.parse(source);
const job = workflow.jobs['strict-timing'];
const step = id => job.steps.find(item => item.id === id);
const probes = {
  lag: ['--expose-gc', '--import', 'tsx', 'packages/cezar/scripts/measure-transcript-facts-lag.mjs'],
  health: ['--expose-gc', 'packages/cezar/scripts/measure-transcript-facts-health.mjs'],
};

test('new PR workflow runs drafts with read-only permissions and pinned safe actions', () => {
  assert.deepEqual(Object.keys(workflow.on), ['pull_request']);
  assert.deepEqual(workflow.permissions, { contents: 'read' });
  assert.equal(job.if, undefined);
  assert.equal(job.permissions, undefined);
  assert.equal(job['runs-on'], 'ubuntu-24.04');
  assert.equal(job['timeout-minutes'], 15);
  assert.doesNotMatch(source, /pull_request\.draft|secrets\.|id-token|continue-on-error/);
  const actions = job.steps.filter(item => item.uses);
  assert.deepEqual(actions.map(item => item.uses), [
    'actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1',
    'actions/setup-node@820762786026740c76f36085b0efc47a31fe5020',
    'actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02',
  ]);
  assert.equal(actions[0].with['persist-credentials'], false);
  assert.equal(actions[0].with.ref, undefined, 'test the PR merge revision, not untrusted shell interpolation');
  assert.equal(actions[1].with['node-version'], '24.20.0');
  assert.equal(actions[2].if, 'always()');
  assert.equal(actions[2].with.path, 'timing-evidence/');
  assert.equal(actions[2].with['retention-days'], 14);
});

test('setup completes before serial probes; health still runs after lag failure only with a built runtime', () => {
  assert.equal(job.strategy, undefined);
  assert.deepEqual(job.steps.filter(item => item.run).map(item => item.id ?? item.run), [
    'evidence', 'npm ci', 'build', 'lag', 'health',
  ]);
  assert.equal(step('build').run, 'npm run build:server');
  assert.equal(step('lag').if, undefined);
  for (const id of Object.keys(probes)) {
    assert.equal(step(id)['timeout-minutes'], 2);
    assert.ok(fs.existsSync(path.join(root, probes[id].at(-1))));
  }
  const expression = step('health').if.slice(3, -2);
  for (const [cancelled, build, evidence, expected] of [
    [false, 'success', 'success', true], [false, 'failure', 'success', false],
    [false, 'skipped', 'success', false], [false, 'success', 'failure', false],
    [true, 'success', 'success', false],
  ]) {
    assert.equal(runInNewContext(expression, { cancelled: () => cancelled,
      steps: { build: { outcome: build }, evidence: { outcome: evidence }, lag: { outcome: 'failure' } } }), expected);
  }
});

// Execute the actual shell blocks with a fake probe, never the expensive timing
// scripts: both a success and a failure must preserve every byte and exact status.
for (const [id, args] of Object.entries(probes)) for (const status of [0, 7]) {
  test(`${id} preserves raw output and exits ${status} without hiding the probe result`, () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cez-timing-workflow-'));
    try {
      fs.mkdirSync(path.join(dir, 'timing-evidence'));
      fs.writeFileSync(path.join(dir, 'node'), `#!/bin/sh\nprintf '%s\\n' "$@" > invoked-args.txt\nprintf '%s\\n' '{"samples":[1,2,3],"histories":700}'\nprintf '%s\\n' 'raw diagnostic' >&2\nexit ${status}\n`, { mode: 0o755 });
      const result = spawnSync('bash', ['-e', '-o', 'pipefail', '-c', step(id).run], {
        cwd: dir, env: { ...process.env, PATH: `${dir}:${process.env.PATH}` }, encoding: 'utf8', timeout: 5_000,
      });
      assert.equal(result.status, status, result.stderr);
      assert.deepEqual(fs.readFileSync(path.join(dir, 'invoked-args.txt'), 'utf8').trim().split('\n'), args);
      const read = suffix => fs.readFileSync(path.join(dir, 'timing-evidence', `${id}.${suffix}`), 'utf8');
      assert.equal(read('json'), '{"samples":[1,2,3],"histories":700}\n');
      assert.equal(read('stderr'), 'raw diagnostic\n');
      assert.equal(read('exit-code.txt'), `${status}\n`);
      assert.match(read('started-at.txt'), /^\d{4}-\d\d-\d\dT/);
      assert.match(read('finished-at.txt'), /^\d{4}-\d\d-\d\dT/);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
}

test('evidence records actual checkout SHA, Node version and exact measured commands', () => {
  assert.match(step('evidence').run, /git rev-parse HEAD > timing-evidence\/revision.txt/);
  assert.match(step('evidence').run, /node --version > timing-evidence\/node-version.txt/);
  for (const args of Object.values(probes)) assert.ok(step('evidence').run.includes(`node ${args.join(' ')}`));
});

'use strict';

// Guards Squeal shared results (hearsay-tools/squeal spec 018 D17): merge-group Vitest shards run
// their unchanged command under `squeal ci record`, and an optional job publishes refs/squeal/<sha>.
// A Squeal gate trial dispatch records too (ci-squeal-gate-trial.workflow.test.cjs).
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { runInNewContext } = require('node:vm');
const yaml = require('yaml');

const repoRoot = path.join(__dirname, '..', '..');
const ci = () => yaml.parse(fs.readFileSync(path.join(repoRoot, '.github', 'workflows', 'ci.yml'), 'utf8'));
const EVENTS = ['pull_request_target', 'workflow_dispatch', 'merge_group', 'push'];
const step = (job, id) => job.steps.find((s) => s.id === id || s.name === id);
// Squeal's GitHub Action (hearsay-tools/squeal spec 018 D20) puts `squeal` on the PATH and never
// fails the job. Like every action here it is pinned to a full commit SHA; the comment names its
// release tag.
const SQUEAL_ACTION = 'hearsay-tools/squeal/ci@6a7b41c08d5b2d27412cad1b1c139e65144876e6';
const SQUEAL_PIN = `uses: ${SQUEAL_ACTION} # v0.1.460`;

function expression(raw, context) {
  const code = String(raw).replace(/^\$\{\{\s*|\s*\}\}$/g, '').replace(/needs\.([\w]+-[\w-]+)/g, "needs['$1']");
  return runInNewContext(code, context);
}

function context(event, { vitest = 'success', exported = 'success', trial = false, pr = '' } = {}) {
  return {
    github: { event_name: event },
    inputs: { pr_number: pr, squeal_gate_trial: trial },
    needs: {
      vitest: { result: vitest },
      'squeal-export': { result: exported },
    },
    cancelled: () => false,
  };
}

// The step's script with its expressions resolved for one shard of one event.
function script(run, event, shard) {
  return run.replace(/\$\{\{.*?\}\}/g, (raw) => raw.includes('matrix.shard') && !raw.includes('&&') ? String(shard) : expression(raw, context(event)));
}

test('the Vitest shards and the Squeal jobs read one exact Node version from .node-version', () => {
  const version = fs.readFileSync(path.join(repoRoot, '.node-version'), 'utf8');
  assert.match(version, /^\d+\.\d+\.\d+\n$/, 'one exact version, no range or alias');
  const [major, minor] = version.split('.').map(Number);
  const floor = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8')).engines.node.slice(2).split('.').map(Number);
  assert.ok(major > floor[0] || (major === floor[0] && minor >= floor[1]), 'at or above the engines floor');
  const { jobs } = ci();
  const readers = Object.entries(jobs).filter(([, job]) => (job.steps ?? []).some((s) => s.with?.['node-version-file']))
    .map(([id]) => id);
  assert.deepEqual(readers.sort(), ['squeal-coverage-proof', 'squeal-export', 'squeal-gate-trial', 'squeal-package-trial', 'squeal-publish', 'vitest'], 'other jobs keep their own Node setting');
  for (const id of readers) {
    const setup = jobs[id].steps.find((s) => s.uses?.startsWith('actions/setup-node@'));
    assert.equal(setup.with['node-version-file'], '.node-version', id);
    assert.equal(setup.with['node-version'], undefined, id);
  }
});

test('merge groups and Squeal gate trial dispatches run the shard under squeal ci record; every other run as before', () => {
  const vitest = ci().jobs.vitest;
  const collect = step(vitest, 'collect');
  const record = step(vitest, 'record');
  const recorded = ['Set up Squeal', 'record', 'Upload Squeal parts'].map((id) => step(vitest, id));
  // [event, inputs, recorded]: only a dispatch with squeal_gate_trial and no pr_number takes the trial.
  const runs = [...EVENTS.map((event) => [event, {}, event === 'merge_group']),
    ['workflow_dispatch', { trial: true }, true], ['workflow_dispatch', { trial: true, pr: '42' }, false],
    ['workflow_dispatch', { trial: 'true' }, false], ['pull_request_target', { trial: true }, false]];
  for (const [event, inputs, recording] of runs) {
    const ctx = context(event, inputs);
    const name = `${event} ${JSON.stringify(inputs)}`;
    assert.equal(expression(collect.if, ctx), event !== 'pull_request_target' && !recording, `${name} collect`);
    for (const s of recorded) assert.equal(expression(s.if, ctx), recording, `${name} ${s.name}`);
  }
  assert.equal(record.env.VITEST_FILE_DURATION_CAP, collect.env.VITEST_FILE_DURATION_CAP);
  // Test failures block: a merge group continues past them only to its rerun, which blocks
  // (ci-queue-rerun.workflow.test.cjs); a trial dispatch never continues.
  for (const [event, inputs] of runs) {
    assert.equal(expression(record['continue-on-error'], context(event, inputs)), event === 'merge_group', `${event} ${JSON.stringify(inputs)}`);
  }
  assert.equal(step(vitest, 'Set up Squeal').uses, SQUEAL_ACTION);
  // The recorded command is the shard command without its own V8 coverage, which only the plain
  // command adds: Squeal's provider yields to a project's coverage (squeal spec 020 D13.1).
  const command = record.run.split('\n')[0];
  const COVERAGE = " ${{ (github.event_name == 'pull_request_target' || github.event_name == 'workflow_dispatch') && '--coverage.enabled' || '' }}";
  assert.equal(command, 'set -- npm test -- --shard=${{ matrix.shard }}/8 --maxWorkers=4');
  assert.equal(`set -- ${collect.run}`, `${command}${COVERAGE}`);
  const upload = step(vitest, 'Upload Squeal parts');
  assert.equal(upload['continue-on-error'], true);
  assert.equal(upload.with.name, 'squeal-parts-shard-${{ matrix.shard }}');
  // The first run's parts, unless a merge-group rerun recorded its own (ci-queue-rerun.workflow.test.cjs).
  assert.equal(upload.with.path, "${{ runner.temp }}/${{ steps.rerun.outcome == 'skipped' && 'squeal-parts' || 'squeal-parts-rerun' }}/");
  assert.equal(record.env.PARTS_DIR, 'squeal-parts');
  assert.equal(upload.with['retention-days'], 3);
  // A shard whose tests failed still uploads its parts: the condition carries its own status
  // function, so GitHub adds no success() (cezarion#3264 review). It reads no setup step: when
  // Squeal cannot run, the action passes the command through and there are no parts to upload.
  assert.doesNotMatch(upload.if, /steps\./);
  assert.match(String(upload.if), /^!cancelled\(\) && /);
});

test('the merge-group step runs the test command under squeal ci record and returns its exit code and output', () => {
  const record = step(ci().jobs.vitest, 'record');
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'ci-squeal-record-'));
  try {
    const bin = path.join(temp, 'bin');
    fs.mkdirSync(bin);
    // `squeal ci record` returns the command's code, as the action's pass-through does when Squeal cannot run.
    fs.writeFileSync(path.join(bin, 'squeal'), '#!/bin/sh\necho "squeal $*"\nwhile [ "$1" != -- ]; do shift; done\nshift\nexec "$@"\n', { mode: 0o755 });
    fs.writeFileSync(path.join(bin, 'npm'), '#!/bin/sh\necho "npm $*"\nexit 3\n', { mode: 0o755 });
    const run = (event) => spawnSync('bash', ['-e', '-c', script(record.run, event, 2)], {
      encoding: 'utf8', env: { PATH: `${bin}:/usr/bin:/bin`, RUNNER_TEMP: '/runner/temp', PARTS_DIR: record.env.PARTS_DIR },
    });
    const recorded = run('merge_group');
    assert.equal(recorded.status, 3, 'the step\'s exit code is the command\'s');
    assert.equal(recorded.stdout, 'squeal ci record --out /runner/temp/squeal-parts -- npm test -- --shard=2/8 --maxWorkers=4\n'
      + 'npm test -- --shard=2/8 --maxWorkers=4\n');
    // A trial dispatch records the same command, with no --coverage.enabled for Squeal's provider to yield to.
    assert.equal(run('workflow_dispatch').stdout, recorded.stdout);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

// The coverage proof (ci-squeal-coverage-proof.workflow.test.cjs) and the packaged test trial
// (ci-squeal-package-trial.workflow.test.cjs) run only on a manual dispatch, and gate nothing either.
const SQUEAL_JOBS = ['squeal-export', 'squeal-publish', 'squeal-gate-trial', 'squeal-coverage-proof', 'squeal-coverage-proof-compare',
  'squeal-package-trial'];

test('squeal-export runs after passing merge-group shards and only reads', () => {
  const { jobs, permissions } = ci();
  const job = jobs['squeal-export'];
  assert.deepEqual(job.needs, ['vitest']);
  for (const event of EVENTS) assert.equal(expression(job.if, context(event)), event === 'merge_group', event);
  for (const vitest of ['failure', 'skipped', 'cancelled']) assert.equal(expression(job.if, context('merge_group', { vitest })), false, vitest);
  assert.equal(expression(job.if, context('merge_group')), true);
  assert.deepEqual(job.permissions, { contents: 'read' });
  assert.deepEqual(permissions, { contents: 'read' });
  const checkout = job.steps.find((s) => s.uses?.startsWith('actions/checkout@'));
  assert.equal(checkout.with.ref, '${{ github.event.merge_group.head_sha }}');
  assert.equal(checkout.with['persist-credentials'], false);
});

test('squeal-publish alone writes contents, after the export, and runs no repository code', () => {
  const { jobs } = ci();
  const job = jobs['squeal-publish'];
  assert.deepEqual(job.needs, ['squeal-export']);
  for (const event of EVENTS) assert.equal(expression(job.if, context(event)), event === 'merge_group', event);
  for (const exported of ['failure', 'skipped', 'cancelled']) {
    assert.equal(expression(job.if, context('merge_group', { exported })), false, exported);
  }
  // Without a status function GitHub adds success(), which a skipped job further up
  // (pr-test-input in a merge group) makes false: the publish was skipped in run 42843943744.
  assert.match(String(job.if), /!cancelled\(\)/, 'the condition carries its own status function');
  assert.deepEqual(job.permissions, { contents: 'write' });
  for (const [id, other] of Object.entries(jobs)) {
    if (id !== 'squeal-publish') assert.notEqual(other.permissions?.contents, 'write', `${id} writes contents`);
  }
  const checkout = job.steps.find((s) => s.uses?.startsWith('actions/checkout@'));
  assert.equal(checkout.with.ref, '${{ github.event.merge_group.head_sha }}');
  assert.equal(checkout.with['fetch-depth'], 0, 'pruning places refs on the first-parent line');
  assert.equal(checkout.with['persist-credentials'], false, 'no token on disk');
  assert.deepEqual(job.steps.map((s) => s.uses?.split('@')[0]).filter(Boolean),
    ['actions/checkout', 'actions/setup-node', 'hearsay-tools/squeal/ci', 'actions/download-artifact']);
  assert.equal(job.steps.find((s) => s.uses?.startsWith('actions/setup-node@')).with['package-manager-cache'], false);
  for (const s of job.steps.filter((s) => s.run)) {
    assert.doesNotMatch(s.run, /\b(npm|pnpm|npx|yarn|corepack)\b|build|\.\/|node_modules/, `${s.name} runs repository code`);
    assert.doesNotMatch(s.run, /^\s*node\b/m, `${s.name} runs a script outside Squeal's action`);
  }
  // The token reaches only the publish step, as git configuration in its environment.
  const tokened = Object.entries(jobs).flatMap(([id, other]) => (other.steps ?? []).map((s) => ({ id, s })))
    .filter(({ id, s }) => SQUEAL_JOBS.includes(id) && /github\.token|secrets\./.test(JSON.stringify(s)));
  assert.deepEqual(tokened.map(({ s }) => s.name), ['Publish Squeal results']);
  assert.deepEqual(Object.keys(step(job, 'Publish Squeal results').env), ['GH_TOKEN']);
});

test('the publish step hands git the token as an extra header and masks it', () => {
  const publish = step(ci().jobs['squeal-publish'], 'Publish Squeal results');
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'ci-squeal-publish-'));
  try {
    fs.writeFileSync(path.join(temp, 'squeal'), '#!/bin/sh\necho "count=$GIT_CONFIG_COUNT key=$GIT_CONFIG_KEY_0 value=$GIT_CONFIG_VALUE_0 args=$*"\nexit 4\n', { mode: 0o755 });
    const result = spawnSync('bash', ['-e', '-c', publish.run], {
      encoding: 'utf8', env: { PATH: `${temp}:/usr/bin:/bin`, RUNNER_TEMP: '/runner/temp', GH_TOKEN: 'tok' },
    });
    const basic = Buffer.from('x-access-token:tok').toString('base64');
    assert.equal(result.status, 4, 'the publish exit code is the step\'s');
    assert.equal(result.stdout, `::add-mask::${basic}\ncount=1 key=http.https://github.com/.extraheader value=AUTHORIZATION: basic ${basic} `
      + 'args=ci publish /runner/temp/squeal-results/squeal-results.json.gz --keep 100\n');
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test('the Squeal jobs never gate a merge', () => {
  const { jobs } = ci();
  const { REQUIRED_QUEUE_JOBS } = require('./queue-ci-proof.cjs');
  for (const id of SQUEAL_JOBS) {
    for (const [other, job] of Object.entries(jobs)) {
      if (!SQUEAL_JOBS.includes(other)) assert.equal([job.needs ?? []].flat().includes(id), false, `${other} needs ${id}`);
    }
    assert.equal(jobs.verify.needs.includes(id), false);
    assert.equal(REQUIRED_QUEUE_JOBS.includes(jobs[id].name), false);
  }
});

test('squeal-export keys the shard parts in a fresh checkout; squeal-publish pushes that export', () => {
  const { jobs } = ci();
  const others = new Set(Object.entries(jobs).filter(([id]) => !SQUEAL_JOBS.includes(id))
    .flatMap(([, other]) => (other.steps ?? []).map((s) => s.uses?.split(' ')[0])).filter(Boolean));
  for (const id of SQUEAL_JOBS) {
    for (const s of jobs[id].steps.filter((s) => s.uses)) {
      assert.match(s.uses, /@[0-9a-f]{40}( |$)/, s.uses);
      assert.ok(others.has(s.uses.split(' ')[0]), `${s.uses} matches the pin the rest of ci.yml uses`);
    }
    for (const s of jobs[id].steps) if (s.run) assert.equal(/\$\{\{/.test(s.run), false, `${id} ${s.name}: no expression in a script`);
  }
  const job = jobs['squeal-export'];
  assert.equal(job.steps.find((s) => s.uses?.startsWith('pnpm/action-setup@')).with.version, '12.11.2');
  const runs = job.steps.map((s) => s.run).filter(Boolean);
  assert.ok(runs.includes('pnpm install --frozen-lockfile'));
  const builds = (j) => j.steps.some((s) => s.run === 'npm run build:server');
  assert.equal(builds(job), builds(jobs.vitest), 'the export checkout holds what the shards read');
  assert.equal(runs.some((run) => /npm (test|run test)|vitest run/.test(run)), false, 'the job runs no test command');
  const pattern = step(job, 'Download Squeal parts').with.pattern;
  assert.equal(pattern, 'squeal-parts-shard-*');
  // `squeal ci export` refuses parts that lack a shard of their count, so the download takes every matrix shard's parts.
  const uploaded = step(jobs.vitest, 'Upload Squeal parts').with.name;
  const parts = jobs.vitest.strategy.matrix.shard.map((n) => uploaded.replace('${{ matrix.shard }}', String(n)));
  assert.equal(parts.length, 8);
  assert.deepEqual(parts.filter((name) => !name.startsWith(pattern.slice(0, -1))), []);
  assert.match(step(job, 'Export Squeal results').run,
    /^squeal ci export --parts "\$RUNNER_TEMP"\/squeal-parts\/squeal-parts-shard-\* --out "\$RUNNER_TEMP\/squeal-results\.json\.gz"$/);
  const upload = step(job, 'Upload Squeal results');
  assert.equal(upload.with.path, '${{ runner.temp }}/squeal-results.json.gz');
  assert.equal(upload.with['retention-days'], 3);
  const download = step(jobs['squeal-publish'], 'Download Squeal results');
  assert.equal(download.with.name, upload.with.name);
  assert.equal(download.with.path, '${{ runner.temp }}/squeal-results');
});

test('every job that runs squeal sets up Squeal\'s pinned action once, after its Node and before the first squeal call', () => {
  const { jobs } = ci();
  const text = fs.readFileSync(path.join(repoRoot, '.github', 'workflows', 'ci.yml'), 'utf8');
  assert.doesNotMatch(text, /squeal\.mjs|SQUEAL_TAG|SQUEAL_COMMIT|SQUEAL_FETCHED|steps\.squeal\b|hearsay-tools\/squeal\.git/, 'no clone of a Squeal release');
  // One pin for the whole workflow: an exact commit with its release tag in the comment.
  const pins = text.match(/^\s*uses: hearsay-tools\/squeal\/ci@.*$/gm);
  assert.ok(pins.length > 0);
  for (const pin of pins) assert.equal(pin.trim(), SQUEAL_PIN);
  const users = Object.entries(jobs).filter(([, job]) => (job.steps ?? []).some((s) => /(^|\s)squeal (ci|code)\b/m.test(s.run ?? '')))
    .map(([id]) => id);
  assert.deepEqual(users.sort(), ['squeal-coverage-proof', 'squeal-export', 'squeal-gate-trial', 'squeal-package-trial', 'squeal-publish', 'vitest']);
  for (const [id, job] of Object.entries(jobs)) {
    const { steps = [] } = job;
    const action = steps.filter((s) => s.uses?.startsWith('hearsay-tools/squeal/'));
    if (!users.includes(id)) {
      assert.deepEqual(action, [], `${id} runs no squeal`);
      continue;
    }
    assert.equal(action.length, 1, `${id}: one Squeal action step`);
    assert.equal(action[0].name, 'Set up Squeal', id);
    assert.equal(action[0].uses, SQUEAL_ACTION, id);
    assert.equal(action[0].with, undefined, `${id}: the action takes no inputs`);
    const at = steps.indexOf(action[0]);
    // The action runs Squeal with the Node on the PATH, so it comes after setup-node.
    assert.ok(steps.findIndex((s) => s.uses?.startsWith('actions/setup-node@')) < at, `${id}: after setup-node`);
    const first = steps.findIndex((s) => /(^|\s)squeal (ci|code)\b/m.test(s.run ?? ''));
    assert.ok(first > at, `${id}: before the first squeal call`);
  }
});

test('squeal.config.json reads the shared results ref squeal-publish writes', () => {
  const config = JSON.parse(fs.readFileSync(path.join(repoRoot, 'squeal.config.json'), 'utf8'));
  assert.deepEqual(config.shared, { ref: 'refs/squeal' });
});

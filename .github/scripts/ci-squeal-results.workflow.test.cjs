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

function expression(raw, context) {
  const code = String(raw).replace(/^\$\{\{\s*|\s*\}\}$/g, '').replace(/needs\.([\w]+-[\w-]+)/g, "needs['$1']");
  return runInNewContext(code, context);
}

function context(event, { vitest = 'success', proof = 'success', verified = 'false', exported = 'success', trial = false, pr = '' } = {}) {
  return {
    github: { event_name: event },
    inputs: { pr_number: pr, squeal_gate_trial: trial },
    needs: {
      vitest: { result: vitest },
      'pr-test-proof': { result: proof, outputs: { verified } },
      'squeal-export': { result: exported },
    },
    steps: { squeal: { outcome: 'success' } },
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
  assert.deepEqual(readers.sort(), ['squeal-export', 'squeal-gate-trial', 'squeal-publish', 'vitest'], 'other jobs keep their own Node setting');
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
  const recorded = ['squeal', 'record', 'Upload Squeal parts'].map((id) => step(vitest, id));
  // [event, inputs, recorded]: only a dispatch with squeal_gate_trial and no pr_number takes the trial.
  const runs = [...EVENTS.map((event) => [event, {}, event === 'merge_group']),
    ['workflow_dispatch', { trial: true }, true], ['workflow_dispatch', { trial: true, pr: '42' }, false],
    ['workflow_dispatch', { trial: 'true' }, false], ['pull_request_target', { trial: true }, false]];
  for (const [event, inputs, recording] of runs) {
    for (const [proof, verified] of [['success', 'false'], ['failure', ''], ['success', 'true']]) {
      const ctx = context(event, { proof, verified, ...inputs });
      const reused = proof === 'success' && verified === 'true';
      const name = `${event} ${JSON.stringify(inputs)}`;
      assert.equal(expression(collect.if, ctx), !reused && !recording, `${name} collect`);
      for (const s of recorded) assert.equal(expression(s.if, ctx), !reused && recording, `${name} ${s.name}`);
    }
  }
  assert.equal(record.env.VITEST_FILE_DURATION_CAP, collect.env.VITEST_FILE_DURATION_CAP);
  assert.equal(record['continue-on-error'], undefined, 'test failures must block');
  assert.equal(step(vitest, 'squeal')['continue-on-error'], true, 'a failed fetch must not fail the shard');
  // The recorded command is the shard command without its own V8 coverage, which only the plain
  // command adds: Squeal's provider yields to a project's coverage (squeal spec 020 D13.1).
  const command = record.run.split('\n')[0];
  const COVERAGE = " ${{ (github.event_name == 'pull_request_target' || github.event_name == 'workflow_dispatch') && '--coverage.enabled' || '' }}";
  assert.equal(command, 'set -- npm test -- --shard=${{ matrix.shard }}/4 --maxWorkers=4');
  assert.equal(`set -- ${collect.run}`, `${command}${COVERAGE}`);
  const upload = step(vitest, 'Upload Squeal parts');
  assert.equal(upload['continue-on-error'], true);
  assert.equal(upload.with.name, 'squeal-parts-shard-${{ matrix.shard }}');
  assert.equal(upload.with.path, '${{ runner.temp }}/squeal-parts/');
  assert.equal(upload.with['retention-days'], 3);
  assert.match(upload.if, /steps\.squeal\.outcome == 'success'/);
  // A shard whose tests failed still uploads its parts: the condition carries its own status
  // function, so GitHub adds no success() (cezarion#3264 review).
  assert.match(String(upload.if), /^!cancelled\(\) && /);
});

test('the merge-group step returns the test command\'s exit code and output, recorded or not', () => {
  const record = step(ci().jobs.vitest, 'record');
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'ci-squeal-record-'));
  try {
    const bin = path.join(temp, 'bin');
    fs.mkdirSync(bin);
    for (const [name, code] of [['node', 7], ['npm', 3]]) {
      fs.writeFileSync(path.join(bin, name), `#!/bin/sh\necho "${name} $*"\nexit ${code}\n`, { mode: 0o755 });
    }
    const run = (fetched) => spawnSync('bash', ['-e', '-c', script(record.run, 'merge_group', 2)], {
      encoding: 'utf8',
      env: { PATH: `${bin}:/usr/bin:/bin`, RUNNER_TEMP: '/runner/temp', SQUEAL_FETCHED: fetched },
    });
    const recorded = run('success');
    assert.equal(recorded.status, 7, 'squeal ci record returns the command\'s code');
    assert.equal(recorded.stdout.trim(), 'node /runner/temp/squeal/plugins/claude-code/dist/cli/squeal.mjs ci record --out /runner/temp/squeal-parts -- npm test -- --shard=2/4 --maxWorkers=4');
    const plain = run('failure');
    assert.equal(plain.status, 3);
    assert.match(plain.stdout, /::warning title=Squeal release not fetched::Shard 2\/4/);
    assert.match(plain.stdout, /^npm test -- --shard=2\/4 --maxWorkers=4$/m);
    // A trial dispatch records the same command, with no --coverage.enabled for Squeal's provider to yield to.
    const trial = spawnSync('bash', ['-e', '-c', script(record.run, 'workflow_dispatch', 2)], {
      encoding: 'utf8', env: { PATH: `${bin}:/usr/bin:/bin`, RUNNER_TEMP: '/runner/temp', SQUEAL_FETCHED: 'success' },
    });
    assert.equal(trial.stdout, recorded.stdout);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

const SQUEAL_JOBS = ['squeal-export', 'squeal-publish', 'squeal-gate-trial'];

test('squeal-export runs after passing merge-group shards and only reads', () => {
  const { jobs, permissions } = ci();
  const job = jobs['squeal-export'];
  assert.deepEqual(job.needs, ['vitest', 'pr-test-proof']);
  for (const event of EVENTS) assert.equal(expression(job.if, context(event)), event === 'merge_group', event);
  for (const vitest of ['failure', 'skipped', 'cancelled']) assert.equal(expression(job.if, context('merge_group', { vitest })), false, vitest);
  assert.equal(expression(job.if, context('merge_group', { verified: 'true' })), false, 'reused shards record nothing');
  assert.equal(expression(job.if, context('merge_group', { proof: 'skipped', verified: '' })), true);
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
    ['actions/checkout', 'actions/setup-node', 'actions/download-artifact']);
  assert.equal(job.steps.find((s) => s.uses?.startsWith('actions/setup-node@')).with['package-manager-cache'], false);
  for (const s of job.steps.filter((s) => s.run)) {
    assert.doesNotMatch(s.run, /\b(npm|pnpm|npx|yarn|corepack)\b|build|\.\/|node_modules/, `${s.name} runs repository code`);
    assert.doesNotMatch(s.run, /^\s*node (?!"\$RUNNER_TEMP\/squeal\/)/m, `${s.name} runs a script outside the Squeal release`);
  }
  // The token reaches only the publish step, as git configuration in its environment.
  const tokened = Object.entries(jobs).flatMap(([id, other]) => (other.steps ?? []).map((s) => ({ id, s })))
    .filter(({ id, s }) => SQUEAL_JOBS.includes(id) && /github\.token|secrets\./.test(JSON.stringify(s)));
  assert.deepEqual(tokened.map(({ s }) => s.name), ['Publish Squeal results']);
  assert.deepEqual(Object.keys(step(job, 'Publish Squeal results').env), ['GH_TOKEN']);
  assert.match(step(job, 'Publish Squeal results').run,
    /squeal\.mjs" ci publish "\$RUNNER_TEMP\/squeal-results\/squeal-results\.json\.gz" --keep 100$/m);
});

test('the publish step hands git the token as an extra header and masks it', () => {
  const publish = step(ci().jobs['squeal-publish'], 'Publish Squeal results');
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'ci-squeal-publish-'));
  try {
    fs.writeFileSync(path.join(temp, 'node'), '#!/bin/sh\necho "count=$GIT_CONFIG_COUNT key=$GIT_CONFIG_KEY_0 value=$GIT_CONFIG_VALUE_0 args=$*"\nexit 4\n', { mode: 0o755 });
    const result = spawnSync('bash', ['-e', '-c', publish.run], {
      encoding: 'utf8', env: { PATH: `${temp}:/usr/bin:/bin`, RUNNER_TEMP: '/runner/temp', GH_TOKEN: 'tok' },
    });
    const basic = Buffer.from('x-access-token:tok').toString('base64');
    assert.equal(result.status, 4, 'the publish exit code is the step\'s');
    assert.equal(result.stdout, `::add-mask::${basic}\ncount=1 key=http.https://github.com/.extraheader value=AUTHORIZATION: basic ${basic} `
      + 'args=/runner/temp/squeal/plugins/claude-code/dist/cli/squeal.mjs ci publish /runner/temp/squeal-results/squeal-results.json.gz --keep 100\n');
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
    const vitestFetch = step(jobs.vitest, 'squeal');
    const fetch = step(jobs[id], 'Fetch the Squeal release');
    assert.deepEqual(fetch.env, vitestFetch.env, `${id}: one Squeal release for record, export and publish`);
    assert.equal(fetch.run, vitestFetch.run);
    for (const s of jobs[id].steps) if (s.run) assert.equal(/\$\{\{/.test(s.run), false, `${id} ${s.name}: no expression in a script`);
  }
  const fetch = step(jobs.vitest, 'squeal');
  assert.match(fetch.env.SQUEAL_COMMIT, /^[0-9a-f]{40}$/);
  assert.match(fetch.run, /rev-parse HEAD\)" = "\$SQUEAL_COMMIT"/);
  const job = jobs['squeal-export'];
  assert.equal(job.steps.find((s) => s.uses?.startsWith('pnpm/action-setup@')).with.version, '12.11.2');
  const runs = job.steps.map((s) => s.run).filter(Boolean);
  assert.ok(runs.includes('pnpm install --frozen-lockfile'));
  assert.ok(runs.includes('npm run build:server'), 'the export checkout holds what the shards read');
  assert.equal(runs.some((run) => /npm (test|run test)|vitest run/.test(run)), false, 'the job runs no test command');
  assert.equal(step(job, 'Download Squeal parts').with.pattern, 'squeal-parts-shard-*');
  assert.match(step(job, 'Export Squeal results').run,
    /squeal\.mjs" ci export --parts "\$RUNNER_TEMP"\/squeal-parts\/squeal-parts-shard-\* --out "\$RUNNER_TEMP\/squeal-results\.json\.gz"$/);
  const upload = step(job, 'Upload Squeal results');
  assert.equal(upload.with.path, '${{ runner.temp }}/squeal-results.json.gz');
  assert.equal(upload.with['retention-days'], 3);
  const download = step(jobs['squeal-publish'], 'Download Squeal results');
  assert.equal(download.with.name, upload.with.name);
  assert.equal(download.with.path, '${{ runner.temp }}/squeal-results');
});

test('squeal.config.json reads the shared results ref squeal-publish writes', () => {
  const config = JSON.parse(fs.readFileSync(path.join(repoRoot, 'squeal.config.json'), 'utf8'));
  assert.deepEqual(config.shared, { ref: 'refs/squeal' });
});

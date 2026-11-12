'use strict';

// Guards the Squeal coverage proof (hearsay-tools/squeal spec 020 D19, row 020-26c): only a dispatch with
// squeal_coverage_proof and no pr_number runs Vitest shard 1/8 three times with V8 coverage, once under
// `squeal ci record`, and compares the three in a job summary. It never fails the run, and every other run
// is unchanged. ci-squeal-results.workflow.test.cjs checks that no Squeal job gates a merge.
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
const PROOF = 'squeal-coverage-proof';
const COMPARE = 'squeal-coverage-proof-compare';
const step = (job, name) => job.steps.find((s) => s.id === name || s.name === name);

function expression(raw, context) {
  const code = String(raw).replace(/^\$\{\{\s*|\s*\}\}$/g, '').replace(/needs\.([\w]+-[\w-]+)/g, "needs['$1']");
  return runInNewContext(code, context);
}

function context(event, { proof = false, pr = '', result = 'success', cancelled = false } = {}) {
  return { github: { event_name: event }, inputs: { pr_number: pr, squeal_coverage_proof: proof, squeal_gate_trial: false },
    needs: { [PROOF]: { result } }, matrix: { run: 'squeal' }, cancelled: () => cancelled };
}

function sandbox(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ci-squeal-coverage-proof-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

// GitHub's artifact pattern, for the names these jobs use.
const matches = (pattern, name) => new RegExp(`^${pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`).test(name);

test('the input is a boolean off by default, and only the two proof jobs read it', () => {
  const workflow = ci();
  const input = workflow.on.workflow_dispatch.inputs.squeal_coverage_proof;
  assert.deepEqual({ ...input, description: undefined }, { description: undefined, required: false, type: 'boolean', default: false });
  const readers = Object.entries(workflow.jobs).filter(([, job]) => JSON.stringify(job).includes('squeal_coverage_proof')).map(([id]) => id);
  assert.deepEqual(readers.sort(), [PROOF, COMPARE], 'the shards, coverage merge and gate trial run as in any dispatch');
});

test('only a squeal_coverage_proof dispatch without pr_number runs the proof; the comparison follows any result but skipped', () => {
  const { jobs } = ci();
  const proof = (event, options) => expression(jobs[PROOF].if, context(event, options));
  assert.equal(jobs[PROOF].needs, undefined, 'it waits for no job');
  assert.equal(proof('workflow_dispatch', { proof: true }), true);
  assert.equal(proof('workflow_dispatch'), false, 'a bare dispatch, the proof of a ci.yml change, stays as it was');
  assert.equal(proof('workflow_dispatch', { proof: true, pr: '42' }), false, 'a release PR dispatch takes no proof');
  assert.equal(proof('workflow_dispatch', { proof: 'true' }), false, 'only the boolean input');
  for (const event of ['pull_request_target', 'merge_group', 'push']) assert.equal(proof(event, { proof: true }), false, event);
  const compare = (event, options) => expression(jobs[COMPARE].if, context(event, options));
  assert.deepEqual(jobs[COMPARE].needs, [PROOF]);
  // Without a status function GitHub adds success(), and one failed or timed-out run would skip the comparison.
  assert.match(String(jobs[COMPARE].if), /^\$\{\{ !cancelled\(\) && /);
  for (const result of ['success', 'failure', 'cancelled']) assert.equal(compare('workflow_dispatch', { proof: true, result }), true, result);
  assert.equal(compare('workflow_dispatch', { proof: true, result: 'skipped' }), false);
  assert.equal(compare('workflow_dispatch', { proof: true, cancelled: true }), false);
  assert.equal(compare('workflow_dispatch', { proof: true, pr: '42' }), false);
  for (const event of ['pull_request_target', 'merge_group', 'push']) assert.equal(compare(event, { proof: true }), false, event);
});

test('three runs of one commit, each reading only and never failing the run; only the squeal run sets up Squeal', () => {
  const { jobs } = ci();
  const job = jobs[PROOF];
  assert.deepEqual(job.strategy, { 'fail-fast': false, matrix: { run: ['squeal', 'v8', 'v8-control'] } });
  for (const id of [PROOF, COMPARE]) {
    assert.deepEqual(jobs[id].permissions, { contents: 'read' }, id);
    assert.equal(jobs[id]['continue-on-error'], true, `${id}: a timeout does not fail the run`);
    assert.equal(typeof jobs[id]['timeout-minutes'], 'number', id);
    for (const s of jobs[id].steps) assert.equal(s['continue-on-error'], true, `${id}: "${s.name}" must set continue-on-error`);
    const checkout = jobs[id].steps.find((s) => s.uses?.startsWith('actions/checkout@'));
    assert.equal(checkout.with.ref, '${{ github.sha }}', `${id}: the dispatched commit, as a bare dispatch's shards test`);
    assert.equal(checkout.with['persist-credentials'], false, id);
  }
  // The shards' pinned action (ci-squeal-results.workflow.test.cjs pins its one `uses`).
  const action = step(job, 'Set up Squeal');
  assert.equal(action.uses, step(jobs.vitest, 'Set up Squeal').uses);
  for (const run of ['squeal', 'v8', 'v8-control']) assert.equal(expression(action.if, { matrix: { run } }), run === 'squeal', run);
  const runs = job.steps.map((s) => s.run).filter(Boolean);
  assert.ok(runs.includes('pnpm install --frozen-lockfile'));
  const builds = (j) => j.steps.some((s) => s.run === 'npm run build:server');
  assert.equal(builds(job), builds(jobs.vitest), 'the proof runs the checkout the shards run');
  assert.equal(step(job, 'Upload the proof run').if, 'always()');
  for (const name of ['Compare the proof runs', 'Upload the comparison']) assert.equal(step(jobs[COMPARE], name).if, 'always()', name);
});

test('the proof\'s artifacts reach only the comparison, never the coverage merge, the gate trial or the export', () => {
  const { jobs } = ci();
  const upload = step(jobs[PROOF], 'Upload the proof run');
  assert.equal(upload.with.name, 'squeal-coverage-proof-${{ matrix.run }}');
  assert.equal(upload.with.path, '${{ runner.temp }}/squeal-coverage-proof/');
  const names = ['squeal', 'v8', 'v8-control'].map((run) => `squeal-coverage-proof-${run}`);
  const download = step(jobs[COMPARE], 'Download the proof runs');
  assert.deepEqual(download.with, { pattern: 'squeal-coverage-proof-*', path: '${{ runner.temp }}/squeal-coverage-proof' });
  for (const name of names) assert.ok(matches(download.with.pattern, name), name);
  const comparison = step(jobs[COMPARE], 'Upload the comparison').with.name;
  assert.equal(comparison, 'squeal-coverage-comparison');
  assert.equal(matches(download.with.pattern, comparison), false, 'a rerun of the comparison does not download its own artifact');
  const patterns = Object.entries(jobs).filter(([id]) => id !== COMPARE).flatMap(([, job]) => (job.steps ?? []))
    .filter((s) => s.uses?.startsWith('actions/download-artifact@')).map((s) => s.with.pattern ?? s.with.name);
  assert.ok(patterns.includes('vitest-coverage-shard-*') && patterns.includes('squeal-parts-shard-*'), patterns.join(', '));
  for (const pattern of patterns) for (const name of [...names, comparison]) assert.equal(matches(pattern, name), false, `${pattern} takes ${name}`);
});

function fakeBin(directory) {
  const bin = path.join(directory, 'bin');
  fs.mkdirSync(bin);
  // `squeal ci record` returns the command's code, as the action's pass-through does when Squeal cannot run.
  fs.writeFileSync(path.join(bin, 'squeal'), '#!/bin/sh\necho "squeal $*"\nmkdir -p "$4"\necho "{}" > "$4/squeal-part-1.json"\n'
    + 'while [ "$1" != -- ]; do shift; done\nshift\nexec "$@"\n', { mode: 0o755 });
  // npm writes the V8 report unless NO_REPORT is set, says one thing on stderr and exits with NPM_EXIT.
  fs.writeFileSync(path.join(bin, 'npm'), '#!/bin/sh\necho "npm $*"\necho "npm: a note" >&2\n'
    + '[ -n "$NO_REPORT" ] || { mkdir -p .ai/qa/coverage && echo \'{"r":1}\' > .ai/qa/coverage/coverage-final.json; }\nexit "$NPM_EXIT"\n', { mode: 0o755 });
  return bin;
}

test('each run times the dispatch shard command, keeps its exit code, report and parts, and exits 0', (t) => {
  const { jobs } = ci();
  const shard = step(jobs[PROOF], 'shard');
  const collect = step(jobs.vitest, 'collect');
  assert.equal(shard.env.VITEST_FILE_DURATION_CAP, collect.env.VITEST_FILE_DURATION_CAP);
  assert.equal(shard.env.PROOF_RUN, '${{ matrix.run }}');
  // The command of shard 1 in a dispatch: the proof measures what the Vitest shards run.
  const dispatched = collect.run.replace(/\$\{\{.*?\}\}/g, (raw) => (raw.includes('matrix.shard') && !raw.includes('&&') ? '1'
    : expression(raw, context('workflow_dispatch'))));
  const command = ['npm', 'test', '--', '--shard=1/8', '--maxWorkers=4', '--coverage.enabled'];
  assert.equal(dispatched, command.join(' '));
  for (const [run, exit] of [['squeal', 3], ['v8', 0], ['v8-control', 1]]) {
    const directory = sandbox(t);
    const workspace = path.join(directory, 'workspace');
    fs.mkdirSync(workspace);
    const result = spawnSync('bash', ['-e', '-c', shard.run], { cwd: workspace, encoding: 'utf8', env: {
      PATH: `${fakeBin(directory)}:${path.dirname(process.execPath)}:/usr/bin:/bin`, RUNNER_TEMP: directory, GITHUB_WORKSPACE: workspace, PROOF_RUN: run, NPM_EXIT: String(exit) } });
    assert.equal(result.status, 0, `${run}: ${result.stderr}`);
    assert.match(result.stderr, /^npm: a note$/m, `${run}: the command's stderr stays in the log`);
    const out = path.join(directory, 'squeal-coverage-proof');
    const meta = JSON.parse(fs.readFileSync(path.join(out, 'run.json'), 'utf8'));
    const recorded = run === 'squeal' ? ['squeal', 'ci', 'record', '--out', path.join(out, 'parts'), '--', ...command] : command;
    // Load and CPU model come from /proc, which only Linux has; elsewhere they read null and empty.
    const kind = (value) => (value === null ? 'number' : typeof value);
    assert.deepEqual({ ...meta, wallSeconds: typeof meta.wallSeconds, userSeconds: typeof meta.userSeconds, sysSeconds: typeof meta.sysSeconds,
      cpus: typeof meta.cpus, cpuModel: typeof meta.cpuModel, loadBefore: kind(meta.loadBefore), loadAfter: kind(meta.loadAfter) },
    { format: 'squeal-coverage-proof-run/1', run, command: recorded, exitCode: exit, wallSeconds: 'number', userSeconds: 'number', sysSeconds: 'number',
      root: workspace, cpus: 'number', cpuModel: 'string', loadBefore: 'number', loadAfter: 'number' });
    assert.equal(fs.readFileSync(path.join(out, 'coverage-final.json'), 'utf8'), '{"r":1}\n');
    assert.equal(fs.existsSync(path.join(out, 'parts', 'squeal-part-1.json')), run === 'squeal', `${run}: parts only under squeal ci record`);
    assert.match(result.stdout, new RegExp(`^Squeal coverage proof ${run}: exit ${exit}, wall \\d+\\.\\d{3} s, `, 'm'));
  }
});

test('a run without a V8 report warns and still writes its times', (t) => {
  const shard = step(ci().jobs[PROOF], 'shard');
  const directory = sandbox(t);
  const result = spawnSync('bash', ['-e', '-c', shard.run], { cwd: directory, encoding: 'utf8', env: {
    PATH: `${fakeBin(directory)}:/usr/bin:/bin`, RUNNER_TEMP: directory, GITHUB_WORKSPACE: directory, PROOF_RUN: 'v8', NPM_EXIT: '1', NO_REPORT: '1' } });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^::warning title=Squeal coverage proof v8::No V8 coverage report \(exit 1\)\.$/m);
  const out = path.join(directory, 'squeal-coverage-proof');
  assert.equal(fs.existsSync(path.join(out, 'coverage-final.json')), false);
  assert.equal(JSON.parse(fs.readFileSync(path.join(out, 'run.json'), 'utf8')).exitCode, 1);
});

test('the compare step writes the summary and comparison.json from the downloaded runs, and exits 0', (t) => {
  const compare = step(ci().jobs[COMPARE], 'Compare the proof runs');
  const directory = sandbox(t);
  const run = (env) => {
    const summary = path.join(directory, 'summary.md');
    fs.writeFileSync(summary, '');
    const result = spawnSync('bash', ['-e', '-c', compare.run], { cwd: repoRoot, encoding: 'utf8',
      env: { PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin`, RUNNER_TEMP: directory, GITHUB_STEP_SUMMARY: summary, ...env } });
    return { ...result, summary: fs.readFileSync(summary, 'utf8') };
  };
  const empty = run({});
  assert.equal(empty.status, 0, empty.stderr);
  assert.match(empty.summary, /^## Squeal coverage proof$/m);
  assert.match(empty.summary, /^\| \(a\) `squeal` against \(b\) `v8` \| \(a\) `squeal`: coverage missing; \(b\) `v8`: coverage missing \|/m);
  assert.equal(JSON.parse(fs.readFileSync(path.join(directory, 'squeal-coverage-comparison', 'comparison.json'), 'utf8')).format, 'squeal-coverage-proof/1');
  // A node that cannot run the script: the summary says so and the step still exits 0.
  const bin = path.join(directory, 'bin');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'node'), '#!/bin/sh\nexit 9\n', { mode: 0o755 });
  const failed = run({ PATH: `${bin}:/usr/bin:/bin` });
  assert.equal(failed.status, 0, failed.stderr);
  assert.match(failed.summary, /^The comparison did not finish \(exit 9\); see the step log\.$/m);
});

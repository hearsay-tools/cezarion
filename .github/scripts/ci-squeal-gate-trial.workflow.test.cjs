'use strict';

// Guards the Squeal quality gate trial (hearsay-tools/squeal spec 020 D13, row 020-08c): only a
// dispatch with squeal_gate_trial and no pr_number records Squeal's coverage in the Vitest shards
// (ci-squeal-results.workflow.test.cjs), and squeal-gate-trial runs `squeal code --base origin/main
// --parts` on the parts. It reports in its job summary and never fails the run.
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
const trialJob = () => ci().jobs['squeal-gate-trial'];
const step = (job, name) => job.steps.find((s) => s.id === name || s.name === name);

function expression(raw, context) {
  const code = String(raw).replace(/^\$\{\{\s*|\s*\}\}$/g, '').replace(/needs\.([\w]+-[\w-]+)/g, "needs['$1']");
  return runInNewContext(code, context);
}

function context(event, { trial = false, pr = '', vitest = 'success', cancelled = false } = {}) {
  return { github: { event_name: event }, inputs: { pr_number: pr, squeal_gate_trial: trial },
    needs: { vitest: { result: vitest } }, cancelled: () => cancelled };
}

function sandbox(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ci-squeal-gate-trial-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function runStep(directory, run, env) {
  const summary = path.join(directory, 'summary.md');
  fs.writeFileSync(summary, '');
  const result = spawnSync('bash', ['-e', '-c', run], { cwd: directory, encoding: 'utf8',
    env: { PATH: process.env.PATH, RUNNER_TEMP: directory, GITHUB_STEP_SUMMARY: summary, ...env } });
  return { ...result, summary: fs.readFileSync(summary, 'utf8') };
}

test('only a squeal_gate_trial dispatch without pr_number runs the trial, after the shards pass or fail', () => {
  const job = trialJob();
  assert.deepEqual(job.needs, ['vitest']);
  // jobs further up (pr-test-input, pr-test-proof) are skipped in a dispatch; GitHub's implied success() would skip this one.
  assert.match(String(job.if), /^\$\{\{ !cancelled\(\) && /);
  const at = (event, options) => expression(job.if, context(event, options));
  assert.equal(at('workflow_dispatch', { trial: true }), true);
  assert.equal(at('workflow_dispatch', { trial: true, vitest: 'failure' }), true, 'failed shards still wrote their parts');
  for (const vitest of ['skipped', 'cancelled']) assert.equal(at('workflow_dispatch', { trial: true, vitest }), false, vitest);
  assert.equal(at('workflow_dispatch', { trial: true, cancelled: true }), false);
  assert.equal(at('workflow_dispatch'), false, 'a bare dispatch, the proof of a ci.yml change, stays as it was');
  assert.equal(at('workflow_dispatch', { trial: true, pr: '42' }), false, 'a release PR dispatch takes no trial');
  assert.equal(at('workflow_dispatch', { trial: 'true' }), false, 'only the boolean input');
  for (const event of ['pull_request_target', 'merge_group', 'push']) assert.equal(at(event, { trial: true }), false, event);
});

test('the trial reads only, holds no token, never fails its job, and checks out the dispatched commit with main', () => {
  const { jobs } = ci();
  const job = jobs['squeal-gate-trial'];
  assert.deepEqual(job.permissions, { contents: 'read' });
  assert.doesNotMatch(JSON.stringify(job), /secrets\.|github\.token/);
  assert.equal(job['continue-on-error'], true, 'a timeout does not fail the run');
  for (const s of job.steps) assert.equal(s['continue-on-error'], true, `"${s.name}" must set continue-on-error`);
  for (const name of ['Report the trial', 'Upload the trial report']) assert.equal(step(job, name).if, 'always()', name);
  const checkout = job.steps.find((s) => s.uses?.startsWith('actions/checkout@'));
  // A bare dispatch's shards test github.sha (ci.workflow.test.cjs); the gate runs at the same commit.
  assert.deepEqual(checkout.with, { ref: '${{ github.sha }}', 'persist-credentials': false, 'fetch-depth': 1 });
  const history = (id) => step(jobs[id], 'Fetch the history the gate compares').run;
  assert.equal(history('squeal-gate-trial'), history('complexity-gate'), 'this commit and main, never every branch');
  const download = step(job, 'Download Squeal parts');
  assert.deepEqual(download.with, { pattern: 'squeal-parts-shard-*', path: '${{ runner.temp }}/squeal-parts' });
  const upload = step(job, 'Upload the trial report');
  assert.equal(upload.with.name, 'squeal-gate-trial');
  assert.equal(upload.with.path, '${{ runner.temp }}/squeal-gate-trial/');
  const runs = job.steps.map((s) => s.run).filter(Boolean);
  assert.ok(runs.includes('pnpm install --frozen-lockfile'));
  assert.ok(runs.includes('npm run build:server'), 'the gate checks the built server modules the shards read');
});

test('the gate step runs squeal code on every shard\'s parts and keeps its exit code, time and stderr', (t) => {
  const { run } = step(trialJob(), 'gate');
  const directory = sandbox(t);
  const bin = path.join(directory, 'bin');
  fs.mkdirSync(bin);
  for (const shard of [1, 2]) fs.mkdirSync(path.join(directory, 'squeal-parts', `squeal-parts-shard-${shard}`), { recursive: true });
  const out = (file) => fs.readFileSync(path.join(directory, 'squeal-gate-trial', file), 'utf8');
  for (const code of [0, 1, 3, 2]) {
    fs.writeFileSync(path.join(bin, 'node'), `#!/bin/sh\necho "$*"\necho "squeal code: a note" >&2\nexit ${code}\n`, { mode: 0o755 });
    const result = runStep(directory, run, { PATH: `${bin}:/usr/bin:/bin` });
    assert.equal(result.status, 0, `exit ${code}: the verdict never fails the step`);
    assert.equal(out('exit-code'), `${code}\n`);
    assert.match(out('seconds'), /^\d+\n$/);
    assert.equal(out('stderr.txt'), 'squeal code: a note\n');
    assert.match(result.stderr, /squeal code: a note/, 'the log shows the gate\'s notes');
  }
  const parts = path.join(directory, 'squeal-parts');
  assert.equal(out('report.json'), `${directory}/squeal/plugins/claude-code/dist/cli/squeal.mjs code --base origin/main --json `
    + `--parts ${parts}/squeal-parts-shard-1 ${parts}/squeal-parts-shard-2\n`);
});

const REPORT = {
  format: 'squeal-code-gate/1', createdAt: '2026-11-10T00:00:00.000Z', verdict: 'pass',
  base: { ref: 'origin/main', commit: 'b'.repeat(40), policy: {} },
  head: { commit: 'c'.repeat(40), dirty: false, paths: [] },
  budget: { seconds: 600, timedOut: false },
  functions: [{ state: 'pass' }, { state: 'pass' }, { state: 'skipped' }],
  uncounted: [],
  runs: [
    { runner: 'vitest', selected: ['a.test.ts', 'b.test.ts', 'c.test.ts'], completed: ['c.test.ts'], notFinished: [], failed: [],
      from: { 'a.test.ts': 'parts', 'b.test.ts': 'store', 'c.test.ts': 'run' }, durationMs: 4200 },
    { runner: 'node-test', selected: ['d.test.cjs'], completed: ['d.test.cjs'], notFinished: [], failed: [], durationMs: 900 },
  ],
  counts: { pass: 2, violation: 0, incomplete: 0, skipped: 1, accepted: 0 },
};
const PROVIDER = { provider: 'squeal', providerVersion: 1, recordVersion: 2 };
const part = (header, testFiles) => ({ format: 'squeal-ci-part/4', header, projects: [], testFiles, evidence: {} });

function writeParts(directory, shard, parts) {
  const dir = path.join(directory, 'squeal-parts', `squeal-parts-shard-${shard}`);
  fs.mkdirSync(dir, { recursive: true });
  parts.forEach((content, i) => fs.writeFileSync(path.join(dir, `squeal-part-${i}.json`), typeof content === 'string' ? content : JSON.stringify(content)));
}

test('the summary names the verdict, where each selected file\'s evidence came from, and each shard\'s recording cost', (t) => {
  const { run } = step(trialJob(), 'Report the trial');
  const directory = sandbox(t);
  const out = path.join(directory, 'squeal-gate-trial');
  fs.mkdirSync(out);
  fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(REPORT));
  fs.writeFileSync(path.join(out, 'exit-code'), '0\n');
  fs.writeFileSync(path.join(out, 'seconds'), '75\n');
  // Shard 1: the provider and 018-29's cost. 2: an older Squeal, and the project's own coverage. 3: a part that
  // does not read. 4: two parts of one command, whose cost counts once.
  writeParts(directory, 1, [part({ coverage: PROVIDER, cost: { command: 'u1', hooksMs: 12345, threads: 9, afterMs: 420 } },
    [{ durationMs: 100000, record: 0 }, { durationMs: 100000, noRecord: 'inspector' }, { durationMs: null, record: 1 }])]);
  writeParts(directory, 2, [part({ coverage: { off: 'project-coverage', note: 'n' } }, [{ durationMs: 5 }])]);
  writeParts(directory, 3, ['{']);
  const cost = { command: 'u4', hooksMs: 1000, threads: 3, afterMs: 260 };
  writeParts(directory, 4, [part({ coverage: PROVIDER, cost }, [{ durationMs: 10000 }]), part({ coverage: PROVIDER, cost }, [{ durationMs: 10000 }])]);
  const result = runStep(directory, run, { SHARDS_RESULT: 'success', GATE: 'success' });
  assert.equal(result.status, 0, result.stderr);
  const lines = result.summary.split('\n');
  for (const line of [
    'A trial: this job gates nothing and never fails the run. Vitest shards: success.',
    'Verdict: **pass** (exit 0) in 75 s. Base `origin/main`, merge base bbbbbbbbbbbb; head cccccccccccc.',
    'Changed functions: 3 (pass 2, violation 0, incomplete 0, skipped 1, accepted 0). Paths not counted: 0. Budget 600 s, timed out: false.',
    '| 4 | 1 | 1 | 2 |',
    '- vitest: 3 selected, 1 completed, 0 not finished, 0 with a failed test; run time 4 s.',
    '- node-test: 1 selected, 1 completed, 0 not finished, 0 with a failed test; run time 1 s.',
    '| 1 | 1 | 3 | 2 | squeal, provider 1, record 2 | 12.3 s in 9 processes and threads | 6.2% of 200 s | 0.42 s |',
    '| 2 | 1 | 1 | 0 | off: project-coverage | not in the parts | | |',
    '| 3 | the parts do not read | | | | | | |',
    '| 4 | 2 | 2 | 0 | squeal, provider 1, record 2 | 1 s in 3 processes and threads | 5% of 20 s | 0.26 s |',
  ]) assert.ok(lines.includes(line), `missing: ${line}\n${result.summary}`);
});

test('without a report the summary names the exit code and the gate\'s last stderr lines, or that it did not run', (t) => {
  const { run } = step(trialJob(), 'Report the trial');
  const directory = sandbox(t);
  const notRun = runStep(directory, run, { SHARDS_RESULT: 'failure', GATE: 'skipped' });
  assert.equal(notRun.status, 0, notRun.stderr);
  assert.match(notRun.summary, /^No report: the gate did not run \(gate step: skipped\)\.$/m);
  assert.match(notRun.summary, /^No shard parts were downloaded\.$/m);
  const out = path.join(directory, 'squeal-gate-trial');
  fs.mkdirSync(out);
  fs.writeFileSync(path.join(out, 'report.json'), '');
  fs.writeFileSync(path.join(out, 'exit-code'), '2\n');
  fs.writeFileSync(path.join(out, 'seconds'), '3\n');
  fs.writeFileSync(path.join(out, 'stderr.txt'), 'squeal code: no directory /runner/temp/squeal-parts/squeal-parts-shard-*\n');
  const setup = runStep(directory, run, { SHARDS_RESULT: 'success', GATE: 'success' });
  assert.equal(setup.status, 0, setup.stderr);
  assert.match(setup.summary, /^No report: exit 2, a setup or usage error after 3 s\. The gate's last stderr lines:$/m);
  assert.match(setup.summary, /^```\nsqueal code: no directory \/runner\/temp\/squeal-parts\/squeal-parts-shard-\*\n```$/m);
});

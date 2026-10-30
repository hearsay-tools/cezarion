'use strict';

// Guards single-pass coverage (hearsay-tools/cezarion#1958): the required shards run tests once,
// and optional report publication cannot change their test verdict.
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
const COVERAGE_JOBS = ['vitest-coverage-merge'];
const SHARD_RUN = 'npm test -- --shard=${{ matrix.shard }}/4 --maxWorkers=4';
const named = (job, name) => job.steps.find((step) => step.name === name);

function expression(raw, context) {
  const code = raw.replace(/^\$\{\{\s*|\s*\}\}$/g, '').replace(/needs\.([\w]+-[\w-]+)/g, "needs['$1']");
  return runInNewContext(code, context);
}

function context(event, { surface = 'full-matrix', bump = 'false', verified = 'false', shards = 'success', cancelled = false } = {}) {
  return {
    github: { event_name: event },
    needs: {
      'queue-proof': { result: 'success', outputs: { verified } },
      'change-surface': { result: 'success', outputs: { surface } },
      'classify-pr': { result: 'success', outputs: { bump_pr: bump } },
      vitest: { result: shards },
    },
    cancelled: () => cancelled,
  };
}

test('the required shards run once, with coverage only on PRs and dispatches', () => {
  const { jobs } = ci();
  assert.equal(jobs['vitest-coverage'], undefined, 'no duplicate test matrix');
  const runs = jobs.vitest.steps.filter((step) => step.run?.startsWith('npm test --'));
  assert.equal(runs.length, 1);
  assert.equal(runs[0]['continue-on-error'], undefined, 'test failures must block');
  for (const event of ['pull_request_target', 'workflow_dispatch', 'merge_group', 'push']) {
    const expected = ['pull_request_target', 'workflow_dispatch'].includes(event);
    const command = runs[0].run.replace(/\$\{\{.*?\}\}/g, (raw) => raw.includes('matrix.shard') ? '1' : expression(raw, context(event)));
    assert.equal(command.trim(), `${SHARD_RUN.replace('${{ matrix.shard }}', '1')}${expected ? ' --coverage.enabled' : ''}`);
    assert.equal(expression(jobs.vitest['timeout-minutes'], context(event)), expected ? 25 : 15);
  }
});

test('coverage publication follows eligible shards, including failures, but never main or the merge queue', () => {
  const { jobs } = ci();
  const merge = jobs['vitest-coverage-merge'].if;
  const upload = named(jobs.vitest, 'Upload shard coverage').if;
  for (const event of ['pull_request_target', 'workflow_dispatch']) {
    assert.equal(expression(upload, context(event)), true);
    assert.equal(expression(merge, context(event)), true);
    assert.equal(expression(merge, context(event, { shards: 'failure' })), true);
    assert.equal(expression(merge, context(event, { shards: 'skipped' })), false);
  }
  for (const event of ['merge_group', 'push']) {
    assert.equal(expression(upload, context(event)), false);
    assert.equal(expression(merge, context(event)), false);
  }
  assert.equal(expression(merge, context('pull_request_target', { cancelled: true })), false);
});

test('no coverage job is a required check, a verify dependency or a merge-queue roster entry', () => {
  const { jobs } = ci();
  const { REQUIRED_QUEUE_JOBS } = require('./queue-ci-proof.cjs');
  for (const id of COVERAGE_JOBS) {
    assert.equal(jobs.verify.needs.includes(id), false, `${id} in verify.needs`);
    assert.equal(jobs.verify.if, 'always()');
    const label = jobs[id].name.replace('${{ matrix.shard }}', '1');
    assert.equal(REQUIRED_QUEUE_JOBS.some((job) => job.startsWith(label.replace('1/4', ''))), false, `${id} in the queue roster`);
    for (const [other, job] of Object.entries(jobs)) {
      if (other !== id && !COVERAGE_JOBS.includes(other)) assert.equal([job.needs ?? []].flat().includes(id), false, `${other} needs ${id}`);
    }
  }
  assert.doesNotMatch(jobs.verify.steps.map((step) => step.run).join('\n'), /coverage/i);
  assert.deepEqual(jobs['vitest-coverage-merge'].needs, ['vitest']);
});

test('the coverage jobs hold no secret, read only, pin every action and keep expressions out of scripts', () => {
  const { jobs } = ci();
  for (const id of COVERAGE_JOBS) {
    const job = jobs[id];
    assert.ok(Object.values(job.permissions).every((permission) => permission === 'read'), id);
    assert.doesNotMatch(JSON.stringify(job), /secrets\./, id);
    for (const step of job.steps) {
      if (step.uses) assert.match(step.uses, /@[0-9a-f]{40}( |$)/, `${id}: ${step.uses} is not pinned to a commit`);
      if (step.run) assert.deepEqual(step.run.match(/\$\{\{[^}]*\}\}/g)?.filter((e) => e !== '${{ matrix.shard }}') ?? [], [], `${id}: ${step.name}`);
    }
  }
});

test('every coverage step can fail without failing its job, so a problem is only a warning', () => {
  const { jobs } = ci();
  for (const id of COVERAGE_JOBS) {
    for (const step of jobs[id].steps.filter((s) => s.id !== 'resolve-dispatch')) {
      assert.equal(step['continue-on-error'], true, `${id}: "${step.name}" must set continue-on-error`);
    }
  }
  for (const name of ['Upload shard coverage', 'Report a missing shard coverage report']) {
    assert.equal(named(jobs.vitest, name)['continue-on-error'], true);
  }
});

test('the shards keep producing one merged artifact named for the head commit', () => {
  const { jobs } = ci();
  const config = fs.readFileSync(path.join(repoRoot, 'vitest.config.ts'), 'utf8');
  const reports = config.match(/reportsDirectory: '([^']+)'/)[1];
  const shardUpload = named(jobs.vitest, 'Upload shard coverage');
  assert.equal(shardUpload.with.path, `${reports}/coverage-final.json`);
  assert.match(shardUpload.with.name, /^vitest-coverage-shard-\$\{\{ matrix\.shard \}\}$/);
  assert.equal(shardUpload.with['if-no-files-found'], 'error');

  const merge = named(jobs['vitest-coverage-merge'], 'Merge shard coverage');
  assert.match(merge.run, /merge-vitest-coverage\.mjs --input shards --output merged --shards 4 /);
  assert.match(named(jobs['vitest-coverage-merge'], 'Download shard coverage').with.pattern, /^vitest-coverage-shard-\*$/);
  const upload = named(jobs['vitest-coverage-merge'], 'Upload merged coverage');
  assert.equal(upload.with.name, 'vitest-coverage-${{ github.event.pull_request.head.sha || github.sha }}');
  assert.equal(upload.with.path, 'merged/');
  assert.equal(upload.with['if-no-files-found'], 'error');
  assert.equal(upload.with['retention-days'], 14);
  assert.equal(upload.with.overwrite, true);
  assert.equal(upload.if, "steps.merge.outcome == 'success'");
});

function sandbox(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ci-coverage-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  fs.symlinkSync(path.join(repoRoot, '.github'), path.join(directory, '.github'));
  return directory;
}

function runStep(directory, step, env) {
  const summary = path.join(directory, 'summary.md');
  fs.writeFileSync(summary, '');
  const result = spawnSync('bash', ['-eu', '-c', step.run], { cwd: directory, encoding: 'utf8',
    env: { PATH: process.env.PATH, GITHUB_STEP_SUMMARY: summary, GITHUB_WORKSPACE: '/home/runner/work/r/r', ...env } });
  return { ...result, summary: fs.readFileSync(summary, 'utf8') };
}

test('the merge step writes the merged report, and fails with the missing shard named when one is absent', (t) => {
  const step = named(ci().jobs['vitest-coverage-merge'], 'Merge shard coverage');
  const directory = sandbox(t);
  const entry = (file) => ({ [file]: { path: file, statementMap: { 0: { start: { line: 1, column: 0 }, end: { line: 1, column: 5 } } }, fnMap: {}, branchMap: {}, s: { 0: 1 }, f: {}, b: {} } });
  const shard = (number, report) => {
    fs.mkdirSync(path.join(directory, 'shards', `vitest-coverage-shard-${number}`), { recursive: true });
    fs.writeFileSync(path.join(directory, 'shards', `vitest-coverage-shard-${number}`, 'coverage-final.json'), JSON.stringify(report));
  };
  const env = { HEAD_SHA: 'a'.repeat(40), TESTED_REF: 'refs/pull/7/merge', BASE_SHA: 'b'.repeat(40), RUN_ID: '99', RUN_ATTEMPT: '2' };
  shard(1, entry('/home/runner/work/r/r/a.ts'));
  shard(3, entry('/home/runner/work/r/r/b.ts'));
  const failed = runStep(directory, step, env);
  assert.notEqual(failed.status, 0);
  assert.match(failed.stderr, /Missing coverage for shard 2, shard 4\./);
  assert.equal(fs.readFileSync(path.join(directory, 'merge.err'), 'utf8').trim(), 'Missing coverage for shard 2, shard 4.');
  shard(2, entry('/home/runner/work/r/r/a.ts'));
  const missingFourth = runStep(directory, step, env);
  assert.notEqual(missingFourth.status, 0);
  assert.match(missingFourth.stderr, /Missing coverage for shard 4\./);
  shard(4, entry('/home/runner/work/r/r/fourth.ts'));
  const done = runStep(directory, step, env);
  assert.equal(done.status, 0, done.stderr);
  assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(path.join(directory, 'merged', 'coverage-final.json'), 'utf8'))), ['a.ts', 'b.ts', 'fourth.ts']);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(directory, 'merged', 'provenance.json'), 'utf8')), {
    headSha: env.HEAD_SHA, testedRef: env.TESTED_REF, baseSha: env.BASE_SHA, runId: '99', runAttempt: '2', shards: 4, files: 3,
    paths: 'relative to the repository root' });
});

test('a coverage artifact that is not uploaded is a warning annotation and a summary line that name the cause', (t) => {
  const step = named(ci().jobs['vitest-coverage-merge'], 'Report the coverage artifact');
  const directory = sandbox(t);
  const base = { HEAD_SHA: 'c'.repeat(40), SHARDS_RESULT: 'failure', DOWNLOAD: 'success', MERGE: 'success', UPLOAD: 'success' };

  const uploaded = runStep(directory, step, base);
  assert.equal(uploaded.status, 0);
  assert.doesNotMatch(uploaded.stdout, /::warning/);
  assert.match(uploaded.summary, /uploaded as artifact vitest-coverage-c{40}/);

  fs.writeFileSync(path.join(directory, 'merge.err'), 'Missing coverage for shard 2, shard 3.\n');
  const missing = runStep(directory, step, { ...base, MERGE: 'failure', UPLOAD: 'skipped' });
  assert.equal(missing.status, 0, 'the report step itself must not fail');
  assert.match(missing.stdout, /^::warning title=Vitest coverage artifact not uploaded::.*Missing coverage for shard 2, shard 3\. \(shard jobs: failure\)/m);
  assert.match(missing.summary, /Vitest coverage not uploaded: Missing coverage for shard 2, shard 3\./);

  const download = runStep(directory, step, { ...base, DOWNLOAD: 'failure', MERGE: 'skipped', UPLOAD: 'skipped' });
  assert.match(download.stdout, /::warning .*the shard download ended as failure/);
  const upload = runStep(directory, step, { ...base, UPLOAD: 'failure' });
  assert.match(upload.stdout, /::warning .*the upload ended as failure/);
});

test('a shard that produced no report warns with its number and says where the verdict comes from', (t) => {
  const step = named(ci().jobs.vitest, 'Report a missing shard coverage report');
  assert.match(step.if, /^always\(\)/);
  const directory = sandbox(t);
  const timedOut = runStep(directory, step, { SHARD: '2', COLLECT: 'failure', UPLOAD: 'skipped' });
  assert.equal(timedOut.status, 0);
  assert.match(timedOut.stdout, /^::warning title=Vitest coverage shard 2\/4 missing::No coverage report from shard 2: the test run ended as failure .*Vitest shard job\.$/m);
  assert.match(timedOut.summary, /Vitest coverage shard 2\/4: no report/);
  const upload = runStep(directory, step, { SHARD: '3', COLLECT: 'success', UPLOAD: 'failure' });
  assert.match(upload.stdout, /shard 3: the upload ended as failure/);
});

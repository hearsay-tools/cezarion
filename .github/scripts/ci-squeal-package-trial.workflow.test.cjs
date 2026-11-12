'use strict';

// Guards the Squeal packaged test trial (hearsay-tools/squeal spec 020 D12 and D15, row 020-32;
// hearsay-tools/squeal#194): only a dispatch with squeal_package_trial and no pr_number runs
// `squeal code` with a node:test entry for packages/cezar/test/e2e and child coverage. The gate
// reads both keys at the merge base, so the job adds them in two local commits and leaves
// squeal.config.json as it is. It reports in its job summary and never fails the run.
const assert = require('node:assert/strict');
const { execFileSync, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { runInNewContext } = require('node:vm');
const yaml = require('yaml');

const repoRoot = path.join(__dirname, '..', '..');
const JOB = 'squeal-package-trial';
const ci = () => yaml.parse(fs.readFileSync(path.join(repoRoot, '.github', 'workflows', 'ci.yml'), 'utf8'));
const step = (job, name) => job.steps.find((s) => s.id === name || s.name === name);
const trialEntry = () => JSON.parse(step(ci().jobs[JOB], 'commits').env.TRIAL_ENTRY);

function expression(raw, context) {
  return runInNewContext(String(raw).replace(/^\$\{\{\s*|\s*\}\}$/g, ''), context);
}

function context(event, { trial = false, pr = '' } = {}) {
  return { github: { event_name: event }, inputs: { pr_number: pr, squeal_package_trial: trial } };
}

function sandbox(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ci-squeal-package-trial-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

// GitHub's bash for `run`; the step's literal env, with the test's values on top.
function runStep(directory, s, env, cwd = directory) {
  const summary = path.join(directory, 'summary.md');
  if (!fs.existsSync(summary)) fs.writeFileSync(summary, '');
  const literal = Object.fromEntries(Object.entries(s.env ?? {}).filter(([, value]) => !String(value).includes('${{')));
  const result = spawnSync('bash', ['-e', '-o', 'pipefail', '-c', s.run], { cwd, encoding: 'utf8',
    env: { PATH: process.env.PATH, HOME: directory, GIT_CONFIG_NOSYSTEM: '1', RUNNER_TEMP: directory, GITHUB_STEP_SUMMARY: summary, ...literal, ...env } });
  return { ...result, summary: fs.readFileSync(summary, 'utf8') };
}

test('two dispatch inputs, read only by the trial; only a squeal_package_trial dispatch without pr_number runs it', () => {
  const workflow = ci();
  const { inputs } = workflow.on.workflow_dispatch;
  const plain = (input) => ({ ...input, description: undefined });
  assert.deepEqual(plain(inputs.squeal_package_trial), { description: undefined, required: false, type: 'boolean', default: false });
  assert.deepEqual(plain(inputs.squeal_package_trial_commit), { description: undefined, required: false, type: 'string', default: '' });
  for (const input of ['squeal_package_trial', 'squeal_package_trial_commit']) {
    const readers = Object.entries(workflow.jobs).filter(([, job]) => JSON.stringify(job).includes(input)).map(([id]) => id);
    assert.deepEqual(readers, [JOB], `${input}: the shards, the gate trial and the coverage proof run as in any dispatch`);
  }
  const job = workflow.jobs[JOB];
  assert.equal(job.needs, undefined, 'it waits for no job');
  const at = (event, options) => expression(job.if, context(event, options));
  assert.equal(at('workflow_dispatch', { trial: true }), true);
  assert.equal(at('workflow_dispatch'), false, 'a bare dispatch, the proof of a ci.yml change, stays as it was');
  assert.equal(at('workflow_dispatch', { trial: true, pr: '42' }), false, 'a release PR dispatch takes no trial');
  assert.equal(at('workflow_dispatch', { trial: 'true' }), false, 'only the boolean input');
  for (const event of ['pull_request_target', 'merge_group', 'push']) assert.equal(at(event, { trial: true }), false, event);
});

test('the trial reads only, holds no token, never fails its job, and installs the measured tree', () => {
  const { jobs } = ci();
  const job = jobs[JOB];
  assert.deepEqual(job.permissions, { contents: 'read' });
  assert.doesNotMatch(JSON.stringify(job), /secrets\.|github\.token/);
  assert.equal(job['continue-on-error'], true, 'a timeout does not fail the run');
  assert.equal(typeof job['timeout-minutes'], 'number');
  for (const s of job.steps) assert.equal(s['continue-on-error'], true, `"${s.name}" must set continue-on-error`);
  const checkout = job.steps.find((s) => s.uses?.startsWith('actions/checkout@'));
  assert.deepEqual(checkout.with, { ref: '${{ github.sha }}', 'persist-credentials': false, 'fetch-depth': 1 });
  const history = (id) => step(jobs[id], 'Fetch the history the gate compares').run;
  assert.equal(history(JOB), history('complexity-gate'), 'this commit and main, never every branch');
  assert.equal(step(job, 'commits').env.TRIAL_COMMIT, '${{ inputs.squeal_package_trial_commit }}');
  // The measured tree's Node, lockfile and dependencies: the trial commits come first.
  const at = (find) => job.steps.findIndex(find);
  const commits = at((s) => s.id === 'commits');
  for (const later of [(s) => s.uses?.startsWith('pnpm/action-setup@'), (s) => s.uses?.startsWith('actions/setup-node@'),
    (s) => s.run === 'pnpm install --frozen-lockfile', (s) => s.id === 'gate']) assert.ok(at(later) > commits);
  assert.equal(step(job, 'Set up pnpm').with.version, step(jobs['squeal-gate-trial'], 'Set up pnpm').with.version);
  assert.equal(step(job, 'Set up Squeal').uses, step(jobs.vitest, 'Set up Squeal').uses);
  assert.equal(step(job, 'gate').if,
    "steps.commits.outcome == 'success' && steps.pnpm.outcome == 'success' && steps.node.outcome == 'success' && steps.install.outcome == 'success' && steps.squeal_setup.outcome == 'success'",
    'never the gate on the unchanged checkout or an unprepared environment');
  for (const [id, name] of [['pnpm', 'Set up pnpm'], ['node', 'Set up Node.js'], ['install', 'Install pnpm dependencies'], ['squeal_setup', 'Set up Squeal']])
    assert.equal(job.steps.find((s) => s.name === name).id, id, name);
  assert.match(step(job, 'Report the trial').env.SETUP, /steps\.pnpm\.outcome.*steps\.node\.outcome.*steps\.install\.outcome.*steps\.squeal_setup\.outcome/);
  for (const name of ['Report the trial', 'Upload the trial report']) assert.equal(step(job, name).if, 'always()', name);
  const upload = step(job, 'Upload the trial report');
  assert.equal(upload.with.name, JOB);
  assert.equal(upload.with.path, '${{ runner.temp }}/squeal-package-trial/');
});

test('the trial entry is `npm run test:package` without its wrapper, and the repository config stays unchanged', () => {
  const entry = trialEntry();
  const config = JSON.parse(fs.readFileSync(path.join(repoRoot, 'squeal.config.json'), 'utf8'));
  const unit = config.nodeTest.find((e) => e.name === 'test:unit');
  assert.equal(entry.name, 'test:package');
  assert.equal(entry.cwd, unit.cwd);
  assert.deepEqual(entry.argv, unit.argv);
  // scripts/test-package.mjs: its suite directory, and the node --test command it runs after the build.
  const wrapper = fs.readFileSync(path.join(repoRoot, 'scripts', 'test-package.mjs'), 'utf8');
  assert.match(wrapper, new RegExp(`^const suite = '${entry.cwd}/${path.posix.dirname(entry.include[0])}';$`, 'm'));
  assert.deepEqual(entry.include, ['test/e2e/*.test.ts'], 'the files the wrapper accepts');
  const quoted = [...entry.argv, '--test'].map((arg) => `'${arg}'`).join(', ');
  assert.ok(wrapper.includes(`run(process.execPath, [${quoted}, ...files], join(repo, '${entry.cwd}'));`), 'the wrapper\'s own command');
  // `prepare` runs in the entry's directory; it is the root build the wrapper runs when stale.
  const [npm, prefix, root, run, script] = entry.prepare.command;
  assert.deepEqual([npm, prefix, run, script], ['npm', '--prefix', 'run', 'build']);
  assert.equal(path.resolve(repoRoot, entry.cwd, root), path.resolve(repoRoot));
  assert.match(wrapper, /run\(platform === 'win32' \? 'npm\.cmd' : 'npm', \['run', 'build'\], repo,/);
  assert.equal(typeof JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8')).scripts.build, 'string');
  assert.equal(entry.prepare.timeoutSeconds, 600);
  // Merging the trial changes no daemon, check or gate run outside the dispatch.
  assert.equal(config.nodeTest.some((e) => e.name === entry.name), false);
  assert.equal(config.coverage?.children, undefined);
});

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', env: { PATH: process.env.PATH, HOME: cwd, GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null', GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@example.test', GIT_COMMITTER_NAME: 'T',
    GIT_COMMITTER_EMAIL: 't@example.test' } }).trim();
}

const UNIT = { name: 'test:unit', cwd: 'packages/cezar', argv: ['--import', 'tsx'], include: ['test/unit/*.test.ts'] };

// main: M then M2; the measured branch leaves main at M with one commit, C.
function fixture(directory, config = { coverage: { exclude: ['x/**'] }, nodeTest: [UNIT] }) {
  const repo = path.join(directory, 'repo');
  fs.mkdirSync(path.join(repo, 'scripts'), { recursive: true });
  const write = (file, text) => {
    fs.mkdirSync(path.dirname(path.join(repo, file)), { recursive: true });
    fs.writeFileSync(path.join(repo, file), text);
  };
  git(directory, 'init', '-q', '-b', 'main', repo);
  write('squeal.config.json', `${JSON.stringify(config, null, 2)}\n`);
  write('scripts/release.mjs', 'export function publish() { return 1; }\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'M');
  const m = git(repo, 'rev-parse', 'HEAD');
  git(repo, 'checkout', '-q', '-b', 'measured');
  write('scripts/release.mjs', 'export function publish() { return 2; }\n');
  write('packages/cezar/test/e2e/release.test.ts', 'import test from "node:test";\ntest("publish", () => {});\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'C');
  const c = git(repo, 'rev-parse', 'HEAD');
  git(repo, 'checkout', '-q', 'main');
  write('other.txt', 'main moved on\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'M2');
  const m2 = git(repo, 'rev-parse', 'HEAD');
  git(repo, 'update-ref', 'refs/remotes/origin/main', m2);
  return { repo, m, c, m2 };
}

const read = (directory, file) => JSON.parse(fs.readFileSync(path.join(directory, 'squeal-package-trial', file), 'utf8'));
const changed = (repo, from, to) => git(repo, 'diff', '--name-only', from, to).split('\n').filter(Boolean);
const configAt = (repo, commit) => JSON.parse(git(repo, 'show', `${commit}:squeal.config.json`));

test('the trial commits put the keys at the merge base and keep the measured change, the config left out', (t) => {
  const directory = sandbox(t);
  const { repo, m, c } = fixture(directory);
  git(repo, 'checkout', '-q', '--detach', c);
  const result = runStep(directory, step(ci().jobs[JOB], 'commits'), { TRIAL_COMMIT: '' }, repo);
  assert.equal(result.status, 0, result.stderr);
  const commits = read(directory, 'commits.json');
  assert.deepEqual({ ...commits, base: undefined, trial: undefined },
    { format: 'squeal-package-trial-commits/1', ref: 'origin/main', head: c, mergeBase: m, base: undefined, trial: undefined });
  const { base, trial } = commits;
  assert.equal(git(repo, 'rev-parse', 'HEAD'), trial, 'the gate runs at the trial head');
  assert.equal(git(repo, 'rev-parse', `${trial}^`), base);
  assert.equal(git(repo, 'rev-parse', `${base}^`), m);
  assert.equal(git(repo, 'rev-parse', 'squeal-package-trial-base'), base, 'the gate\'s --base');
  assert.equal(git(repo, 'status', '--porcelain'), '');
  assert.deepEqual(changed(repo, base, trial), ['packages/cezar/test/e2e/release.test.ts', 'scripts/release.mjs']);
  assert.deepEqual(changed(repo, m, base), ['squeal.config.json']);
  assert.deepEqual(changed(repo, c, trial), ['squeal.config.json']);
  const expected = { coverage: { exclude: ['x/**'], children: true }, nodeTest: [UNIT, trialEntry()] };
  assert.deepEqual(configAt(repo, base), expected);
  assert.deepEqual(configAt(repo, trial), expected);
  assert.deepEqual(read(directory, 'squeal.config.base.json'), expected, 'the artifact holds what the gate read');
  assert.match(result.stdout, new RegExp(`^Squeal packaged test trial: ${c} against origin/main \\(merge base ${m}\\)`, 'm'));
});

test('with squeal_package_trial_commit the trial measures that commit against its first parent', (t) => {
  const directory = sandbox(t);
  // A config that already names the entry gets the trial's, once.
  const { repo, m, c, m2 } = fixture(directory, { nodeTest: [UNIT, { name: 'test:package', include: ['old/*.ts'] }] });
  git(repo, 'checkout', '-q', '--detach', m2);
  const result = runStep(directory, step(ci().jobs[JOB], 'commits'), { TRIAL_COMMIT: c }, repo);
  assert.equal(result.status, 0, result.stderr);
  const { head, ref, mergeBase, base, trial } = read(directory, 'commits.json');
  assert.deepEqual([head, ref, mergeBase], [c, `${c}^1`, m]);
  assert.equal(git(repo, 'rev-parse', `${base}^`), m);
  assert.deepEqual(changed(repo, base, trial), ['packages/cezar/test/e2e/release.test.ts', 'scripts/release.mjs']);
  assert.deepEqual(changed(repo, c, 'HEAD'), ['squeal.config.json'], 'the measured tree, not the dispatched one');
  assert.deepEqual(configAt(repo, trial), { coverage: { children: true }, nodeTest: [UNIT, trialEntry()] });
});

test('squeal_package_trial_commit takes a full commit SHA only, before any fetch', (t) => {
  const directory = sandbox(t);
  const { repo, m2 } = fixture(directory);
  git(repo, 'checkout', '-q', '--detach', m2);
  for (const value of ['--upload-pack=touch pwned', 'main', m2.slice(0, 12), `${m2}\n`, m2.toUpperCase(), 'f'.repeat(40)]) {
    const result = runStep(directory, step(ci().jobs[JOB], 'commits'), { TRIAL_COMMIT: value }, repo);
    assert.notEqual(result.status, 0, JSON.stringify(value));
    if (value !== 'f'.repeat(40)) assert.match(result.stdout, /^::error title=Squeal packaged test trial::squeal_package_trial_commit must be a full 40-character commit SHA\.$/m);
    assert.equal(git(repo, 'rev-parse', 'HEAD'), m2);
    assert.equal(spawnSync('git', ['rev-parse', '--verify', '--quiet', 'squeal-package-trial-base'], { cwd: repo }).status, 1);
    assert.equal(fs.existsSync(path.join(directory, 'squeal-package-trial', 'commits.json')), false);
  }
  assert.equal(fs.existsSync(path.join(repo, 'pwned')), false);
});

test('the gate step runs squeal code against the trial base and keeps its exit code, time and stderr', (t) => {
  const s = step(ci().jobs[JOB], 'gate');
  const directory = sandbox(t);
  const bin = path.join(directory, 'bin');
  fs.mkdirSync(bin);
  const out = (file) => fs.readFileSync(path.join(directory, 'squeal-package-trial', file), 'utf8');
  for (const code of [0, 1, 3, 2]) {
    fs.writeFileSync(path.join(bin, 'squeal'), `#!/bin/sh\necho "$*"\necho "squeal code: a note" >&2\nexit ${code}\n`, { mode: 0o755 });
    const result = runStep(directory, s, { PATH: `${bin}:/usr/bin:/bin` });
    assert.equal(result.status, 0, `exit ${code}: the verdict never fails the step`);
    assert.equal(out('exit-code'), `${code}\n`);
    assert.match(out('seconds'), /^\d+\n$/);
    assert.equal(out('stderr.txt'), 'squeal code: a note\n');
    assert.match(result.stderr, /squeal code: a note/, 'the log shows the gate\'s notes and the prepare output');
  }
  assert.equal(out('report.json'), 'code --base squeal-package-trial-base --json --timeout 1200\n');
});

const fn = (path, qualifiedName, state, gap, expected, measured, coverage, crap) =>
  ({ path, qualifiedName, state, gap, crap, coverage, loaders: { expected, measured } });
const E2E = 'packages/cezar/test/e2e/release.test.ts';
const REPORT = {
  format: 'squeal-code-gate/1', verdict: 'incomplete',
  base: { ref: 'squeal-package-trial-base', commit: 'b'.repeat(40), policy: { coverageChildren: true } },
  head: { commit: 'c'.repeat(40), dirty: false, paths: [] },
  budget: { seconds: 1200, timedOut: false },
  functions: [
    fn('scripts/release.mjs', 'publish', 'pass', null, [E2E], [E2E], { lines: 7, covered: 7, share: 1 }, 5),
    fn(E2E, '<test>', 'pass', null, [E2E], [E2E], { lines: 4, covered: 4, share: 1 }, 2),
    fn('packages/cezar/src/release/stable.ts', 'plan', 'pass', null, ['packages/cezar/src/release/stable.test.ts'], [], { lines: 3, covered: 3, share: 1 }, 1),
    fn('scripts/release-smoke.mjs', 'smoke', 'incomplete', 'no-loader', [], [], null, null),
  ],
  uncounted: [],
  runs: [
    { runner: 'vitest', selected: ['packages/cezar/src/release/stable.test.ts'], completed: ['packages/cezar/src/release/stable.test.ts'],
      notFinished: [], failed: [], durationMs: 4200 },
    { runner: 'node-test', selected: [E2E, 'scripts/release-smoke.test.mjs'], completed: [E2E, 'scripts/release-smoke.test.mjs'],
      notFinished: [], failed: [], children: { read: 3, dropped: 0 }, durationMs: 81400,
      prepare: [{ project: 'test:package', command: ['npm', '--prefix', '../..', 'run', 'build'], outcome: 'passed', exit: 0, durationMs: 61600, notRun: [] }] },
  ],
  counts: { pass: 3, violation: 0, incomplete: 1, skipped: 0, accepted: 0 },
};
const COMMITS = { format: 'squeal-package-trial-commits/1', ref: 'origin/main', head: '1'.repeat(40), mergeBase: '2'.repeat(40),
  base: '3'.repeat(40), trial: '4'.repeat(40) };

function writeOut(directory, files) {
  const out = path.join(directory, 'squeal-package-trial');
  fs.mkdirSync(out, { recursive: true });
  for (const [name, content] of Object.entries(files)) fs.writeFileSync(path.join(out, name), typeof content === 'string' ? content : JSON.stringify(content));
}

test('the summary gives the commits, the verdict, each run with prepare and children, and the packaged functions', (t) => {
  const directory = sandbox(t);
  writeOut(directory, { 'commits.json': COMMITS, 'report.json': REPORT, 'exit-code': '3\n', seconds: '95\n' });
  const result = runStep(directory, step(ci().jobs[JOB], 'Report the trial'), { GATE: 'success' });
  assert.equal(result.status, 0, result.stderr);
  const lines = result.summary.split('\n');
  for (const line of [
    '## Squeal packaged test trial',
    `Measured: ${'1'.repeat(12)} against \`origin/main\`, merge base ${'2'.repeat(12)}. Local commits with the trial keys: base ${'3'.repeat(12)}, head ${'4'.repeat(12)}.`,
    'Verdict: **incomplete** (exit 3) in 95 s. Budget 1200 s, timed out: false. Child coverage read at the base: true.',
    'Changed functions: 4 (pass 3, violation 0, incomplete 1, skipped 0, accepted 0). Paths not counted: 0.',
    '- vitest: 1 selected, 1 completed, 0 not finished, 0 with a failed test; run time 4 s.',
    '- node-test: 2 selected, 2 completed, 0 not finished, 0 with a failed test; run time 81 s; child coverage files read 3, dropped 0.',
    '  - `prepare` of `test:package`: `npm --prefix ../.. run build`, passed, exit 0, 62 s; 0 selected files did not run because of it.',
    '| `scripts/release.mjs` `publish` | pass |  | 7/7 | 5 | `release.test.ts` |',
    '| `packages/cezar/test/e2e/release.test.ts` `<test>` | pass |  | 4/4 | 2 | `release.test.ts` |',
    '| `scripts/release-smoke.mjs` `smoke` | incomplete | no-loader |  |  |  |',
  ]) assert.ok(lines.includes(line), `missing: ${line}\n${result.summary}`);
  assert.doesNotMatch(result.summary, /stable\.ts/, 'a pass that no packaged test loads is left out');
});

test('without a report the summary says why; without trial commits it says the gate did not run', (t) => {
  const directory = sandbox(t);
  const s = step(ci().jobs[JOB], 'Report the trial');
  writeOut(directory, { 'commits.json': COMMITS, 'exit-code': '2\n', seconds: '4\n', 'stderr.txt': 'squeal code: --base squeal-package-trial-base: no such ref\n' });
  const failed = runStep(directory, s, { GATE: 'success' });
  assert.equal(failed.status, 0, failed.stderr);
  assert.match(failed.summary, /^No report: exit 2, a setup or usage error after 4 s\. The gate's last stderr lines:$/m);
  assert.match(failed.summary, /^squeal code: --base squeal-package-trial-base: no such ref$/m);
  const none = sandbox(t);
  const setup = 'pnpm success, Node.js failure, install skipped, Squeal skipped';
  const skipped = runStep(none, s, { GATE: 'skipped', SETUP: setup });
  assert.equal(skipped.status, 0, skipped.stderr);
  assert.match(skipped.summary, /^No trial commits: the step that builds them failed \(see its log\)\.$/m);
  // A failed setup step is named, so a skipped gate is never read as a trial result.
  assert.match(skipped.summary, /^No report: the gate did not run \(gate step: skipped; setup: pnpm success, Node\.js failure, install skipped, Squeal skipped\)\.$/m);
});

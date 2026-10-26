const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { main, parseArgs } = require('./mutants-run.cjs');
const { validateArtifact } = require('./mutants-report.cjs');
const fixture = require('./fixtures/mutants/stryker-report.json');

const HEAD = 'a'.repeat(40);
const FILE = 'packages/contract/src/attention.ts';
const DIFF_CONTRACT = `+++ b/${FILE}\n@@ -80,0 +81,20 @@\n`;
const DIFF_BOTH = `${DIFF_CONTRACT}+++ b/packages/web/src/routes/tasks.tsx\n@@ -1 +1,2 @@\n`;

/** Every side effect the orchestrator has, recorded, with the answers a test chooses. */
function harness({ diff = DIFF_CONTRACT, related = () => 4, stryker = async () => ({ outcome: 'exited', code: 0 }), report = () => fixture, clock = [0] } = {}) {
  const calls = [];
  const files = new Map();
  const outputs = new Map();
  let reportPresent = false;
  const deps = {
    git: args => { calls.push(['git', args.join(' ')]); return diff; },
    countRelated: async (name, list) => { calls.push(['related', name, list.map(f => f.file)]); return related(name); },
    stryker: async (name, args, ms) => {
      calls.push(['stryker', name, args, ms]);
      const result = await stryker(name, args, ms);
      reportPresent = result.outcome === 'exited' && report(name) !== null;
      return result;
    },
    removeReport: () => { calls.push(['removeReport']); reportPresent = false; },
    readReport: name => (reportPresent ? report(name) : null),
    restoreTree: () => calls.push(['restoreTree']),
    writeFile: (file, text) => files.set(file, text),
    appendSummary: text => files.set('summary', text),
    setOutput: (key, value) => outputs.set(key, value),
    now: () => clock[0],
    log: () => {},
  };
  return { deps, calls, files, outputs, clock };
}

const env = { PR_HEAD_SHA: HEAD, GITHUB_REPOSITORY: 'o/r', GITHUB_RUN_ID: '9' };
const artifactOf = h => JSON.parse(h.files.get('mutation-evidence/mutants.json'));

test('parseArgs reads the command and the two revisions, defaulting to the merge ref\'s first parent', () => {
  assert.deepEqual(parseArgs(['scope']), { command: 'scope', base: 'HEAD^1', head: 'HEAD' });
  assert.deepEqual(parseArgs(['run', '--base', 'abc', '--head', 'def']), { command: 'run', base: 'abc', head: 'def' });
  assert.throws(() => parseArgs(['mutate']), /scope or run/);
});

test('scope with no product line changed writes the no-lines artifact and asks for no install', async () => {
  const h = harness({ diff: '+++ b/docs/a.md\n@@ -1 +1 @@\n' });
  assert.equal(await main(['scope'], env, h.deps), 0);
  const written = artifactOf(h);
  assert.equal(written.state, 'no-mutable-lines');
  assert.equal(written.head, HEAD);
  assert.equal(h.outputs.get('has_work'), 'false');
  assert.deepEqual(validateArtifact(written).packages, []);
  assert.match(h.files.get('summary'), /No product source line changed/);
  assert.deepEqual(h.calls.map(c => c[0]), ['git']);
});

test('scope with product lines changed only says there is work', async () => {
  const h = harness();
  assert.equal(await main(['scope'], env, h.deps), 0);
  assert.equal(h.outputs.get('has_work'), 'true');
  assert.equal(h.files.has('mutation-evidence/mutants.json'), false);
  assert.match(h.calls[0][1], /diff -U0 --no-color --no-renames --diff-filter=AM HEAD\^1 HEAD -- packages/);
});

test('run mutates each package\'s changed lines once, with its own project, and writes an artifact the comment job accepts', async () => {
  const h = harness();
  assert.equal(await main(['run'], env, h.deps), 0);
  const stryker = h.calls.find(c => c[0] === 'stryker');
  assert.deepEqual(stryker.slice(1, 3), ['contract', [`${FILE}:81-100`]]);
  const written = artifactOf(h);
  assert.equal(written.state, 'ran');
  assert.equal(written.packages[0].state, 'completed');
  assert.equal(written.packages[0].relatedTests, 4);
  assert.equal(written.packages[0].counts.survived, 2);
  assert.doesNotThrow(() => validateArtifact(written));
  assert.match(h.files.get('summary'), /2 survived/);
  assert.match(h.files.get('summary'), /actions\/runs\/9/);
});

test('run clears the previous report before each Stryker run and restores the tree after it', async () => {
  const h = harness({ diff: DIFF_BOTH, related: () => 2 });
  await main(['run'], env, h.deps);
  const order = h.calls.map(c => c[0]).filter(name => name !== 'git' && name !== 'related');
  assert.deepEqual(order, ['removeReport', 'stryker', 'restoreTree', 'removeReport', 'stryker', 'restoreTree']);
});

test('a package over the changed-line budget is skipped before anything is counted or run', async () => {
  const h = harness({ diff: `+++ b/${FILE}\n@@ -1,0 +1,401 @@\n` });
  await main(['run'], env, h.deps);
  const [pack] = artifactOf(h).packages;
  assert.equal(pack.state, 'skipped');
  assert.match(pack.reason, /401 changed lines is over the budget of 400/);
  assert.deepEqual(h.calls.map(c => c[0]), ['git']);
});

test('a package whose tests are too many is skipped after they are counted, and the others still run', async () => {
  const h = harness({ diff: DIFF_BOTH, related: name => (name === 'web' ? 264 : 4) });
  await main(['run'], env, h.deps);
  const packs = Object.fromEntries(artifactOf(h).packages.map(p => [p.name, p]));
  assert.equal(packs.web.state, 'skipped');
  assert.match(packs.web.reason, /264 test files import the changed files, over the budget of 150/);
  assert.equal(packs.web.relatedTests, 264);
  assert.equal(packs.contract.state, 'completed');
  assert.deepEqual(h.calls.filter(c => c[0] === 'stryker').map(c => c[1]), ['contract']);
});

test('MUTANTS_* variables lift the budget for the timing probe', async () => {
  const h = harness({ related: () => 264 });
  await main(['run'], { ...env, MUTANTS_MAX_RELATED_TESTS: '0', MUTANTS_DEADLINE_MINUTES: '90' }, h.deps);
  assert.equal(artifactOf(h).packages[0].state, 'completed');
  assert.equal(h.calls.find(c => c[0] === 'stryker')[3], 90 * 60_000);
});

test('a failed count does not stop the run; the package runs with its tests unknown', async () => {
  const h = harness({ related: () => { throw new Error('vitest crashed'); } });
  await main(['run'], env, h.deps);
  const [pack] = artifactOf(h).packages;
  assert.equal(pack.state, 'completed');
  assert.equal(pack.relatedTests, null);
});

test('Stryker running past the deadline is stopped and reported, and the job still passes', async () => {
  const h = harness({ stryker: async () => ({ outcome: 'timed-out', code: null }) });
  assert.equal(await main(['run'], env, h.deps), 0);
  const [pack] = artifactOf(h).packages;
  assert.equal(pack.state, 'timed-out');
  assert.match(pack.reason, /35 minute/);
  assert.ok(h.calls.some(c => c[0] === 'restoreTree'));
});

test('Stryker failing without a report is an error with its exit code, not a failed job', async () => {
  const h = harness({ stryker: async () => ({ outcome: 'exited', code: 1 }), report: () => null });
  assert.equal(await main(['run'], env, h.deps), 0);
  const [pack] = artifactOf(h).packages;
  assert.equal(pack.state, 'error');
  assert.match(pack.reason, /exited with code 1 and wrote no report/);
});

test('the deadline is shared: a package that starts with no time left is skipped', async () => {
  const clock = [0];
  const h = harness({ diff: DIFF_BOTH, clock, stryker: async () => { clock[0] += 36 * 60_000; return { outcome: 'exited', code: 0 }; } });
  await main(['run'], env, h.deps);
  const packs = Object.fromEntries(artifactOf(h).packages.map(p => [p.name, p]));
  assert.equal(packs.contract.state, 'completed');
  assert.equal(packs.web.state, 'skipped');
  assert.match(packs.web.reason, /time budget/);
  assert.equal(packs.contract.durationMs, 36 * 60_000);
});

test('Stryker gets only the time that is left', async () => {
  const clock = [1000];
  const h = harness({ diff: DIFF_BOTH, clock, stryker: async () => { clock[0] += 10 * 60_000; return { outcome: 'exited', code: 0 }; } });
  await main(['run'], env, h.deps);
  const budgets = h.calls.filter(c => c[0] === 'stryker').map(c => c[3]);
  assert.deepEqual(budgets, [35 * 60_000, 25 * 60_000]);
});

test('the real CLI writes the no-lines artifact in a repository with no product change', t => {
  const dir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'mutants-run-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const git = (...args) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...args], { cwd: dir, encoding: 'utf8' });
  git('init', '-q');
  fs.mkdirSync(path.join(dir, 'docs'));
  fs.writeFileSync(path.join(dir, 'docs/a.md'), 'one\n');
  git('add', '.');
  git('commit', '-q', '-m', 'one');
  fs.writeFileSync(path.join(dir, 'docs/a.md'), 'two\n');
  git('commit', '-qam', 'two');
  const out = path.join(dir, 'github-output');
  const result = spawnSync(process.execPath, [path.join(__dirname, 'mutants-run.cjs'), 'scope', '--base', 'HEAD~1'], {
    cwd: dir, encoding: 'utf8', env: { PATH: process.env.PATH, GITHUB_OUTPUT: out, PR_HEAD_SHA: HEAD },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.readFileSync(out, 'utf8'), 'has_work=false\n');
  const written = JSON.parse(fs.readFileSync(path.join(dir, 'mutation-evidence/mutants.json'), 'utf8'));
  assert.equal(written.state, 'no-mutable-lines');
});

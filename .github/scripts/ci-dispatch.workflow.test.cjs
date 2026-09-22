const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { runInNewContext } = require('node:vm');
const yaml = require('yaml');
const root = path.resolve(__dirname, '../..');
const ci = () => yaml.parse(fs.readFileSync(path.join(root, '.github/workflows/ci.yml'), 'utf8'));
const HEAD = 'a'.repeat(40);
const BASE = 'b'.repeat(40);
const prFixture = () => ({ number: 42, state: 'open', changed_files: 1,
  user: { login: 'github-actions[bot]' },
  head: { sha: HEAD, ref: 'release/v1.2.3', repo: { full_name: 'owner/repo' } },
  base: { sha: BASE, ref: 'main', repo: { full_name: 'owner/repo' } },
});
function evaluate(value, context) {
  return typeof value === 'string' && value.startsWith('${{')
    ? runInNewContext(value.slice(3, -2), context) : value;
}
function classify(jobName, { pr = prFixture(), number = '42', apiFails = false, appLogin = '',
  files = [{ filename: 'packages/cezar/package.json' }], after = { version: '1.2.3' } } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ci-dispatch-'));
  fs.writeFileSync(path.join(dir, 'package.json'), '{"type":"commonjs"}');
  const context = { github: { event_name: 'workflow_dispatch', sha: HEAD,
    repository: 'owner/repo', token: '', head_ref: '', event: { pull_request: { head: {}, base: {}, user: {} } } },
    vars: { RELEASE_APP_BOT_LOGIN: appLogin }, inputs: { pr_number: number }, steps: {}, format: (s, n) => s.replace('{0}', n) };
  const env = { ...process.env, PATH: `${dir}:${process.env.PATH}`, GITHUB_WORKSPACE: dir,
    GITHUB_REPOSITORY: 'owner/repo', GITHUB_SHA: HEAD, FIXTURE: JSON.stringify({ pr, files, after, apiFails }) };
  fs.writeFileSync(path.join(dir, 'gh'), `#!/usr/bin/env node
const {spawnSync} = require('node:child_process');
const f = JSON.parse(process.env.FIXTURE);
if (f.apiFails) process.exit(1);
const args = process.argv.slice(2);
const endpoint = args.find(x => x.includes('repos/'));
let value;
if (endpoint.includes('/contents/')) {
 const json = endpoint.endsWith('ref=${BASE}') ? {version:'1.2.2'} : f.after;
 value = {content:Buffer.from(JSON.stringify(json)).toString('base64')};
} else if (endpoint.endsWith('/files')) value = args.includes('--slurp') ? [f.files] : f.files;
else value = f.pr;
const filter = args.indexOf('--jq');
if (filter >= 0) {
 const result = spawnSync('jq', ['-r', args[filter+1]], {input:JSON.stringify(value),encoding:'utf8'});
 process.stdout.write(result.stdout); process.exit(result.status);
}
process.stdout.write(JSON.stringify(value));
`);
  fs.chmodSync(path.join(dir, 'gh'), 0o755);
  try {
    const job = ci().jobs[jobName];
    assert.ok(job.steps.some(s => s.id === 'resolve-dispatch'), 'dispatch must resolve metadata before checkout');
    for (const step of job.steps) {
      if (step.if && !runInNewContext(step.if, context)) continue;
      if (step.uses?.startsWith('actions/checkout@')) {
        if (['build-and-package', 'vitest', 'cockpit-browser'].includes(jobName)) return evaluate(step.with.ref, context);
        assert.equal(evaluate(step.with.ref, context), BASE, 'classifier comes from API base, never dispatch head');
        fs.mkdirSync(path.join(dir, '.github/scripts'), { recursive: true });
        for (const name of ['release-bump-pr.cjs', 'change-surface.cjs']) {
          fs.copyFileSync(path.join(__dirname, name), path.join(dir, '.github/scripts', name));
        }
      }
      if (!step.run) continue;
      const output = path.join(dir, `${step.id}.output`);
      const stepEnv = Object.fromEntries(Object.entries(step.env || {}).map(([key, value]) => [key, String(evaluate(value, context) ?? '')]));
      const result = spawnSync('bash', ['-e', '-c', step.run], { cwd: dir, env: { ...env, ...stepEnv, GITHUB_OUTPUT: output }, encoding: 'utf8' });
      assert.equal(result.status, 0, result.stderr);
      context.steps[step.id] = { outputs: fs.existsSync(output)
        ? Object.fromEntries(fs.readFileSync(output, 'utf8').trim().split('\n').filter(Boolean).map(line => { const i = line.indexOf('='); return [line.slice(0, i), line.slice(i + 1)]; })) : {} };
    }
    return context.steps.classify.outputs;
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

test('dispatch validates the live release PR and runs the trusted version-stamp classifier', () => {
  for (const base of ['main', 'develop']) {
    const pr = prFixture(); pr.base.ref = base;
    assert.equal(classify('classify-pr', { pr }).bump_pr, 'true');
    assert.equal(classify('change-surface', { pr }).surface, 'full-matrix');
  }
});

test('dispatch metadata mismatches and missing inputs keep the full matrix', () => {
  const cases = [{ number: '' }, { number: '42/../43' }, { apiFails: true }];
  for (const mutate of [
    p => { p.head.sha = 'c'.repeat(40); }, p => { p.head.ref = 'feature'; },
    p => { p.user.login = 'human'; }, p => { p.base.ref = 'release'; },
    p => { p.head.repo.full_name = 'fork/repo'; }, p => { p.head.repo = null; },
    p => { p.base.repo.full_name = 'foreign/repo'; }, p => { p.base.sha = 'invalid'; },
    p => { p.state = 'closed'; },
  ]) { const pr = prFixture(); mutate(pr); cases.push({ pr }); }
  for (const options of cases) {
    assert.equal(classify('classify-pr', options).bump_pr, 'false', JSON.stringify(options));
    assert.equal(classify('change-surface', options).surface, 'full-matrix', JSON.stringify(options));
  }
});

test('dispatch cannot skip tests for incomplete lists, docs, code, or non-version manifest edits', () => {
  const incomplete = prFixture(); incomplete.changed_files = 2;
  for (const options of [
    { pr: incomplete }, { files: [] }, { files: [{ filename: 'README.md' }] },
    { files: [{ filename: 'packages/cezar/src/index.ts' }] },
    { after: { version: '1.2.3', scripts: { postinstall: 'untrusted' } } },
  ]) {
    assert.equal(classify('classify-pr', options).bump_pr, 'false');
    assert.equal(classify('change-surface', options).surface, 'full-matrix');
  }
});


test('verification uses a PR merge ref only after validating dispatch attribution', () => {
  const moved = prFixture(); moved.head.sha = 'c'.repeat(40);
  for (const job of ['build-and-package', 'vitest', 'cockpit-browser']) {
    assert.equal(classify(job), 'refs/pull/42/merge');
    for (const options of [{ pr: moved }, { number: '' }, { number: 'bad' }, { apiFails: true }]) {
      assert.equal(classify(job, options), HEAD, `${job}: ${JSON.stringify(options)}`);
    }
  }
});


test('dispatch uses the configured App author without normalizing arbitrary users to a bot', () => {
  const pr = prFixture(); pr.user.login = 'cezar-release[bot]';
  assert.equal(classify('classify-pr', { pr, appLogin: pr.user.login }).bump_pr, 'true');
  assert.equal(classify('classify-pr', { pr, appLogin: 'other[bot]' }).bump_pr, 'false');
  pr.user.login = 'human';
  assert.equal(classify('classify-pr', { pr, appLogin: 'human' }).bump_pr, 'false');
});

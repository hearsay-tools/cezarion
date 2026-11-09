const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { diffStats, missingPatches, checkPullRequest } = require('./missing-patches.cjs');
const fixtures = require('./fixtures/missing-patches/api.json');

test('recorded looping heads reject large modified and removed text files', () => {
  for (const fixture of fixtures.slice(0, 2)) {
    const reasons = missingPatches(fixture.files, new Map(), fixture.files.length);
    const absent = fixture.files.filter(file => !Object.hasOwn(file, 'patch'));
    assert.equal(reasons.length, absent.length);
    for (const file of absent) {
      assert.ok(reasons.some(reason => reason.includes(JSON.stringify(file.filename)) &&
        reason.includes(`${file.status}, +${file.additions}/-${file.deletions}`) && reason.includes('Split the PR')));
    }
  }
});

test('real binary and pure rename entries pass; normal patches pass', () => {
  const binary = fixtures[2].files[0];
  const rename = fixtures[3].files[0];
  const normal = fixtures[1].files.find(file => Object.hasOwn(file, 'patch'));
  const stats = diffStats(fixtures[2].numstat);
  assert.ok(stats.has(binary.filename));
  assert.deepEqual(missingPatches([binary, rename, normal], stats, 3), []);
  assert.equal(missingPatches([binary], new Map(), 1).length, 1);
  assert.equal(missingPatches([{ ...rename, additions: 1 }], new Map(), 1).length, 1);
  assert.deepEqual(missingPatches([{ ...rename, status: 'copied' }], new Map(), 1), []);
});

test('an incomplete or capped file list fails even with normal patches', () => {
  const normal = fixtures[1].files.find(file => Object.hasOwn(file, 'patch'));
  assert.match(missingPatches([normal], new Map(), 2)[0], /incomplete.*3000-file/);
  assert.match(missingPatches(Array(3000).fill(normal), new Map(), 3000)[0], /3000-file/);
});

test('Git numstat classifies bytes, including removed binary files and unusual paths', t => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'missing-patches-'));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe' });
  git('init');
  git('config', 'user.name', 'Test');
  git('config', 'user.email', 'test@example.invalid');
  const removed = 'removed text-name.txt';
  const added = 'binary\tline\n.txt';
  fs.writeFileSync(path.join(cwd, removed), Buffer.from([0, 1, 2]));
  fs.writeFileSync(path.join(cwd, 'text.png'), 'before\n');
  fs.writeFileSync(path.join(cwd, 'empty-removed'), '');
  fs.writeFileSync(path.join(cwd, 'mode-only'), 'unchanged\n');
  git('add', '--all');
  git('commit', '-m', 'base');
  const base = git('rev-parse', 'HEAD').trim();
  fs.unlinkSync(path.join(cwd, removed));
  fs.writeFileSync(path.join(cwd, added), Buffer.from([0, 3, 4]));
  fs.writeFileSync(path.join(cwd, 'text.png'), 'after\n');
  fs.unlinkSync(path.join(cwd, 'empty-removed'));
  fs.writeFileSync(path.join(cwd, 'empty-added'), '');
  fs.chmodSync(path.join(cwd, 'mode-only'), 0o755);
  git('add', '--all');
  git('commit', '-m', 'head');
  const stats = diffStats(git('diff', '--no-ext-diff', '--no-textconv', '--no-renames', '--numstat', '-z', `${base}...HEAD`));
  assert.deepEqual([added, removed].map(file => stats.get(file)), Array(2).fill({ added: '-', deleted: '-' }));
  assert.deepEqual(stats.get('text.png'), { added: '1', deleted: '1' });
  for (const [filename, status] of [['empty-added', 'added'], ['empty-removed', 'removed'], ['mode-only', 'modified']]) {
    assert.deepEqual(stats.get(filename), { added: '0', deleted: '0' });
    const file = { filename, status, additions: 0, deletions: 0 };
    assert.deepEqual(missingPatches([file], stats, 1), []);
    assert.equal(missingPatches([file], new Map(), 1).length, 1);
  }
});

test('PR check rejects missing patches without error annotations and detects revision changes', async t => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'missing-patches-api-'));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  t.after(() => { process.exitCode = 0; });
  const git = (...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe' });
  git('init');
  git('config', 'user.name', 'Test');
  git('config', 'user.email', 'test@example.invalid');
  git('commit', '--allow-empty', '-m', 'base');
  const sha = git('rev-parse', 'HEAD').trim();
  git('remote', 'add', 'origin', cwd);
  git('update-ref', 'refs/pull/1/head', sha);
  const pr = { number: 1, base: { sha, ref: 'main' }, head: { sha }, changed_files: 1 };
  const context = { sha, eventName: 'pull_request_target', repo: { owner: 'test', repo: 'repo' }, payload: { pull_request: pr } };
  const file = fixtures[0].files[0];
  const messages = [];
  const listFiles = () => {};
  const github = { rest: { pulls: { get: async () => ({ data: pr }), listFiles } },
    paginate: async (method, params) => {
      assert.equal(method, listFiles);
      assert.equal(params.per_page, 100);
      return [file];
    } };
  const core = { info: message => messages.push(message) };
  assert.equal((await checkPullRequest({ github, context, core, cwd })).length, 1);
  assert.equal(process.exitCode, 1);
  assert.ok(messages[0].includes(file.filename));
  process.exitCode = 0;
  github.rest.pulls.get = async () => ({ data: { ...pr, head: { sha: 'changed' } } });
  assert.match((await checkPullRequest({ github, context, core, cwd }))[0], /head or base changed/);
  assert.equal(process.exitCode, 1);
  process.exitCode = 0;
  let reads = 0;
  github.rest.pulls.get = async () => ({ data: ++reads === 1 ? pr : { ...pr, base: { sha: 'changed' } } });
  assert.match((await checkPullRequest({ github, context, core, cwd }))[0], /head or base changed/);
  assert.equal(reads, 2);
  assert.equal(process.exitCode, 1);
  process.exitCode = 0;
  for (const eventName of ['merge_group', 'push']) {
    assert.equal(await checkPullRequest({ github, context: { eventName, payload: {} }, core, cwd }), undefined);
  }
  github.rest.pulls.get = async () => ({ data: pr });
  assert.equal((await checkPullRequest({ github, context: { ...context, payload: {
    pull_request: { ...pr, base: { ...pr.base, ref: 'release/test' } },
  } }, core, cwd })).length, 1);
});

test('PR check accepts the real binary fixture before the PR ref exists across different base and head commits', async t => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'missing-patches-binary-'));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe' });
  git('init');
  git('config', 'user.name', 'Test');
  git('config', 'user.email', 'test@example.invalid');
  git('commit', '--allow-empty', '-m', 'base');
  const base = git('rev-parse', 'HEAD').trim();
  const binary = fixtures[2].files[0];
  fs.mkdirSync(path.dirname(path.join(cwd, binary.filename)), { recursive: true });
  fs.writeFileSync(path.join(cwd, binary.filename), Buffer.from([0, 1, 2]));
  git('add', '--all');
  git('commit', '-m', 'binary');
  const head = git('rev-parse', 'HEAD').trim();
  assert.notEqual(base, head);
  git('remote', 'add', 'origin', cwd);
  assert.throws(() => git('show-ref', '--verify', 'refs/pull/1/head'), /not a valid ref/);
  const pr = { number: 1, base: { sha: base, ref: 'main' }, head: { sha: head }, changed_files: 1 };
  const context = { sha: base, eventName: 'pull_request_target', repo: { owner: 'test', repo: 'repo' }, payload: { pull_request: pr } };
  const github = { rest: { pulls: { get: async () => ({ data: pr }), listFiles: () => {} } },
    paginate: async () => [binary] };
  const messages = [];
  assert.deepEqual(await checkPullRequest({ github, context, core: { info: line => messages.push(line) }, cwd }), []);
  assert.match(messages[0], /every changed text file/);
});

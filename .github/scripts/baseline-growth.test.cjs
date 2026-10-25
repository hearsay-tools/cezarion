const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync, spawnSync } = require('node:child_process');
const { compareBaseline, checkBaselineGrowth } = require('./baseline-growth.cjs');

const root = path.resolve(__dirname, '../..');
const formats = [
  'packages/cezar/src/test-wait-discipline.baseline.json',
  'packages/web/src/test/e2e-wait-discipline.baseline.json',
  'packages/web/src/test/search-params-discipline.baseline.json',
  'packages/web/src/test/card-2-contrast.baseline.json',
  '.github/agents-md.baseline.json',
];
for (const file of formats) {
  test(`pins growth and shrinkage for ${file}`, () => {
    const before = JSON.parse(fs.readFileSync(path.join(root, file), 'utf8'));
    assert.deepEqual(compareBaseline(before, structuredClone(before)), []);
    const after = structuredClone(before);
    const entries = Array.isArray(after) ? after : after.sites;
    if (entries) {
      entries.push(typeof entries[0] === 'string' ? 'new-site' : { ...entries[0], file: 'new.test.ts' });
      assert.ok(compareBaseline(before, after).length);
      entries.pop();
      entries.pop();
    } else {
      after.maxBytes++;
      assert.ok(compareBaseline(before, after).length);
      after.maxBytes -= 2;
    }
    assert.deepEqual(compareBaseline(before, after), []);
  });
}

test('numeric allowances cannot grow, entries can reorder, metadata can change', () => {
  const before = { $comment: 'old', sites: [{ file: 'a', count: 2 }, { file: 'b', count: 1 }] };
  assert.deepEqual(compareBaseline(before, { ...before, $comment: 'new', sites: [...before.sites].reverse() }), []);
  assert.deepEqual(compareBaseline(before, { sites: [{ file: 'a', count: 1 }] }), []);
  assert.ok(compareBaseline(before, { sites: [{ file: 'a', count: 3 }] }).length);
  assert.ok(compareBaseline(['a'], ['a', 'a']).length, 'duplicate entries also grow the allowance');
  assert.ok(compareBaseline({ max: 2 }, { max: 2, extra: 1 }).length);
  assert.ok(compareBaseline({ max: 2 }, { max: 'unlimited' }).length);
});

function repository(t) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'baseline-growth-'));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe' }).trim();
  git('init', '-q');
  const write = (file, content) => {
    fs.mkdirSync(path.dirname(path.join(cwd, file)), { recursive: true });
    fs.writeFileSync(path.join(cwd, file), content);
  };
  const commit = () => {
    git('add', '.');
    git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'fixture');
    return git('rev-parse', 'HEAD');
  };
  write('deep/space name.baseline.json', '{"max":2}');
  write('reader.test.cjs', "readFileSync('deep/space name.baseline.json')");
  return { cwd, git, write, commit, base: commit() };
}

test('git comparison discovers arbitrary paths, new files pass, and overrides only CI growth', (t) => {
  const r = repository(t);
  r.write('deep/space name.baseline.json', '{"max":3}');
  r.write('.hidden/new.baseline.json', '{"allowances":["first"]}');
  const head = r.commit();
  const input = { cwd: r.cwd, base: r.base, head };
  assert.match(checkBaselineGrowth(input).join('\n'), /space name/);
  assert.deepEqual(checkBaselineGrowth({ ...input, allowGrowth: true }), []);
  r.write('deep/space name.baseline.json', '{"max":1}');
  assert.deepEqual(checkBaselineGrowth({ ...input, head: r.commit() }), []);
});

test('deleted baselines require removing literal readers, even with the override', (t) => {
  const r = repository(t);
  fs.unlinkSync(path.join(r.cwd, 'deep/space name.baseline.json'));
  const head = r.commit();
  for (const allowGrowth of [false, true]) {
    assert.match(checkBaselineGrowth({ cwd: r.cwd, base: r.base, head, allowGrowth }).join('\n'), /reader.test.cjs/);
  }
  r.write('reader.test.cjs', '// removed reader');
  assert.deepEqual(checkBaselineGrowth({ cwd: r.cwd, base: r.base, head: r.commit() }), []);
});

test('invalid JSON fails closed, including new files and an override', (t) => {
  const r = repository(t);
  r.write('new.baseline.json', 'invalid');
  assert.throws(() => checkBaselineGrowth({ cwd: r.cwd, base: r.base, head: r.commit(), allowGrowth: true }));
});

test('the auto-merge gate calls the same comparison and never accepts a label override', () => {
  const source = fs.readFileSync(path.join(root, '.ai/skills/auto-merge/check.mjs'), 'utf8');
  assert.match(source, /import .*checkBaselineGrowth.*baseline-growth\.cjs/);
  assert.match(source, /checkBaselineGrowth\(\{ base, head \}\)/);
  assert.doesNotMatch(source, /allowGrowth: true/);
});

test('trusted PR gate uses live labels and head blobs, and refuses changed metadata', async (t) => {
  const { checkPullRequest } = require('./baseline-growth.cjs');
  const r = repository(t);
  r.write('deep/space name.baseline.json', '{"max":3}');
  r.write('.github/scripts/baseline-growth.cjs', 'throw new Error("head code must never run")');
  const head = r.commit();
  r.git('remote', 'add', 'origin', r.cwd);
  r.git('update-ref', 'refs/pull/42/head', head);
  const context = { eventName: 'pull_request_target', repo: { owner: 'owner', repo: 'repo' },
    payload: { pull_request: { number: 42, head: { sha: head }, base: { sha: r.base } } } };
  let pr = { head: { sha: head }, base: { sha: r.base }, labels: [] };
  const github = { rest: { pulls: { get: async () => ({ data: pr }) } } };
  const failures = [];
  const info = [];
  const core = { setFailed: message => failures.push(message), info: message => info.push(message) };
  const input = { github, context, core, cwd: r.cwd };
  await checkPullRequest(input);
  const failure = failures.pop();
  assert.match(failure, /number grew/);
  assert.match(failure, /add the baseline-growth label, then re-run the failed classify-pr job/);
  pr.labels = [{ name: 'baseline-growth' }];
  await checkPullRequest(input);
  assert.equal(failures.length, 0);
  assert.match(info.pop(), /owner merge/);
  r.git('checkout', '--detach', r.base);
  await checkPullRequest({ ...input, context: { ...context, eventName: 'workflow_dispatch',
    sha: head, payload: { inputs: { pr_number: '42' } } } });
  assert.match(info.pop(), /owner merge/);
  await assert.rejects(checkPullRequest({ ...input, context: { ...context, eventName: 'workflow_dispatch',
    payload: { inputs: { pr_number: 'bad' } } } }), /Invalid PR number/);
  pr.head.sha = 'a'.repeat(40);
  await assert.rejects(checkPullRequest(input), /PR changed/);
  pr.head.sha = head;
  pr.base.sha = 'b'.repeat(40);
  await assert.rejects(checkPullRequest(input), /PR changed/);
  pr.base.sha = r.base;
  r.git('update-ref', 'refs/pull/42/head', r.base);
  await assert.rejects(checkPullRequest(input), /changed during fetch/);
  await checkPullRequest({ ...input, context: { eventName: 'push' } });
});

test('duplicate site counts can reorder without consuming the wrong allowance', () => {
  assert.deepEqual(compareBaseline([{ file: 'a', count: 2 }, { file: 'a', count: 1 }],
    [{ file: 'a', count: 1 }, { file: 'a', count: 2 }]), []);
});

function autoMerge(r, head, title = 'ci: improve checks') {
  return spawnSync(process.execPath, [path.join(root, '.ai/skills/auto-merge/check.mjs'),
    '--title', title, '--base', r.base, '--head', head], { cwd: r.cwd, encoding: 'utf8' });
}

test('auto-merge rejects numeric growth and allows a shrinking baseline', (t) => {
  const r = repository(t);
  r.write('deep/space name.baseline.json', '{"max":3}');
  const growth = autoMerge(r, r.commit());
  assert.equal(growth.status, 1, growth.stderr);
  assert.match(growth.stdout, /ratchet baseline growth/);
  r.write('deep/space name.baseline.json', '{"max":1}');
  const shrink = autoMerge(r, r.commit());
  assert.equal(shrink.status, 0, shrink.stdout + shrink.stderr);
  r.write('.github/scripts/baseline-growth.cjs', '// guard changes need owner review');
  assert.match(autoMerge(r, r.commit()).stdout, /gate or test harness/);
});

test('CI permits a new ratchet, while auto-merge requires owner review of its starting debt', (t) => {
  const r = repository(t);
  r.write('new.baseline.json', '{"max":100}');
  const head = r.commit();
  assert.deepEqual(checkBaselineGrowth({ cwd: r.cwd, base: r.base, head }), []);
  const result = autoMerge(r, head);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout, /new ratchet baseline: new.baseline.json/);
});

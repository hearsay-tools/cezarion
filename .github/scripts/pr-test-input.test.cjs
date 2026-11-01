'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { resolvePrTestInput, attestationName } = require('./pr-test-input.cjs');
const MERGE = 'a'.repeat(40), BASE = 'b'.repeat(40), HEAD = 'c'.repeat(40), TREE = 'd'.repeat(40);
function fixture() {
  const s = { ref: { object: { sha: MERGE } }, merge: { sha: MERGE, parents: [{ sha: BASE }, { sha: HEAD }], tree: { sha: TREE } },
    head: { sha: HEAD, tree: { sha: TREE } }, compare: { status: 'ahead', merge_base_commit: { sha: BASE } }, calls: [] };
  const options = { owner: 'o', repo: 'r', pullNumber: 7, head: HEAD, workflowSha: BASE, headRepository: 'o/r',
    github: { request: async (route, args) => {
      s.calls.push({ route, args });
      if (s.failAt === s.calls.length) throw new Error('private error');
      let data;
      if (route.endsWith('/git/ref/{ref}')) data = s.ref;
      else if (route.endsWith('/compare/{basehead}')) data = s.compare;
      else data = args.commit_sha === s.merge.sha ? s.merge : s.head;
      return { data: structuredClone(data) };
    } } };
  return { s, options, run: () => resolvePrTestInput(options) };
}
test('pins an up-to-date same-repository PR to its immutable head and names its trusted attestation', async () => {
  const h = fixture(); assert.deepEqual(await h.run(), { sha: HEAD, reusable: true });
  assert.equal(attestationName(BASE, HEAD), `Attest PR test inputs / ${BASE} / ${HEAD}`);
  assert.ok(h.s.calls.every(c => c.args.request.timeout <= 10000));
});
for (const [name, mutate] of Object.entries({
  'fork': h => { h.options.headRepository = 'fork/r'; },
  'new main base': h => { h.s.merge.parents[0].sha = MERGE; },
  'unknown workflow': h => { h.options.workflowSha = ''; },
  'head tree differs': h => { h.s.head.tree.sha = BASE; },
  'wrong head commit': h => { h.s.head.sha = BASE; },
  'behind base': h => { h.s.compare.status = 'behind'; },
  'diverged base': h => { h.s.compare.merge_base_commit.sha = MERGE; },
  'missing comparison': h => { h.s.compare = {}; },
  'optional API error': h => { h.s.failAt = 3; },
})) test(`pins immutable merge and withholds attestation: ${name}`, async () => {
  const h = fixture(); mutate(h); assert.deepEqual(await h.run(), { sha: MERGE, reusable: false });
});
for (const [name, mutate] of Object.entries({
  'invalid head': h => { h.options.head = 'unknown'; },
  'invalid PR': h => { h.options.pullNumber = 0; },
  'missing merge ref': h => { h.s.ref = {}; },
  'moved head': h => { h.s.merge.parents[1].sha = MERGE; },
  'wrong merge commit': h => { h.s.merge.sha = HEAD; },
  'missing tree': h => { h.s.merge.tree = {}; },
  'invalid first parent': h => { h.s.merge.parents[0].sha = 'unknown'; },
  'one parent': h => { h.s.merge.parents.pop(); },
  'required API error': h => { h.s.failAt = 1; },
})) test(`unknown test input fails closed: ${name}`, async () => {
  const h = fixture(); mutate(h); await assert.rejects(h.run);
});
test('identical base/head comparison is eligible', async () => {
  const h = fixture(); h.s.compare.status = 'identical'; assert.equal((await h.run()).reusable, true);
});

test('real Git merge and squash commits can share the attested head tree with different identities', async t => {
  const fs = require('node:fs');
  const path = require('node:path');
  const { spawnSync } = require('node:child_process');
  const root = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'pr-test-input-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const git = (...args) => {
    const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr); return result.stdout.trim();
  };
  git('init', '-b', 'main'); git('config', 'user.email', 'fixture@example.invalid'); git('config', 'user.name', 'Fixture');
  fs.writeFileSync(path.join(root, 'input'), 'base'); git('add', 'input'); git('commit', '-m', 'base');
  const base = git('rev-parse', 'HEAD');
  fs.writeFileSync(path.join(root, 'input'), 'head'); git('commit', '-am', 'head');
  const head = git('rev-parse', 'HEAD'), tree = git('rev-parse', 'HEAD^{tree}');
  const merge = git('commit-tree', tree, '-p', base, '-p', head, '-m', 'PR merge');
  const squash = git('commit-tree', tree, '-p', base, '-m', 'Queue squash');
  assert.notEqual(merge, head); assert.notEqual(squash, head); assert.notEqual(merge, squash);
  assert.equal(git('rev-parse', `${squash}^{tree}`), tree);
  const h = fixture(); h.options.head = head; h.options.workflowSha = base;
  h.s.ref.object.sha = merge;
  h.s.merge = { sha: merge, tree: { sha: tree }, parents: [{ sha: base }, { sha: head }] };
  h.s.head = { sha: head, tree: { sha: tree } };
  h.s.compare.merge_base_commit.sha = git('merge-base', base, head);
  assert.deepEqual(await h.run(), { sha: head, reusable: true });
});

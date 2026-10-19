const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { readPinnedDiff, collectSnapshot, Gh } = require('./merge-recommendation-github.cjs');
const { snapshot } = require('./fixtures/merge-recommendation.cjs');

test('reads the full committed diff without following worktree files, symlinks or Git diff drivers', t => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'cez-merge-git-'));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
  git('init', '-q'); git('config', 'user.name', 'Test'); git('config', 'user.email', 'test@example.invalid');
  fs.writeFileSync(path.join(cwd, 'README.md'), 'tyop\n');
  git('add', '.'); git('commit', '-qm', 'base'); const baseSha = git('rev-parse', 'HEAD');
  fs.writeFileSync(path.join(cwd, 'README.md'), 'typo\n');
  git('add', '.'); git('commit', '-qm', 'head'); const headSha = git('rev-parse', 'HEAD');
  fs.writeFileSync(path.join(cwd, 'README.md'), 'uncommitted distraction\n');
  const result = readPinnedDiff({ cwd, baseSha, headSha });
  assert.deepEqual(result.files, [{ path: 'README.md', additions: 1, deletions: 1, status: 'modified', mode: '100644', modeChanged: false }]);
  assert.match(result.diff, /\+typo/); assert.doesNotMatch(result.diff, /distraction/);
  fs.unlinkSync(path.join(cwd, 'README.md')); fs.symlinkSync('elsewhere', path.join(cwd, 'README.md'));
  git('add', '.'); git('commit', '-qm', 'symlink');
  assert.equal(readPinnedDiff({ cwd, baseSha, headSha: git('rev-parse', 'HEAD') }).files[0].mode, '120000');
  assert.throws(() => readPinnedDiff({ cwd, baseSha: '--help', headSha }), /SHA/);
});

test('collects rule provenance and review state, and rejects mismatched full diff counts', async () => {
  const s = snapshot();
  const pr = { number: 1, title: 'Typo', body: '', state: 'open', draft: false, mergeable: true, mergeable_state: 'clean', additions: 1, deletions: 1, changed_files: 1,
    head: { sha: s.headSha, repo: { full_name: s.repository } }, base: { sha: s.baseSha, ref: 'main' } };
  const gh = {
    api: async (_method, route) => { if (route.includes('/git/ref/')) return { object: { sha: s.baseSha } }; assert.match(route, /pulls\/1$/); return pr; },
    pages: async route => {
      if (route.includes('/rules/branches/')) return [{ type: 'required_status_checks', parameters: { required_status_checks: s.requiredChecks.map(c => ({ context: c.name, integration_id: c.appId })) } }];
      if (route.includes('/check-runs')) return s.checks.map(c => ({ id: c.id, name: c.name, head_sha: c.headSha, status: c.status, conclusion: c.conclusion, app: { id: c.appId } }));
      throw new Error(route);
    },
    graphql: async () => ({ repository: { pullRequest: { reviewDecision: null, reviewThreads: { nodes: [], pageInfo: { hasNextPage: false } } } } }),
  };
  const args = { gh, repository: s.repository, number: 1, defaultBranch: 'main', policyCommit: s.policyCommit, trusted: true,
    diffReader: () => ({ files: s.files, diff: s.diff }) };
  const actual = await collectSnapshot(args);
  assert.equal(actual.complete, true); assert.equal(actual.openThreads, 0);
  assert.deepEqual(actual.requiredChecks, s.requiredChecks);
  pr.additions = 2;
  assert.equal((await collectSnapshot(args)).complete, false);
});

test('GitHub adapter bounds pagination and refuses missing pages instead of returning partial evidence', async () => {
  const gh = new Gh({ execute: (_command, args) => {
    const endpoint = args[1];
    if (endpoint.includes('page=1')) return JSON.stringify({ total_count: 2, check_runs: [{ id: 1 }] });
    return JSON.stringify({ total_count: 2, check_runs: [] });
  } });
  await assert.rejects(gh.pages('repos/o/r/commits/abc/check-runs', 'check_runs'), /incomplete/i);
});

test('every Git read in a pinned report uses the named attribute source, including nested files', t => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'cez-merge-pin-'));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
  const run = (...args) => execFileSync(realGit, args, { cwd, encoding: 'utf8' }).trim();
  run('init', '-q'); run('config', 'user.name', 'Test'); run('config', 'user.email', 'test@example.invalid');
  fs.mkdirSync(path.join(cwd, 'docs'));
  fs.writeFileSync(path.join(cwd, 'docs/page.md'), 'tyop\n');
  run('add', '.'); run('commit', '-qm', 'base'); const baseSha = run('rev-parse', 'HEAD');
  fs.writeFileSync(path.join(cwd, 'docs/page.md'), 'typo\n');
  run('add', '.'); run('commit', '-qm', 'head'); const headSha = run('rev-parse', 'HEAD');
  fs.writeFileSync(path.join(cwd, '.gitattributes'), '*.md -diff\n');
  const bin = path.join(cwd, 'bin'), log = path.join(cwd, 'calls.jsonl'); fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'git'), `#!${process.execPath}\nconst fs=require('node:fs');const cp=require('node:child_process');fs.appendFileSync(${JSON.stringify(log)},JSON.stringify(process.argv.slice(2))+'\\n');process.stdout.write(cp.execFileSync(${JSON.stringify(realGit)},process.argv.slice(2),{env:process.env}));\n`, { mode: 0o755 });
  const oldPath = process.env.PATH; process.env.PATH = `${bin}${path.delimiter}${oldPath}`;
  let result;
  try { result = readPinnedDiff({ cwd, baseSha, headSha }); } finally { process.env.PATH = oldPath; }
  assert.equal(result.files[0].path, 'docs/page.md'); assert.equal(result.files[0].mode, '100644');
  assert.equal(result.files[0].additions, 1);
  const calls = fs.readFileSync(log, 'utf8').trim().split('\n').map(line => JSON.parse(line));
  assert.ok(calls.length >= 6);
  for (const args of calls) assert.equal(args[0], `--attr-source=${headSha}`, JSON.stringify(args));
});

function collectorFixture() {
  const s = snapshot(), pr = { title: 'Typo', body: '', state: 'open', draft: false,
    mergeable: true, mergeable_state: 'clean', additions: 1, deletions: 1, changed_files: 1,
    head: { sha: s.headSha, repo: { full_name: s.repository } }, base: { sha: 'e'.repeat(40), ref: 'main' } };
  let liveBase = s.baseSha;
  const gh = {
    api: async (_method, route) => route.includes('/git/ref/') ? { object: { sha: liveBase } } : structuredClone(pr),
    pages: async route => route.includes('/rules/')
      ? [{ type: 'required_status_checks', parameters: { required_status_checks: s.requiredChecks.map(c => ({ context: c.name, integration_id: c.appId })) } }]
      : s.checks.map(c => ({ id: c.id, name: c.name, head_sha: c.headSha, status: c.status, conclusion: c.conclusion, app: { id: c.appId } })),
    graphql: async () => ({ repository: { pullRequest: { reviewDecision: null, reviewThreads: { nodes: [], pageInfo: { hasNextPage: false } } } } }),
  };
  return { s, pr, gh, setBase: value => { liveBase = value; }, args: { gh, repository: s.repository, number: 1, defaultBranch: 'main', policyCommit: s.policyCommit, trusted: true,
    diffReader: () => ({ files: s.files, diff: s.diff }) } };
}

test('pins the live target branch rather than GitHub stale pull-request base metadata', async () => {
  const f = collectorFixture(); let readBase;
  f.args.diffReader = args => { readBase = args.baseSha; return { files: f.s.files, diff: f.s.diff }; };
  const actual = await collectSnapshot(f.args);
  assert.equal(actual.baseSha, f.s.baseSha);
  assert.equal(readBase, f.s.baseSha);
  assert.equal(actual.complete, true);
});

test('invalidates evidence if the head, live base or draft state changes during collection', async () => {
  for (const change of ['head', 'base', 'draft']) {
    const f = collectorFixture(), pages = f.gh.pages;
    f.gh.pages = async route => {
      if (route.includes('/check-runs')) {
        if (change === 'head') f.pr.head.sha = 'd'.repeat(40);
        if (change === 'base') f.setBase('d'.repeat(40));
        if (change === 'draft') f.pr.draft = true;
      }
      return pages(route);
    };
    const actual = await collectSnapshot(f.args);
    assert.equal(actual.complete, false, change);
    assert.match(actual.error, /changed/i);
  }
});

test('invalidates readiness evidence changed while review pages are being collected', async () => {
  for (const change of ['checks', 'rules', 'thread', 'review']) {
    const f = collectorFixture(); let page = 0;
    f.gh.graphql = async () => {
      page++;
      if (page === 1) return { repository: { pullRequest: { reviewDecision: null,
        reviewThreads: { nodes: Array.from({ length: 100 }, () => ({ isResolved: true })),
          pageInfo: { hasNextPage: true, endCursor: 'earlier-threads' } } } } };
      if (page === 2) {
        if (change === 'checks') f.s.checks[0].conclusion = 'failure';
        if (change === 'rules') f.s.requiredChecks.push({ name: 'New required check', appId: 15368 });
        // A new thread can be inserted into an earlier page after we read it.
        return { repository: { pullRequest: { reviewDecision: null,
          reviewThreads: { nodes: [], pageInfo: { hasNextPage: false } } } } };
      }
      return { repository: { pullRequest: { reviewDecision: change === 'review' ? 'CHANGES_REQUESTED' : null,
        reviewThreads: { nodes: change === 'thread' ? [{ isResolved: false }] : [],
          pageInfo: { hasNextPage: false } } } } };
    };
    const actual = await collectSnapshot(f.args);
    assert.equal(actual.complete, false, change);
    assert.match(actual.error, /changed/i, change);
  }
});

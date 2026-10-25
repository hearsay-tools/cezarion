const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const yaml = require('yaml');
const { readHistory, countPairs, renderReport, updateTrackingIssue, isTestFile, TRACKING_TITLE, TRACKING_MIN_SHARED, ISSUE_MAX_BYTES, cliOptions } = require('./change-coupling.cjs');
const now = new Date('2026-10-25T12:00:00Z');
const fixture = require('./fixtures/change-coupling/history.json');

function historyRepo(t) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'coupling-'));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
  git('init', '--quiet');
  const shas = fixture.map((entry, i) => {
    for (const file of entry.files) {
      fs.mkdirSync(path.dirname(path.join(cwd, file)), { recursive: true });
      fs.writeFileSync(path.join(cwd, file), String(i));
    }
    git('add', '.');
    execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid',
      'commit', '--quiet', '-m', `fixture ${i}`], { cwd, env: {
      ...process.env, GIT_AUTHOR_DATE: entry.date, GIT_COMMITTER_DATE: entry.date,
    } });
    return git('rev-parse', 'HEAD');
  });
  return { cwd, shas };
}

test('fixture git history pins 90-day cutoff, counts, degree and latest shared commit', t => {
  const { cwd, shas } = historyRepo(t);
  const commits = readHistory({ cwd, now });
  assert.equal(commits.length, 5);
  const pairs = countPairs(commits);
  const ab = pairs.find(p => p.a === 'src/a.ts' && p.b === 'src/b.ts');
  assert.deepEqual(ab, { a: 'src/a.ts', b: 'src/b.ts', countA: 4, countB: 3,
    shared: 2, degree: 2 / 3, latest: shas[0] });
  assert.ok(pairs.some(p => p.a === 'src/a.ts' && p.b === 'src/boundary.ts'));
  assert.ok(!JSON.stringify(pairs).includes('old.ts'));
  assert.ok(!JSON.stringify(pairs).includes('a.test.ts'));
  const output = execFileSync(process.execPath, [path.join(__dirname, 'change-coupling.cjs')], { cwd, encoding: 'utf8' });
  assert.match(output, /Shared commits/);
});

test('raw path cap applies before test exclusion; paths count once per commit', () => {
  const boundary = ['a', 'b', ...Array.from({ length: 23 }, (_, i) => `test/${i}.ts`)];
  const pairs = countPairs([
    { sha: 'one', timestamp: 1, files: boundary },
    { sha: 'two', timestamp: 2, files: [...boundary, 'test/extra.ts'] },
    { sha: 'three', timestamp: 3, files: ['a', 'a', 'b'] },
  ]);
  assert.deepEqual(pairs, [{ a: 'a', b: 'b', countA: 2, countB: 2, shared: 2, degree: 1, latest: 'three' }]);
});

test('test file conventions are excluded without excluding production test helpers by substring', () => {
  for (const file of ['x.test.cjs', 'x.spec.tsx', 'x.e2e.ts', 'test/a.ts', 'tests/a.ts',
    'src/__tests__/a.ts', 'src/__fixtures__/a.json', 'fixtures/a.json', 'src/a.testkit.ts', 'e2e/a.ts']) {
    assert.equal(isTestFile(file), true, file);
  }
  for (const file of ['src/latest.ts', 'src/testable.ts', 'src/testing.ts']) assert.equal(isTestFile(file), false, file);
});

test('report filters strictly above 50%, links commits and escapes unusual paths', () => {
  const pairs = countPairs([
    { sha: 'a'.repeat(40), timestamp: 1, files: ['a|odd`\n.ts', 'b', 'c'] },
    { sha: 'b'.repeat(40), timestamp: 2, files: ['b', 'c'] },
    { sha: 'c'.repeat(40), timestamp: 3, files: ['b'] },
    { sha: 'd'.repeat(40), timestamp: 4, files: ['c'] },
  ]);
  const report = renderReport(pairs, { repository: 'owner/repo', minimum: 0.5 });
  assert.match(report, /https:\/\/github.com\/owner\/repo\/commit\//);
  assert.match(report, /a&#124;odd&#96; .ts/);
  assert.match(report, /66\.7%/);
  assert.match(renderReport([{ ...pairs[0], degree: 0.5 }], { minimum: 0.5 }), /No file pairs/);
  assert.match(renderReport([]), /No file pairs/);
});

test('pair sorting is deterministic by degree, shared count and paths', () => {
  const commits = [
    { sha: 'a', timestamp: 1, files: ['z', 'b', 'a'] },
    { sha: 'b', timestamp: 2, files: ['a', 'b'] },
  ];
  assert.deepEqual(countPairs(commits).map(p => [p.a, p.b]), [['a', 'b'], ['a', 'z'], ['b', 'z']]);
});

function mockGithub(issues) {
  const calls = [];
  return { calls, github: {
    paginate: async (route, args) => { calls.push(['list', args]); return issues; },
    rest: { issues: {
      listForRepo: 'list',
      update: async args => { calls.push(['update', args]); return { data: { html_url: 'existing' } }; },
      create: async args => { calls.push(['create', args]); return { data: { html_url: 'new' } }; },
    } },
  } };
}

test('updater reuses oldest exact tracking issue, including closed issues; ignores PRs', async () => {
  const { github, calls } = mockGithub([
    { number: 1, title: TRACKING_TITLE, pull_request: {} },
    { number: 4, title: TRACKING_TITLE, state: 'open' },
    { number: 3, title: TRACKING_TITLE, state: 'closed' },
    { number: 2, title: `prefix ${TRACKING_TITLE}` },
  ]);
  assert.equal(await updateTrackingIssue({ github, owner: 'o', repo: 'r', body: 'report' }), 'existing');
  assert.equal(calls[0][1].state, 'all');
  assert.deepEqual(calls[1], ['update', { owner: 'o', repo: 'r', issue_number: 3, state: 'open', body: 'report' }]);
});

test('updater creates only on first run and propagates API errors', async () => {
  const { github, calls } = mockGithub([]);
  assert.equal(await updateTrackingIssue({ github, owner: 'o', repo: 'r', body: 'empty' }), 'new');
  assert.equal(calls[1][1].title, TRACKING_TITLE);
  github.paginate = async () => { throw new Error('API unavailable'); };
  await assert.rejects(updateTrackingIssue({ github, owner: 'o', repo: 'r', body: '' }), /API unavailable/);
  assert.equal(calls.length, 2);
});

test('weekly workflow pins trusted full history, least permissions and serialized issue updates', () => {
  const workflow = yaml.parse(fs.readFileSync(path.join(__dirname, '../workflows/change-coupling.yml'), 'utf8'));
  assert.deepEqual(workflow.on.schedule, [{ cron: '37 6 * * 1' }]);
  assert.equal(workflow.concurrency['cancel-in-progress'], false);
  const job = workflow.jobs.report;
  assert.match(job.if, /github.event.repository.default_branch/);
  assert.deepEqual(job.permissions, { contents: 'read', issues: 'write' });
  const checkout = job.steps.find(s => s.uses?.startsWith('actions/checkout@'));
  assert.equal(checkout.with['fetch-depth'], 0);
  assert.equal(checkout.with['persist-credentials'], false);
  const generator = job.steps.find(s => s.name === 'Generate reports');
  const publisher = job.steps.find(s => s.name === 'Update tracking issue');
  assert.match(generator.with.script, /--minimum-shared/);
  assert.match(generator.with.script, /TRACKING_MIN_SHARED/);
  assert.match(generator.with.script, /ISSUE_MAX_BYTES/);
  assert.match(generator.with.script, /minimum: 0.5/);
  const upload = job.steps.find(s => s.uses?.startsWith('actions/upload-artifact@'));
  assert.equal(upload.with.name, 'change-coupling-report');
  assert.equal(upload.with['retention-days'], 90);
  assert.ok(job.steps.indexOf(upload) < job.steps.indexOf(publisher));
  assert.match(publisher.with.script, /change-coupling.cjs/);
  assert.match(publisher.with.script, /updateTrackingIssue/);
});


test('tracking report floor and byte cap retain links and explain omitted pairs', () => {
  assert.equal(TRACKING_MIN_SHARED, 3);
  assert.equal(ISSUE_MAX_BYTES, 60000);
  const pairs = Array.from({ length: 1000 }, (_, i) => ({
    a: `src/${i}-é.ts`, b: 'src/b.ts', shared: 3, countA: 3, countB: 4,
    degree: 1, latest: 'a'.repeat(40),
  }));
  const options = { repository: 'owner/repo', minimum: 0.5, minimumShared: TRACKING_MIN_SHARED,
    maxBytes: ISSUE_MAX_BYTES, runUrl: 'https://github.com/owner/repo/actions/runs/123' };
  const report = renderReport([...pairs, { ...pairs[0], shared: 2, a: 'excluded.ts' }], options);
  assert.ok(Buffer.byteLength(report) <= ISSUE_MAX_BYTES);
  assert.match(report, /Minimum shared commits: 3/);
  assert.match(report, /omitted to fit/);
  assert.match(report, /actions\/runs\/123/);
  assert.match(report, /commit\/aaaaaaaa/);
  assert.doesNotMatch(report, /excluded.ts/);
  assert.match(renderReport([{ ...pairs[0], shared: 2 }]), /2 .*100.0%/);
});

test('CLI floor is opt-in, validates options and preserves all-pairs default', () => {
  assert.deepEqual(cliOptions([]), {});
  assert.deepEqual(cliOptions(['--minimum-shared', '3', '--minimum-degree', '0.5',
    '--max-bytes', '60000', '--repository', 'o/r', '--run-url', 'https://github.com/o/r/actions/runs/1']), {
    minimumShared: 3, minimum: 0.5, maxBytes: 60000, repository: 'o/r', runUrl: 'https://github.com/o/r/actions/runs/1',
  });
  for (const args of [['--unknown', '1'], ['--minimum-shared'], ['--minimum-shared', 'nan'], ['--max-bytes', '-1']]) {
    assert.throws(() => cliOptions(args));
  }
});

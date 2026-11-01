const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const weekly = require('./mutants-weekly.cjs');
const { fakeGithub } = require('./mutants-github.testkit.cjs');

const { productFile, artifactName, parseNumstat, selectFiles, plan, cli, readResult, classify, comparison, renderIssue,
  syncIssues, findEarlier, renderSummary, publish, marker, CAP, MAX_BODY } = weekly;
const HEAD = 'a'.repeat(40);
const OLD = 'b'.repeat(40);
const RUN_URL = 'https://github.test/o/r/actions/runs/9';

const survivor = (line, fn = 'decide', extra = {}) => ({ file: 'packages/cezar/src/a.ts', line, function: fn, kind: 'Condition', mutator: 'ConditionalExpression', original: `x > ${line}`, replacement: 'true', status: 'Survived', ...extra });
function result(file = 'packages/cezar/src/a.ts', { fail = [], survivors = [], guards = [], consumers, version = 2, ...extra } = {}) {
  const names = ['logic score', 'covered lines', ...guards.map(g => g.name)];
  return { version, file, head: HEAD, tier: 'logic', score: 80, rawScore: 79, counts: { killed: 8, timeout: 0, survived: 2, noCoverage: 0, error: 0, ignored: 0 },
    survivors, guards, staleEquivalent: [], ambiguousEquivalent: [], multipleEquivalent: [],
    targets: names.map(name => ({ name, pass: !fail.includes(name) })), ...(consumers ? { consumers } : {}), ...extra };
}

test('a product file is a TypeScript source under packages/<pkg>/src, never a test, spec, testkit or declaration', () => {
  for (const file of ['packages/cezar/src/a.ts', 'packages/web/src/routes/b.tsx', 'packages/contract/src/waits.ts', 'packages/api-client/src/x/y.ts']) assert.equal(productFile(file), true, file);
  for (const file of ['packages/cezar/src/a.test.ts', 'packages/web/src/b.test.tsx', 'packages/web/e2e/c.e2e.ts', 'packages/web/src/c.e2e.ts',
    'packages/cezar/src/run.testkit.ts', 'packages/cezar/src/types.d.ts', 'packages/cezar/scripts/a.ts', 'packages/cezar/src/a.mjs',
    'packages/cezar/src/../x.ts', '.github/scripts/a.ts', 'packages/cezar/test/a.ts']) assert.equal(productFile(file), false, file);
});

test('artifact names are safe for upload-artifact and differ for paths that map to the same characters', () => {
  const a = artifactName('packages/web/src/a-b/c.tsx');
  assert.match(a, /^mutants-weekly-file-[\w.-]+$/);
  assert.notEqual(artifactName('packages/web/src/a/b.ts'), artifactName('packages/web/src/a_b.ts'));
  assert.equal(artifactName('packages/web/src/a/b.ts'), artifactName('packages/web/src/a/b.ts'));
});

test('numstat lines add up per file, a binary row counts zero and other lines are ignored', () => {
  const changed = parseNumstat('\n3\t2\tpackages/cezar/src/a.ts\n\n10\t0\tpackages/cezar/src/b.ts\n1\t4\tpackages/cezar/src/a.ts\n-\t-\tpackages/web/src/i.png\n');
  assert.deepEqual([...changed], [['packages/cezar/src/a.ts', 10], ['packages/cezar/src/b.ts', 10], ['packages/web/src/i.png', 0]]);
});

test('selection takes every target first in file order, then changed product files by changed lines, then path, up to the cap', () => {
  const targets = ['packages/cezar/src/t2.ts', 'packages/cezar/src/t1.ts', 'packages/cezar/src/gone.ts'];
  const changed = new Map([
    ['packages/cezar/src/small.ts', 2], ['packages/web/src/big.tsx', 50], ['packages/cezar/src/b.ts', 7], ['packages/cezar/src/a.ts', 7],
    ['packages/cezar/src/t1.ts', 99], ['packages/cezar/src/a.test.ts', 500], ['packages/cezar/src/k.testkit.ts', 500], ['packages/cezar/src/x.d.ts', 500],
    ['packages/cezar/src/deleted.ts', 400], ['packages/cezar/src/touched.ts', 0], ['docs/a.md', 900],
  ]);
  const tracked = new Set([...changed.keys(), ...targets].filter(file => !/deleted|gone/.test(file)));
  const picked = selectFiles({ targets, changed, tracked, cap: 5 });
  assert.deepEqual(picked.selected.map(e => [e.file, e.reason]), [
    ['packages/cezar/src/t2.ts', 'target'], ['packages/cezar/src/t1.ts', 'target'],
    ['packages/web/src/big.tsx', 'changed'], ['packages/cezar/src/a.ts', 'changed'], ['packages/cezar/src/b.ts', 'changed'],
  ]);
  assert.deepEqual(picked.cut.map(e => [e.file, e.lines]), [['packages/cezar/src/small.ts', 2]]);
  assert.deepEqual(picked.skipped, [{ file: 'packages/cezar/src/gone.ts', reason: 'not at head' }]);
  assert.ok(picked.selected.every(e => e.artifact === artifactName(e.file)));
  assert.equal(CAP, 64);
  const many = Array.from({ length: 70 }, (_, i) => `packages/cezar/src/t${String(i).padStart(2, '0')}.ts`);
  const all = selectFiles({ targets: many, changed: new Map([['packages/cezar/src/z.ts', 1]]), tracked: new Set([...many, 'packages/cezar/src/z.ts']) });
  assert.equal(all.selected.length, 64);
  assert.deepEqual(all.cut.map(e => e.file), [...many.slice(64), 'packages/cezar/src/z.ts']);
});

test('the plan reads the head, its tracked files and seven days of main history through git', () => {
  const calls = [];
  const git = args => {
    calls.push(args);
    if (args[0] === 'rev-parse') return `${HEAD}\n`;
    if (args[0] === 'ls-tree') return 'packages/cezar/src/t.ts\npackages/cezar/src/c.ts\n';
    return '4\t1\tpackages/cezar/src/c.ts\n';
  };
  const result = plan({ git, now: new Date('2026-11-07T03:41:00Z'), targets: ['packages/cezar/src/t.ts'] });
  assert.equal(result.head, HEAD);
  assert.equal(result.since, '2026-10-31T03:41:00.000Z');
  assert.deepEqual(result.selected.map(e => e.file), ['packages/cezar/src/t.ts', 'packages/cezar/src/c.ts']);
  assert.deepEqual(calls.find(args => args[0] === 'log'), ['log', '--no-renames', '--numstat', '--format=', '--since=2026-10-31T03:41:00.000Z', HEAD, '--', 'packages']);
  assert.deepEqual(calls.find(args => args[0] === 'ls-tree'), ['ls-tree', '-r', '--name-only', HEAD]);
});

test('the plan command writes plan.json and the matrix, head and count outputs', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mutants-weekly-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const output = path.join(dir, 'output');
  const git = args => args[0] === 'rev-parse' ? HEAD : args[0] === 'ls-tree' ? Object.keys(require('../mutants/targets.json')).join('\n') : '';
  const logs = [];
  cli(['plan', '--out', path.join(dir, 'plan')], { git, now: () => new Date('2026-11-07T00:00:00Z'), env: { GITHUB_OUTPUT: output }, log: line => logs.push(line) });
  const written = JSON.parse(fs.readFileSync(path.join(dir, 'plan', 'plan.json'), 'utf8'));
  assert.equal(written.version, 1);
  assert.deepEqual(written.selected.map(e => e.file), Object.keys(require('../mutants/targets.json')));
  const lines = fs.readFileSync(output, 'utf8').trim().split('\n');
  const matrix = JSON.parse(lines.find(line => line.startsWith('matrix=')).slice('matrix='.length));
  assert.deepEqual(matrix.include[0], { file: written.selected[0].file, artifact: written.selected[0].artifact });
  assert.ok(lines.includes(`head=${HEAD}`));
  assert.ok(lines.includes(`count=${written.selected.length}`));
  assert.throws(() => cli(['measure'], {}), /Usage/);
  assert.throws(() => cli(['plan', '--outside', 'x'], {}), /Usage/);
});

test('the default plan dependencies run git, read the clock and print', t => {
  const deps = weekly.cliDeps();
  assert.match(deps.git(['--version']), /^git version/);
  assert.ok(deps.now() instanceof Date);
  assert.equal(deps.env, process.env);
  const printed = [];
  t.mock.method(console, 'log', line => printed.push(line));
  deps.log('hello');
  assert.deepEqual(printed, ['hello']);
});

function resultDir(t, entries) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mutants-weekly-files-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  for (const [file, text] of entries) {
    fs.mkdirSync(path.join(dir, artifactName(file)), { recursive: true });
    fs.writeFileSync(path.join(dir, artifactName(file), 'result.json'), typeof text === 'string' ? text : JSON.stringify(text));
  }
  return dir;
}
const entry = file => ({ file, artifact: artifactName(file), reason: 'target', lines: 0 });

test('a result counts only when it is version 2, for the planned file and head; anything else is not measured', t => {
  const file = 'packages/cezar/src/a.ts';
  const cases = [
    [null, /no result/],
    ['{"version": 2,', /unreadable/],
    [result(file, { version: 1 }), /version 1/],
    [result('packages/cezar/src/other.ts'), /another file/],
    [{ ...result(file), head: OLD }, /another head/],
    [{ ...result(file), targets: 'x' }, /unexpected shape/],
  ];
  for (const [content, reason] of cases) {
    const dir = resultDir(t, content === null ? [] : [[file, content]]);
    const read = readResult(dir, entry(file), HEAD);
    assert.equal(read.result, undefined);
    assert.match(read.reason, reason);
    assert.deepEqual(classify(entry(file), read), { file, entryReason: 'target', state: 'not-measured', reason: read.reason });
  }
  const dir = resultDir(t, [[file, result(file)]]);
  assert.equal(readResult(dir, entry(file), HEAD).result.file, file);
});

test('every target passing is a pass; a failed target or failed contract consumer tests are a miss', () => {
  const file = 'packages/contract/src/w.ts';
  assert.equal(classify(entry(file), { result: result(file) }).state, 'passed');
  const missed = classify(entry(file), { result: result(file, { fail: ['covered lines'] }) });
  assert.equal(missed.state, 'missed');
  assert.deepEqual(missed.failures, ['covered lines']);
  const consumers = classify(entry(file), { result: result(file, { consumers: { state: 'failed', reason: 'Stryker failed: exited, exit 1', tests: [] } }) });
  assert.equal(consumers.state, 'missed');
  assert.deepEqual(consumers.failures, ['consumer tests: failed — Stryker failed: exited, exit 1']);
  assert.equal(classify(entry(file), { result: result(file, { consumers: { state: 'merged', tests: ['x'] } }) }).state, 'passed');
});

test('the comparison uses compareResults when an earlier version 2 result exists, and says so when none or no comparable one does', () => {
  const file = 'packages/cezar/src/a.ts';
  assert.deepEqual(comparison(undefined, result(file)), { kind: 'none' });
  assert.deepEqual(comparison({ ...result(file), version: 1 }, result(file)), { kind: 'incomparable', version: 1 });
  assert.deepEqual(comparison({ ...result('packages/cezar/src/b.ts') }, result(file)), { kind: 'incomparable', reason: 'Comparison needs the same result version and file' });
  const before = { ...result(file, { survivors: [survivor(1), survivor(2)] }), score: 70, head: OLD };
  const after = result(file, { survivors: [survivor(2), survivor(3)] });
  const compared = comparison(before, after);
  assert.equal(compared.kind, 'compared');
  assert.equal(compared.head, OLD);
  assert.equal(compared.change.score, 10);
  assert.deepEqual(compared.change.added.map(m => m.line), [3]);
  assert.deepEqual(compared.change.removed.map(m => m.line), [1]);
});

test('the issue body holds the marker, file, head, run, PASS and FAIL lines, the change, guard survivors and equivalent entries', () => {
  const file = 'packages/cezar/src/a.ts';
  const res = result(file, {
    fail: ['covered lines', 'decide'], survivors: [survivor(4)],
    guards: [{ name: 'decide', found: true, survivors: [survivor(4)] }, { name: 'gone', found: false, survivors: [] }, { name: 'ok', found: true, survivors: [] }],
    consumers: { state: 'failed', reason: 'boom', tests: [] },
  });
  res.staleEquivalent = [{ file, function: 'f', mutator: 'BlockStatement', original: '{ a }', replacement: '{}', reason: 'r' }];
  res.ambiguousEquivalent = [{ file, function: 'dup', mutator: 'BooleanLiteral', original: 'true', replacement: 'false', reason: 'r' }];
  res.multipleEquivalent = [{ file, function: 'm', mutator: 'StringLiteral', original: "'a'", replacement: '""', reason: 'r', matchCount: 3 }];
  const outcome = classify(entry(file), { result: res });
  const body = renderIssue({ outcome, earlier: { kind: 'none' }, head: HEAD, runUrl: RUN_URL });
  assert.ok(body.startsWith(marker(file)));
  for (const text of [`\`${file}\``, `\`${HEAD}\``, RUN_URL, 'PASS: logic score', 'FAIL: covered lines', 'FAIL: decide', 'PASS: ok',
    'FAIL: consumer tests: failed — boom', 'No earlier result.', '`decide`: 1 undetected', 'L4 Condition / ConditionalExpression',
    '`gone`: not found', 'Stale', 'Ambiguous', 'more than one mutant (3)', 'Fixes #']) assert.ok(body.includes(text), text);
  assert.ok(!body.includes('`ok`:'), 'a guard with no survivors gets no line');
  assert.match(renderIssue({ outcome, earlier: { kind: 'incomparable', version: 1 }, head: HEAD, runUrl: RUN_URL }), /No comparable earlier result: it has result version 1, this run has version 2\./);
  assert.match(renderIssue({ outcome, earlier: { kind: 'incomparable', reason: 'bad' }, head: HEAD, runUrl: RUN_URL }), /No comparable earlier result: bad\./);
  const earlierResult = result(file, { survivors: [survivor(9)] });
  const compared = comparison({ ...earlierResult, head: OLD, score: 75, counts: { ...earlierResult.counts, killed: 6, survived: 3 } }, res);
  const withChange = renderIssue({ outcome, earlier: compared, head: HEAD, runUrl: RUN_URL });
  assert.match(withChange, /Earlier result at `bbbbbbb`: counted score \+5\.0 points, raw score \+0\.0 points\. Counts: killed \+2, survived -1\./);
  assert.match(renderIssue({ outcome, earlier: comparison({ ...res, head: OLD }, res), head: HEAD, runUrl: RUN_URL }), /Counts: no change\./);
  assert.match(withChange, /1 new survivor/);
  assert.match(withChange, /1 survivor gone/);
});

test('the issue body stays inside the GitHub limit and counts what it leaves out', () => {
  const file = 'packages/cezar/src/a.ts';
  const many = Array.from({ length: 5000 }, (_, i) => survivor(i + 1, 'decide', { original: 'x'.repeat(90) }));
  const res = result(file, { fail: ['decide'], survivors: many, guards: [{ name: 'decide', found: true, survivors: many }] });
  const body = renderIssue({ outcome: classify(entry(file), { result: res }), earlier: comparison({ ...result(file), head: OLD }, res), head: HEAD, runUrl: RUN_URL });
  assert.ok(body.length <= MAX_BODY, `${body.length}`);
  assert.match(body, /and \d+ more/);
  assert.ok(MAX_BODY < 65536);
});

const issueOf = (number, file, state = 'open', body = `${marker(file)}\nold`) => ({ number, title: `Mutation targets missed: ${file}`, body, state, labels: [] });
const outcome = (file, state, extra = {}) => ({ file, state, entryReason: 'target', ...(state === 'not-measured' ? { reason: 'no result: the job timed out, failed or was cancelled' } : {}),
  ...(state !== 'not-measured' ? { result: result(file, { fail: state === 'missed' ? ['covered lines'] : [] }), failures: state === 'missed' ? ['covered lines'] : [] } : {}), ...extra });
const sync = (github, outcomes, exists = () => true) => syncIssues({ github, owner: 'o', repo: 'r', outcomes, earlier: new Map(), head: HEAD, runUrl: RUN_URL, exists, date: '2026-11-07' });

test('a miss creates one issue with the title, marker and labels, and a re-run updates that issue instead of adding one', async () => {
  const github = fakeGithub();
  const files = ['packages/web/src/a.tsx', 'packages/contract/src/b.ts', 'packages/api-client/src/c.ts', 'packages/cezar/src/d.ts'];
  await sync(github, files.map(file => outcome(file, 'missed')));
  assert.deepEqual(github.state.issues.map(i => [i.title, i.labels.map(l => l.name)]), [
    ['Mutation targets missed: packages/web/src/a.tsx', ['code-quality-improvement', 'area-web']],
    ['Mutation targets missed: packages/contract/src/b.ts', ['code-quality-improvement', 'area-contract']],
    ['Mutation targets missed: packages/api-client/src/c.ts', ['code-quality-improvement', 'area-api-client']],
    ['Mutation targets missed: packages/cezar/src/d.ts', ['code-quality-improvement', 'area-cezar']],
  ]);
  assert.ok(github.state.issues.every((issue, i) => issue.body.startsWith(marker(files[i]))));
  const actions = await sync(github, files.map(file => outcome(file, 'missed')));
  assert.equal(github.state.issues.length, 4);
  assert.deepEqual(actions.map(a => a.action), ['updated', 'updated', 'updated', 'updated']);
});

test('a miss reopens and rewrites a closed issue found by its marker, even after a title edit', async () => {
  const file = 'packages/cezar/src/a.ts';
  const github = fakeGithub({ issues: [{ ...issueOf(7, file, 'closed'), title: 'renamed' }, { number: 8, title: 'other', body: 'no marker', state: 'open' }, { ...issueOf(9, file), pull_request: {} }] });
  const [action] = await sync(github, [outcome(file, 'missed')]);
  assert.deepEqual(action, { file, action: 'reopened', number: 7 });
  assert.equal(github.state.issues[0].state, 'open');
  assert.match(github.state.issues[0].body, /FAIL: covered lines/);
  assert.deepEqual(github.state.writes, ['issue.update']);
});

test('a pass closes an open issue with a short comment and leaves a closed one alone', async () => {
  const github = fakeGithub({ issues: [issueOf(7, 'packages/cezar/src/a.ts'), issueOf(8, 'packages/cezar/src/b.ts', 'closed')] });
  const actions = await sync(github, [outcome('packages/cezar/src/a.ts', 'passed'), outcome('packages/cezar/src/b.ts', 'passed'), outcome('packages/cezar/src/c.ts', 'passed')]);
  assert.deepEqual(actions, [{ file: 'packages/cezar/src/a.ts', action: 'closed', number: 7 }]);
  assert.equal(github.state.issues[0].state, 'closed');
  assert.equal(github.state.issues[0].state_reason, 'completed');
  assert.match(github.state.comments[0].body, /every target passes/i);
  assert.equal(github.state.comments[0].issue_number, 7);
});

test('a file that is not measured never closes its issue: an open one gets one note that later runs replace', async () => {
  const file = 'packages/cezar/src/a.ts';
  const github = fakeGithub({ issues: [issueOf(7, file), issueOf(8, 'packages/cezar/src/b.ts', 'closed')] });
  await sync(github, [outcome(file, 'not-measured'), outcome('packages/cezar/src/b.ts', 'not-measured'), outcome('packages/cezar/src/c.ts', 'not-measured')]);
  await syncIssues({ github, owner: 'o', repo: 'r', outcomes: [outcome(file, 'not-measured', { reason: 'unreadable result' })], earlier: new Map(), head: HEAD, runUrl: RUN_URL, exists: () => true, date: '2026-11-14' });
  const [open, closed] = github.state.issues;
  assert.equal(open.state, 'open');
  assert.ok(open.body.startsWith(`${marker(file)}\nold`), 'the last measured body stays');
  assert.equal(open.body.match(/Not measured this week/g).length, 1);
  assert.match(open.body, /2026-11-14.*unreadable result/s);
  assert.equal(closed.state, 'closed');
  assert.equal(github.state.issues.length, 2);
  assert.deepEqual(github.state.writes, ['issue.update', 'issue.update']);
  await sync(github, [outcome(file, 'missed')]);
  assert.doesNotMatch(github.state.issues[0].body, /Not measured this week/);
});

test('an open issue whose file no longer exists at the head is closed with a note; one whose file exists is left alone', async () => {
  const github = fakeGithub({ issues: [issueOf(7, 'packages/cezar/src/gone.ts'), issueOf(8, 'packages/cezar/src/kept.ts'), issueOf(9, 'packages/cezar/src/old.ts', 'closed')] });
  const actions = await sync(github, [], file => !/gone|old/.test(file));
  assert.deepEqual(actions, [{ file: 'packages/cezar/src/gone.ts', action: 'closed-deleted', number: 7 }]);
  assert.equal(github.state.issues[0].state, 'closed');
  assert.equal(github.state.issues[0].state_reason, 'not_planned');
  assert.match(github.state.comments[0].body, /no longer exists/);
  assert.equal(github.state.issues[1].state, 'open');
});

const combined = (results) => Buffer.from(JSON.stringify({ version: 1, results }));
const readArchive = data => JSON.parse(Buffer.from(data).toString('utf8'));

test('the earlier result is the newest earlier run that holds one for the file, skipping this run and expired artifacts', async () => {
  const a = 'packages/cezar/src/a.ts';
  const b = 'packages/cezar/src/b.ts';
  const runs = [{ id: 9, created_at: '2026-11-07' }, { id: 8, created_at: '2026-10-31' }, { id: 6, created_at: '2026-10-17' }, { id: 7, created_at: '2026-10-24' }];
  const artifacts = [
    { id: 1, run_id: 9, name: 'mutants-weekly-results', expired: false, data: combined({ [a]: { ...result(a), head: 'now' } }) },
    { id: 2, run_id: 8, name: 'mutants-weekly-results', expired: false, data: combined({ [a]: { ...result(a), head: 'week-1' } }) },
    { id: 3, run_id: 7, name: 'mutants-weekly-results', expired: true, data: combined({ [b]: { ...result(b), head: 'expired' } }) },
    { id: 4, run_id: 6, name: 'mutants-weekly-results', expired: false, data: combined({ [a]: { ...result(a), head: 'week-3' }, [b]: { ...result(b), head: 'week-3' } }) },
  ];
  const github = fakeGithub({ runs, artifacts });
  const earlier = await findEarlier({ github, owner: 'o', repo: 'r', runId: 9, files: [a, b], readArchive, warn: () => {} });
  assert.equal(earlier.get(a).head, 'week-1');
  assert.equal(earlier.get(b).head, 'week-3');
  const none = await findEarlier({ github: fakeGithub({ runs: [{ id: 9, created_at: 'x' }], artifacts }), owner: 'o', repo: 'r', runId: 9, files: [a], readArchive, warn: () => {} });
  assert.equal(none.get(a), undefined);
  assert.equal((await findEarlier({ github, owner: 'o', repo: 'r', runId: 9, files: [], readArchive, warn: () => {} })).size, 0);
  const warnings = [];
  const broken = fakeGithub({ runs, artifacts: [{ ...artifacts[1], data: Buffer.from('not json') }, artifacts[3]] });
  const skipped = await findEarlier({ github: broken, owner: 'o', repo: 'r', runId: 9, files: [a], readArchive, warn: line => warnings.push(line) });
  assert.equal(skipped.get(a).head, 'week-3');
  assert.equal(warnings.length, 1);
});

// One stored entry: the smallest archive unzip reads, like the zip upload-artifact serves.
function storedZip(name, text) {
  const data = Buffer.from(text);
  const crc = require('node:zlib').crc32(data);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(data.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(name.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt32LE(crc, 16);
  central.writeUInt32LE(data.length, 20); central.writeUInt32LE(data.length, 24); central.writeUInt16LE(name.length, 28);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(1, 8); end.writeUInt16LE(1, 10);
  end.writeUInt32LE(46 + name.length, 12); end.writeUInt32LE(30 + name.length + data.length, 16);
  return Buffer.concat([local, Buffer.from(name), data, central, Buffer.from(name), end]);
}

test('the default archive reader takes results.json out of the downloaded zip', () => {
  const zip = storedZip('results.json', JSON.stringify({ version: 1, results: { a: 1 } }));
  assert.deepEqual(weekly.unzipResults(zip.buffer.slice(zip.byteOffset, zip.byteOffset + zip.length)), { version: 1, results: { a: 1 } });
  assert.throws(() => weekly.unzipResults(storedZip('other.json', '{}')));
});

test('the summary lists measured, missed, not measured, over the weekly cap and skipped files', () => {
  const summary = renderSummary({
    plan: { head: HEAD, cut: [{ file: 'packages/cezar/src/cut.ts', lines: 3 }], skipped: [{ file: 'packages/cezar/src/gone.ts', reason: 'not at head' }] },
    outcomes: [outcome('packages/cezar/src/p.ts', 'passed'), outcome('packages/cezar/src/m.ts', 'missed'), outcome('packages/cezar/src/n.ts', 'not-measured')],
    actions: [{ file: 'packages/cezar/src/m.ts', action: 'created', number: 12 }, { file: 'packages/cezar/src/old.ts', action: 'closed-deleted', number: 4 }],
  });
  for (const text of ['2 measured', '1 missed', '1 not measured', '1 over the weekly cap', '`packages/cezar/src/m.ts`', '#12', 'FAIL: covered lines',
    'Not measured: over the weekly cap', '`packages/cezar/src/cut.ts` (3 changed lines)', '`packages/cezar/src/n.ts`: no result', '`packages/cezar/src/gone.ts`: not at head', '#4']) {
    assert.ok(summary.includes(text), text);
  }
});

test('publish writes the combined results before it syncs issues, compares a miss with the earlier result and writes the summary', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mutants-weekly-publish-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const files = ['packages/cezar/src/m.ts', 'packages/cezar/src/p.ts', 'packages/cezar/src/n.ts'];
  const planDir = path.join(dir, 'plan');
  fs.mkdirSync(planDir);
  fs.writeFileSync(path.join(planDir, 'plan.json'), JSON.stringify({ version: 1, head: HEAD, since: 'x', cap: 64, selected: files.map(entry), cut: [], skipped: [] }));
  const filesDir = resultDir(t, [[files[0], result(files[0], { fail: ['covered lines'] })], [files[1], result(files[1])]]);
  const github = fakeGithub({ runs: [{ id: 8, created_at: '2026-10-31' }], artifacts: [{ id: 1, run_id: 8, name: 'mutants-weekly-results', expired: false, data: combined({ [files[0]]: { ...result(files[0]), head: OLD, score: 70 } }) }] });
  const summaries = [];
  const core = { warning() {}, info() {}, summary: { addRaw(text) { summaries.push(text); return this; }, async write() {} } };
  const context = { repo: { owner: 'o', repo: 'r' }, runId: 9, serverUrl: 'https://github.test' };
  const outDir = path.join(dir, 'out');
  await publish({ github, context, core, planDir, filesDir, outDir, readArchive, exists: () => true });
  const written = JSON.parse(fs.readFileSync(path.join(outDir, 'results.json'), 'utf8'));
  assert.deepEqual(Object.keys(written.results), files.slice(0, 2));
  assert.equal(written.head, HEAD);
  assert.equal(github.state.issues.length, 1);
  assert.match(github.state.issues[0].body, /Earlier result at `bbbbbbb`: counted score \+10\.0 points/);
  assert.match(github.state.issues[0].body, /https:\/\/github\.test\/o\/r\/actions\/runs\/9/);
  assert.match(summaries.join(''), /1 not measured/);
  await assert.rejects(publish({ github, context, core, planDir: filesDir, filesDir, outDir, readArchive, exists: () => true }), /plan/);
});

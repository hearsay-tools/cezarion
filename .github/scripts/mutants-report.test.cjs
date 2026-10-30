const test = require('node:test');
const assert = require('node:assert/strict');
const {
  MARKER, LIMITS, collectPackage, validateArtifact, renderReport, renderUnavailable, shouldCreate,
} = require('./mutants-report.cjs');
const fixture = require('./fixtures/mutants/stryker-report.json');

const FILE = 'packages/contract/src/attention.ts';
const HEAD = 'abcdef0123456789abcdef0123456789abcdef01';
const ctx = { head: HEAD, runUrl: 'https://github.com/o/r/actions/runs/7', blobBase: `https://github.com/o/r/blob/${HEAD}` };
const clone = value => JSON.parse(JSON.stringify(value));
const collect = (changed, report = fixture) =>
  collectPackage({ name: 'contract', report, changed: new Map([[FILE, changed]]), durationMs: 16_000, relatedTests: 4 });
const wrap = (...packages) => ({ version: 1, state: 'ran', head: HEAD, stryker: '10.1.1', packages });
const mutant = (over = {}) => ({ file: FILE, line: 85, column: 48, mutator: 'ConditionalExpression', original: 'a', replacement: 'b', status: 'Survived', ...over });
const pack = (over = {}) => ({
  name: 'contract', state: 'completed', reason: '', changedLines: 21, relatedTests: 4, durationMs: 16_000,
  counts: { killed: 0, survived: 0, noCoverage: 0, timeout: 0, error: 0, ignored: 0 }, mutants: [], ...over,
});

test('collectPackage counts every status and lists the mutants that start on a changed line', () => {
  const result = collect([[80, 100]]);
  assert.equal(result.state, 'completed');
  assert.deepEqual(result.counts, { killed: 3, survived: 2, noCoverage: 1, timeout: 1, error: 0, ignored: 0 });
  assert.equal(result.changedLines, 21);
  assert.equal(result.relatedTests, 4);
  const survivors = result.mutants.filter(m => m.status === 'Survived');
  assert.deepEqual(survivors.map(m => [m.line, m.column, m.mutator, m.original, m.replacement]), [
    [85, 48, 'ConditionalExpression', "run.status === 'waiting' || run.status === 'running'", 'true'],
    [92, 50, 'BlockStatement', '{ return false; }', '{}'],
  ]);
});

test('collectPackage lists undetected mutants before detected ones, each group in source order', () => {
  const order = collect([[80, 100]]).mutants.map(m => `${m.status}:${m.line}:${m.column}`);
  assert.deepEqual(order, [
    'Survived:85:48', 'Survived:92:50', 'NoCoverage:85:10',
    'Killed:84:61', 'Killed:85:10', 'Killed:85:10', 'Timeout:85:10',
  ]);
});

test('collectPackage drops mutants outside the changed lines, and files the diff never touched', () => {
  const one = collect([[85, 85]]);
  assert.deepEqual(one.mutants.map(m => m.line), [85, 85, 85, 85, 85]);
  assert.equal(one.counts.survived, 1);
  const other = collectPackage({ name: 'contract', report: fixture, changed: new Map([['packages/contract/src/other.ts', [[1, 999]]]]), durationMs: 1, relatedTests: null });
  assert.deepEqual(other.counts, pack().counts);
  assert.equal(other.relatedTests, null);
});

test('collectPackage counts errors and ignored mutants without listing them', () => {
  const report = clone(fixture);
  const [first, second] = report.files[FILE].mutants;
  first.status = 'CompileError';
  second.status = 'Ignored';
  const result = collect([[80, 100]], report);
  assert.equal(result.counts.error, 1);
  assert.equal(result.counts.ignored, 1);
  assert.ok(result.mutants.every(m => ['Survived', 'NoCoverage', 'Killed', 'Timeout'].includes(m.status)));
});

test('collectPackage caps each list and keeps the counts whole', () => {
  const report = clone(fixture);
  const template = report.files[FILE].mutants.find(m => m.status === 'Survived');
  report.files[FILE].mutants = Array.from({ length: LIMITS.undetected + 30 }, (_, i) => ({ ...template, id: String(i) }));
  const result = collect([[1, 200]], report);
  assert.equal(result.counts.survived, LIMITS.undetected + 30);
  assert.equal(result.mutants.length, LIMITS.undetected);
  assert.equal(result.omitted, 30);
});

test('validateArtifact keeps a well-formed artifact and strips every field it does not know', () => {
  const artifact = wrap({ ...collect([[80, 100]]), extra: 'x' });
  artifact.padding = 'y';
  const clean = validateArtifact(JSON.parse(JSON.stringify(artifact)));
  assert.equal(clean.padding, undefined);
  assert.equal(clean.packages[0].extra, undefined);
  assert.deepEqual(clean.packages[0].counts, artifact.packages[0].counts);
  assert.equal(clean.packages[0].mutants.length, 7);
});

test('validateArtifact refuses a shape the job could not have written', () => {
  const bad = {
    'a wrong version': { ...wrap(), version: 2 },
    'an unknown state': { ...wrap(), state: 'done' },
    'a head that is not a sha': { ...wrap(), head: 'main; rm -rf' },
    'a package outside the four': wrap(pack({ name: '../etc' })),
    'a mutant path outside src': wrap(pack({ mutants: [mutant({ file: '../../etc/passwd' })] })),
    'a mutant path with markup': wrap(pack({ mutants: [mutant({ file: 'packages/web/src/<b>.ts' })] })),
    'a fractional line': wrap(pack({ mutants: [mutant({ line: 1.5 })] })),
    'a negative count': wrap(pack({ counts: { ...pack().counts, killed: -1 } })),
    'an unknown mutant status': wrap(pack({ mutants: [mutant({ status: 'Pending' })] })),
    'a very long text': wrap(pack({ mutants: [mutant({ replacement: 'x'.repeat(LIMITS.text + 1) })] })),
    'too many mutants': wrap(pack({ mutants: Array.from({ length: LIMITS.undetected + LIMITS.detected + 1 }, () => mutant()) })),
    'too many packages': wrap(...Array.from({ length: 5 }, () => pack())),
    'not an object': 'text',
    'null': null,
  };
  for (const [name, value] of Object.entries(bad)) assert.throws(() => validateArtifact(value), Error, name);
});

test('renderReport opens with the marker once and reports survivors in a table', () => {
  const body = renderReport(wrap(collect([[80, 100]])), ctx);
  assert.ok(body.startsWith(`${MARKER}\n`));
  assert.equal(body.split(MARKER).length, 2);
  assert.match(body, /Advisory/);
  assert.match(body, /never blocks a merge/);
  assert.match(body, /`abcdef0`/);
  assert.match(body, /\[job run\]\(https:\/\/github.com\/o\/r\/actions\/runs\/7\)/);
  assert.match(body, /\[`packages\/contract\/src\/attention.ts:85`\]\(https:\/\/github.com\/o\/r\/blob\/abcdef0123456789abcdef0123456789abcdef01\/packages\/contract\/src\/attention.ts#L85\)/);
  assert.match(body, /ConditionalExpression/);
  assert.match(body, /\| Where \| Mutator \| Original \| Mutant \| Result \|/);
  assert.match(body, /\| Not covered \|/);
  assert.match(body, /7 mutants in 21 changed lines: 3 killed, 2 survived, 1 not covered, 1 timed out/);
  assert.match(body, /1 not covered/);
  assert.match(body, /<details><summary>Killed and timed-out mutants \(4\)<\/summary>/);
});

test('renderReport says one mutant in one changed line in the singular', () => {
  const body = renderReport(wrap(pack({ changedLines: 1, counts: { ...pack().counts, killed: 1, survived: 0 }, mutants: [] })), ctx);
  assert.match(body, /1 mutant in 1 changed line:/);
});

test('renderReport says so when nothing survived, and names the tests the job ran', () => {
  const body = renderReport(wrap(pack({ counts: { ...pack().counts, killed: 5 }, mutants: [mutant({ status: 'Killed' })] })), ctx);
  assert.match(body, /No mutant survived/);
  assert.match(body, /`contract` package's own unit tests/);
});

test('renderReport escapes every cell so a mutant cannot inject markup, a mention or a table break', () => {
  const hostile = mutant({ original: '<img src=x onerror=alert(1)> @octocat | `x`', replacement: '</code><script>@all</script>\nnext' });
  const body = renderReport(wrap(pack({ counts: { ...pack().counts, survived: 1 }, mutants: [hostile] })), ctx);
  assert.doesNotMatch(body, /<img|<script|<\/code><|@octocat|@all/);
  const row = body.split('\n').find(line => line.includes('&#60;img'));
  assert.equal(row.split(/(?<!\\)\|/).length, 7, 'a row keeps exactly five cells');
});

test('renderReport shows an untrusted reason and mutant text as plain text: no link, image, autolink, reference or emphasis', () => {
  const hostile = '[link](https://example.com) ![image](https://example.com/a.png) https://example.com www.example.com '
    + '<https://example.com> #12 :+1: *bold* _it_ ~~gone~~ back\\slash [ref]: https://example.com';
  const body = renderReport(wrap(
    pack({ name: 'cezar', state: 'skipped', reason: hostile }),
    pack({ counts: { ...pack().counts, survived: 1 }, mutants: [mutant({ original: hostile, replacement: hostile })] }),
  ), ctx);
  const notice = body.split('\n').find(line => line.startsWith('Skipped: ')).slice('Skipped: '.length);
  const cells = [...body.matchAll(/<code>(.*?)<\/code>/g)].map(found => found[1]);
  assert.equal(cells.length, 2);
  for (const shown of [notice, ...cells]) {
    // Only numeric character references remain: none of the characters that start syntax is left as itself.
    assert.match(shown, /^(?:[^&<>|@`\\[\]()!*_~:#]|&#\d+;)*$/);
    assert.doesNotMatch(shown, /www\./i);
    assert.match(shown, /&#91;link&#93;&#40;https&#58;\/\/example\.com&#41;/);
  }
});

test('renderReport states why a package was skipped, timed out or failed, with no mutants listed', () => {
  const body = renderReport(wrap(
    pack({ name: 'cezar', state: 'skipped', reason: '264 test files import the changed files, over the budget of 150', changedLines: 80 }),
    pack({ name: 'web', state: 'timed-out', reason: 'stopped after 35 minutes' }),
    pack({ name: 'contract', state: 'error', reason: 'Stryker exited with code 1' }),
  ), ctx);
  assert.match(body, /#### cezar\nSkipped: 264 test files import the changed files, over the budget of 150/);
  assert.match(body, /#### web\nStopped: stopped after 35 minutes/);
  assert.match(body, /#### contract\nFailed: Stryker exited with code 1/);
  assert.match(body, /run Stryker on this change yourself/i);
});

test('renderReport for a push with no mutable lines carries no survivors from an earlier push', () => {
  const body = renderReport({ version: 1, state: 'no-mutable-lines', head: HEAD, stryker: '10.1.1', packages: [] }, ctx);
  assert.ok(body.startsWith(MARKER));
  assert.match(body, /No product source line changed in `abcdef0`/);
  assert.doesNotMatch(body, /survived|\|/);
});

test('renderReport stays under the comment limit and says what it left out', () => {
  const many = Array.from({ length: LIMITS.undetected }, (_, i) => mutant({ line: i + 1, original: 'o'.repeat(LIMITS.text), replacement: 'r'.repeat(LIMITS.text) }));
  const killed = Array.from({ length: LIMITS.detected }, (_, i) => mutant({ line: i + 1, status: 'Killed', original: 'o'.repeat(LIMITS.text), replacement: 'r'.repeat(LIMITS.text) }));
  const heavy = pack({ counts: { ...pack().counts, survived: LIMITS.undetected, killed: LIMITS.detected }, mutants: [...many, ...killed] });
  const body = renderReport(wrap(heavy, { ...heavy, name: 'web' }, { ...heavy, name: 'cezar' }), ctx);
  assert.ok(body.length <= LIMITS.comment, String(body.length));
  assert.match(body, /Left out to fit the comment/);
  assert.ok(body.startsWith(MARKER));
});

test('renderUnavailable replaces the report when the job gave none, and keeps the marker', () => {
  const failed = renderUnavailable('failed', ctx);
  assert.ok(failed.startsWith(MARKER));
  assert.match(failed, /did not finish for `abcdef0`/);
  assert.match(renderUnavailable('unreadable', ctx), /could not be read/);
  assert.doesNotMatch(failed, /survived/);
});

test('shouldCreate is false only when no product line changed', () => {
  assert.equal(shouldCreate({ state: 'no-mutable-lines' }), false);
  assert.equal(shouldCreate(wrap(pack({ state: 'skipped', reason: 'x' }))), true);
  assert.equal(shouldCreate(wrap(pack())), true);
});

const { readEquivalent } = require('./mutants-equivalent.cjs');
const equivalent = { file: FILE, function: 'hasPendingPermission', mutator: 'ConditionalExpression', original: "run.status === 'waiting' || run.status === 'running'", replacement: 'true', reason: 'fixture example' };
const fixtureRanges = [{ name: 'hasPendingPermission', range: { start: { line: 83, column: 0 }, end: { line: 86, column: 0 } } }];
const rangesByFile = new Map([[FILE, fixtureRanges]]);
const withEntries = entries => collectPackage({ name: 'contract', report: fixture, changed: new Map([[FILE, [[80, 100]]]]), durationMs: 16_000, relatedTests: 4, entries, rangesByFile });

test('equivalent mutants leave the tables, other counts and total; another mutator stays', () => {
  const result = withEntries([equivalent]);
  assert.deepEqual(result.counts, { killed: 3, survived: 1, noCoverage: 1, timeout: 1, error: 0, ignored: 0, equivalent: 1 });
  assert.equal(result.mutants.length, 6);
  assert.equal(result.mutants.some(m => m.line === 85 && m.column === 48), false);
  const body = renderReport(validateArtifact(wrap(result)), ctx);
  assert.match(body, /6 mutants in 21 changed lines/);
  assert.match(body, /1 equivalent/);
  assert.deepEqual(withEntries([{ ...equivalent, mutator: 'BooleanLiteral' }]), collect([[80, 100]]));
});

test('missing and empty lists keep the fixture artifact and comment byte-identical', () => {
  const hash = text => require('node:crypto').createHash('sha256').update(text).digest('hex');
  const missing = readEquivalent('missing', { readFileSync() { throw Object.assign(new Error('missing'), { code: 'ENOENT' }); } });
  for (const entries of [missing.entries, []]) {
    const artifact = wrap(withEntries(entries));
    // Captured from the parent commit before integrating equivalent matching.
    assert.equal(hash(JSON.stringify(artifact)), 'e12e307426e71fb4b42273c123a9ec1ba48b81ba5db80d08d9292341a397d5d8');
    assert.equal(hash(renderReport(artifact, ctx)), 'de91e378382bc37b2bcc4891913f7748776a52e866920a460cbe3dc704d113d4');
  }
});

test('an unreadable list keeps the report usable and its warning is bounded and escaped', () => {
  const { entries, warning } = readEquivalent('denied', { readFileSync() { throw new Error('<script> @all | [link](https://example.com)'); } });
  const artifact = { ...wrap(withEntries(entries)), warning };
  const clean = validateArtifact(artifact);
  assert.equal(clean.warning, warning);
  assert.match(renderReport(clean, ctx), /Warning: Could not read equivalent mutants/);
  assert.doesNotMatch(renderReport(clean, ctx), /<script>|@all|https:\/\/example.com/);
  assert.throws(() => validateArtifact({ ...artifact, warning: 'x'.repeat(LIMITS.reason + 1) }), /warning/);
  assert.throws(() => validateArtifact({ ...artifact, warning: 1 }), /warning/);
  for (const equivalent of [-1, 0.5, '1']) {
    assert.throws(() => validateArtifact(wrap(pack({ counts: { ...pack().counts, equivalent } }))), /count equivalent/);
  }
});

test('equivalent matching uses full source slices rather than shortened table cells', () => {
  const original = 'x'.repeat(250) + 'end';
  const report = { files: { [FILE]: { source: original, mutants: [{ mutatorName: 'StringLiteral', replacement: 'other', status: 'Survived', location: { start: { line: 1, column: 1 }, end: { line: 1, column: original.length + 1 } } }] } } };
  const collect = text => collectPackage({ name: 'contract', report, changed: new Map([[FILE, [[1, 1]]]]), durationMs: 0, relatedTests: 1, entries: [{ ...equivalent, function: '(module)', mutator: 'StringLiteral', original: text, replacement: 'other' }], rangesByFile: new Map([[FILE, []]]) });
  assert.equal(collect(original).counts.equivalent, 1);
  assert.equal(collect('x'.repeat(250) + 'different').counts.survived, 1);
});

test('same mutation text in two functions excludes only the listed function', () => {
  const source = 'function first() { return true; }\nfunction second() { return true; }';
  const mutants = [1, 2].map(line => ({ mutatorName: 'BooleanLiteral', replacement: 'false', status: 'Survived', location: { start: { line, column: line === 1 ? 27 : 28 }, end: { line, column: line === 1 ? 31 : 32 } } }));
  const report = { files: { [FILE]: { source, mutants } } };
  const entries = [{ ...equivalent, function: 'first', mutator: 'BooleanLiteral', original: 'true', replacement: 'false' }];
  const functions = ['first', 'second'].map((name, line) => ({ name, range: { start: { line, column: 0 }, end: { line, column: 100 } } }));
  const result = collectPackage({ name: 'contract', report, changed: new Map([[FILE, [[1, 2]]]]), durationMs: 0, relatedTests: 1, entries, rangesByFile: new Map([[FILE, functions]]) });
  assert.equal(result.counts.survived, 1);
  assert.equal(result.counts.equivalent, 1);
  assert.equal(result.mutants[0].line, 2);
  const unavailable = collectPackage({ name: 'contract', report, changed: new Map([[FILE, [[1, 2]]]]), durationMs: 0, relatedTests: 1, entries });
  assert.equal(unavailable.counts.survived, 2);
  assert.equal(unavailable.counts.equivalent, undefined);
});

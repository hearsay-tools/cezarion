'use strict';

// Pins the comparison of the Squeal coverage proof (squeal-coverage-proof.cjs, ci.yml squeal-coverage-proof-compare).
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { compareReports, coverageFiles, summarizeParts, main } = require('./squeal-coverage-proof.cjs');

const at = (line, column, endColumn = column + 5) => ({ start: { line, column }, end: { line, column: endColumn } });
// One Istanbul file entry from [location, count] pairs, with ids in the given order.
const entry = (file, statements) => ({
  path: file,
  statementMap: Object.fromEntries(statements.map(([loc], i) => [String(i), loc])),
  s: Object.fromEntries(statements.map(([, count], i) => [String(i), count])),
});
const report = (root, files) => Object.fromEntries(Object.entries(files).map(([file, statements]) => {
  const absolute = `${root.replace(/\/$/, '')}/${file}`;
  return [absolute, entry(absolute, statements)];
}));

function sandbox(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'squeal-coverage-proof-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

test('statements compare by location relative to each run\'s checkout, whatever their ids', () => {
  const first = coverageFiles(report('/w/a', {
    'src/x.ts': [[at(1, 0), 1], [at(2, 0), 0], [at(3, 0), 4], [at(9, 0), 1]],
    'src/only-first.ts': [[at(1, 0), 1]],
    'src/same.ts': [[at(1, 0), 2], [at(1, 0), 0]],
  }), '/w/a');
  const second = coverageFiles(report('/w/b/', {
    // Ids in another order. Line 2 is covered here only, line 3 in the first only; line 9 is in the first map only, line 7 in this one only.
    'src/x.ts': [[at(3, 0), 0], [at(1, 0), 1], [at(2, 0), 2], [at(7, 0), 1]],
    'src/same.ts': [[at(1, 0), 1], [at(1, 0), 0]],
    'src/only-second.ts': [[at(1, 0), 0]],
  }), '/w/b/');
  assert.deepEqual([...first.keys()].sort(), ['src/only-first.ts', 'src/same.ts', 'src/x.ts']);
  const result = compareReports({ run: 'squeal', files: first }, { run: 'v8', files: second });
  assert.deepEqual(result.statements, { compared: 5, differing: 2, onlyFirst: 1, onlySecond: 1, unmatched: 2 });
  assert.deepEqual(result.files, { compared: 2, differing: 1, onlyFirst: ['src/only-first.ts'], onlySecond: ['src/only-second.ts'] });
  assert.deepEqual(result.differingFiles, [{ file: 'src/x.ts', onlyFirst: 1, onlySecond: 1 }]);
  assert.deepEqual(compareReports({ run: 'v8', files: second }, { run: 'v8-control', files: second }).statements,
    { compared: 7, differing: 0, onlyFirst: 0, onlySecond: 0, unmatched: 0 }, 'a report against itself');
});

const COVERAGE = { provider: 'squeal', collector: 'v8', collectorVersion: '4.1.10', providerVersion: 1, recordVersion: 2 };
const part = (header, testFiles) => ({ format: 'squeal-ci-part/4', header: { squealVersion: '0.1.443', runnerVersion: '4.1.10', end: 'completed', ...header },
  projects: [], testFiles, evidence: {} });

test('the parts give records against test files, the collector, node:inspector and Squeal\'s time once per command', () => {
  const cost = { command: 'u1', hooksMs: 30000, threads: 7, afterMs: 1500 };
  const inspector = { loaded: [{ project: 'server', path: 'a.test.ts' }], unknown: [{ project: 'web', path: 'b.test.ts' }] };
  const summary = summarizeParts({ errors: [], parts: [
    part({ coverage: { ...COVERAGE, inspector }, cost }, [{ durationMs: 100000, record: 0 }, { durationMs: 50000, noRecord: 'inspector' }]),
    part({ coverage: { ...COVERAGE, inspector }, cost }, [{ durationMs: 50000, record: 1 }, { durationMs: null }]),
  ] });
  assert.deepEqual(summary, {
    parts: 2, errors: [], formats: ['squeal-ci-part/4'], ends: ['completed'], versions: ['Squeal 0.1.443, Vitest 4.1.10'],
    testFiles: 4, withRecord: 2, noRecord: { inspector: 1, 'none named': 1 },
    coverage: [COVERAGE], collector: ['v8'],
    inspector: { loaded: ['server:a.test.ts'], unknown: ['web:b.test.ts'] },
    cost: { commands: 1, hooksMs: 30000, threads: 7, afterMs: 1500 }, testMs: 200000,
  });
  const yielded = summarizeParts({ errors: [], parts: [part({ coverage: { off: 'project-coverage', note: 'istanbul' } }, [{ durationMs: 1 }])] });
  assert.deepEqual(yielded.collector, ['none']);
  assert.equal(yielded.cost, null);
});

function writeRun(input, run, { meta, coverage, parts } = {}) {
  const dir = path.join(input, `squeal-coverage-proof-${run}`);
  fs.mkdirSync(dir, { recursive: true });
  if (meta) fs.writeFileSync(path.join(dir, 'run.json'), JSON.stringify({ format: 'squeal-coverage-proof-run/1', run, root: `/w/${run}`, cpus: 4, cpuModel: 'AMD EPYC 7763', loadBefore: 0.5, loadAfter: 3.9, ...meta }));
  if (coverage) fs.writeFileSync(path.join(dir, 'coverage-final.json'), typeof coverage === 'string' ? coverage : JSON.stringify(report(`/w/${run}`, coverage)));
  if (parts) {
    fs.mkdirSync(path.join(dir, 'parts'));
    parts.forEach((content, i) => fs.writeFileSync(path.join(dir, 'parts', `squeal-part-${i}.json`), typeof content === 'string' ? content : JSON.stringify(content)));
  }
}

test('the summary and comparison.json name the differences, the records and each run\'s time', (t) => {
  const input = sandbox(t);
  const files = { 'src/x.ts': [[at(1, 0), 1], [at(2, 0), 1]], 'src/y.ts': [[at(1, 0), 1]] };
  writeRun(input, 'squeal', { meta: { exitCode: 0, wallSeconds: 660, userSeconds: 2000, sysSeconds: 100 }, coverage: { ...files, 'src/x.ts': [[at(1, 0), 1], [at(2, 0), 0]] },
    parts: [part({ coverage: COVERAGE, cost: { command: 'u1', hooksMs: 21000, threads: 7, afterMs: 432 } }, [{ durationMs: 400000, record: 0 }, { durationMs: 20000, noRecord: 'inspector' }]), '{'] });
  writeRun(input, 'v8', { meta: { exitCode: 0, wallSeconds: 600, userSeconds: 1900, sysSeconds: 100 }, coverage: files });
  writeRun(input, 'v8-control', { meta: { exitCode: 1, wallSeconds: 630, userSeconds: 1950, sysSeconds: 90 }, coverage: files });
  const json = path.join(input, 'comparison.json');
  let markdown = '';
  assert.equal(main(['--input', input, '--json', json], { stdout: (text) => { markdown += text; } }), 0);
  const lines = markdown.split('\n');
  for (const line of [
    '| (a) `squeal` against (b) `v8` | 3 | 1 (33.3%) | 0 | 1 | 2 | 1 | 0 | 0 |',
    '| (b) `v8` against (c) `v8-control` | 3 | 0 (0%) | 0 | 0 | 2 | 0 | 0 | 0 |',
    '- `src/x.ts`: 0 / 1',
    '- Coverage header: collector `v8` (@vitest/coverage-v8 4.1.10), provider 1, record 2. Collector: `v8` (expected `v8`).',
    '- Test files: 2; with a record: 1 (50%); without: 1 (inspector 1).',
    '- `node:inspector`: loaded by 0 test files, unknown for 0 test files.',
    '| (a) `squeal` | 0 | 660 s | 2,100 s | 4 | AMD EPYC 7763 | 0.5, 3.9 |',
    '| (c) `v8-control` | 1 | 630 s | 2,040 s | 4 | AMD EPYC 7763 | 0.5, 3.9 |',
    '- (a) against (b): wall +60 s (+10%), CPU +100 s (+5%).',
    '- (c) against (b), the run-to-run control: wall +30 s (+5%), CPU +40 s (+2%).',
    "- Squeal's own time in (a), from its parts: 21 s in its hooks over 7 processes and threads (5% of the test files' summed 420 s), and 0.43 s after the command.",
  ]) assert.ok(lines.includes(line), `missing: ${line}\n${markdown}`);
  assert.match(markdown, /^- Parts: 1 \(squeal-ci-part\/4; Squeal 0\.1\.443, Vitest 4\.1\.10\), run end completed\. Not read: squeal-part-1\.json: does not read: .+\.$/m);
  const comparison = JSON.parse(fs.readFileSync(json, 'utf8'));
  assert.equal(comparison.format, 'squeal-coverage-proof/1');
  assert.deepEqual(comparison.runs.map((run) => run.coverage), [{ files: 2, statements: 3, covered: 2 }, { files: 2, statements: 3, covered: 3 }, { files: 2, statements: 3, covered: 3 }]);
  assert.deepEqual(comparison.comparisons.map((c) => c.statements.differing), [1, 0]);
  assert.equal(comparison.parts.withRecord, 1);
});

test('a missing run, report or part is named in the summary, and the script still exits 0', (t) => {
  const input = sandbox(t);
  writeRun(input, 'squeal', { meta: { exitCode: 127, wallSeconds: 0.1, userSeconds: 0, sysSeconds: 0 } });
  writeRun(input, 'v8', { meta: { exitCode: 0, wallSeconds: 600, userSeconds: 1900, sysSeconds: 100 }, coverage: '{' });
  let markdown = '';
  assert.equal(main(['--input', input], { stdout: (text) => { markdown += text; } }), 0);
  assert.match(markdown, /^\| \(a\) `squeal` against \(b\) `v8` \| \(a\) `squeal`: coverage missing; \(b\) `v8`: coverage does not read: .+ \|( \|){7}$/m);
  assert.match(markdown, /^\| \(b\) `v8` against \(c\) `v8-control` \| .*\(c\) `v8-control`: coverage missing \|/m);
  assert.match(markdown, /^No part reads \(no parts directory\)\.$/m);
  assert.match(markdown, /^\| \(c\) `v8-control` \| run\.json missing \|/m);
  assert.match(markdown, /^- \(c\) against \(b\), the run-to-run control: wall unknown, CPU unknown\.$/m);
  assert.match(markdown, /^- Squeal's own time in \(a\): not in the parts\.$/m);
  let usage = '';
  assert.equal(main([], { stderr: (text) => { usage += text; } }), 0);
  assert.match(usage, /^Usage: /);
});

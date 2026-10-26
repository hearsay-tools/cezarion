import assert from 'node:assert/strict';
import test from 'node:test';
import { mergeIstanbulReports } from './istanbul-merge.mjs';
import { mergeIstanbulReports as reexported } from './coverage.mjs';

const at = (line, startColumn = 0, endColumn = 10) => ({ start: { line, column: startColumn }, end: { line, column: endColumn } });

function entry(path, { statements = [1], functions = [1], branches = [[1, 0]] } = {}) {
  return {
    path,
    statementMap: Object.fromEntries(statements.map((_, index) => [index, at(index + 1)])),
    fnMap: Object.fromEntries(functions.map((_, index) => [index, { name: `fn${index}`, decl: at(index + 1), loc: at(index + 1) }])),
    branchMap: Object.fromEntries(branches.map((_, index) => [index, { type: 'if', loc: at(index + 1), locations: [at(index + 1), at(index + 1)] }])),
    s: Object.fromEntries(statements.map((count, index) => [index, count])),
    f: Object.fromEntries(functions.map((count, index) => [index, count])),
    b: Object.fromEntries(branches.map((counts, index) => [index, counts])),
  };
}

test('counters at the same location add up, so a file split across shards keeps one entry', () => {
  const target = { '/repo/a.ts': entry('/repo/a.ts', { statements: [1, 0], functions: [2], branches: [[1, 0]] }) };
  const source = { '/repo/a.ts': entry('/repo/a.ts', { statements: [3, 4], functions: [5], branches: [[0, 6]] }) };
  const merged = mergeIstanbulReports(target, source);
  assert.deepEqual(Object.keys(merged), ['/repo/a.ts']);
  assert.deepEqual(merged['/repo/a.ts'].s, { 0: 4, 1: 4 });
  assert.deepEqual(merged['/repo/a.ts'].f, { 0: 7 });
  assert.deepEqual(merged['/repo/a.ts'].b, { 0: [1, 6] });
});

test('a file only the source report has is added with its own counters', () => {
  const merged = mergeIstanbulReports({ '/repo/a.ts': entry('/repo/a.ts') }, { '/repo/b.ts': entry('/repo/b.ts', { statements: [9] }) });
  assert.deepEqual(Object.keys(merged).sort(), ['/repo/a.ts', '/repo/b.ts']);
  assert.deepEqual(merged['/repo/b.ts'].s, { 0: 9 });
});

test('a location only the source has is appended with its counter', () => {
  const target = { '/repo/a.ts': entry('/repo/a.ts', { statements: [1] }) };
  const merged = mergeIstanbulReports(target, { '/repo/a.ts': entry('/repo/a.ts', { statements: [5, 7] }) });
  assert.deepEqual(merged['/repo/a.ts'].s, { 0: 6, 1: 7 });
  assert.deepEqual(merged['/repo/a.ts'].statementMap[1], at(2));
});

test('the quality tool keeps importing the function from coverage.mjs', () => {
  assert.equal(reexported, mergeIstanbulReports);
});

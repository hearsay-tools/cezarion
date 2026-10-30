#!/usr/bin/env node
'use strict';
// Whole-file mutation facts. Unlisted mutators are Value, including arithmetic and unary changes.
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const TARGETS = require('../mutants/targets.json');
const STATUS = { Killed: 'killed', Timeout: 'timeout', Survived: 'survived', NoCoverage: 'noCoverage', CompileError: 'error', RuntimeError: 'error', Ignored: 'ignored' };
const undetected = m => ['Survived', 'NoCoverage'].includes(m.status);
const flat = text => text.replace(/\s+/g, ' ').trim();

function classText(text) {
  const words = text.replace(/^['"`]|['"`]$/g, '').trim().split(/\s+/);
  return words.length > 0 && words.every(word => /^(?:(?:[\w-]+|\[[^\]]+\]):)*-?(?:[\w]+-[\w\[\]./#%()-]+|flex|grid|hidden|block|inline|relative|absolute|fixed|sticky|truncate|italic|underline|sr-only)$/.test(word));
}

function kindOf(m, file) {
  if (m.status === 'NoCoverage') return 'Not covered';
  if (m.mutator === 'StringLiteral') {
    if (file.endsWith('.tsx') && classText(m.original)) return 'Class name';
    if (flat(m.original).split(' ').length >= 2) return 'Text';
  }
  if (m.mutator === 'EqualityOperator' && /(?:<=?|>=?)/.test(m.original) && /(?:<=?|>=?)/.test(m.replacement)) return 'Boundary';
  if (m.mutator === 'OptionalChaining' || (m.mutator === 'LogicalOperator' && `${m.original} ${m.replacement}`.includes('??'))) return 'Fallback';
  if (['ConditionalExpression', 'LogicalOperator', 'EqualityOperator', 'BooleanLiteral'].includes(m.mutator)) return 'Condition';
  if (['BlockStatement', 'CallExpression', 'ArrowFunction', 'MethodExpression'].includes(m.mutator)) return 'Removed call';
  return 'Value';
}

const position = p => p.line * 1e7 + p.column;
const contains = (range, point) => position(range.start) <= position(point) && position(point) < position(range.end);

/** sg supplies syntax ranges; only names are read from each matched node's header. */
function namedRanges(nodes) {
  const classes = nodes.filter(n => /^class\s/.test(n.text)).map(n => ({ ...n, name: /^class\s+([\w$]+)/.exec(n.text)?.[1] }));
  return nodes.flatMap(n => {
    if (/^class\s/.test(n.text)) return [];
    const declaration = /^(?:async\s+)?function\s*\*?\s*([\w$]+)/.exec(n.text);
    const variable = /^([\w$]+)\s*(?::[^=]+)?=/.exec(n.text);
    const method = /^(?:(?:public|private|protected|static|async|override|abstract|get|set|readonly)\s+)*([\w$]+)\s*(?:<[^>]+>)?\(/.exec(n.text);
    const name = declaration?.[1] ?? variable?.[1] ?? method?.[1];
    if (!name) return [];
    const owner = classes.filter(c => contains(c.range, n.range.start)).sort((a, b) => position(b.range.start) - position(a.range.start))[0];
    return [{ name: method && owner ? `${owner.name}.${name}` : name, range: n.range }];
  });
}

function functionRanges(file, cwd = process.cwd()) {
  const rule = { id: 'mutation-functions', language: file.endsWith('.tsx') ? 'Tsx' : 'TypeScript', rule: { any: [
    { kind: 'function_declaration' }, { kind: 'method_definition' }, { kind: 'class_declaration' },
    { kind: 'variable_declarator', has: { field: 'value', any: [{ kind: 'arrow_function' }, { kind: 'function_expression' }] } },
  ] } };
  const output = execFileSync(path.join(cwd, 'node_modules/.bin/sg'), ['scan', '--inline-rules', JSON.stringify(rule), '--json=compact', file], { cwd, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  return namedRanges(JSON.parse(output));
}

function functionOf(location, ranges) {
  const point = { line: location.start.line - 1, column: location.start.column - 1 };
  return ranges.filter(r => contains(r.range, point)).sort((a, b) => position(b.range.start) - position(a.range.start))[0]?.name ?? '(module)';
}

function tierOf(file, targets = TARGETS) {
  return targets[file] ?? { tier: file.startsWith('packages/web/') && file.endsWith('.tsx') ? 'component' : 'logic', guards: [] };
}

function countsOf(mutants) {
  const counts = { killed: 0, timeout: 0, survived: 0, noCoverage: 0, error: 0, ignored: 0 };
  for (const m of mutants) {
    if (!STATUS[m.status]) throw new Error(`Unknown mutant status: ${m.status}`);
    counts[STATUS[m.status]] += 1;
  }
  return counts;
}

function scoreOf(c) {
  const total = c.killed + c.timeout + c.survived + c.noCoverage;
  return total === 0 ? 100 : 100 * (c.killed + c.timeout) / total;
}

function evaluate(mutants, target, ranges) {
  const counted = mutants.filter(m => m.kind !== 'Class name' && (m.kind !== 'Text' || target.guards.includes(m.function)));
  const counts = countsOf(counted);
  const guards = target.guards.map(name => {
    const found = ranges.some(r => r.name === name);
    const survivors = mutants.filter(m => m.function === name && m.kind !== 'Class name' && undetected(m));
    return { name, found, survivors, pass: found && survivors.length === 0 };
  });
  const targets = [{ name: `${target.tier} score`, pass: scoreOf(counts) >= (target.tier === 'logic' ? 85 : 75) }];
  if (target.tier === 'logic') targets.push({ name: 'covered lines', pass: counts.noCoverage === 0 });
  targets.push(...guards.map(g => ({ name: g.name, pass: g.pass })));
  return { counts, score: scoreOf(counts), rawCounts: countsOf(mutants), rawScore: scoreOf(countsOf(mutants)), survivors: counted.filter(undetected), guards, targets };
}

const survivorKey = m => JSON.stringify([m.function, m.mutator, flat(m.original), flat(m.replacement)]);
function compareResults(before, after) {
  if (before.version !== after.version || before.file !== after.file) throw new Error('Comparison needs the same result version and file');
  const oldKeys = new Set(before.survivors.map(survivorKey));
  const newKeys = new Set(after.survivors.map(survivorKey));
  return { score: after.score - before.score, rawScore: after.rawScore - before.rawScore,
    counts: Object.fromEntries(Object.keys(after.counts).map(key => [key, after.counts[key] - before.counts[key]])),
    added: after.survivors.filter(m => !oldKeys.has(survivorKey(m))), removed: before.survivors.filter(m => !newKeys.has(survivorKey(m))) };
}

module.exports = { classText, kindOf, namedRanges, functionRanges, functionOf, tierOf, countsOf, scoreOf, evaluate, compareResults };

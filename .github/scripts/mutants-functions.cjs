'use strict';
// Shared ast-grep function identities for the PR report and whole-file mutation command.
const path = require('node:path');
const { execFileSync } = require('node:child_process');

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

/** Existing names remain stable; repeated names cannot identify one function safely. */
function duplicateNames(ranges) {
  const seen = new Set();
  const duplicates = new Set();
  for (const { name } of ranges) {
    if (seen.has(name)) duplicates.add(name);
    seen.add(name);
  }
  return duplicates;
}

module.exports = { position, contains, namedRanges, functionRanges, functionOf, duplicateNames };

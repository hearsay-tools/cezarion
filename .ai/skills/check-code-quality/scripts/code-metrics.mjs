import { parse } from '@babel/parser';

const functionTypes = new Set([
  'FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression',
  'ObjectMethod', 'ClassMethod', 'ClassPrivateMethod',
]);
const branchTypes = new Set([
  'IfStatement', 'ConditionalExpression', 'LogicalExpression', 'CatchClause',
  'ForStatement', 'ForInStatement', 'ForOfStatement', 'WhileStatement',
  'DoWhileStatement', 'AssignmentPattern',
]);
const classInitializers = new Set(['ClassProperty', 'ClassPrivateProperty', 'ClassAccessorProperty', 'StaticBlock']);
const logicalAssignments = new Set(['&&=', '||=', '??=']);
const optionalChains = new Set(['OptionalMemberExpression', 'OptionalCallExpression']);

/** The label of the decision point a node adds to its function's complexity, or undefined. */
function decisionKind(node) {
  if (node.type === 'LogicalExpression') return `${node.type} ${node.operator}`;
  if (branchTypes.has(node.type) || (node.type === 'SwitchCase' && node.test)) return node.type;
  if (node.type === 'AssignmentExpression' && logicalAssignments.has(node.operator)) return `${node.type} ${node.operator}`;
  if (optionalChains.has(node.type) && node.optional) return `${node.type} ?.`;
  return undefined;
}

function* childNodes(node, skipKey) {
  for (const [key, value] of Object.entries(node)) {
    if (skipKey && key === 'key') continue;
    const children = Array.isArray(value) ? value : [value];
    for (const child of children) if (child?.type) yield child;
  }
}

function functionName(node, parent, ancestors) {
  if (node.id?.name) return node.id.name;
  const key = node.key ?? (['ObjectProperty', 'ClassProperty', 'ClassPrivateProperty', 'ClassAccessorProperty'].includes(parent?.type) ? parent.key : undefined);
  if (key) {
    const name = key.type === 'PrivateName' ? `#${key.id.name}` : key.name ?? key.value;
    if (name !== undefined) {
      const owner = ancestors.findLast(item => item.type === 'ClassDeclaration' || item.type === 'ClassExpression');
      return owner?.id ? `${owner.id.name}.${name}` : String(name);
    }
  }
  if (parent?.type === 'VariableDeclarator' && parent.id.type === 'Identifier') return parent.id.name;
  if (parent?.type === 'AssignmentExpression' && parent.left.type === 'Identifier') return parent.left.name;
  if (parent?.type === 'ExportDefaultDeclaration') return 'default';
  return `anonymous@${node.loc.start.line}:${node.loc.start.column + 1}`;
}

/** ESLint's classic counting convention, with a separate count for each function. */
export function analyzeSource(source, filename) {
  const typed = /\.[cm]?tsx?$/i.test(filename);
  const jsx = /\.[jt]sx$/i.test(filename);
  const ast = parse(source, {
    sourceType: 'unambiguous', attachComment: false,
    plugins: [...(typed ? ['typescript'] : []), ...(jsx ? ['jsx'] : [])],
  });
  const functions = [];
  function visit(node, owner, parent, ancestors) {
    if (!node || typeof node.type !== 'string') return;
    const method = ['ObjectMethod', 'ClassMethod', 'ClassPrivateMethod'].includes(node.type);
    if (method && node.computed) visit(node.key, owner, node, [...ancestors, node]);
    if (functionTypes.has(node.type) && node.body) {
      owner = {
        name: functionName(node, parent, ancestors),
        line: node.loc.start.line, column: node.loc.start.column + 1,
        endLine: node.loc.end.line, complexity: 1, points: [],
        start: node.start, end: node.end,
        bodyStart: node.body.start, bodyEnd: node.body.end,
        bodyLoc: node.body.loc.start, bodyEndLine: node.body.loc.end.line,
        excludedRanges: [],
        curriedArrow: node.type === 'ArrowFunctionExpression' && node.body.type === 'ArrowFunctionExpression',
      };
      // A directly returned arrow is nested function syntax, not independent
      // parent statements. Mapped statements can drift into its signature.
      if (owner.curriedArrow) owner.excludedRanges.push([node.body.start, node.body.end]);
      functions.push(owner);
    } else if (classInitializers.has(node.type)) {
      // Initializers run outside the surrounding function. Still visit any functions inside them.
      if (owner) owner.excludedRanges.push([node.start, node.end]);
      owner = undefined;
    }
    const kind = owner && decisionKind(node);
    if (kind) {
      owner.complexity++;
      owner.points.push({ line: node.loc.start.line, kind });
    }
    for (const child of childNodes(node, method)) visit(child, owner, node, [...ancestors, node]);
  }
  visit(ast.program, undefined, undefined, []);
  for (const fn of functions) fn.points.sort((a, b) => a.line - b.line);
  return functions.sort((a, b) => a.start - b.start);
}

export function selectFunctions(functions, { name, line } = {}) {
  let selected = functions;
  if (name !== undefined) {
    selected = selected.filter(fn => fn.name === name || fn.name.split('.').at(-1) === name);
  }
  if (line !== undefined) {
    selected = selected.filter(fn => fn.line <= line && fn.endLine >= line)
      .sort((a, b) => (a.end - a.start) - (b.end - b.start)).slice(0, 1);
  }
  if ((name !== undefined || line !== undefined) && !selected.length) {
    throw new Error(`No function matches ${name ? JSON.stringify(name) : ''}${line ? ` at line ${line}` : ''}.`);
  }
  if (name !== undefined && selected.length > 1) {
    throw new Error(`Several functions match ${JSON.stringify(name)} (lines ${selected.map(fn => fn.line).join(', ')}). Add --line.`);
  }
  return selected;
}

const unavailable = reason => ({ coverage: { status: 'unavailable', reason }, crap: null });
const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);

/** Exact body matches take precedence; declaration endpoints rescue mapped curries.
 * Every candidate reserves its entry, including ambiguous exact matches, so a
 * fallback cannot borrow another function's counter. Never break ties by order.
 */
function matchCoverageFunctions(functions, fnMap) {
  const entries = Object.entries(fnMap);
  const candidates = new Map(functions.map(fn => {
    const exact = entries.filter(([, item]) => item?.loc?.start?.line === fn.bodyLoc.line
      && item.loc.start.column === fn.bodyLoc.column && item.loc.end?.line === fn.bodyEndLine);
    if (exact.length || !fn.curriedArrow) return [fn, exact];
    const anchored = entries.filter(([, item]) => item?.decl?.end?.line === fn.line
      && item.decl.end.column === fn.column && item.loc?.end?.line === fn.bodyEndLine);
    return [fn, anchored];
  }));
  const claims = new Map();
  for (const matches of candidates.values()) {
    for (const [id] of matches) claims.set(id, (claims.get(id) ?? 0) + 1);
  }
  return new Map(functions.map(fn => {
    const matches = candidates.get(fn);
    const id = matches.length === 1 ? matches[0][0] : undefined;
    return [fn, claims.get(id) === 1 ? id : undefined];
  }));
}

/** Attribute statements before combining line hits, so nested/inline functions stay separate. */
export function measureCoverage(source, functions, entry) {
  if (!isRecord(entry) || !['fnMap', 'f', 'statementMap', 's'].every(key => isRecord(entry[key]))) {
    throw new Error('Expected an Istanbul coverage-final.json file with fnMap, f, statementMap and s.');
  }
  const offsets = [0];
  for (let i = 0; i < source.length; i++) if (source[i] === '\n') offsets.push(i + 1);
  function offset(point) {
    if (!Number.isInteger(point?.line) || point.line < 1 || point.line > offsets.length
      || !Number.isInteger(point.column) || point.column < 0) throw new Error('Invalid statement location in coverage report.');
    const start = offsets[point.line - 1];
    const end = offsets[point.line] ?? source.length;
    if (start + point.column > end) throw new Error('Coverage location is outside the source. Regenerate coverage.');
    return start + point.column;
  }
  const hits = new Map(functions.map(fn => [fn, new Map()]));
  const innermost = [...functions].sort((a, b) => (a.bodyEnd - a.bodyStart) - (b.bodyEnd - b.bodyStart));
  for (const [id, statement] of Object.entries(entry.statementMap)) {
    const at = offset(statement?.start);
    const count = entry.s[id];
    if (!Number.isFinite(count) || count < 0) throw new Error('Invalid statement counter in coverage report.');
    const owner = innermost.find(fn => fn.bodyStart <= at && at < fn.bodyEnd);
    if (owner?.excludedRanges.some(([start, end]) => start <= at && at < end)) continue;
    if (owner) {
      const lines = hits.get(owner);
      lines.set(statement.start.line, Math.max(lines.get(statement.start.line) ?? 0, count));
    }
  }
  const matches = matchCoverageFunctions(functions, entry.fnMap);
  return new Map(functions.map(fn => {
    const id = matches.get(fn);
    if (id === undefined) return [fn, unavailable('Function does not match the coverage source positions. Regenerate coverage; for curried arrows, see references/tool.md for the block-bodied rewrite.')];
    const calls = entry.f[id];
    if (!Number.isFinite(calls) || calls < 0) throw new Error('Invalid function counter in coverage report.');
    const lines = hits.get(fn);
    const covered = [...lines.values()].filter(count => count > 0).length;
    if (calls === 0 && covered > 0) return [fn, unavailable('Function and statement counters disagree. Regenerate coverage.')];
    // An empty body has no line counters; use its call counter to distinguish called from uncalled.
    const fraction = lines.size ? covered / lines.size : Number(calls > 0);
    return [fn, {
      coverage: {
        status: 'available', percent: fraction * 100, coveredLines: covered,
        executableLines: lines.size, calls,
        uncoveredLines: [...lines].filter(([, count]) => count === 0).map(([line]) => line).sort((a, b) => a - b),
      },
      crap: fn.complexity ** 2 * (1 - fraction) ** 3 + fn.complexity,
    }];
  }));
}

export function functionResults(functions, measurements, reason = 'No coverage report. Use --test or --coverage to calculate CRAP.', breakdown = false) {
  return functions.map(fn => {
    const { name, line, column, endLine, complexity, points } = fn;
    return {
      name, line, column, endLine, complexity, ...(breakdown ? { decisionPoints: points } : {}),
      ...(measurements?.get(fn) ?? unavailable(reason)),
    };
  });
}

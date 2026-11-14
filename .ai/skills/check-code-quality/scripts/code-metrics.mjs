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
    plugins: [...(typed ? [['typescript', { dts: /\.d\.[cm]?tsx?$/i.test(filename) }]] : []), ...(jsx ? ['jsx'] : [])],
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
      };
      functions.push(owner);
    } else if (classInitializers.has(node.type)) {
      // Initializers run outside the surrounding function. Still visit any functions inside them.
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

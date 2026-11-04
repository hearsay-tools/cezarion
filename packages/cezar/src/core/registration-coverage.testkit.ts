import { parse } from '@babel/parser';
import { traverse, type Node } from '@babel/types';

function allowedDeclaration(node: Node, parent: Node | undefined): boolean {
  if (parent?.type === 'ImportSpecifier') {
    return parent.imported.type === 'Identifier' && parent.imported.name === parent.local.name;
  }
  if (parent?.type === 'FunctionDeclaration') return parent.id === node;
  if (parent?.type === 'ExportSpecifier') {
    return parent.local.type === 'Identifier' && parent.exported.type === 'Identifier' && parent.local.name === parent.exported.name;
  }
  return false;
}

export const NATIVE_TOOL_REGISTRATION = 'registerCiNativeTools';

function registrationReference(node: Node, parent: Node | undefined, callee: string): Node | undefined {
  const name = callee.split('.').at(-1);
  if (node.type === 'Identifier' && node.name === name) {
    if (callee.includes('.') && parent?.type === 'MemberExpression' && parent.property === node) return parent;
    return node;
  }
  if (node.type === 'StringLiteral' && node.value === name) return node;
  if (node.type === 'TemplateElement' && (node.value.raw === name || node.value.cooked === name)) return node;
  return undefined;
}

function supportedGroup(node: Node, catalog: string, knownGroups: readonly string[]): string | undefined {
  if (node.type !== 'CallExpression' || node.arguments.length !== 1) return undefined;
  const argument = node.arguments[0];
  if (argument?.type !== 'MemberExpression' || argument.computed || argument.object.type !== 'Identifier'
    || argument.object.name !== catalog || argument.property.type !== 'Identifier') return undefined;
  return knownGroups.includes(argument.property.name) ? argument.property.name : undefined;
}

function declaresTest(call: Node, path: readonly Node[], callee: string): Node | undefined {
  if (callee !== 'it.each') return call;
  const outer = path[path.indexOf(call) - 1];
  if (outer?.type !== 'CallExpression' || outer.callee !== call || outer.arguments.length !== 2) return undefined;
  const [name, callback] = outer.arguments;
  if (name?.type !== 'StringLiteral' || !callback || !['ArrowFunctionExpression', 'FunctionExpression'].includes(callback.type)) return undefined;
  return outer;
}

function suiteOptions(suite: Node): boolean {
  if (suite.type !== 'CallExpression') return false;
  if (suite.arguments.length === 2) return true;
  const options = suite.arguments[1];
  return suite.arguments.length === 3 && options?.type === 'ObjectExpression' && options.properties.every(property =>
    property.type === 'ObjectProperty' && !property.computed && property.key.type === 'Identifier'
    && property.key.name === 'timeout' && property.value.type === 'NumericLiteral');
}

function synchronousSuiteCallback(callback: Node | undefined, body: Node): boolean {
  if (!callback || (callback.type !== 'ArrowFunctionExpression' && callback.type !== 'FunctionExpression')) return false;
  if (callback.async || callback.generator || callback.params.length !== 0 || callback.body !== body) return false;
  let abrupt = false;
  traverse(body, (node, ancestors) => {
    if (node.type !== 'ReturnStatement' && node.type !== 'ThrowStatement') return;
    const nestedFunction = ancestors.some(ancestor => ['ArrowFunctionExpression', 'FunctionExpression', 'FunctionDeclaration', 'ObjectMethod', 'ClassMethod'].includes(ancestor.node.type));
    if (!nestedFunction) abrupt = true;
  });
  return !abrupt;
}

/** Only module statements and synchronous describe callbacks execute at collection time. */
function collectionStatement(statement: Node, path: readonly Node[]): boolean {
  if (statement.type !== 'ExpressionStatement') return false;
  const containerIndex = path.indexOf(statement) - 1;
  const container = path[containerIndex];
  if (container?.type === 'Program') return true;
  if (container?.type !== 'BlockStatement') return false;
  const callback = path[containerIndex - 1];
  if (!synchronousSuiteCallback(callback, container)) return false;
  const suite = path[containerIndex - 2];
  if (suite?.type !== 'CallExpression' || suite.callee.type !== 'Identifier' || suite.callee.name !== 'describe'
    || !suiteOptions(suite) || suite.arguments.at(-1) !== callback || suite.arguments[0]?.type !== 'StringLiteral') return false;
  const suiteStatement = path[containerIndex - 3];
  return suiteStatement?.type === 'ExpressionStatement' && suiteStatement.expression === suite
    && collectionStatement(suiteStatement, path);
}

function executesRegistration(call: Node, path: readonly Node[], callee: string): boolean {
  const declaration = declaresTest(call, path, callee);
  if (!declaration) return false;
  const statement = path[path.indexOf(declaration) - 1];
  return statement?.type === 'ExpressionStatement' && statement.expression === declaration && collectionStatement(statement, path);
}

/** Every reference must be an unchanged declaration/import/export or a supported plain call. */
function registrationArguments(source: string, file: string, callee: string, argumentValue: (call: Node) => string | undefined): string[] {
  const groups: string[] = [];
  const tree = parse(source, { sourceType: 'module', plugins: ['typescript'], allowUndeclaredExports: true });
  traverse(tree, (node, ancestors) => {
    const parent = ancestors.at(-1)?.node;
    const reference = registrationReference(node, parent, callee);
    if (!reference || allowedDeclaration(node, parent)) return;
    const call = reference === parent ? ancestors.at(-2)?.node : parent;
    const plainMember = reference.type === 'MemberExpression' && !reference.computed && reference.object.type === 'Identifier'
      && reference.property.type === 'Identifier' && `${reference.object.name}.${reference.property.name}` === callee;
    const plainCallee = reference.type === 'Identifier' && reference.name === callee;
    const group = call?.type === 'CallExpression' && call.callee === reference && (plainCallee || plainMember)
      ? argumentValue(call) : undefined;
    const path = ancestors.map(ancestor => ancestor.node).concat(node);
    if (group === undefined || !call || !executesRegistration(call, path, callee)) {
      const form = call ?? reference;
      throw new Error(`${file}: unsupported ${callee} registration: ${source.slice(form.start!, form.end!)}`);
    }
    groups.push(group);
  });
  return groups;
}

/** Scan catalog-member registrations with the same reference and execution rules. */
export function registrationGroups(source: string, file: string, callee: string, catalog: string, knownGroups: readonly string[]): string[] {
  return registrationArguments(source, file, callee, call => supportedGroup(call, catalog, knownGroups));
}

/** Literal partitions only: other arguments and every unsupported reference are errors. */
export function registrationStrings(source: string, file: string, callee: string): string[] {
  return registrationArguments(source, file, callee, call => {
    if (call.type !== 'CallExpression' || call.arguments.length !== 1) return undefined;
    const argument = call.arguments[0];
    return argument?.type === 'StringLiteral' ? argument.value : undefined;
  });
}

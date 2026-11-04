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

function registrationReference(node: Node, parent: Node | undefined, callee: string): Node | undefined {
  const [owner, member] = callee.split('.');
  const name = member ?? owner;
  if (node.type === 'Identifier' && node.name === name) {
    if (!member) return node;
    if (parent?.type === 'MemberExpression' && parent.property === node) return parent;
    return node;
  }
  if (node.type === 'StringLiteral' && node.value === name && parent?.type === 'MemberExpression' && parent.property === node) return parent;
  return undefined;
}

function supportedGroup(node: Node, catalog: string, knownGroups: readonly string[]): string | undefined {
  if (node.type !== 'CallExpression' || node.arguments.length !== 1) return undefined;
  const argument = node.arguments[0];
  if (argument?.type !== 'MemberExpression' || argument.computed || argument.object.type !== 'Identifier'
    || argument.object.name !== catalog || argument.property.type !== 'Identifier') return undefined;
  return knownGroups.includes(argument.property.name) ? argument.property.name : undefined;
}

/** Every reference must be an unchanged declaration/import/export or a supported plain call. */
export function registrationGroups(source: string, file: string, callee: string, catalog: string, knownGroups: readonly string[]): string[] {
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
      ? supportedGroup(call, catalog, knownGroups) : undefined;
    if (group === undefined) {
      const form = call ?? reference;
      throw new Error(`${file}: unsupported ${callee} registration: ${source.slice(form.start!, form.end!)}`);
    }
    groups.push(group);
  });
  return groups;
}

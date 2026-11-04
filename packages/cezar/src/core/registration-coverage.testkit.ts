import { parse } from '@babel/parser';
import { traverseFast } from '@babel/types';

/** Count real calls only; unsupported syntax must never hide a registration. */
export function registrationGroups(source: string, file: string, callee: string, catalog: string, knownGroups: readonly string[]): string[] {
  const groups: string[] = [];
  const tree = parse(source, { sourceType: 'module', plugins: ['typescript'] });
  traverseFast(tree, node => {
    if (node.type !== 'CallExpression') return;
    const called = node.callee;
    const name = called.type === 'Identifier' ? called.name
      : called.type === 'MemberExpression' && !called.computed && called.object.type === 'Identifier' && called.property.type === 'Identifier'
        ? `${called.object.name}.${called.property.name}` : undefined;
    if (name !== callee) return;
    const argument = node.arguments[0];
    const group = argument?.type === 'MemberExpression' && !argument.computed && argument.object.type === 'Identifier'
      && argument.object.name === catalog && argument.property.type === 'Identifier' ? argument.property.name : undefined;
    if (node.arguments.length !== 1 || group === undefined || !knownGroups.includes(group)) {
      throw new Error(`${file}: unsupported ${callee} registration: ${source.slice(node.start!, node.end!)}`);
    }
    groups.push(group);
  });
  return groups;
}

import { parse } from '@babel/parser';
import { traverse, type Node } from '@babel/types';

function unreadable(file: string): never {
  throw new Error(`${file}: a module load whose target is not a literal import specifier`);
}

function staticImport(node: Node): string | undefined {
  if (node.type === 'ImportDeclaration') {
    const typeOnly = node.importKind === 'type' ||
      (node.specifiers.length > 0 && node.specifiers.every(spec => spec.type === 'ImportSpecifier' && spec.importKind === 'type'));
    return typeOnly ? undefined : node.source.value;
  }
  if ((node.type === 'ExportNamedDeclaration' || node.type === 'ExportAllDeclaration') && node.source) {
    return node.exportKind === 'type' ? undefined : node.source.value;
  }
  if (node.type === 'TSImportEqualsDeclaration' && node.moduleReference.type === 'TSExternalModuleReference') {
    return node.importKind === 'type' ? undefined : node.moduleReference.expression.value;
  }
  return undefined;
}

function dynamicLoad(node: Node, file: string): string | undefined {
  if (node.type === 'ImportExpression') return node.source.type === 'StringLiteral' ? node.source.value : unreadable(file);
  if (node.type !== 'CallExpression') return undefined;
  if (node.callee.type === 'Identifier' && node.callee.name === 'require') return unreadable(file);
  if (node.callee.type !== 'Import') return undefined;
  const [target] = node.arguments;
  return target?.type === 'StringLiteral' ? target.value : unreadable(file);
}

/** Every module a TypeScript source loads at run time: static imports (side-effect ones too),
 *  `export ... from` and `import()` with a literal specifier. Type-only imports and exports are
 *  left out. A form whose target cannot be read, such as `import(name)` or `require`, throws, so
 *  a guard built on this list fails closed (hearsay-tools/cezarion#3242). */
export function runtimeImports(source: string, file = 'source'): string[] {
  const tree = parse(source, { sourceType: 'module', plugins: ['typescript'] });
  const found: string[] = [];
  traverse(tree, (node) => {
    const specifier = staticImport(node) ?? dynamicLoad(node, file);
    if (specifier !== undefined) found.push(specifier);
  });
  return found;
}

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { parse } from '@babel/parser';

type Node = { type: string; start?: number | null; end?: number | null; [key: string]: unknown };

/** The module a dynamic import's argument names, when it is one string or one plain template. */
function literalSpecifier(argument: Node | undefined): string | undefined {
  if (argument?.type === 'StringLiteral') return argument.value as string;
  if (argument?.type !== 'TemplateLiteral' || (argument.expressions as unknown[]).length > 0) return undefined;
  return ((argument.quasis as Array<{ value: { cooked: string } }>)[0]!).value.cooked;
}

/**
 * Every module specifier `source` imports for its values, read from its syntax tree: value
 * `import` and `export … from` declarations, and `import()` expressions. TypeScript erases
 * type-only imports and `import('…').T` type queries, so they are not counted. A dynamic import
 * whose argument is not one literal throws: a closure pin that skipped it would fail open.
 * `file` picks the JSX grammar for a `.jsx` or `.tsx` source.
 */
export function runtimeImports(source: string, file = 'module.ts'): string[] {
  const ast = parse(source, {
    sourceType: 'module',
    plugins: ['typescript', ...(/\.[cm]?[jt]sx$/.test(file) ? ['jsx' as const] : [])],
  }) as unknown as Node;
  const found: string[] = [];
  const visit = (node: Node): void => {
    if (node.type === 'TSImportType') return;
    if (node.type === 'ImportDeclaration' && node.importKind !== 'type') found.push((node.source as Node).value as string);
    if ((node.type === 'ExportNamedDeclaration' || node.type === 'ExportAllDeclaration') && node.source && node.exportKind !== 'type') {
      found.push((node.source as Node).value as string);
    }
    const argument = node.type === 'ImportExpression' ? node.source as Node
      : node.type === 'CallExpression' && (node.callee as Node).type === 'Import' ? (node.arguments as Node[])[0] : undefined;
    if (node.type === 'ImportExpression' || argument) {
      const specifier = literalSpecifier(argument);
      if (specifier === undefined) {
        throw new Error(`${file}: a runtime import names no literal module, so its closure cannot be walked: ${source.slice(node.start ?? 0, node.end ?? 0)}`);
      }
      found.push(specifier);
    }
    for (const [key, value] of Object.entries(node)) {
      if (key === 'leadingComments' || key === 'trailingComments' || key === 'innerComments') continue;
      for (const child of Array.isArray(value) ? value : [value]) {
        if (child && typeof child === 'object' && typeof (child as Node).type === 'string') visit(child as Node);
      }
    }
  };
  visit(ast);
  return found;
}

/** The relative modules `source` imports for their values; type-only imports are erased. */
export function relativeImports(source: string, file?: string): string[] {
  return runtimeImports(source, file).filter(specifier => specifier.startsWith('./') || specifier.startsWith('../'));
}

/** Every module `entry` (an absolute `.ts` path) loads at runtime through relative imports, as absolute paths. */
export function importClosure(entry: string): string[] {
  const seen = new Set<string>();
  const visit = (path: string): void => {
    if (seen.has(path)) return;
    seen.add(path);
    for (const specifier of relativeImports(readFileSync(path, 'utf8'), path)) {
      visit(join(dirname(path), specifier).replace(/\.js$/, '.ts'));
    }
  };
  visit(entry);
  return [...seen].sort();
}

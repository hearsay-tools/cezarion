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

/** The module a value declaration loads: `import`, `export … from` or `import x = require('…')`. */
function declaredModule(node: Node): string | undefined {
  if (node.type === 'ImportDeclaration' && node.importKind !== 'type') return (node.source as Node).value as string;
  const reExport = node.type === 'ExportNamedDeclaration' || node.type === 'ExportAllDeclaration';
  if (reExport && node.source && node.exportKind !== 'type') return (node.source as Node).value as string;
  const reference = node.type === 'TSImportEqualsDeclaration' && node.importKind !== 'type' ? node.moduleReference as Node : undefined;
  return reference?.type === 'TSExternalModuleReference' ? (reference.expression as Node).value as string : undefined;
}

/** The argument of an expression that loads a module, `import(…)` or `require(…)`; null when it has none. */
function loadArgument(node: Node): Node | null | undefined {
  if (node.type === 'ImportExpression') return node.source as Node;
  if (node.type !== 'CallExpression') return undefined;
  const callee = node.callee as Node;
  const loads = callee.type === 'Import' || (callee.type === 'Identifier' && callee.name === 'require');
  return loads ? (node.arguments as Node[])[0] ?? null : undefined;
}

/** The syntax nodes directly under `node`, comments left out. */
function children(node: Node): Node[] {
  return Object.entries(node)
    .filter(([key]) => !key.endsWith('Comments'))
    .flatMap(([, value]) => (Array.isArray(value) ? value : [value]))
    .filter((child): child is Node => Boolean(child) && typeof child === 'object' && typeof (child as Node).type === 'string');
}

/**
 * Every module specifier `source` loads at runtime, read from its syntax tree: value `import`,
 * `export … from` and `import x = require(…)` declarations, and `import(…)` and `require(…)`
 * calls. TypeScript erases type-only imports and `import('…').T` type queries, so they are not
 * counted. A load whose argument is not one literal throws: a closure pin that skipped it would
 * fail open. `file` picks the JSX grammar for a `.jsx` or `.tsx` source.
 */
export function runtimeImports(source: string, file = 'module.ts'): string[] {
  const ast = parse(source, {
    sourceType: 'module',
    plugins: ['typescript', ...(/\.[cm]?[jt]sx$/.test(file) ? ['jsx' as const] : [])],
  }) as unknown as Node;
  const found: string[] = [];
  const visit = (node: Node): void => {
    if (node.type === 'TSImportType') return;
    const declared = declaredModule(node);
    const argument = declared === undefined ? loadArgument(node) : undefined;
    if (declared !== undefined) found.push(declared);
    else if (argument !== undefined) found.push(literalOrThrow(argument ?? undefined, file, source.slice(node.start ?? 0, node.end ?? 0)));
    children(node).forEach(visit);
  };
  visit(ast);
  return found;
}

function literalOrThrow(argument: Node | undefined, file: string, call: string): string {
  const specifier = literalSpecifier(argument);
  if (specifier === undefined) throw new Error(`${file}: a runtime import names no literal module, so its closure cannot be walked: ${call}`);
  return specifier;
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

import { parse } from '@babel/parser';
import type { Node } from '@babel/types';
import { TEST_FILE } from './home-boundary.ts';
import { lineAt, type SourceRule } from './source-rule.ts';

const SOURCES = new Set(['homedir', 'cezarHomeDir', 'resolveHome']);
const EXPRESSIONS = new Set(['TSAsExpression', 'TSTypeAssertion', 'TSNonNullExpression', 'TSSatisfiesExpression', 'TSInstantiationExpression']);
const TYPE_ONLY = new Set([
  'TSTypeAnnotation', 'TSTypeParameterDeclaration', 'TSTypeParameterInstantiation', 'TSTypeParameter',
  'TSInterfaceDeclaration', 'TSInterfaceBody', 'TSTypeAliasDeclaration', 'TSDeclareFunction', 'TSDeclareMethod',
  'TSTypeReference', 'TSTypeLiteral', 'TSTypeQuery', 'TSImportType', 'TSExpressionWithTypeArguments', 'TSClassImplements',
  'TSMappedType', 'TSUnionType', 'TSIntersectionType', 'TSConditionalType', 'TSInferType', 'TSParenthesizedType',
  'TSTypeOperator', 'TSIndexedAccessType', 'TSArrayType', 'TSTupleType', 'TSNamedTupleMember', 'TSOptionalType', 'TSRestType',
  'TSFunctionType', 'TSConstructorType', 'TSLiteralType', 'TSTypePredicate', 'TSMethodSignature', 'TSPropertySignature',
  'TSCallSignatureDeclaration', 'TSConstructSignatureDeclaration', 'TSIndexSignature',
]);

/** Read syntax only. Computed expressions are never evaluated. */
function guarded(node: Node | null | undefined): boolean {
  return node?.type === 'Identifier' ? SOURCES.has(node.name)
    : node?.type === 'StringLiteral' && SOURCES.has(node.value);
}

function children(node: Node): Node[] {
  return Object.entries(node).flatMap(([key, value]) => {
    if (['typeAnnotation', 'typeParameters', 'typeArguments'].includes(key)) return [];
    return (Array.isArray(value) ? value : [value]).filter((child): child is Node => {
      return child && typeof child === 'object' && typeof child.type === 'string';
    });
  });
}

/** Type syntax cannot import or invoke a runtime home source. */
function runtimeChildren(node: Node): Node[] | undefined {
  if (EXPRESSIONS.has(node.type)) return [(node as Node & { expression: Node }).expression];
  if (TYPE_ONLY.has(node.type) || ('declare' in node && node.declare)) return [];
  if (node.type === 'TSModuleDeclaration' && node.id.type === 'StringLiteral') return [];
  if ('importKind' in node && node.importKind === 'type') return [];
  if ('exportKind' in node && node.exportKind === 'type') return [];
  return undefined;
}

function bareCall(node: Node): Node[] {
  let callee = (node as Node & { callee: Node }).callee;
  while (EXPRESSIONS.has(callee.type)) callee = (callee as Node & { expression: Node }).expression;
  return callee.type === 'Identifier' && guarded(callee) ? [callee] : [];
}

function sites(node: Node, parent: Node | undefined): Node[] {
  if (node.type === 'CallExpression' || node.type === 'OptionalCallExpression') return bareCall(node);
  if (node.type === 'MemberExpression' || node.type === 'OptionalMemberExpression') return guarded(node.property) ? [node.property] : [];
  if (node.type === 'ObjectProperty' && parent?.type === 'ObjectPattern') return guarded(node.key) ? [node.key] : [];
  if (node.type === 'ImportSpecifier') return [node.imported, node.local].filter(guarded);
  if (node.type === 'ExportSpecifier') return [node.local, node.exported].filter(guarded);
  if (node.type === 'ImportDefaultSpecifier' || node.type === 'ImportNamespaceSpecifier') return guarded(node.local) ? [node.local] : [];
  if (node.type === 'ExportNamespaceSpecifier' || node.type === 'ExportDefaultSpecifier') return guarded(node.exported) ? [node.exported] : [];
  return [];
}

/** Ban guarded syntax instead of attempting open-ended binding or value flow. */
export function unsafeHomeWrites(source: string, file = 'file.test.ts'): number[] {
  const ast = parse(source, { sourceType: 'unambiguous', plugins: ['typescript', 'decorators', ...(/\.[cm]?[jt]sx$/.test(file) ? ['jsx' as const] : [])] });
  const allowedLines = new Set((ast.comments ?? []).filter(comment => comment.type === 'CommentLine'
    && /^\s*test-home-read:\s*\S/.test(comment.value)).map(comment => comment.loc?.start.line));
  const offsets = new Set<number>();
  function scan(node: Node, parent?: Node): void {
    const selected = runtimeChildren(node);
    if (selected) { for (const child of selected) scan(child, node); return; }
    for (const site of sites(node, parent)) if (!allowedLines.has(site.loc?.start.line)) offsets.add(site.start ?? 0);
    for (const child of children(node)) scan(child, node);
  }
  scan(ast);
  return [...offsets].sort((a, b) => a - b);
}

export const testHomeWrite: SourceRule = {
  name: 'test-home-write',
  description: 'Test home syntax requires a reasoned exception (hearsay-tools/cezarion#2813).',
  applies: file => TEST_FILE.test(file),
  check: (file, source) => unsafeHomeWrites(source, file).map(offset => ({
    line: lineAt(source, offset),
    message: 'Ambient home syntax in a test; use Home.sandbox or add // test-home-read: <reason> on this line (hearsay-tools/cezarion#2813).',
  })),
};

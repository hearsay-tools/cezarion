import { parse } from '@babel/parser';
import type { Node } from '@babel/types';
import { property, unwrapped, visit } from './home-boundary.ts';
import { lineAt, type SourceRule } from './source-rule.ts';

const SOURCES = new Set(['homedir', 'cezarHomeDir']);

function sourceRef(node: Node | undefined | null, aliases: Set<string>): boolean {
  if (!node) return false;
  const target = unwrapped(node);
  if (target.type === 'Identifier') return aliases.has(target.name);
  if (target.type === 'SequenceExpression') return sourceRef(target.expressions.at(-1), aliases);
  if (target.type === 'CallExpression' || target.type === 'OptionalCallExpression') {
    const callee = unwrapped(target.callee);
    return (callee.type === 'MemberExpression' || callee.type === 'OptionalMemberExpression')
      && property(callee) === 'bind' && sourceRef(callee.object, aliases);
  }
  if (target.type !== 'MemberExpression' && target.type !== 'OptionalMemberExpression') return false;
  const key = property(target);
  return SOURCES.has(key ?? '') || (['call', 'apply'].includes(key ?? '') && sourceRef(target.object, aliases));
}

function sourceAliases(ast: Node): Set<string> {
  const aliases = new Set(SOURCES);
  visit(ast, node => {
    if (node.type === 'ImportSpecifier' && SOURCES.has(property(node.imported) ?? '')) aliases.add(node.local.name);
    if (node.type !== 'VariableDeclarator' || node.id.type !== 'ObjectPattern') return;
    for (const field of node.id.properties) {
      if (field.type === 'ObjectProperty' && SOURCES.has(property(field.key) ?? '') && field.value.type === 'Identifier') aliases.add(field.value.name);
    }
  });
  return aliases;
}

function ambientCall(node: Node, aliases: Set<string>): boolean {
  if (node.type !== 'CallExpression' && node.type !== 'OptionalCallExpression') return false;
  const callee = unwrapped(node.callee);
  if ((callee.type === 'MemberExpression' || callee.type === 'OptionalMemberExpression')
    && property(callee) === 'apply' && callee.object.type === 'Identifier' && callee.object.name === 'Reflect') {
    return sourceRef(node.arguments[0], aliases);
  }
  return sourceRef(callee, aliases);
}

/** Ban the source rather than trying to prove every possible filesystem sink safe. */
export function unsafeHomeWrites(source: string, file = 'file.test.ts'): number[] {
  const ast = parse(source, { sourceType: 'unambiguous', plugins: ['typescript', ...(file.endsWith('.tsx') ? ['jsx' as const] : [])] });
  const aliases = sourceAliases(ast);
  const allowedLines = new Set((ast.comments ?? []).filter(comment => comment.type === 'CommentLine'
    && /^\s*test-home-read:\s*\S/.test(comment.value)).map(comment => comment.loc?.start.line));
  const sites: number[] = [];
  visit(ast, node => {
    if (ambientCall(node, aliases) && !allowedLines.has(node.loc?.start.line)) sites.push(node.start ?? 0);
  });
  return sites;
}

export const testHomeWrite: SourceRule = {
  name: 'test-home-write',
  description: 'Test home sources require a reasoned read-only exception (hearsay-tools/cezarion#2813).',
  applies: file => /\.(?:test\.tsx?|testkit\.ts|test\.[mc]js)$/.test(file),
  check: (file, source) => unsafeHomeWrites(source, file).map(offset => ({
    line: lineAt(source, offset),
    message: 'Ambient home call in a test; use Home.sandbox or add // test-home-read: <read-only reason> on the call line (hearsay-tools/cezarion#2813).',
  })),
};

import { parse } from '@babel/parser';
import { collectBindings } from './test-home-bindings.ts';
import { hasHome, valueOf, writeFunctions } from './test-home-values.ts';
import { lineAt, type SourceRule } from './source-rule.ts';

const TWO_PATHS = /^(?:rename|copyFile|cp|symlink|link)(?:Sync)?$/;

/** No baseline: test paths must not come from an ambient home. */
export function unsafeHomeWrites(source: string, file = 'file.test.ts'): number[] {
  const ast = parse(source, { sourceType: 'unambiguous', plugins: ['typescript', ...(file.endsWith('.tsx') ? ['jsx' as const] : [])] });
  const bindings = collectBindings(ast);
  return bindings.nodes.flatMap(node => {
    if (node.type !== 'CallExpression' && node.type !== 'OptionalCallExpression') return [];
    const writes = writeFunctions(valueOf(node.callee, bindings));
    return writes.some(method => node.arguments.slice(0, TWO_PATHS.test(method) ? 2 : 1)
      .some(path => hasHome(valueOf(path, bindings)))) ? [node.start ?? 0] : [];
  });
}

export const testHomeWrite: SourceRule = {
  name: 'test-home-write',
  description: 'Test writes use sandbox paths (hearsay-tools/cezarion#2813).',
  applies: file => /\.(?:test\.tsx?|testkit\.ts|test\.[mc]js)$/.test(file),
  check: (file, source) => unsafeHomeWrites(source, file).map(offset => ({
    line: lineAt(source, offset),
    message: 'Ambient home reaches a filesystem write; use a path from Home.sandbox (hearsay-tools/cezarion#2813).',
  })),
};

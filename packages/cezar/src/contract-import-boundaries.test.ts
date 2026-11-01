import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { contractModules, hint, scanRootImports } from './lint/contract-root-import.ts';

/**
 * The scanner behind `cez/contract-root-import` (hearsay-tools/cezarion#1237): contract values
 * load through module subpaths, never through a package root. `npm run lint` applies it to the
 * repository; these cases pin what it refuses and allows.
 */
const repo = join(import.meta.dirname, '../../..');

describe('scanning one file', () => {
  const R = '@open-mercato/cezar-contract';
  const kinds = (source: string) => scanRootImports('x.ts', source).map((site) => site.kind);

  it.each([
    [`import { a } from '${R}'`, 'value-import'],
    [`import { type A } from '${R}'`, 'value-import'],
    [`import '${R}'`, 'side-effect'],
    [`import * as c from '${R}'`, 'namespace'],
    [`import d from '${R}'`, 'default'],
    [`export { a } from '${R}'`, 're-export'],
    [`export * from '${R}'`, 're-export'],
    [`const m = await import('${R}')`, 'dynamic'],
    [`import { a } from '${R}/index'`, 'value-import'],
    [`import { a } from "@open-mercato/cezar-api-client"`, 'value-import'],
    [`const m = await import(\`${R}\`)`, 'dynamic'],
    [`const t = typeof import('${R}')`, 'dynamic'],
    [`type T = X\nconst m = import('${R}')`, 'dynamic'],
    [`type T = X; const m = import('${R}')`, 'dynamic'],
    [`{ type T = X } const m = import('${R}')`, 'dynamic'],
    [`type T = X\nconst m = c ?\n  import('${R}') : d`, 'dynamic'],
  ])('refuses %s', (source, kind) => {
    expect(kinds(source)).toEqual([kind]);
  });

  it.each([
    `import type { A } from '${R}'`,
    `import type {\n  A,\n  B,\n} from '${R}'`,
    `export type { A } from '${R}'`,
    `export type X = import('${R}').X`,
    `import { a } from '${R}/workspace'`,
    `const s = "import { a } from '${R}'"`,
    `const t = \`export * from '${R}'\``,
    `// import { a } from '${R}'`,
    `type T =\n  import('${R}').RunRecord`,
    `type T =\n  | A\n  | import('${R}').B`,
    `type T = {\n  a: A;\n  b: import('${R}').B;\n}`,
    `type T = Map<\n  string,\n  import('${R}').B\n>`,
    `export type M = typeof import('${R}')`,
    `declare type T = import('${R}').X`,
    `type T<X extends Foo<Bar>> = import('${R}').X`,
    `type T<X extends { a: A; b: B }> = import('${R}').X`,
  ])('allows %s', (source) => {
    expect(kinds(source)).toEqual([]);
  });

  it('names the specifiers and the line of a multi-line declaration', () => {
    expect(scanRootImports('x.ts', `const a = 1;\nimport {\n  b,\n  type C,\n  d as e,\n} from '${R}';`)).toEqual([
      { file: 'x.ts', line: 2, root: R, kind: 'value-import', names: ['b', 'type C', 'd'] },
    ]);
  });
});

describe('the diagnostic', () => {
  const site = (root: string, names: string[]) => scanRootImports('x.ts', `import { ${names.join(', ')} } from '${root}'`)[0]!;

  it('names the subpath that defines each value, for each root', () => {
    expect(hint(site('@open-mercato/cezar-contract', ['agentConfigFormatSchema', 'type A']))).toBe(
      'value-import of @open-mercato/cezar-contract: agentConfigFormatSchema → @open-mercato/cezar-contract/agent-config, A → `import type` from the root',
    );
    expect(hint(site('@open-mercato/cezar-api-client', ['agentConfigFormatSchema', 'API_PREFIX', 'nothingByThisName']))).toBe(
      'value-import of @open-mercato/cezar-api-client: agentConfigFormatSchema → @open-mercato/cezar-api-client/contract/agent-config, ' +
        'API_PREFIX → @open-mercato/cezar-api-client/utils/project-scope, nothingByThisName → (no defining module found)',
    );
  });

  it('names only the kind and root of an import without names', () => {
    expect(hint(scanRootImports('x.ts', "import '@open-mercato/cezar-contract'")[0]!)).toBe('side-effect of @open-mercato/cezar-contract');
  });
});

describe('the api-client shims', () => {
  it('mirror the contract modules', () => {
    const shimDir = join(repo, 'packages/api-client/src/contract');
    const shims = readdirSync(shimDir).filter((name) => name.endsWith('.ts')).map((name) => name.slice(0, -'.ts'.length)).sort();
    expect(shims).toEqual(contractModules());
    for (const name of shims) {
      expect(readFileSync(join(shimDir, `${name}.ts`), 'utf8'), name).toBe(`export * from '@open-mercato/cezar-contract/${name}'\n`);
    }
  });
});

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { blank } from './test-wait-discipline.testkit.ts';

/**
 * Contract values load through module subpaths, never through a package root
 * (hearsay-tools/cezarion#1237).
 *
 * Both roots, `@open-mercato/cezar-contract` and `@open-mercato/cezar-api-client`, re-export every
 * contract module, delegation's schemas among them. A value imported through a root puts all of
 * them in the importer's runtime closure, so an edit to any shared schema reruns tests that never
 * use it. A type import costs nothing at runtime, so the roots stay open to `import type`, to
 * `export type … from` and to an `import('<root>').T` type query inside a type alias. Everything
 * else is refused here.
 */
const repo = join(import.meta.dirname, '../../..');
const ROOTS = ['@open-mercato/cezar-contract', '@open-mercato/cezar-api-client'];
const SCANNED = ['packages/cezar/src', 'packages/cezar/test', 'packages/web/src', 'packages/web/e2e', 'packages/api-client/src', 'packages/contract/src'];

/** Files allowed to import a root at runtime, each with its reason. This list only shrinks. */
const EXEMPT: Record<string, string> = {
  'packages/api-client/src/index.ts': 'the api-client barrel re-exports the contract root',
  'packages/web/src/test/api-client-subpaths.test.ts': 'pins that a root and its subpaths share one module instance',
};

type Kind = 'value-import' | 'side-effect' | 'namespace' | 'default' | 're-export' | 'dynamic';
interface RootImport { file: string; line: number; root: string; kind: Kind; names: string[] }

const rootOf = (specifier: string): string | undefined =>
  ROOTS.find((root) => specifier === root || specifier === `${root}/index`);

/** What a declaration ending in `from '<root>'` is, by its text up to `from`; undefined when it is a type. */
function declarationKind(head: string): Kind | undefined {
  if (/^(?:import|export) type\b/.test(head)) return undefined;
  if (/^export\b/.test(head)) return 're-export';
  if (/^import \* as\b/.test(head)) return 'namespace';
  if (/^import \{/.test(head)) return 'value-import';
  return 'default';
}

/**
 * The `=` of a type alias at a statement start. TypeScript needs the name on the line of `type`.
 * Type parameters end at the first `>` an `=` follows: the alias's own, or a parameter default's
 * inside the same alias.
 */
const ALIAS_HEAD = /(?:^|[;{}\n])\s*(?:export\s+)?(?:declare\s+)?type[ \t]+[\w$]+\s*(?:<[\s\S]*?>)?\s*=(?!>)/g;
/** A line that ends mid-type, and a line that starts mid-type: the type goes on past the break between. */
const ENDS_OPEN = /(?:[=|&,<:?.]|=>)\s*$/;
const STARTS_OPEN = /^\s*(?:[|&?:.,]|=>)/;

/**
 * Whether the blanked `code` ends inside a type alias, where `import('<root>')` is a type query.
 * The alias opened last runs from its `=` to a `;` at its own bracket depth, a bracket that closes
 * past that depth, or a line break at that depth between two lines that neither ends nor starts
 * mid-type. Outside an alias, `typeof import(…)` is an expression that runs the import.
 */
function insideTypeAlias(code: string): boolean {
  const head = [...code.matchAll(ALIAS_HEAD)].at(-1);
  if (head === undefined) return false;
  let depth = 0;
  for (let i = head.index + head[0].length; i < code.length; i++) {
    const ch = code.charAt(i);
    if ('([{'.includes(ch)) depth++;
    else if (')]}'.includes(ch)) {
      if (--depth < 0) return false;
    } else if (depth === 0 && ch === ';') return false;
    else if (depth === 0 && ch === '\n' && !ENDS_OPEN.test(code.slice(head.index, i)) && !STARTS_OPEN.test(code.slice(i + 1))) {
      return false;
    }
  }
  return true;
}

/** Every runtime import of a package root in `source`. Strings and comments are blanked first. */
export function scanRootImports(file: string, source: string): RootImport[] {
  const code = blank(source);
  const sites: RootImport[] = [];
  const lineAt = (offset: number) => source.slice(0, offset).split('\n').length;
  // `blank` keeps the quotes of each string and the backticks of each template, and turns their
  // content to spaces at the same offsets. A template keeps its `${…}`, so one with a
  // substitution never matches: no static scan can read its specifier.
  for (const match of code.matchAll(/([`'"]) *\1/g)) {
    const at = match.index;
    const root = rootOf(source.slice(at + 1, at + match[0].length - 1));
    if (root === undefined) continue;
    const before = code.slice(0, at);
    if (/\bimport\s*\(\s*$/.test(before)) {
      if (!insideTypeAlias(before)) sites.push({ file, line: lineAt(at), root, kind: 'dynamic', names: [] });
      continue;
    }
    if (/\bimport\s*$/.test(before)) {
      sites.push({ file, line: lineAt(at), root, kind: 'side-effect', names: [] });
      continue;
    }
    if (!/\bfrom\s*$/.test(before)) continue;
    const keywords = [...before.matchAll(/\b(?:import|export)\b/g)];
    const start = keywords.at(-1)?.index;
    if (start === undefined) continue;
    const head = before.slice(start).replace(/\s+/g, ' ').trim();
    const kind = declarationKind(head);
    if (kind === undefined) continue;
    const braces = /\{([^}]*)\}/.exec(head)?.[1] ?? '';
    const names = braces.split(',').map((name) => name.trim().replace(/\s+as\s+\S+$/, '')).filter(Boolean);
    sites.push({ file, line: lineAt(start), root, kind, names });
  }
  return sites;
}

function sourceFiles(dir: string): string[] {
  if (!existsSync(join(repo, dir))) return [];
  return readdirSync(join(repo, dir), { withFileTypes: true, recursive: true })
    .filter((entry) => entry.isFile() && /\.tsx?$/.test(entry.name))
    .map((entry) => relative(repo, join(entry.parentPath, entry.name)).replaceAll('\\', '/'))
    .filter((path) => !/\/(?:node_modules|dist|__fixtures__)\//.test(path))
    .sort();
}

const contractModules = () => readdirSync(join(repo, 'packages/contract/src'))
  .filter((name) => name.endsWith('.ts') && name !== 'index.ts' && !name.endsWith('.test.ts'))
  .map((name) => name.slice(0, -'.ts'.length))
  .sort();

/** The subpath that defines each exported value, for the failure message. */
function subpathOwners(): Map<string, { contract?: string; apiClient?: string }> {
  const owners = new Map<string, { contract?: string; apiClient?: string }>();
  const record = (path: string, key: 'contract' | 'apiClient', subpath: string) => {
    for (const [, name] of readFileSync(join(repo, path), 'utf8').matchAll(/^export (?:async )?(?:const|let|function\*?|class|enum) ([\w$]+)/gm)) {
      owners.set(name as string, { ...owners.get(name as string), [key]: subpath });
    }
  };
  for (const name of contractModules()) record(`packages/contract/src/${name}.ts`, 'contract', name);
  for (const path of ['client', 'protocol/ui-events', 'utils/project-scope']) {
    record(`packages/api-client/src/${path}.ts`, 'apiClient', path);
  }
  return owners;
}

function hint(site: RootImport, owners: ReturnType<typeof subpathOwners>): string {
  const advice = site.names.map((name) => {
    if (name.startsWith('type ')) return `${name.slice(5)} → \`import type\` from the root`;
    const owner = owners.get(name);
    if (owner?.apiClient) return `${name} → @open-mercato/cezar-api-client/${owner.apiClient}`;
    if (owner?.contract) {
      return site.root === '@open-mercato/cezar-api-client'
        ? `${name} → @open-mercato/cezar-api-client/contract/${owner.contract}`
        : `${name} → @open-mercato/cezar-contract/${owner.contract}`;
    }
    return `${name} → (no defining module found)`;
  });
  return `${site.file}:${site.line} ${site.kind} of ${site.root}${advice.length ? `: ${advice.join(', ')}` : ''}`;
}

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

describe('the repository', () => {
  it('no file imports a contract value through a root', () => {
    const owners = subpathOwners();
    const sites = SCANNED.flatMap(sourceFiles)
      .filter((file) => !(file in EXEMPT))
      .flatMap((file) => scanRootImports(file, readFileSync(join(repo, file), 'utf8')));
    expect(sites.map((site) => hint(site, owners)), 'import these from the subpaths named, or as `import type`').toEqual([]);
  });

  it('every exemption still names a root import', () => {
    for (const file of Object.keys(EXEMPT)) {
      expect(existsSync(join(repo, file)), file).toBe(true);
      expect(scanRootImports(file, readFileSync(join(repo, file), 'utf8')).length, file).toBeGreaterThan(0);
    }
  });

  it('the api-client shims mirror the contract modules', () => {
    const shimDir = join(repo, 'packages/api-client/src/contract');
    const shims = readdirSync(shimDir).filter((name) => name.endsWith('.ts')).map((name) => name.slice(0, -'.ts'.length)).sort();
    expect(shims).toEqual(contractModules());
    for (const name of shims) {
      expect(readFileSync(join(shimDir, `${name}.ts`), 'utf8'), name).toBe(`export * from '@open-mercato/cezar-contract/${name}'\n`);
    }
  });
});

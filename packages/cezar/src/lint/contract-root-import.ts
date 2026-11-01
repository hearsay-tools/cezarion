import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { blankOnce, lineAt, repoRoot, type SourceRule } from './source-rule.ts';

/**
 * Contract values load through module subpaths, never through a package root
 * (hearsay-tools/cezarion#1237).
 *
 * Both roots, `@open-mercato/cezar-contract` and `@open-mercato/cezar-api-client`, re-export every
 * contract module, delegation's schemas among them. A value imported through a root puts all of
 * them in the importer's runtime closure, so an edit to any shared schema reruns tests that never
 * use it. A type import costs nothing at runtime, so the roots stay open to `import type`, to
 * `export type … from` and to an `import('<root>').T` type query inside a type alias. Everything
 * else is refused.
 */
const ROOTS = ['@open-mercato/cezar-contract', '@open-mercato/cezar-api-client'];
export const SCANNED = ['packages/cezar/src', 'packages/cezar/test', 'packages/web/src', 'packages/web/e2e', 'packages/api-client/src', 'packages/contract/src'];
export const exemptionsPath = join(repoRoot, 'packages/cezar/src/lint/contract-root-import.baseline.json');

/** Files allowed to import a root at runtime, each with its reason. The list only shrinks. */
export function readExemptions(path = exemptionsPath): Record<string, string> {
  return (JSON.parse(readFileSync(path, 'utf8')) as { files: Record<string, string> }).files;
}

type Kind = 'value-import' | 'side-effect' | 'namespace' | 'default' | 're-export' | 'dynamic';
export interface RootImport { file: string; line: number; root: string; kind: Kind; names: string[] }

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
  const code = blankOnce(source);
  const sites: RootImport[] = [];
  // `blank` keeps the quotes of each string and the backticks of each template, and turns their
  // content to spaces at the same offsets. A template keeps its `${…}`, so one with a
  // substitution never matches: no static scan can read its specifier.
  for (const match of code.matchAll(/([`'"]) *\1/g)) {
    const at = match.index;
    const root = rootOf(source.slice(at + 1, at + match[0].length - 1));
    if (root === undefined) continue;
    const before = code.slice(0, at);
    if (/\bimport\s*\(\s*$/.test(before)) {
      if (!insideTypeAlias(before)) sites.push({ file, line: lineAt(source, at), root, kind: 'dynamic', names: [] });
      continue;
    }
    if (/\bimport\s*$/.test(before)) {
      sites.push({ file, line: lineAt(source, at), root, kind: 'side-effect', names: [] });
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
    sites.push({ file, line: lineAt(source, start), root, kind, names });
  }
  return sites;
}

export const contractModules = (root = repoRoot): string[] => readdirSync(join(root, 'packages/contract/src'))
  .filter((name) => name.endsWith('.ts') && name !== 'index.ts' && !name.endsWith('.test.ts'))
  .map((name) => name.slice(0, -'.ts'.length))
  .sort();

type Owners = Map<string, { contract?: string; apiClient?: string }>;

/** The subpath that defines each exported value, for the diagnostic. */
function subpathOwners(): Owners {
  const owners: Owners = new Map();
  const record = (path: string, key: 'contract' | 'apiClient', subpath: string) => {
    for (const [, name] of readFileSync(join(repoRoot, path), 'utf8').matchAll(/^export (?:async )?(?:const|let|function\*?|class|enum) ([\w$]+)/gm)) {
      owners.set(name as string, { ...owners.get(name as string), [key]: subpath });
    }
  };
  for (const name of contractModules()) record(`packages/contract/src/${name}.ts`, 'contract', name);
  for (const path of ['client', 'protocol/ui-events', 'utils/project-scope']) {
    record(`packages/api-client/src/${path}.ts`, 'apiClient', path);
  }
  return owners;
}

let owners: Owners | undefined;

/** What the site imports and the subpath each name comes from. */
export function hint(site: RootImport, known: Owners = (owners ??= subpathOwners())): string {
  const advice = site.names.map((name) => {
    if (name.startsWith('type ')) return `${name.slice(5)} → \`import type\` from the root`;
    const owner = known.get(name);
    if (owner?.apiClient) return `${name} → @open-mercato/cezar-api-client/${owner.apiClient}`;
    if (owner?.contract) {
      return site.root === '@open-mercato/cezar-api-client'
        ? `${name} → @open-mercato/cezar-api-client/contract/${owner.contract}`
        : `${name} → @open-mercato/cezar-contract/${owner.contract}`;
    }
    return `${name} → (no defining module found)`;
  });
  return `${site.kind} of ${site.root}${advice.length ? `: ${advice.join(', ')}` : ''}`;
}

export const scanned = (file: string): boolean =>
  SCANNED.some((dir) => file.startsWith(`${dir}/`)) && /\.tsx?$/.test(file) && !/\/(?:node_modules|dist|__fixtures__)\//.test(file);

let exemptions: Record<string, string> | undefined;

export const contractRootImport: SourceRule = {
  name: 'contract-root-import',
  description: 'Import contract values through module subpaths, never through a package root (hearsay-tools/cezarion#1237).',
  applies: (file) => scanned(file) && !(file in (exemptions ??= readExemptions())),
  check: (file, source) => scanRootImports(file, source).map((site) => ({
    line: site.line,
    message: `${hint(site)}. Import values from the subpaths named, or types as \`import type\` from the root (hearsay-tools/cezarion#1237).`,
  })),
};

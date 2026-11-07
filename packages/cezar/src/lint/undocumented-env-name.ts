import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from '@babel/parser';
import type { Node } from '@babel/types';
import { property, unwrapped, visit } from './home-boundary.ts';
import { blankOnce, lineAt, repoRoot, type SourceRule } from './source-rule.ts';

/**
 * `.env.example` is the env contract (AGENTS.md § Zero config): every `CEZ_*` or `HSQ_*` name a shipped source
 * or runner script reads or writes is documented there. This proves documentation coverage, not
 * correct default behavior.
 */
const SCANNED = ['packages/cezar/src/', 'packages/contract/src/', 'packages/api-client/src/', 'packages/web/src/', 'packages/cezar/scripts/'];
export const envExamplePath = join(repoRoot, '.env.example');

/**
 * Each `CEZ_*` or `HSQ_*` name in `source`, with the offset of its first occurrence. A conservative source scan,
 * not data-flow analysis. Match env parameters as well as process.env, and use blank() offsets so
 * examples in comments/strings are not reads.
 */
function envSites(source: string, file = 'file.ts'): Map<string, number> {
  const code = blankOnce(source);
  const names = new Map<string, number>();
  const add = (name: string, at: number) => {
    if (!names.has(name) || names.get(name)! > at) names.set(name, at);
  };
  // Include literal keys passed through helpers or constants used for dynamic indexing.
  // This deliberately also requires documentation for env keys a source only writes.
  for (const match of source.matchAll(/(['"`])((?:CEZ|HSQ)_[A-Z0-9_]*[A-Z0-9])\1/g)) {
    if (code[match.index] === match[1]) add(match[2]!, match.index);
  }
  for (const match of code.matchAll(/\b((?:CEZ|HSQ)_[A-Z0-9_]+)\b/g)) add(match[1]!, match.index);
  // The AST preserves literal arguments across comments, whitespace and import aliases.
  const ast = parse(source, { sourceType: 'unambiguous', plugins: ['typescript', ...(/\.[cm]?[jt]sx$/.test(file) ? ['jsx' as const] : [])] });
  for (const call of productEnvCalls(ast)) {
    if (call.suffix === undefined) continue; // product-env-read rejects dynamic suffixes.
    for (const prefix of ['HSQ_', 'CEZ_']) add(`${prefix}${call.suffix}`, call.offset);
  }
  return names;
}

/** Named-import aliases retain the same env contract as productEnv. */
function productEnvHelpers(ast: Node): Set<string> {
  const names = new Set(['productEnv']);
  visit(ast, node => {
    if (node.type === 'ImportSpecifier' && property(node.imported) === 'productEnv') names.add(node.local.name);
  });
  return names;
}

/** Only a literal suffix can prove both accepted full names; dynamic calls fail read lint. */
export function productEnvCalls(ast: Node): { suffix: string | undefined; offset: number }[] {
  const helpers = productEnvHelpers(ast);
  const calls: { suffix: string | undefined; offset: number }[] = [];
  visit(ast, node => {
    if (node.type !== 'CallExpression' && node.type !== 'OptionalCallExpression') return;
    if (!helpers.has(property(unwrapped(node.callee)) ?? '')) return;
    const argument = node.arguments[0];
    const literal = argument && unwrapped(argument);
    const suffix = literal?.type === 'StringLiteral' ? literal.value
      : literal?.type === 'TemplateLiteral' && literal.expressions.length === 0 ? literal.quasis[0]?.value.cooked : undefined;
    calls.push({ suffix: suffix != null && /^[A-Z][A-Z0-9_]*$/.test(suffix) ? suffix : undefined, offset: node.start ?? 0 });
  });
  return calls;
}

export const envNames = (source: string): string[] => [...envSites(source).keys()].sort();

/** The names `source` uses that `documented` lacks. CEZ_MOCK_* controls offline test fault
 *  injection, not shipped settings, so the whole prefix is exempt. */
export const undocumented = (source: string, documented: Set<string>): string[] =>
  envNames(source).filter((name) => !name.startsWith('CEZ_MOCK_') && !documented.has(name));

export const documentedNames = (path = envExamplePath): Set<string> =>
  new Set(readFileSync(path, 'utf8').match(/\b(?:CEZ|HSQ)_[A-Z0-9_]+\b/g));

/** Whether the rule reads `file`: shipped sources and runner scripts, never tests or fixtures. */
export const scannedEnvFile = (file: string): boolean =>
  SCANNED.some((dir) => file.startsWith(dir)) &&
  /\.(?:[cm]?[jt]sx?)$/.test(file) &&
  !/\.(?:test|testkit|spec)\./.test(file.slice(file.lastIndexOf('/') + 1)) &&
  !/\/(?:__tests__|__fixtures__|fixtures)\//.test(file);

let documented: Set<string> | undefined;

export const undocumentedEnvName: SourceRule = {
  name: 'undocumented-env-name',
  description: 'Document every CEZ_* or HSQ_* environment name a shipped source or runner script uses in .env.example.',
  applies: scannedEnvFile,
  check: (file, source) => {
    const sites = envSites(source, file);
    documented ??= documentedNames();
    return [...sites.keys()].filter(name => !name.startsWith('CEZ_MOCK_') && !documented!.has(name)).map((name) => ({
      line: lineAt(source, sites.get(name)!),
      message: `${name} is not in .env.example. Document it there in the same commit (AGENTS.md § Zero config).`,
    }));
  },
};

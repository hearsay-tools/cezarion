import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { blankOnce, lineAt, repoRoot, type SourceRule } from './source-rule.ts';

/**
 * `.env.example` is the env contract (AGENTS.md § Zero config): every `CEZ_*` name a shipped source
 * or runner script reads or writes is documented there. This proves documentation coverage, not
 * correct default behavior.
 */
const SCANNED = ['packages/cezar/src/', 'packages/contract/src/', 'packages/api-client/src/', 'packages/web/src/', 'packages/cezar/scripts/'];
export const envExamplePath = join(repoRoot, '.env.example');

/**
 * Each `CEZ_*` name in `source`, with the offset of its first occurrence. A conservative source scan,
 * not data-flow analysis. Match env parameters as well as process.env, and use blank() offsets so
 * examples in comments/strings are not reads.
 */
function envSites(source: string): Map<string, number> {
  const code = blankOnce(source);
  const names = new Map<string, number>();
  const add = (name: string, at: number) => {
    if (!names.has(name) || names.get(name)! > at) names.set(name, at);
  };
  // Include literal keys passed through helpers or constants used for dynamic indexing.
  // This deliberately also requires documentation for env keys a source only writes.
  for (const match of source.matchAll(/(['"`])(CEZ_[A-Z0-9_]*[A-Z0-9])\1/g)) {
    if (code[match.index] === match[1]) add(match[2]!, match.index);
  }
  for (const match of code.matchAll(/\.\s*(CEZ_[A-Z0-9_]+)/g)) add(match[1]!, match.index);
  return names;
}

export const envNames = (source: string): string[] => [...envSites(source).keys()].sort();

/** The names `source` uses that `documented` lacks. CEZ_MOCK_* controls offline test fault
 *  injection, not shipped settings, so the whole prefix is exempt. */
export const undocumented = (source: string, documented: Set<string>): string[] =>
  envNames(source).filter((name) => !name.startsWith('CEZ_MOCK_') && !documented.has(name));

export const documentedNames = (path = envExamplePath): Set<string> =>
  new Set(readFileSync(path, 'utf8').match(/\bCEZ_[A-Z0-9_]+\b/g));

/** Whether the rule reads `file`: shipped sources and runner scripts, never tests or fixtures. */
export const scannedEnvFile = (file: string): boolean =>
  SCANNED.some((dir) => file.startsWith(dir)) &&
  /\.(?:[cm]?[jt]sx?)$/.test(file) &&
  !/\.(?:test|testkit|spec)\./.test(file.slice(file.lastIndexOf('/') + 1)) &&
  !/\/(?:__tests__|__fixtures__|fixtures)\//.test(file);

let documented: Set<string> | undefined;

export const undocumentedEnvName: SourceRule = {
  name: 'undocumented-env-name',
  description: 'Document every CEZ_* environment name a shipped source or runner script uses in .env.example.',
  applies: scannedEnvFile,
  check: (_file, source) => {
    const sites = envSites(source);
    return undocumented(source, (documented ??= documentedNames())).map((name) => ({
      line: lineAt(source, sites.get(name)!),
      message: `${name} is not in .env.example. Document it there in the same commit (AGENTS.md § Zero config).`,
    }));
  },
};

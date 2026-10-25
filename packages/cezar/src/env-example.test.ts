import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { blank } from './test-wait-discipline.testkit.js';

const root = resolve(import.meta.dirname, '../../..');

// A conservative source scan, not data-flow analysis. Match env parameters as well as
// process.env, and use blank() offsets so examples in comments/strings are not reads.
function envNames(source: string): string[] {
  const code = blank(source);
  const names = new Set<string>();
  // Include literal keys passed through helpers or constants used for dynamic indexing.
  // This deliberately also requires documentation for env keys a source only writes.
  for (const match of source.matchAll(/(['"`])(CEZ_[A-Z0-9_]*[A-Z0-9])\1/g)) {
    if (code[match.index] === match[1]) names.add(match[2]!);
  }
  for (const match of code.matchAll(/\.\s*(CEZ_[A-Z0-9_]+)/g)) names.add(match[1]!);
  return [...names].sort();
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return /^(?:__tests__|__fixtures__|fixtures)$/.test(entry.name) ? [] : sourceFiles(path);
    return /\.(?:[cm]?[jt]sx?)$/.test(entry.name) && !/\.(?:test|testkit|spec)\./.test(entry.name) ? [path] : [];
  });
}

function undocumented(source: string, documented: Set<string>): string[] {
  // CEZ_MOCK_* controls offline test fault injection, not shipped settings. Keep existing
  // documentation, but exempt the whole prefix so each mock wire uses the same policy.
  return envNames(source).filter((name) => !name.startsWith('CEZ_MOCK_') && !documented.has(name));
}

describe('.env.example contract', () => {
  it('finds process.env, env parameters and literal bracket access', () => {
    expect(envNames(`process.env.CEZ_ONE; env.CEZ_TWO; process.env['CEZ_THREE']; env["CEZ_FOUR"];`))
      .toEqual(['CEZ_FOUR', 'CEZ_ONE', 'CEZ_THREE', 'CEZ_TWO']);
  });

  it('ignores comments and examples inside strings, but scans template substitutions', () => {
    expect(envNames('// env.CEZ_COMMENT\n"process.env.CEZ_STRING"; `example ${env.CEZ_REAL}`;'))
      .toEqual(['CEZ_REAL']);
  });

  it('includes keys routed through constants and helpers', () => {
    expect(envNames("const prefix = 'CEZ_TOOL_'; const key = 'CEZ_KEY'; readEnv('CEZ_HELPER'); (opts.env ?? process.env).CEZ_FALLBACK;"))
      .toEqual(['CEZ_FALLBACK', 'CEZ_HELPER', 'CEZ_KEY']);
  });

  it('rejects an undocumented read and exempts every mock switch', () => {
    expect(undocumented('env.CEZ_NEW; env.CEZ_KNOWN; env.CEZ_MOCK_NEW;', new Set(['CEZ_KNOWN'])))
      .toEqual(['CEZ_NEW']);
  });

  it('documents every CEZ_* environment access in shipped sources and runner scripts', () => {
    const documented = new Set(readFileSync(join(root, '.env.example'), 'utf8').match(/\bCEZ_[A-Z0-9_]+\b/g));
    const directories = ['cezar', 'contract', 'api-client', 'web'].map((pkg) => join(root, 'packages', pkg, 'src'));
    directories.push(join(root, 'packages/cezar/scripts'));
    const missing = directories.flatMap(sourceFiles).flatMap((file) =>
      undocumented(readFileSync(file, 'utf8'), documented).map((name) => `${relative(root, file)}: ${name}`));
    expect(missing, 'Document these environment names in .env.example').toEqual([]);
  });
});

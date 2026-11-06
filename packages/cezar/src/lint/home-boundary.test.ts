import { createRequire } from 'node:module';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { homeBoundary, homeReadersFile, homeSites, scanHomeBoundary, staleHomeReaders, type HomeReader } from './home-boundary.ts';

const product = 'packages/cezar/src/library.ts';
const test = 'packages/cezar/src/library.test.ts';
const reader: HomeReader = { file: product, kind: 'homedir', calls: 1, reason: 'OS-user Applications lookup.' };
const roots: string[] = [];
afterAll(() => roots.forEach(root => rmSync(root, { recursive: true, force: true })));

function fixture(entries: HomeReader[], files: Record<string, string> = {}): string {
  const root = mkdtempSync(join(tmpdir(), 'cez-home-lint-'));
  roots.push(root);
  for (const [file, source] of Object.entries({ ...files, [homeReadersFile]: JSON.stringify({ entries }) })) {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), source);
  }
  return root;
}

describe('explicit Home boundaries', () => {
  it.each([
    ['cezarHomeDir()', 'cezarHomeDir'],
    ["import { cezarHomeDir as oldHome } from './paths.ts'; oldHome()", 'cezarHomeDir'],
    ["paths['cezarHomeDir']()", 'cezarHomeDir'],
    ["resolveHome({ purpose: 'cli' })", 'resolveHome'],
    ["import { resolveHome as home } from './home/resolve.ts'; home()", 'resolveHome'],
    ["homes['resolveHome']()", 'resolveHome'],
    ['homedir()', 'homedir'],
    ['os.homedir()', 'homedir'],
    ["os['homedir']()", 'homedir'],
    ["import { homedir as userHome } from 'node:os'; userHome()", 'homedir'],
    ["const { homedir: userHome } = os; userHome()", 'homedir'],
    ['const userHome = os.homedir; userHome()', 'homedir'],
  ])('rejects the forbidden form %s', (source, kind) => {
    expect(scanHomeBoundary(product, source, [])).toEqual([expect.objectContaining({ kind })]);
  });

  it.each([
    'process.env.CEZ_HOME = dir',
    "process.env['CEZ_HOME'] = dir",
    "process['env'].CEZ_HOME ||= dir",
    '(process.env.CEZ_HOME as string) = dir',
    'delete process.env.CEZ_HOME',
    'process.env.CEZ_HOME++',
    "vi.stubEnv('CEZ_HOME', dir)",
    "vi['stubEnv']('CEZ_HOME', dir)",
  ])('rejects test home selection outside setup: %s', source => {
    expect(scanHomeBoundary(test, source, [])).toEqual([expect.objectContaining({ kind: 'test-selection' })]);
  });

  it('allows resolver entry points and the home module', () => {
    for (const file of ['packages/cezar/src/index.ts', 'packages/cezar/src/subcommands.ts', 'packages/cezar/src/home/resolve.ts']) {
      expect(scanHomeBoundary(file, 'resolveHome()', [])).toEqual([]);
    }
    expect(scanHomeBoundary('packages/cezar/src/home/resolve.ts', 'homedir()', [])).toEqual([]);
  });

  it('allows only the listed number of OS-user reads', () => {
    expect(scanHomeBoundary(product, 'homedir()', [reader])).toEqual([]);
    expect(scanHomeBoundary(product, 'homedir(); homedir()', [reader])).toEqual([{ kind: 'homedir', offset: 11 }]);
  });

  it('allows test env reads, child env objects and shared setup', () => {
    expect(scanHomeBoundary(test, 'const env = { CEZ_HOME: dir }; const old = process.env.CEZ_HOME', [])).toEqual([]);
    expect(homeBoundary.applies('packages/cezar/vitest.setup.ts')).toBe(false);
    expect(homeBoundary.applies('packages/cezar/src/a.testkit.ts')).toBe(true);
    expect(homeBoundary.applies('packages/cezar/test/e2e/a.test.ts')).toBe(true);
    expect(homeBoundary.applies('scripts/tool.mjs')).toBe(false);
  });

  it('ignores text and comments and fails closed on a parse error', () => {
    expect(homeSites('const text = "homedir() resolveHome() cezarHomeDir()"; // process.env.CEZ_HOME = dir')).toEqual([]);
    expect(() => homeSites('let x = ;')).toThrow();
  });
});

describe('shrink-only OS-user reader list', () => {
  it('accepts an exact live entry', () => {
    expect(staleHomeReaders(fixture([reader], { [product]: 'homedir()' }))).toEqual([]);
  });

  it.each([
    ['missing file', [reader], {}],
    ['removed call', [reader], { [product]: 'const x = 1' }],
    ['lower call count', [{ ...reader, calls: 2 }], { [product]: 'homedir()' }],
    ['empty reason', [{ ...reader, reason: '' }], { [product]: 'homedir()' }],
    ['test file', [{ ...reader, file: test }], { [test]: 'homedir()' }],
    ['home module', [{ ...reader, file: 'packages/cezar/src/home/resolve.ts' }], { 'packages/cezar/src/home/resolve.ts': 'homedir()' }],
    ['duplicate', [reader, reader], { [product]: 'homedir()' }],
  ] as const)('fails a stale or invalid entry: %s', (_label, entries, files) => {
    expect(staleHomeReaders(fixture([...entries], files))).toEqual([expect.stringContaining('stale or invalid entry')]);
  });

  it('uses the CI ratchet to reject added readers and larger counts', () => {
    const require = createRequire(import.meta.url);
    const { compareBaseline } = require('../../../../.github/scripts/baseline-growth.cjs') as { compareBaseline: (before: unknown, after: unknown) => string[] };
    const before = { entries: [reader] };
    expect(compareBaseline(before, { entries: [] })).toEqual([]);
    expect(compareBaseline(before, { entries: [{ ...reader, calls: 0 }] })).toEqual([]);
    expect(compareBaseline(before, { entries: [{ ...reader, calls: 2 }] }).length).toBeGreaterThan(0);
    expect(compareBaseline(before, { entries: [reader, { ...reader, file: test }] }).length).toBeGreaterThan(0);
  });
});

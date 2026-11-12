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
    ['squawkHomeDir()', 'squawkHomeDir'],
    ["import { squawkHomeDir as oldHome } from './paths.ts'; oldHome()", 'squawkHomeDir'],
    ["paths['squawkHomeDir']()", 'squawkHomeDir'],
    ["resolveHome({ purpose: 'cli' })", 'resolveHome'],
    ["import { resolveHome as home } from './home/resolve.ts'; home()", 'resolveHome'],
    ["homes['resolveHome']()", 'resolveHome'],
    ['homedir()', 'homedir'],
    ['os.homedir()', 'homedir'],
    ['(0, os.homedir)()', 'homedir'],
    ['const h = (0, os.homedir); h()', 'homedir'],
    ['os.homedir.call(null)', 'homedir'],
    ['os.homedir.apply(null, [])', 'homedir'],
    ['const h = os.homedir.call; h(null)', 'homedir'],
    ['os.homedir?.()', 'homedir'],
    ['os?.homedir()', 'homedir'],
    ['os?.homedir?.()', 'homedir'],
    ['const h = os?.homedir; h?.()', 'homedir'],
    ['os.homedir.bind(null)()', 'homedir'],
    ['const h = os.homedir.bind(null); h()', 'homedir'],
    ['os?.homedir.bind?.(null)?.()', 'homedir'],
    ['Reflect.apply(os.homedir, null, [])', 'homedir'],
    ['Reflect["apply"]((0, os["homedir"]), null, [])', 'homedir'],
    ['Reflect.apply?.(os?.homedir, null, [])', 'homedir'],
    ['const h = os.homedir; Reflect.apply(h, null, [])', 'homedir'],
    ['(os.homedir as (() => string))()', 'homedir'],
    ['os.homedir!()', 'homedir'],
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
    "vi.stubEnv?.('CEZ_HOME', dir)",
    "vi?.stubEnv('CEZ_HOME', dir)",
    "[process.env.CEZ_HOME] = [dir]",
    "({ a: process.env.CEZ_HOME } = source)",
    "({ a: [process.env.CEZ_HOME = dir] } = source)",
    "[...process.env.CEZ_HOME] = dirs",
    "({ ...process.env.CEZ_HOME } = source)",
    "for (process.env.CEZ_HOME of dirs) {}",
    "for (process.env.CEZ_HOME in dirs) {}",
    "for ([process.env[\"CEZ_HOME\"]] of dirs) {}",
    "delete process?.env?.[\"CEZ_HOME\"]",
    "Object.assign(process.env, { CEZ_HOME })",
    "Object.assign(process[\"env\"], {}, { [\"CEZ_HOME\"]: dir })",
    "Reflect.set(process.env, \"CEZ_HOME\", dir)",
    "Reflect.defineProperty(process.env, \"CEZ_HOME\", { value: dir })",
    "Object.defineProperty(process.env, \"CEZ_HOME\", { value: dir })",
  ])('rejects test home selection outside setup: %s', source => {
    expect(scanHomeBoundary(test, source, [])).toEqual([expect.objectContaining({ kind: 'test-selection' })]);
  });

  it.each([
    '[value = process.env.CEZ_HOME] = []',
    '({ [process.env.CEZ_HOME]: value } = source)',
    'for (const value of process.env.CEZ_HOME) {}',
    'Object.assign(other, { CEZ_HOME: dir })',
    'Object.assign(process.env, { OTHER: dir })',
    'Reflect.set(other, "CEZ_HOME", dir)',
    'Reflect.set(process.env, "OTHER", dir)',
    'Reflect.defineProperty(other, "CEZ_HOME", { value: dir })',
  ])('allows reads and writes outside the selected home: %s', source => {
    expect(scanHomeBoundary(test, source, [])).toEqual([]);
  });

  it.each(['"CEZ_HOME"', '`CEZ_HOME`', '"CEZ_" + "HOME"'].flatMap(key => {
    return [
      `vi.stubEnv(${key}, dir)`,
      `process.env[${key}] = dir`,
      `delete process.env[${key}]`,
      `process.env[${key}]++`,
      `Object.assign(process.env, { [${key}]: dir })`,
      `Reflect.set(process.env, ${key}, dir)`,
      `Reflect.defineProperty(process.env, ${key}, { value: dir })`,
      `Object.defineProperty(process.env, ${key}, { value: dir })`,
    ];
  }))('rejects a statically known selection key: %s', source => {
    expect(scanHomeBoundary(test, source, [])).toEqual([expect.objectContaining({ kind: 'test-selection' })]);
  });

  it.each([
    ['os["homedir"]()', 'homedir'],
    ['os[`homedir`]()', 'homedir'],
    ['os["home" + "dir"]()', 'homedir'],
    ['homes[`resolveHome`]()', 'resolveHome'],
    ['homes["resolve" + "Home"]()', 'resolveHome'],
    ['paths[`squawkHomeDir`]()', 'squawkHomeDir'],
    ['paths["cezar" + "HomeDir"]()', 'squawkHomeDir'],
  ])('rejects a statically known callee key: %s', (source, kind) => {
    expect(scanHomeBoundary(product, source, [])).toEqual([expect.objectContaining({ kind })]);
  });

  it.each([
    'vi[`stubEnv`]("CEZ_HOME", dir)',
    'vi["stub" + "Env"]("CEZ_HOME", dir)',
    'process[`env`].CEZ_HOME = dir',
    'process["en" + "v"].CEZ_HOME = dir',
  ])('rejects static keys along the selection path: %s', source => {
    expect(scanHomeBoundary(test, source, [])).toEqual([expect.objectContaining({ kind: 'test-selection' })]);
  });

  it.each([
    'process.env[name] = dir',
    'process.env[`CEZ_${suffix}`] = dir',
    'process.env["CEZ_" + suffix] = dir',
    'Reflect.set(process.env, name, dir)',
    'Object.assign(process.env, { [name]: dir })',
    'vi.stubEnv(CEZ_HOME, dir)',
  ])('leaves unresolved keys outside the static rule: %s', source => {
    expect(scanHomeBoundary(test, source, [])).toEqual([]);
  });

  it('allows resolver entry points and the home module', () => {
    for (const file of ['packages/cezar/src/index.ts', 'packages/cezar/src/subcommands.ts', 'packages/cezar/src/home/resolve.ts']) {
      expect(scanHomeBoundary(file, 'resolveHome()', [])).toEqual([]);
    }
    expect(scanHomeBoundary('packages/cezar/src/home/resolve.ts', 'homedir()', [])).toEqual([]);
  });

  it('does not count reference creation or calls of unrelated functions as home reads', () => {
    expect(homeSites('const h = os.homedir.bind(null); other.call(null); other.apply(null, []); Reflect.apply(other, null, []);')).toEqual([]);
    expect(homeSites('(os.homedir, other)();')).toEqual([]);
  });

  it('counts indirect reads in reader exemptions and stale entries', () => {
    const source = '(0, os.homedir)(); os.homedir.bind(null)(); Reflect.apply(os.homedir, null, []);';
    expect(homeSites(source)).toHaveLength(3);
    expect(scanHomeBoundary(product, source, [{ ...reader, calls: 2 }])).toEqual([expect.objectContaining({ kind: 'homedir' })]);
    expect(staleHomeReaders(fixture([{ ...reader, calls: 3 }], { [product]: source }))).toEqual([]);
    expect(staleHomeReaders(fixture([{ ...reader, calls: 4 }], { [product]: source }))).toEqual([expect.stringContaining('stale or invalid entry')]);
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
    expect(homeSites('const text = "homedir() resolveHome() squawkHomeDir()"; // process.env.CEZ_HOME = dir')).toEqual([]);
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

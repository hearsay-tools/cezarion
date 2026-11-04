import { globSync, readFileSync } from 'node:fs';
import { NATIVE_TOOL_REGISTRATION, registrationGroups } from './registration-coverage.testkit.ts';
import { describe, expect, it } from 'vitest';
import { CI_NATIVE_GROUPS, registerCiDefinitionsAndInjection, registerCiValidation } from './ci-tools.testkit.ts';

registerCiDefinitionsAndInjection();
registerCiValidation();

function nativeGroups(source: string, file = 'inline-native.test.ts'): string[] {
  return registrationGroups(source, file, NATIVE_TOOL_REGISTRATION, 'CI_NATIVE_GROUPS', Object.keys(CI_NATIVE_GROUPS));
}

function assertNativeCoverage(sources: readonly string[]) {
  const groups = sources.flatMap(source => { return nativeGroups(source); });
  const tools = groups.flatMap(group => CI_NATIVE_GROUPS[group as keyof typeof CI_NATIVE_GROUPS] ?? []);
  expect([...tools].sort()).toEqual(['cezar_ask', 'cezar_cancel_wait', 'cezar_done', 'cezar_wait']);
}

describe('native CI tool row coverage', () => {
  const sourceRoot = new URL('../', import.meta.url);
  const sources = globSync('**/*.test.ts', { cwd: sourceRoot })
    .map(file => {
      const source = readFileSync(new URL(file, sourceRoot), 'utf8');
      return nativeGroups(source, file).length > 0 ? source : '';
    })
    .filter(source => { return source.length > 0; });
  it('registers each native tool group in exactly one source file', () => {
    assertNativeCoverage(sources);
  });
  it('rejects a tool family registered in two files', () => {
    expect(() => assertNativeCoverage([...sources, sources[0]!])).toThrow();
  });
  it('rejects a tool family registered in no file', () => {
    expect(() => assertNativeCoverage(sources.slice(1))).toThrow();
  });
  it('ignores a commented-out native group call', () => {
    assertNativeCoverage([...sources, '// registerCiNativeTools(CI_NATIVE_GROUPS.waitCancel);']);
    assertNativeCoverage([...sources, '/* registerCiNativeTools(CI_NATIVE_GROUPS.waitCancel); */']);
  });
  it('ignores a native group call inside a string', () => {
    assertNativeCoverage([...sources, 'const text = "registerCiNativeTools(CI_NATIVE_GROUPS.waitCancel);";']);
  });
  it('ignores a native group call inside template text', () => {
    assertNativeCoverage([...sources, 'const text = `registerCiNativeTools(CI_NATIVE_GROUPS.waitCancel);`;']);
  });
  it('rejects a real native group call in a third source file', () => {
    expect(() => assertNativeCoverage([...sources, 'registerCiNativeTools(CI_NATIVE_GROUPS.waitCancel);'])).toThrow();
  });
  it.each([
    '[...CI_NATIVE_GROUPS.waitCancel]',
    'group',
    'CI_NATIVE_GROUPS["waitCancel"]',
    '',
    '...CI_NATIVE_GROUPS.waitCancel',
    'CI_NATIVE_GROUPS.unknown',
    'CI_NATIVE_GROUPS.waitCancel, extra',
  ])('rejects unresolved native registration argument %s', argument => {
    const call = `registerCiNativeTools(${argument})`;
    expect(() => nativeGroups(`${call};`, 'third-native.test.ts')).toThrow(`third-native.test.ts: unsupported registerCiNativeTools registration: ${call}`);
  });
  it('checks native registrations inside function bodies', () => {
    expect(() => assertNativeCoverage([...sources, 'function later() { registerCiNativeTools(CI_NATIVE_GROUPS.waitCancel); }'])).toThrow();
    expect(() => nativeGroups('function later() { registerCiNativeTools(group); }', 'nested.test.ts')).toThrow('nested.test.ts: unsupported');
  });
  it.each([
    'registerCiNativeTools?.(CI_NATIVE_GROUPS.waitCancel)',
    'const r = registerCiNativeTools',
    'registerCiNativeTools.call(null, CI_NATIVE_GROUPS.waitCancel)',
    'consume(registerCiNativeTools)',
    'registerCiNativeTools.apply(null, [CI_NATIVE_GROUPS.waitCancel])',
    'registerCiNativeTools.bind(null)',
    'tools["registerCiNativeTools"](CI_NATIVE_GROUPS.waitCancel)',
    'export { registerCiNativeTools as other }',
    'import { registerCiNativeTools as other } from "./tools"',
  ])('rejects unaccounted native registration reference %s', source => {
    expect(() => nativeGroups(`${source};`, 'reference.test.ts')).toThrow('reference.test.ts: unsupported');
  });
  it('allows unchanged imports, declarations and exports', () => {
    expect(nativeGroups('import { registerCiNativeTools } from "./tools";')).toEqual([]);
    expect(nativeGroups('export function registerCiNativeTools() {}')).toEqual([]);
    expect(nativeGroups('export { registerCiNativeTools };')).toEqual([]);
  });
  it.each([
    'ci?.["registerCiNativeTools"](CI_NATIVE_GROUPS.waitCancel)',
    'ci["registerCiNativeTools"](CI_NATIVE_GROUPS.waitCancel)',
    'ci[`registerCiNativeTools`](CI_NATIVE_GROUPS.waitCancel)',
    'const key = "registerCiNativeTools"',
    'const key = `registerCiNativeTools`',
  ])('rejects exact registration-name literals %s', source => {
    expect(() => nativeGroups(`${source};`, 'literal.test.ts')).toThrow('literal.test.ts: unsupported');
  });
  it('ignores comments and longer literal text containing a registration name', () => {
    expect(nativeGroups('// registerCiNativeTools\n/* registerCiNativeTools */')).toEqual([]);
    expect(nativeGroups('const text = "prefix registerCiNativeTools suffix"; const template = `prefix registerCiNativeTools suffix`;')).toEqual([]);
  });
});

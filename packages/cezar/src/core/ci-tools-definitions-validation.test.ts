import { globSync, readFileSync } from 'node:fs';
import { parse } from '@babel/parser';
import { traverseFast } from '@babel/types';
import { describe, expect, it } from 'vitest';
import { CI_NATIVE_GROUPS, registerCiDefinitionsAndInjection, registerCiValidation } from './ci-tools.testkit.ts';

registerCiDefinitionsAndInjection();
registerCiValidation();

function nativeGroups(source: string): string[] {
  const groups: string[] = [];
  const tree = parse(source, { sourceType: 'module', plugins: ['typescript'] });
  traverseFast(tree, node => {
    if (node.type !== 'CallExpression' || node.callee.type !== 'Identifier' || node.callee.name !== 'registerCiNativeTools') return;
    const argument = node.arguments[0];
    if (argument?.type === 'MemberExpression' && !argument.computed && argument.object.type === 'Identifier'
      && argument.object.name === 'CI_NATIVE_GROUPS' && argument.property.type === 'Identifier') {
      groups.push(argument.property.name);
    }
  });
  return groups;
}

function assertNativeCoverage(sources: readonly string[]) {
  const groups = sources.flatMap(nativeGroups);
  const tools = groups.flatMap(group => CI_NATIVE_GROUPS[group as keyof typeof CI_NATIVE_GROUPS] ?? []);
  expect([...tools].sort()).toEqual(['cezar_ask', 'cezar_cancel_wait', 'cezar_done', 'cezar_wait']);
}

describe('native CI tool row coverage', () => {
  const sourceRoot = new URL('../', import.meta.url);
  const sources = globSync('**/*.test.ts', { cwd: sourceRoot })
    .map(file => readFileSync(new URL(file, sourceRoot), 'utf8'))
    .filter(source => source.includes('registerCiNativeTools'))
    .filter(source => nativeGroups(source).length > 0);
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
});

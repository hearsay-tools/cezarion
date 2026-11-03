import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CI_NATIVE_GROUPS, registerCiDefinitionsAndInjection, registerCiValidation } from './ci-tools.testkit.ts';

registerCiDefinitionsAndInjection();
registerCiValidation();

function assertNativeCoverage(sources: readonly string[]) {
  const groups = sources.flatMap(source => [...source.matchAll(/registerCiNativeTools\(CI_NATIVE_GROUPS\.(\w+)\)/g)].map(match => match[1]!));
  const tools = groups.flatMap(group => CI_NATIVE_GROUPS[group as keyof typeof CI_NATIVE_GROUPS] ?? []);
  expect([...tools].sort()).toEqual(['cezar_ask', 'cezar_cancel_wait', 'cezar_done', 'cezar_wait']);
}

describe('native CI tool row coverage', () => {
  const sources = ['ci-tools-wait-cancel.test.ts', 'ci-tools-ask-done.test.ts'].map(file => readFileSync(new URL(file, import.meta.url), 'utf8'));
  it('registers each native tool group in exactly one source file', () => {
    assertNativeCoverage(sources);
  });
  it('rejects a tool family registered in two files', () => {
    expect(() => assertNativeCoverage([...sources, sources[0]!])).toThrow();
  });
  it('rejects a tool family registered in no file', () => {
    expect(() => assertNativeCoverage(sources.slice(1))).toThrow();
  });
});

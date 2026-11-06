import { describe, expect, it } from 'vitest';
import { mockScenarioBoundary as rule } from './lint/mock-scenario-boundary.ts';

const file = 'packages/cezar/scripts/mock-pi-rpc.mjs';
const adopted = "import { play, scenarioFor } from './mock-scenario.mjs';\n";

describe('shared scenario boundary', () => {
  it.each([
    "prompt.includes('mock:hold');", 'prompt.includes("mock:hold-cezar-done");',
    'const value = `mock:cezar-done`;', '/mock:no-progress/.test(prompt);',
    '/mock:(no-progress|busy-progress)/.test(prompt);',
    '/mock:(?:hold|cezar-ask)/.test(prompt);',
    '/prefix[/]mock:hold/.test(prompt);',
    "const x = 'prefix mock:silent-tail-late-reply suffix';",
    'const x = `prefix ${name} mock:agent-echo`;',
    'const x = `${"mock:hold"}`;',
    'const x = `${`mock:hold`}`;',
    "const x = 'mock:turn-messages:';", "const x = 'mock:gate-prompt-ack';",
  ])('refuses an adopted encoder literal: %s', sample => {
    expect(rule.check(file, adopted + sample)).toEqual([{ line: 2, message: expect.stringContaining('mock-scenario.mjs') }]);
  });

  it.each([
    "// 'mock:hold'\nconst x = 'ordinary';",
    '/* /mock:no-progress/ */',
    'const x = `${/* mock:hold */ name}`;',
    'const x = `${// mock:hold\nname}`;',
    'const x = `${{ name: /* mock:hold */ value }.name}`;',
    "const x = 'mock:backend-resume';",
    "const x = 'mock:holden';",
    "const x = 'mock:cezar-tools';",
    "scenarioFor(prompt, context);",
    "// 'mock:hold'\nconst x = 'mock:backend-resume';",
  ])('allows comments and runner-only literals: %s', sample => {
    expect(rule.check(file, adopted + sample)).toEqual([]);
  });

  it.each(['provider-error-early', 'crash-stderr-pre-ack', 'no-progress-ack-only'])(
    'allows the native token %s', token => {
      expect(rule.check(file, adopted + `prompt.includes('mock:${token}');`)).toEqual([]);
      expect(rule.check(file, adopted + `/mock:${token}/.test(prompt);`)).toEqual([]);
    });

  it.each(['silent-tail-late-reply', 'no-progress-input-closed', 'crash-stderr-clean',
    'autonomous-cap', 'multi-pr-refs-extra', 'hold-cezar-ask', 'cezar-ask-reply-late',
    'deferred-turn-start-extra', 'turn-messages-extra'])(
    'still reports shared family member %s', token => {
      expect(rule.check(file, adopted + `prompt.includes('mock:${token}');`)).toHaveLength(1);
    });

  it.each(['mock-opencode-serve.mjs', 'mock-codex-app-server.mjs'])(
    'allows the native resume flag in %s and refuses it without an exception', mock => {
      const source = adopted + "prompt.includes('mock:resume-cezar-done');";
      expect(rule.check(`packages/cezar/scripts/${mock}`, source)).toEqual([]);
      expect(rule.check(file, source)).toHaveLength(1);
    });

  it.each(['provider-error-early', 'crash-stderr-pre-ack', 'no-progress-ack-only'])(
    'applies native exemptions within grouped regex alternatives: %s', token => {
      expect(rule.check(file, adopted + `/mock:(${token})/.test(prompt);`)).toEqual([]);
      expect(rule.check(file, adopted + `/mock:(?:${token}|hold)/.test(prompt);`)).toHaveLength(1);
    });

  it.each(['mock-opencode-serve.mjs', 'mock-codex-app-server.mjs'])(
    'scopes grouped resume exemptions to %s', mock => {
      const source = adopted + '/mock:(?:resume-cezar-done)/.test(prompt);';
      const nativeFile = `packages/cezar/scripts/${mock}`;
      expect(rule.check(nativeFile, source)).toEqual([]);
      expect(rule.check(file, source)).toHaveLength(1);
      expect(rule.check(nativeFile, adopted + '/mock:(resume-cezar-done|hold)/.test(prompt);')).toHaveLength(1);
    });

  it.each([
    '/mock:(?:(?:provider-error-early)|hold)/.test(prompt);',
    '/mock:(?:(?:(?:provider-error-early))|hold)/.test(prompt);',
    '/mock:(?:provider-error-early\\)|hold)/.test(prompt);',
    '/mock:(?:provider-error-early[)]|hold)/.test(prompt);',
  ])('finds shared alternatives after nested or literal parentheses: %s', sample => {
    expect(rule.check(file, adopted + sample)).toHaveLength(1);
  });

  it.each([
    '/mock:(?:(?:(?:provider-error-early)))/.test(prompt);',
    '/mock:(?:provider-error-early\\))/.test(prompt);',
    '/mock:(?:provider-error-early[)])/.test(prompt);',
  ])('keeps nested native alternatives exempt: %s', sample => {
    expect(rule.check(file, adopted + sample)).toEqual([]);
  });

  it('leaves mocks that have not adopted the module alone', () => {
    expect(rule.check(file, "prompt.includes('mock:hold');")).toEqual([]);
    expect(rule.check(file, "// import './mock-scenario.mjs'\nprompt.includes('mock:hold');")).toEqual([]);
    expect(rule.check(file, 'const sample = "from \'./mock-scenario.mjs\'";\nprompt.includes(\'mock:hold\');')).toEqual([]);
  });

  it('recognizes dynamic imports and ignores a sample before a real literal', () => {
    expect(rule.check(file, "await import('./mock-scenario.mjs');\n// 'mock:hold'\nconst x = 'mock:hold';")[0]?.line).toBe(3);
  });

  it('scopes the guard to mock scripts outside the shared module', () => {
    expect(rule.applies(file)).toBe(true);
    expect(rule.applies('packages/cezar/scripts/mock-scenario.mjs')).toBe(false);
    expect(rule.applies('packages/cezar/src/example.ts')).toBe(false);
    expect(rule.applies('packages/cezar/scripts/example.mjs')).toBe(false);
  });
});

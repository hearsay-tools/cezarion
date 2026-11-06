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
    "const x = 'mock:turn-messages:';", "const x = 'mock:gate-prompt-ack';",
  ])('refuses an adopted encoder literal: %s', sample => {
    expect(rule.check(file, adopted + sample)).toEqual([{ line: 2, message: expect.stringContaining('mock-scenario.mjs') }]);
  });

  it.each([
    "// 'mock:hold'\nconst x = 'ordinary';",
    '/* /mock:no-progress/ */',
    "const x = 'mock:backend-resume';",
    "const x = 'mock:holden';",
    "const x = 'mock:cezar-tools';",
    "scenarioFor(prompt, context);",
    "// 'mock:hold'\nconst x = 'mock:backend-resume';",
  ])('allows comments and runner-only literals: %s', sample => {
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

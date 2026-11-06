import { describe, expect, it } from 'vitest';
import { mockLifecycleBoundary as rule } from './lint/mock-lifecycle-boundary.ts';

const file = 'packages/cezar/scripts/mock-pi-rpc.mjs';
describe('mock lifecycle boundary', () => {
  it.each(['watchdogStall', 'watchdogWritePid', 'waitForMockRelease', 'waitForRelease'])(
    'refuses a definition of %s', name => {
      for (const sample of [`function ${name}() {}`, `async function ${name}() {}`, `const ${name} = () => {};`]) {
        expect(rule.check(file, sample)).toHaveLength(1);
      }
    });
  it.each(["'watchdog.pid'", '"watchdog.pid"', '`watchdog.pid`',
    "'./watchdog.pid'", '"/tmp/x/watchdog.pid"', '`${dir}/watchdog.pid`',
    '`${dir}watchdog.pid`', '`./watchdog.pid${suffix}`',
  ])(
    'refuses the readiness literal %s', sample => {
      expect(rule.check(file, `writeFileSync(${sample}, pid);`)).toHaveLength(1);
    });
  it.each([
    "// function watchdogStall() {} 'watchdog.pid'",
    '/* const waitForRelease = () => {}; "watchdog.pid" */',
    'const sample = "function watchdogStall() {}";',
    "// write('./watchdog.pid');\nwrite('ordinary.pid');",
    'const sample = "write(\'./watchdog.pid\');";',
    "write('./watchdog.pid.backup');",
    "import { stall, waitForRelease } from './mock-lifecycle.mjs';",
    'stall(prompt); waitForRelease(400);',
  ])('allows comments, samples and imports: %s', sample => {
    expect(rule.check(file, sample)).toEqual([]);
  });
  it('scans only mock scripts outside the module', () => {
    expect(rule.applies(file)).toBe(true);
    for (const path of ['packages/cezar/scripts/mock-lifecycle.mjs', 'packages/cezar/src/example.ts', 'packages/cezar/scripts/example.mjs']) {
      expect(rule.applies(path)).toBe(false);
    }
  });
  it('reports the source line', () => {
    expect(rule.check(file, "// ignored\nwrite('watchdog.pid');")[0]?.line).toBe(2);
  });
});

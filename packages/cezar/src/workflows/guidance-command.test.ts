import { afterEach, describe, expect, it } from 'vitest';
import { sentRequestInstructions } from './completion-policy.ts';

const argv = process.argv[1]!;
afterEach(() => { process.argv[1] = argv; });

/** Agents inherit the ambient PATH. An upgrade through the old package links only cez and Squawk. */
describe('agent guidance names the command the cockpit was started as', () => {
  it.each([
    ['/usr/lib/node_modules/@hearsay-tools/squawk/dist/hsq.js', 'hsq'],
    ['/usr/lib/node_modules/@hearsay-tools/squawk/dist/cez.js', 'cez'],
    ['/usr/lib/node_modules/@wjarka/cezarion/dist/index.js', 'cez'],
  ])('started as %s', (entry, command) => {
    process.argv[1] = entry;
    const text = sentRequestInstructions([]);
    expect(text).toContain(`\`${command} message wait --request <UUID>\``);
    expect(text).toContain(`\`${command} message cancel-request <UUID>\``);
  });
});

import { describe, expect, it } from 'vitest';
import { logPrefix, productName } from './display.ts';
import { productIdentity } from './identity.ts';

describe('product display spelling', () => {
  it.each(['cezar', 'Cezar', 'Cezarion'] as const)('preserves %s until the switch', legacy => {
    expect(productName(legacy, false)).toBe(legacy);
    expect(productName(legacy, true)).toBe(productIdentity(true).displayName);
  });

  it('tags log lines with the command of each switch state', () => {
    expect(logPrefix(false)).toBe('[cez]');
    expect(logPrefix(true)).toBe('[hsq]');
  });
});

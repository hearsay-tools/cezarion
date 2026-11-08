import { describe, expect, it } from 'vitest';
import { productName } from './display.ts';
import { productIdentity } from './identity.ts';

describe('product display spelling', () => {
  it.each(['cezar', 'Cezar', 'Cezarion'] as const)('preserves %s until the switch', legacy => {
    expect(productName(legacy, false)).toBe(legacy);
    expect(productName(legacy, true)).toBe(productIdentity(true).displayName);
  });
});

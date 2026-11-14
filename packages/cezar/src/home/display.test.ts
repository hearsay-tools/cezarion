import { describe, expect, it } from 'vitest';
import { logPrefix, productName } from './display.ts';
import { productIdentity } from './identity.ts';

describe('product display spelling', () => {
  it.each(['cezar', 'Cezar', 'Cezarion'] as const)('names the product for the old spelling %s', legacy => {
    expect(productName(legacy)).toBe(productIdentity().displayName);
  });

  it('tags log lines with the command', () => {
    expect(logPrefix()).toBe('[hsq]');
  });
});

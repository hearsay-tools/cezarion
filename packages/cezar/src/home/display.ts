import { productIdentity } from './identity.ts';
import { REBRAND_SWITCH } from './switch.ts';

/** Preserve each shipped spelling until the release switches the display name. */
export function productName(legacy: 'cezar' | 'Cezar' | 'Cezarion', rebrand = REBRAND_SWITCH): string {
  return rebrand ? productIdentity(rebrand).displayName : legacy;
}

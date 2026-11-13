import { productIdentity } from '../../cezar/src/home/identity.ts'
import { productName as buildProductName } from '../src/lib/product-name'

/** The identity the e2e cockpit build embeds: both read the same product identity. */
const identity = productIdentity()

/** The display name the cockpit renders in place of a shipped spelling. */
export function productName(legacy: 'cezar' | 'Cezar' | 'Cezarion'): string {
  return buildProductName(legacy, identity)
}

/** The installed command the cockpit prints in its instructions. */
export const productCommand = identity.command

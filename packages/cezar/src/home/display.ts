import { productIdentity } from './identity.ts';

/** The product's display name. The argument is ignored: it keeps the call sites' old spelling until
 *  hearsay-tools/squawk#3509 rewrites them as literals. */
export function productName(_legacy: 'cezar' | 'Cezar' | 'Cezarion'): string {
  return productIdentity().displayName;
}

/** The tag that opens a product log line: `[hsq]`. */
export function logPrefix(): string {
  return `[${productIdentity().command}]`;
}

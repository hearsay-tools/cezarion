declare const __PRODUCT_IDENTITY__: { rebrand: boolean; displayName: string }

/** Display prose only. Persisted names, paths and protocol values keep their identity. */
export function productName(
  legacy: 'cezar' | 'Cezar' | 'Cezarion',
  identity = __PRODUCT_IDENTITY__,
): string {
  return identity.rebrand ? identity.displayName : legacy
}

declare const __PRODUCT_IDENTITY__: { rebrand: boolean; displayName: string; command: string; npmAlias: string; npmPackage: string }

/** Display prose only. Persisted names, paths and protocol values keep their identity. */
export function productName(
  legacy: 'cezar' | 'Cezar' | 'Cezarion',
  identity = __PRODUCT_IDENTITY__,
): string {
  return identity.rebrand ? identity.displayName : legacy
}

/** The installed command and npm alias come from the same build identity as product prose. */
export function productCommand(identity = __PRODUCT_IDENTITY__): string {
  return identity.command
}

export function productNpmAlias(identity = __PRODUCT_IDENTITY__): string {
  return identity.npmAlias
}

export function productNpmPackage(identity = __PRODUCT_IDENTITY__): string {
  return identity.npmPackage
}

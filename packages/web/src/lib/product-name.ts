declare const __PRODUCT_IDENTITY__: { rebrand: boolean; displayName: string; command: string; npx: string; npmPackage: string }

/** Display prose only. Persisted names, paths and protocol values keep their identity. */
export function productName(
  legacy: 'cezar' | 'Cezar' | 'Cezarion',
  identity = __PRODUCT_IDENTITY__,
): string {
  return identity.rebrand ? identity.displayName : legacy
}

/** The installed command and one-off npx command come from the same build identity as product prose. */
export function productCommand(identity = __PRODUCT_IDENTITY__): string {
  return identity.command
}

/** Runs the cockpit without a global install, for example `npx -p @hearsay-tools/squawk hsq`. */
export function productNpx(identity = __PRODUCT_IDENTITY__): string {
  return identity.npx
}

/** Runs the scoped package once. The new package has no binary named after it, so npx names `hsq`. */
export function productPackageNpx(identity = __PRODUCT_IDENTITY__): string {
  return identity.rebrand ? `npx -p ${identity.npmPackage} ${identity.command}` : `npx ${identity.npmPackage}`
}

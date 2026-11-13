/** The shipped identity. Its unscoped alias package makes `npx cezarion` work. */
export type LegacyProductIdentity = {
  rebrand: false;
  displayName: 'Cezarion';
  command: 'cez';
  npmPackage: '@wjarka/cezarion';
  npmAlias: 'cezarion';
  npmAliasDirectory: 'alias-cezarion';
  npx: 'npx cezarion';
  envPrefix: 'CEZ_';
  desktopExecutable: 'cezar-desktop';
  desktopAppId: 'tools.hearsay.cezarion';
  mobileAppId: 'tools.hearsay.cezarion.mobile';
};

/** The new identity. npm refuses the unscoped name `hsq`, so it has no alias package. */
export type RebrandProductIdentity = {
  rebrand: true;
  displayName: 'Squawk';
  command: 'hsq';
  npmPackage: '@hearsay-tools/squawk';
  npmAlias: null;
  npmAliasDirectory: null;
  npx: 'npx -p @hearsay-tools/squawk hsq';
  envPrefix: 'HSQ_';
  desktopExecutable: 'squawk-desktop';
  desktopAppId: 'tools.hearsay.squawk';
  mobileAppId: 'tools.hearsay.squawk.mobile';
};

/** Shared product names for the CLI, browser and native build tools. */
export type ProductIdentity = LegacyProductIdentity | RebrandProductIdentity;

/** The new identity by default; `false` names the old one, which compatibility packages and old-app builds still carry. */
export function productIdentity(rebrand?: true): RebrandProductIdentity;
export function productIdentity(rebrand: false): LegacyProductIdentity;
export function productIdentity(rebrand: boolean): ProductIdentity;
export function productIdentity(rebrand = true): ProductIdentity {
  return rebrand ? {
    rebrand, displayName: 'Squawk', command: 'hsq', npmPackage: '@hearsay-tools/squawk',
    npmAlias: null, npmAliasDirectory: null, npx: 'npx -p @hearsay-tools/squawk hsq', envPrefix: 'HSQ_',
    desktopAppId: 'tools.hearsay.squawk', mobileAppId: 'tools.hearsay.squawk.mobile', desktopExecutable: 'squawk-desktop',
  } : {
    rebrand, displayName: 'Cezarion', command: 'cez', npmPackage: '@wjarka/cezarion',
    npmAlias: 'cezarion', npmAliasDirectory: 'alias-cezarion', npx: 'npx cezarion', envPrefix: 'CEZ_',
    desktopAppId: 'tools.hearsay.cezarion', mobileAppId: 'tools.hearsay.cezarion.mobile', desktopExecutable: 'cezar-desktop',
  };
}

/** Runs the scoped package once. It has no binary named after it, so the new
 *  package names its `hsq` binary; the old package's `cezarion` binary matches its name. */
export function scopedNpxCommand(identity: ProductIdentity, version?: string): string {
  const spec = `${identity.npmPackage}${version ? `@${version}` : ''}`;
  return identity.rebrand ? `npx -p ${spec} ${identity.command}` : `npx ${spec}`;
}

/** The one-off command that runs `version` (or the latest) without a global install. */
export function npxCommand(version?: string): string {
  return scopedNpxCommand(productIdentity(), version);
}

/** Additive binary names. Package aliases have separate ownership rules. */
export const BINARY_NAMES = ['cezarion', 'cez', 'hsq'] as const;
export type BinaryName = typeof BINARY_NAMES[number];

/** Accepted launch identities during the package deprecation window. */
export const NPM_LAUNCH_PACKAGES = [
  productIdentity(false).npmPackage, productIdentity(false).npmAlias, productIdentity(true).npmPackage,
] as const;

export type NpmLaunchPackage = typeof NPM_LAUNCH_PACKAGES[number];

/** The scoped runtime belonging to an installed scoped package or the old alias. */
export function npmPackageIdentity(name: string): ProductIdentity | undefined {
  return [productIdentity(false), productIdentity(true)]
    .find(identity => name === identity.npmPackage || (identity.npmAlias !== null && name === identity.npmAlias));
}

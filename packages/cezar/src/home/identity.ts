import { REBRAND_SWITCH } from './switch.ts';

/** Shared product names for the CLI, browser and native build tools. */
export type ProductIdentity = {
  rebrand: boolean;
  displayName: 'Cezarion' | 'Squawk';
  command: 'cez' | 'hsq';
  npmPackage: '@wjarka/cezarion' | '@hearsay-tools/squawk';
  npmAlias: 'cezarion' | 'hsq';
  npmAliasDirectory: 'alias-cezarion' | 'alias-hsq';
  envPrefix: 'CEZ_' | 'HSQ_';
  desktopExecutable: 'cezar-desktop' | 'squawk-desktop';
  desktopAppId: 'tools.hearsay.cezarion' | 'tools.hearsay.squawk';
  mobileAppId: 'tools.hearsay.cezarion.mobile' | 'tools.hearsay.squawk.mobile';
};

export function productIdentity(rebrand: boolean = REBRAND_SWITCH): ProductIdentity {
  return rebrand ? {
    rebrand, displayName: 'Squawk', command: 'hsq', npmPackage: '@hearsay-tools/squawk',
    npmAlias: 'hsq', npmAliasDirectory: 'alias-hsq', envPrefix: 'HSQ_', desktopAppId: 'tools.hearsay.squawk',
    mobileAppId: 'tools.hearsay.squawk.mobile', desktopExecutable: 'squawk-desktop',
  } : {
    rebrand, displayName: 'Cezarion', command: 'cez', npmPackage: '@wjarka/cezarion',
    npmAlias: 'cezarion', npmAliasDirectory: 'alias-cezarion', envPrefix: 'CEZ_', desktopAppId: 'tools.hearsay.cezarion',
    mobileAppId: 'tools.hearsay.cezarion.mobile', desktopExecutable: 'cezar-desktop',
  };
}

/** Additive binary names. Package aliases have separate ownership rules. */
export const BINARY_NAMES = ['cezarion', 'cez', 'hsq'] as const;
export type BinaryName = typeof BINARY_NAMES[number];

/** Accepted launch identities during the package deprecation window. */
export const NPM_LAUNCH_PACKAGES = [
  productIdentity(false).npmPackage, productIdentity(false).npmAlias,
  productIdentity(true).npmPackage, productIdentity(true).npmAlias,
] as const;

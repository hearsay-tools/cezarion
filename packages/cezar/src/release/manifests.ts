/** The manifest arithmetic both release channels share — the pure half of stamping.
 *
 *  `stable.ts` and `snapshot.ts` differ in exactly one decision (how a released package pins
 *  its sibling: a caret range for stable, an exact pin for a snapshot), so everything else
 *  lives here rather than twice.
 *
 *  Source stamping retains workspace names from checked-out manifests. Publication projects
 *  the active service name from productIdentity without renaming source workspaces.
 */

import { productIdentity } from '../home/identity.ts';

/** The minimal manifest shape the stamper touches; everything else passes through. */
export interface ManifestLike {
  name: string;
  version: string;
  /** npm's own opt-out. A private package is still versioned in lockstep, never published. */
  private?: boolean;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  [key: string]: unknown;
}

/**
 * Whether a release stamps AND publishes this package, or only stamps it.
 *
 * The distinction exists because "in the release" and "on the registry" are different things.
 * A package that ships nowhere yet still needs its version moved in lockstep: the api-client is
 * the worked example — the service pins it, so a frozen version would leave that range pointing
 * at a build the release was not cut from, which is exactly the drift this pipeline exists to
 * prevent. Publishing is gated on npm's own `private` flag rather than a list here, so opening
 * a package up is one line in ITS manifest and no change to the release code.
 */
export function isPublishable(pkg: ManifestLike): boolean {
  return pkg.private !== true;
}

/**
 * Relative dirs of every manifest a release stamps, keyed as `ReleaseManifests`.
 *
 * The completeness test walks the workspace root's `workspaces` array against these values, so a
 * new workspace that is not listed here fails CI rather than shipping a bump `npm ci` cannot
 * install. The new identity has no alias package: npm refuses the unscoped name `hsq`. The old
 * names ship as the compatibility packages of `compatibility.ts`.
 */
export const RELEASE_MANIFEST_DIRS: { readonly [K in keyof ReleaseManifests]: string } = {
  contract: 'packages/contract',
  apiClient: 'packages/api-client',
  cezar: 'packages/cezar',
  web: 'packages/web',
};

/** Source workspaces keep their names so builds and version-only bump PRs still work. */
export function publicationManifests(manifests: ReleaseManifests): ReleaseManifests {
  return { ...manifests, cezar: { ...manifests.cezar, name: productIdentity().npmPackage } };
}

/**
 * Every manifest a release stamps.
 *
 * The order of the fields is the order they must be PUBLISHED in, because each one depends on
 * the one before it: the service (from the phase
 * where it stops merely testing against the client and starts importing it) depends on the
 * api-client. Publishing the dependent first would briefly advertise a version of its
 * dependency that does not exist on the registry yet. Private members of the set are still
 * stamped — they are simply skipped at publish time.
 */
export interface ReleaseManifests {
  /**
   * The API contract (zod schemas + inferred types). FIRST in the stamped set because both the
   * api-client and the service depend on it, so its version has to settle before their pins are
   * rewritten. Like the api-client it is `private`, so it is stamped but never published — which
   * is exactly why the service cannot simply depend on it at runtime: `packages/cezar/scripts/
   * inline-contract.mjs` folds it into `dist/contract/` at build time instead. It moves to a real
   * publish the day that script is deleted.
   */
  contract: ManifestLike;
  /** The contract package a consumer installs to talk to a Squawk service. */
  apiClient: ManifestLike;
  /** The published service + CLI. */
  cezar: ManifestLike;
  /**
   * The cockpit SPA. `private`, so never published, but it consumes the api-client and the
   * service, and a bump that leaves its ranges on the previous version makes `npm ci` on the
   * version-bump branch fail the same way an unstamped contract does.
   */
  web: ManifestLike;
}

/** The one-off command that runs `version` (or a dist-tag) of this release set. npx installs
 *  the scoped package and names its `hsq` binary. */
export function releaseRunCommand(publication: ReleaseManifests, version: string): string {
  return `npx -p ${publication.cezar.name}@${version} ${productIdentity().command}`;
}

/** How a released package pins a sibling it depends on. */
export type PinStyle = (version: string) => string;

/**
 * Rewrite `pkg`'s range for `depName`, in whichever dependency section already declares it.
 *
 * Absent means absent: a package that does not depend on the other is returned untouched. That
 * is what lets the api-client dependency migrate from `devDependencies` (today: only the tests
 * import it) to `dependencies` (once the service imports its DTOs at runtime) without the
 * release pipeline needing to know it happened.
 */
export function pinDependency(pkg: ManifestLike, depName: string, range: string): ManifestLike {
  const sections = ['dependencies', 'devDependencies', 'peerDependencies'] as const;
  const out: ManifestLike = { ...pkg };
  for (const section of sections) {
    const deps = pkg[section] as Record<string, string> | undefined;
    if (deps && depName in deps) out[section] = { ...deps, [depName]: range };
  }
  return out;
}

/**
 * Stamp every manifest to `version` and re-pin the intra-release dependencies.
 *
 * Pins, all derived from the manifests rather than hardcoded:
 *   - the service → the api-client (and the contract), so a published service can never resolve
 *     a client build it was not released with;
 *   - the cockpit → the api-client and the service, so a bump branch stays `npm ci`-able.
 */
export function stampManifestSet(
  manifests: ReleaseManifests,
  version: string,
  pin: PinStyle,
): ReleaseManifests {
  const { contract, apiClient, cezar, web } = manifests;
  const range = pin(version);

  return {
    contract: { ...contract, version },
    apiClient: pinDependency({ ...apiClient, version }, contract.name, range),
    cezar: pinDependency(
      pinDependency({ ...cezar, version }, apiClient.name, range),
      contract.name,
      range,
    ),
    web: pinDependency(
      pinDependency({ ...web, version }, apiClient.name, range),
      cezar.name,
      range,
    ),
  };
}

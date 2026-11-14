/** Stable-release decisions — the pure half of `scripts/release.mjs`.
 *
 *  Sibling of `snapshot.ts`, but for the *owner-driven* `latest` channel. The
 *  `Release` workflow (`.github/workflows/release.yml`) is run manually and
 *  never fires from a push, so — unlike snapshots — a stable release is the only
 *  thing that ever moves the `latest` dist-tag (spec
 *  `.ai/specs/2026-07-18-npm-preview-publish.md`, #482).
 *
 *  Two decisions live here so they stay unit-testable and side-effect-free: the next stable
 *  version for a given bump, and the pin style the release set is stamped with. Crucially,
 *  stable releases use a **caret** range — the opposite of the snapshot stamper's exact pin —
 *  so a stable `cezarion` picks up compatible patch releases of the implementation package.
 */

import { stampManifestSet, type ReleaseManifests as ReleaseManifestSet } from './manifests.ts';

/** The version-bump modes the Release workflow offers. `existing` publishes the
 *  version already committed to the service manifest (for hand-prepared releases);
 *  the rest increment semver from the current base. */
export type ReleaseBump = 'patch' | 'minor' | 'major' | 'existing';

export const RELEASE_BUMPS: readonly ReleaseBump[] = ['patch', 'minor', 'major', 'existing'];

export function isReleaseBump(value: string): value is ReleaseBump {
  return (RELEASE_BUMPS as readonly string[]).includes(value);
}

/** Compute the next stable version from the current base and a bump mode.
 *
 *  `base` must be a plain `major.minor.patch` (no prerelease/build suffix) — a
 *  stable release should never start from a snapshot version. `existing` returns
 *  the base verbatim; the increments zero out the lower components the way
 *  `npm version` does. Returns `null` for an unparseable base so the caller can
 *  fail loudly instead of publishing a garbage version. */
export function computeStableVersion(bump: ReleaseBump, base: string): string | null {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(base.trim());
  if (!m) return null;
  const [major, minor, patch] = [Number(m[1]), Number(m[2]), Number(m[3])];
  switch (bump) {
    case 'existing':
      return `${major}.${minor}.${patch}`;
    case 'patch':
      return `${major}.${minor}.${patch + 1}`;
    case 'minor':
      return `${major}.${minor + 1}.0`;
    case 'major':
      return `${major + 1}.0.0`;
    default:
      return null;
  }
}

export type { ManifestLike, ReleaseManifests } from './manifests.ts';

/** Stamp the release set to a stable version.
 *
 *  Mirror of `stampSnapshotManifests`, differing in exactly one decision: intra-release
 *  dependencies get a **caret** range (`^0.1.6`), not an exact pin. A stable `cezarion` should
 *  follow compatible releases of the implementation package, and a stable service should follow
 *  compatible releases of the api-client; a snapshot must pin the one exact build it was cut
 *  from. Everything else — which manifests exist, which sections carry the pin — lives in `manifests.ts` so the two channels cannot drift apart. */
export function stampStableManifests(
  manifests: ReleaseManifestSet,
  version: string,
): ReleaseManifestSet {
  return stampManifestSet(manifests, version, (v) => `^${v}`);
}

/** What one publication of the Release workflow writes: the version, its dist-tag, and how
 *  the set pins its siblings. */
export interface ReleaseTarget {
  version: string;
  distTag: string;
  /** A release candidate pins its siblings exactly, so its tests run exactly that build. */
  exactPins: boolean;
}

const STABLE_VERSION = /^\d+\.\d+\.\d+$/;
const CANDIDATE_VERSION = /^\d+\.\d+\.\d+-rc\.[1-9]\d*$/;
const STABLE_TAG = /^latest(?:-\d+\.\d+)?$/;
const CANDIDATE_TAG = /^next(?:-\d+\.\d+)?$/;

/** Resolve the release target, or explain why it is refused.
 *
 *  Without a requested version the bump decides, under `latest`, as before. A requested
 *  version is either stable (`x.y.z`, under `latest` or a maintenance line's `latest-x.y`)
 *  or a release candidate (`x.y.z-rc.n`, under `next` or `next-x.y`). A candidate can never
 *  take `latest`, so an install of `@latest` never resolves to one. */
export function resolveReleaseTarget(
  bump: ReleaseBump,
  base: string,
  requested: { version?: string | undefined; distTag?: string | undefined } = {},
): ReleaseTarget | { error: string } {
  const version = requested.version || computeStableVersion(bump, base);
  if (!version) return { error: `cannot ${bump}-bump base version "${base}" — a stable release must start from a plain x.y.z.` };
  const candidate = CANDIDATE_VERSION.test(version);
  if (!candidate && !STABLE_VERSION.test(version)) return { error: `"${version}" is neither x.y.z nor x.y.z-rc.n.` };
  const distTag = requested.distTag || (candidate ? '' : 'latest');
  if (!(candidate ? CANDIDATE_TAG : STABLE_TAG).test(distTag)) {
    return { error: `dist-tag "${distTag}" does not fit ${candidate ? 'a release candidate (next or next-x.y)' : 'a stable version (latest or latest-x.y)'}.` };
  }
  const line = /-(\d+\.\d+)$/.exec(distTag)?.[1];
  if (line && !version.startsWith(`${line}.`)) return { error: `dist-tag "${distTag}" names another version line than ${version}.` };
  return { version, distTag, exactPins: candidate };
}

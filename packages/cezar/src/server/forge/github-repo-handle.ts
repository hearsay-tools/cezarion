import { productEnv } from '../../core/product-env.ts';
import { gh, githubContext, parseOwnerName } from './github-cli.ts';
import type { RepoHandleDiscovery } from './repo-handle-discovery.ts';

// The repo handle for the per-commit checks query (#525 Phase 2). Memoized per repoRoot — stable
// in practice, and keyed per root rather than globally for multi-project forward-compatibility.
// `null` is a cached permanent negative for malformed identity. Local absence is not cached (#102).
// Network, authentication and timeout failures are deliberately NOT cached: caching them would
// disable glyphs until process restart on one transient failure.
// `gh repo view` asks GitHub, which follows a rename, so the handle is the repository's current
// name even when `origin` still names the old one (hearsay-tools/cezarion#3326).
type RepoHandle = { owner: string; name: string } | null;
const repoHandleCache = new Map<string, RepoHandle>();
type RepoDiscoveryFlight = {
  controller: AbortController;
  promise: Promise<RepoHandle>;
  owners: number;
};
const repoDiscoveryFlights = new Map<string, RepoDiscoveryFlight>();

/** Each subscriber owns a lease, not the subprocess. Only the last cancellation aborts it.
 * Keep the rejecting promise intact so strict callers retain gh's diagnostic. */
export function sharedRepoHandle(repoRoot: string, signal?: AbortSignal, context = githubContext(repoRoot)): Promise<RepoHandle> {
  if (signal?.aborted) return Promise.reject(signal.reason);
  const memo = repoHandleCache.get(context.key);
  if (memo !== undefined) return Promise.resolve(memo);
  let flight = repoDiscoveryFlights.get(context.key);
  if (!flight) {
    const controller = new AbortController();
    const created: RepoDiscoveryFlight = {
      controller, owners: 0,
      promise: gh(repoRoot, ['repo', 'view', '--json', 'nameWithOwner', '--jq', '.nameWithOwner'], 15_000, controller.signal, context)
        .then(parseOwnerName),
    };
    created.promise = created.promise.then(handle => {
      // A disposed owner may complete late; it must not overwrite a replacement discovery.
      if (!controller.signal.aborted && repoDiscoveryFlights.get(context.key) === created) {
        repoHandleCache.set(context.key, handle);
      }
      return handle;
    }).finally(() => {
      if (repoDiscoveryFlights.get(context.key) === created) repoDiscoveryFlights.delete(context.key);
    });
    flight = created;
    repoDiscoveryFlights.set(context.key, flight);
  }
  const owned = flight;
  owned.owners++;
  return new Promise((resolve, reject) => {
    let released = false;
    const release = () => {
      if (released) return false;
      released = true;
      signal?.removeEventListener('abort', cancel);
      if (--owned.owners === 0 && repoDiscoveryFlights.get(context.key) === owned) {
        repoDiscoveryFlights.delete(context.key);
        owned.controller.abort();
      }
      return true;
    };
    const cancel = () => { if (release()) reject(signal?.reason); };
    signal?.addEventListener('abort', cancel, { once: true });
    owned.promise.then(
      handle => { if (release()) resolve(handle); },
      error => { if (release()) reject(error); },
    );
  });
}

/** Test-only: drop the memoized repo handles. */
export function __clearRepoHandleCacheForTests(): void {
  repoHandleCache.clear();
  for (const flight of repoDiscoveryFlights.values()) flight.controller.abort();
  repoDiscoveryFlights.clear();
}

/** Drop this root's memoized handle after a read that named it failed or was redirected: the
 *  repository may have been renamed since, and the next lookup asks GitHub again. */
export function forgetRepoHandle(repoRoot: string): void {
  repoHandleCache.delete(githubContext(repoRoot).key);
}

/** Local absence cannot improve through network retries. Authentication, timeouts and remote
 * errors deliberately stay retryable, including 404s for temporarily inaccessible repositories. */
function isPermanentRepoFailure(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if ('code' in error && error.code === 'ENOENT') return true;
  const stderr = 'stderr' in error && typeof error.stderr === 'string' ? error.stderr : '';
  return /not a git repository|no git remotes found|none of the git remotes configured for this repository point to a known GitHub host/i.test(`${error.message}\n${stderr}`);
}

/** Share the existing memo with ordinary discovery, but retain failure classification (#102).
 * An aborted owner must never publish its late result into this shared cache. */
export async function discoverRepoHandle(repoRoot: string, signal?: AbortSignal): Promise<RepoHandleDiscovery> {
  const context = githubContext(repoRoot);
  if (signal?.aborted) return { status: 'cancelled' };
  try {
    const handle = await sharedRepoHandle(repoRoot, signal, context);
    if (signal?.aborted) return { status: 'cancelled' };
    return handle ? { status: 'resolved', handle } : { status: 'unknown' };
  } catch (error) {
    if (signal?.aborted) return { status: 'cancelled' };
    if (isPermanentRepoFailure(error)) {
      // Do not replace a successful discovery another caller completed while this one failed.
      const recovered = repoHandleCache.get(context.key);
      if (recovered) return { status: 'resolved', handle: recovered };
      // The live arming loop stops on unknown. Do not memoize local failures here: later cold
      // index/status requests must still discover an installed gh or a newly added remote.
      return { status: 'unknown' };
    }
    return { status: 'retryable' };
  }
}

/** Compatible fail-open lookup for existing API and cold-index callers. */
export async function resolveRepoHandle(
  repoRoot: string,
  signal?: AbortSignal,
): Promise<{ owner: string; name: string } | null> {
  const result = await discoverRepoHandle(repoRoot, signal);
  return result.status === 'resolved' ? result.handle : null;
}

/** The name to read `remote`'s repository under: GitHub's current name for it, or `remote` itself
 *  when `gh` cannot say. Null only without a remote. */
export async function canonicalRepoRef(repoRoot: string, remote: { owner: string; repo: string } | null): Promise<{ owner: string; repo: string } | null> {
  if (!remote || productEnv('DRY_RUN') === '1') return remote;
  const handle = await resolveRepoHandle(repoRoot);
  return handle ? { owner: handle.owner, repo: handle.name } : remote;
}

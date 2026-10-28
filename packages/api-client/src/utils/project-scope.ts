/**
 * Build versioned API paths from routes and the active project scope. The routed provider is the
 * sole scope writer; plain client functions read it per request.
 */

/**
 * The version prefix every request carries.
 *
 * The service used to answer on an unversioned `/api/*` as well; that surface was removed once
 * the whole API was reachable under `/api/v1` (BACKWARD_COMPATIBILITY.md). Nothing should
 * reintroduce a bare `/api/...` fetch — it will 404.
 */
export const API_PREFIX = '/api/v1'

/**
 * Runtime API base for embedding or a separate service origin. Empty means same-origin
 * root-relative requests; keep this framework-neutral.
 */
let baseUrl = ''

/** Set the service origin. `''` (the default) means "same origin as this page". */
export function setApiBaseUrl(url: string): void {
  // A trailing slash would double up against the leading slash of every route.
  baseUrl = url.replace(/\/+$/, '')
}

export function getApiBaseUrl(): string {
  return baseUrl
}

let activeProjectId: string | null = null

/** Written by ProjectScopeProvider on mount/param change (and cleared on unmount). Everything
 *  else only reads. */
export function setApiScope(projectId: string | null): void {
  activeProjectId = projectId === '' ? null : projectId
}

export function getApiScope(): string | null {
  return activeProjectId
}

/** The scoped API base — what the context carries and what deep links embed. */
export function apiBase(): string {
  const scoped =
    activeProjectId === null ? '' : `/p/${encodeURIComponent(activeProjectId)}`
  return `${baseUrl}${API_PREFIX}${scoped}`
}

/**
 * The leading TanStack Query key segment (queries.ts prepends this to every key so caches never
 * bleed across projects). `'default'` when unscoped — a stable sentinel, and also the server's
 * reserved alias for the boot project, so the segment always *names* the project the data
 * belongs to. A registered project id can never collide with it: `'default'` is a reserved slug
 * server-side.
 */
export function queryScope(): string {
  return activeProjectId ?? 'default'
}

/**
 * Workspace-level routes — single-mount on the server, never mirrored under `/p/:projectId`, so
 * scoping them would 404. `/workspace/*` (config, ui-state, events), `/projects` (the registry
 * plus `/checkout`), `/fs/*` (the folder picker — one filesystem, not one per project),
 * `/providers/*` and `/models` (host state shared across projects), and `/health`.
 */
const WORKSPACE_LEVEL =
  /^\/(?:health$|models(?:$|[/?])|providers(?:$|[/?])|projects(?:$|[/?])|workspace\/|fs\/)/

/**
 * Turn a ROUTE into the request path: `/runs` → `/api/v1/runs`, or `/api/v1/p/<id>/runs` when a
 * project scope is active. Workspace-level routes (above) answer for the whole workspace and
 * never take the scope.
 *
 * Every caller passes a route, never a URL — that is what keeps the version in one place.
 * A URL that arrived from the server goes through `resolveApiUrl` instead.
 *
 * Applied at request time (send(), the EventSources), never stored.
 */
export function apiPath(route: string): string {
  return `${baseUrl}${API_PREFIX}${scopeRoute(route)}`
}

/** The active project's prefix, or nothing — the one place the scoping rule is spelled. */
function scopeRoute(route: string): string {
  if (activeProjectId === null || WORKSPACE_LEVEL.test(route)) return route
  return `/p/${encodeURIComponent(activeProjectId)}${route}`
}

/** Matches a cockpit API URL and captures the part after `/api`, scope included. */
const API_URL = /^\/api(?:\/v1)?(\/.*)$/

/**
 * Resolve a URL the SERVER minted into one this client can fetch today.
 *
 * Run transcripts persist absolute image URLs (`/api/runs/<id>/images/…`) into NDJSON and keep
 * them forever, so the cockpit renders URLs written by every version that ever ran in a repo.
 * Two things therefore have to happen at render time rather than at write time:
 *
 * - **Upgrade.** A URL stored before the API was versioned is rewritten onto `/api/v1`. This is
 *   the migration path for existing transcripts; without it every historical screenshot 404s
 *   the moment the unversioned surface is gone.
 * - **Re-scope.** Transcripts store the unscoped spelling, so the active project's prefix is
 *   applied on use, which keeps one stored URL valid under every project.
 *
 * Anything that is not a cockpit API URL — a `/raw/...` asset, a `https://github.com/...` link,
 * a `data:` URI — is returned untouched. It is not ours to rewrite.
 */
export function resolveApiUrl(url: string): string {
  // An absolute URL keeps its own origin — re-basing someone else's host is not ours to do — but
  // it still gets the version upgrade, because a transcript written before `/api/v1` existed can
  // just as easily carry `https://host/api/runs/…` as `/api/runs/…`, and the unversioned spelling
  // 404s either way. Only the PATH is rewritten, and only when it is a cockpit API path.
  const scheme = /^[a-z][a-z0-9+.-]*:/i.exec(url)
  if (scheme) {
    // Opaque schemes (`data:`, `blob:`) have no path to speak of and no origin to preserve.
    const separator = url.indexOf('//', scheme[0].length)
    if (separator !== scheme[0].length) return url
    const pathStart = url.indexOf('/', separator + 2)
    if (pathStart === -1) return url
    const origin = url.slice(0, pathStart)
    const upgraded = upgradeApiPath(url.slice(pathStart))
    return upgraded === null ? url : `${origin}${upgraded}`
  }
  const withoutBase = baseUrl && url.startsWith(baseUrl) ? url.slice(baseUrl.length) : url
  const upgraded = upgradeApiPath(withoutBase)
  return upgraded === null ? url : `${baseUrl}${upgraded}`
}

/**
 * The path half of {@link resolveApiUrl}: `/api/…` or `/api/v1/…` → the versioned, correctly
 * scoped spelling, WITHOUT the configured base (the caller owns that, since an absolute URL keeps
 * its own origin instead). `null` when the path is not a cockpit API path at all.
 */
function upgradeApiPath(path: string): string | null {
  const match = API_URL.exec(path)
  if (!match) return null
  const route = match[1] as string
  // Already scoped (`/p/<id>/…`) — the stored URL names its own project, so leave it.
  if (route.startsWith('/p/')) return `${API_PREFIX}${route}`
  return `${API_PREFIX}${scopeRoute(route)}`
}

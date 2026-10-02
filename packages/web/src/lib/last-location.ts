import type {
  ProjectsResponse,
  WorkspaceLastLocation,
} from '@open-mercato/cezar-api-client'

import { pathnameProjectId } from './project-router'

export type LocationParts = Pick<Location, 'pathname' | 'search' | 'hash'>

/**
 * Where the remembered location lives: THIS browser, not the workspace file.
 *
 * It shipped in `~/.cezar/ui-state.json` and that made one answer serve every client — the phone
 * on the couch decided where the desktop's next bare-root launch landed, and two open cockpits
 * overwrote each other on every navigation. "The page this window was last on" describes a
 * browser, so it is stored per browser (like `cez-theme`). A server that still holds the legacy
 * `lastLocation` key keeps it; nothing reads it any more.
 */
export const LAST_LOCATION_STORAGE_KEY = 'cez-last-location'

/** The stored value, unvalidated — `locationToRestore` is what decides whether it is usable. */
export function readStoredLastLocation(): unknown {
  try {
    const raw = localStorage.getItem(LAST_LOCATION_STORAGE_KEY)
    return raw === null ? null : JSON.parse(raw)
  } catch {
    // Absent, private mode, or a hand-edited non-JSON value — no remembered location.
    return null
  }
}

export function writeStoredLastLocation(location: WorkspaceLastLocation): void {
  try {
    localStorage.setItem(LAST_LOCATION_STORAGE_KEY, JSON.stringify(location))
  } catch {
    // Private mode / storage full — navigation continues, the next launch just starts at boot.
  }
}

const LAST_LOCATION_KEYS = new Set(['projectId', 'pathname', 'search', 'hash'])

function parsedLastLocation(value: unknown): WorkspaceLastLocation | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null

  const record = value as Record<string, unknown>
  if (Object.keys(record).some((key) => !LAST_LOCATION_KEYS.has(key))) return null
  if (typeof record.projectId !== 'string' || record.projectId.length < 1 || record.projectId.length > 64) {
    return null
  }
  if (
    typeof record.pathname !== 'string' ||
    record.pathname.length < 1 ||
    record.pathname.length > 2_048 ||
    !record.pathname.startsWith('/p/')
  ) {
    return null
  }
  if (
    record.search !== undefined &&
    (typeof record.search !== 'string' || record.search.length > 4_096 || !record.search.startsWith('?'))
  ) {
    return null
  }
  if (
    record.hash !== undefined &&
    (typeof record.hash !== 'string' || record.hash.length > 2_048 || !record.hash.startsWith('#'))
  ) {
    return null
  }

  try {
    if (pathnameProjectId(record.pathname) !== record.projectId) return null
  } catch {
    return null
  }

  return {
    projectId: record.projectId,
    pathname: record.pathname,
    ...(record.search === undefined ? {} : { search: record.search }),
    ...(record.hash === undefined ? {} : { hash: record.hash }),
  }
}

function projectIsUsable(projectId: string, registry: ProjectsResponse): boolean {
  const project = registry.projects.find((entry) => entry.id === projectId)
  return project !== undefined && project.status !== 'missing'
}

export function locationToSave(
  location: LocationParts,
  registry: ProjectsResponse | undefined,
): WorkspaceLastLocation | null {
  if (registry === undefined) return null

  let projectId: string | null
  try {
    projectId = pathnameProjectId(location.pathname)
  } catch {
    return null
  }
  if (projectId === null || !projectIsUsable(projectId, registry)) return null

  return parsedLastLocation({
    projectId,
    pathname: location.pathname,
    ...(location.search === '' ? {} : { search: location.search }),
    ...(location.hash === '' ? {} : { hash: location.hash }),
  })
}

export function locationToRestore(
  value: unknown,
  registry: ProjectsResponse | undefined,
  bootProject: string | undefined,
): string | null {
  const location = parsedLastLocation(value)
  if (location === null) return null

  const projectIsAvailable =
    registry === undefined
      ? bootProject !== undefined && location.projectId === bootProject
      : projectIsUsable(location.projectId, registry)
  if (!projectIsAvailable) return null

  return `${location.pathname}${location.search ?? ''}${location.hash ?? ''}`
}

/** `left` is deliberately `unknown`: the comparison's caller reads it back out of storage, where
 *  the type system does not reach. Anything that does not parse as a location is simply not equal
 *  to one, so a corrupted value is overwritten rather than kept. */
export function sameLastLocation(left: unknown, right: WorkspaceLastLocation): boolean {
  const parsed = parsedLastLocation(left)
  return (
    parsed !== null &&
    parsed.projectId === right.projectId &&
    parsed.pathname === right.pathname &&
    (parsed.search ?? '') === (right.search ?? '') &&
    (parsed.hash ?? '') === (right.hash ?? '')
  )
}

/**
 * Where each project's own last page lives: `{ [projectId]: location }`, in THIS browser.
 *
 * `cez-last-location` answers one question — where does a bare-root launch land — and holds only
 * the single latest page. Switching projects asks a different one (where was I in THAT project),
 * so it gets its own key and the bare-root key is untouched. Global pages never reach it:
 * `locationToSave` only yields project-scoped, registered locations.
 */
export const PROJECT_LOCATIONS_STORAGE_KEY = 'cez-project-locations'

function readProjectLocations(): Record<string, unknown> {
  try {
    const raw = localStorage.getItem(PROJECT_LOCATIONS_STORAGE_KEY)
    const value: unknown = raw === null ? null : JSON.parse(raw)
    return typeof value === 'object' && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {}
  } catch {
    // Absent, private mode or hand-edited: no memories, and the next write replaces it.
    return {}
  }
}

/** One project's stored memory, unvalidated — `projectSwitchTarget` decides whether it is usable. */
export function readStoredProjectLocation(projectId: string): unknown {
  const entry = readProjectLocations()[projectId]
  return entry === undefined ? null : entry
}

export function writeStoredProjectLocation(location: WorkspaceLastLocation): void {
  try {
    localStorage.setItem(
      PROJECT_LOCATIONS_STORAGE_KEY,
      JSON.stringify({ ...readProjectLocations(), [location.projectId]: location }),
    )
  } catch {
    // Private mode / storage full — switching just lands on the project home.
  }
}

/**
 * The remembered page of `projectId` as a path, or null when there is nothing usable: no memory,
 * corrupt storage, a page of another project, or a project that is gone or missing. This is the
 * storage half of a project switch; whether the router actually serves the page, and whether its
 * entity still exists, is `lib/project-switch.ts`.
 */
export function rememberedProjectPage(
  projectId: string,
  stored: unknown,
  registry: ProjectsResponse | undefined,
): string | null {
  const saved = parsedLastLocation(stored)
  if (saved === null || saved.projectId !== projectId) return null
  if (registry === undefined || !projectIsUsable(projectId, registry)) return null
  return `${saved.pathname}${saved.search ?? ''}${saved.hash ?? ''}`
}

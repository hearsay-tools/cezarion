import { useEffect } from 'react'
import { useLocation } from 'react-router'

import { useSwitchHost } from '@/components/use-project-switch'

import { useProjects } from '@/api/queries'
import {
  locationToSave,
  readStoredLastLocation,
  readStoredProjectLocation,
  sameLastLocation,
  writeStoredLastLocation,
  writeStoredProjectLocation,
} from '@/lib/last-location'

/**
 * Remembers settled project-scoped navigation for the next exact-bare-root launch, in THIS
 * browser's localStorage (`lib/last-location.ts`).
 *
 * This controller lives once beside the routed tree: global settings and legacy paths are
 * ignored by `locationToSave`, while valid registered project URLs are mirrored to storage as
 * they settle. Storing it per browser is the point — the workspace file gave every client one
 * shared answer, so a phone browsing one project moved where the desktop's next launch landed.
 *
 * Each project also keeps its own latest page (`cez-project-locations`), which the rail and the
 * palette read when switching projects.
 *
 * The write is synchronous and local, so there is no debounce and no in-flight ordering to
 * protect: a redirect chain simply overwrites its own intermediate values, and the last
 * navigation wins because it runs last.
 */
export function LastLocationController(): null {
  const location = useLocation()
  const projects = useProjects()
  // Lives as long as the app, so a project switch still pending after the palette unmounts is
  // cancelled by the next navigation.
  useSwitchHost()

  useEffect(() => {
    const next = locationToSave(location, projects.data)
    if (next === null) return
    // Cheap, but not free: skipping the equal write keeps a re-render storm off the disk-backed
    // storage, and keeps the stored JSON byte-identical across a reload.
    if (!sameLastLocation(readStoredLastLocation(), next)) writeStoredLastLocation(next)
    // The same settled page, filed under its own project so a switch back can return to it.
    if (!sameLastLocation(readStoredProjectLocation(next.projectId), next)) writeStoredProjectLocation(next)
  }, [
    location.hash,
    location.pathname,
    location.search,
    projects.data,
  ])

  return null
}

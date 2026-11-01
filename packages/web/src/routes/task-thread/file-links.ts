import { createContext } from 'react'
import { isHtmlPath } from '@/lib/html-report'

/** The project a file link may be stamped with is the run's OWNER — never a viewer/boot project
 * (#925). `TaskFileScope` fills it from the matched `/p/:projectId` route; publish ownership and
 * the legacy-flat redirect are the other two owner sources. */
export type TaskFileContextValue = { runId: string; projectId?: string | undefined; basePath?: string }
export const TaskFileContext = createContext<TaskFileContextValue | null>(null)

const ARTIFACT_ID = /^[0-9a-f-]{36}$/i
/** A publication link `cez artifact publish` prints for its owner: `/p/<owner>/tasks/<run>/files?artifact=<id>`. */
const SCOPED_ARTIFACT = /^(\/p\/[^/?#]+\/tasks\/[^/?#]+)\/files\?(artifact=[^&#]*)$/

function onlyArtifact(query: string): boolean {
  const params = new URLSearchParams(query)
  return [...params.keys()].length === 1 && ARTIFACT_ID.test(params.get('artifact') ?? '')
}

/** Publications open in the reader (hearsay-tools/cezarion#2400), which hands non-HTML to Files.
 *  The reader only reads, so a link keeps its owner's project and run and needs no confirm.
 *  `undefined`: not a publication link. */
function publicationHref(href: string, files: string, reader: string): string | null | undefined {
  if (href.startsWith(`${files}?artifact=`)) return onlyArtifact(href.slice(files.length + 1)) ? reader + href.slice(files.length) : null
  const scoped = SCOPED_ARTIFACT.exec(href)
  return scoped && onlyArtifact(scoped[2]!) ? `${scoped[1]}/report?${scoped[2]}` : undefined
}

const COCKPIT_PATH = /^\/(?:api|p|tasks|new|settings|skills|workflows|git|github|inbox|automations)(?:\/|[?#]|$)/

/** Classify before the Markdown sanitizer drops file: URLs; never broaden its protocol list. */
export function taskFileHref(destination: string, context: TaskFileContextValue): string | null {
  if (!destination || /[\u0000-\u001f]/.test(destination) || destination.startsWith('#') || destination.startsWith('//')) return null
  try { decodeURIComponent(destination) } catch { return null }
  // Split before decoding: %23 belongs to the filename; a literal # starts a fragment.
  const fragmentAt = destination.indexOf('#')
  const href = fragmentAt < 0 ? destination : destination.slice(0, fragmentAt)
  const fragment = fragmentAt < 0 ? '' : destination.slice(fragmentAt)
  const prefix = context.projectId ? `/p/${encodeURIComponent(context.projectId)}` : ''
  const files = `/tasks/${encodeURIComponent(context.runId)}/files`
  const reader = `/tasks/${encodeURIComponent(context.runId)}/report`
  const publication = publicationHref(href, files, prefix + reader)
  if (publication !== undefined) return publication === null ? null : publication + fragment
  if (COCKPIT_PATH.test(href)) return null
  const windows = /^[a-z]:[\\/]/i.test(href)
  if (!windows && /^[a-z][a-z\d+.-]*:/i.test(href) && !/^file:/i.test(href)) return null
  // Markdown destinations are URI-encoded; query selectors carry literal paths.
  // File URLs retain their own encoding for the server's fileURLToPath parser.
  let path = /^file:/i.test(href) ? href : decodeURIComponent(href)
  if (/[\u0000-\u001f]/.test(path)) return null
  if (context.basePath && !path.startsWith('/') && !windows && !/^file:/i.test(href)) {
    const base = context.basePath.replaceAll('\\', '/')
    path = base.slice(0, base.lastIndexOf('/') + 1) + path
  }
  return `${prefix}${isHtmlPath(path) ? reader : files}?path=${encodeURIComponent(path)}${fragment}`
}

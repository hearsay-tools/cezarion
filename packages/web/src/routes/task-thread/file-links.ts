import { createContext } from 'react'

export type TaskFileContextValue = { runId: string; projectId?: string; basePath?: string }
export const TaskFileContext = createContext<TaskFileContextValue | null>(null)

const COCKPIT_PATH = /^\/(?:api|p|tasks|new|settings|skills|workflows|git|github|inbox|automations)(?:\/|[?#]|$)/

/** Classify before the Markdown sanitizer drops file: URLs; never broaden its protocol list. */
export function taskFileHref(href: string, context: TaskFileContextValue): string | null {
  if (!href || /[\u0000-\u001f]/.test(href) || href.startsWith('#') || href.startsWith('//')) return null
  try { decodeURIComponent(href) } catch { return null }
  const prefix = context.projectId ? `/p/${encodeURIComponent(context.projectId)}` : ''
  const files = `/tasks/${encodeURIComponent(context.runId)}/files`
  if (href.startsWith(`${files}?artifact=`)) {
    const query = new URLSearchParams(href.slice(files.length + 1))
    if ([...query.keys()].length === 1 && /^[0-9a-f-]{36}$/i.test(query.get('artifact') ?? '')) return prefix + href
    return null
  }
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
  return `${prefix}${files}?path=${encodeURIComponent(path)}`
}

import { exactLineIndex, nextLineIndex } from '@open-mercato/cezar-api-client/contract/handoff'

/** The lifecycle lines cezar wrote into the Progress log before hearsay-tools/cezarion#1809. A
 *  journal from an older run still holds them; the preview never shows one. */
const LEGACY_LIFECYCLE_LINE =
  /^- \S+ — (?:(?:turn complete|step ".*" complete|step ".*" ended without done|session idle-closed) — |worktree setup (?:done in|failed —|skipped —) )/

/**
 * The latest progress a Tasks row previews (hearsay-tools/cezarion#1616): the first lines of the
 * handoff journal's `## Progress log`, newest first. The list bullet is dropped; every line is the
 * agent's own words.
 */
export function progressPreview(handoff: string, maxLines = 3): string[] {
  const marker = '## Progress log'
  const start = exactLineIndex(handoff, marker)
  if (start < 0) return []
  const own: string[] = []
  for (const line of handoff.slice(nextLineIndex(handoff, start)).split('\n')) {
    if (own.length >= maxLines || line.startsWith('## ')) break
    const trimmed = line.trim()
    if (!trimmed || LEGACY_LIFECYCLE_LINE.test(trimmed)) continue
    own.push(trimmed.replace(/^[-*] /, ''))
  }
  return own
}

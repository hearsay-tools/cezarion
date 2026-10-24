/** cezar's own turn-end heartbeats, as `handoffProgressExcerpt` (`packages/cezar/src/handoff.ts`)
 *  recognizes them: shown only when the agent wrote nothing of its own. */
const LIFECYCLE_HEARTBEAT = /^- \S+ — (?:turn complete|step ".*" complete|session idle-closed) — /

/**
 * The latest progress a Tasks row previews (hearsay-tools/cezarion#1616): the first lines of the
 * handoff journal's `## Progress log`, newest first, by the same rule the variants compare column
 * reads on the server. The list bullet is dropped; the line is otherwise the agent's own words.
 */
export function progressPreview(handoff: string, maxLines = 3): string[] {
  const marker = '## Progress log'
  const start = handoff.indexOf(marker)
  if (start < 0) return []
  const own: string[] = []
  const lifecycle: string[] = []
  for (const line of handoff.slice(start + marker.length).split('\n')) {
    if (line.startsWith('## ')) break
    const trimmed = line.trim()
    if (!trimmed) continue
    ;(LIFECYCLE_HEARTBEAT.test(trimmed) ? lifecycle : own).push(trimmed)
    if (own.length >= maxLines) break
  }
  return (own.length ? own : lifecycle).slice(0, maxLines).map((line) => line.replace(/^[-*] /, ''))
}

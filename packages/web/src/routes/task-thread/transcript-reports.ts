import { useContext, useLayoutEffect, useMemo } from 'react'
import { useParams } from 'react-router'

import { reportButtonId, reportReferences } from './report-cards'
import { ReportCardSourcesContext } from './report-selection'
import { groupThreadItems, type ThreadBlock } from './thread-groups'
import type { ThreadScrollControls } from './thread-scroller'
import type { TranscriptRowModel } from './session-transcript'

interface TranscriptReportMessage {
  messageKey: string
  text: string
  rowKey: string
  rowIndex: number
}

function blockMessages(block: ThreadBlock, scope: string): Array<{ messageKey: string; text: string }> {
  if (block.kind === 'entry') {
    const entry = block.entry
    return entry.kind === 'message' && entry.role === 'assistant' ? [{ messageKey: `${scope}:${entry.id}`, text: entry.text }] : []
  }
  if (block.kind === 'tool-card') return groupThreadItems(block.children).flatMap(child => blockMessages(child, `${scope}:${block.id}`))
  if (block.kind === 'streak') return block.blocks.flatMap(child => blockMessages(child, scope))
  return []
}

/** Read the data model before virtual rows mount. Source ownership must not depend on viewport. */
export function transcriptReportMessages(rows: readonly TranscriptRowModel[]): TranscriptReportMessage[] {
  return rows.flatMap((row, rowIndex) => row.content.kind === 'block'
    ? blockMessages(row.content.block, row.scope).map(message => ({ ...message, rowKey: row.key, rowIndex }))
    : [])
}

export function useTranscriptReports(runId: string, rows: readonly TranscriptRowModel[], controls: Pick<ThreadScrollControls, 'jumpToRow'>, mode: 'document' | 'panel') {
  const registry = useContext(ReportCardSourcesContext)
  // The provider below SessionTranscript uses this same matched owner, never ambient scope.
  const { projectId } = useParams<{ projectId?: string }>()
  const messages = useMemo(() => transcriptReportMessages(rows), [rows])
  useLayoutEffect(() => {
    if (!registry) return
    const cleanups: Array<() => void> = []
    const context = { runId, ...(projectId ? { projectId } : {}) }
    for (const message of messages) {
      const references = reportReferences(message.text, context)
      for (const reference of references) cleanups.push(registry.register(reference.artifactId, reference.runId))
      if (mode === 'document' && references.length > 0) cleanups.push(registry.registerOpener(message.messageKey, artifactId => {
        const buttonId = reportButtonId(message.messageKey, artifactId)
        controls.jumpToRow(message.rowKey, message.rowIndex, row => [...row.querySelectorAll<HTMLElement>('[id]')].find(element => element.id === buttonId) ?? null)
      }))
    }
    return () => { for (const cleanup of cleanups) cleanup() }
  }, [registry, messages, runId, projectId, mode, controls.jumpToRow])
}

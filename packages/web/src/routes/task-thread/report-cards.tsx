import { createContext, useContext, useLayoutEffect } from 'react'
import { Link, useLocation, useNavigate } from 'react-router'

import { useArtifactMetadata } from '@/api/queries'
import { isHtmlPath } from '@/lib/html-report'
import { reportTitle } from '@/lib/report-title'

import { TaskFileContext, taskFileHref, type TaskFileContextValue } from './file-links'
import { markdownLinks } from './markdown-links'
import { ReportCardSourcesContext } from './report-selection'

/** A modal host closes before the reader opens. */
export const ReportOpenContext = createContext<((messageKey: string) => void) | undefined>(undefined)

/** The stable row identity belongs to the transcript, including nested entry scopes. */
export const ReportMessageKeyContext = createContext<string | undefined>(undefined)

export interface ReportReference {
  runId: string
  artifactId: string
  label: string
  href: string
}

/** Only owned publication links qualify. Metadata decides whether the publication is HTML. */
export function reportReferences(text: string, context: TaskFileContextValue): ReportReference[] {
  const references = new Map<string, ReportReference>()
  for (const link of markdownLinks(text)) {
    const href = taskFileHref(link.href, context)
    if (!href) continue
    const target = new URL(href, 'https://cockpit.invalid')
    const match = /^\/p\/([^/]+)\/tasks\/([^/]+)\/report$/.exec(target.pathname)
    const flat = /^\/tasks\/([^/]+)\/report$/.exec(target.pathname)
    const artifactId = target.searchParams.get('artifact')
    if (!artifactId || (match ? decodeURIComponent(match[1]!) !== context.projectId : !flat)) continue
    const runId = decodeURIComponent(match ? match[2]! : flat![1]!)
    const key = `${runId}:${artifactId}`
    if (!references.has(key)) references.set(key, { runId, artifactId, label: link.label, href })
  }
  return [...references.values()]
}

export function reportButtonId(messageKey: string, artifactId: string): string {
  return `report-card-${encodeURIComponent(messageKey)}-${artifactId}`
}

export function ReportCards({ text, messageKey }: { text: string; messageKey?: string | undefined }) {
  const context = useContext(TaskFileContext)
  const rowKey = useContext(ReportMessageKeyContext)
  const opener = messageKey ?? rowKey
  if (!context || opener === undefined) return null
  const references = reportReferences(text, context)
  if (references.length === 0) return null
  return <div data-slot="report-cards" className="flex flex-col gap-3 [margin-block-start:1rem]">
    {references.map(reference => <ReportCard key={`${reference.runId}:${reference.artifactId}`} reference={reference} messageKey={opener} />)}
  </div>
}

function ReportCard({ reference, messageKey }: { reference: ReportReference; messageKey: string }) {
  const { artifactId, runId, label, href } = reference
  const onOpen = useContext(ReportOpenContext)
  const sources = useContext(ReportCardSourcesContext)
  useLayoutEffect(() => sources?.register(artifactId, runId), [sources, artifactId, runId])
  const metadata = useArtifactMetadata(runId, artifactId)
  const location = useLocation()
  const navigate = useNavigate()
  if (metadata.isError) return <Link id={reportButtonId(messageKey, artifactId)} data-slot="report-card-fallback" to={href} state={{ readerFrom: location.pathname + location.search }}>{label}</Link>
  const artifact = metadata.data?.artifact
  if (artifact && !isHtmlPath(artifact.name)) return null
  const query = new URLSearchParams(location.search)
  query.set('report', artifactId)
  query.set('card', messageKey)
  const prior = new URLSearchParams(location.search).has('report') ? location.state as { reportReturnTo?: string; reportReturnKey?: string; reportScrollTop?: number } | null : null
  const returning = new URLSearchParams(location.search)
  returning.delete('report')
  returning.delete('card')
  const returnTo = `${location.pathname}${returning.size ? `?${returning}` : ''}`
  const navigation = (window as { navigation?: { currentEntry?: { key?: string } } }).navigation
  const state = {
    reportCardEntry: true,
    reportReturnTo: prior?.reportReturnTo ?? returnTo,
    reportReturnKey: prior?.reportReturnKey ?? navigation?.currentEntry?.key,
    reportScrollTop: prior?.reportScrollTop,
  }
  const destination = { pathname: location.pathname, search: `?${query}`, hash: new URL(href, 'https://cockpit.invalid').hash }
  return <section data-slot="report-card" data-artifact-id={artifactId} data-report-run-id={runId} aria-busy={metadata.isPending} className="flex min-w-0 flex-col gap-2 rounded-lg border border-border bg-card p-3 text-foreground">
    <h3 className="break-words text-sm font-medium">{artifact ? reportTitle(artifact) : label}</h3>
    <p className="text-xs text-soft-foreground">HTML report</p>
    <Link id={reportButtonId(messageKey, artifactId)} to={destination} state={state}
      onClick={event => {
        if (event.button !== 0 || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return
        event.preventDefault()
        onOpen?.(messageKey)
        const reportScrollTop = state.reportScrollTop ?? document.querySelector<HTMLElement>('[data-slot="main"]')?.scrollTop
        void navigate(destination, { state: { ...state, reportScrollTop } })
      }}
      className={`inline-flex min-h-11 min-w-11 items-center self-start rounded-md border border-border px-3 text-sm active:bg-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring ${metadata.isPending ? 'text-soft-foreground' : 'text-accent-text'}`}>Read report</Link>
  </section>
}

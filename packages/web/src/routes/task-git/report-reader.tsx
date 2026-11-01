import { FileQuestionIcon, FileWarningIcon, FileXIcon } from 'lucide-react'
import { useState, type ReactNode } from 'react'
import { Navigate, useLocation, useNavigate, useParams, useSearchParams } from 'react-router'

import { ApiError, artifactUrl } from '@/api/client'
import { useArtifact, useFileLink } from '@/api/queries'
import { ArrowLeftIcon, TriangleAlertIcon } from '@/components/design-icons'
import { CenteredState } from '@/components/centered-state'
import { HtmlReportFrame } from '@/components/html-report-frame'
import { Button } from '@/components/ui/button'
import { isHtmlPath } from '@/lib/html-report'
import type { FileLinkResult, FilePreviewData } from '@open-mercato/cezar-api-client'

import { CodeLines } from './file-preview'
import { formatFileSize } from './worktree-files'

type NavigationApi = { canGoBack?: boolean; back: () => unknown }

/** Back leaves the reader in one step. `#anchor` clicks inside the frame add history entries
 *  under the reader's URL, and the page cannot see where the frame stands among them. The
 *  Navigation API walks the top page's own entries, so it skips them. Without it, Back goes to the
 *  source view the link recorded (`readerFrom`), never through history arithmetic.
 *  From the first entry of the app session, Back goes to the task's conversation. */
export function useLeaveReader(): () => void {
  const location = useLocation()
  const navigate = useNavigate()
  return () => {
    // The first entry of this app session: a bookmark, a new tab, or a cold flat link the legacy
    // redirect replaced (its key is no longer 'default', but the router's index stays 0).
    const first = location.key === 'default' || (window.history.state as { idx?: unknown } | null)?.idx === 0
    if (first) { void navigate({ pathname: location.pathname.replace(/\/report\/?$/, '') }, { replace: true }); return }
    const navigation = (window as { navigation?: NavigationApi }).navigation
    const from = readerSource(location.state)
    if (navigation?.canGoBack) void navigation.back()
    // Pushing the source creates a new entry, so it names the one it returns to (Files restores it).
    else if (from) void navigate(from, { state: { filesRestoreKey: (location.state as { filesRestoreKey?: unknown } | null)?.filesRestoreKey } })
    else void navigate(-1)
  }
}

/** The in-app path a link into the reader came from; anything else reads as none. */
function readerSource(state: unknown): string | null {
  const from = (state as { readerFrom?: unknown } | null)?.readerFrom
  return typeof from === 'string' && from.startsWith('/') && !from.startsWith('//') ? from : null
}

function previewFile(data: FilePreviewData | FileLinkResult | undefined): FilePreviewData | null {
  return data?.type === 'file' ? data : null
}

/** The URL is the one source of the selection (State restore cases, hearsay-tools/cezarion#2400). */
function useReportSelection(id: string) {
  const [query] = useSearchParams()
  const path = query.get('path')
  const artifactId = query.get('artifact')
  // An empty value selects nothing a query could load, so it reads as an invalid link.
  const conflict = query.getAll('path').length > 1 || query.getAll('artifact').length > 1 || (path !== null && artifactId !== null) || path === '' || artifactId === ''
  const live = useFileLink(id, artifactId || conflict ? null : path)
  const published = useArtifact(id, conflict ? null : artifactId)
  return { path, conflict, selected: path !== null || artifactId !== null, result: artifactId ? published : live }
}

/** `/tasks/:id/report?artifact=…|path=…` — the dedicated HTML reader (hearsay-tools/cezarion#2400).
 *  Non-HTML files go to Files with the same query. */
export function TaskReportRoute() {
  const { id = '' } = useParams<{ id: string }>()
  const { path, conflict, selected, result } = useReportSelection(id)
  const location = useLocation()
  const [source, setSource] = useState(false)
  const file = previewFile(result.data)
  // Files owns what the reader cannot render: other file types, and live files too large or binary
  // to read, which have no snapshot to download (Files says to open them in the editor).
  if (file && (!isHtmlPath(file.path) || (!file.artifact && (file.tooLarge || file.binary)))) return <Navigate replace to={{ pathname: location.pathname.replace(/\/report\/?$/, '/files'), search: location.search, hash: location.hash }} />
  const name = file ? (file.artifact?.name ?? file.path.split(/[\\/]/).at(-1) ?? file.path) : (path ?? 'Report')
  return (
    <div data-route="task-report" className="fixed inset-0 z-50 flex flex-col bg-background pt-[env(safe-area-inset-top)] pr-[env(safe-area-inset-right)] pb-[env(safe-area-inset-bottom)] pl-[env(safe-area-inset-left)] md:static md:z-auto md:h-full md:p-0">
      <ReportBar runId={id} file={file} name={name} source={source} onSource={() => setSource(value => !value)} />
      <div data-slot="report-body" className="flex min-h-0 flex-1 flex-col overflow-auto">
        <ReportBody conflict={conflict} selected={selected} result={result} source={source} name={name} fragment={location.hash} />
      </div>
    </div>
  )
}

function ReportBar({ runId, file, name, source, onSource }: { runId: string; file: FilePreviewData | null; name: string; source: boolean; onSource: () => void }) {
  const leave = useLeaveReader()
  const artifact = file?.artifact
  return (
    <header data-slot="report-bar" className="flex min-h-14 shrink-0 items-center gap-2 border-b border-border bg-card px-2 md:px-4">
      <Button variant="ghost" className="min-h-11 min-w-11 gap-1.5 px-2" onClick={leave} aria-label="Back">
        <ArrowLeftIcon size={18} aria-hidden="true" /><span className="max-sm:sr-only">Back</span>
      </Button>
      <div className="min-w-0 flex-1">
        <h1 className="truncate text-sm font-medium">{name}</h1>
        {file ? <p className="truncate text-xs text-soft-foreground">
          {artifact ? `Published snapshot · ${new Date(artifact.createdAt).toLocaleString()}` : 'Live file'} · {formatFileSize(file.size)}
        </p> : null}
      </div>
      {file && !file.tooLarge && !file.binary ? <Button variant="ghost" className="min-h-11 px-3 text-accent-text" onClick={onSource}>{source ? 'Preview' : 'Source'}</Button> : null}
      {artifact ? <a className="inline-flex min-h-11 items-center rounded-md px-3 text-sm text-accent-text underline focus-visible:ring-2" href={artifactUrl(runId, artifact.id, 'download')}>Download</a> : null}
    </header>
  )
}

function ReportBody({ conflict, selected, result, source, name, fragment }: {
  fragment: string
  conflict: boolean
  selected: boolean
  result: ReturnType<typeof useArtifact> | ReturnType<typeof useFileLink>
  source: boolean
  name: string
}): ReactNode {
  if (conflict) return <State icon={<FileXIcon />} title="Invalid report link" subtitle="Choose either a path or a published artifact." />
  if (!selected) return <State icon={<FileQuestionIcon />} title="No report selected" subtitle="Open a report from a link in the conversation or from Files." />
  if (result.isPending) return <p role="status" data-slot="report-loading" className="px-4 py-6 text-center text-sm text-soft-foreground">Loading report…</p>
  if (result.isError) {
    const missing = result.error instanceof ApiError && result.error.status === 404
    return <State icon={missing ? <FileXIcon /> : <TriangleAlertIcon size={16} />} tone={missing ? 'neutral' : 'danger'}
      title={missing ? 'Report missing or deleted' : 'Could not load this report'} subtitle={result.error.message}
      action={<Button variant="outline" className="min-h-11" onClick={() => void result.refetch()}>Retry</Button>} />
  }
  const data: FilePreviewData | { type: 'unavailable' | 'unpublished'; path: string; reason: string } = result.data!
  if (data.type !== 'file') return <State icon={<FileXIcon />} title={data.type === 'unpublished' ? 'Report not published' : 'Report unavailable'} subtitle={data.reason} />
  if (data.tooLarge) return <State icon={<FileWarningIcon />} title="Too large to preview" subtitle={`${formatFileSize(data.size)} is past the 500 kB preview limit. Download it to read it.`} />
  if (data.binary) return <State icon={<FileQuestionIcon />} title="Binary file" subtitle="This file holds binary data, not readable HTML." />
  if (source) return <div className="bg-card"><CodeLines path={data.path} text={data.content ?? ''} /></div>
  return <HtmlReportFrame html={data.content ?? ''} title={`Report: ${name}`} fragment={fragment} className="min-h-[60dvh] flex-1" />
}

function State({ icon, title, subtitle, tone = 'neutral', action }: { icon: ReactNode; title: string; subtitle: string; tone?: 'neutral' | 'danger'; action?: ReactNode }) {
  return <div data-slot="report-state" className="flex flex-col items-center gap-3 p-6">
    <CenteredState icon={icon} tone={tone} heading="h2" title={title} subtitle={subtitle} />
    {action}
  </div>
}

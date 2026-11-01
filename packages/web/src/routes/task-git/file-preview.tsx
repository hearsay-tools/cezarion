import { FileQuestionIcon, FileWarningIcon, FileXIcon } from 'lucide-react'
import { FileSearchIcon, TriangleAlertIcon } from '@/components/design-icons'
import { useEffect, useMemo, useState } from 'react'
import { useLocation, useNavigate } from 'react-router'

import { ApiError, runFileRawUrl } from '@/api/client'
import { useRunFile } from '@/api/queries'
import type { WorktreeEntry } from '@open-mercato/cezar-api-client'
import { CenteredState } from '@/components/centered-state'
import { highlight, highlightSync, langForPath, type SynToken } from '@/lib/highlighter'
import { cn } from '@/lib/utils'

import { HtmlReportFrame } from '@/components/html-report-frame'
import { isHtmlPath } from '@/lib/html-report'
import { formatFileSize, previewKind } from './worktree-files'
import { Markdown } from '../task-thread/markdown'
import { followInApp } from '../task-thread/task-link'

/**
 * The Files tab's preview pane (R5 Step 1.6). Every state is honest about WHY there is no
 * text: images render inline from the server's raw mode (image extensions only — the server
 * refuses everything else as bytes), size-capped files say "too large", binary non-images
 * say "binary", and a 409 comes back in the server's own words. Text goes through the ONE
 * Shiki singleton with `langForPath`, plaintext fallback included.
 */
export function FilePreview({ runId, path, className }: { runId: string; path: string | null; className?: string | undefined }) {
  const entry = useRunFile(runId, path ?? undefined)

  if (path === null) {
    return (
      <Pane className={className}>
        <CenteredState
          icon={<FileSearchIcon size={16} />}
          tone="neutral"
          heading="h2"
          title="Select a file"
          subtitle="Pick a file from this task’s worktree to inspect its contents."
          className="[&_[data-slot=centered-state-tile]]:size-10 [&_[data-slot=centered-state-tile]]:border-0 [&_[data-slot=centered-state-tile]]:bg-transparent [&_[data-slot=centered-state-tile]]:text-accent-text [&_[data-slot=centered-state-tile]]:shadow-none [&_h2]:text-xl"
        />
      </Pane>
    )
  }
  if (entry.isPending) {
    return (
      <Pane className={className}>
        <p data-slot="file-preview-loading" className="px-4 py-6 text-center text-xs text-soft-foreground">
          Loading {path}…
        </p>
      </Pane>
    )
  }
  if (entry.isError) {
    // A 409 is the server's answer ("symlinks are not served: …"), not an outage.
    const refused = entry.error instanceof ApiError && entry.error.status === 409
    return (
      <Pane className={className}>
        <CenteredState
          icon={refused ? <FileXIcon /> : <TriangleAlertIcon size={16} />}
          tone={refused ? 'neutral' : 'danger'}
          heading="h2"
          title={refused ? 'Cannot preview this file' : 'Could not load this file'}
          subtitle={entry.error.message}
        />
      </Pane>
    )
  }
  if (entry.data.type !== 'file') {
    // An exact-path entry (or a stale file selection) can resolve to a directory.
    return (
      <Pane className={className}>
        <CenteredState
          icon={<FileQuestionIcon />}
          tone="neutral"
          heading="h2"
          title="Choose a file inside this directory"
          subtitle="Expand the folder in the tree, or enter the full path to a file."
        />
      </Pane>
    )
  }
  return <FileEntryView runId={runId} entry={entry.data} className={className} />
}

export function FileEntryView({
  runId,
  entry,
  className,
  imageUrl,
  downloadUrl,
  snapshot,
  readerHref,
  documentPreview = false,
}: {
  runId: string
  entry: Extract<WorktreeEntry, { type: 'file' }>
  className?: string | undefined
  imageUrl?: string
  downloadUrl?: string
  snapshot?: string
  /** Where "Open reader" goes for an HTML file (hearsay-tools/cezarion#2400). */
  readerHref?: string | undefined
  documentPreview?: boolean
}) {
  const [source, setSource] = useState(false)
  const markdown = documentPreview && /\.(?:md|markdown)$/i.test(entry.path)
  const html = documentPreview && isHtmlPath(entry.path)
  const safeImage = /\.(?:png|jpe?g|gif|webp|bmp|ico|avif)$/i.test(entry.path)
  const kind = documentPreview && safeImage && entry.size <= 10 * 1024 * 1024 ? 'image' : previewKind(entry)
  // Only readable text has a rendered view to toggle: too-large and binary files show their state.
  const toggle = (markdown || html) && kind === 'text'
  return (
    <Pane className={className}>
      <header
        data-slot="file-preview-head"
        className="flex items-center gap-2 border-b border-border bg-muted/40 px-4 py-2 text-xs"
      >
        <span className="min-w-0 truncate font-mono font-medium">{entry.path}</span>
        <span className="ml-auto shrink-0 tabular-nums text-soft-foreground">{formatFileSize(entry.size)}</span>
      </header>
      {snapshot || downloadUrl || toggle ? <PreviewActions snapshot={snapshot} downloadUrl={downloadUrl} source={toggle ? source : null}
        onSource={() => setSource(value => !value)} readerHref={html && kind === 'text' ? readerHref : undefined} /> : null}
      <EntryBody runId={runId} entry={entry} kind={kind} showImage={kind === 'image' && (!documentPreview || safeImage)}
        rendered={source ? null : markdown ? 'markdown' : html ? 'html' : null} imageUrl={imageUrl} />
    </Pane>
  )
}

function EntryBody({ runId, entry, kind, showImage, rendered, imageUrl }: {
  runId: string
  entry: Extract<WorktreeEntry, { type: 'file' }>
  kind: ReturnType<typeof previewKind>
  showImage: boolean
  rendered: 'markdown' | 'html' | null
  imageUrl?: string | undefined
}) {
  if (showImage) return (
    <div className="flex justify-center p-4">
      {/* Raw bytes from the same origin the JSON came from — no auth story to get wrong. */}
      <img data-slot="file-preview-image" src={imageUrl ?? runFileRawUrl(runId, entry.path)} alt={entry.path} className="max-h-[70vh] max-w-full rounded-sm" />
    </div>
  )
  if (kind === 'too-large') return <CenteredState icon={<FileWarningIcon />} tone="neutral" heading="h2" title="Too large to preview"
    subtitle={`${formatFileSize(entry.size)} — past the preview cap. Open it in your editor instead.`} />
  if (kind === 'binary') return <CenteredState icon={<FileQuestionIcon />} tone="neutral" heading="h2" title="Binary file"
    subtitle={`${formatFileSize(entry.size)} of binary data — no text preview.`} />
  if (rendered === 'markdown') return <div className="p-4"><Markdown document>{entry.content ?? ''}</Markdown></div>
  if (rendered === 'html') return <HtmlReportFrame html={entry.content ?? ''} title={`Report: ${entry.path}`} className="h-[70vh]" />
  return <CodeLines path={entry.path} text={entry.content ?? ''} />
}

function PreviewActions({ snapshot, downloadUrl, source, onSource, readerHref }: {
  snapshot?: string | undefined
  downloadUrl?: string | undefined
  /** null: the file has no rendered view to toggle. */
  source: boolean | null
  onSource: () => void
  readerHref?: string | undefined
}) {
  return <div className="flex flex-wrap items-center gap-3 border-b border-border px-4 py-2 text-xs">
    {snapshot ? <span>Published snapshot · {snapshot}</span> : null}
    {downloadUrl ? <a className="inline-flex min-h-11 items-center text-accent-text underline" href={downloadUrl}>Download</a> : null}
    {source !== null ? <button className="min-h-11 rounded px-2 text-accent-text underline focus-visible:ring-2" onClick={onSource}>{source ? 'Preview' : 'View source'}</button> : null}
    {readerHref ? <ReaderLink href={readerHref} /> : null}
  </div>
}

function ReaderLink({ href }: { href: string }) {
  const navigate = useNavigate()
  const location = useLocation()
  return <a className="inline-flex min-h-11 items-center px-2 text-accent-text underline focus-visible:ring-2" href={href}
    onClick={event => followInApp(event, navigate, href, location)}>Open reader</a>
}

/** The preview card — same bordered grammar as the diff facade's file cards. */
function Pane({ className, children }: { className?: string | undefined; children: React.ReactNode }) {
  return (
    <section data-slot="file-preview" className={cn('flex flex-col overflow-hidden rounded-lg border border-border bg-card', className)}>
      {children}
    </section>
  )
}

/** Past this many lines highlighting is skipped — plaintext beats jank (diff-view.tsx's cap). */
const HIGHLIGHT_MAX_LINES = 1500

/** Tokens for the whole file through the shared singleton: sync when the grammar is resident,
 *  async load once when not, plaintext for unknown/oversized files. Same shape as the diff
 *  facade's useFileTokens — this one owns whole files instead of patch lines. */
function useFileTokens(path: string, text: string): SynToken[][] {
  const plain = useMemo(() => text.split('\n').map((line) => [{ content: line }]), [text])
  const lang = useMemo(() => langForPath(path), [path])
  const oversized = plain.length > HIGHLIGHT_MAX_LINES
  const [loaded, setLoaded] = useState<{ key: string; tokens: SynToken[][] } | null>(null)

  useEffect(() => {
    if (lang === null || oversized) return
    let cancelled = false
    void highlight(text, lang).then((result) => {
      if (!cancelled) setLoaded({ key: `${path}\0${text}`, tokens: result.tokens })
    })
    return () => {
      cancelled = true
    }
  }, [path, text, lang, oversized])

  if (lang === null || oversized) return plain
  if (loaded?.key === `${path}\0${text}`) return loaded.tokens
  return highlightSync(text, lang)?.tokens ?? plain
}

export function CodeLines({ path, text }: { path: string; text: string }) {
  const tokens = useFileTokens(path, text)
  return (
    <div
      data-slot="file-preview-code"
      data-lang={langForPath(path) ?? 'plaintext'}
      className="overflow-x-auto py-2 font-mono text-xs leading-[1.7]"
    >
      {tokens.map((line, index) => (
        <div key={index} className="flex px-4">
          <span className="w-10 shrink-0 select-none pr-3 text-right tabular-nums text-soft-foreground">
            {index + 1}
          </span>
          <span className="min-w-0 flex-1 whitespace-pre pr-4">
            {line.map((token, tokenIndex) => (
              <span
                key={tokenIndex}
                style={token.color !== undefined ? { color: token.color } : undefined}
              >
                {token.content}
              </span>
            ))}
          </span>
        </div>
      ))}
    </div>
  )
}

import { useEffect, useMemo, useState, type SyntheticEvent } from 'react'
import { prepareReport, REPORT_ALLOW, REPORT_SANDBOX, wrapReport, type BlockedContent } from '@/lib/html-report'
import { findLibraries, loadLibraries, type ReportLibraries } from '@/lib/report-libraries'
import { cn } from '@/lib/utils'

const LABELS: [keyof BlockedContent, string, string][] = [
  ['scripts', 'remote script', 'remote scripts'],
  ['remote', 'remote resource', 'remote resources'],
  ['relative', 'linked file next to the report', 'linked files next to the report'],
  ['forms', 'form', 'forms'],
  ['embeds', 'embedded frame or object', 'embedded frames or objects'],
]

export function blockedSummary(blocked: BlockedContent): string | null {
  const parts = LABELS.filter(([key]) => blocked[key] > 0).map(([key, one, many]) => `${blocked[key]} ${blocked[key] === 1 ? one : many}`)
  return parts.length ? parts.join(', ') : null
}

const NO_LIBRARIES: ReportLibraries = {}

/** The pinned library code a report names, or null while it loads. A report that names none is ready at once. */
function useReportLibraries(html: string): ReportLibraries | null {
  const ids = useMemo(() => findLibraries(html), [html])
  const key = ids.join(' ')
  const [loaded, setLoaded] = useState<{ key: string; libraries: ReportLibraries } | null>(null)
  useEffect(() => {
    if (!key) return
    let live = true
    void loadLibraries(key.split(' ') as typeof ids).then(libraries => { if (live) setLoaded({ key, libraries }) })
    return () => { live = false }
  }, [key])
  if (!key) return NO_LIBRARIES
  return loaded?.key === key ? loaded.libraries : null
}

/**
 * A self-contained HTML report in an opaque-origin sandbox (hearsay-tools/cezarion#2400,
 * hearsay-tools/cezarion#2716): its inline scripts run, but no request leaves the frame and it cannot
 * reach the cockpit's APIs, cookies, storage, DOM or top-level navigation. Only a click opens a
 * new tab. The report frame sits inside a wrapper frame that refuses its navigations.
 */
export function HtmlReportFrame({ html, title, fragment, className }: {
  html: string
  title: string
  /** A route `#fragment` the report opens at, e.g. from a `report.html#results` link. */
  fragment?: string | undefined
  className?: string | undefined
}) {
  const libraries = useReportLibraries(html)
  return libraries ? <ReportFrame html={html} title={title} fragment={fragment} className={className} libraries={libraries} /> : <div data-slot="html-report" aria-busy="true" className={cn('flex min-h-0 flex-col', className)} />
}

function ReportFrame({ html, title, fragment, className, libraries }: {
  html: string
  title: string
  fragment?: string | undefined
  className?: string | undefined
  libraries: ReportLibraries
}) {
  const { srcdoc, blocked } = useMemo(() => {
    const prepared = prepareReport(html, libraries)
    return { srcdoc: wrapReport(prepared.srcdoc, title), blocked: prepared.blocked }
  }, [html, libraries, title])
  // The cockpit moves the report to the route fragment: a fragment navigation of the report
  // frame's own `about:srcdoc` document scrolls it in place, with no reload and, by `replace`, no
  // history entry. The target URL is always `about:srcdoc`, so this cannot send the frame anywhere
  // else. The wrapper's load event waits for the report frame, its only child.
  const openAtFragment = (event: SyntheticEvent<HTMLIFrameElement>) => {
    if (fragment && /^#\S+$/.test(fragment)) event.currentTarget.contentWindow?.frames[0]?.location.replace(`about:srcdoc${fragment}`)
  }
  const summary = blockedSummary(blocked)
  return (
    <div data-slot="html-report" className={cn('flex min-h-0 flex-col', className)}>
      {summary ? (
        <p data-slot="html-report-blocked" role="note" className="border-b border-border bg-muted/40 px-4 py-2 text-xs text-foreground">
          Blocked for your safety: {summary}. Reports show only what they carry inside the file.
        </p>
      ) : null}
      <iframe
        data-slot="html-report-frame"
        title={title}
        sandbox={REPORT_SANDBOX}
        allow={REPORT_ALLOW}
        srcDoc={srcdoc}
        referrerPolicy="no-referrer"
        onLoad={openAtFragment}
        className="block min-h-0 w-full flex-1 border-0 bg-report-canvas"
      />
    </div>
  )
}

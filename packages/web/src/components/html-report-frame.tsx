import { useMemo } from 'react'
import { prepareReport, REPORT_SANDBOX, type BlockedContent } from '@/lib/html-report'
import { cn } from '@/lib/utils'

const LABELS: [keyof BlockedContent, string, string][] = [
  ['scripts', 'script', 'scripts'],
  ['remote', 'remote resource', 'remote resources'],
  ['relative', 'linked file next to the report', 'linked files next to the report'],
  ['forms', 'form', 'forms'],
  ['embeds', 'embedded frame or object', 'embedded frames or objects'],
]

export function blockedSummary(blocked: BlockedContent): string | null {
  const parts = LABELS.filter(([key]) => blocked[key] > 0).map(([key, one, many]) => `${blocked[key]} ${blocked[key] === 1 ? one : many}`)
  return parts.length ? parts.join(', ') : null
}

/**
 * A self-contained HTML report in an opaque-origin sandbox (hearsay-tools/cezarion#2400): no
 * script runs, no request leaves the frame, and it cannot reach the cockpit's APIs, cookies,
 * storage, DOM or top-level navigation. Only a clicked web or mail link opens a new tab.
 */
export function HtmlReportFrame({ html, title, className }: { html: string; title: string; className?: string | undefined }) {
  const { srcdoc, blocked } = useMemo(() => prepareReport(html), [html])
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
        srcDoc={srcdoc}
        referrerPolicy="no-referrer"
        className="block min-h-0 w-full flex-1 border-0 bg-report-canvas"
      />
    </div>
  )
}

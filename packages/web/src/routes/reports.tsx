import { productCommand } from '@/lib/product-name'
import { useLayoutEffect, useRef } from 'react'
import { useLocation, useNavigationType } from 'react-router'
import { useReports } from '@/api/reports'
import { REPORTS_QUERY_MAX } from '@open-mercato/cezar-api-client/contract/reports'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Link } from '@/lib/project-router'
import { reportTitle } from '@/lib/report-title'
import { useSearchParamsWriter } from '@/lib/use-search-params-writer'
import './reports.css'

// Keep the source entry through both native Back and the reader's fallback navigation.
const positions = new Map<string, { scroll: number; row: string; pages: number }>()

export function ReportsRoute() {
  const location = useLocation()
  const navigationType = useNavigationType()
  const [params, write] = useSearchParamsWriter()
  const q = (params.get('q') ?? '').slice(0, REPORTS_QUERY_MAX)
  const result = useReports(q)
  const scroller = useRef<HTMLDivElement>(null)
  const restored = useRef('')
  const key = location.pathname + location.search
  const reports = result.data?.pages.flatMap(page => page.reports) ?? []
  useLayoutEffect(() => {
    if (!result.data || restored.current === key) return
    const saved = positions.get(key)
    const fallback = (location.state as { filesRestoreKey?: unknown } | null)?.filesRestoreKey === key
    if (!saved || !scroller.current || (navigationType !== 'POP' && !fallback)) { restored.current = key; return }
    const row = scroller.current.querySelector<HTMLAnchorElement>(`[data-report-id="${saved.row}"]`)
    if (result.isFetchNextPageError) {
      restored.current = key
      scroller.current.scrollTop = 0
      return
    }
    if ((!row || result.data.pages.length < saved.pages) && result.hasNextPage) {
      if (!result.isFetchingNextPage) void result.fetchNextPage()
      return
    }
    restored.current = key
    scroller.current.scrollTop = row ? saved.scroll : 0
    row?.focus({ preventScroll: true })
  }, [key, result.data, result.hasNextPage, result.isFetchingNextPage, result.isFetchNextPageError, result.fetchNextPage, location.state, navigationType])

  const search = (value: string) => write(current => {
    if (value) current.set('q', value.slice(0, REPORTS_QUERY_MAX))
    else current.delete('q')
    positions.delete(location.pathname + '?' + current.toString())
    return current
  })
  return <section data-route="reports" className="flex h-full min-h-0 flex-col">
    <header className="flex shrink-0 flex-col gap-3 border-b border-border p-4">
      <h1 className="text-lg font-semibold">Reports</h1>
      <Input maxLength={REPORTS_QUERY_MAX} aria-label="Search reports" placeholder="Search reports or source tasks" value={q} onChange={event => search(event.target.value)} className="min-h-11" />
    </header>
    <div ref={scroller} data-slot="reports-list" className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-4 [scrollbar-gutter:stable]">
      {result.isPending ? <p role="status">Loading reports…</p> : result.isError ? <div role="alert" className="flex flex-col items-start gap-3">
        <p>Could not load reports</p><p className="text-sm text-soft-foreground">{result.error.message}</p>
        <Button className="min-h-11" onClick={() => void result.refetch()}>Retry</Button>
      </div> : reports.length === 0 ? <div className="flex flex-col items-start gap-3">
        <h2 className="font-medium">{q ? 'No matching reports' : 'No published reports yet'}</h2>
        {q ? <Button data-slot="reports-clear-search" variant="outline" className="min-h-11" onClick={() => search('')}>Clear search</Button> : <p className="text-sm text-soft-foreground">Publish an HTML snapshot with <code>{productCommand()} artifact publish</code> to list it here.</p>}
      </div> : <ul className="flex flex-col gap-3">
        {reports.map(report => <li key={report.id} data-slot="report-row" className="reports-row rounded-lg border border-border bg-card p-3">
          <h2 className="min-w-0 font-medium [overflow-wrap:anywhere]"><Link data-report-id={report.id} className="reports-open" to={`/tasks/${report.runId}/report?artifact=${report.id}`} state={{ readerFrom: key, filesRestoreKey: key }}
            onClick={() => positions.set(key, { scroll: scroller.current?.scrollTop ?? 0, row: report.id, pages: result.data?.pages.length ?? 1 })}>{reportTitle(report)}</Link></h2>
          <Link className="reports-task text-sm text-accent-text underline [overflow-wrap:anywhere]" to={`/tasks/${report.runId}`}>{report.taskTitle}</Link>
          <time className="block text-xs text-soft-foreground" dateTime={report.createdAt}>{new Date(report.createdAt).toLocaleString()}</time>
        </li>)}
      </ul>}
      {result.hasNextPage ? <Button variant="outline" className="min-h-11" disabled={result.isFetchingNextPage} onClick={() => void result.fetchNextPage()}>Load more reports</Button> : null}
    </div>
  </section>
}

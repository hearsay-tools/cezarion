import { onLiveReconcile } from '@/api/live-coordinator'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { automationEventSchema, automationLogResultSchema, type AutomationLogRecord, type AutomationLogResult } from '@open-mercato/cezar-api-client'

import { retryAutomationReceipt, getAutomationLog } from '@/api/client'
import { onWorkspaceEvent } from '@/api/global-events'
import { Pill } from '@/components/pill'
import type { StatusDotTone } from '@/components/status-dot'
import { Button } from '@/components/ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { logTime } from '@/lib/automation-format'
import { Link } from '@/lib/project-router'
import { PageFrame, PageState } from './page-frame'

const TONE: Record<AutomationLogResult, StatusDotTone> = {
  launched: 'success',
  manual: 'success',
  'catch-up': 'success',
  skipped: 'neutral',
  'no-match': 'neutral',
  preview: 'neutral',
  baseline: 'neutral',
  duplicate: 'neutral',
  failed: 'danger',
  error: 'danger',
  'rate-limited': 'danger',
}

const RESULT_LABEL: Record<AutomationLogResult, string> = {
  launched: 'Launched',
  manual: 'Manual',
  'catch-up': 'Catch up',
  skipped: 'Skipped',
  'no-match': 'No match',
  preview: 'Preview',
  baseline: 'Baseline',
  duplicate: 'Duplicate',
  failed: 'Failed',
  error: 'Error',
  'rate-limited': 'Rate limited',
}

/** One automation's log, newest first, kept fresh by the workspace `automation-change` signal. */
function useAutomationLog(automationId: string) {
  const [records, setRecords] = useState<AutomationLogRecord[]>()
  const [error, setError] = useState('')
  const refresh = useCallback(
    (signal?: AbortSignal) => getAutomationLog(automationId, { signal }).then(({ records: next }) => { if (signal?.aborted) return; setRecords(next); setError('') }).catch((cause) => { if (!signal?.aborted) setError(String(cause)) }),
    [automationId],
  )
  useEffect(() => { void refresh() }, [refresh])
  useEffect(() => onLiveReconcile(refresh), [refresh])
  useEffect(() => onWorkspaceEvent((name, payload) => {
    if (name === 'automation-change' && (payload as { automationId?: unknown }).automationId === automationId) void refresh()
  }), [automationId, refresh])
  return { records, error, refresh }
}

/** A task that failed to START leaves a `failed`/`error` row carrying its receipt and no run. A
 *  later row for the same receipt that has a run means a retry already went through, and only the
 *  newest row of a receipt offers the button: a retry that failed again adds a second row. */
function retryable(record: AutomationLogRecord, all: readonly AutomationLogRecord[]): boolean {
  if ((record.result !== 'failed' && record.result !== 'error') || !record.receiptId || record.runId) return false
  return !all.some((other) => other.receiptId === record.receiptId && (other.runId || other.seq > record.seq))
}

function LogRows({ records, all, timeZone, onRetried }: { records: readonly AutomationLogRecord[]; all: readonly AutomationLogRecord[]; timeZone: string; onRetried: () => void }) {
  const [retrying, setRetrying] = useState<string>()
  const [failure, setFailure] = useState<{ receiptId: string; message: string }>()
  const now = Date.now()
  const retry = async (receiptId: string) => {
    setRetrying(receiptId)
    setFailure(undefined)
    try { await retryAutomationReceipt(receiptId); onRetried() } catch (cause) { setFailure({ receiptId, message: cause instanceof Error ? cause.message : String(cause) }) } finally { setRetrying(undefined) }
  }
  return (
    <ol className="grid gap-3" aria-label="Automation execution log">
      {records.map((record) => (
        <li key={record.seq} className="min-w-0 rounded-xl border bg-card p-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <Pill dot={TONE[record.result]}>{RESULT_LABEL[record.result]}</Pill>
            <time className="text-xs text-muted-foreground" dateTime={record.ts} title={record.ts}>{logTime(record.ts, timeZone, now)}</time>
          </div>
          {record.reason ? <p className="mt-2 text-sm break-words text-muted-foreground">{record.reason}</p> : null}
          {record.githubUrl || record.runId || retryable(record, all) ? (
            <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2 text-sm">
              {record.githubUrl ? <a className="inline-flex min-h-11 items-center underline underline-offset-4 break-all" href={record.githubUrl} target="_blank" rel="noreferrer">{record.githubTitle ?? `GitHub #${record.githubNumber ?? ''}`}</a> : null}
              {record.runId ? <Link className="inline-flex min-h-11 items-center underline underline-offset-4" to={`/tasks/${record.runId}`}>Open task</Link> : null}
              {retryable(record, all) ? <Button variant="outline" disabled={retrying === record.receiptId} onClick={() => void retry(record.receiptId!)}>Retry task</Button> : null}
            </div>
          ) : null}
          {failure && failure.receiptId === record.receiptId ? <p role="alert" className="mt-2 text-sm break-words text-destructive">{failure.message}</p> : null}
        </li>
      ))}
    </ol>
  )
}

const ALL = 'all'

function FilterSelect({ label, value, onChange, options }: { label: string; value: string; onChange: (next: string) => void; options: readonly { value: string; label: string }[] }) {
  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger aria-label={label} className="w-full sm:w-52"><SelectValue /></SelectTrigger>
      <SelectContent>
        {options.map((option) => <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>)}
      </SelectContent>
    </Select>
  )
}

/** `/automations/:id/log` — the whole log with result and event filters. */
export function AutomationLogScreen({ automationId, automationName, timeZone }: { automationId: string; automationName?: string | undefined; timeZone: string }) {
  const { records, error, refresh } = useAutomationLog(automationId)
  const [result, setResult] = useState(ALL)
  const [event, setEvent] = useState(ALL)
  const visible = useMemo(
    () => (records ?? []).filter((record) => (result === ALL || record.result === result) && (event === ALL || record.event === event)),
    [records, result, event],
  )
  const hasEvents = (records ?? []).some((record) => record.event)
  return (
    <PageFrame title="Execution log" subtitle={automationName ?? 'Automation activity'} action={<Button variant="outline" asChild><Link to="/automations">Back to automations</Link></Button>}>
      {error && !records ? (
        <div className="grid justify-items-start gap-3"><PageState text={error} /><Button variant="outline" onClick={() => void refresh()}>Retry</Button></div>
      ) : !records ? <PageState text="Loading execution log…" /> : records.length === 0 ? <PageState text="Nothing has run yet." /> : (
        <div className="grid gap-4">
          <div className="flex flex-wrap gap-2">
            <FilterSelect label="Result" value={result} onChange={setResult} options={[{ value: ALL, label: 'All results' }, ...automationLogResultSchema.options.map((value) => ({ value, label: RESULT_LABEL[value] }))]} />
            {hasEvents ? <FilterSelect label="Event" value={event} onChange={setEvent} options={[{ value: ALL, label: 'All events' }, ...automationEventSchema.options.map((value) => ({ value, label: value }))]} /> : null}
          </div>
          {visible.length === 0
            ? <PageState text="No rows match these filters." />
            : <LogRows records={visible} all={records} timeZone={timeZone} onRetried={() => void refresh()} />}
        </div>
      )}
    </PageFrame>
  )
}

/** The five latest rows, for the list card. */
export function InlineLog({ automationId, automationName, timeZone, showName = false }: { automationId: string; automationName?: string; timeZone: string; showName?: boolean }) {
  const { records, error, refresh } = useAutomationLog(automationId)
  return (
    <section data-slot="automation-inline-log" className="mt-4 min-w-0 border-t pt-4">
      <h3 className="mb-3 text-sm font-medium">Recent activity{showName && automationName ? ` · ${automationName}` : ''}</h3>
      {error && !records ? (
        <div className="grid justify-items-start gap-2"><PageState text={error} /><Button variant="outline" onClick={() => void refresh()}>Retry</Button></div>
      ) : !records ? <p className="text-sm text-muted-foreground">Loading activity…</p> : records.length === 0 ? <p className="text-sm text-muted-foreground">Nothing has run yet.</p> : (
        <LogRows records={records.slice(0, 5)} all={records} timeZone={timeZone} onRetried={() => void refresh()} />
      )}
    </section>
  )
}

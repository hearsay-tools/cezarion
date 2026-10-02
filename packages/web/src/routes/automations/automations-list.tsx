import { useState } from 'react'
import { scheduleLabel, type AutomationListEntry, type AutomationsResponse } from '@open-mercato/cezar-api-client'

import { checkAutomation, getAutomationCheck, runAutomationNow, setAutomationEnabled } from '@/api/client'
import { CenteredState } from '@/components/centered-state'
import { GithubIcon, RefreshCwIcon, ZapIcon } from '@/components/design-icons'
import { Pill } from '@/components/pill'
import { Button } from '@/components/ui/button'
import { dayTime, relativeIn } from '@/lib/automation-format'
import { Link } from '@/lib/project-router'
import { cn } from '@/lib/utils'
import { PageFrame, PageState } from './page-frame'

/** What a card says under its actions: a progress word, a result, or a refusal. */
type Note = { text: string; tone: 'info' | 'error'; runId?: string }

export function AutomationsList({ data, error, refresh }: { data: AutomationsResponse | undefined; error: string; refresh: () => Promise<void> }) {
  const [notes, setNotes] = useState<Record<string, Note>>({})
  const [busy, setBusy] = useState<Record<string, boolean>>({})
  const note = (id: string, next: Note | undefined) =>
    setNotes((current) => {
      const { [id]: _dropped, ...rest } = current
      return next ? { ...rest, [id]: next } : rest
    })
  const guard = async (id: string, work: () => Promise<void>) => {
    setBusy((current) => ({ ...current, [id]: true }))
    try { await work() } catch (cause) { note(id, { text: cause instanceof Error ? cause.message : String(cause), tone: 'error' }) } finally { setBusy((current) => ({ ...current, [id]: false })) }
  }

  const runNow = (automation: AutomationListEntry) => guard(automation.id, async () => {
    note(automation.id, { text: 'Starting…', tone: 'info' })
    const { runId } = await runAutomationNow(automation.id)
    note(automation.id, { text: 'Started task', tone: 'info', runId })
    void refresh()
  })
  const toggle = (automation: AutomationListEntry) => guard(automation.id, async () => {
    note(automation.id, undefined)
    await setAutomationEnabled(automation.id, !automation.enabled)
    await refresh()
  })
  const preview = (automation: AutomationListEntry) => guard(automation.id, async () => {
    note(automation.id, { text: 'Checking…', tone: 'info' })
    const { checkId } = await checkAutomation(automation.id, 'preview')
    for (let attempt = 0; attempt < 60; attempt += 1) {
      const check = await getAutomationCheck(checkId)
      if (check.status === 'complete') {
        note(automation.id, { text: `${check.matches ?? 0} match${check.matches === 1 ? '' : 'es'} found; no tasks launched.`, tone: 'info' })
        void refresh()
        return
      }
      if (check.status === 'error') throw new Error(check.error ?? 'Preview failed')
      await new Promise((resolve) => setTimeout(resolve, 500))
    }
    throw new Error('Preview is still running')
  })

  return (
    <PageFrame
      title="Automations"
      subtitle="Schedules and GitHub checks run while Cezarion is open."
      action={<Button asChild><Link to="/automations/new">New automation</Link></Button>}
    >
      {error && !data ? (
        <div className="grid justify-items-start gap-3"><PageState text={error} /><Button variant="outline" onClick={() => void refresh()}>Retry</Button></div>
      ) : !data ? <PageState text="Loading automations…" /> : (
        <>
          <SchedulerStatus data={data} />
          {data.automations.length === 0 ? (
            <CenteredState
              icon={<ZapIcon />}
              tone="neutral"
              title="No automations yet"
              subtitle="Create one paused, preview it, then enable it."
              heading="h2"
              actions={<Button asChild><Link to="/automations/new">New automation</Link></Button>}
            />
          ) : (
            <ul className="grid gap-3" aria-label="Automations">
              {data.automations.map((automation) => (
                <AutomationCard
                  key={automation.id}
                  automation={automation}
                  timeZone={data.timeZone}
                  note={notes[automation.id]}
                  busy={busy[automation.id] === true}
                  onRun={() => void runNow(automation)}
                  onToggle={() => void toggle(automation)}
                  onPreview={() => void preview(automation)}
                />
              ))}
            </ul>
          )}
        </>
      )}
    </PageFrame>
  )
}

function SchedulerStatus({ data }: { data: AutomationsResponse }) {
  const tone = data.scheduler.state === 'scheduled' ? 'text-success' : 'text-muted-foreground'
  return (
    <p data-slot="automation-scheduler" className={cn('mb-4 text-xs break-words', tone)}>
      {`Scheduler ${data.scheduler.state === 'scheduled' ? 'running' : 'idle'} · GitHub ${data.available ? 'available' : 'unavailable'}${data.reason ? ` · ${data.reason}` : ''} · ${data.timeZone}`}
    </p>
  )
}

/** `scheduleLabel` for a schedule; the event list and poll interval for a GitHub check. */
function triggerLabel(automation: AutomationListEntry): string {
  if (automation.kind === 'schedule' && automation.schedule) return scheduleLabel(automation.schedule)
  return `on ${(automation.events ?? []).join(', ')} · every ${Math.round((automation.intervalSeconds ?? 300) / 60)} min`
}

function AutomationCard({ automation, timeZone, note, busy, onRun, onToggle, onPreview }: {
  automation: AutomationListEntry
  timeZone: string
  note?: Note
  busy: boolean
  onRun: () => void
  onToggle: () => void
  onPreview: () => void
}) {
  const isSchedule = automation.kind === 'schedule'
  const KindIcon = isSchedule ? RefreshCwIcon : GithubIcon
  const nextAt = automation.enabled && isSchedule ? automation.nextRunAt : undefined
  return (
    <li data-slot="automation-card" data-kind={automation.kind} className="min-w-0 rounded-xl border bg-card p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="flex items-center gap-2 font-semibold break-words"><KindIcon aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />{automation.name}</h2>
          <p className="mt-1.5 text-[13px] break-words text-muted-foreground">{triggerLabel(automation)}</p>
        </div>
        <Pill dot={automation.enabled ? 'success' : 'neutral'}>{automation.enabled ? 'Enabled' : 'Paused'}</Pill>
      </div>
      <p className="mt-3 text-sm">
        {!isSchedule && automation.enabled ? <span>continuous</span> : nextAt ? (
          <>
            <span>{`Next run: ${dayTime(nextAt, timeZone)}`}</span>
            <span className="text-muted-foreground">{` · ${relativeIn(Date.now(), Date.parse(nextAt))}`}</span>
          </>
        ) : <span>Next run: —</span>}
      </p>
      {automation.latestLog ? (
        <p className="mt-1.5 text-[13px] break-words text-muted-foreground">
          <span className="capitalize">{automation.latestLog.result.replace('-', ' ')}</span>
          {automation.latestLog.reason ? <> · <span>{automation.latestLog.reason}</span></> : null}
        </p>
      ) : null}
      <div className="mt-4 flex flex-wrap gap-2">
        <Button variant="outline" asChild><Link to={`/automations/${automation.id}`}>Edit</Link></Button>
        <Button variant="outline" asChild><Link to={`/automations/${automation.id}/log`}>Execution log</Link></Button>
        <Button variant="outline" disabled={busy} onClick={onToggle}>{automation.enabled ? 'Pause' : 'Enable'}</Button>
        {isSchedule
          ? <Button variant="outline" disabled={busy} onClick={onRun}>Run now</Button>
          : <Button variant="outline" disabled={busy} onClick={onPreview}>Test filter</Button>}
      </div>
      {note ? (
        <p role={note.tone === 'error' ? 'alert' : 'status'} className={cn('mt-3 text-sm break-words', note.tone === 'error' ? 'text-destructive' : 'text-muted-foreground')}>
          {note.text}
          {note.runId ? <> · <Link className="underline underline-offset-4" to={`/tasks/${note.runId}`}>Open task</Link></> : null}
        </p>
      ) : null}
    </li>
  )
}

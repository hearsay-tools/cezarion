import { useEffect, useRef, useState } from 'react'
import type { AutomationListEntry } from '@open-mercato/cezar-api-client'

import { deleteAutomation } from '@/api/client'
import { Button } from '@/components/ui/button'
import { dayTime, onceResolved } from '@/lib/automation-format'
import { Link } from '@/lib/project-router'
import { InlineLog } from './log'
import { PageFrame } from './page-frame'

/**
 * An archived one-time schedule (hearsay-tools/cezarion#1465): a record, not a form. It shows what
 * happened, the task it started, what that task ran with and its log. Delete is the one action an
 * archived schedule takes. The link the CLI and the agent tools print lands here, through the
 * route's edit mode.
 */
export function ArchivedAutomation({ automation, timeZone, onDeleted }: { automation: AutomationListEntry; timeZone: string; onDeleted: () => void }) {
  const archive = automation.archived!
  const schedule = automation.schedule
  const due = schedule ? onceResolved(schedule) : null
  const [confirming, setConfirming] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [error, setError] = useState('')
  // Delete and its confirm replace each other, so focus follows, as on the list's Cancel.
  const deleteRef = useRef<HTMLButtonElement>(null)
  const keepRef = useRef<HTMLButtonElement>(null)
  const focusAfter = useRef<'keep' | 'delete' | null>(null)
  useEffect(() => {
    const target = focusAfter.current === 'keep' ? keepRef.current : focusAfter.current === 'delete' ? deleteRef.current : null
    focusAfter.current = null
    target?.focus()
  }, [confirming])

  const remove = async () => {
    setDeleting(true)
    try {
      await deleteAutomation(automation.id)
      onDeleted()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
      setDeleting(false)
    }
  }

  const inputs: [string, string | undefined][] = [
    ['Workflow', automation.task.workflow],
    ['Runner', automation.task.runner],
    ['Model', automation.task.model],
    ['Effort', automation.task.effort],
  ]
  return (
    <PageFrame title={automation.name} subtitle="Archived one-time schedule. It cannot change; delete it when you no longer need the record.">
      <div className="grid min-w-0 max-w-3xl gap-5">
        <section className="min-w-0 rounded-xl border bg-card p-4">
          <p className="text-sm break-words">
            <span>{archive.outcome === 'launched' ? 'Started its task.' : 'Cancelled — no task was started.'}</span>
            {archive.runId ? <> · <Link className="inline-flex min-h-11 items-center underline underline-offset-4" to={`/tasks/${archive.runId}`}>Open task</Link></> : null}
          </p>
          <p className="mt-1 text-sm text-muted-foreground">{`Archived ${dayTime(archive.at, timeZone)} (${timeZone}).`}</p>
          {due && schedule?.timeZone ? <p className="mt-1 text-sm text-muted-foreground">{`Was due ${due.date} ${due.time} (${schedule.timeZone}).`}</p> : null}
        </section>
        <section aria-labelledby="archived-inputs" className="min-w-0 rounded-xl border bg-card p-4">
          <h2 id="archived-inputs" className="mb-3 text-[15px] font-medium">What it ran with</h2>
          <dl className="grid gap-3 text-sm">
            <div className="grid gap-1">
              <dt className="text-muted-foreground">Prompt</dt>
              <dd className="break-words whitespace-pre-wrap">{automation.task.prompt}</dd>
            </div>
            {inputs.filter(([, value]) => value).map(([label, value]) => (
              <div key={label} className="grid gap-1">
                <dt className="text-muted-foreground">{label}</dt>
                <dd className="break-words">{value}</dd>
              </div>
            ))}
          </dl>
        </section>
        <section className="min-w-0">
          <InlineLog automationId={automation.id} automationName={automation.name} timeZone={timeZone} readOnly />
          <Button variant="outline" asChild className="mt-3"><Link to={`/automations/${automation.id}/log`}>Execution log</Link></Button>
        </section>
        <div className="grid justify-items-start gap-2">
          {confirming ? (
            <>
              <p className="text-sm break-words">{`Delete “${automation.name}”? Its record and log are removed; the task stays.`}</p>
              <div className="flex flex-wrap gap-2">
                <Button variant="danger-ghost" data-action="automation-delete-confirm" disabled={deleting} onClick={() => void remove()}>Delete schedule</Button>
                <Button ref={keepRef} variant="outline" disabled={deleting} onClick={() => { focusAfter.current = 'delete'; setConfirming(false) }}>Keep</Button>
              </div>
            </>
          ) : (
            <div className="flex flex-wrap gap-2">
              <Button ref={deleteRef} variant="outline" data-action="automation-delete" onClick={() => { focusAfter.current = 'keep'; setConfirming(true) }}>Delete</Button>
              <Button variant="outline" asChild><Link to="/automations">Back to automations</Link></Button>
            </div>
          )}
          {error ? <p role="alert" className="text-sm break-words text-destructive">{error}</p> : null}
        </div>
      </div>
    </PageFrame>
  )
}

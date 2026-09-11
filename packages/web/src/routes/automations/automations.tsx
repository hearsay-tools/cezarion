import '../task-flows.css'
import { useEffect, useState, type FormEvent, type ReactNode } from 'react'
import { useParams } from 'react-router'
import { ClockIcon, PlayIcon, PlusIcon, ZapIcon } from 'lucide-react'
import type { AutomationDefinition, AutomationLogRecord, AutomationsResponse } from '@open-mercato/cezar-api-client'

import { checkAutomation, createAutomation, getAutomationCheck, getAutomationLog, getAutomations, setAutomationEnabled, updateAutomation } from '@/api/client'
import { useHealth } from '@/api/queries'
import { CenteredState } from '@/components/centered-state'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Link, useNavigate } from '@/lib/project-router'
import { useActiveProjectId } from '@/lib/project-router'
import { onWorkspaceEvent } from '@/api/global-events'

export function AutomationsRoute({ mode = 'list' }: { mode?: 'list' | 'new' | 'edit' | 'log' }) {
  const { automationId } = useParams()
  const navigate = useNavigate()
  const projectId = useActiveProjectId()
  const [data, setData] = useState<AutomationsResponse>()
  const [error, setError] = useState('')
  const [checkStatus, setCheckStatus] = useState<Record<string, string>>({})
  // GitHub automations are opt-in (#801). A bookmarked `/automations…` URL still routes here with
  // the capability off, so the view says so rather than rendering an editor whose every request
  // would 409. `!== true` deliberately: only a health payload that HAS answered switches this on.
  const health = useHealth()
  const healthKnown = health.data !== undefined
  const automationsOff = healthKnown && health.data.capabilities?.automations !== true
  const refresh = () => getAutomations().then((next) => { setData(next); setError('') }).catch((cause) => setError(String(cause)))
  // Waits for health rather than firing optimistically: a fetch made before the answer arrives
  // would 409 on a gated server and paint an error over the disabled state below. The deps are
  // two booleans, not `health.data`, so a health refetch does not re-request the list.
  useEffect(() => { if (healthKnown && !automationsOff) void refresh() }, [healthKnown, automationsOff])
  useEffect(() => onWorkspaceEvent((name, payload) => {
    if (name !== 'automation-change') return
    const changed = payload as { project?: unknown }
    if (typeof changed.project === 'string' && (projectId === null || changed.project === projectId)) void refresh()
  }), [projectId])

  // Every mode below needs the capability answer, so none of them renders before health has given
  // it. Without this the list mode alone degraded honestly (it has a loading state of its own)
  // while a cold deep link into `/automations/new` painted a full creation form on a gated
  // server — and a submit inside that window POSTs straight into a 409.
  if (!healthKnown) {
    return (
      <div data-route="automations" className="flex min-h-full flex-col p-3 md:p-5">
        <PageState text="Loading automations…" />
      </div>
    )
  }

  // Before every mode branch, so all four `/automations*` routes degrade the same way.
  if (automationsOff) {
    return (
      <div data-route="automations" className="flex min-h-full flex-col p-3 md:p-5">
        <CenteredState
          icon={<ZapIcon />}
          tone="neutral"
          title="GitHub automations are off"
          subtitle="This server does not poll GitHub or launch tasks from it. Set CEZ_AUTOMATIONS=1 and restart cezar to turn automations on."
          heading="h2"
        />
      </div>
    )
  }

  if (mode === 'new') return <AutomationEditor onSaved={() => { navigate('/automations'); void refresh() }} />
  if (mode === 'edit') {
    const automation = data?.automations.find((item) => item.id === automationId)
    if (error) return <PageFrame title="Edit automation" subtitle="Could not load this automation."><PageState text={error} /><Button variant="outline" onClick={() => void refresh()}>Retry</Button></PageFrame>
    if (data && !automation) return <PageFrame title="Automation not found" subtitle="This automation may have been removed."><Button asChild variant="outline"><Link to="/automations">Back to automations</Link></Button></PageFrame>
    return automation ? <AutomationEditor automation={automation} onSaved={() => { navigate('/automations'); void refresh() }} /> : <PageState text="Loading automation…" />
  }
  if (mode === 'log') {
    const automation = data?.automations.find((item) => item.id === automationId)
    return automationId
      ? <AutomationLog automationId={automationId} automationName={automation?.name} />
      : <PageState text="Automation not found." />
  }

  const preview = async (automation: AutomationDefinition) => {
    setCheckStatus((current) => ({ ...current, [automation.id]: 'Checking…' }))
    try {
      const { checkId } = await checkAutomation(automation.id, 'preview')
      for (let attempt = 0; attempt < 60; attempt += 1) {
        const check = await getAutomationCheck(checkId)
        if (check.status === 'complete') {
          setCheckStatus((current) => ({ ...current, [automation.id]: `${check.matches ?? 0} match${check.matches === 1 ? '' : 'es'} found; no tasks launched.` }))
          void refresh()
          return
        }
        if (check.status === 'error') throw new Error(check.error ?? 'Preview failed')
        await new Promise((resolve) => setTimeout(resolve, 500))
      }
      throw new Error('Preview is still running')
    } catch (cause) {
      setCheckStatus((current) => ({ ...current, [automation.id]: cause instanceof Error ? cause.message : String(cause) }))
    }
  }

  return (
    <PageFrame
      title="Automations"
      subtitle="Checks run while cezar is open. No webhook or public URL required."
      action={<div className="flex flex-wrap gap-2"><Button asChild><Link to="/automations/new"><PlusIcon />New automation</Link></Button><Button variant="outline" asChild><Link to="/github">GitHub</Link></Button></div>}
    >
      {error ? <div className="grid gap-3"><PageState text={error} /><Button variant="outline" onClick={() => void refresh()}>Retry</Button></div> : !data ? <PageState text="Loading automations…" /> : (
        <>
          <div className="mb-4 rounded-lg border bg-muted/30 px-4 py-3 text-sm">
            <span className="font-medium">GitHub {data.available ? 'available' : 'unavailable'}</span>
            <span className="text-muted-foreground"> · Scheduler {data.scheduler.state}{data.reason ? ` · ${data.reason}` : ''}</span>
          </div>
          {data.automations.length === 0 ? <PageState text="No automations yet. Create one paused, test its bounded filter, then enable it from a current-time baseline." /> : (
            <div className="grid gap-3">
              {data.automations.map((automation) => (
                <article key={automation.id} className="rounded-xl border bg-card p-4">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div><h2 className="font-semibold">{automation.name}</h2><p className="mt-1 text-sm text-muted-foreground">{automation.events.join(', ')} · every {Math.round(automation.intervalSeconds / 60)} min</p></div>
                    <span className="rounded-full border px-2 py-1 text-xs">{automation.enabled ? 'Enabled' : 'Paused'}</span>
                  </div>
                  <div className="mt-4 flex flex-wrap gap-2">
                    <Button size="sm" variant="outline" onClick={() => void preview(automation)} disabled={checkStatus[automation.id] === 'Checking…'}><PlayIcon />Test filter</Button>
                    <Button size="sm" variant="outline" onClick={() => void setAutomationEnabled(automation.id, !automation.enabled).then(refresh)}>{automation.enabled ? 'Pause' : 'Enable'}</Button>
                    <Button size="sm" variant="ghost" asChild><Link to={`/automations/${automation.id}`}>Edit</Link></Button>
                    <Button size="sm" variant="ghost" asChild><Link to={`/automations/${automation.id}/log`}>View log</Link></Button>
                  </div>
                  {checkStatus[automation.id] && <p className="mt-3 text-sm text-muted-foreground" role="status">{checkStatus[automation.id]}</p>}
                </article>
              ))}
            </div>
          )}
          {data.automations.map((automation) => <AutomationLog key={automation.id} automationId={automation.id} automationName={automation.name} inline />)}
        </>
      )}
    </PageFrame>
  )
}

function AutomationLog({ automationId, automationName, inline = false }: { automationId: string; automationName?: string; inline?: boolean }) {
  const [records, setRecords] = useState<AutomationLogRecord[]>()
  const [error, setError] = useState('')
  const refresh = () => getAutomationLog(automationId).then(({ records: next }) => { setRecords(next); setError('') }).catch((cause) => setError(String(cause)))
  useEffect(() => { void refresh() }, [automationId])
  useEffect(() => onWorkspaceEvent((name, payload) => {
    if (name === 'automation-change' && (payload as { automationId?: unknown }).automationId === automationId) void refresh()
  }), [automationId])
  const content = <>
    {error ? <div className="grid gap-3"><PageState text={error} /><Button variant="outline" onClick={() => void refresh()}>Retry</Button></div> : !records ? <PageState text="Loading execution log…" /> : records.length === 0 ? <PageState text="No checks have run yet." /> : (
      <ol className="grid gap-3" aria-label="Automation execution log">
        {(inline ? records.slice(0, 5) : records).map((record) => <li key={record.seq} className="rounded-xl border bg-card p-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="font-medium capitalize">{record.result.replace('-', ' ')}</span>
            <time className="text-xs text-muted-foreground" dateTime={record.ts}>{new Date(record.ts).toLocaleString()}</time>
          </div>
          {record.reason && <p className="mt-2 text-sm text-muted-foreground">{record.reason}</p>}
          {(record.githubUrl || record.runId) && <div className="mt-3 flex flex-wrap gap-3 text-sm">
            {record.githubUrl && <a className="underline underline-offset-4" href={record.githubUrl} target="_blank" rel="noreferrer">{record.githubTitle ?? `GitHub #${record.githubNumber ?? ''}`}</a>}
            {record.runId && <Link className="underline underline-offset-4" to={`/runs/${record.runId}`}>Open task</Link>}
          </div>}
        </li>)}
      </ol>
    )}
  </>
  return inline ? <section className="mt-5 rounded-xl border border-border bg-card p-6"><h2 className="mb-4 text-lg font-medium">Recent activity</h2><p className="mb-4 text-sm text-muted-foreground">{automationName}</p>{content}</section> : <PageFrame title="Execution log" subtitle={automationName ?? 'Automation activity'} action={<Button variant="outline" asChild><Link to="/automations">Back to automations</Link></Button>}>{content}</PageFrame>
}

function AutomationEditor({ automation, onSaved }: { automation?: AutomationDefinition; onSaved: () => void }) {
  const [name, setName] = useState(automation?.name ?? '')
  const [prompt, setPrompt] = useState(automation?.task.prompt ?? 'Review {{github.url}}')
  const [enable, setEnable] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (saving) return
    setSaving(true)
    setError('')
    try {
      if (automation) {
        await updateAutomation(automation.id, {
          name,
          description: automation.description,
          events: automation.events,
          intervalSeconds: automation.intervalSeconds,
          filters: automation.filters,
          task: { ...automation.task, prompt },
          enabled: automation.enabled,
          expectedRevision: automation.revision,
        })
        if (enable && !automation.enabled) await setAutomationEnabled(automation.id, true)
      } else {
        await createAutomation({ name, events: ['issue.opened'], intervalSeconds: 300, filters: { lookbackDays: 7, maxRecords: 25 }, task: { prompt, workflow: 'quick-task' }, enable })
      }
      onSaved()
    } catch (cause) { setError(String(cause)) } finally { setSaving(false) }
  }
  return <PageFrame title={automation ? 'Edit automation' : 'New automation'} subtitle="Define a bounded GitHub trigger and the ordinary cezar task it launches.">
    <form className="automation-editor grid gap-5" onSubmit={submit}>
      <fieldset className="grid gap-4 rounded-xl border p-5"><legend className="px-2 font-semibold">When GitHub changes</legend><div className="grid gap-2"><Label htmlFor="automation-name">Name</Label><Input id="automation-name" value={name} onChange={(event) => setName(event.target.value)} required /></div><div className="flex items-center gap-2 text-sm"><ClockIcon className="size-4" />{automation ? `Saved trigger · ${automation.events.join(', ')} · Every ${Math.round(automation.intervalSeconds / 60)} minutes` : 'New issue · every 5 minutes · last 7 days · maximum 25 records'}</div></fieldset>
      <fieldset className="grid gap-4 rounded-xl border p-5"><legend className="px-2 font-semibold">What task to run</legend><div className="grid gap-2"><Label htmlFor="automation-prompt">Prompt</Label><Textarea id="automation-prompt" value={prompt} onChange={(event) => setPrompt(event.target.value)} rows={3} required /></div><p className="text-xs text-muted-foreground">Placeholders include {'{{github.number}}'}, {'{{github.title}}'}, {'{{github.url}}'}, and {'{{github.labels}}'}. GitHub content is appended as untrusted context.</p></fieldset>
      {!automation?.enabled ? <fieldset className="rounded-xl border p-5"><legend className="px-2 font-semibold">Review and enable</legend><label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={enable} onChange={(event) => setEnable(event.target.checked)} />Save and enable from a current-time baseline (existing matches will not launch)</label></fieldset> : null}
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      <div className="flex gap-2"><Button type="submit" disabled={saving}>{saving ? 'Saving…' : 'Save automation'}</Button><Button type="button" variant="outline" onClick={onSaved}>Cancel</Button></div>
    </form>
  </PageFrame>
}

function PageFrame({ title, subtitle, action, children }: { title: string; subtitle: string; action?: ReactNode; children: ReactNode }) {
  return <main data-route="automations" className="task-flow-page w-full"><header className="mb-6 flex flex-col items-start gap-5"><div><div className="mb-2 flex items-center gap-2"><h1 className="text-[28px] font-medium">{title}</h1></div><p className="text-sm text-muted-foreground">{subtitle}</p></div>{action}</header>{children}</main>
}
function PageState({ text }: { text: string }) { return <div role="status" className="rounded-xl border bg-card p-6 text-sm text-muted-foreground">{text}</div> }

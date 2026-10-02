import { useState, type FormEvent, type ReactNode } from 'react'
import type { AutomationDefinition, AutomationKind, Runner } from '@open-mercato/cezar-api-client'

import { ApiError, createAutomation, deleteAutomation, setAutomationEnabled, updateAutomation } from '@/api/client'
import { useConfig, useProviderStatus, useRunnerModels, useWorkflows } from '@/api/queries'
import { CpuIcon, TerminalIcon, WorkflowIcon } from '@/components/design-icons'
import { SegmentedControl } from '@/components/facet-filter'
import { PickerPill, PickerPillGroup } from '@/components/picker-pill'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import { Link } from '@/lib/project-router'
import { usableRunners } from '@/lib/provider-status'
import { RUNNERS, modelsForRunner } from '../new-task-form'
import { fromDefinition, toCreateBody, toUpdateBody, type AutomationDraft } from './editor-draft'
import { GithubFields, pollSentence } from './editor-github-fields'
import { ScheduleFields } from './editor-schedule-fields'
import { NextRunsPreview } from './next-runs-preview'
import { PageFrame } from './page-frame'

type Section = 'name' | 'when' | 'run' | 'enable' | 'form'
type Failure = { section: Section; message: string; conflict?: boolean }

const KIND_LABEL: Record<AutomationKind, string> = { schedule: 'On a schedule', github: 'When GitHub changes' }

/** Which section a server message belongs under. The server answers one `{ error }` string, not a
 *  field path, so the section is read off the words it uses; anything unplaceable sits above Save. */
function sectionOf(message: string): Section {
  if (/placeholder|prompt|workflow|runner|model|task|autonomous/i.test(message)) return 'run'
  if (/\bname\b/i.test(message)) return 'name'
  if (/schedule|github|event|filter|label|interval|remote|forge|lookback|records?|hour|minute|poll|kind/i.test(message)) return 'when'
  return 'form'
}

function Section({ title, failure, section, children }: { title: string; failure?: Failure; section: Section; children: ReactNode }) {
  return (
    <fieldset className="grid min-w-0 gap-4 rounded-xl border p-5 max-md:p-4!">
      <legend className="px-0">{title}</legend>
      {children}
      {failure?.section === section && !failure.conflict ? <p role="alert" className="text-sm break-words text-destructive">{failure.message}</p> : null}
    </fieldset>
  )
}

export function AutomationEditor({ automation, forge, timeZone, onSaved, onReload }: {
  automation?: AutomationDefinition
  forge: { available: boolean; reason?: string }
  timeZone: string
  onSaved: () => void
  onReload?: () => void
}) {
  const [draft, setDraft] = useState<AutomationDraft>(() => fromDefinition(automation))
  const [revision, setRevision] = useState(automation?.revision)
  const [failure, setFailure] = useState<Failure>()
  const [saving, setSaving] = useState(false)
  const [confirmingDelete, setConfirmingDelete] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [deleteError, setDeleteError] = useState('')
  const patch = (next: Partial<AutomationDraft>) => setDraft((current) => ({ ...current, ...next }))

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (saving) return
    setSaving(true)
    setFailure(undefined)
    let step: 'save' | 'enable' = 'save'
    try {
      if (automation && revision !== undefined) {
        // `enabled` rides the PUT unchanged: turning a paused automation ON is the enable route's
        // job, because only that route establishes the baseline (or arms the first run).
        const { automation: next } = await updateAutomation(automation.id, toUpdateBody({ ...draft, enabled: automation.enabled }, revision))
        setRevision(next.revision)
        if (draft.enabled !== automation.enabled) {
          step = 'enable'
          await setAutomationEnabled(automation.id, draft.enabled)
        }
      } else {
        await createAutomation(toCreateBody(draft))
      }
      onSaved()
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause)
      // Only the store's revision conflict means "edited elsewhere"; the other 409s (a kind switch,
      // automations switched off) say their own thing, and Reload could not fix them.
      if (step === 'save' && automation && cause instanceof ApiError && cause.status === 409 && /revision conflict/i.test(message)) {
        setFailure({ section: 'form', message: 'Edited elsewhere — reload to see the latest version', conflict: true })
      } else {
        setFailure({ section: step === 'enable' ? 'enable' : sectionOf(message), message })
      }
    } finally {
      setSaving(false)
    }
  }

  const remove = async () => {
    if (!automation || deleting) return
    setDeleting(true)
    setDeleteError('')
    try {
      await deleteAutomation(automation.id)
      onSaved()
    } catch (cause) {
      setDeleteError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setDeleting(false)
    }
  }

  const saveLabel = automation ? 'Save changes' : draft.enabled ? 'Save and enable' : 'Save paused'
  const isSchedule = draft.kind === 'schedule'
  return (
    <PageFrame
      title={automation ? 'Edit automation' : 'New automation'}
      subtitle="Define when it runs and the ordinary task it launches."
    >
      <form className="automation-editor grid min-w-0 gap-5 md:grid-cols-[minmax(0,1fr)_320px] md:items-start" onSubmit={submit}>
        <div className="grid min-w-0 gap-5">
          <Section title="Name" section="name" failure={failure}>
            <div className="grid gap-2">
              <Label htmlFor="automation-name">Name</Label>
              <Input id="automation-name" value={draft.name} onChange={(event) => patch({ name: event.target.value })} required />
            </div>
          </Section>

          <Section title="When" section="when" failure={failure}>
            {automation ? (
              <p className="text-sm"><span className="text-muted-foreground">Trigger · </span>{KIND_LABEL[draft.kind]}</p>
            ) : (
              <div className="grid justify-items-start gap-2">
                <SegmentedControl<AutomationKind>
                  slot="automation-kind"
                  label="Trigger"
                  size="touch"
                  value={draft.kind}
                  onChange={(kind) => patch({ kind })}
                  options={[
                    { value: 'schedule', label: KIND_LABEL.schedule },
                    { value: 'github', label: KIND_LABEL.github, disabled: !forge.available, ...(forge.available ? {} : { title: forge.reason ?? 'GitHub is unavailable' }) },
                  ]}
                />
                {forge.available ? null : <p className="text-xs break-words text-muted-foreground">{`GitHub unavailable · ${forge.reason ?? 'no GitHub access'}`}</p>}
              </div>
            )}
            {isSchedule
              ? <ScheduleFields value={draft.schedule} onChange={(schedule) => patch({ schedule })} timeZone={timeZone} />
              : <GithubFields draft={draft} onChange={patch} {...(forge.available ? {} : { disabledReason: forge.reason ?? 'no GitHub access' })} />}
          </Section>

          <Section title="What to run" section="run" failure={failure}>
            <div className="grid gap-2">
              <Label htmlFor="automation-prompt">Prompt</Label>
              <Textarea id="automation-prompt" value={draft.prompt} onChange={(event) => patch({ prompt: event.target.value })} rows={4} required />
              <p className="text-xs break-words text-muted-foreground">
                {isSchedule
                  ? <>Available: {'{{date}}'} {'{{time}}'} {'{{project}}'} {'{{automation}}'}. A run-context block is appended automatically.</>
                  : <>Available: {'{{github.number}}'} {'{{github.title}}'} {'{{github.url}}'} {'{{github.labels}}'}. GitHub content is appended as untrusted context.</>}
              </p>
            </div>
            <EnginePills draft={draft} patch={patch} />
            <label className="flex min-h-11 items-center gap-3 text-sm">
              <Switch aria-label="Autonomous" checked={draft.autonomous} onCheckedChange={(autonomous) => patch({ autonomous })} />
              <span>Autonomous <span className="text-muted-foreground">· runs without waiting for answers</span></span>
            </label>
            <p className="text-xs break-words text-muted-foreground">Each run is an ordinary task in its own worktree, queued behind the parallel cap, never auto-merged.</p>
          </Section>

          <Section title="Enable" section="enable" failure={failure}>
            <label className="flex min-h-11 items-center gap-3 text-sm">
              <Switch aria-label={automation ? 'Enabled' : 'Enable after saving'} checked={draft.enabled} onCheckedChange={(enabled) => patch({ enabled })} />
              <span>{automation ? 'Enabled' : 'Enable after saving'}</span>
            </label>
            <p className="text-xs break-words text-muted-foreground">
              {isSchedule ? 'The first run is the next occurrence shown beside the schedule.' : 'Enabling starts from a current-time baseline. Existing matches will not launch tasks.'}
            </p>
          </Section>

          {failure?.section === 'form' ? (
            <div role="alert" className="flex flex-wrap items-center gap-3 text-sm text-destructive">
              <span className="break-words">{failure.message}</span>
              {failure.conflict && onReload ? <Button type="button" variant="outline" onClick={onReload}>Reload</Button> : null}
            </div>
          ) : null}
          <div className="flex flex-wrap gap-2">
            <Button type="submit" disabled={saving}>{saving ? 'Saving…' : saveLabel}</Button>
            <Button type="button" variant="outline" asChild><Link to="/automations">Cancel</Link></Button>
          </div>
          {automation ? (
            <div className="grid justify-items-start gap-2 border-t pt-4">
              {confirmingDelete ? (
                <>
                  <p className="text-sm break-words">{`Delete “${automation.name}”? It will stop running and cannot be restored.`}</p>
                  <div className="flex flex-wrap gap-2">
                    <Button type="button" variant="danger-ghost" data-slot="automation-delete-confirm" disabled={deleting} onClick={() => void remove()}>Delete automation</Button>
                    <Button type="button" variant="outline" disabled={deleting} onClick={() => { setConfirmingDelete(false); setDeleteError('') }}>Keep</Button>
                  </div>
                </>
              ) : (
                <Button type="button" variant="outline" data-slot="automation-delete" onClick={() => setConfirmingDelete(true)}>Delete</Button>
              )}
              {deleteError ? <p role="alert" className="text-sm break-words text-destructive">{deleteError}</p> : null}
            </div>
          ) : null}
        </div>

        <aside className="min-w-0 md:sticky md:top-4">
          {isSchedule
            ? <NextRunsPreview schedule={draft.schedule} timeZone={timeZone} />
            : (
              <section className="rounded-xl border bg-card p-4">
                <h2 className="mb-2 text-[15px] font-medium">How it polls</h2>
                <p className="text-sm break-words text-muted-foreground">{pollSentence(draft)}</p>
              </section>
            )}
        </aside>
      </form>
    </PageFrame>
  )
}

/** Workflow / runner / model, from the composer's own sources. An unset runner or model means
 *  "whatever the project defaults to when the run starts", so the options start with that. */
function EnginePills({ draft, patch }: { draft: AutomationDraft; patch: (next: Partial<AutomationDraft>) => void }) {
  const workflows = useWorkflows()
  const providers = useProviderStatus()
  const config = useConfig()
  const effectiveRunner: Runner = draft.runner ?? config.data?.defaultRunner ?? 'claude'
  const catalog = useRunnerModels(effectiveRunner)
  const names = [...new Set([...(workflows.data?.workflows ?? []).map((workflow) => workflow.name), ...(draft.workflow ? [draft.workflow] : [])])]
  const runners = [...new Set([...usableRunners(providers.data), ...(draft.runner ? [draft.runner] : [])])]
  const models = modelsForRunner(effectiveRunner, catalog.data, [draft.model])
  const modelLabel = models.find((model) => model.id === (draft.model ?? ''))?.label ?? draft.model ?? 'auto'
  const icon = (Icon: typeof CpuIcon) => <Icon aria-hidden="true" className="size-[18px] shrink-0 text-accent-text" />
  return (
    <PickerPillGroup>
      <div className="flex flex-wrap gap-2">
        <PickerPill
          slot="automation-workflow-pill"
          icon={icon(WorkflowIcon)}
          fieldLabel
          ariaLabel="Workflow"
          label={draft.workflow ?? 'inline steps'}
          value={draft.workflow ?? ''}
          disabled={draft.workflow === undefined}
          disabledHint="This automation carries its own steps."
          options={names.map((name) => ({ value: name, label: name }))}
          onPick={(workflow) => patch({ workflow })}
        />
        <PickerPill
          slot="automation-runner-pill"
          icon={icon(TerminalIcon)}
          fieldLabel
          ariaLabel="Runner"
          label={draft.runner ?? 'default'}
          value={draft.runner ?? ''}
          options={[{ value: '', label: 'default', desc: 'The project’s default runner' }, ...runners.map((id) => ({ value: id, label: RUNNERS.find((runner) => runner.id === id)?.label ?? id }))]}
          onPick={(runner) => {
            // A model id belongs to its runner, so picking another runner clears it.
            patch({ runner: runner ? (runner as Runner) : undefined, model: undefined })
          }}
        />
        <PickerPill
          slot="automation-model-pill"
          icon={icon(CpuIcon)}
          fieldLabel
          ariaLabel="Model"
          label={modelLabel}
          value={draft.model ?? ''}
          options={models.map((model) => ({ value: model.id, label: model.label, desc: model.desc }))}
          onPick={(model) => patch({ model: model || undefined })}
        />
      </div>
    </PickerPillGroup>
  )
}

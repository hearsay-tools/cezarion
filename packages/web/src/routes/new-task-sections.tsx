import { Button } from '@/components/ui/button'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { CheckIcon, ChevronDownIcon, CpuIcon, GaugeIcon, SlidersHorizontalIcon, TerminalIcon } from '@/components/design-icons'
import type { RefObject } from 'react'

import { Link } from '@/lib/project-router'

import { putConfig } from '@/api/client'
import { hasAccountChoice } from '@/api/agent-accounts'
import { queryKeys } from '@/api/queries'
import type { RepoResponse } from '@open-mercato/cezar-api-client'
import { TwinkleBackdrop } from '@/components/centered-state'
import { CompletionControls } from '@/components/completion-controls'
import { PickerPill, PickerPillGroup, RunnerPill } from '@/components/picker-pill'
import { toast } from '@/components/ui/toaster'
import { submitShortcutHint } from '@/lib/use-submit-shortcut'
import { webhookLabel } from '@/lib/webhook'
import { cn } from '@/lib/utils'

import type { useAccountSelection, useEngineSelection } from './new-task-controller'
import type { NewTaskDraft } from './new-task-draft'
import { effortOptionsForModel, modelCatalogStatus, resolveEffort, RUNNERS } from './new-task-form'

/** The `/new` route's layout sections (hearsay-tools/cezarion#1598), each with explicit inputs. */

type Engine = ReturnType<typeof useEngineSelection>
type Accounts = ReturnType<typeof useAccountSelection>
type DraftUpdate = (patch: Partial<NewTaskDraft>) => void

/** The unattended bookmarklet start in flight: no composer, no params echoed anywhere —
 *  just an honest "working on it" until the POST answers (success navigates to the thread;
 *  failure drops back to the prefilled composer with a toast). */
export function AutoStartingSurface() {
  return (
    <div
      data-route="new"
      className="relative isolate flex min-h-full flex-col items-center justify-center overflow-x-clip px-6"
    >
      <TwinkleBackdrop />
      <div data-slot="auto-starting" role="status" className="text-center">
        <h1 className="animate-pulse text-lg font-semibold tracking-tight">Starting task…</h1>
        <p className="mt-1.5 text-[14px] text-muted-foreground">
          Launched from a bookmarklet — taking you to the run.
        </p>
      </div>
    </div>
  )
}

export function NewTaskHeader() {
  return (
    <header className="mb-7 max-md:mb-5">
      <p data-slot="page-eyebrow" className="mb-2 text-[11px] font-semibold tracking-[0.16em] text-[var(--accent-text)] uppercase">
        NEW TASK
      </p>
      <h1 className="text-[30px] leading-[normal] font-semibold tracking-[-0.9px] max-md:text-[22px] max-md:leading-[29px] max-md:tracking-[-0.6px]">
        What should the agent work on?
      </h1>
      <p data-slot="page-description" className="mt-2 hidden text-[13px] text-muted-foreground md:block">
        Describe the outcome. Configure the run. Review everything before it lands.
      </p>
    </header>
  )
}

export function RetiredVariantsNotice({ onUseOneTask }: { onUseOneTask: () => void }) {
  return (
    <section role="alert" className="flex flex-col items-start gap-3 rounded-xl border border-border bg-card p-4">
      <p>Parallel variants are removed. This saved draft requested multiple candidates. Use owned workers to compare approaches, or start one task.</p>
      <Button variant="outline" className="min-h-11" onClick={onUseOneTask}>Use one task</Button>
    </section>
  )
}

/** Runner (with its accounts), model and effort. Controls stay with the editor; the compact
 *  layout puts effort before model, and the DOM order follows that visual order. */
export function AgentOptions({
  groupRef,
  compact,
  engine,
  accounts,
  draftEffort,
  update,
}: {
  groupRef: RefObject<HTMLDivElement | null>
  compact: boolean
  engine: Engine
  accounts: Accounts
  draftEffort: string | null
  update: DraftUpdate
}) {
  const showRunnerPill = engine.runners.length > 1
    || engine.runners.some((id) => hasAccountChoice(accounts.accountChoices, id))
  const runnerPill = showRunnerPill
    ? <RoutedRunnerPill key="runner" engine={engine} accounts={accounts} update={update} />
    : null
  const modelPill = <ModelPill key="model" engine={engine} draftEffort={draftEffort} update={update} />
  const effortPill = <EffortPill key="effort" engine={engine} update={update} />
  return (
    <div ref={groupRef} data-slot="agent-options" role="group" aria-label="Agent settings" className="new-task-agent-options">
      <PickerPillGroup>
        {compact ? [runnerPill, effortPill, modelPill] : [runnerPill, modelPill, effortPill]}
      </PickerPillGroup>
    </div>
  )
}

function RoutedRunnerPill({ engine, accounts, update }: { engine: Engine; accounts: Accounts; update: DraftUpdate }) {
  return (
    <RunnerPill
      icon={<TerminalIcon aria-hidden="true" className="size-[18px] shrink-0 text-accent-text" />}
      fieldLabel
      runners={engine.runners}
      value={engine.displayRunner}
      accounts={accounts.accountChoices}
      account={accounts.agentProfile}
      repoAccount={accounts.repoAccount}
      onPick={(next, picked) =>
        update({
          runner: next,
          agentProfile: picked,
          ...(next === engine.displayRunner ? {} : { model: null }),
        })
      }
      disabled={!engine.providersReady}
    />
  )
}

function ModelPill({ engine, draftEffort, update }: { engine: Engine; draftEffort: string | null; update: DraftUpdate }) {
  const { catalog, displayRunner } = engine
  return (
    <PickerPill
      icon={<CpuIcon aria-hidden="true" className="size-[18px] shrink-0 text-accent-text" />}
      fieldLabel
      slot="model-pill"
      ariaLabel="Model"
      label={engine.models.find((m) => m.id === engine.model)?.label ?? 'auto'}
      value={engine.model}
      disabled={!engine.providersReady}
      readOnly={engine.modelsLocked}
      disabledHint={engine.modelsLocked ? 'Model selection is locked to native coding-agent settings.' : undefined}
      onPick={(next) => {
        const nextOptions = effortOptionsForModel(displayRunner, next, catalog.data)
        update({
          model: next,
          effort: draftEffort === null ? null : resolveEffort(draftEffort, nextOptions),
        })
      }}
      options={engine.models.map((m) => ({ value: m.id, label: m.label, desc: m.desc }))}
      status={modelCatalogStatus(displayRunner, catalog.data, catalog.isError, catalog.isFetching)}
    />
  )
}

function EffortPill({ engine, update }: { engine: Engine; update: DraftUpdate }) {
  return (
    <PickerPill
      icon={<GaugeIcon aria-hidden="true" className="size-[18px] shrink-0 text-accent-text" />}
      fieldLabel
      slot="effort-pill"
      ariaLabel="Effort"
      label={engine.effortOptions.find((option) => option.value === engine.effort)?.label ?? 'auto'}
      value={engine.effort}
      disabled={!engine.providersReady}
      readOnly={engine.modelsLocked}
      disabledHint={engine.modelsLocked ? 'Effort selection is locked to native coding-agent settings.' : undefined}
      onPick={(next) => update({ effort: next })}
      options={engine.effortOptions.map((option) => ({
        value: option.value,
        label: option.label,
        desc: option.desc,
      }))}
    />
  )
}

/** Run and completion settings in one native disclosure (hearsay-tools/cezarion#1596). */
export function ExecutionSettings({
  engine,
  draft,
  update,
  repo,
  hasGit,
  runMode,
  webhook,
  interactiveSkill,
  completionDisabled,
}: {
  engine: Engine
  draft: NewTaskDraft
  update: DraftUpdate
  repo: RepoResponse | undefined
  hasGit: boolean
  runMode: { worktree: boolean; autonomous: boolean }
  webhook: { url: string | undefined; on: boolean; onChange: (on: boolean) => void }
  interactiveSkill: boolean
  completionDisabled: boolean
}) {
  const { displayRunner } = engine
  return (
    <details data-slot="execution-options" open className="group rounded-xl border border-border bg-card xl:self-start">
      <summary className="flex min-h-[44px] cursor-pointer list-none flex-wrap items-center gap-x-2 gap-y-1 px-3 py-2 text-xs text-muted-foreground pointer-hover:bg-muted/50 active:bg-muted/50 focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-foreground [&::-webkit-details-marker]:hidden">
        <SlidersHorizontalIcon aria-hidden="true" className="size-[18px] shrink-0 text-accent-text" />
        <span className="font-medium text-foreground">Execution settings</span>
        <span data-slot="execution-summary" hidden className="min-w-0 basis-full truncate pl-5 xl:ml-auto xl:basis-auto xl:pl-0">
          {RUNNERS.find((runner) => runner.id === displayRunner)?.label ?? displayRunner}
          {' · '}{engine.models.find((item) => item.id === engine.model)?.label ?? 'auto'}
        </span>
        <ChevronDownIcon aria-hidden="true" className="new-task-settings-chevron size-4 shrink-0" />
      </summary>
      <div className="new-task-settings-body">
        <p className="new-task-settings-description">Control this run and what happens after Done.</p>
        <div role="group" aria-label="Run settings" className="new-task-run-settings">
          {/* Worktree opt-out (#worktree-toggle): any ordinary run in a git repo may use the
              current checkout. Workflows may run in place when the user opts out. */}
          {hasGit ? (
            <WorktreeToggle
              on={runMode.worktree}
              onChange={(on) => update({ worktree: on })}
            />
          ) : null}
          <BaseBranchRow repo={repo} />
          <AutonomousToggle
            on={runMode.autonomous}
            disabled={draft.planFirst}
            onChange={(on) => update({ autonomous: on })}
          />
          {webhook.url !== undefined ? (
            <NotifyWebhookToggle on={webhook.on} url={webhook.url} onChange={webhook.onChange} />
          ) : null}
          {interactiveSkill && (draft.autonomous === null || draft.worktree === null) ? (
            <p className="basis-full text-xs text-muted-foreground" data-slot="interactive-skill-hint">
              This skill recommends an interactive run in the current checkout. You can change either setting.
            </p>
          ) : null}
        </div>
        <CompletionControls embedded archiveWhenDone={draft.archiveWhenDone} autoMergePr={draft.autoMergePr} onChange={update} disabled={completionDisabled} />
      </div>
    </details>
  )
}

export function ComposerFooterEnd({
  showConfigureProviders,
  planFirst,
  planning,
  onModeChange,
}: {
  showConfigureProviders: boolean
  planFirst: boolean
  planning: boolean
  onModeChange: (planFirst: boolean) => void
}) {
  return (
    <>
      {showConfigureProviders ? (
        <Link
          to="/settings/agents#providers"
          className="text-xs font-medium text-foreground underline underline-offset-4"
        >
          Configure providers
        </Link>
      ) : null}
      <ModeSegment planFirst={planFirst} planning={planning} onModeChange={onModeChange} />
      <kbd
        aria-hidden="true"
        className="hidden rounded-[5px] border border-b-2 border-border bg-card px-[5px] py-px font-mono text-[11px] font-medium text-muted-foreground md:inline"
      >
        {submitShortcutHint()}
      </kbd>
    </>
  )
}

/** Worktree opt-out toggle (#worktree-toggle): a checkbox-style chip for ordinary runs.
 *  Checked = isolated worktree (the default); unchecked = run in the repo working tree. */
function WorktreeToggle({
  on,
  disabled,
  disabledReason,
  onChange,
}: {
  on: boolean
  disabled?: boolean
  disabledReason?: string
  onChange: (on: boolean) => void
}) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={on}
      disabled={disabled}
      aria-label="Worktree"
      data-slot="worktree-toggle"
      onClick={() => onChange(!on)}
      title={
        disabled
          ? disabledReason
          : on
          ? 'Runs in an isolated worktree — uncheck to run in the repo working tree'
          : 'Runs in the repo working tree — check to isolate in a worktree'
      }
      className="flex items-center justify-between gap-3 px-0 py-3 text-left"
    >
      <span><span className="block text-[13px] font-medium">Worktree</span><span className="block text-[12px] text-muted-foreground">{on ? 'Changes stay in a separate working copy.' : 'Changes are made in the current working directory.'}</span></span>
      <span aria-hidden="true" className={cn('flex h-6 w-10 shrink-0 items-center rounded-full border p-0.5', on ? 'border-accent-strong bg-accent-strong' : 'border-muted-foreground bg-muted')}><span className={cn('size-[18px] rounded-full', on ? 'ml-auto bg-accent-strong-foreground' : 'bg-foreground')} /></span>
    </button>
  )
}

/** Autonomous toggle (#autonomous): checked = the run never pauses for you, auto-continuing
 *  until the agent is done. No "needs you" is ever raised. */
function AutonomousToggle({
  on,
  disabled,
  onChange,
}: {
  on: boolean
  disabled?: boolean
  onChange: (on: boolean) => void
}) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={on}
      disabled={disabled}
      aria-label="Autonomous"
      data-slot="autonomous-toggle"
      onClick={() => onChange(!on)}
      title={
        disabled
          ? 'Plan-first runs are interactive — autonomous is unavailable'
          : on
            ? 'Autonomous — the agent runs to completion without pausing for you'
            : 'Runs interactively — check to let the agent finish without pausing for you'
      }
      className="flex items-center justify-between gap-3 px-0 py-3 text-left disabled:opacity-50"
    >
      <span><span className="block text-[13px] font-medium">Autonomous</span><span className="block text-[12px] text-muted-foreground">Let the agent proceed without prompts</span></span>
      <span aria-hidden="true" className={cn('flex h-6 w-10 shrink-0 items-center rounded-full border p-0.5', on ? 'border-accent-strong bg-accent-strong' : 'border-muted-foreground bg-muted')}><span className={cn('size-[18px] rounded-full', on ? 'ml-auto bg-accent-strong-foreground' : 'bg-foreground')} /></span>
    </button>
  )
}

/** Notify webhook toggle (#589): checked = the project's task webhook receives this task's
 *  status changes from the start. Rendered only when the project has a webhook. */
function NotifyWebhookToggle({
  on,
  url,
  onChange,
}: {
  on: boolean
  url: string
  onChange: (on: boolean) => void
}) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={on}
      aria-label="Notify webhook"
      data-slot="notify-webhook-toggle"
      onClick={() => onChange(!on)}
      title={on ? `Status changes go to ${webhookLabel(url)}` : `Check to send this task's status changes to ${webhookLabel(url)}`}
      className="flex min-h-11 items-center justify-between gap-3 px-0 py-3 text-left"
    >
      <span className="min-w-0"><span className="block text-[13px] font-medium">Notify webhook</span><span data-slot="notify-webhook-subtitle" className="block truncate text-[12px] text-muted-foreground">Send status changes</span></span>
      <span aria-hidden="true" className={cn('flex h-6 w-10 shrink-0 items-center rounded-full border p-0.5', on ? 'border-accent-strong bg-accent-strong' : 'border-muted-foreground bg-muted')}><span className={cn('size-[18px] rounded-full', on ? 'ml-auto bg-accent-strong-foreground' : 'bg-foreground')} /></span>
    </button>
  )
}

/** The Base branch row of the run settings. It stays while `/repo` loads and after it fails:
 *  it sits above Autonomous, so inserting or removing it moved that toggle under a pointer
 *  mid-click (hearsay-tools/cezarion#1605). Only the picker waits for the repo. */
function BaseBranchRow({ repo }: { repo: RepoResponse | undefined }) {
  return (
    <div data-slot="base-branch-row" className="new-task-base-branch flex items-center justify-between gap-2 text-xs text-muted-foreground">
      <span>Base branch</span>
      {repo ? <BaseBranchPill repo={repo} /> : null}
    </div>
  )
}

/** Base-branch picker: worktrees fork from it and PRs target it. It is repo-level CONFIG
 *  (`PUT /api/config`, exactly the legacy Repo tab's picker), not a per-run flag — so it
 *  mutates the server and refetches, rather than living in the draft. Hidden without git. */
function BaseBranchPill({ repo }: { repo: RepoResponse }) {
  const queryClient = useQueryClient()
  const mutation = useMutation({
    mutationFn: (baseBranch: string | null) => putConfig({ baseBranch }),
    onSuccess: (result) => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.repo })
      toast(
        result.baseBranch
          ? `New tasks will branch off "${result.baseBranch}" (PRs target it too).`
          : 'Base branch cleared — new tasks fork from the checked-out branch.',
      )
    },
    onError: (error: Error) => toast(error.message, { tone: 'danger' }),
  })
  if (!repo.info) return null
  const current = repo.baseBranch ?? repo.info.branch
  return (
    <PickerPill
      searchPlaceholder="Search branches…"
      slot="base-pill"
      ariaLabel="Base branch"
      label={<span className="text-[11px]">{current}</span>}
      value={repo.baseBranch ?? ''}
      onPick={(value) => mutation.mutate(value === '' ? null : value)}
      options={[
        { value: '', label: `follow checked-out branch (${repo.info.branch})`, desc: 'New task worktrees fork from whatever branch is checked out' },
        ...repo.branches.map((branch) => ({ value: branch, label: branch })),
      ]}
    />
  )
}

/** The `Start | Plan first` segment (#383): a real toggle with an UNMISTAKABLE selected state.
 *  "Start" selected keeps the quiet card fill; "Plan first" selected takes the mockup's
 *  contrast fill + focus ring (`.seg .plan-active`) — plan mode must never be ambient. The
 *  active plan segment doubles as the busy indicator while `POST /api/plan` is in flight. */
function ModeSegment({
  planFirst,
  planning,
  onModeChange,
}: {
  planFirst: boolean
  planning: boolean
  onModeChange: (planFirst: boolean) => void
}) {
  return (
    <div
      data-slot="mode-seg"
      role="radiogroup"
      aria-label="Run mode"
      className="inline-flex items-center gap-0.5 rounded-lg bg-muted p-[3px]"
    >
      <button
        type="button"
        role="radio"
        aria-checked={!planFirst}
        onClick={() => onModeChange(false)}
        className={cn(
          'h-6 rounded-md px-2 text-xs transition-colors',
          !planFirst
            ? 'bg-card font-semibold text-foreground shadow-xs'
            : 'font-medium text-muted-foreground hover:text-foreground',
        )}
      >
        {!planFirst ? <CheckIcon aria-hidden="true" className="size-3.5" /> : null}
        Start
      </button>
      <button
        type="button"
        role="radio"
        aria-checked={planFirst}
        aria-busy={planning || undefined}
        data-slot="mode-plan"
        onClick={() => onModeChange(true)}
        className={cn(
          'h-6 rounded-md px-2 text-xs transition-colors',
          planFirst
            ? 'bg-contrast font-semibold text-contrast-foreground ring-2 ring-ring/55'
            : 'font-medium text-muted-foreground hover:text-foreground',
          planning && 'animate-pulse',
        )}
      >
        {planning ? 'Planning…' : 'Plan first'}
      </button>
    </div>
  )
}

import { EyeIcon } from 'lucide-react'
import { CheckIcon, CircleSlashIcon, FolderOpenIcon, SparklesIcon, WorkflowIcon, XIcon } from '@/components/design-icons'
import { useRef, useState } from 'react'
import { useParams, useSearchParams } from 'react-router'

import { Link, useNavigate } from '@/lib/project-router'

import { useProjectScope } from '@/api/project-scope-context'
import { useConfig, useRepo, useUiState, useWorkspaceConfig } from '@/api/queries'
import type { ProjectListEntry, Skill, WorkflowDef } from '@open-mercato/cezar-api-client'
import { Composer, type ComposerHandle } from '@/components/composer/composer'
import { chevron, chipClass } from '@/components/picker-pill'
import { PromptTemplateMenu } from '@/components/prompt-template-menu'
import { SkillPreviewDialog } from '@/components/skill-detail'
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import type { PromptTemplate } from '@/lib/prompt-templates'
import {
  isProjectSkill,
  queryScore,
  searchSkillsForDisplay,
  searchWorkflows,
  skillKeywords,
} from '@/lib/skills'
import { submitShortcutHint } from '@/lib/use-submit-shortcut'
import { cn } from '@/lib/utils'

import {
  providerUnavailableReason,
  routeRunMode,
  useAccountSelection,
  useBookmarkletDeepLink,
  useCompactAgentOptions,
  useEngineSelection,
  useNewTaskDraft,
  useNewTaskSubmit,
  useNotifyWebhook,
  usePromptTemplates,
  useProviderReadyFocus,
  useSourceSelection,
} from './new-task-controller'
import { composerRunModeNote } from './new-task-draft'
import { QUICK_TASK, type TaskSource } from './new-task-form'
import { parseNewTaskParams } from './new-task-params'
import {
  AgentOptions,
  AutoStartingSurface,
  ComposerFooterEnd,
  ExecutionSettings,
  NewTaskHeader,
  RetiredVariantsNotice,
} from './new-task-sections'
import { PlanReview } from './plan-review'
import './new-task.css'

/** What the composer says and does in each run mode (`Start | Plan first`, #383). */
const COMPOSER_MODE = {
  start: {
    note: 'Start immediately with the selected configuration.',
    pendingLabel: 'Starting task…',
    failureHint: undefined,
    clearOnSuccess: true,
    sendAriaLabel: 'Start task',
  },
  plan: {
    note: 'Review the plan before starting the task.',
    pendingLabel: 'Planning task…',
    failureHint: 'Could not create the plan. Your draft is kept. Please retry.',
    clearOnSuccess: false,
    sendAriaLabel: 'Plan task',
  },
} as const

/**
 * `/new` — Start from design.pen 1A–1D: page intro, editor + model/effort, then the 330px
 * execution panel on desktop. Mobile keeps those controls in document flow under the draft.
 * In plan-first mode (#383, the `Start | Plan first` segment) submit runs `POST /api/plan`
 * and opens the review page (plan-review.tsx) instead of starting a run.
 *
 * This route also owns the saved-bookmarklet contract (spec 011, BACKWARD_COMPATIBILITY.md):
 * a full document load of `/new?skill=&ref=&auto=1&key=` auto-starts a run unattended when the
 * key matches `GET /api/launch-key`, and only prefills otherwise — `handleDeepLink()` in
 * web/app.js, verbatim (see new-task-autostart.ts for the verified semantics).
 *
 * State and effects live in new-task-controller.ts, layout sections in new-task-sections.tsx.
 */
export function NewTaskRoute() {
  const [search] = useSearchParams()
  const agentOptionsRef = useRef<HTMLDivElement>(null)
  const composerRef = useRef<ComposerHandle>(null)
  const draftPanelRef = useRef<HTMLDivElement>(null)

  // The composer's project (multi-project spec, step 3.4). TWO ids, deliberately:
  //  - `urlProjectId` is what the URL names — always a real project, boot included. It is the
  //    pill's selected value and what a swap navigates away from.
  //  - `scope.projectId` is the API/cache scope, which is NULL for the boot project (the
  //    step-3.1 invariant). It keys the draft, so the boot project keeps the bare legacy
  //    storage key and a draft typed before this upgrade survives it.
  // Both are absent when this route renders outside a `/p/:projectId` prefix (a component
  // test), and everything below degrades to exactly the single-project behavior.
  const { projectId: urlProjectId } = useParams()
  const draftProjectId = useProjectScope().projectId

  // The deep-link params, captured ONCE: the bookmarklet hook strips them from the URL
  // (legacy's `history.replaceState` — the launch key must not survive in history or survive
  // a reload to re-trigger), so live search params would vanish under us.
  const [deepLink] = useState(() => parseNewTaskParams(search))

  const repo = useRepo()
  const uiState = useUiState()
  // Settings → Agents runner/model policy for this project. `/api/health` is boot-bound and
  // cannot answer these per-project defaults when another project is active (#699).
  const config = useConfig()
  const workspaceConfig = useWorkspaceConfig()

  const { draft, update, submissionPending, mounted } = useNewTaskDraft(draftProjectId, deepLink)
  const sources = useSourceSelection(draft.source, uiState)
  const { source, sourcesReady, skillList } = sources
  const webhook = useNotifyWebhook(urlProjectId)
  const templates = usePromptTemplates({ uiState, source, sourcesReady, draftText: draft.text, submissionPending, update })
  const engine = useEngineSelection(draft, config)
  const accounts = useAccountSelection(engine.displayRunner, draft.agentProfile)
  useProviderReadyFocus(engine.providersReady)

  const hasGit = repo.data === undefined || repo.data.info !== null
  const runMode = routeRunMode({ hasGit, draft, selectedSkill: sources.selectedSkill, workspaceConfig, source })
  const { plan, setPlan, planning, starting, submit, startPlanned } = useNewTaskSubmit({
    draft,
    draftProjectId,
    engine,
    agentProfile: accounts.agentProfile,
    sourcesReady,
    source,
    runMode,
    notifyOn: webhook.notifyOn,
    uiState,
    mounted,
  })
  const autoStarting = useBookmarkletDeepLink({
    deepLink, search, engine, config, draftProjectId, mounted, sourcesReady, skillList, update,
  })
  const compactAgentOptions = useCompactAgentOptions(agentOptionsRef, autoStarting)

  if (autoStarting) return <AutoStartingSurface />

  const { providers, providersReady } = engine
  const mode = draft.planFirst ? COMPOSER_MODE.plan : COMPOSER_MODE.start
  const unavailableReason = providerUnavailableReason(providers)

  return (
    <div
      data-route="new"
      data-plan-review={plan !== null ? 'true' : undefined}
      className="relative isolate flex min-h-full flex-col overflow-x-clip pb-16"
    >

      <div data-slot="new-task-layout" ref={draftPanelRef} style={plan !== null ? { display: 'none' } : undefined} className="relative z-[1] mx-auto w-full max-w-none px-11 pt-12 max-md:px-[18px] max-md:pt-[22px]">
        <NewTaskHeader />

        {draft.retiredVariants ? <RetiredVariantsNotice onUseOneTask={() => update({ retiredVariants: false })} /> : null}

        <Composer
          ref={composerRef}
          onSubmit={submit}
          retainDraftUntilSuccess
          idleFeedback={
            <div data-slot="new-task-mode-note" className="flex items-center justify-between gap-3 text-[11px] text-muted-foreground">
              <span>{mode.note}</span>
              <kbd className="hidden font-sans md:inline">{submitShortcutHint()}</kbd>
            </div>
          }
          pendingLabel={mode.pendingLabel}
          failureHint={mode.failureHint}
          clearOnSuccess={mode.clearOnSuccess}
          onPendingChange={(pending) => { submissionPending.current = pending }}
          value={draft.text}
          onValueChange={(text) => update({ text })}
          autoFocus
          placeholder="Describe a task for the agent — / for skills…"
          ariaLabel="Describe a task for the agent"
          sendAriaLabel={mode.sendAriaLabel}
          disabled={!providersReady || starting}
          disabledReason={unavailableReason}
          autocompleteSkills
          footerStart={
            <ComposerFooterStart
              projects={webhook.projectList}
              urlProjectId={urlProjectId}
              templates={templates}
              onInsertTemplate={(text) => composerRef.current?.insertAtCaret(text)}
              sources={sources}
              onPickSource={(next) => update({ source: next })}
            />
          }
          agentOptions={
            <AgentOptions
              groupRef={agentOptionsRef}
              compact={compactAgentOptions}
              engine={engine}
              accounts={accounts}
              draftEffort={draft.effort}
              update={update}
            />
          }
          executionOptions={
            <ExecutionSettings
              engine={engine}
              draft={draft}
              update={update}
              repo={repo.data}
              hasGit={hasGit}
              runMode={runMode}
              webhook={{ url: webhook.webhookUrl, on: webhook.notifyOn, onChange: webhook.setNotifyChoice }}
              interactiveSkill={sources.selectedSkill?.interactive === true}
              completionDisabled={starting || planning}
            />
          }
          footerEnd={
            <ComposerFooterEnd
              showConfigureProviders={!providersReady && !providers.isPending}
              planFirst={draft.planFirst}
              planning={planning}
              onModeChange={(planFirst) => update({ planFirst })}
            />
          }
        />
        <p data-slot="run-mode-note" className="mt-2.5 text-[13px] text-muted-foreground">
          {composerRunModeNote({ worktree: runMode.worktree, hasGit })}
        </p>

      </div>

      {plan !== null ? (
        <PlanReview
          plan={plan}
          starting={starting}
          startAvailable={providersReady}
          startUnavailableReason={unavailableReason}
          startUnavailableAction={
            !providers.isPending ? (
              <Link to="/settings/agents#providers">Configure providers</Link>
            ) : undefined
          }
          onStepsChange={(steps) => setPlan((current) => (current ? { ...current, steps } : current))}
          onStart={() => void startPlanned()}
          onDiscard={() => {
            setPlan(null)
            requestAnimationFrame(() => draftPanelRef.current?.querySelector('textarea')?.focus())
          }}
        />
      ) : null}
    </div>
  )
}

/** Project, template and source pickers at the head of the composer footer. */
function ComposerFooterStart({
  projects,
  urlProjectId,
  templates,
  onInsertTemplate,
  sources,
  onPickSource,
}: {
  projects: readonly ProjectListEntry[]
  urlProjectId: string | undefined
  templates: readonly PromptTemplate[]
  onInsertTemplate: (text: string) => void
  sources: ReturnType<typeof useSourceSelection>
  onPickSource: (source: TaskSource | null) => void
}) {
  const navigate = useNavigate()
  return (
    <>
      {/* The project pill LEADS the row (mockup new-task-project.html): everything to
          its right is resolved against it, so it reads left-to-right as "in this
          project, run this skill, with this model". Rendered only once the workspace
          actually holds more than one project — with a single one the control offers
          nothing and the composer keeps the shape it has always had, the same rule the
          sidebar's project groups follow. */}
      {projects.length > 1 && urlProjectId !== undefined ? (
        <ProjectPill
          projects={projects}
          projectId={urlProjectId}
          // An explicit `/p/<id>` target: the scoped navigate wrapper passes already
          // scoped paths through untouched, so this is a genuine cross-project jump.
          onPick={(next) => navigate(`/p/${encodeURIComponent(next)}/new`, { replace: true })}
        />
      ) : null}
      <PromptTemplateMenu label="Template" templates={templates} onInsert={onInsertTemplate} />
      <SourcePill
        source={sources.source}
        ready={sources.sourcesReady}
        skills={sources.skillList}
        skillUsage={sources.skillUsage}
        workflows={sources.workflowList}
        onPick={onPickSource}
      />
    </>
  )
}

/**
 * Rank the registry against the pill's search box.
 *
 * Ranked in JS with cmdk's own filtering off (#484 — cmdk's score-sort does not re-order these
 * pickers reliably). Registry order is `lastOpenedAt`, so an empty search shows the same
 * recency the sidebar does; a typed query floats name/id PREFIX matches above mid-string ones,
 * each group still in recency order.
 */
function matchProjects(
  projects: readonly ProjectListEntry[],
  search: string,
): ProjectListEntry[] {
  const query = search.trim().toLowerCase()
  if (query === '') return [...projects]
  const rank = (project: ProjectListEntry): number => {
    const name = project.name.toLowerCase()
    const id = project.id.toLowerCase()
    if (name.startsWith(query) || id.startsWith(query)) return 0
    if (name.includes(query) || id.includes(query)) return 1
    return 2
  }
  return projects
    .map((project, index) => ({ project, rank: rank(project), index }))
    .filter((entry) => entry.rank < 2)
    .sort((a, b) => a.rank - b.rank || a.index - b.index)
    .map((entry) => entry.project)
}

/**
 * The project pill (multi-project spec §"New task"; mockup new-task-project.html) — the
 * composer's scope selector, preselected from the URL.
 *
 * Picking a project NAVIGATES to that project's composer rather than swapping local state:
 * `/p/<id>/new` is the single place the scope is decided (the step-3.2 route gate), and every
 * part of this screen that must re-resolve already keys off it — the skill/workflow picker and
 * `/`-autocomplete (`/api/p/<id>/skills`), the runner and model probes, the base-branch pill,
 * the per-project draft, and the `POST /api/p/<id>/runs` submit target. Doing it any other way
 * would mean a second, parallel notion of "the active project" living in this component.
 *
 * `replace`: a scope swap corrects where you are, it is not a place to go Back to — Back stays
 * whatever brought you to the composer.
 */
function ProjectPill({
  projects,
  projectId,
  onPick,
}: {
  projects: readonly ProjectListEntry[]
  projectId: string
  onPick: (projectId: string) => void
}) {
  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState('')
  const selected = projects.find((project) => project.id === projectId)
  const matched = matchProjects(projects, search)

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        if (!next) setSearch('')
      }}
    >
      <PopoverTrigger asChild>
        <button
          type="button"
          data-slot="project-pill"
          aria-label="Project"
          title="Which project this task runs in — its skills, workflows, settings and draft"
          className={cn(chipClass, 'border-foreground/60 font-semibold text-foreground')}
        >
          <FolderOpenIcon aria-hidden="true" className="size-3 shrink-0 text-soft-foreground" />
          {/* The registry is authoritative for the display name; the raw id is the fallback
              while it is still loading, so the pill never renders an empty label. */}
          <span className="max-w-40 truncate">{selected?.name ?? projectId}</span>
          {chevron}
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        sideOffset={8}
        className="w-[300px] max-w-[calc(100vw-2rem)] p-0"
      >
        <Command shouldFilter={false}>
          <CommandInput placeholder="search projects…" value={search} onValueChange={setSearch} />
          {/* Same 3rem headroom rule as the source picker: the list must not eat the search box. */}
          <CommandList
            data-slot="project-menu"
            className="max-h-[min(18rem,calc(var(--radix-popover-content-available-height)-3rem))]"
          >
            {matched.length === 0 ? <CommandEmpty>Nothing matches.</CommandEmpty> : null}
            {matched.map((project) => (
              <CommandItem
                key={project.id}
                value={project.id}
                keywords={[project.name]}
                data-slot="project-option"
                data-project-id={project.id}
                // A `missing` folder has nothing to run a task in. The entry stays listed (the
                // sidebar owns removing it) but cannot be picked — better than navigating into
                // a project whose every request 4xxs.
                disabled={project.status === 'missing'}
                onSelect={() => {
                  onPick(project.id)
                  setOpen(false)
                }}
              >
                <span className="min-w-0 flex-1 truncate text-xs font-medium">{project.name}</span>
                {project.status === 'missing' ? (
                  <span className="shrink-0 text-[11px] text-soft-foreground">folder not found</span>
                ) : project.branch !== undefined ? (
                  <span className="shrink-0 font-mono text-[11px] text-soft-foreground">
                    {project.branch}
                  </span>
                ) : null}
                {project.id === projectId ? (
                  <CheckIcon aria-hidden="true" className="size-3.5 shrink-0 text-link-foreground" />
                ) : null}
              </CommandItem>
            ))}
          </CommandList>
          {/* The mockup's `dd-note`. Worth the two lines: picking here does far more than
              relabel a pill, and nothing else on screen says so. */}
          <p className="border-t border-border px-3 py-2 text-[11px] leading-snug text-soft-foreground">
            Skills, workflows, settings and the draft re-resolve against the selected project.
          </p>
        </Command>
      </PopoverContent>
    </Popover>
  )
}

/**
 * The workflow/skill picker (#385's searchable cmdk dropdown, #519's tier ordering): ONE pill
 * for both kinds of source — and one that can be EMPTY.
 *
 * `null` — no skill, no workflow — is a first-class state rather than a hidden default. It is
 * what a fresh `/new` opens on, and there are three ways back to it: the ✕ on the pill (one
 * click, no menu), picking the selected row again (the toggle the GitHub hand-off's workflow
 * row already had — this picker was the one that swallowed the second click), and the "No
 * skill" row at the head of the list. Before that the only exit was picking the `quick-task`
 * WORKFLOW, which reads as a third mode to learn rather than as "none of the above" — the
 * report this fixes was a user hunting for it.
 *
 * `quick-task` is therefore not a row of its own: it IS the run an empty picker performs, and
 * one run behind two names is what made the exit invisible. The "No skill" row carries the
 * catalog's own description for it, so a workspace whose file shadows the built-in still
 * describes what it will actually run.
 *
 * Groups render No skill, Most used (skills picked before, frequency descending), Project
 * skills (bold), Workflows, then Global.
 */
function SourcePill({
  source,
  ready,
  skills,
  skillUsage,
  workflows,
  onPick,
}: {
  source: TaskSource | null
  ready: boolean
  skills: readonly Skill[]
  skillUsage: Readonly<Record<string, number>> | undefined
  workflows: readonly WorkflowDef[]
  onPick: (source: TaskSource | null) => void
}) {
  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState('')
  const [preview, setPreview] = useState<Skill | null>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const { mostUsed, project, global, ranked } = searchSkillsForDisplay(skills, search, skillUsage)
  const quickTask = workflows.find((workflow) => workflow.name === QUICK_TASK)
  const matchedWorkflows = searchWorkflows(workflows, search).filter((w) => w.name !== QUICK_TASK)
  // The empty label must announce what the picker actually offers (#263): "Skill" alone hid the
  // workflow rows behind it. Query-independent on purpose — the label states the catalog, not the
  // current filter. No pickable workflow (only the built-in) and the honest label is just "Skill".
  const offersWorkflows = workflows.some((workflow) => workflow.name !== QUICK_TASK)
  // The empty row answers to what people type when they mean "none of these" — including the
  // built-in's own name, which is no longer a row of its own. Same match signal as every other
  // row, so one query ranks the whole list.
  const noneMatches =
    queryScore('no skill', `none plain ${QUICK_TASK} ${quickTask?.description ?? ''}`, search) > 0
  const nothingMatches =
    !noneMatches
    && (ranked ? ranked.length === 0 : mostUsed.length === 0 && project.length === 0 && global.length === 0)
    && matchedWorkflows.length === 0
  const pick = (next: TaskSource | null) => {
    onPick(next)
    setOpen(false)
  }
  /** Picking what is already picked CLEARS it — the gesture every other toggle in the cockpit
   *  answers to, and the one the report asked for by name. */
  const toggle = (next: TaskSource) =>
    pick(source?.source === next.source && source.ref === next.ref ? null : next)

  const skillItem = (skill: Skill, emphasized: boolean) => {
    const selected = source?.source === 'skill' && source.ref === skill.name
    return (
      <CommandItem
        key={skill.path}
        // The path suffix keeps values unique when a project skill shadows a global one.
        value={`skill ${skill.name} ${skill.path}`}
        keywords={skillKeywords(skill.name, skill.description)}
        data-slot="source-option"
        data-source-kind="skill"
        data-source-ref={skill.name}
        onSelect={() => toggle({ source: 'skill', ref: skill.name })}
      >
        <span className={cn('shrink-0 font-mono text-xs', emphasized && 'font-semibold')}>
          {skill.name}
        </span>
        {skill.description ? (
          <span className="min-w-0 flex-1 truncate text-xs text-soft-foreground">
            {skill.description}
          </span>
        ) : null}
        {/* Read-only "View skill" (spec §Skills) — the Settings catalog's detail component
            as a dialog. stopPropagation: viewing must not pick the source. */}
        <button
          type="button"
          data-slot="source-skill-view"
          aria-label={`View skill ${skill.name}`}
          title="View skill"
          onClick={(event) => {
            event.preventDefault()
            event.stopPropagation()
            setPreview(skill)
          }}
          className="ml-auto shrink-0 rounded-sm p-0.5 text-soft-foreground transition-colors hover:text-foreground"
        >
          <EyeIcon aria-hidden="true" className="size-3.5" />
        </button>
        {selected ? <CheckIcon aria-hidden="true" className="size-3.5 shrink-0 text-link-foreground" /> : null}
      </CommandItem>
    )
  }

  const SourceIcon = source === null || source.source === 'skill' ? SparklesIcon : WorkflowIcon
  // The generic label distinguishes an empty choice. Keep its enabled boundary and ink
  // consistent with the other selectors; dashed boundaries mark disabled pills (#171).
  const trigger = (
    <button
      type="button"
      data-slot="source-pill"
      data-source-kind={source?.source ?? 'none'}
      aria-label="Choose a skill or workflow"
      title={
        source === null
          ? 'No skill — the task runs as one plain agent step. Pick a skill or workflow to change that.'
          : `Runs the ${source.source} "${source.ref}" — pick it again, or press ✕, to run without it`
      }
      disabled={!ready}
      onKeyDown={(event) => {
        // A filled pill clears like a token in a tag field. Modifiers stay out of it: ⌘⌫ is a
        // text gesture in the composer this row belongs to, not a picker one.
        if (source === null || event.metaKey || event.ctrlKey || event.altKey) return
        if (event.key !== 'Backspace' && event.key !== 'Delete') return
        event.preventDefault()
        onPick(null)
      }}
      className={cn(
        chipClass,
        'font-mono text-[11px]',
        source === null
          ? 'text-muted-foreground'
          : 'rounded-r-none border-r-0 border-foreground/60 pr-1.5 font-semibold text-foreground',
      )}
    >
      <SourceIcon
        aria-hidden="true"
        className={cn('size-3 shrink-0', source === null ? 'text-muted-foreground' : 'text-accent-icon')}
      />
      <span className="max-w-44 truncate">{!ready ? '…' : (source?.ref ?? (offersWorkflows ? 'Skill or workflow' : 'Skill'))}</span>
      {chevron}
    </button>
  )

  return (
    <>
      <SkillPreviewDialog skill={preview} onClose={() => setPreview(null)} />
      <Popover
        open={open}
        onOpenChange={(next) => {
          setOpen(next)
          if (!next) setSearch('')
        }}
      >
        {/* Split control, not a button inside a button: the trigger owns the menu, the ✕ owns
            the clear, and the seam between them is the ✕'s left border. */}
        <span className="inline-flex items-center">
          <PopoverTrigger asChild>{trigger}</PopoverTrigger>
          {source !== null && ready ? (
            <button
              type="button"
              data-slot="source-pill-clear"
              aria-label={`Clear the ${source.source} ${source.ref}`}
              title="Run without it"
              onClick={() => onPick(null)}
              className={cn(
                chipClass,
                'rounded-l-none border-foreground/60 pl-1.5 pr-2 text-soft-foreground hover:text-foreground',
              )}
            >
              <XIcon aria-hidden="true" className="size-3" />
            </button>
          ) : null}
        </span>
        <PopoverContent
          align="start"
          sideOffset={8}
          className="w-[336px] max-w-[calc(100vw-2rem)] p-0"
        >
          <Command shouldFilter={false}>
            <CommandInput
              placeholder="search skills & workflows…"
              value={search}
              onValueChange={setSearch}
              onInput={() => listRef.current?.scrollTo(0, 0)}
            />
            {/* The 3rem headroom is the CommandInput row: the popper's available-height var
                covers the whole popover, and the list must leave the search box visible. */}
            <CommandList
              ref={listRef}
              data-slot="source-menu"
              className="max-h-[min(18rem,calc(var(--radix-popover-content-available-height)-3rem))]"
            >
              {nothingMatches ? <CommandEmpty>Nothing matches.</CommandEmpty> : null}
              {/* Heading-less and first: "run it plain" is not a kind of skill, and the way out
                  of a selection has to be the thing you see when the list opens. */}
              {noneMatches ? (
                <CommandGroup>
                  <CommandItem
                    value="none no-skill"
                    keywords={['none', 'plain', ...skillKeywords(QUICK_TASK)]}
                    data-slot="source-option"
                    data-source-kind="none"
                    onSelect={() => pick(null)}
                  >
                    <CircleSlashIcon aria-hidden="true" className="size-3.5 shrink-0 text-soft-foreground" />
                    <span className="shrink-0 text-xs font-medium">No skill</span>
                    <span className="min-w-0 flex-1 truncate text-xs text-soft-foreground">
                      {quickTask?.description ?? 'One agent run on your task — no ceremony.'}
                    </span>
                    {source === null ? (
                      <CheckIcon aria-hidden="true" className="ml-auto size-3.5 shrink-0 text-link-foreground" />
                    ) : null}
                  </CommandItem>
                </CommandGroup>
              ) : null}
              {ranked ? (
                ranked.length > 0 ? (
                  <CommandGroup>
                    {ranked.map((skill) => skillItem(skill, isProjectSkill(skill)))}
                  </CommandGroup>
                ) : null
              ) : (
                <>
                  {mostUsed.length > 0 ? (
                    <CommandGroup heading="Most used">
                      {mostUsed.map((skill) => skillItem(skill, isProjectSkill(skill)))}
                    </CommandGroup>
                  ) : null}
                  {project.length > 0 ? (
                    <CommandGroup heading="Project skills">
                      {project.map((skill) => skillItem(skill, true))}
                    </CommandGroup>
                  ) : null}
                </>
              )}
              {matchedWorkflows.length > 0 ? (
                <CommandGroup heading="Workflows">
                  {matchedWorkflows.map((workflow) => {
                    const selected = source?.source === 'workflow' && source.ref === workflow.name
                    return (
                      <CommandItem
                        key={workflow.name}
                        value={`workflow ${workflow.name}`}
                        keywords={skillKeywords(workflow.name, workflow.description)}
                        data-slot="source-option"
                        data-source-kind="workflow"
                        data-source-ref={workflow.name}
                        onSelect={() => toggle({ source: 'workflow', ref: workflow.name })}
                      >
                        <span className="shrink-0 font-mono text-xs">{workflow.name}</span>
                        {workflow.description ? (
                          <span className="min-w-0 flex-1 truncate text-xs text-soft-foreground">
                            {workflow.description}
                          </span>
                        ) : null}
                        {selected ? (
                          <CheckIcon aria-hidden="true" className="ml-auto size-3.5 shrink-0 text-link-foreground" />
                        ) : null}
                      </CommandItem>
                    )
                  })}
                </CommandGroup>
              ) : null}
              {global.length > 0 ? (
                <CommandGroup heading="Global">{global.map((skill) => skillItem(skill, false))}</CommandGroup>
              ) : null}
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>
    </>
  )
}


import { useEffect, useRef, useState } from 'react'
import type { RefObject } from 'react'
import { useDraggable } from '@dnd-kit/core'
import type { Skill, WorkflowDef, WorkflowStepDef } from '@open-mercato/cezar-api-client'
import {
  ArrowDownIcon,
  ArrowUpIcon,
  CheckIcon,
  ChevronDownIcon,
  CopyIcon,
  DownloadIcon,
  EllipsisIcon,
  FileCodeIcon,
  PlusIcon,
  SearchIcon,
  SparklesIcon,
  Trash2Icon,
  UploadIcon,
  WandSparklesIcon,
  XIcon,
} from '@/components/design-icons'
import { SkillEmptyHintCompact } from '@/components/skill-empty-hint'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { isProjectSkill, searchSkills } from '@/lib/skills'
import { cn } from '@/lib/utils'
import { WB_MAX_STEPS } from '@/lib/workflow-builder'

/**
 * The workflow builder's presentational sections, split out of `workflows.tsx` (the hearsay-tools/cezarion#2863
 * complexity split; the file-length pin holds `workflows.tsx` to its extracted size). Each
 * section renders exactly what it rendered inline: same elements, classes, strings and
 * handlers, reached through props. The dnd-kit wiring, mutations and state stay in the
 * builder route.
 */

export type Draft = {
  name: string
  description: string
  steps: WorkflowStepDef[]
}

export type DragItem = { type: 'palette'; skill: string } | { type: 'step'; step: WorkflowStepDef }

/** The workflow picker + name/description form — the editable metadata above the canvas. */
export function WbMetadata({
  workflows,
  draft,
  trimmedName,
  nameRef,
  onDraft,
  onLoadWorkflow,
}: {
  workflows: WorkflowDef[]
  draft: Draft
  trimmedName: string
  nameRef: RefObject<HTMLInputElement | null>
  onDraft: (draft: Draft) => void
  onLoadWorkflow: (workflow: WorkflowDef) => void
}) {
  return (
    <section data-slot="wb-metadata" className="flex min-w-0 flex-col gap-3">
      <div data-slot="wb-load" className="flex flex-col items-start gap-2">
        <label htmlFor="workflow-load" className="text-xs text-muted-foreground">
          Load an existing workflow
        </label>
        <div className="relative max-w-full"><ChevronDownIcon aria-hidden="true" className="pointer-events-none absolute left-3 top-3.5 size-4 text-muted-foreground" />
        <select
          id="workflow-load"
          value={workflows.some((w) => w.name === trimmedName) ? trimmedName : ''}
          onChange={(event) => {
            const workflow = workflows.find((w) => w.name === event.target.value)
            if (workflow) onLoadWorkflow(workflow)
          }}
          className="h-11 max-w-full rounded-lg border border-border bg-card pl-9 pr-3 text-xs font-medium appearance-none focus-visible:outline-2 focus-visible:outline-ring"
        >
          <option value="" disabled>
            Choose a workflow
          </option>
          {workflows.map((workflow) => (
            <option
              key={workflow.name}
              value={workflow.name}
              data-slot="wb-load-option"
              data-name={workflow.name}
            >
              {workflow.name}
            </option>
          ))}
        </select></div>
      </div>
      <label htmlFor="workflow-name" className="text-xs font-semibold">
        Workflow name
      </label>
      <Input
        id="workflow-name"
        ref={nameRef}
        data-slot="wb-name"
        aria-label="Workflow name"
        spellCheck={false}
        value={draft.name}
        onChange={(event) => onDraft({ ...draft, name: event.target.value })}
        className="h-12 bg-card text-sm"
      />
      <label htmlFor="workflow-description" className="text-xs font-semibold">
        Description
      </label>
      <Textarea
        id="workflow-description"
        data-slot="wb-description"
        aria-label="Description"
        value={draft.description}
        onChange={(event) => onDraft({ ...draft, description: event.target.value })}
        className="min-h-[72px] bg-card p-3.5 text-sm"
      />
    </section>
  )
}

/** The Import / Export / Auto / Delete toolbar row. */
export function WbActionsRow({
  savedFile,
  autoOpen,
  onImportToggle,
  onExport,
  onAutoToggle,
  onDeleteRequest,
}: {
  savedFile: WorkflowDef | undefined
  autoOpen: boolean
  onImportToggle: () => void
  onExport: () => void
  onAutoToggle: () => void
  onDeleteRequest: () => void
}) {
  return (
    <div
      data-slot="wb-actions"
      className="grid grid-cols-[max-content_max-content] items-center justify-start gap-2 sm:flex sm:flex-wrap [&_button]:min-h-11 [&_button]:border [&_button]:border-border [&_button]:bg-card"
    >
      <Button
        type="button"
        variant="ghost"
        size="sm"
        data-slot="wb-import"
        className="col-span-2 justify-self-start"
        onClick={onImportToggle}
      >
        <UploadIcon aria-hidden="true" className="size-3" />
        Import
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        data-slot="wb-export"
        className="col-span-2 justify-self-start"
        title="Download workflow.yaml"
        onClick={onExport}
      >
        <DownloadIcon aria-hidden="true" className="size-3" />
        Export
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        data-slot="wb-auto"
        aria-expanded={autoOpen}
        title="Describe a chain — the agent builds it"
        onClick={onAutoToggle}
      >
        <WandSparklesIcon aria-hidden="true" className="size-3" />
        Auto
      </Button>
      {savedFile ? (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          data-slot="wb-delete"
          className="text-danger hover:text-danger"
          title="Delete the saved workflow file"
          onClick={onDeleteRequest}
        >
          <Trash2Icon aria-hidden="true" className="size-3" />
          Delete
        </Button>
      ) : null}
    </div>
  )
}

/** The auto chain creator's prompt panel (hearsay-tools/cezarion#414). */
export function WbAutoPanel({
  text,
  onTextChange,
  pending,
  onRun,
  onCancel,
}: {
  text: string
  onTextChange: (text: string) => void
  pending: boolean
  onRun: () => void
  onCancel: () => void
}) {
  return (
    <div
      data-slot="wb-auto-panel"
      className="rounded-xl border border-border bg-card p-5 [&_button]:min-h-11"
    >
      <h2 className="text-lg font-normal">Build a chain from a prompt</h2>
      <p className="mt-4 text-[13px] leading-relaxed text-muted-foreground">
        Describe the outcome. An agent proposes a title and ordered skill/check steps. Review the result, edit it, then Save.
      </p>
      <Textarea
        data-slot="wb-auto-text"
        aria-label="Describe the chain to build"
        rows={3}
        autoFocus
        placeholder="e.g. Fix the bug, run the tests, then review the diff for regressions."
        value={text}
        onChange={(event) => onTextChange(event.target.value)}
        onKeyDown={(event) => {
          if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
            event.preventDefault()
            onRun()
          }
        }}
        className="mt-4 min-h-[108px] bg-background p-4 text-sm"
      />
      <div className="mt-3 flex items-center gap-1.5">
        <Button
          type="button"
          variant="primary"
          size="sm"
          data-slot="wb-auto-run"
          disabled={pending || text.trim() === ''}
          onClick={onRun}
        >
          <WandSparklesIcon aria-hidden="true" className="size-3" />
          {pending ? 'Building…' : 'Build chain'}
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          data-slot="wb-auto-cancel"
          onClick={onCancel}
        >
          <XIcon aria-hidden="true" className="size-4" />
          Cancel
        </Button>
      </div>
      <p className="mt-4 text-xs text-muted-foreground">
        Creates an editable draft. Review the generated name and steps before saving.
      </p>
    </div>
  )
}

/** The YAML import dialog: paste → `POST /api/workflows/parse` → the canvas. */
export function WbImportDialog({
  open,
  onOpenChange,
  text,
  onTextChange,
  error,
  pending,
  onRun,
  onCancel,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  text: string
  onTextChange: (text: string) => void
  error: string
  pending: boolean
  onRun: () => void
  onCancel: () => void
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent showCloseButton={false}
        data-slot="wb-import-panel"
        className="max-md:translate-x-0 max-md:translate-y-0 sm:max-w-[660px] rounded-xl border border-border bg-card p-5 [&_button]:min-h-11"
      >
        <DialogTitle className="text-xl font-normal">Import workflow YAML</DialogTitle>
        <DialogDescription className="sr-only">Paste a portable workflow definition to import.</DialogDescription>
        <Textarea
          data-slot="wb-import-text"
          aria-label="Workflow YAML to import"
          rows={4}
          spellCheck={false}
          placeholder={'name: my-flow\nskills:\n  - test-conventions\n  - commit-style'}
          value={text}
          onChange={(event) => onTextChange(event.target.value)}
          className="mt-4 min-h-[124px] bg-background p-4 font-mono text-[13px] leading-relaxed"
        />
        <p className="mt-4 text-[13px] text-muted-foreground">Paste a portable workflow definition. Imported steps appear in execution order.</p>
        {error !== '' ? (
          <p data-slot="wb-import-error" role="alert" className="mt-2 text-xs text-danger">
            {error}
          </p>
        ) : null}
        <div className="mt-3 flex items-center gap-1.5">
          <Button
            type="button"
            variant="primary"
            size="sm"
            data-slot="wb-import-run"
            disabled={pending}
            onClick={onRun}
          >
            Import
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            data-slot="wb-import-cancel"
            onClick={onCancel}
          >
            Cancel
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}

/** The skill palette + the disclosed `workflow.yaml` preview. */
export function WbAside({
  paletteSkills,
  query,
  onQueryChange,
  error,
  inFlow,
  onAdd,
  yaml,
}: {
  paletteSkills: Skill[]
  query: string
  onQueryChange: (query: string) => void
  error: string | null
  inFlow: ReadonlySet<string>
  onAdd: (skill: string) => void
  yaml: string
}) {
  return (
    <aside data-slot="wb-aside" className="min-w-0 rounded-xl border border-border bg-card p-5">
      <h2 className="text-[16px] font-semibold">Available skills</h2>
      <div className="sw-search relative mt-4"><SearchIcon aria-hidden="true" className="pointer-events-none absolute left-3 top-3.5 size-4 text-muted-foreground" />
      <Input
        data-slot="wb-filter"
        placeholder="Find a skill…"
        aria-label="Filter skills"
        value={query}
        onChange={(event) => onQueryChange(event.target.value)}
        className="h-11 pl-9 text-xs"
      />
      </div>
      <Palette
        skills={paletteSkills}
        query={query}
        error={error}
        inFlow={inFlow}
        onAdd={onAdd}
      />

      <h3 className="mt-5 text-sm font-semibold">workflow.yaml</h3>
      <p className="mt-3 text-xs leading-relaxed text-muted-foreground">
        Export the workflow to use this chain in another project.
      </p>
      <details className="mt-4 min-w-0">
        <summary
          data-slot="wb-yaml-toggle"
          className="inline-flex min-h-[44px] cursor-pointer items-center rounded-lg border border-border px-3 text-xs font-medium focus-visible:outline-2 focus-visible:outline-ring"
        >
          <FileCodeIcon aria-hidden="true" className="mr-2 size-4" />
          View YAML
        </summary>
        <div className="mt-3 flex justify-end">
          <CopyYamlButton yaml={yaml} />
        </div>
        <pre
          data-slot="wb-yaml"
          className="mt-2 max-h-96 overflow-auto rounded-lg border border-border bg-background p-3 font-mono text-[11px] leading-relaxed whitespace-pre text-muted-foreground"
        >
          {yaml}
        </pre>
      </details>
    </aside>
  )
}

/** What the pointer carries mid-drag: a copy of the pill/card, per dnd-kit. */
export function WbDragPreview({
  dragging,
  steps,
  skills,
}: {
  dragging: DragItem | null
  steps: WorkflowStepDef[]
  skills: readonly Skill[]
}) {
  if (dragging?.type === 'palette') {
    return (
      <div className="flex items-center gap-2 rounded-md border border-border bg-card px-2.5 py-1.5 font-mono text-[13px] font-medium shadow-md">
        <SparklesIcon aria-hidden="true" className="size-3.5 text-link-foreground" />
        {dragging.skill}
      </div>
    )
  }
  if (dragging?.type === 'step') {
    return (
      <StepCardBody
        step={dragging.step}
        index={steps.findIndex((s) => s.id === dragging.step.id)}
        skills={skills}
        overlay
      />
    )
  }
  return null
}

/** The Add step picker dialog: filter → radio list → append to the canvas. */
export function WbAddStepDialog({
  open,
  onOpenChange,
  query,
  onQueryChange,
  matches,
  skillsCount,
  error,
  selectedSkill,
  onSelectSkill,
  stepsCount,
  onCloseAutoFocus,
  onCancel,
  onAdd,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  query: string
  onQueryChange: (query: string) => void
  matches: Skill[]
  skillsCount: number
  error: string | null
  selectedSkill: string | null
  onSelectSkill: (skill: string | null) => void
  stepsCount: number
  onCloseAutoFocus: (event: Event) => void
  onCancel: () => void
  onAdd: (skill: string) => void
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent data-slot="wb-add-dialog" onCloseAutoFocus={onCloseAutoFocus} className="max-h-[85dvh] overflow-y-auto sm:max-w-[660px] [&_button]:min-h-11">
        <DialogHeader>
          <DialogTitle className="text-xl font-normal">Add step</DialogTitle>
          <DialogDescription className="sr-only">Choose a skill to append to this workflow.</DialogDescription>
        </DialogHeader>
        <Input aria-label="Filter skills" placeholder="Filter skills…" value={query} onChange={(event) => onQueryChange(event.target.value)} />
        {error !== null ? <p role="alert" className="text-sm text-danger">Could not load skills: {error}</p> : (
          <div role="radiogroup" aria-label="Available skills" className="grid max-h-80 gap-2 overflow-y-auto">
            {matches.map((skill) => (
              <label key={skill.name} className="flex cursor-pointer items-start gap-3 rounded-lg py-2 has-[:checked]:bg-accent-strong/10 has-[:focus-visible]:outline-2">
                <input type="radio" name="workflow-add-skill" className="sr-only" value={skill.name} checked={selectedSkill === skill.name} onChange={() => onSelectSkill(skill.name)} />
                <span className="min-w-0 break-words text-sm"><span className="block">{skill.name}</span><span className="mt-2 block text-xs text-muted-foreground">{skill.description}</span></span>
              </label>
            ))}
            {matches.length === 0 ? <p className="text-sm text-muted-foreground">{skillsCount === 0 ? 'No skills available in this project.' : 'No matching skills.'}</p> : null}
          </div>
        )}
        <div className="flex flex-wrap gap-3">
          <Button variant="outline" onClick={onCancel}>Cancel</Button>
          <Button variant="primary" disabled={!selectedSkill || stepsCount >= WB_MAX_STEPS} onClick={() => { if (selectedSkill) onAdd(selectedSkill) }}>Add selected skill</Button>
        </div>
        <p className="text-xs text-muted-foreground">Append the selected skill, then reorder it in the existing canvas.</p>
        {stepsCount >= WB_MAX_STEPS ? <p role="status" className="text-sm text-muted-foreground">A workflow can contain up to {WB_MAX_STEPS} steps. Remove a step before adding another.</p> : null}
      </DialogContent>
    </Dialog>
  )
}

/** Save-over (409 `exists`) and delete confirms — legacy `confirm()`, as dialogs. */
export function WbConfirmDialogs({
  trimmedName,
  savedFile,
  overwriteOpen,
  onOverwriteDismiss,
  deleteOpen,
  onDeleteDismiss,
  onOverwrite,
  onDelete,
}: {
  trimmedName: string
  savedFile: WorkflowDef | undefined
  overwriteOpen: boolean
  onOverwriteDismiss: () => void
  deleteOpen: boolean
  onDeleteDismiss: () => void
  onOverwrite: () => void
  onDelete: () => void
}) {
  return (
    <>
      <AlertDialog open={overwriteOpen} onOpenChange={(open) => !open && onOverwriteDismiss()}>
        <AlertDialogContent data-slot="wb-overwrite-dialog" className="sw-workflow-confirm sm:max-w-[660px]">
          <AlertDialogHeader>
            <AlertDialogTitle>&ldquo;{trimmedName}&rdquo; already exists</AlertDialogTitle>
            <AlertDialogDescription>
              Saving overwrites the existing workflow file. There is no undo.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep the file</AlertDialogCancel>
            <AlertDialogAction data-slot="wb-overwrite-confirm" className="bg-danger text-danger-foreground" onClick={onOverwrite}>
              Overwrite
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={deleteOpen} onOpenChange={(open) => !open && onDeleteDismiss()}>
        <AlertDialogContent data-slot="wb-delete-dialog" className="sw-workflow-confirm sm:max-w-[660px]">
          <AlertDialogHeader>
            <AlertDialogTitle>Delete workflow &ldquo;{trimmedName}&rdquo;?</AlertDialogTitle>
            <AlertDialogDescription>
              Removes {savedFile?.path?.split('/').pop() ?? 'the saved file'} from{' '}
              <span className="font-mono">.ai/cezar/workflows/</span>. There is no undo.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep the file</AlertDialogCancel>
            <AlertDialogAction
              data-slot="wb-delete-confirm"
              className="bg-danger text-danger-foreground hover:brightness-[0.96]"
              onClick={onDelete}
            >
              Delete workflow
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}

/** `name ?? skill ?? id` — the card title, the legacy fallback chain. */
function stepTitle(step: WorkflowStepDef): string {
  return step.name ?? step.skill ?? step.id
}

/** The prompt the step really runs: the plain `{{task}}` placeholder is not worth showing. */
function stepSpecificPrompt(step: WorkflowStepDef): string | undefined {
  return step.prompt?.trim() === '{{task}}' ? undefined : step.prompt?.trim()
}

/** The `$ command` summary, with the retry policy appended when the step declares one. */
function stepCommandSummary(step: WorkflowStepDef): string {
  const onFail = step.onFail
    ? ` — on fail retry from "${step.onFail.retry}" (×${step.onFail.max ?? 2})`
    : ''
  return `$ ${step.command}${onFail}`
}

/** A skill step's summary: its specific prompt, else the skill catalog's description. */
function stepSkillSummary(step: WorkflowStepDef, known: Skill | undefined): string {
  return (
    stepSpecificPrompt(step) ||
    known?.description ||
    'Not in this repo or the team skills — the step runs on its plain prompt.'
  )
}

/** The card's summary line: the command, the skill description, or the raw prompt. */
function stepDescription(step: WorkflowStepDef, known: Skill | undefined): string {
  if (step.command) return stepCommandSummary(step)
  if (step.skill) return stepSkillSummary(step, known)
  return step.prompt ?? ''
}

/** The `unknown` badge for a skill step whose skill the catalog does not know. */
function stepBadge(step: WorkflowStepDef, known: Skill | undefined): 'unknown' | null {
  return step.skill && !known ? 'unknown' : null
}

/** The one-word kind line under the summary. */
function stepKindLabel(step: WorkflowStepDef): string {
  if (step.command) {
    return `Command step${step.onFail ? ` · Retry ×${step.onFail.max ?? 2}` : ''}`
  }
  return step.skill ? 'Skill step' : 'Prompt step'
}

/** The card's heading row: the drag grip, the title, the unknown badge, the actions menu. */
function StepCardHeading({
  index,
  title,
  badge,
  onRemove,
  gripProps,
}: {
  index: number
  title: string
  badge: 'unknown' | null
  onRemove?: (() => void) | undefined
  gripProps?: Record<string, unknown> | undefined
}) {
  return (
    <div data-slot="wb-step-heading" className="flex min-w-0 items-center gap-2.5">
      <button
        type="button"
        data-slot="wb-step-grip"
        aria-label={`Reorder step ${index + 1}: ${title}`}
        className="inline-flex size-[26px] shrink-0 cursor-grab items-center justify-center rounded-md text-muted-foreground transition-colors outline-none hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50"
        {...gripProps}
      >
        <span className="rounded bg-accent-strong/10 px-2 py-1 font-mono text-[12px] text-link-foreground">{String(index + 1).padStart(2, '0')}</span>
      </button>
      <div className="min-w-0 flex-1 break-words text-sm font-medium [overflow-wrap:anywhere]">{title}</div>
      {badge ? (
        <span
          data-slot="wb-step-badge"
          className={cn(
            'shrink-0 rounded-full border px-2 py-px font-mono text-[11px]',
            badge === 'unknown' && 'border-danger/35 text-danger',
          )}
        >
          {badge}
        </span>
      ) : null}
      {onRemove ? (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button data-slot="wb-step-actions" variant="ghost" size="icon" className="size-[26px]" aria-label={`Step ${index + 1} actions: ${title}`}>
              <EllipsisIcon aria-hidden="true" className="size-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem data-slot="wb-step-remove" aria-label={`Remove step ${index + 1}: ${title}`} onSelect={onRemove}>
              <Trash2Icon aria-hidden="true" /> Remove step
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      ) : null}
    </div>
  )
}

/** Move up/down for narrow screens — the no-drag reorder path. */
function StepMoveButtons({
  index,
  onMoveUp,
  onMoveDown,
}: {
  index: number
  onMoveUp?: (() => void) | undefined
  onMoveDown?: (() => void) | undefined
}) {
  return (
    <div className="mt-3 flex flex-wrap gap-2 @min-[900px]:hidden">
      <Button
        variant="outline"
        size="sm"
        className="min-h-11"
        aria-label={`Move step ${index + 1} up`}
        disabled={!onMoveUp}
        onClick={onMoveUp}
      >
        <ArrowUpIcon aria-hidden="true" className="size-4" />
        Move up
      </Button>
      <Button
        variant="outline"
        size="sm"
        className="min-h-11"
        aria-label={`Move step ${index + 1} down`}
        disabled={!onMoveDown}
        onClick={onMoveDown}
      >
        <ArrowDownIcon aria-hidden="true" className="size-4" />
        Move down
      </Button>
    </div>
  )
}

/**
 * The card itself, shared with the DragOverlay (which renders it detached — no sortable hooks).
 * `gripProps` carries dnd-kit's `attributes` (role, tabIndex, aria) onto the grip button so the
 * keyboard path lifts from a real focusable control.
 */
export function StepCardBody({
  step,
  index,
  skills,
  onRemove,
  gripProps,
  onMoveUp,
  onMoveDown,
  overlay = false,
}: {
  step: WorkflowStepDef
  index: number
  skills: readonly Skill[]
  onRemove?: (() => void) | undefined
  onMoveUp?: (() => void) | undefined
  onMoveDown?: (() => void) | undefined
  gripProps?: Record<string, unknown>
  overlay?: boolean
}) {
  const known = skills.find((skill) => skill.name === step.skill)
  const title = stepTitle(step)
  const description = stepDescription(step, known)
  const badge = stepBadge(step, known)

  return (
    <div
      data-slot="wb-step"
      data-id={step.id}
      data-index={index}
      className={cn(
        // `bg-card-2` + a slightly stronger border: a white-on-white card with a `#ebebeb`
        // border all but vanished on the light page (the workflows low-contrast finding).
        'rounded-lg border border-border bg-background p-4',
        overlay && 'shadow-md',
      )}
    >
      <StepCardHeading index={index} title={title} badge={badge} onRemove={onRemove} gripProps={gripProps} />
      {description ? (
        <div
          data-slot="wb-step-summary"
          className="mt-3 break-words text-xs leading-relaxed text-muted-foreground"
        >
          {description}
        </div>
      ) : null}
      <p data-slot="wb-step-kind" className="mt-3 text-[12px] text-link-foreground">
        {stepKindLabel(step)}
      </p>
      {!overlay ? (
        <StepMoveButtons index={index} onMoveUp={onMoveUp} onMoveDown={onMoveDown} />
      ) : null}
    </div>
  )
}

function Palette({
  skills,
  query,
  error,
  inFlow,
  onAdd,
}: {
  skills: readonly Skill[]
  query: string
  error: string | null
  inFlow: ReadonlySet<string>
  onAdd: (skill: string) => void
}) {
  if (error !== null) {
    return (
      <p data-slot="wb-palette" className="mt-2.5 text-xs text-danger">
        Could not load skills: {error}
      </p>
    )
  }
  const shown = searchSkills(skills, query)
  return (
    <div data-slot="wb-palette" className="mt-2.5 flex flex-col gap-1">
      {shown.length > 0 ? (
        shown.map((skill) => (
          <PaletteSkill key={skill.path} skill={skill} inFlow={inFlow.has(skill.name)} onAdd={onAdd} />
        ))
      ) : (
        <p className="py-1 text-xs leading-relaxed text-soft-foreground">
          {skills.length > 0 ? 'No skills match.' : <SkillEmptyHintCompact />}
        </p>
      )}
    </div>
  )
}

/** A palette pill: a dnd-kit drag source that COPIES into the flow, plus an explicit add
 *  button — the same insert without a pointer (and what tests exercise deterministically). */
function PaletteSkill({
  skill,
  inFlow,
  onAdd,
}: {
  skill: Skill
  inFlow: boolean
  onAdd: (skill: string) => void
}) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: `palette:${skill.name}`,
    data: { type: 'palette', skill: skill.name } satisfies DragItem,
  })
  return (
    <div
      ref={setNodeRef}
      data-slot="wb-skill"
      data-skill={skill.name}
      data-in-flow={inFlow || undefined}
      title={skill.description ?? ''}
      className={cn(
        'flex min-h-11 cursor-grab items-center gap-2 rounded-md py-1 transition-colors hover:bg-muted',
        isDragging && 'opacity-40',
      )}
      {...attributes}
      {...listeners}
    >
      <span
        className={cn(
          'min-w-0 flex-1 break-words text-xs',
          isProjectSkill(skill) ? 'font-semibold text-foreground' : 'font-medium text-muted-foreground',
        )}
      >
        {skill.name}
      </span>
      <button
        type="button"
        data-slot="wb-skill-add"
        aria-label={`Add ${skill.name} to the flow`}
        title="Add to the flow"
        onClick={() => onAdd(skill.name)}
        className="inline-flex size-11 shrink-0 items-center justify-center rounded-md text-link-foreground transition-colors outline-none hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50"
      >
        <PlusIcon aria-hidden="true" className="size-3.5" />
      </button>
    </div>
  )
}

/** Copy flips to "✓ Copied" for a beat — the legacy `wbCopy` affordance. */
function CopyYamlButton({ yaml }: { yaml: string }) {
  const [copied, setCopied] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(
    () => () => {
      if (timer.current !== null) clearTimeout(timer.current)
    },
    [],
  )
  return (
    <button
      type="button"
      data-slot="wb-copy"
      title="Copy the YAML"
      onClick={() => {
        void navigator.clipboard?.writeText(yaml).catch(() => {})
        setCopied(true)
        if (timer.current !== null) clearTimeout(timer.current)
        timer.current = setTimeout(() => setCopied(false), 1600)
      }}
      className="flex items-center gap-1 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
    >
      {copied ? (
        <>
          <CheckIcon aria-hidden="true" className="size-3 text-success" />
          Copied
        </>
      ) : (
        <>
          <CopyIcon aria-hidden="true" className="size-3" />
          Copy
        </>
      )}
    </button>
  )
}

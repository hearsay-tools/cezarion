import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
} from '@dnd-kit/core'
import type { DragEndEvent, DragOverEvent, DragStartEvent } from '@dnd-kit/core'
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import {
  CheckIcon,
  CopyIcon,
  DownloadIcon,
  EllipsisIcon,
  PlusIcon,
  SparklesIcon,
  Trash2Icon,
  TriangleAlertIcon,
  UploadIcon,
  WandSparklesIcon,
} from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { useParams } from 'react-router'

import { ApiError, createWorkflow, deleteWorkflow, parseWorkflow, postPlan } from '@/api/client'
import { queryKeys, useSkills, useUiState, useWorkflows } from '@/api/queries'
import type { Skill, WorkflowDef, WorkflowStepDef } from '@open-mercato/cezar-api-client'
import { CenteredState } from '@/components/centered-state'
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
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { toast } from '@/components/ui/toaster'
import { isProjectSkill, orderSkillsByUsage } from '@/lib/skills'
import { cn } from '@/lib/utils'
import {
  WB_MAX_STEPS,
  draftFromPlan,
  insertStep,
  moveStep,
  removeStep,
  saveBody,
  skillStep,
  stepCountLabel,
  workflowSlug,
  workflowYaml,
} from '@/lib/workflow-builder'

import { WorkflowsLoading } from './workflows-loading'

/**
 * `/workflows` — the workflow builder rebuilt in React (R6 Step 1.6, spec §"Skills, Workflows,
 * Inbox"): same canvas, drag, YAML import/export, and eight-step limit as spec 012.
 * The design.pen layout groups editable metadata above the step editor, with a native workflow
 * selector, a disclosed YAML preview, and explicit reorder buttons on narrow screens.
 *
 * Existing workflow operations:
 *  - first visit seeds the canvas with the repo's first saved (file) workflow; `/workflows/:name`
 *    deep-links any workflow into the canvas;
 *  - palette skills COPY in (drag, or the keyboard/click "add" affordance); step cards MOVE;
 *  - a pure skill stack previews/saves in the portable compact `skills:` YAML form, anything
 *    richer in full `steps:` (lib/workflow-builder mirrors the server's `skillStackOf`);
 *  - Import → `POST /api/workflows/parse` (the server owns YAML), Save → `POST /api/workflows`
 *    with the 409-overwrite confirm, Delete → `DELETE /api/workflows/:name` (file workflows
 *    only), Export → a `<slug>.yaml` download, Copy → clipboard;
 *  - the 8-step limit answers a toast, exactly where the legacy `alertBar` fired.
 *
 * Drag is dnd-kit throughout: PointerSensor with a small activation distance (so plain clicks
 * on the cards' buttons stay clicks) + KeyboardSensor with the sortable coordinate getter —
 * keyboard-accessible reorder per dnd-kit defaults (focus a grip, Space lifts, arrows move,
 * Space drops).
 */

/** The canvas droppable's id — palette drops on it (not on a card) append at the end. */
const CANVAS_ID = 'wb-canvas'

type Draft = {
  name: string
  description: string
  steps: WorkflowStepDef[]
}

type DragItem = { type: 'palette'; skill: string } | { type: 'step'; step: WorkflowStepDef }

function emptyDraft(): Draft {
  return { name: 'my-workflow', description: '', steps: [] }
}

function draftFrom(workflow: WorkflowDef): Draft {
  return {
    name: workflow.name,
    description: workflow.description ?? '',
    steps: structuredClone(workflow.steps ?? []),
  }
}

export function WorkflowsRoute() {
  const { name } = useParams<{ name: string }>()
  // Key the builder by the deep-linked name: navigating between /workflows/:name links resets
  // the canvas to that workflow, while in-page edits (chips) stay plain state like legacy.
  return <WorkflowsBuilder key={name ?? ''} routeName={name} />
}

function WorkflowsBuilder({ routeName }: { routeName: string | undefined }) {
  const workflowsQuery = useWorkflows()
  const skillsQuery = useSkills()
  const uiStateQuery = useUiState()
  const queryClient = useQueryClient()

  const [draft, setDraft] = useState<Draft | null>(null)
  const [query, setQuery] = useState('')
  const [addOpen, setAddOpen] = useState(false)
  const [addQuery, setAddQuery] = useState('')
  const [selectedSkill, setSelectedSkill] = useState<string | null>(null)
  const [importOpen, setImportOpen] = useState(false)
  const [importText, setImportText] = useState('')
  const [importError, setImportError] = useState('')
  const [autoOpen, setAutoOpen] = useState(false)
  const [autoText, setAutoText] = useState('')
  const [confirmOverwrite, setConfirmOverwrite] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [dragging, setDragging] = useState<DragItem | null>(null)
  // The step id (or CANVAS_ID) the pointer is over mid-drag — drives the "drop to insert"
  // indicator between cards, the affordance the legacy `.wb-gap` slots gave (#wb-drop-line).
  const [overId, setOverId] = useState<string | null>(null)
  const nameInput = useRef<HTMLInputElement>(null)
  const addStepButton = useRef<HTMLButtonElement>(null)

  const workflows = workflowsQuery.data?.workflows ?? []
  const skills = skillsQuery.data ?? []
  // The palette lists skills the way every other picker does (#519): most-used first, then
  // project, then global — so what you reach for floats to the top.
  const paletteSkills = orderSkillsByUsage(skills, uiStateQuery.data?.skillUsage)

  // First visit seeds the canvas with the deep-linked workflow when the URL names one, else
  // the repo's first saved workflow — "open the tab, see your flow" (legacy rule). No files
  // yet → an empty canvas + the drop hint.
  useEffect(() => {
    if (draft !== null || workflowsQuery.data === undefined) return
    const list = workflowsQuery.data.workflows
    const wanted =
      (routeName ? list.find((w) => w.name === routeName) : undefined) ??
      list.find((w) => w.source === 'file')
    setDraft(wanted ? draftFrom(wanted) : emptyDraft())
  }, [draft, workflowsQuery.data, routeName])

  const setSteps = (steps: WorkflowStepDef[]) =>
    setDraft((current) => (current === null ? current : { ...current, steps }))

  const importMutation = useMutation({
    mutationFn: (yaml: string) => parseWorkflow(yaml),
    onSuccess: (parsed) => {
      setDraft({ name: parsed.name, description: parsed.description ?? '', steps: parsed.steps })
      setImportOpen(false)
      setImportText('')
      setImportError('')
      toast(`Imported "${parsed.name}" — review, then Save.`)
    },
    onError: (error) => setImportError(error.message),
  })

  // Auto chain creator (#414): the planner turns a plain-language brief into a proposed chain
  // (title + steps) and drops it straight onto the canvas to review, tweak and Save. It never
  // hard-fails — a degraded answer comes back as a one-step plan with `fallback: true`, which we
  // surface as a dim note instead of an error.
  const autoPlan = useMutation({
    mutationFn: (task: string) => postPlan(task),
    onSuccess: (plan) => {
      setDraft((current) => {
        const base = current ?? emptyDraft()
        const { name, steps } = draftFromPlan(plan, base.name)
        return { ...base, name, steps }
      })
      setAutoOpen(false)
      setAutoText('')
      toast(
        plan.fallback
          ? 'Planner unavailable — added a single step. Edit, then Save.'
          : `Built "${plan.name ?? draft?.name ?? 'workflow'}" — review, tweak, then Save.`,
        plan.fallback ? { tone: 'danger' } : undefined,
      )
    },
    onError: (error) => toast(error instanceof Error ? error.message : String(error), { tone: 'danger' }),
  })

  const save = useMutation({
    mutationFn: (overwrite: boolean) =>
      createWorkflow({
        ...saveBody(draft?.name ?? '', draft?.description ?? '', draft?.steps ?? []),
        ...(overwrite ? { overwrite: true } : {}),
      }),
    onSuccess: (saved) => {
      setConfirmOverwrite(false)
      toast(`Saved — ${saved.path.split('/').pop() ?? saved.path}`)
      // The chips + the Delete button now reflect the file (and the /new picker lists it).
      void queryClient.invalidateQueries({ queryKey: queryKeys.workflows })
    },
    onError: (error) => {
      if (error instanceof ApiError && error.exists === true) setConfirmOverwrite(true)
      else toast(error instanceof Error ? error.message : String(error), { tone: 'danger' })
    },
  })

  const del = useMutation({
    mutationFn: (workflowName: string) => deleteWorkflow(workflowName),
    onSuccess: (_, workflowName) => {
      setConfirmDelete(false)
      toast(`Deleted "${workflowName}".`)
      setDraft(emptyDraft())
      void queryClient.invalidateQueries({ queryKey: queryKeys.workflows })
    },
    onError: (error) => {
      setConfirmDelete(false)
      toast(error instanceof Error ? error.message : String(error), { tone: 'danger' })
    },
  })

  // dnd-kit defaults on purpose: the small pointer distance keeps card buttons clickable, the
  // sortable coordinate getter is what makes Space/arrows/Space reorder work.
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  )

  if (workflowsQuery.isError) {
    return (
      <div
        data-route="workflows"
        className="@container mx-auto min-h-full w-full max-w-[calc(var(--measure)+72px)] px-[18px] py-6 md:p-9"
      >
        <CenteredState
          icon={<TriangleAlertIcon />}
          tone="danger"
          title="Could not load workflows"
          subtitle={workflowsQuery.error.message}
        />
      </div>
    )
  }
  if (draft === null) return <WorkflowsLoading />

  const steps = draft.steps
  const trimmedName = draft.name.trim()
  const savedFile = workflows.find((w) => w.name === trimmedName && w.source === 'file')
  const yaml = workflowYaml(draft.name, draft.description, steps)

  /** Palette → canvas, at `at` (or the end). One rule for drop, click and keyboard: the
   *  server's 8-step limit answers a toast, never a silent no-op. */
  const addSkill = (skill: string, at = steps.length) => {
    if (steps.length >= WB_MAX_STEPS) {
      toast(`A workflow holds at most ${WB_MAX_STEPS} steps.`, { tone: 'danger' })
      return
    }
    setSteps(insertStep(steps, skillStep(skill, steps), at))
  }

  const handleDragStart = (event: DragStartEvent) => {
    const data = event.active.data.current as DragItem | undefined
    setDragging(data ?? null)
  }

  const handleDragOver = (event: DragOverEvent) => {
    setOverId(event.over ? String(event.over.id) : null)
  }

  const handleDragEnd = (event: DragEndEvent) => {
    setDragging(null)
    setOverId(null)
    const { active, over } = event
    if (over === null) return
    const data = active.data.current as DragItem | undefined
    if (data?.type === 'palette') {
      // A drop on a card inserts before it; a drop on the canvas itself appends.
      const at = over.id === CANVAS_ID ? steps.length : steps.findIndex((s) => s.id === over.id)
      addSkill(data.skill, at === -1 ? steps.length : at)
      return
    }
    if (over.id === active.id) return
    const from = steps.findIndex((s) => s.id === active.id)
    const to = steps.findIndex((s) => s.id === over.id)
    if (from !== -1 && to !== -1) setSteps(moveStep(steps, from, to))
  }

  const runImport = () => {
    const text = importText.trim()
    if (text === '') return
    importMutation.mutate(text)
  }

  const runAuto = () => {
    const text = autoText.trim()
    if (text === '' || autoPlan.isPending) return
    autoPlan.mutate(text)
  }

  const runSave = () => {
    if (trimmedName === '') {
      nameInput.current?.focus()
      return
    }
    if (steps.length === 0) {
      toast('Add at least one step first.', { tone: 'danger' })
      return
    }
    save.mutate(false)
  }

  const exportYaml = () => {
    const blob = new Blob([yaml], { type: 'text/yaml' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `${workflowSlug(draft.name)}.yaml`
    document.body.appendChild(a)
    a.click()
    a.remove()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  }

  return (
    <div
      data-route="workflows"
      className="@container mx-auto min-h-full w-full max-w-[calc(var(--measure)+72px)] px-[18px] py-6 md:p-9"
    >
      <header className="mb-[22px] flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-[30px] font-semibold tracking-tight">Workflows</h1>
          <p className="mt-1 text-[13px] text-muted-foreground">
            Portable skill chains. Steps run from top to bottom.
          </p>
        </div>
        <Button
          variant="primary"
          data-slot="wb-new"
          className="min-h-11"
          onClick={() => setDraft(emptyDraft())}
        >
          <PlusIcon aria-hidden="true" className="size-4" />
          New workflow
        </Button>
      </header>

      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        onDragStart={handleDragStart}
        onDragOver={handleDragOver}
        onDragEnd={handleDragEnd}
        onDragCancel={() => {
          setDragging(null)
          setOverId(null)
        }}
      >
        <div className="flex min-w-0 flex-col gap-[22px] pb-[calc(32px+env(safe-area-inset-bottom))]">
          <section data-slot="wb-metadata" className="flex min-w-0 flex-col gap-3">
            <div data-slot="wb-load" className="flex flex-col items-start gap-2">
              <label htmlFor="workflow-load" className="text-xs text-muted-foreground">
                Load an existing workflow
              </label>
              <select
                id="workflow-load"
                value={workflows.some((w) => w.name === trimmedName) ? trimmedName : ''}
                onChange={(event) => {
                  const workflow = workflows.find((w) => w.name === event.target.value)
                  if (workflow) setDraft(draftFrom(workflow))
                }}
                className="h-11 max-w-full rounded-lg border border-border bg-card px-3 text-[13px] focus-visible:outline-2 focus-visible:outline-ring"
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
              </select>
            </div>
            <label htmlFor="workflow-name" className="text-xs font-semibold">
              Workflow name
            </label>
            <Input
              id="workflow-name"
              ref={nameInput}
              data-slot="wb-name"
              aria-label="Workflow name"
              spellCheck={false}
              value={draft.name}
              onChange={(event) => setDraft({ ...draft, name: event.target.value })}
              className="h-12 bg-card text-sm"
            />
            <label htmlFor="workflow-description" className="text-xs font-semibold">
              Description
            </label>
            <Textarea
              id="workflow-description"
              data-slot="wb-description"
              value={draft.description}
              onChange={(event) => setDraft({ ...draft, description: event.target.value })}
              rows={2}
              className="min-h-12 bg-card text-[13px]"
            />
          </section>
          <div
            data-slot="wb-actions"
            className="flex flex-wrap items-center gap-2 [&_button]:min-h-11 [&_button]:border [&_button]:border-border [&_button]:bg-card"
          >
            <Button
              type="button"
              variant="ghost"
              size="sm"
              data-slot="wb-import"
              onClick={() => {
                setImportError('')
                setAutoOpen(false)
                setImportOpen((open) => !open)
              }}
            >
              <UploadIcon aria-hidden="true" className="size-3" />
              Import
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              data-slot="wb-export"
              title="Download workflow.yaml"
              onClick={exportYaml}
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
              onClick={() => {
                setImportOpen(false)
                setAutoOpen((open) => !open)
              }}
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
                onClick={() => setConfirmDelete(true)}
              >
                <Trash2Icon aria-hidden="true" className="size-3" />
                Delete
              </Button>
            ) : null}
          </div>
          {autoOpen ? (
            <div
              data-slot="wb-auto-panel"
              className="rounded-xl border border-border bg-card p-5 [&_button]:min-h-11"
            >
              <h2 className="text-[15px] font-semibold">Build a chain from a prompt</h2>
              <p className="mt-1 text-xs leading-relaxed text-soft-foreground">
                Describe what the chain should do. An agent proposes a title and an ordered set of skill /
                check steps. Review the result, edit it, then Save.
              </p>
              <Textarea
                data-slot="wb-auto-text"
                aria-label="Describe the chain to build"
                rows={3}
                autoFocus
                placeholder="e.g. Fix the bug, run the tests, then review the diff for regressions."
                value={autoText}
                onChange={(event) => setAutoText(event.target.value)}
                onKeyDown={(event) => {
                  if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
                    event.preventDefault()
                    runAuto()
                  }
                }}
                className="mt-4 min-h-[108px] text-[13px]"
              />
              <div className="mt-3 flex items-center gap-1.5">
                <Button
                  type="button"
                  variant="primary"
                  size="sm"
                  data-slot="wb-auto-run"
                  disabled={autoPlan.isPending || autoText.trim() === ''}
                  onClick={runAuto}
                >
                  <WandSparklesIcon aria-hidden="true" className="size-3" />
                  {autoPlan.isPending ? 'Building…' : 'Build chain'}
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  data-slot="wb-auto-cancel"
                  onClick={() => {
                    setAutoOpen(false)
                    setAutoText('')
                  }}
                >
                  Cancel
                </Button>
              </div>
              <p className="mt-4 text-xs text-muted-foreground">
                Creates an editable draft. Review the generated name and steps before saving.
              </p>
            </div>
          ) : null}

          {importOpen ? (
            <div
              data-slot="wb-import-panel"
              className="rounded-xl border border-border bg-card p-5 [&_button]:min-h-11"
            >
              <h2 className="text-xl font-normal">Import workflow YAML</h2>
              <Textarea
                data-slot="wb-import-text"
                aria-label="Workflow YAML to import"
                rows={6}
                spellCheck={false}
                placeholder={'name: my-flow\nskills:\n  - test-conventions\n  - commit-style'}
                value={importText}
                onChange={(event) => setImportText(event.target.value)}
                className="mt-4 min-h-32 bg-background p-4 font-mono text-[13px] leading-relaxed"
              />
              <p className="mt-4 text-[13px] text-muted-foreground">Paste a portable workflow definition. Imported steps appear in execution order.</p>
              {importError !== '' ? (
                <p data-slot="wb-import-error" role="alert" className="mt-2 text-xs text-danger">
                  {importError}
                </p>
              ) : null}
              <div className="mt-3 flex items-center gap-1.5">
                <Button
                  type="button"
                  variant="primary"
                  size="sm"
                  data-slot="wb-import-run"
                  disabled={importMutation.isPending}
                  onClick={runImport}
                >
                  Import
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  data-slot="wb-import-cancel"
                  onClick={() => {
                    setImportOpen(false)
                    setImportText('')
                    setImportError('')
                  }}
                >
                  Cancel
                </Button>
              </div>
            </div>
          ) : null}

          <div className="grid min-w-0 items-start gap-[22px] @min-[700px]:grid-cols-[minmax(0,1fr)_260px]">
            <section data-slot="wb-main" className="min-w-0 rounded-xl border border-border bg-card p-5">
              <p className="text-xs text-muted-foreground">
                Steps · {steps.length} of {WB_MAX_STEPS}
                <span data-slot="wb-count" className="sr-only">
                  {stepCountLabel(steps)}
                </span>
              </p>
              <Canvas
                steps={steps}
                skills={skills}
                dragging={dragging !== null}
                overId={overId}
                activeStepId={dragging?.type === 'step' ? dragging.step.id : null}
                onRemove={(index) => setSteps(removeStep(steps, index))}
                onMove={(from, to) => setSteps(moveStep(steps, from, to))}
              />
              <Button
                ref={addStepButton}
                variant="outline"
                className="mt-4 min-h-11"
                onClick={() => { setSelectedSkill(null); setAddQuery(''); setAddOpen(true) }}
              >
                <PlusIcon aria-hidden="true" className="size-4" />
                Add step
              </Button>
              <p className="mt-4 text-xs leading-relaxed text-muted-foreground">
                Drag to reorder, or use Move up / Move down. The agent follows this sequence from top to
                bottom.
              </p>
              <footer className="mt-4 flex flex-wrap items-center justify-between gap-4 border-t border-border pt-4">
                <p className="text-xs leading-relaxed text-muted-foreground">
                  Review the name and steps, then save to a workflow file.
                </p>
                <Button
                  type="button"
                  variant="primary"
                  size="sm"
                  className="min-h-11 max-sm:w-full"
                  data-slot="wb-save"
                  disabled={save.isPending}
                  onClick={runSave}
                >
                  <CheckIcon aria-hidden="true" className="size-3" />
                  Save
                </Button>
              </footer>
            </section>

            {/* ---- palette + YAML preview ------------------------------------------------- */}
            <aside data-slot="wb-aside" className="min-w-0 rounded-xl border border-border bg-card p-5">
              <h2 className="text-[15px] font-semibold">Available skills</h2>
              <p className="mt-1 text-xs leading-relaxed text-soft-foreground">
                Drag into the flow. Order is execution order — the agent applies them top to bottom.
              </p>
              <Input
                data-slot="wb-filter"
                placeholder="Filter skills…"
                aria-label="Filter skills"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                className="mt-4 h-11 text-[13px]"
              />
              <Palette
                skills={paletteSkills}
                query={query}
                error={skillsQuery.isError ? skillsQuery.error.message : null}
                inFlow={new Set(steps.map((s) => s.skill).filter((s): s is string => Boolean(s)))}
                onAdd={(skill) => addSkill(skill)}
              />

              <h3 className="mt-5 text-sm font-semibold">workflow.yaml</h3>
              <p className="mt-3 text-xs leading-relaxed text-muted-foreground">
                Export the workflow to use this chain in another project.
              </p>
              <details className="mt-4 min-w-0">
                <summary
                  data-slot="wb-yaml-toggle"
                  className="inline-flex min-h-11 cursor-pointer items-center rounded-lg border border-border px-3 text-xs font-medium focus-visible:outline-2 focus-visible:outline-ring"
                >
                  View YAML
                </summary>
                <div className="mt-3 flex justify-end">
                  <CopyYamlButton yaml={yaml} />
                </div>
                <pre
                  data-slot="wb-yaml"
                  className="mt-2 max-h-96 overflow-auto rounded-lg border border-border bg-background p-3 font-mono text-[11.5px] leading-relaxed whitespace-pre text-muted-foreground"
                >
                  {yaml}
                </pre>
              </details>
            </aside>
          </div>
        </div>

        {/* What the pointer carries mid-drag: a copy of the pill/card, per dnd-kit. */}
        <DragOverlay>
          {dragging?.type === 'palette' ? (
            <div className="flex items-center gap-2 rounded-md border border-border bg-card px-2.5 py-1.5 font-mono text-[13px] font-medium shadow-md">
              <SparklesIcon aria-hidden="true" className="size-3.5 text-link-foreground" />
              {dragging.skill}
            </div>
          ) : dragging?.type === 'step' ? (
            <StepCardBody
              step={dragging.step}
              index={steps.findIndex((s) => s.id === dragging.step.id)}
              skills={skills}
              overlay
            />
          ) : null}
        </DragOverlay>
      </DndContext>

      <Dialog open={addOpen} onOpenChange={setAddOpen}>
        <DialogContent data-slot="wb-add-dialog" onCloseAutoFocus={(event) => { event.preventDefault(); addStepButton.current?.focus() }} className="max-h-[85dvh] overflow-y-auto [&_button]:min-h-11">
          <DialogHeader>
            <DialogTitle>Add step</DialogTitle>
            <DialogDescription>Append a skill, then reorder it in the existing canvas.</DialogDescription>
          </DialogHeader>
          <Input aria-label="Filter skills" placeholder="Filter skills…" value={addQuery} onChange={(event) => setAddQuery(event.target.value)} />
          {skillsQuery.isError ? <p role="alert" className="text-sm text-danger">Could not load skills: {skillsQuery.error.message}</p> : (
            <div role="radiogroup" aria-label="Available skills" className="grid max-h-80 gap-2 overflow-y-auto">
              {paletteSkills.filter((skill) => `${skill.name} ${skill.description}`.toLowerCase().includes(addQuery.trim().toLowerCase())).map((skill) => (
                <label key={skill.name} className="flex cursor-pointer items-start gap-3 rounded-lg border border-border p-3 has-[:checked]:border-accent-strong has-[:checked]:bg-accent-strong/5">
                  <input type="radio" name="workflow-add-skill" className="mt-1 accent-[var(--accent-strong)]" value={skill.name} checked={selectedSkill === skill.name} onChange={() => setSelectedSkill(skill.name)} />
                  <span className="min-w-0 break-words text-sm"><span className="block">{skill.name}</span><span className="mt-2 block text-xs text-muted-foreground">{skill.description}</span></span>
                </label>
              ))}
              {paletteSkills.filter((skill) => `${skill.name} ${skill.description}`.toLowerCase().includes(addQuery.trim().toLowerCase())).length === 0 ? <p className="text-sm text-muted-foreground">{skills.length === 0 ? 'No skills available in this project.' : 'No matching skills.'}</p> : null}
            </div>
          )}
          <div className="flex flex-wrap gap-3">
            <Button variant="outline" onClick={() => setAddOpen(false)}>Cancel</Button>
            <Button variant="primary" disabled={!selectedSkill || steps.length >= WB_MAX_STEPS} onClick={() => { if (selectedSkill) { addSkill(selectedSkill); setAddOpen(false) } }}>Add selected skill</Button>
          </div>
          {steps.length >= WB_MAX_STEPS ? <p role="status" className="text-sm text-muted-foreground">A workflow can contain up to {WB_MAX_STEPS} steps. Remove a step before adding another.</p> : null}
        </DialogContent>
      </Dialog>

      {/* Save-over confirm: the server answered 409 `exists` — legacy `confirm()`, as a dialog. */}
      <AlertDialog open={confirmOverwrite} onOpenChange={(open) => !open && setConfirmOverwrite(false)}>
        <AlertDialogContent data-slot="wb-overwrite-dialog">
          <AlertDialogHeader>
            <AlertDialogTitle>&ldquo;{trimmedName}&rdquo; already exists</AlertDialogTitle>
            <AlertDialogDescription>
              Saving overwrites the existing workflow file. There is no undo.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep the file</AlertDialogCancel>
            <AlertDialogAction data-slot="wb-overwrite-confirm" className="bg-danger text-danger-foreground" onClick={() => save.mutate(true)}>
              Overwrite
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={confirmDelete} onOpenChange={(open) => !open && setConfirmDelete(false)}>
        <AlertDialogContent data-slot="wb-delete-dialog">
          <AlertDialogHeader>
            <AlertDialogTitle>Delete workflow &ldquo;{trimmedName}&rdquo;?</AlertDialogTitle>
            <AlertDialogDescription>
              Removes {savedFile?.path?.split('/').pop() ?? 'the saved file'} from{' '}
              <span className="font-mono">.ai/cezar/workflows/</span>. There is no undo.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep it</AlertDialogCancel>
            <AlertDialogAction
              data-slot="wb-delete-confirm"
              className="bg-danger text-danger-foreground hover:brightness-[0.96]"
              onClick={() => del.mutate(trimmedName)}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

/** The step list: one droppable + sortable column. Empty → the legacy drop hint. */
function Canvas({
  steps,
  skills,
  dragging,
  overId,
  activeStepId,
  onRemove,
  onMove,
}: {
  steps: WorkflowStepDef[]
  skills: readonly Skill[]
  /** A drag (palette or step) is in flight — reveals the between-card insert affordances. */
  dragging: boolean
  /** The step id (or CANVAS_ID) under the pointer, for the insert line. */
  overId: string | null
  /** The id of the step BEING dragged — never draw an insert line against itself. */
  activeStepId: string | null
  onRemove: (index: number) => void
  onMove: (from: number, to: number) => void
}) {
  const { setNodeRef, isOver } = useDroppable({ id: CANVAS_ID })
  // Append target: the pointer is over the canvas padding (below the last card), not a card.
  const appendActive = dragging && overId === CANVAS_ID
  return (
    <div
      ref={setNodeRef}
      data-slot="wb-steps"
      data-dragging={dragging || undefined}
      className={cn(
        'mt-4 rounded-lg transition-colors',
        isOver ? 'border-accent-strong/60 bg-accent-strong/5' : 'border-muted-foreground/25',
      )}
    >
      {steps.length === 0 ? (
        <p
          className={cn(
            'rounded-md px-3 py-10 text-center text-[13px] transition-colors',
            isOver ? 'text-link-foreground' : 'text-muted-foreground',
          )}
        >
          Drop a skill here — or Import a workflow.yaml
        </p>
      ) : (
        <SortableContext items={steps.map((s) => s.id)} strategy={verticalListSortingStrategy}>
          <ol className="flex flex-col gap-2.5">
            {steps.map((step, index) => (
              <StepCard
                key={step.id}
                step={step}
                index={index}
                skills={skills}
                connector={index > 0}
                dragging={dragging}
                // The insert line rides above the hovered card — unless that card is the one
                // being dragged (dropping onto itself is a no-op, so no line).
                insertBefore={dragging && overId === step.id && activeStepId !== step.id}
                onRemove={() => onRemove(index)}
                onMoveUp={index > 0 ? () => onMove(index, index - 1) : undefined}
                onMoveDown={index < steps.length - 1 ? () => onMove(index, index + 1) : undefined}
              />
            ))}
          </ol>
          {/* Appending below the last card: the same accent slot, at the tail. */}
          <div
            aria-hidden="true"
            className={cn(
              'mx-1 mt-2.5 h-[3px] rounded-full transition-colors',
              appendActive ? 'bg-accent-strong' : 'bg-transparent',
            )}
          />

        </SortableContext>
      )}
    </div>
  )
}

function StepCard({
  step,
  index,
  skills,
  connector,
  dragging,
  insertBefore,
  onRemove,
  onMoveUp,
  onMoveDown,
}: {
  step: WorkflowStepDef
  index: number
  skills: readonly Skill[]
  /** Draw the rest-state vertical hairline linking this card to the one above (every card but
   *  the first) — the legacy `.wb-gap` connector. */
  connector: boolean
  /** A drag is in flight — hide the rest connector so it doesn't compete with the insert line. */
  dragging: boolean
  /** The drop indicator sits in the gap above this card. */
  insertBefore: boolean
  onRemove: () => void
  onMoveUp?: () => void
  onMoveDown?: () => void
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: step.id,
    data: { type: 'step', step } satisfies DragItem,
  })
  return (
    <li
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={cn('relative', isDragging && 'opacity-40')}
    >
      {/* Rest connector: a hairline down the middle of the gap, linking consecutive skills. */}
      {connector && !dragging ? (
        <span
          aria-hidden="true"
          className="pointer-events-none absolute -top-[11px] left-1/2 h-[9px] w-px -translate-x-1/2 bg-muted-foreground/30"
        />
      ) : null}
      {/* Drop-to-insert line: an accent bar in the gap above, where the card will land. */}
      {insertBefore ? (
        <span
          aria-hidden="true"
          data-slot="wb-drop-line"
          className="pointer-events-none absolute -top-[7px] right-0 left-0 h-[3px] rounded-full bg-accent-strong"
        />
      ) : null}
      <StepCardBody
        step={step}
        index={index}
        skills={skills}
        onRemove={onRemove}
        onMoveUp={onMoveUp}
        onMoveDown={onMoveDown}
        gripProps={{ ...attributes, ...listeners }}
      />
    </li>
  )
}

/**
 * The card itself, shared with the DragOverlay (which renders it detached — no sortable hooks).
 * `gripProps` carries dnd-kit's `attributes` (role, tabIndex, aria) onto the grip button so the
 * keyboard path lifts from a real focusable control.
 */
function StepCardBody({
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
  onRemove?: () => void
  onMoveUp?: () => void
  onMoveDown?: () => void
  gripProps?: Record<string, unknown>
  overlay?: boolean
}) {
  const known = skills.find((skill) => skill.name === step.skill)
  const isCheck = Boolean(step.command)
  const title = step.name ?? step.skill ?? step.id
  const specificPrompt = step.prompt?.trim() === '{{task}}' ? undefined : step.prompt?.trim()
  const description = isCheck
    ? `$ ${step.command}${step.onFail ? ` — on fail retry from "${step.onFail.retry}" (×${step.onFail.max ?? 2})` : ''}`
    : step.skill
      ? (specificPrompt || known?.description || 'Not in this repo or the team skills — the step runs on its plain prompt.')
      : (step.prompt ?? '')
  const badge = step.skill && !known ? 'unknown' : null

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
      <div data-slot="wb-step-heading" className="flex min-w-0 items-center gap-1">
        <button
          type="button"
          data-slot="wb-step-grip"
          aria-label={`Reorder step ${index + 1}: ${title}`}
          className="inline-flex size-11 shrink-0 cursor-grab items-center justify-center rounded-md text-muted-foreground transition-colors outline-none hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50"
          {...gripProps}
        >
          <span className="rounded bg-accent-strong/10 px-2 py-1 font-mono text-[10px] text-link-foreground">{String(index + 1).padStart(2, '0')}</span>
        </button>
        <div className="min-w-0 flex-1 break-words text-sm font-medium [overflow-wrap:anywhere]">{title}</div>
        {badge ? (
          <span
            data-slot="wb-step-badge"
            className={cn(
              'shrink-0 rounded-full border px-2 py-px font-mono text-[10.5px]',
              badge === 'unknown' && 'border-danger/35 text-danger',
            )}
          >
            {badge}
          </span>
        ) : null}
        {onRemove ? (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button data-slot="wb-step-actions" variant="ghost" size="icon" className="size-11" aria-label={`Step ${index + 1} actions: ${title}`}>
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
      {description ? (
        <div
          data-slot="wb-step-summary"
          className="mt-3 break-words text-xs leading-relaxed text-muted-foreground"
        >
          {description}
        </div>
      ) : null}
      <p data-slot="wb-step-kind" className="mt-3 text-[10px] text-link-foreground">
        {isCheck
          ? `Command step${step.onFail ? ` · Retry ×${step.onFail.max ?? 2}` : ''}`
          : step.skill
            ? 'Skill step'
            : 'Prompt step'}
      </p>
      {!overlay ? (
        <div className="mt-3 flex flex-wrap gap-2 @min-[900px]:hidden">
          <Button
            variant="outline"
            size="sm"
            className="min-h-11"
            aria-label={`Move step ${index + 1} up`}
            disabled={!onMoveUp}
            onClick={onMoveUp}
          >
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
            Move down
          </Button>
        </div>
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
  const needle = query.trim().toLowerCase()
  // `skills` arrives already ordered (project-first, then recency — #408/#414); the filter
  // preserves that order, it never re-sorts.
  const shown = skills.filter(
    (skill) =>
      needle === '' ||
      skill.name.toLowerCase().includes(needle) ||
      (skill.description ?? '').toLowerCase().includes(needle),
  )
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
      title={skill.description ?? ''}
      className={cn(
        'flex min-h-11 cursor-grab items-center gap-2 rounded-md py-1 transition-colors hover:bg-muted',
        isDragging && 'opacity-40',
      )}
      {...attributes}
      {...listeners}
    >
      <SparklesIcon
        aria-hidden="true"
        className={cn(
          'size-3.5 shrink-0',
          isProjectSkill(skill) ? 'text-accent-icon' : 'text-soft-foreground',
        )}
      />
      <span
        className={cn(
          'min-w-0 flex-1 break-words text-xs',
          isProjectSkill(skill) ? 'font-semibold text-foreground' : 'font-medium text-muted-foreground',
        )}
      >
        {skill.name}
      </span>
      {inFlow ? <CheckIcon aria-hidden="true" className="size-3.5 shrink-0 text-success" /> : null}
      <button
        type="button"
        data-slot="wb-skill-add"
        aria-label={`Add ${skill.name} to the flow`}
        title="Add to the flow"
        onClick={() => onAdd(skill.name)}
        className="inline-flex size-11 shrink-0 items-center justify-center rounded-md text-soft-foreground transition-colors outline-none hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50"
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

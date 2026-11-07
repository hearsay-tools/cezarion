import '../skills-workflows.css'
import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
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
import { CheckIcon, PlusIcon, TriangleAlertIcon } from '@/components/design-icons'
import { useEffect, useRef, useState } from 'react'
import { useParams } from 'react-router'

import { ApiError, createWorkflow, deleteWorkflow, parseWorkflow, postPlan } from '@/api/client'
import { queryKeys, useSkills, useUiState, useWorkflows } from '@/api/queries'
import type { Skill, WorkflowDef, WorkflowStepDef } from '@open-mercato/cezar-api-client'
import { CenteredState } from '@/components/centered-state'
import { Button } from '@/components/ui/button'
import { toast } from '@/components/ui/toaster'
import { orderSkillsByUsage, searchSkills } from '@/lib/skills'
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

import {
  type Draft,
  type DragItem,
  StepCardBody,
  WbActionsRow,
  WbAddStepDialog,
  WbAside,
  WbAutoPanel,
  WbConfirmDialogs,
  WbDragPreview,
  WbImportDialog,
  WbMetadata,
} from './workflows-builder-sections'
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
  const addMatches = searchSkills(paletteSkills, addQuery, uiStateQuery.data?.skillUsage)

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
        className="@container mx-auto min-h-full w-full px-[18px] py-6 md:p-9"
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
      className="@container mx-auto min-h-full w-full px-[18px] py-6 md:p-9"
    >
      <header className="mb-[22px] flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-[25px] font-semibold md:text-[30px]">Workflows</h1>
          <p className="mt-2 text-xs text-muted-foreground md:text-[13px]">
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
          <WbMetadata
            workflows={workflows}
            draft={draft}
            trimmedName={trimmedName}
            nameRef={nameInput}
            onDraft={setDraft}
            onLoadWorkflow={(workflow) => setDraft(draftFrom(workflow))}
          />
          <WbActionsRow
            savedFile={savedFile}
            autoOpen={autoOpen}
            onImportToggle={() => {
              setImportError('')
              setAutoOpen(false)
              setImportOpen((open) => !open)
            }}
            onExport={exportYaml}
            onAutoToggle={() => {
              setImportOpen(false)
              setAutoOpen((open) => !open)
            }}
            onDeleteRequest={() => setConfirmDelete(true)}
          />
          {autoOpen ? (
            <WbAutoPanel
              text={autoText}
              onTextChange={setAutoText}
              pending={autoPlan.isPending}
              onRun={runAuto}
              onCancel={() => {
                setAutoOpen(false)
                setAutoText('')
              }}
            />
          ) : null}

          <WbImportDialog
            open={importOpen}
            onOpenChange={setImportOpen}
            text={importText}
            onTextChange={setImportText}
            error={importError}
            pending={importMutation.isPending}
            onRun={runImport}
            onCancel={() => {
              setImportOpen(false)
              setImportText('')
              setImportError('')
            }}
          />

          <div className="grid min-w-0 items-start gap-[22px] @min-[700px]:grid-cols-[minmax(0,1fr)_300px]">
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
                <span className="hidden @min-[900px]:inline">Drag to reorder. The agent follows this sequence from top to bottom.</span>
                <span className="@min-[900px]:hidden">Use Move up / Move down to reorder without dragging.</span>
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
            <WbAside
              paletteSkills={paletteSkills}
              query={query}
              onQueryChange={setQuery}
              error={skillsQuery.isError ? skillsQuery.error.message : null}
              inFlow={new Set(steps.map((s) => s.skill).filter((s): s is string => Boolean(s)))}
              onAdd={(skill) => addSkill(skill)}
              yaml={yaml}
            />
          </div>
        </div>

        {/* What the pointer carries mid-drag: a copy of the pill/card, per dnd-kit. */}
        <DragOverlay>
          <WbDragPreview dragging={dragging} steps={steps} skills={skills} />
        </DragOverlay>
      </DndContext>

      <WbAddStepDialog
        open={addOpen}
        onOpenChange={setAddOpen}
        query={addQuery}
        onQueryChange={setAddQuery}
        matches={addMatches}
        skillsCount={skills.length}
        error={skillsQuery.isError ? skillsQuery.error.message : null}
        selectedSkill={selectedSkill}
        onSelectSkill={setSelectedSkill}
        stepsCount={steps.length}
        onCloseAutoFocus={(event) => { event.preventDefault(); addStepButton.current?.focus() }}
        onCancel={() => setAddOpen(false)}
        onAdd={(skill) => { addSkill(skill); setAddOpen(false) }}
      />

      <WbConfirmDialogs
        trimmedName={trimmedName}
        savedFile={savedFile}
        overwriteOpen={confirmOverwrite}
        onOverwriteDismiss={() => setConfirmOverwrite(false)}
        deleteOpen={confirmDelete}
        onDeleteDismiss={() => setConfirmDelete(false)}
        onOverwrite={() => save.mutate(true)}
        onDelete={() => del.mutate(trimmedName)}
      />
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
        'relative mt-4 rounded-lg transition-colors',
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
          <ol className="flex flex-col gap-4">
            {steps.map((step, index) => (
              <StepCard
                key={step.id}
                step={step}
                index={index}
                skills={skills}
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
              'absolute inset-x-0 mt-1 h-[3px] rounded-full transition-colors',
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
  insertBefore,
  onRemove,
  onMoveUp,
  onMoveDown,
}: {
  step: WorkflowStepDef
  index: number
  skills: readonly Skill[]
  /** A drag is in flight — hide the rest connector so it doesn't compete with the insert line. */
  dragging: boolean
  /** The drop indicator sits in the gap above this card. */
  insertBefore: boolean
  onRemove: () => void
  onMoveUp?: (() => void) | undefined
  onMoveDown?: (() => void) | undefined
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



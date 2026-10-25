import {
  normalizeSchedule,
  type AutomationSchedule,
  type NormalizedSchedule,
} from '@open-mercato/cezar-api-client/contract/automation-schedule'
import type {
  AutomationTask,
  AutomationEvent,
  AutomationFilters,
  AutomationKind,
  CreateAutomationInput,
  Runner,
  UpdateAutomationInput,
} from '@open-mercato/cezar-api-client'

/** A task as a request carries it (`z.input`): the editor writes it, so it takes the writable side. */
type TaskInput = CreateAutomationInput['task']

/** The workflow a fresh automation runs — the built-in zero-config chain. */
const DEFAULT_WORKFLOW = 'quick-task'

/** Everything the editor holds while the user types. Both kinds live in one draft, so switching
 *  the kind back and forth loses nothing; the body builders send only the active kind's keys. */
export interface AutomationDraft {
  name: string
  description: string
  kind: AutomationKind
  schedule: NormalizedSchedule
  events: AutomationEvent[]
  intervalSeconds: number
  filters: AutomationFilters
  prompt: string
  workflow?: string | undefined
  runner?: Runner | undefined
  model?: string | undefined
  autonomous: boolean
  archiveWhenDone: boolean
  autoMergePr: boolean
  /** The state the user wants after saving. */
  enabled: boolean
  retiredVariants: boolean
  /** Task keys the editor has no control for (effort, a system prompt …), carried
   *  through an edit untouched. */
  taskExtra: Omit<TaskInput, 'prompt' | 'workflow' | 'runner' | 'model' | 'autonomous' | 'archiveWhenDone' | 'autoMergePr'>
}

/** What `fromDefinition` reads: a stored definition, or the create body built from a draft. */
type DraftSource = Partial<{
  name: string
  description: string | undefined
  kind: AutomationKind | undefined
  events: AutomationEvent[] | undefined
  intervalSeconds: number | undefined
  filters: AutomationFilters | undefined
  schedule: AutomationSchedule | undefined
  task: TaskInput | AutomationTask
  enabled: boolean | undefined
  enable: boolean | undefined
}>

export function fromDefinition(source: DraftSource = {}): AutomationDraft {
  const { prompt, workflow, runner, model, autonomous, archiveWhenDone, autoMergePr, variants, ...taskExtra } = source.task ?? { prompt: '' }
  const fresh = source.task === undefined
  return {
    retiredVariants: variants !== undefined && variants !== 1,
    name: source.name ?? '',
    description: source.description ?? '',
    kind: source.kind ?? 'schedule',
    schedule: normalizeSchedule(source.schedule ?? { type: 'daily' }),
    events: source.events ?? ['issue.opened'],
    intervalSeconds: source.intervalSeconds ?? 300,
    filters: source.filters ?? { lookbackDays: 7, maxRecords: 25 },
    prompt,
    // A task that carries inline `steps` has no workflow, and must not gain one.
    ...(workflow !== undefined ? { workflow } : fresh ? { workflow: DEFAULT_WORKFLOW } : {}),
    ...(runner !== undefined ? { runner } : {}),
    ...(model !== undefined ? { model } : {}),
    autonomous: autonomous ?? true,
    archiveWhenDone: archiveWhenDone ?? false,
    autoMergePr: autoMergePr ?? false,
    enabled: source.enabled ?? source.enable ?? false,
    taskExtra,
  }
}

/** Only the keys the shape reads: a `daily` body carries no `every`, an `hours` body no time, a
 *  `once` body only its wall time, zone and latest start (hearsay-tools/cezarion#1465). */
function scheduleBody(schedule: NormalizedSchedule): AutomationSchedule {
  switch (schedule.type) {
    case 'daily':
    case 'weekdays': return { type: schedule.type, hour: schedule.hour, minute: schedule.minute }
    case 'weekly': return { type: 'weekly', hour: schedule.hour, minute: schedule.minute, day: schedule.day }
    case 'hours': return { type: 'hours', every: schedule.every }
    case 'once': return {
      type: 'once',
      at: schedule.at ?? '',
      timeZone: schedule.timeZone ?? '',
      ...(schedule.latestStartMinutes !== undefined ? { latestStartMinutes: schedule.latestStartMinutes } : {}),
    }
  }
}

function taskBody(draft: AutomationDraft): TaskInput {
  if (draft.retiredVariants) throw new Error('Parallel variants are removed. Choose Use one task before saving this automation.')
  return {
    ...draft.taskExtra,
    prompt: draft.prompt,
    ...(draft.workflow ? { workflow: draft.workflow } : {}),
    ...(draft.runner ? { runner: draft.runner } : {}),
    ...(draft.model ? { model: draft.model } : {}),
    autonomous: draft.autonomous,
    ...(draft.archiveWhenDone ? { archiveWhenDone: true } : {}),
    ...(draft.autoMergePr ? { autoMergePr: true } : {}),
  }
}

/** The keys both bodies share: the active kind's trigger, never the other kind's. */
function commonBody(draft: AutomationDraft) {
  return {
    name: draft.name.trim(),
    ...(draft.description.trim() ? { description: draft.description.trim() } : {}),
    kind: draft.kind,
    ...(draft.kind === 'schedule'
      ? { schedule: scheduleBody(draft.schedule) }
      : { events: draft.events, intervalSeconds: draft.intervalSeconds, filters: draft.filters }),
    task: taskBody(draft),
  }
}

export function toCreateBody(draft: AutomationDraft): CreateAutomationInput {
  return { ...commonBody(draft), enable: draft.enabled }
}

export function toUpdateBody(draft: AutomationDraft, revision: number): UpdateAutomationInput {
  return {
    ...commonBody(draft),
    task: { ...taskBody(draft), archiveWhenDone: draft.archiveWhenDone, autoMergePr: draft.autoMergePr },
    enabled: draft.enabled,
    expectedRevision: revision,
  }
}

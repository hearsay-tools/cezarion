import {
  normalizeSchedule,
  type AutomationEvent,
  type AutomationFilters,
  type AutomationKind,
  type AutomationSchedule,
  type CreateAutomationInput,
  type NormalizedSchedule,
  type Runner,
  type UpdateAutomationInput,
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
  workflow?: string
  runner?: Runner
  model?: string
  autonomous: boolean
  /** The state the user wants after saving. */
  enabled: boolean
  /** Task keys the editor has no control for (effort, variants, a system prompt …), carried
   *  through an edit untouched. */
  taskExtra: Omit<TaskInput, 'prompt' | 'workflow' | 'runner' | 'model' | 'autonomous'>
}

/** What `fromDefinition` reads: a stored definition, or the create body built from a draft. */
type DraftSource = Partial<{
  name: string
  description: string
  kind: AutomationKind
  events: AutomationEvent[]
  intervalSeconds: number
  filters: AutomationFilters
  schedule: AutomationSchedule
  task: TaskInput
  enabled: boolean
  enable: boolean
}>

export function fromDefinition(source: DraftSource = {}): AutomationDraft {
  const { prompt, workflow, runner, model, autonomous, ...taskExtra } = source.task ?? { prompt: '' }
  const fresh = source.task === undefined
  return {
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
    enabled: source.enabled ?? source.enable ?? false,
    taskExtra,
  }
}

/** Only the keys the shape reads: a `daily` body carries no `every`, an `hours` body no time. */
function scheduleBody(schedule: NormalizedSchedule): AutomationSchedule {
  switch (schedule.type) {
    case 'daily':
    case 'weekdays': return { type: schedule.type, hour: schedule.hour, minute: schedule.minute }
    case 'weekly': return { type: 'weekly', hour: schedule.hour, minute: schedule.minute, day: schedule.day }
    case 'hours': return { type: 'hours', every: schedule.every }
  }
}

function taskBody(draft: AutomationDraft): TaskInput {
  return {
    ...draft.taskExtra,
    prompt: draft.prompt,
    ...(draft.workflow ? { workflow: draft.workflow } : {}),
    ...(draft.runner ? { runner: draft.runner } : {}),
    ...(draft.model ? { model: draft.model } : {}),
    autonomous: draft.autonomous,
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
  return { ...commonBody(draft), enabled: draft.enabled, expectedRevision: revision }
}

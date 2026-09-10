/** Stable ids persisted in `~/.cezar/ui-state.json`; never derive them from labels. */
export const TASK_COLUMN_IDS = [
  'status',
  'task',
  'workflow',
  'branch',
  'diff',
  'reference',
  'tokens',
  'cost',
  'cpu',
  'memory',
  'started',
] as const

export type TaskColumnId = (typeof TASK_COLUMN_IDS)[number]
export type TaskColumnIcon =
  | 'workflow'
  | 'branch'
  | 'diff'
  | 'reference'
  | 'tokens'
  | 'cost'
  | 'cpu'
  | 'memory'
  | 'started'

export interface TaskColumnDefinition {
  id: TaskColumnId
  label: string
  canFold: boolean
  defaultExpanded: boolean
  align: 'left' | 'right'
  /** Preferred expanded width. Extra table width is distributed after these readable defaults.
   *  The defaults sum to ≤1138px — the table's width at a 1440px viewport beside the 262px
   *  sidebar — so the design's proportions hold without a horizontal scrollbar there. */
  width?: string
  icon?: TaskColumnIcon
  capability?: 'tokens' | 'cost'
}

/**
 * The one ordered description of the desktop Tasks table. Header, colgroup, and every row consume
 * this list so capability-hidden and folded columns cannot drift structurally.
 */
export const TASK_COLUMNS = [
  { id: 'status', label: 'Status', canFold: false, defaultExpanded: true, align: 'left', width: '124px' },
  { id: 'task', label: 'Task', canFold: false, defaultExpanded: true, align: 'left', width: '320px' },
  {
    id: 'workflow',
    label: 'Workflow',
    canFold: true,
    defaultExpanded: true,
    align: 'left',
    width: '96px',
    icon: 'workflow',
  },
  {
    id: 'branch',
    label: 'Branch',
    canFold: true,
    defaultExpanded: false,
    align: 'left',
    width: '120px',
    icon: 'branch',
  },
  { id: 'diff', label: '±', canFold: true, defaultExpanded: true, align: 'right', width: '72px', icon: 'diff' },
  {
    id: 'reference',
    label: 'Ref',
    canFold: true,
    defaultExpanded: true,
    align: 'right',
    width: '72px',
    icon: 'reference',
  },
  {
    id: 'tokens',
    label: 'IN / OUT',
    canFold: true,
    defaultExpanded: true,
    align: 'right',
    width: '104px',
    icon: 'tokens',
    capability: 'tokens',
  },
  {
    id: 'cost',
    label: 'Cost',
    canFold: true,
    defaultExpanded: true,
    align: 'right',
    width: '68px',
    icon: 'cost',
    capability: 'cost',
  },
  { id: 'cpu', label: 'CPU', canFold: true, defaultExpanded: true, align: 'right', width: '60px', icon: 'cpu' },
  {
    id: 'memory',
    label: 'Mem',
    canFold: true,
    defaultExpanded: true,
    align: 'right',
    width: '92px',
    icon: 'memory',
  },
  {
    id: 'started',
    label: 'Started',
    canFold: true,
    defaultExpanded: true,
    align: 'right',
    width: '84px',
    icon: 'started',
  },
] as const satisfies readonly TaskColumnDefinition[]

export type NormalizedExpandedColumns = Partial<Record<TaskColumnId, boolean>>

const TASK_COLUMN_BY_ID = new Map<TaskColumnId, TaskColumnDefinition>(
  TASK_COLUMNS.map((column) => [column.id, column]),
)

function booleanEntries(raw: unknown): Record<string, boolean> {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return {}
  return Object.fromEntries(
    Object.entries(raw).filter((entry): entry is [string, boolean] => typeof entry[1] === 'boolean'),
  )
}

/** Rendering reads known, foldable booleans only; malformed user-edited state acts as absent. */
export function normalizeExpandedColumns(raw: unknown): NormalizedExpandedColumns {
  const normalized: NormalizedExpandedColumns = {}
  for (const [id, expanded] of Object.entries(booleanEntries(raw))) {
    const column = TASK_COLUMN_BY_ID.get(id as TaskColumnId)
    if (column?.canFold) normalized[column.id] = expanded
  }
  return normalized
}

/** Status and Task are immutable even if a user manually writes false for either id. */
export function isColumnExpanded(
  id: TaskColumnId,
  normalized: NormalizedExpandedColumns,
): boolean {
  const column = TASK_COLUMN_BY_ID.get(id)
  if (!column) return true
  if (!column.canFold) return true
  return normalized[id] ?? column.defaultExpanded
}

/**
 * Compose one toggle from the raw cache value. Valid unknown ids survive for forward
 * compatibility; malformed values are omitted so this bounded map can pass the PUT contract.
 */
export function toggleExpandedColumn(raw: unknown, id: TaskColumnId): Record<string, boolean> {
  const current = booleanEntries(raw)
  const column = TASK_COLUMN_BY_ID.get(id)
  if (!column?.canFold) return current
  return {
    ...current,
    [id]: !isColumnExpanded(id, normalizeExpandedColumns(raw)),
  }
}

export function taskColumnsForCapabilities(capabilities: {
  tokens: boolean
  cost: boolean
}): readonly TaskColumnDefinition[] {
  return TASK_COLUMNS.filter((column: TaskColumnDefinition) => {
    return column.capability === undefined || capabilities[column.capability]
  })
}

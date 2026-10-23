import { cronOf } from '@open-mercato/cezar-api-client/contract/automation-schedule'
import type { CreateAutomationInput } from '@open-mercato/cezar-api-client'

import { toCreateBody, type AutomationDraft } from '@/routes/automations/editor-draft'

/**
 * The editor's "Copy as CLI" line (#774, port of upstream #985): `cez automation add …` when every
 * key of the body Save would send has a flag, `cez automation create --json '…'` otherwise. Both
 * are built from `toCreateBody`, so the line cannot disagree with Save.
 *
 * Every value is POSIX single-quoted: a prompt is free text, and `!`, `$(…)`, backticks and
 * newlines must reach `cez` verbatim, not run in the user's shell.
 */

/** `'…'` for a POSIX shell; an embedded `'` closes the quote, adds an escaped one and reopens. */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

/** The task keys `add` has flags for. `worktree` is not a flag: `add` always sends `true`. */
const FLAG_TASK_KEYS: ReadonlySet<string> = new Set(['prompt', 'workflow', 'runner', 'model', 'autonomous', 'worktree', 'archiveWhenDone', 'autoMergePr'])
/** The poll filters `add` has flags for, besides the two bounds it always sends at 7 and 25. */
const FLAG_FILTER_LISTS: ReadonlySet<string> = new Set(['anyLabels', 'authors', 'changedLabels'])

function bodyFlagExpressible(body: CreateAutomationInput): boolean {
  if (body.description !== undefined) return false
  // `add` rejects an empty name or prompt; the JSON form lets the server say what is missing.
  if (!body.name.trim() || !body.task.prompt.trim()) return false
  const task = body.task as Record<string, unknown>
  if (Object.keys(task).some((key) => !FLAG_TASK_KEYS.has(key))) return false
  // The positive flags send true; use JSON to preserve an explicit false.
  if (task.archiveWhenDone === false || task.autoMergePr === false) return false
  if (task.worktree !== true) return false
  if (body.kind === 'schedule') return body.schedule !== undefined
  const { events, filters } = body
  if (!events?.length || events.some((event) => event.includes(','))) return false
  if (!filters || filters.lookbackDays !== 7 || filters.maxRecords !== 25) return false
  return Object.entries(filters).every(([key, value]) =>
    key === 'lookbackDays' || key === 'maxRecords' || (key === 'includeExisting' && value === true) || (FLAG_FILTER_LISTS.has(key) && Array.isArray(value) && value.length > 0))
}

export function flagExpressible(draft: AutomationDraft): boolean {
  return bodyFlagExpressible(toCreateBody(draft))
}

/** `5m` / `1h` for `--every`; seconds when uneven. */
function everyFlag(seconds: number): string {
  if (seconds % 3_600 === 0) return `${seconds / 3_600}h`
  if (seconds % 60 === 0) return `${seconds / 60}m`
  return `${seconds}s`
}

/** `7d` / `6h` / `30m` for `--latest-start`, from minutes. */
function durationFlag(minutes: number): string {
  if (minutes % 1_440 === 0) return `${minutes / 1_440}d`
  if (minutes % 60 === 0) return `${minutes / 60}h`
  return `${minutes}m`
}

/** `--flag 'value'`, or `--flag='value'` when the value starts with a dash: the CLI's strict
 *  parser refuses `--prompt -x` as ambiguous. */
function flag(name: string, value: string): string {
  return value.startsWith('-') ? `--${name}=${shellQuote(value)}` : `--${name} ${shellQuote(value)}`
}

function flagsOf(body: CreateAutomationInput): string {
  const parts = ['cez automation add', flag('name', body.name)]
  if (body.schedule?.type === 'once') {
    parts.push(flag('at', body.schedule.at!), flag('tz', body.schedule.timeZone!))
    if (body.schedule.latestStartMinutes !== undefined) parts.push(flag('latest-start', durationFlag(body.schedule.latestStartMinutes)))
  } else if (body.kind === 'schedule') {
    parts.push(flag('cron', cronOf(body.schedule!)))
  } else {
    parts.push(flag('on', body.events!.join(',')), `--every ${everyFlag(body.intervalSeconds ?? 300)}`)
    if (body.filters?.includeExisting) parts.push('--include-existing')
    for (const label of body.filters?.anyLabels ?? []) parts.push(flag('label', label))
    for (const author of body.filters?.authors ?? []) parts.push(flag('author', author))
    for (const label of body.filters?.changedLabels ?? []) parts.push(flag('changed-label', label))
  }
  const { task } = body
  if (task.workflow) parts.push(flag('workflow', task.workflow))
  if (task.runner) parts.push(flag('runner', task.runner))
  if (task.model) parts.push(flag('model', task.model))
  if (task.autonomous === false) parts.push('--no-autonomous')
  if (task.archiveWhenDone) parts.push('--archive-when-done')
  if (task.autoMergePr) parts.push('--auto-merge-pr')
  if (body.enable === true) parts.push('--enable')
  parts.push(flag('prompt', task.prompt))
  return parts.join(' ')
}

/** The cockpit and project the copied line talks to. */
export interface CliAddress {
  origin: string
  projectId: string
}

/**
 * What the card prints. With an `address`, the line names this cockpit and project the way a
 * task's env does (`CEZ_COCKPIT_URL`, `CEZ_PROJECT_ID`): `cez automation` never probes for a
 * cockpit on its own, so a line pasted into an ordinary shell needs both to reach this one.
 */
export function cliOf(draft: AutomationDraft, address?: CliAddress): string {
  const body = toCreateBody(draft)
  const command = bodyFlagExpressible(body) ? flagsOf(body) : `cez automation create --json ${shellQuote(JSON.stringify(body))}`
  return address
    ? `CEZ_COCKPIT_URL=${shellQuote(address.origin)} CEZ_PROJECT_ID=${shellQuote(address.projectId)} ${command}`
    : command
}

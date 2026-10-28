/*
 * What each task's preview pane looked like when the owner left it (hearsay-tools/cezarion#2077):
 * open or closed, what it showed, and how wide it was. The pure half: no React, no side effects
 * beyond `localStorage`. Like the stream quality and the split width, it belongs to the browser you
 * sit at, so no config key and no `CEZ_*` flag. Storage that is absent, unreadable or hand-edited
 * reads as no memory, and the pane opens as it always did.
 */

/** `{ [runId]: entry }`. Namespaced `cez-` like `cez-preview-quality`. */
export const PREVIEW_MEMORY_STORAGE_KEY = 'cez-preview-tasks'
/** The width last set on any task: what a task with no width of its own starts at. Kept from before #2077. */
export const PANE_WIDTH_STORAGE_KEY = 'cez.preview.pane-width'
/** Enough for every task an owner moves between; the oldest entry goes first. */
export const PREVIEW_MEMORY_LIMIT = 100

export const DEFAULT_PANE_PERCENT = 58
export const MIN_PANE_PERCENT = 30
export const MAX_PANE_PERCENT = 75

/** What the pane showed: a registered server, the agent's page, or a URL the owner typed. */
export type PreviewTarget = { port: number } | { agent: true } | { url: string }

export interface PreviewMemory {
  open: boolean
  target?: PreviewTarget | undefined
  /** The pane's share of the split, in percent, as the owner left it. */
  percent?: number | undefined
}

interface StoredEntry extends PreviewMemory {
  /** When the entry last changed: the oldest goes first once the map is full. */
  at: number
}

export const clampPanePercent = (percent: number): number =>
  Math.min(MAX_PANE_PERCENT, Math.max(MIN_PANE_PERCENT, Math.round(percent)))

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function readTarget(value: unknown): PreviewTarget | undefined {
  if (!isRecord(value)) return undefined
  const { port, agent, url } = value
  if (typeof port === 'number' && Number.isInteger(port) && port >= 1 && port <= 65535) return { port }
  if (agent === true) return { agent: true }
  // The pane checks the address again before it opens it; this only keeps junk out of the map.
  if (typeof url === 'string' && /^https?:\/\//i.test(url)) return { url }
  return undefined
}

function readEntry(value: unknown): StoredEntry | undefined {
  if (!isRecord(value)) return undefined
  const target = readTarget(value.target)
  const percent = typeof value.percent === 'number' && Number.isFinite(value.percent) ? value.percent : undefined
  return {
    open: value.open === true,
    ...(target ? { target } : {}),
    ...(percent === undefined ? {} : { percent }),
    at: typeof value.at === 'number' ? value.at : 0,
  }
}

function readAll(): Record<string, unknown> {
  try {
    const raw = localStorage.getItem(PREVIEW_MEMORY_STORAGE_KEY)
    const value: unknown = raw === null ? null : JSON.parse(raw)
    return isRecord(value) ? value : {}
  } catch {
    return {}
  }
}

/** The task's saved pane, or `undefined` when there is none to use. */
export function readPreviewMemory(runId: string): PreviewMemory | undefined {
  const entry = readEntry(readAll()[runId])
  if (!entry) return undefined
  const { at: _at, ...memory } = entry
  return memory
}

/**
 * Merge `change` into the task's entry. A key given as `undefined` is forgotten. Other tasks'
 * entries are kept as they are, except the oldest once the map holds more than the limit.
 */
export function rememberPreview(runId: string, change: Partial<PreviewMemory>, now = Date.now()): void {
  const all = readAll()
  const previous = readEntry(all[runId])
  const next: Record<string, unknown> = { open: false, ...previous, ...change, at: now }
  for (const key of Object.keys(next)) if (next[key] === undefined) delete next[key]
  all[runId] = next
  const ids = Object.keys(all)
  if (ids.length > PREVIEW_MEMORY_LIMIT) {
    const age = (id: string) => readEntry(all[id])?.at ?? 0
    for (const id of ids.sort((a, b) => age(a) - age(b)).slice(0, ids.length - PREVIEW_MEMORY_LIMIT)) delete all[id]
  }
  try {
    localStorage.setItem(PREVIEW_MEMORY_STORAGE_KEY, JSON.stringify(all))
  } catch {
    // Private mode / storage full: the pane keeps its state for this visit only.
  }
}

function readLastPercent(): number | undefined {
  try {
    const stored = Number(localStorage.getItem(PANE_WIDTH_STORAGE_KEY))
    return stored > 0 ? stored : undefined
  } catch {
    return undefined
  }
}

/** The task's own width, else the last width set on any task, else the default; always in the limits. */
export function readPanePercent(runId: string | undefined): number {
  const own = runId === undefined ? undefined : readPreviewMemory(runId)?.percent
  const percent = own ?? readLastPercent()
  return percent === undefined ? DEFAULT_PANE_PERCENT : clampPanePercent(percent)
}

/** Save a width for the task and as the width the next new task starts at. */
export function rememberPanePercent(runId: string | undefined, percent: number): void {
  try {
    localStorage.setItem(PANE_WIDTH_STORAGE_KEY, String(percent))
  } catch {
    /* a private window keeps the width for this visit only */
  }
  if (runId !== undefined) rememberPreview(runId, { percent })
}

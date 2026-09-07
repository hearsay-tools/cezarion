/** The GitHub tab's desktop list width: a browser-local screen preference, not workspace state. */
export const GITHUB_LIST_WIDTH_STORAGE_KEY = 'cez-github-list-width'

/** Bounds in CSS pixels. The list stays readable while leaving the detail pane usable. */
export const MIN_GITHUB_LIST_WIDTH = 280
export const MAX_GITHUB_LIST_WIDTH = 520
export const DEFAULT_GITHUB_LIST_WIDTH = 360

/** How far one arrow key moves the separator. */
export const GITHUB_LIST_WIDTH_STEP = 16

/** Convert any drag or storage value into a width the desktop layout can paint. */
export function clampGithubListWidth(raw: unknown): number {
  if (raw === null || raw === undefined || raw === '') return DEFAULT_GITHUB_LIST_WIDTH
  const width = typeof raw === 'number' ? raw : Number(raw)
  if (!Number.isFinite(width)) return DEFAULT_GITHUB_LIST_WIDTH
  return Math.min(MAX_GITHUB_LIST_WIDTH, Math.max(MIN_GITHUB_LIST_WIDTH, Math.round(width)))
}

/** Read the stored desktop list width, degrading to the default when storage is unavailable. */
export function readStoredGithubListWidth(): number {
  try {
    const raw = localStorage.getItem(GITHUB_LIST_WIDTH_STORAGE_KEY)
    if (raw === null) return DEFAULT_GITHUB_LIST_WIDTH
    return clampGithubListWidth(raw)
  } catch {
    return DEFAULT_GITHUB_LIST_WIDTH
  }
}

/** Persist a clamped width without making private-mode storage errors fatal. */
export function writeStoredGithubListWidth(width: number): void {
  try {
    localStorage.setItem(GITHUB_LIST_WIDTH_STORAGE_KEY, String(clampGithubListWidth(width)))
  } catch {
    // Storage can be disabled or quota-limited; the in-memory width still applies for this page.
  }
}

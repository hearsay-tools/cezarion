import type { DiffFileChange } from './types'

/**
 * Pure diff rendering-cost rules. THE PERFORMANCE RULE: render flat with content-visibility up
 * to DIFF_VIRTUALIZE_THRESHOLD; above it virtualize file cards. Cards retain sticky header
 * ranges and lazy highlighting; a huge single file still needs row containment.
 */

/** Rendered rows across all files, past which the file list goes through virtua. */
export const DIFF_VIRTUALIZE_THRESHOLD = 1500

/**
 * One diff row's height at `text-xs`/`leading-[1.7]` (12px × 1.7 ≈ 20.4px), rounded down.
 * Only ever a PLACEHOLDER: it seeds `contain-intrinsic-block-size` for never-yet-rendered
 * content and virtua's first estimate, and both correct themselves on real measurement. It
 * exists so the scrollbar starts at a sane length, not so it is exact.
 */
export const DIFF_ROW_ESTIMATE_PX = 20

/** The card chrome above/below a body (sticky header + padding), for the same estimate. */
const DIFF_CARD_CHROME_PX = 44

/**
 * How many rows a file will render, WITHOUT parsing it: the patch's line count, minus the
 * `diff --git`/`---`/`+++` preamble git puts before the first `@@`. An over-estimate on
 * files whose patch carries extra metadata lines, which is the safe direction — it only ever
 * makes a placeholder slightly too tall.
 */
export function estimateFileRows(file: DiffFileChange): number {
  if (file.binary === true || file.patch === '') return 1 // the one-line "no text diff" note
  const lines = file.patch.split('\n')
  const firstHunk = lines.findIndex((line) => line.startsWith('@@'))
  return firstHunk === -1 ? lines.length : lines.length - firstHunk
}

/** A card's placeholder height for `contain-intrinsic-block-size` / virtua's estimate. */
export function estimateFileHeight(file: DiffFileChange): number {
  return estimateFileRows(file) * DIFF_ROW_ESTIMATE_PX + DIFF_CARD_CHROME_PX
}

/** Total rendered rows across the changeset — the number the threshold rule is about. */
export function diffRowCount(files: readonly DiffFileChange[]): number {
  return files.reduce((sum, file) => sum + estimateFileRows(file), 0)
}

/**
 * Which renderer the diff uses. `search` is the location's query string: `?diff=flat` and
 * `?diff=virtual` force a mode — the honest measurement seam (the e2e perf comparison loads
 * the same changeset both ways, exactly as `?thread=` does for the transcript) and a
 * debugging escape hatch; anything else is `auto`, the threshold rule above.
 */
export function diffRenderMode(search: string, rowCount: number): 'flat' | 'virtual' {
  const forced = new URLSearchParams(search).get('diff')
  if (forced === 'flat' || forced === 'virtual') return forced
  return rowCount > DIFF_VIRTUALIZE_THRESHOLD ? 'virtual' : 'flat'
}

/** Stable identity for a file across refetches — the renderer's key and its state map's key. */
export function fileKey(file: DiffFileChange): string {
  return `${file.oldPath ?? ''}→${file.path}`
}

/**
 * The widest line in a patch, in characters. In no-wrap mode the card body scrolls
 * horizontally, and `content-visibility` size-contains off-screen rows — so without a floor
 * the body's scrollWidth would be whatever the CURRENTLY VISIBLE rows happen to be, and the
 * horizontal scrollbar would resize under a reader who had scrolled right. The body pins a
 * `min-inline-size` of this many `ch` instead, which is exact for the monospace ASCII that
 * dominates diffs and merely a floor everywhere else (a wider real row still widens the box).
 */
export function widestLineChars(patch: string): number {
  let widest = 0
  for (const line of patch.split('\n')) if (line.length > widest) widest = line.length
  return widest
}

/**
 * Card placement for the activity graph (spec 2026-11-05-live-activity-view, D9 and "Size, motion
 * and access"). A card keeps its column and its order while it stays on the view; state changes
 * never move it. A new card goes to the end of the shortest column. Pure.
 */

/** The minimum card width and the gap between columns, so lines and labels have room. */
export const CARD_MIN_WIDTH = 300
export const COLUMN_GAP = 96
/** With more cards than this, cards drop their detail line and fold workers into dots. */
export const DENSE_AFTER = 12

/** Card ids per column, top to bottom. */
export type Columns = readonly (readonly string[])[]

/** As many columns as fit at the minimum card width, and at least one. */
export function columnCount(width: number): number {
  if (!Number.isFinite(width) || width <= 0) return 1
  return Math.max(1, Math.floor((width + COLUMN_GAP) / (CARD_MIN_WIDTH + COLUMN_GAP)))
}

function lightest(columns: string[][], weight: (id: string) => number): string[] {
  let best = columns[0] as string[]
  let bestWeight = Number.POSITIVE_INFINITY
  for (const column of columns) {
    const total = column.reduce((sum, id) => sum + weight(id), 0)
    if (total < bestWeight) {
      best = column
      bestWeight = total
    }
  }
  return best
}

/**
 * The next placement. `previous` is the last placement or undefined on the first snapshot; `ids`
 * are the cards on the view now, in snapshot order; `weight` estimates a card's height (workers
 * make a card taller). A changed column count is a new layout: every card is placed again.
 */
export function placeCards(
  previous: Columns | undefined,
  ids: readonly string[],
  count: number,
  weight: (id: string) => number = () => 1,
): string[][] {
  const columns = Math.max(1, Math.floor(count))
  const present = new Set(ids)
  const kept = previous?.length === columns
    ? previous.map((column) => column.filter((id) => present.has(id)))
    : Array.from({ length: columns }, (): string[] => [])
  const placed = new Set(kept.flat())
  for (const id of ids) {
    if (placed.has(id)) continue
    lightest(kept, weight).push(id)
    placed.add(id)
  }
  return kept
}

/** True when the placement holds the same ids in the same places. */
export function samePlacement(a: Columns | undefined, b: Columns): boolean {
  return a !== undefined && a.length === b.length && a.every((column, i) => column.length === b[i]?.length && column.every((id, j) => id === b[i]?.[j]))
}

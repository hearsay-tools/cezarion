import { arrayMove } from '@dnd-kit/sortable'

/**
 * The one answer to "in what order do the projects go?" (hearsay-tools/cezarion#438, a port of
 * open-mercato/cezar#952 adapted to this fork's project rail).
 *
 * Every surface that lists the registry reads this rule: the desktop rail and the mobile drawer
 * (both through `useWorkspaceSignals`) and the ⌘K palette. A registry listed in two different
 * orders in the same cockpit is a bug the user reads as a glitch. The palette layers its own
 * "active project last" rule on top; it does not re-sort.
 *
 * The stored order (`~/.cezar/ui-state.json` → `sidebar.projectOrder`) is a hand-picked list of
 * project ids, and it is deliberately NOT authoritative on its own: the registry is, so this
 * module treats the stored list as a preference to apply to whatever is actually registered right
 * now. That is what keeps a hand-edited, stale or partial list from ever hiding a project.
 *
 * The fallback is REGISTRY order (registration order, `config.projects`), not upstream's
 * `lastOpenedAt` sort. The rail has always shown registry order, and `lastOpenedAt` is bumped on
 * every server boot, so sorting by it would reshuffle the rail of a user who never reordered.
 */

/** The registry field the order depends on — narrower than `ProjectListEntry` so the rule can
 *  be tested (and reasoned about) without inventing a whole registry row. */
export type OrderableProject = { id: string }

/** Matches `sidebar.projectOrder`'s cap in `packages/contract/src/workspace.ts`. Clamping here
 *  too means a list that grew past the bound in some other client still renders, and the next
 *  write brings it back inside the contract instead of 400ing forever. */
export const PROJECT_ORDER_LIMIT = 200

/**
 * Whether a registry this size can be hand-ordered at all. The stored list holds at most
 * `PROJECT_ORDER_LIMIT` ids, so past it a drag could only persist a truncated list; the ids cut
 * off would then read as "never placed" and jump above the rest, undoing the drop. Rather than
 * offer a drag that does not stick, the rail offers none, and the registry order stands.
 */
export function canPersistProjectOrder(count: number): boolean {
  return count <= PROJECT_ORDER_LIMIT
}

/**
 * A stored order, made safe to use: strings only, blanks and duplicates dropped, capped.
 *
 * `ui-state.json` is a user-owned file the README invites people to edit, and the read schema is
 * a loose bag — so `["a", "a", 3, ""]` is a shape this has to survive, not a shape to reject.
 */
export function normalizeProjectOrder(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const seen = new Set<string>()
  for (const entry of value) {
    if (typeof entry !== 'string') continue
    const id = entry.trim()
    if (id === '' || seen.has(id)) continue
    seen.add(id)
    if (seen.size >= PROJECT_ORDER_LIMIT) break
  }
  return [...seen]
}

/**
 * Apply a stored order to the live registry.
 *
 * - never reordered (empty list) → registry order, unchanged;
 * - ids no longer registered → ignored (they are pruned from the file on the next write);
 * - registered projects the list does not mention → kept in registry order among themselves and
 *   placed ABOVE the picked ones. A project registered after the last drag is one the user just
 *   added, so it lands where the eye already is and is one drag from its home — the alternative,
 *   appending it below a long curated list, hides the thing that just happened.
 *
 * Never drops, duplicates or invents a row: the output is a permutation of the input.
 */
export function orderProjects<T extends OrderableProject>(
  projects: readonly T[],
  storedOrder: readonly string[],
): T[] {
  const order = normalizeProjectOrder(storedOrder)
  if (order.length === 0) return [...projects]

  const rank = new Map(order.map((id, index) => [id, index]))
  const picked: T[] = []
  const rest: T[] = []
  for (const project of projects) {
    if (rank.has(project.id)) picked.push(project)
    else rest.push(project)
  }
  picked.sort((a, b) => rank.get(a.id)! - rank.get(b.id)!)
  return [...rest, ...picked]
}

/**
 * The list to persist after a drag: the id at `from` lifted out and dropped at `to`.
 *
 * The move itself is dnd-kit's own `arrayMove` — the same function its sorting strategies use to
 * work out where each item lands, so the persisted order cannot drift from the order the drag
 * previewed. What this adds is the guard: `arrayMove` happily takes an out-of-range index and
 * splices at the end, while a drop that resolved to nothing must be a no-op. It is called from an
 * event handler, so it returns the input rather than throwing.
 */
export function moveProjectId(ids: readonly string[], from: number, to: number): string[] {
  if (from === to) return [...ids]
  if (from < 0 || to < 0 || from >= ids.length || to >= ids.length) return [...ids]
  return arrayMove([...ids], from, to)
}

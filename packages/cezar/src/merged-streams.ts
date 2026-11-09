/**
 * Merge append-only streams that are read from both project directories. `sources` arrive in
 * precedence order: `.ai/cezar/` first, then `.ai/squawk/`.
 *
 * 1. Deduplicate across sources by identity: the first source that holds an identity keeps it.
 *    Rows repeated inside one source stay, as a one-directory reader keeps them.
 * 2. Replay the survivors in their recorded time, so per-key "latest" state is the newest event
 *    whichever directory holds it. A missing or unreadable time takes the time of the row before
 *    it in the same source. Ties go to `tiebreak`, then the earlier source, then file order.
 *
 * With rows in one source only, that source is returned unchanged, in file order.
 */
export function mergeAppendOnly<T>(
  sources: readonly (readonly T[])[],
  identity: (row: T) => string,
  time: (row: T) => string | undefined,
  tiebreak: (a: T, b: T) => number = () => 0,
): T[] {
  const filled = sources.filter(rows => rows.length > 0);
  if (filled.length <= 1) return [...(filled[0] ?? [])];
  const seen = new Set<string>();
  const kept: Array<{ row: T; at: number; source: number; position: number }> = [];
  sources.forEach((rows, source) => {
    const survivors = rows.filter(row => !seen.has(identity(row)));
    let at = Number.NEGATIVE_INFINITY;
    survivors.forEach((row, position) => {
      const parsed = Date.parse(time(row) ?? '');
      if (!Number.isNaN(parsed)) at = parsed;
      kept.push({ row, at, source, position });
    });
    rows.forEach(row => seen.add(identity(row)));
  });
  return kept.sort((a, b) => a.at - b.at || tiebreak(a.row, b.row) || a.source - b.source || a.position - b.position)
    .map(entry => entry.row);
}

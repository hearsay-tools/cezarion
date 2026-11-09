import { automationDefinitionSchema, type AutomationDefinition } from './types.ts';

/** Files arrive in precedence order. Unknown top-level keys survive a counterpart write. */
export function mergeProjectAutomationFiles<T>(filename: string, files: readonly T[]): T {
  if (files.length === 1) return files[0]!;
  const ordered = [...files].reverse() as Array<Record<string, unknown>>;
  const result = Object.assign({}, ...ordered);
  if (filename === 'automations.json') {
    const byId = new Map<string, AutomationDefinition>();
    const tombstones: Record<string, string> = {};
    for (const file of ordered) {
      for (const raw of file.automations as unknown[]) {
        const parsed = automationDefinitionSchema.safeParse(raw);
        if (parsed.success) { byId.set(parsed.data.id, parsed.data); delete tombstones[parsed.data.id]; }
      }
      for (const [id, time] of Object.entries((file.tombstones ?? {}) as Record<string, string>)) {
        byId.delete(id); tombstones[id] = time;
      }
    }
    result.tombstones = tombstones;
    result.automations = [...byId.values()];
  } else if (filename === 'automation-state.json') {
    result.states = Object.assign({}, ...ordered.map(file => file.states));
  }
  return result as T;
}

/** Keep each source's append order; only an earlier directory suppresses a logical key. */
export function mergeProjectAutomationLog<T>(filename: string, sources: readonly T[][]): T[] {
  const seen = new Set<unknown>();
  const kept: T[][] = [];
  for (const [index, source] of sources.entries()) {
    // Fallback has an independent sequence domain. Stable negative values keep
    // pagination and copied/compacted rows distinct from positive legacy sequences.
    const rows = index > 0 && filename === 'automation-log.ndjson'
      ? source.map(row => ({ ...row, seq: Number((row as Record<string, unknown>).seq) - Number.MAX_SAFE_INTEGER })) : source;
    const key = (row: T) => {
      const record = row as Record<string, unknown>;
      return filename === 'automation-receipts.ndjson' ? `${record.receiptId}:${record.status}:${record.updatedAt}` : `${record.automationId}:${record.seq}`;
    };
    kept.push(rows.filter((row, index) => !seen.has(key(source[index]!)) && !seen.has(key(row))));
    rows.forEach(row => seen.add(key(row)));
  }
  return kept.reverse().flat();
}

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

/** Keep raw identities for deduplication. Only page reads project two positive sequence domains. */
export function mergeProjectAutomationLog<T>(filename: string, sources: readonly T[][], page = false): T[] {
  const seen = new Set<unknown>();
  const kept: T[][] = [];
  const project = page && filename === 'automation-log.ndjson' && sources.slice(1).some(rows => rows.length > 0);
  for (const [index, rows] of sources.entries()) {
    const key = (row: T) => {
      const record = row as Record<string, unknown>;
      return filename === 'automation-receipts.ndjson' ? `${record.receiptId}:${record.status}:${record.updatedAt}` : `${record.automationId}:${record.seq}`;
    };
    const missing = rows.filter(row => !seen.has(key(row)));
    kept.push(project ? missing.map(row => ({ ...row, seq: Number((row as Record<string, unknown>).seq) * 2 - (index > 0 ? 1 : 0) })) : missing);
    rows.forEach(row => seen.add(key(row)));
  }
  const merged = kept.reverse().flat();
  return project ? merged.sort((a, b) => Number((a as Record<string, unknown>).seq) - Number((b as Record<string, unknown>).seq)) : merged;
}

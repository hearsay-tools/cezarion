import { mergeAppendOnly } from '../merged-streams.ts';
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

/** Deduplicate by raw identity, then replay chronologically (`mergeAppendOnly`). A page read over two
 *  logs numbers the merged rows 1..n in that order: the cursor stays positive, and a row appended later
 *  (newest time, highest raw seq) only extends it. One log alone keeps its stored sequences. */
export function mergeProjectAutomationLog<T>(filename: string, sources: readonly T[][], page = false): T[] {
  const field = (row: T, key: string) => (row as Record<string, unknown>)[key];
  const receipts = filename === 'automation-receipts.ndjson';
  const merged = mergeAppendOnly(sources,
    row => receipts ? `${field(row, 'receiptId')}:${field(row, 'status')}:${field(row, 'updatedAt')}` : `${field(row, 'automationId')}:${field(row, 'seq')}`,
    row => String(field(row, receipts ? 'updatedAt' : 'ts')),
    receipts ? undefined : (a, b) => Number(field(a, 'seq')) - Number(field(b, 'seq')));
  const project = page && !receipts && sources.slice(1).some(rows => rows.length > 0);
  return project ? merged.map((row, index) => ({ ...row, seq: index + 1 })) : merged;
}

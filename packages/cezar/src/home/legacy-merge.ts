import { isDeepStrictEqual } from 'node:util';

type JsonObject = Record<string, unknown>;

function object(value: unknown): JsonObject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Import requires a JSON object in each home version.');
  return value as JsonObject;
}

function keyedArray(value: unknown): Map<string, unknown> {
  if (!Array.isArray(value)) throw new Error('Import requires a registry array with unique entry IDs.');
  const entries = new Map<string, unknown>();
  for (const entry of value) {
    const id = object(entry).id;
    if (typeof id !== 'string' || entries.has(id)) throw new Error('Import requires a registry array with unique entry IDs.');
    entries.set(id, entry);
  }
  return entries;
}

/** Apply only legacy deltas. An explicit Import chooses legacy when both sides changed. */
function mergeEntries(base: unknown, legacy: unknown, live: unknown): unknown[] {
  const before = keyedArray(base ?? []), after = keyedArray(legacy), merged = keyedArray(live ?? []);
  for (const id of new Set([...before.keys(), ...after.keys()])) {
    if (isDeepStrictEqual(before.get(id), after.get(id))) continue;
    if (after.has(id)) merged.set(id, after.get(id));
    else merged.delete(id);
  }
  return [...merged.values()];
}

export function mergeLegacyJson(file: string, base: unknown, legacy: unknown, live: unknown): JsonObject {
  const before = object(base), after = object(legacy), merged = new Map(Object.entries(object(live)));
  const registry = file === 'config.json' ? 'projects' : file === 'agent-accounts.json' ? 'accounts' : undefined;
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (isDeepStrictEqual(before[key], after[key]) && Object.hasOwn(before, key) === Object.hasOwn(after, key)) continue;
    if (!Object.hasOwn(after, key)) merged.delete(key);
    else merged.set(key, key === registry ? mergeEntries(before[key], after[key], merged.get(key)) : after[key]);
  }
  return Object.fromEntries(merged);
}

/**
 * The raw-record codec (#779, plan step 4): a run row keeps what this cezar cannot read.
 *
 * A record goes through the runtime schema on the way in, and zod drops every key it does not
 * declare. Before this codec, the next write serialized the parsed record, so a field an older or
 * newer cezar stored was lost the first time this one touched the run. Now the parse still
 * produces the unchanged runtime record, and `collectRawExtras` notes, beside it, what the stored
 * JSON held that the parse dropped. A write goes through `encodeRawRecord`: every field the
 * runtime record has is written exactly as it is now, so changes and deletions of known fields
 * apply at every depth, and the dropped fields go back in wherever their parent still exists.
 *
 * Plain JSON only: nothing here knows the run schema. Arrays whose elements all carry a distinct
 * string `id` (steps, queued messages) are matched by that id, so an unknown field follows its
 * step through reordering, insertion and removal. Any other array is matched by position, and
 * only while its known content is exactly what was read; once the runtime changes it, the array is
 * written as the runtime has it and whatever unknown fields it carried are dropped with it.
 */

type JsonObject = Record<string, unknown>;

/** What one stored record held beyond its parse. Opaque outside this module. */
export type RawExtras = ObjectExtras | KeyedArrayExtras | IndexedArrayExtras;

interface ObjectExtras {
  kind: 'object';
  /** Keys the parse dropped, with their stored values. */
  fields: Map<string, unknown>;
  /** Keys the parse kept whose values hold dropped fields further down. */
  children: Map<string, RawExtras>;
}

interface KeyedArrayExtras {
  kind: 'keyed';
  elements: Map<string, RawExtras>;
}

interface IndexedArrayExtras {
  kind: 'indexed';
  /** The array's known content when it was read: the extras apply only while it is unchanged. */
  known: string;
  elements: Map<number, RawExtras>;
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The ids of an array whose every element is an object with a distinct string `id`. */
function elementIds(array: readonly unknown[]): string[] | undefined {
  const ids = array.map((element) => (isObject(element) && typeof element.id === 'string' ? element.id : undefined));
  if (ids.length === 0 || ids.some((id) => id === undefined) || new Set(ids).size !== ids.length) return undefined;
  return ids as string[];
}

/**
 * What `raw` (a record as stored) holds that `parsed` (the same record through the runtime schema)
 * does not: undefined when the parse kept every stored field, which is the common case and makes
 * every later write a plain `JSON.stringify`. Defaults the parse added are not extras.
 */
export function collectRawExtras(raw: unknown, parsed: unknown): RawExtras | undefined {
  if (isObject(raw) && isObject(parsed)) {
    const fields = new Map<string, unknown>();
    const children = new Map<string, RawExtras>();
    for (const [key, value] of Object.entries(raw)) {
      if (value === undefined) continue;
      if (parsed[key] === undefined) {
        fields.set(key, value);
        continue;
      }
      const child = collectRawExtras(value, parsed[key]);
      if (child) children.set(key, child);
    }
    return fields.size > 0 || children.size > 0 ? { kind: 'object', fields, children } : undefined;
  }
  if (!Array.isArray(raw) || !Array.isArray(parsed)) return undefined;
  const rawIds = elementIds(raw);
  const parsedIds = elementIds(parsed);
  if (rawIds && parsedIds) {
    const byId = new Map(parsedIds.map((id, index) => [id, parsed[index]] as const));
    const elements = new Map<string, RawExtras>();
    rawIds.forEach((id, index) => {
      const child = byId.has(id) ? collectRawExtras(raw[index], byId.get(id)) : undefined;
      if (child) elements.set(id, child);
    });
    return elements.size > 0 ? { kind: 'keyed', elements } : undefined;
  }
  // Positions only line up while the parse kept every element.
  if (raw.length !== parsed.length) return undefined;
  const elements = new Map<number, RawExtras>();
  raw.forEach((element, index) => {
    const child = collectRawExtras(element, parsed[index]);
    if (child) elements.set(index, child);
  });
  return elements.size > 0 ? { kind: 'indexed', known: JSON.stringify(parsed), elements } : undefined;
}

/** `current` with `extras` put back where they still fit, and the extras that did. Never changes
 *  `current`: only the containers on the way to a restored field are copied. */
function merge(current: unknown, extras: RawExtras): [unknown, RawExtras | undefined] {
  if (extras.kind === 'object') {
    if (!isObject(current)) return [current, undefined];
    const out: JsonObject = { ...current };
    const fields = new Map<string, unknown>();
    const children = new Map<string, RawExtras>();
    for (const [key, value] of extras.fields) {
      // A key the runtime now has a value for is its own: it was dropped as unreadable before.
      if (out[key] !== undefined) continue;
      out[key] = value;
      fields.set(key, value);
    }
    for (const [key, child] of extras.children) {
      // The known parent is gone: everything stored under it goes with it.
      if (out[key] === undefined) continue;
      const [value, kept] = merge(out[key], child);
      out[key] = value;
      if (kept) children.set(key, kept);
    }
    if (fields.size === 0 && children.size === 0) return [current, undefined];
    return [out, { kind: 'object', fields, children }];
  }
  if (!Array.isArray(current)) return [current, undefined];
  if (extras.kind === 'keyed') {
    const elements = new Map<string, RawExtras>();
    const out = current.map((element) => {
      const id = isObject(element) && typeof element.id === 'string' ? element.id : undefined;
      const child = id === undefined ? undefined : extras.elements.get(id);
      if (!child) return element;
      const [value, kept] = merge(element, child);
      if (kept) elements.set(id!, kept);
      return value;
    });
    return elements.size > 0 ? [out, { kind: 'keyed', elements }] : [current, undefined];
  }
  if (JSON.stringify(current) !== extras.known) return [current, undefined];
  const elements = new Map<number, RawExtras>();
  const out = current.map((element, index) => {
    const child = extras.elements.get(index);
    if (!child) return element;
    const [value, kept] = merge(element, child);
    if (kept) elements.set(index, kept);
    return value;
  });
  return elements.size > 0 ? [out, { kind: 'indexed', known: extras.known, elements }] : [current, undefined];
}

/**
 * The JSON to store for `record`: exactly `JSON.stringify(record)` without extras, else the record
 * with every extra that still fits put back. `extras` in the result is what the stored JSON now
 * holds beyond the record, for the next write of the same row.
 */
export function encodeRawRecord(record: unknown, extras: RawExtras | undefined): { data: string; extras: RawExtras | undefined } {
  if (!extras) return { data: JSON.stringify(record), extras: undefined };
  const [value, kept] = merge(record, extras);
  return { data: JSON.stringify(value), extras: kept };
}

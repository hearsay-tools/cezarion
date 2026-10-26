import { resolve } from 'node:path';

// No dependency beyond Node, so CI can merge shard reports without installing the skill's packages.

const location = ({ start, end }) => `${start.line}:${start.column}-${end.line}:${end.column}`;

// Sum the counters of one map ('statementMap' with 's', ...) by source location.
// A location only one report has keeps its own counter.
function mergeCounters(target, source, map, counts, add) {
  const ids = new Map(Object.entries(target[map]).map(([id, item]) => [location(item.loc ?? item), id]));
  let next = Object.keys(target[map]).length;
  for (const [id, item] of Object.entries(source[map])) {
    const match = ids.get(location(item.loc ?? item));
    if (match === undefined) {
      target[map][next] = item;
      target[counts][next++] = source[counts][id];
    } else target[counts][match] = add(target[counts][match], source[counts][id]);
  }
}

/** Add the counters of an Istanbul report to another, keeping one entry per file. */
export function mergeIstanbulReports(target, source) {
  const entries = new Map(Object.values(target).map(entry => [resolve(entry.path), entry]));
  for (const entry of Object.values(source)) {
    const current = entries.get(resolve(entry.path));
    if (!current) {
      target[entry.path] = entry;
      continue;
    }
    mergeCounters(current, entry, 'statementMap', 's', (a, b) => a + b);
    mergeCounters(current, entry, 'fnMap', 'f', (a, b) => a + b);
    mergeCounters(current, entry, 'branchMap', 'b', (a, b) => a.length === b.length ? a.map((n, i) => n + b[i]) : a);
  }
  return target;
}

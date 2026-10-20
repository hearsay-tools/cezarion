import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The old worker-wait engine is gone (hearsay-tools/cezarion#1301): the completion gate's
 * `delegation.wait`, its `delegation.completion` record and the `activity: 'monitoring'` park.
 * Cezar's completion wait is a `worker` entry in the wait list, so no source names the old engine's
 * pieces, writes the old fields or reads them. Old rows still parse: the contract keeps the fields
 * optional, and store schema 7 reads them into the list on open (`upgradeLegacyWaits`, store.ts),
 * which with the schema history in run-database.ts and the cold index's re-derivation of an old
 * stored summary (run-index.ts) are the only places allowed to name them.
 */
const repo = join(import.meta.dirname, '../../../..');
const SCANNED = ['packages/cezar/src', 'packages/contract/src'];

/** Lines `from` through the next line matching `to`, inclusive, in `file`. */
interface Region { file: string; from: RegExp; to: RegExp }

/** The schema 4 upgrade reads the old monitoring park into a timer: its doc comment and its body. */
const MONITORING_UPGRADE: readonly Region[] = [
  { file: 'packages/cezar/src/runs/store.ts', from: /^ \* Upgrade-on-read \(store schema 4/, to: /^ \*\/$/ },
  { file: 'packages/cezar/src/runs/store.ts', from: /^export function upgradeLegacyWaits\(/, to: /^}$/ },
];

const FORBIDDEN: Array<{ name: string; pattern: RegExp; exempt?: readonly string[]; exemptRegions?: readonly Region[] }> = [
  { name: "activity: 'monitoring'", pattern: /activity: 'monitoring'/, exemptRegions: MONITORING_UPGRADE },
  { name: 'the phase 3b tag', pattern: /phase 3b \(#1235\)/ },
  { name: 'workerWaiting', pattern: /\bworkerWaiting\b/ },
  { name: 'parkWorkerWait', pattern: /\bparkWorkerWait\b/ },
  { name: 'retainsWorkerWaitOnProgress', pattern: /\bretainsWorkerWaitOnProgress\b/ },
  { name: 'prepareWorkerWaitBatch', pattern: /\bprepareWorkerWaitBatch\b/ },
  { name: 'completionWait(', pattern: /\bcompletionWait\(/ },
  // A `completion` record written into a delegation; a local's type annotation is not one.
  { name: 'completion: { write', pattern: /(?<!(?:let|const|var) )\bcompletion: \{/ },
  { name: 'a delegation.wait/lastWait/completion read', pattern: /\bdelegation\??\.(?:wait|lastWait|completion)\b/,
    // The upgrade, the schema history, and the cold index re-deriving a summary an older build stored.
    exempt: ['packages/cezar/src/runs/store.ts', 'packages/cezar/src/runs/run-database.ts', 'packages/cezar/src/runs/run-index.ts'] },
];

function sources(dir: string): string[] {
  return readdirSync(join(repo, dir), { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sources(path);
    return entry.name.endsWith('.ts') && !/\.(?:test|testkit)\.ts$/.test(entry.name) ? [path] : [];
  });
}

/** The line indexes each region covers in `lines`; a region whose markers are missing covers none. */
function regionLines(lines: readonly string[], region: Region): number[] {
  const start = lines.findIndex((line) => region.from.test(line));
  if (start < 0) return [];
  const end = lines.findIndex((line, index) => index > start && region.to.test(line));
  return end < 0 ? [] : Array.from({ length: end - start + 1 }, (_, offset) => start + offset);
}

describe('the old worker-wait engine (hearsay-tools/cezarion#1301)', () => {
  it('is not named, written or read by any source', () => {
    const hits: string[] = [];
    for (const file of SCANNED.flatMap(sources)) {
      const rel = relative(repo, join(repo, file));
      const lines = readFileSync(join(repo, file), 'utf8').split('\n');
      for (const { name, pattern, exempt, exemptRegions } of FORBIDDEN) {
        if (exempt?.includes(rel)) continue;
        const allowed = new Set((exemptRegions ?? []).filter((region) => region.file === rel).flatMap((region) => regionLines(lines, region)));
        lines.forEach((line, index) => { if (!allowed.has(index) && pattern.test(line)) hits.push(`${rel}:${index + 1}: ${name}`); });
      }
    }
    expect(hits).toEqual([]);
  });

  // An exemption is a region, not a file: one whose markers moved would silently cover nothing.
  it('finds every exempt region it names', () => {
    for (const region of FORBIDDEN.flatMap((entry) => entry.exemptRegions ?? [])) {
      expect(regionLines(readFileSync(join(repo, region.file), 'utf8').split('\n'), region), `${region.file} ${region.from}`).not.toEqual([]);
    }
  });
});

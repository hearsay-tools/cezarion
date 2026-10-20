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

const FORBIDDEN: Array<{ name: string; pattern: RegExp; exempt?: readonly string[] }> = [
  { name: "activity: 'monitoring'", pattern: /activity: 'monitoring'/, exempt: ['packages/cezar/src/runs/store.ts'] },
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

describe('the old worker-wait engine (hearsay-tools/cezarion#1301)', () => {
  it('is not named, written or read by any source', () => {
    const hits: string[] = [];
    for (const file of SCANNED.flatMap(sources)) {
      const rel = relative(repo, join(repo, file));
      readFileSync(join(repo, file), 'utf8').split('\n').forEach((line, index) => {
        for (const { name, pattern, exempt } of FORBIDDEN) {
          if (!exempt?.includes(rel) && pattern.test(line)) hits.push(`${rel}:${index + 1}: ${name}`);
        }
      });
    }
    expect(hits).toEqual([]);
  });
});

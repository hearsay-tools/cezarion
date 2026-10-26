import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { blank } from './test-wait-discipline.testkit.ts';

/**
 * Run search has one home in `packages/contract/src/run-search.ts` (hearsay-tools/cezarion#1807).
 * The ast-grep rule `run-search-field-list-outside-contract` refuses a second field list; this
 * pins the other half: every reader still asks the contract. A reader that swapped the call for its
 * own text test would pass the rule if it listed the fields some other way.
 */
const repo = join(import.meta.dirname, '../../..');
const HOME = 'packages/contract/src/run-search.ts';
const SUBPATH = /from\s+['"]@open-mercato\/cezar-(?:contract|api-client\/contract)\/run-search['"]/;

/** Each reader, and what it must call. The prefilter belongs to the two that read SQL rows. */
const READERS: Record<string, readonly string[]> = {
  'packages/cezar/src/runs/store.ts': ['matchesRunSearch', 'sqlPrefilterTokens'],
  'packages/cezar/src/runs/run-index.ts': ['matchesRunSearch', 'sqlPrefilterTokens'],
  'packages/web/src/lib/tasks-table.ts': ['matchesRunSearch'],
  'packages/web/src/lib/global-tasks.ts': ['matchesRunSearch'],
};

const read = (file: string) => readFileSync(join(repo, file), 'utf8');

describe('run search readers', () => {
  for (const [file, calls] of Object.entries(READERS)) {
    it(`${file} calls ${calls.join(' and ')} from the contract module`, () => {
      const source = read(file);
      expect(source, 'imports the contract module by its subpath').toMatch(SUBPATH);
      for (const call of calls) expect(blank(source), call).toMatch(new RegExp(`\\b${call}\\(`));
    });
  }

  it('the old server module is gone', () => {
    expect(existsSync(join(repo, 'packages/cezar/src/runs/run-search.ts'))).toBe(false);
  });

  it('the contract module imports only types, so the cold reader that loads it stays cheap', () => {
    const imports = blank(read(HOME)).split('\n').filter((line) => /^\s*import\b/.test(line));
    expect(imports.length).toBeGreaterThan(0);
    for (const line of imports) expect(line).toMatch(/^\s*import\s+type\b/);
  });
});

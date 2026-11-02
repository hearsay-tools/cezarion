import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { type Rule, type Site, scanFile } from './test-wait-discipline.ts';
import { type ScanError } from './blank.ts';

export const srcDir = resolve(import.meta.dirname, '..');

export const baselinePath = resolve(import.meta.dirname, '../test-wait-discipline.baseline.json');

export const pollsBaselinePath = resolve(import.meta.dirname, '../test-wait-discipline-polls.baseline.json');

export const ownFiles = new Set(['test-wait-discipline.testkit.ts', 'test-wait-discipline.test.ts']);

/** Every `*.test.ts` and `*.testkit.ts` under `dir`, relative to it, sorted, the scan's own excluded. */
export function scannedFiles(dir = srcDir): string[] {
  const files: string[] = [];
  const walk = (relative: string): void => {
    for (const entry of readdirSync(join(dir, relative), { withFileTypes: true })) {
      const path = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (entry.name !== 'node_modules' && entry.name !== '__fixtures__') walk(path);
      } else if (/\.(?:test|testkit)\.ts$/.test(entry.name) && !ownFiles.has(path)) files.push(path);
    }
  };
  walk('');
  return files.sort();
}

export function scanSuite(dir = srcDir): { sites: Site[]; errors: ScanError[] } {
  const sites: Site[] = [];
  const errors: ScanError[] = [];
  for (const file of scannedFiles(dir)) {
    const scanned = scanFile(file, readFileSync(join(dir, file), 'utf8'));
    sites.push(...scanned.sites);
    errors.push(...scanned.errors);
  }
  return { sites, errors };
}

/** One checked-in baseline: the rules whose sites it holds, and the comment its file opens with. */
export interface Baseline {
  /** What its sites are, for the failure message. */
  what: string;
  path: string;
  comment: string;
  rules: readonly Rule[];
}

export const baselineTail =
  'Keyed by file, rule and the line text so a moved line does not churn it. ' +
  'This list only shrinks: fix a site, then run TEST_WAIT_DISCIPLINE_UPDATE=1 npm run lint. ' +
  'Rules: AGENTS.md § Validation.';

export const baselines: readonly Baseline[] = [
  {
    what: 'bare sleep or short wait bound',
    path: baselinePath,
    comment: `Bare sleeps and short wait bounds the server unit tests carried when the ratchet landed (hearsay-tools/cezarion#1155). ${baselineTail}`,
    rules: ['sleep', 'short-bound'],
  },
  {
    what: 'poll loop with no deadline or one under 10 s',
    path: pollsBaselinePath,
    comment: `Poll loops the server unit tests carried when the deadline rule landed (hearsay-tools/cezarion#1203). ${baselineTail}`,
    rules: ['poll-deadline'],
  },
];

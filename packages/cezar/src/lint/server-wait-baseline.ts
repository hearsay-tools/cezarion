import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { type Rule, type Site, type BaselineEntry, scanFile } from './test-wait-discipline.ts';
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

/** Sites folded to `(file, rule, site) → count`, sorted for a stable file. */
export function tally(sites: Site[]): BaselineEntry[] {
  const counts = new Map<string, BaselineEntry>();
  for (const { file, rule, site } of sites) {
    const key = JSON.stringify([file, rule, site]);
    const entry = counts.get(key);
    if (entry) entry.count += 1;
    else counts.set(key, { file, rule, site, count: 1 });
  }
  return [...counts.values()].sort(
    (a, b) => a.file.localeCompare(b.file) || a.rule.localeCompare(b.rule) || a.site.localeCompare(b.site),
  );
}

/**
 * `added`: sites the baseline does not cover — a new key, or a known key seen more often than
 * recorded. `stale`: baseline entries the suite no longer has as many of — a fixed site, which
 * the baseline must shrink to match so the ratchet holds at the new level.
 */
export function compareToBaseline(
  actual: BaselineEntry[],
  baseline: BaselineEntry[],
): { added: BaselineEntry[]; stale: BaselineEntry[] } {
  const key = (e: BaselineEntry) => JSON.stringify([e.file, e.rule, e.site]);
  const recorded = new Map(baseline.map((e) => [key(e), e]));
  const seen = new Map(actual.map((e) => [key(e), e]));
  const added = actual
    .filter((e) => (recorded.get(key(e))?.count ?? 0) < e.count)
    .map((e) => ({ ...e, count: e.count - (recorded.get(key(e))?.count ?? 0) }));
  const stale = baseline.filter((e) => (seen.get(key(e))?.count ?? 0) < e.count);
  return { added, stale };
}

export interface BaselineFile {
  $comment: string;
  sites: BaselineEntry[];
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

export function readBaseline(path = baselinePath): BaselineEntry[] {
  if (!existsSync(path)) return [];
  return (JSON.parse(readFileSync(path, 'utf8')) as BaselineFile).sites;
}

/**
 * Shrink the baseline to what the suite has now. Never grows it: a site the baseline does not
 * cover stays a failure, so the only way to land one is to wait on the product's signal or give
 * the bound a reason. A baseline that does not exist yet is written once from `actual`, which is
 * how a new rule lands its first list. Run through
 * `TEST_WAIT_DISCIPLINE_UPDATE=1 npm run lint`.
 */
export function shrinkBaseline(actual: BaselineEntry[], baseline: Baseline = baselines[0]!): void {
  if (!existsSync(baseline.path)) {
    writeBaseline(actual, baseline);
    return;
  }
  const key = (e: BaselineEntry) => JSON.stringify([e.file, e.rule, e.site]);
  const seen = new Map(actual.map((e) => [key(e), e]));
  const sites = readBaseline(baseline.path)
    .map((e) => ({ ...e, count: Math.min(e.count, seen.get(key(e))?.count ?? 0) }))
    .filter((e) => e.count > 0);
  writeBaseline(sites, baseline);
}

export function writeBaseline(sites: BaselineEntry[], baseline: Baseline = baselines[0]!): void {
  const file: BaselineFile = { $comment: baseline.comment, sites };
  // `\u` escapes keep the checked-in files ASCII, so two runs on two branches write the same bytes.
  const json = JSON.stringify(file, null, 2).replace(/[\u0080-\uffff]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
  writeFileSync(baseline.path, `${json}\n`);
}

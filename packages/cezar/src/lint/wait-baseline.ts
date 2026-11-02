import { existsSync, readFileSync, writeFileSync } from 'node:fs';

/** The server and cockpit baseline ratchet, independent of either scanner's rules. */
export interface KeyedSite<Rule extends string> {
  file: string;
  rule: Rule;
  site: string;
}

export interface BaselineEntry<Rule extends string> extends KeyedSite<Rule> {
  count: number;
}

export interface BaselineOptions {
  path: string;
  comment: string;
}

/** Sites folded to `(file, rule, site) → count`, sorted for a stable file. */
export function tally<Rule extends string>(sites: KeyedSite<Rule>[]): BaselineEntry<Rule>[] {
  const counts = new Map<string, BaselineEntry<Rule>>();
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
export function compareToBaseline<Rule extends string>(
  actual: BaselineEntry<Rule>[],
  baseline: BaselineEntry<Rule>[],
): { added: BaselineEntry<Rule>[]; stale: BaselineEntry<Rule>[] } {
  const key = (e: BaselineEntry<Rule>) => JSON.stringify([e.file, e.rule, e.site]);
  const recorded = new Map(baseline.map((e) => [key(e), e]));
  const seen = new Map(actual.map((e) => [key(e), e]));
  const added = actual
    .filter((e) => (recorded.get(key(e))?.count ?? 0) < e.count)
    .map((e) => ({ ...e, count: e.count - (recorded.get(key(e))?.count ?? 0) }));
  const stale = baseline.filter((e) => (seen.get(key(e))?.count ?? 0) < e.count);
  return { added, stale };
}

interface BaselineFile<Rule extends string> {
  $comment: string;
  sites: BaselineEntry<Rule>[];
}

export function readBaseline<Rule extends string = string>(path: string): BaselineEntry<Rule>[] {
  if (!existsSync(path)) return [];
  return (JSON.parse(readFileSync(path, 'utf8')) as BaselineFile<Rule>).sites;
}

/**
 * Shrink the baseline to what the suite has now. Never grows it: a site the baseline does not
 * cover stays a failure, so the only way to land one is to wait on the product's signal or give
 * the bound a reason. A baseline that does not exist yet is written once from `actual`, which is
 * how a new rule lands its first list. Run through
 * `TEST_WAIT_DISCIPLINE_UPDATE=1 npm run lint`.
 */
export function shrinkBaseline<Rule extends string>(actual: BaselineEntry<Rule>[], baseline: BaselineOptions): void {
  if (!existsSync(baseline.path)) {
    writeBaseline(actual, baseline);
    return;
  }
  const key = (e: BaselineEntry<Rule>) => JSON.stringify([e.file, e.rule, e.site]);
  const seen = new Map(actual.map((e) => [key(e), e]));
  const sites = readBaseline<Rule>(baseline.path)
    .map((e) => ({ ...e, count: Math.min(e.count, seen.get(key(e))?.count ?? 0) }))
    .filter((e) => e.count > 0);
  writeBaseline(sites, baseline);
}

export function writeBaseline<Rule extends string>(sites: BaselineEntry<Rule>[], baseline: BaselineOptions): void {
  const file: BaselineFile<Rule> = { $comment: baseline.comment, sites };
  // `\u` escapes keep the checked-in files ASCII, so two runs on two branches write the same bytes.
  const json = JSON.stringify(file, null, 2).replace(/[\u0080-\uffff]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
  writeFileSync(baseline.path, `${json}\n`);
}

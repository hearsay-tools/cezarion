import { existsSync, readFileSync, writeFileSync } from 'node:fs'

/**
 * The ratchet the cockpit's wait-discipline scans share (`e2e-wait-discipline.ts`,
 * `unit-wait-discipline.ts`): a checked-in list of the sites a scan found the day it landed, which can
 * only shrink. Each scan owns its rules and its baseline file; this module owns how a list is tallied,
 * compared and written.
 */

/** What a baseline keys a site by: the line's text, not its number, so a moved line does not churn it. */
export interface KeyedSite<Rule extends string> {
  file: string
  rule: Rule
  site: string
}

export interface BaselineEntry<Rule extends string> extends KeyedSite<Rule> {
  count: number
}

interface BaselineFile<Rule extends string> {
  $comment: string
  sites: BaselineEntry<Rule>[]
}

const keyOf = (entry: KeyedSite<string>) => JSON.stringify([entry.file, entry.rule, entry.site])

/** Sites folded to `(file, rule, site) → count`, sorted for a stable file. */
export function tally<Rule extends string>(sites: readonly KeyedSite<Rule>[]): BaselineEntry<Rule>[] {
  const counts = new Map<string, BaselineEntry<Rule>>()
  for (const { file, rule, site } of sites) {
    const entry = counts.get(keyOf({ file, rule, site }))
    if (entry) entry.count += 1
    else counts.set(keyOf({ file, rule, site }), { file, rule, site, count: 1 })
  }
  return [...counts.values()].sort((a, b) => a.file.localeCompare(b.file) || a.rule.localeCompare(b.rule) || a.site.localeCompare(b.site))
}

/**
 * `added`: sites the baseline does not cover — a new key, or a known key seen more often than recorded.
 * `stale`: baseline entries the scan no longer has as many of — a fixed site, which the baseline must
 * shrink to match so the ratchet holds at the new level.
 */
export function compareToBaseline<Rule extends string>(
  actual: BaselineEntry<Rule>[],
  baseline: BaselineEntry<Rule>[],
): { added: BaselineEntry<Rule>[]; stale: BaselineEntry<Rule>[] } {
  const recorded = new Map(baseline.map(entry => [keyOf(entry), entry]))
  const seen = new Map(actual.map(entry => [keyOf(entry), entry]))
  const added = actual
    .filter(entry => (recorded.get(keyOf(entry))?.count ?? 0) < entry.count)
    .map(entry => ({ ...entry, count: entry.count - (recorded.get(keyOf(entry))?.count ?? 0) }))
  const stale = baseline.filter(entry => (seen.get(keyOf(entry))?.count ?? 0) < entry.count)
  return { added, stale }
}

interface BaselineOptions {
  /** The baseline file a call without a path reads and writes. */
  path: string
  /** The `$comment` written at the top of the file: what it holds, and the command that shrinks it. */
  comment: string
  /** A shrink with no file on disk writes one from the sites the scan finds, so the ratchet starts at today's level. */
  seedWhenMissing: boolean
}

/** Read, write and shrink one scan's baseline file. */
export function waitBaseline<Rule extends string>({ path: defaultPath, comment, seedWhenMissing }: BaselineOptions) {
  type Entry = BaselineEntry<Rule>
  const read = (path = defaultPath): Entry[] =>
    existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')) as BaselineFile<Rule>).sites : []
  const write = (sites: Entry[], path = defaultPath): void => {
    const file: BaselineFile<Rule> = { $comment: comment, sites }
    writeFileSync(path, `${JSON.stringify(file, null, 2)}\n`)
  }
  /** Shrink the baseline to what the scan has now. Never grows it: a site it does not cover stays a failure. */
  const shrink = (actual: Entry[], path = defaultPath): void => {
    if (seedWhenMissing && !existsSync(path)) return write(actual, path)
    const seen = new Map(actual.map(entry => [keyOf(entry), entry]))
    write(
      read(path)
        .map(entry => ({ ...entry, count: Math.min(entry.count, seen.get(keyOf(entry))?.count ?? 0) }))
        .filter(entry => entry.count > 0),
      path,
    )
  }
  return { read, write, shrink }
}

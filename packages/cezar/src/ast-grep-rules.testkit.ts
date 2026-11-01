import { execFile } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { parse } from 'yaml';
import { z } from 'zod';

/**
 * Helpers for `npm run lint` and `ast-grep-rules.test.ts`: the ast-grep rules that pin construction sites and
 * readers (hearsay-tools/cezarion#1802). A rule is a syntax-tree match, so it finds what a regex
 * over `blank()` cannot, such as an `ActiveRun` literal whatever order its fields take. The
 * rules and their baselines live in `.ai/ast-grep/rules`, one `<id>.yml` and one
 * `<id>.baseline.json` per rule, and `.ai/ast-grep/README.md` says how to add one.
 *
 * The binary comes from `@ast-grep/cli`'s own resolver, not its `ast-grep` shim: the workspace
 * denies the package's postinstall (pnpm-workspace.yaml `allowBuilds`), so the shim stays a JS
 * file that warns on stderr, and a host with no platform package must fail by name, not skip.
 */

export const repoRoot = resolve(import.meta.dirname, '../../..');
export const sgconfigPath = join(repoRoot, 'sgconfig.yml');
export const rulesDir = join(repoRoot, '.ai/ast-grep/rules');
export const ruleTestsDir = join(repoRoot, '.ai/ast-grep/rule-tests');

/** One match, as the baseline records it. */
export interface Site {
  file: string;
  rule: string;
  /** The match's first line, trimmed: a line moves with the code around it, a line number does not. */
  site: string;
  line: number;
}

export interface BaselineEntry {
  file: string;
  rule: string;
  site: string;
  count: number;
}

/** The two functions `@ast-grep/cli` exports from its `postinstall.js`; its own shim calls them. */
export interface BinaryResolver {
  detectPackageName(): string | null;
  resolveBinaryPath(): string | null;
}

const resolverSchema = z.object({
  detectPackageName: z.custom<() => string | null>((value) => typeof value === 'function'),
  resolveBinaryPath: z.custom<() => string | null>((value) => typeof value === 'function'),
});

export function loadResolver(): BinaryResolver {
  const requireFromHere = createRequire(import.meta.url);
  let manifest: string;
  try {
    manifest = requireFromHere.resolve('@ast-grep/cli/package.json');
  } catch {
    throw new Error('@ast-grep/cli is not installed, so the ast-grep rules cannot run. Run pnpm install.');
  }
  return resolverSchema.parse(requireFromHere(join(dirname(manifest), 'postinstall.js')));
}

/** The failure for a host with no ast-grep binary. Names the package, so nobody reads it as a skip. */
export function missingBinaryMessage(packageName: string | null, platform: string, arch: string): string {
  return packageName
    ? `The ast-grep binary ${packageName} is not installed, so the ast-grep rules cannot run. ` +
        'It is an optionalDependency of @ast-grep/cli: run pnpm install without --no-optional.'
    : `@ast-grep/cli ships no ast-grep binary for ${platform} ${arch} (musl libc has none either), ` +
        'so the ast-grep rules cannot run on this host.';
}

export function resolveBinary(resolver: BinaryResolver = loadResolver()): string {
  const binary = resolver.resolveBinaryPath();
  if (binary) return binary;
  throw new Error(missingBinaryMessage(resolver.detectPackageName(), process.platform, process.arch));
}

// bound: a hang guard, not a wait. A scan of every rule takes about a second on an idle host; this
// leaves room for one loaded a hundred times over. It is shorter than the test's own timeout.
const RUN_TIMEOUT_MS = 100_000;
const MAX_OUTPUT_BYTES = 64 * 1024 * 1024;

export interface AstGrepRun {
  code: number;
  stdout: string;
  stderr: string;
}

const failedRunSchema = z.object({ code: z.number(), stdout: z.string(), stderr: z.string() });

/** Runs ast-grep from the repo root. A non-zero exit is a result; a missing binary or a timeout throws. */
export async function runAstGrep(args: string[]): Promise<AstGrepRun> {
  try {
    const { stdout, stderr } = await promisify(execFile)(resolveBinary(), args, {
      cwd: repoRoot,
      encoding: 'utf8',
      maxBuffer: MAX_OUTPUT_BYTES,
      timeout: RUN_TIMEOUT_MS,
    });
    return { code: 0, stdout, stderr };
  } catch (error) {
    const failed = failedRunSchema.safeParse(error);
    if (failed.success) return failed.data;
    throw error;
  }
}

const matchesSchema = z.array(
  z.object({
    ruleId: z.string(),
    file: z.string(),
    text: z.string(),
    range: z.object({ start: z.object({ line: z.number() }) }),
  }),
);

/** Every match of every rule in `sgconfig.yml`. Reads stdout only: the shim's warning is on stderr. */
export async function scanRepository(): Promise<Site[]> {
  const run = await runAstGrep(['scan', '--config', sgconfigPath, '--json=compact']);
  if (run.code !== 0) throw new Error(`ast-grep scan exited ${run.code}:\n${run.stderr}${run.stdout}`);
  const matches = matchesSchema.parse(run.stdout.trim() === '' ? [] : JSON.parse(run.stdout));
  return matches.map((match) => ({
    file: match.file,
    rule: match.ruleId,
    site: (match.text.split('\n')[0] ?? '').trim(),
    // ast-grep counts lines from 0.
    line: match.range.start.line + 1,
  }));
}

const ruleFileSchema = z.object({ id: z.string(), message: z.string().min(1) });

export function ruleIds(dir = rulesDir): string[] {
  return readdirSync(dir)
    .filter((name) => name.endsWith('.yml'))
    .map((name) => name.slice(0, -'.yml'.length))
    .sort();
}

/** The `id` and `message` a rule file declares; the message names the owner to use instead. */
export function readRule(id: string, dir = rulesDir): z.infer<typeof ruleFileSchema> {
  return ruleFileSchema.parse(parse(readFileSync(join(dir, `${id}.yml`), 'utf8')));
}

export function baselinePath(rule: string, dir = rulesDir): string {
  return join(dir, `${rule}.baseline.json`);
}

export function baselineRules(dir = rulesDir): string[] {
  return readdirSync(dir)
    .filter((name) => name.endsWith('.baseline.json'))
    .map((name) => name.slice(0, -'.baseline.json'.length))
    .sort();
}

const baselineFileSchema = z.object({
  sites: z.array(z.object({ file: z.string(), rule: z.string(), site: z.string(), count: z.number() })),
});

/** A rule with no baseline file allows no match at all. */
export function readBaseline(rule: string, dir = rulesDir): BaselineEntry[] {
  const path = baselinePath(rule, dir);
  if (!existsSync(path)) return [];
  return baselineFileSchema.parse(JSON.parse(readFileSync(path, 'utf8'))).sites;
}

const key = (entry: { file: string; rule: string; site: string }) => JSON.stringify([entry.file, entry.rule, entry.site]);
const countOf = (counts: Map<string, number>, entry: { file: string; rule: string; site: string }) => counts.get(key(entry)) ?? 0;

/** Sites folded to `(file, rule, site) → count`, sorted for a stable file. */
export function tally(sites: Site[]): BaselineEntry[] {
  const counts = new Map<string, BaselineEntry>();
  for (const { file, rule, site } of sites) {
    const entry = counts.get(key({ file, rule, site }));
    if (entry) entry.count += 1;
    else counts.set(key({ file, rule, site }), { file, rule, site, count: 1 });
  }
  return [...counts.values()].sort(
    (a, b) => a.file.localeCompare(b.file) || a.rule.localeCompare(b.rule) || a.site.localeCompare(b.site),
  );
}

/**
 * `added`: matches the baseline does not cover, a new key or a known key seen more often than
 * recorded. `stale`: baseline entries the repository no longer has as many of, which the
 * baseline must shrink to match so the ratchet holds at the new level.
 */
export function compareToBaseline(
  actual: BaselineEntry[],
  baseline: BaselineEntry[],
): { added: BaselineEntry[]; stale: BaselineEntry[] } {
  const recorded = new Map(baseline.map((entry) => [key(entry), entry.count]));
  const seen = new Map(actual.map((entry) => [key(entry), entry.count]));
  const added = actual
    .filter((entry) => countOf(recorded, entry) < entry.count)
    .map((entry) => ({ ...entry, count: entry.count - countOf(recorded, entry) }));
  const stale = baseline.filter((entry) => countOf(seen, entry) < entry.count);
  return { added, stale };
}

/** The baseline lowered to what the repository has now. It never grows. */
export function shrink(baseline: BaselineEntry[], actual: BaselineEntry[]): BaselineEntry[] {
  const seen = new Map(actual.map((entry) => [key(entry), entry.count]));
  return baseline
    .map((entry) => ({ ...entry, count: Math.min(entry.count, countOf(seen, entry)) }))
    .filter((entry) => entry.count > 0);
}

export function writeBaseline(rule: string, sites: BaselineEntry[], dir = rulesDir): void {
  const file = {
    $comment:
      'Matches the rule found when it landed (hearsay-tools/cezarion#1802), keyed by file and the first line of the match ' +
      'so a moved line does not churn it. This list only shrinks: fix a match, then run ' +
      'AST_GREP_RULES_UPDATE=1 npm run lint. Rules: .ai/ast-grep/README.md.',
    sites,
  };
  writeFileSync(baselinePath(rule, dir), `${JSON.stringify(file, null, 2)}\n`);
}

/**
 * Update mode. A rule with no baseline file gets its first one, holding today's matches: that
 * starts a ratchet. After that the baseline is only ever lowered. A match the baseline does not
 * cover stays a failure, so the only way to land one is to use the owner the rule names.
 */
export function updateBaseline(rule: string, actual: BaselineEntry[], dir = rulesDir): void {
  if (!existsSync(baselinePath(rule, dir))) {
    if (actual.length > 0) writeBaseline(rule, actual, dir);
    return;
  }
  writeBaseline(rule, shrink(readBaseline(rule, dir), actual), dir);
}

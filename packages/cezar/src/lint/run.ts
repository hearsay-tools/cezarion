import { execFile } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import {
  baselinePath as astGrepBaselinePath,
  compareToBaseline,
  readBaseline,
  readRule,
  ruleIds,
  scanRepository,
  tally,
  updateBaseline,
} from '../ast-grep-rules.testkit.ts';
import { readExemptions, scanRootImports } from './contract-root-import.ts';
import { RULES } from './plugin.ts';
import { compareSetters, readSetterBaseline, scanSetters, WEB_SRC } from './raw-query-setter.ts';
import { readReaders, readsResumeTime } from './run-fact-reader.ts';
import { repoRoot } from './source-rule.ts';

/**
 * `npm run lint` (hearsay-tools/cezarion#2416): the repository's own rules, as one command that
 * fails closed. It runs oxlint with the `cez` plugin, then the ast-grep rules against their
 * baselines, then the checks that need the whole repository: an exemption, a reader-list entry or
 * a baseline entry that no longer names a match is stale and must go. Any tool, plugin or parse
 * error is a failure, never a pass. `docs/sdlc/lint.md` describes each rule.
 */

/** The directories oxlint reads. Each rule narrows them to its own scope (`SourceRule.applies`). */
export const LINT_PATHS = ['packages'];

// bound: a hang guard, not a wait. Oxlint reads every package source in a few seconds on an idle
// host; this leaves room for one loaded many times over.
const RUN_TIMEOUT_MS = 300_000;
const MAX_OUTPUT_BYTES = 64 * 1024 * 1024;

interface Run { code: number; stdout: string; stderr: string }

async function run(file: string, args: string[], cwd: string): Promise<Run> {
  try {
    const { stdout, stderr } = await promisify(execFile)(file, args, { cwd, encoding: 'utf8', maxBuffer: MAX_OUTPUT_BYTES, timeout: RUN_TIMEOUT_MS });
    return { code: 0, stdout, stderr };
  } catch (error) {
    const failed = error as Partial<Run> & { message?: string };
    if (typeof failed.code === 'number') return { code: failed.code, stdout: failed.stdout ?? '', stderr: failed.stderr ?? '' };
    throw error;
  }
}

/** The oxlint CLI this checkout installed. */
export function oxlintBin(): string {
  const manifest = createRequire(import.meta.url).resolve('oxlint/package.json');
  return join(dirname(manifest), 'bin/oxlint');
}

interface OxlintDiagnostic {
  message: string;
  code?: string;
  filename: string;
  labels?: Array<{ span: { line: number; column: number } }>;
}

/**
 * Oxlint's findings in `cwd`, one line each. Exit 0 or 1 with a JSON report is a result; anything
 * else, or a report that ran another number of rules than the plugin defines, is a tool failure.
 */
export async function oxlintProblems(cwd: string, paths: string[], config = '.oxlintrc.json'): Promise<string[]> {
  const result = await run(process.execPath, [oxlintBin(), '-c', config, '-f', 'json', ...paths], cwd);
  let report: { diagnostics: OxlintDiagnostic[]; number_of_rules?: number } | undefined;
  try {
    report = JSON.parse(result.stdout) as typeof report;
  } catch {
    report = undefined;
  }
  if ((result.code !== 0 && result.code !== 1) || !Array.isArray(report?.diagnostics)) {
    return [`oxlint failed (exit ${result.code}): ${`${result.stderr}${result.stdout}`.trim() || 'no output'}`];
  }
  const problems = report.diagnostics.map((d) => {
    const at = d.labels?.[0]?.span;
    // A diagnostic without a rule code is oxlint's own: a parse error or a plugin failure.
    return `${d.filename}${at ? `:${at.line}:${at.column}` : ''} ${d.code ?? 'oxlint'}: ${d.message}`;
  });
  if (report.number_of_rules !== RULES.length) {
    problems.push(`oxlint ran ${report.number_of_rules ?? 'no'} rules, but the cez plugin defines ${RULES.length}: enable exactly the cez rules in ${config}`);
  }
  if (result.code === 1 && problems.length === 0) problems.push(`oxlint exited 1 without a finding: ${result.stderr.trim()}`);
  return problems;
}

/**
 * The ast-grep rules against their baselines (hearsay-tools/cezarion#1802). With
 * `AST_GREP_RULES_UPDATE=1`, a rule without a baseline gets its first one and every other baseline
 * is lowered to today's matches; update mode never adds a match to a baseline.
 */
export async function astGrepProblems(update = process.env.AST_GREP_RULES_UPDATE === '1'): Promise<string[]> {
  const sites = await scanRepository();
  return ruleIds().flatMap((rule) => {
    const mine = sites.filter((s) => s.rule === rule);
    if (update) updateBaseline(rule, tally(mine));
    const { added, stale } = compareToBaseline(tally(mine), readBaseline(rule));
    const message = readRule(rule).message.trim().replace(/\s+/g, ' ');
    return [
      ...added.map((e) => {
        const lines = mine.filter((s) => s.file === e.file && s.site === e.site).map((s) => s.line);
        return `${e.file}:${lines.join(',')} ast-grep/${rule}: ${e.count} more than ${astGrepBaselinePath(rule).slice(repoRoot.length + 1)} records: ${e.site}. ${message} Never add a match to the baseline.`;
      }),
      ...stale.map((e) => `${astGrepBaselinePath(rule).slice(repoRoot.length + 1)} ast-grep/${rule}: stale entry ${e.file} ×${e.count}: ${e.site}. Shrink it: AST_GREP_RULES_UPDATE=1 npm run lint`),
    ];
  });
}

const EXEMPTIONS = 'packages/cezar/src/lint/contract-root-import.baseline.json';
const READERS = 'packages/cezar/src/lint/resume-time-readers.json';
const SETTERS = 'packages/web/src/test/search-params-discipline.baseline.json';

/** Entries in the rules' exemption lists and baselines under `root` that no longer name a match. */
export function staleEntries(root = repoRoot): string[] {
  const source = (file: string) => (existsSync(join(root, file)) ? readFileSync(join(root, file), 'utf8') : undefined);
  const problems: string[] = [];
  for (const file of Object.keys(readExemptions(join(root, EXEMPTIONS)))) {
    const text = source(file);
    if (text === undefined || scanRootImports(file, text).length === 0) {
      problems.push(`${EXEMPTIONS} cez/contract-root-import: ${file} no longer imports a contract root at runtime; remove its exemption`);
    }
  }
  for (const file of Object.keys(readReaders(join(root, READERS)))) {
    const text = source(file);
    if (text === undefined || !readsResumeTime(text)) {
      problems.push(`${READERS} cez/run-fact-reader: ${file} no longer reads autoResumeAt; remove it from the list`);
    }
  }
  const baseline = readSetterBaseline(join(root, SETTERS));
  const actual = [...new Set(baseline.map((entry) => entry.file))].flatMap((file) => {
    const text = source(`${WEB_SRC}${file}`);
    return text === undefined ? [] : scanSetters(file, text);
  });
  for (const entry of compareSetters(actual, baseline).stale) {
    problems.push(`${SETTERS} cez/raw-query-setter: ${entry.file} no longer has ${entry.site}; remove the entry`);
  }
  return problems;
}

/** Every problem `npm run lint` reports, in one list. */
export async function lint(): Promise<string[]> {
  const [oxlint, astGrep] = await Promise.all([oxlintProblems(repoRoot, LINT_PATHS), astGrepProblems()]);
  return [...oxlint, ...astGrep, ...staleEntries()];
}

if (import.meta.main) {
  const problems = await lint().catch((error: unknown) => [`lint failed: ${error instanceof Error ? error.message : String(error)}`]);
  for (const problem of problems) console.error(problem);
  if (problems.length > 0) {
    console.error(`\n${problems.length} lint problem(s). Rules and fixes: docs/sdlc/lint.md`);
    process.exitCode = 1;
  } else {
    console.log(`lint: ${RULES.length} cez rules and ${ruleIds().length} ast-grep rules passed`);
  }
}

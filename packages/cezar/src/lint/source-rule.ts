import { relative, resolve } from 'node:path';
import { blank } from '../test-wait-discipline.testkit.ts';

/**
 * The repository's own lint rules (hearsay-tools/cezarion#2416). Each rule keeps the source
 * scanner its Vitest guard used, so its fixture cases still pin it, and oxlint runs it on every
 * file in its scope. `docs/sdlc/lint.md` lists the rules and how to add one.
 */

/** The repository root, for data a rule reads from the repository itself. */
export const repoRoot = resolve(import.meta.dirname, '../../../..');

/** One violation in one file. `line` counts from 1, `column` from 0. */
export interface Finding {
  line: number;
  column?: number;
  message: string;
}

/** A repository rule: which files it reads, and what it finds in one of them. */
export interface SourceRule {
  /** Its id inside the `cez` plugin: `cez/<name>` in `.oxlintrc.json` and in each diagnostic. */
  name: string;
  description: string;
  /** Whether the rule reads `file`, a path relative to the root oxlint runs in. */
  applies(file: string): boolean;
  check(file: string, source: string): Finding[];
}

let lastSource: string | undefined;
let lastCode = '';

/**
 * `blank()` of the last source asked for. Oxlint runs every rule on one file before the next,
 * and four rules read the same blanked text, so one entry saves three passes per file.
 */
export function blankOnce(source: string): string {
  if (source !== lastSource) {
    lastSource = source;
    lastCode = blank(source);
  }
  return lastCode;
}

/** The 1-based line of `offset` in `source`. */
export const lineAt = (source: string, offset: number): number => source.slice(0, offset).split('\n').length;

/** A path relative to `root`, with forward slashes. */
export const repoPath = (root: string, file: string): string => relative(root, file).replaceAll('\\', '/');

/** The subset of oxlint's rule context a source rule uses. */
export interface RuleContext {
  cwd: string;
  filename: string;
  sourceCode: { text: string };
  report(descriptor: { message: string; loc: { start: { line: number; column: number }; end: { line: number; column: number } } }): void;
}

/**
 * The rule as oxlint runs it. Paths are relative to the directory oxlint runs in: `npm run lint`
 * runs it at the repository root, and a fixture test runs it in a temporary copy.
 */
export function oxlintRule(rule: SourceRule) {
  return {
    meta: { type: 'problem' as const, docs: { description: rule.description } },
    create(context: RuleContext) {
      return {
        Program() {
          const file = repoPath(context.cwd, context.filename);
          if (!rule.applies(file)) return;
          for (const finding of rule.check(file, context.sourceCode.text)) {
            const at = { line: finding.line, column: finding.column ?? 0 };
            context.report({ message: finding.message, loc: { start: at, end: at } });
          }
        },
      };
    },
  };
}

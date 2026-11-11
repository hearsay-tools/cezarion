import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from '@babel/parser';
import type { Node } from '@babel/types';
import { visit } from './home-boundary.ts';
import { lineAt, repoRoot, type SourceRule } from './source-rule.ts';

/**
 * Only `packages/cezar/src/core/` branches on a runner id. Shared code reads what the runner
 * declares (`RUNNER_FACTS` in `core/runner-facts.ts`, hearsay-tools/cezarion#2991), so a new runner
 * needs one new row and no new branch.
 *
 * Static scope: non-test TS and TSX source in `packages/cezar/src/` outside `core/`, and in
 * `packages/web/src/`. The rule reports
 * - an equality comparison (`===`, `!==`, `==`, `!=`) with a runner-id string literal on one side;
 * - a `switch` with one or more runner-id `case` labels, as one site that names its labels.
 * The ids come from `RUNNER_IDS` in `core/agent-runner.ts`, plus the legacy ids. A literal may
 * sit under parentheses, `as`, `satisfies` or `!`, or be a template with no substitution.
 *
 * The rule tracks no value and knows no type, so it over-approximates: `'pi'` and `'cursor'`
 * are also plain words. The plain form matched 45 sites, and one was no runner id: the preview
 * pane's `cursor` frame, a `switch (message.t)`. So the rule leaves out
 * - a comparison or a switch whose other operand is `t` or `type`, or ends in `.t` or `.type`:
 *   the tag of a message or an event;
 * - a comparison of two literals;
 * - an id held in a variable or a constant, an id tested with `includes`, `has`, a map lookup or
 *   a regular expression, and an id used as an object key.
 *
 * `runner-id-branch.baseline.json` lists the sites the rule lets pass, each with its count in
 * that file and a reason. It only shrinks: `npm run lint` fails a stale entry, and CI's
 * baseline-growth gate refuses a new one.
 */
const DEFINITION = 'packages/cezar/src/core/agent-runner.ts';
/** Ids that old run records still carry; `RUNNER_IDS` does not list them. */
const LEGACY_IDS = ['claude-cli'];
const SEAM = 'packages/cezar/src/core/';
const OPERATORS = new Set(['===', '!==', '==', '!=']);

export const runnerIdBranchesFile = 'packages/cezar/src/lint/runner-id-branch.baseline.json';

/** The string elements of `export const RUNNER_IDS = [...] as const`, read from the source. */
export function declaredRunnerIds(read: (path: string) => string = path => readFileSync(join(repoRoot, path), 'utf8')): string[] {
  const { program } = parse(read(DEFINITION), { sourceType: 'module', plugins: ['typescript'] });
  for (const statement of program.body) {
    const declaration = statement.type === 'ExportNamedDeclaration' && statement.declaration ? statement.declaration : statement;
    if (declaration.type !== 'VariableDeclaration') continue;
    for (const { id, init } of declaration.declarations) {
      if (id.type !== 'Identifier' || id.name !== 'RUNNER_IDS' || !init) continue;
      const list = unwrapped(init);
      const ids = list.type === 'ArrayExpression' ? list.elements.map(element => (element ? literalText(element) : undefined)) : [];
      if (ids.length > 0 && ids.every(value => value !== undefined)) return ids as string[];
    }
  }
  throw new Error(`runner-id-branch: RUNNER_IDS is not a string array literal in ${DEFINITION}`);
}

export function unwrapped(node: Node): Node {
  if (node.type === 'TSAsExpression' || node.type === 'TSSatisfiesExpression' || node.type === 'TSNonNullExpression'
    || node.type === 'TSTypeAssertion' || node.type === 'ParenthesizedExpression') return unwrapped(node.expression);
  return node;
}

/** The value of a string literal or of a template with no substitution. */
export function literalText(node: Node): string | undefined {
  const target = unwrapped(node);
  if (target.type === 'StringLiteral') return target.value;
  if (target.type === 'TemplateLiteral' && target.expressions.length === 0) return target.quasis[0]?.value.cooked ?? undefined;
  return undefined;
}

/** Babel plugins for a path: JSX only where the extension says so, because `<T>x` is a cast in `.ts`. */
export const parserPlugins = (file: string): Array<'typescript' | 'jsx'> => (/\.[cm]?[jt]sx$/.test(file) ? ['typescript', 'jsx'] : ['typescript']);

let declared: Set<string> | undefined;
const RUNNER_ID_SET = () => (declared ??= new Set([...declaredRunnerIds(), ...LEGACY_IDS]));

const TAG_NAMES = new Set(['t', 'type']);

/** `type`, `t`, `x.type` or `x.t`: the tag of a message or an event. */
function isTag(node: Node): boolean {
  const target = unwrapped(node);
  if (target.type === 'Identifier') return TAG_NAMES.has(target.name);
  if (target.type !== 'MemberExpression' && target.type !== 'OptionalMemberExpression') return false;
  return !target.computed && target.property.type === 'Identifier' && TAG_NAMES.has(target.property.name);
}

/** One branch on a runner id. `site` is its normalized text: the key of an exception entry. */
export interface RunnerIdBranch { site: string; offset: number }

export function runnerIdBranches(file: string, source: string, ids: ReadonlySet<string> = RUNNER_ID_SET()): RunnerIdBranch[] {
  // A branch needs a quoted id in the source; most files have none and are not parsed.
  if (![...ids].some(id => source.includes(`'${id}'`) || source.includes(`"${id}"`) || source.includes(`\`${id}\``))) return [];
  const ast = parse(source, { sourceType: 'module', plugins: parserPlugins(file) });
  const text = (node: Node) => source.slice(node.start ?? 0, node.end ?? 0).replace(/\s+/g, ' ');
  const runnerId = (node: Node | null | undefined) => {
    const value = node ? literalText(node) : undefined;
    return value !== undefined && ids.has(value) ? value : undefined;
  };
  const sites: RunnerIdBranch[] = [];
  visit(ast.program, (node) => {
    if (node.type === 'BinaryExpression' && OPERATORS.has(node.operator)) {
      const left = runnerId(node.left);
      const right = runnerId(node.right);
      if ((left === undefined) === (right === undefined)) return;
      const other = left === undefined ? node.left : node.right;
      if (literalText(other) !== undefined || isTag(other)) return;
      sites.push({ site: `${text(other)} ${node.operator} '${left ?? right}'`, offset: node.start ?? 0 });
    }
    if (node.type === 'SwitchStatement' && !isTag(node.discriminant)) {
      const labels = node.cases.flatMap(({ test }) => runnerId(test) ?? []);
      if (labels.length > 0) sites.push({ site: `switch (${text(node.discriminant)}) case ${labels.map(id => `'${id}'`).join(', ')}`, offset: node.start ?? 0 });
    }
  });
  return sites.sort((a, b) => a.offset - b.offset);
}

/** A site the rule lets pass `count` times in `file`. */
export interface RunnerIdBranchException { file: string; site: string; count: number; reason: string }

export function readRunnerIdBranchExceptions(path = join(repoRoot, runnerIdBranchesFile)): RunnerIdBranchException[] {
  return (JSON.parse(readFileSync(path, 'utf8')) as { entries: RunnerIdBranchException[] }).entries;
}

let listed: RunnerIdBranchException[] | undefined;

/** The branches beyond what the list allows: of each site, the ones after its allowed count. */
export function scanRunnerIdBranches(file: string, source: string, exceptions = (listed ??= readRunnerIdBranchExceptions())): RunnerIdBranch[] {
  const seen = new Map<string, number>();
  return runnerIdBranches(file, source).filter(({ site }) => {
    const count = (seen.get(site) ?? 0) + 1;
    seen.set(site, count);
    return count > (exceptions.find(entry => entry.file === file && entry.site === site)?.count ?? 0);
  });
}

const isTest = (file: string) => /\.(?:test|e2e)\.tsx?$|\.testkit\.tsx?$|\/test\//.test(file);
const applies = (file: string) => /^packages\/(?:cezar|web)\/src\/.+\.tsx?$/.test(file) && !file.startsWith(SEAM) && !isTest(file);

/** Entries that allow more than the file still has, repeat another entry, or give no reason. */
export function staleRunnerIdBranches(root = repoRoot): string[] {
  const seen = new Set<string>();
  return readRunnerIdBranchExceptions(join(root, runnerIdBranchesFile)).flatMap((entry) => {
    const path = join(root, entry.file);
    const actual = existsSync(path) ? runnerIdBranches(entry.file, readFileSync(path, 'utf8')).filter(({ site }) => site === entry.site).length : 0;
    const key = `${entry.file}\n${entry.site}`;
    const valid = applies(entry.file) && Number.isInteger(entry.count) && entry.count > 0 && entry.reason.trim() !== '' && !seen.has(key);
    seen.add(key);
    return valid && actual === entry.count ? [] : [
      `${runnerIdBranchesFile} cez/runner-id-branch: stale or invalid entry ${entry.file}: ${entry.site} (lists ${entry.count}, the file has ${actual}); lower the count or remove the entry`,
    ];
  });
}

export const runnerIdBranch: SourceRule = {
  name: 'runner-id-branch',
  description: 'Only packages/cezar/src/core/ branches on a runner id; shared code reads RUNNER_FACTS (hearsay-tools/cezarion#2991).',
  applies,
  check: (file, source) => scanRunnerIdBranches(file, source).map(({ site, offset }) => ({
    line: lineAt(source, offset),
    message: `${site}: only packages/cezar/src/core/ branches on a runner id. Read what the runner declares: RUNNER_FACTS in packages/cezar/src/core/runner-facts.ts, or add a fact there (hearsay-tools/cezarion#2991).`,
  })),
};

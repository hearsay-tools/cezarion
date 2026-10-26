import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, normalize } from 'node:path'
import { parse } from '@babel/parser'
import { VISITOR_KEYS, type Expression, type Node, type Statement } from '@babel/types'

/**
 * What the coverage evidence cannot see about a cockpit module (hearsay-tools/cezarion#1816).
 *
 * The map credits a module to a spec when one of its functions ran. Two kinds of code run without
 * a function of their own:
 *
 * - an exported value, such as a class-name constant: the functions that read it live in the
 *   modules that import it, so a change to it reaches the specs of its importers;
 * - a top-level statement, such as a listener registered at load, or a declaration whose
 *   initializer calls something: it runs in every spec that loads the module's chunk.
 *
 * The capture job reads both facts from the source at the commit it maps.
 */

export interface ModuleFacts {
  /** Repository paths of the modules this one imports or re-exports from. */
  imports: string[]
  exportsValue: boolean
  topLevelEffect: boolean
}

const EXTENSIONS = ['', '.ts', '.tsx', '/index.ts', '/index.tsx']

/** The workspace packages the cockpit imports by name; each exports `./*` as `./src/*.ts`. */
export const WORKSPACE_PACKAGES: ReadonlyArray<readonly [name: string, source: string]> = [
  ['@open-mercato/cezar-api-client', 'packages/api-client/src'],
  ['@open-mercato/cezar-contract', 'packages/contract/src'],
]

function importBase(from: string, specifier: string): string | null {
  if (specifier.startsWith('@/')) return join('packages/web/src', specifier.slice(2))
  if (specifier.startsWith('.')) return normalize(join(dirname(from), specifier))
  for (const [name, source] of WORKSPACE_PACKAGES) {
    if (specifier === name) return `${source}/index`
    if (specifier.startsWith(`${name}/`)) return join(source, specifier.slice(name.length + 1))
  }
  return null
}

/** The repository path an import names, or null for another package or a file that does not exist. */
export function resolveImport(repoRoot: string, from: string, specifier: string): string | null {
  const base = importBase(from, specifier)
  if (base === null) return null
  const stem = base.replace(/\.(?:m?js|jsx)$/, '')
  for (const candidate of [base, ...EXTENSIONS.map((extension) => stem + extension)]) {
    if (/\.tsx?$/.test(candidate) && existsSync(join(repoRoot, candidate))) return candidate.split('\\').join('/')
  }
  return null
}

function isFunction(expression: Expression | null | undefined): boolean {
  if (!expression) return false
  if (expression.type === 'TSAsExpression' || expression.type === 'TSSatisfiesExpression') return isFunction(expression.expression)
  return expression.type === 'ArrowFunctionExpression' || expression.type === 'FunctionExpression'
}

/** Whether an export statement makes a runtime value other than a function visible to importers. */
function exportsValue(statement: Statement): boolean {
  if (statement.type === 'ExportAllDeclaration') return statement.exportKind !== 'type'
  if (statement.type === 'ExportDefaultDeclaration') {
    const declaration = statement.declaration
    return declaration.type !== 'FunctionDeclaration' && declaration.type !== 'TSDeclareFunction' && !isFunction(declaration as Expression)
  }
  if (statement.type !== 'ExportNamedDeclaration' || statement.exportKind === 'type') return false
  const declaration = statement.declaration
  // `export { a }` and `export { a } from './x'` may pass a value on; a barrel stays transparent.
  if (!declaration) return statement.specifiers.length > 0
  if (declaration.type === 'VariableDeclaration') return declaration.declarations.some((item) => !isFunction(item.init))
  return declaration.type === 'ClassDeclaration' || declaration.type === 'TSEnumDeclaration'
}

const DECLARATIONS = new Set([
  'ImportDeclaration', 'ExportNamedDeclaration', 'ExportDefaultDeclaration', 'ExportAllDeclaration',
  'VariableDeclaration', 'FunctionDeclaration', 'ClassDeclaration', 'EmptyStatement',
  'TSTypeAliasDeclaration', 'TSInterfaceDeclaration', 'TSEnumDeclaration', 'TSModuleDeclaration', 'TSDeclareFunction',
  'TSImportEqualsDeclaration', 'TSExportAssignment',
])

/** Nodes whose code runs later than the module load: function bodies and instance fields. */
function deferred(node: Node): boolean {
  if (node.type === 'ClassProperty' || node.type === 'ClassPrivateProperty' || node.type === 'ClassAccessorProperty') return !node.static
  return node.type === 'ArrowFunctionExpression' || node.type === 'FunctionExpression' || node.type === 'FunctionDeclaration'
    || node.type === 'ObjectMethod' || node.type === 'ClassMethod' || node.type === 'ClassPrivateMethod'
}

const RUNS_CODE = new Set([
  'CallExpression', 'OptionalCallExpression', 'NewExpression', 'TaggedTemplateExpression', 'ImportExpression',
  'AssignmentExpression', 'UpdateExpression', 'AwaitExpression', 'YieldExpression', 'StaticBlock',
])

/**
 * Whether evaluating a declaration at module load calls or changes anything, such as the
 * initializer in `const theme = applyTheme()`. A call's effect cannot be told from its name, so
 * every call counts.
 */
function runsAtLoad(node: Node | null | undefined): boolean {
  if (!node || deferred(node)) return false
  if (RUNS_CODE.has(node.type)) return true
  const record = node as unknown as Record<string, unknown>
  return (VISITOR_KEYS[node.type] ?? []).some((key) => {
    const child = record[key]
    return Array.isArray(child) ? child.some((item) => runsAtLoad(item as Node | null)) : runsAtLoad(child as Node | null)
  })
}

/** The facts of one module, from its source text. `path` is its repository path. */
export function moduleFacts(repoRoot: string, path: string, text: string): ModuleFacts {
  const program = parse(text, {
    sourceType: 'module',
    plugins: path.endsWith('.tsx') ? ['typescript', 'jsx'] : ['typescript'],
  }).program
  const imports = new Set<string>()
  let value = false
  let effect = false
  for (const statement of program.body) {
    const source = 'source' in statement && statement.source ? statement.source.value : null
    const resolved = source ? resolveImport(repoRoot, path, source) : null
    if (resolved && !('importKind' in statement && statement.importKind === 'type')) imports.add(resolved)
    value ||= exportsValue(statement)
    effect ||= !DECLARATIONS.has(statement.type) || runsAtLoad(statement)
  }
  return { imports: [...imports].sort(), exportsValue: value, topLevelEffect: effect }
}

/** The facts of every `.ts`/`.tsx` path in `paths`, read from the checkout at `repoRoot`. */
export function readModuleGraph(repoRoot: string, paths: Iterable<string>): Map<string, ModuleFacts> {
  const graph = new Map<string, ModuleFacts>()
  for (const path of paths) {
    if (!/\.tsx?$/.test(path) || !existsSync(join(repoRoot, path))) continue
    graph.set(path, moduleFacts(repoRoot, path, readFileSync(join(repoRoot, path), 'utf8')))
  }
  return graph
}

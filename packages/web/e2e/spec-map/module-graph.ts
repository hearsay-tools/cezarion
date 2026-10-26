import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, normalize } from 'node:path'
import { parse } from '@babel/parser'
import type { Expression, Statement } from '@babel/types'

/**
 * What the coverage evidence cannot see about a cockpit module (hearsay-tools/cezarion#1816).
 *
 * The map credits a module to a spec when one of its functions ran. Two kinds of code run without
 * a function of their own:
 *
 * - an exported value, such as a class-name constant: the functions that read it live in the
 *   modules that import it, so a change to it reaches the specs of its importers;
 * - a top-level statement, such as a listener registered at load: it runs in every spec that
 *   loads the module's chunk.
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

/** The repository path an import names, or null for a package or a file that does not exist. */
export function resolveImport(repoRoot: string, from: string, specifier: string): string | null {
  let base: string
  if (specifier.startsWith('@/')) base = join('packages/web/src', specifier.slice(2))
  else if (specifier.startsWith('.')) base = normalize(join(dirname(from), specifier))
  else return null
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
    effect ||= !DECLARATIONS.has(statement.type)
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

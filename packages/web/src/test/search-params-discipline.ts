import { readFileSync, readdirSync } from 'node:fs'
import { join, relative } from 'node:path'
import { parse } from '@babel/parser'
import type { Node } from '@babel/types'

export interface SetterSite {
  file: string
  site: string
}

export interface SetterException extends SetterSite {
  reason: string
}

function walk(node: Node, visit: (node: Node) => void): void {
  visit(node)
  for (const value of Object.values(node)) {
    for (const child of Array.isArray(value) ? value : [value]) {
      if (child && typeof child === 'object' && typeof child.type === 'string') walk(child as Node, visit)
    }
  }
}

/** Guard acquiring a raw setter, rather than its spelling at a call. This also catches
 * forwarding it as a callback or alias. Read-only tuple destructuring remains valid.
 * This is a syntax guard for direct hook calls, not inter-module data-flow analysis. */
export function scanSetters(file: string, source: string): SetterSite[] {
  // Every supported hook import/property contains this spelling, even when locally renamed.
  if (!source.includes('useSearchParams')) return []
  const ast = parse(source, { sourceType: 'module', plugins: ['typescript', 'jsx'] })
  const hooks = new Set<string>()
  const namespaces = new Set<string>()
  for (const node of ast.program.body) {
    if (node.type !== 'ImportDeclaration' || !['react-router', 'react-router-dom'].includes(node.source.value)) continue
    for (const specifier of node.specifiers) {
      if (specifier.type === 'ImportNamespaceSpecifier') namespaces.add(specifier.local.name)
      if (specifier.type === 'ImportSpecifier' && specifier.imported.type === 'Identifier' && specifier.imported.name === 'useSearchParams') hooks.add(specifier.local.name)
    }
  }
  const sites: SetterSite[] = []
  walk(ast, node => {
    if (node.type !== 'VariableDeclarator' || node.init?.type !== 'CallExpression') return
    const callee = node.init.callee
    const hook = callee.type === 'Identifier' && hooks.has(callee.name)
    const namespaced = callee.type === 'MemberExpression' && callee.object.type === 'Identifier' && namespaces.has(callee.object.name) && !callee.computed && callee.property.type === 'Identifier' && callee.property.name === 'useSearchParams'
    if (!hook && !namespaced) return
    // A retained tuple can later expose its setter through indexing or destructuring.
    // Only an explicit read-only first-element binding is permitted outside the baseline.
    if (node.id.type === 'ArrayPattern' && node.id.elements.length <= 1 && !node.id.elements.some(element => element?.type === 'RestElement')) return
    sites.push({ file, site: source.slice(node.start ?? 0, node.end ?? 0).replace(/\s+/g, ' ') })
  })
  return sites
}

/** Scan every TS/JS source, including tests: fixtures inside strings are not code. */
export function scanTree(root: string, dir = root): SetterSite[] {
  return readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)).flatMap(entry => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return scanTree(root, path)
    if (!/\.[cm]?[jt]sx?$/.test(entry.name)) return []
    return scanSetters(relative(root, path).replaceAll('\\', '/'), readFileSync(path, 'utf8'))
  })
}

/** Consume one exception per site, so a duplicate cannot hide behind the same baseline row. */
export function compareSetters(actual: SetterSite[], baseline: SetterException[]) {
  const remaining = [...baseline]
  const added = actual.filter(site => {
    const index = remaining.findIndex(entry => entry.file === site.file && entry.site === site.site)
    if (index < 0) return true
    remaining.splice(index, 1)
    return false
  })
  return { added, stale: remaining }
}

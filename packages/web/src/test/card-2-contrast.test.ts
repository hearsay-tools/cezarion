// @vitest-environment node
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse } from '@babel/parser'
import type { Node, JSXAttribute } from '@babel/types'
import { expect, it } from 'vitest'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const baselinePath = join(root, 'test/card-2-contrast.baseline.json')

/** Static guard, not a computed-style audit. Unknown sizes are conservatively small.
 * Literal branches in cn()/templates are inspected; arbitrary runtime class values are not. */
function eachChild(node: Node, visit: (node: Node) => void): void {
  for (const value of Object.values(node)) {
    for (const child of Array.isArray(value) ? value : [value]) {
      if (child && typeof child === 'object' && typeof child.type === 'string') visit(child as Node)
    }
  }
}

/** Only a falsy number (0/NaN) survives React's && short circuit as visible text. */
function mayRenderFalsyNumber(node: Node): boolean {
  switch (node.type) {
    case 'BooleanLiteral': case 'NullLiteral': case 'StringLiteral':
    case 'JSXElement': case 'JSXFragment': return false
    case 'NumericLiteral': return node.value === 0
    case 'UnaryExpression': return node.operator !== '!' && node.operator !== 'void' && node.operator !== 'typeof' && node.operator !== 'delete'
    case 'BinaryExpression': return !['===', '!==', '==', '!=', '<', '>', '<=', '>=', 'in', 'instanceof'].includes(node.operator)
    default: return true // a runtime identifier/call may evaluate to 0 or NaN
  }
}

/** JSX branches are visited separately; only expressions that can render text belong to the wrapper. */
function rendersText(node: Node): boolean {
  switch (node.type) {
    case 'JSXText': return node.value.trim() !== ''
    case 'JSXElement': case 'JSXFragment': case 'JSXEmptyExpression':
    case 'NullLiteral': case 'BooleanLiteral': return false
    case 'JSXExpressionContainer': return rendersText(node.expression)
    case 'ConditionalExpression': return rendersText(node.consequent) || rendersText(node.alternate)
    case 'LogicalExpression': return (node.operator === '&&' ? mayRenderFalsyNumber(node.left) : rendersText(node.left)) || rendersText(node.right)
    default: return true // identifiers and calls can contain runtime text
  }
}

function scan(source: string): string[] {
  const file = parse(source, { sourceType: 'module', plugins: ['typescript', 'jsx'] })
  const sites: string[] = []
  function visit(node: Node, card = false, color = '', inheritedLarge = false): void {
    if (node.type === 'JSXElement') {
      const opening = node.openingElement
      const attr = (name: string) => opening.attributes.find(p => p.type === 'JSXAttribute' && p.name.type === 'JSXIdentifier' && p.name.name === name) as JSXAttribute | undefined
      const strings = (n: Node | null | undefined): string[] => {
        if (!n) return []
        if (n.type === 'StringLiteral' || n.type === 'TemplateElement') return [n.type === 'StringLiteral' ? n.value : n.value.raw]
        const result: string[] = []
        eachChild(n, c => { result.push(...strings(c)) })
        return result
      }
      const classes = strings(attr('className')?.value).join(' ').split(/\s+/)
      const slot = strings(attr('data-slot')?.value)[0]
      const backgrounds = classes.filter(c => /^bg-(?!gradient)/.test(c))
      const bodySlot = ['tool-error', 'tool-command', 'hook-entry', 'hook-source', 'hook-raw-toggle', 'hook-stdout', 'hook-stderr'].includes(slot ?? '')
      const inheritsSurface = backgrounds.length === 0 || backgrounds.some(c => c === 'bg-transparent' || c.includes('/'))
      const onCard = backgrounds.includes('bg-card-2') || inheritsSurface && (card || bodySlot)
      const ownColors = classes.filter(c => /^text-(?:danger|soft-foreground|muted-foreground|supporting-foreground|link-foreground|foreground|signal-word-red)$/.test(c))
      const colors = ownColors.length ? ownColors : [color]
      const sizes = classes.filter(c => /^text-(?:xs|sm|base|lg|xl|\d?xl|\[\d+(?:\.\d+)?px\])$/.test(c))
      const large = sizes.length ? sizes.every(s => /^(?:text-[2-9]xl|text-\[(?:2[4-9]|[3-9]\d)px\])$/.test(s)) : inheritedLarge
      const children = node.children
      const hasText = children.some(rendersText)
      if (onCard && !large && hasText && colors.some(c => c === 'text-danger' || c === 'text-soft-foreground')) {
        sites.push(source.slice(opening.start ?? 0, opening.end ?? 0).replace(/\s+/g, ' '))
      }
      for (const child of children) visit(child, onCard, colors.find(c => c === 'text-danger' || c === 'text-soft-foreground') ?? colors[0] ?? '', large)
      return
    }
    eachChild(node, child => visit(child, card, color, inheritedLarge))
  }
  visit(file)
  return sites
}

it('catches unsafe small text on the element, descendants, conditional classes and known body slots', () => {
  expect(scan(`<><p className="bg-card-2 text-danger text-xs">bad</p><div className="bg-card-2"><span className={cn('text-xs', bad ? 'text-danger' : 'text-muted-foreground')}>bad</span></div><div data-slot="tool-error" className="text-soft-foreground">bad</div></>`)).toHaveLength(3)
})
it('follows inherited ink and size through expressions and fragments', () => {
  expect(scan(`<div className="bg-card-2 text-danger text-[11px]">{ok === true && <><span>bad</span></>}</div>`)).toHaveLength(1)
  expect(scan(`<div className="bg-card-2 text-danger text-[24px]"><span className="text-xs">bad</span></div>`)).toHaveLength(1)
})
it('accepts safe ink, separate surfaces, large text, icons and unrelated text', () => {
  expect(scan(`<><div className="bg-card-2"><p className="text-muted-foreground text-xs">ok</p><svg className="text-danger"/><p className="text-danger text-[24px]">large</p><p className="bg-background text-danger">other</p></div><p className="text-danger">elsewhere</p></>`)).toEqual([])
})
it('checks every possible size and background branch conservatively', () => {
  expect(scan(`<p className={cn('bg-card-2 text-danger', ok ? 'text-2xl' : 'text-xs')}>bad</p>`)).toHaveLength(1)
  expect(scan(`<p className={cn('text-xs text-danger', ok ? 'bg-background' : 'bg-card-2')}>bad</p>`)).toHaveLength(1)
})
it('retains card-2 underneath transparent backgrounds', () => {
  expect(scan(`<div className="bg-card-2"><p className="bg-transparent text-xs text-danger">bad</p></div>`)).toHaveLength(1)
})
it('lets documented safe foregrounds override inherited unsafe ink', () => {
  expect(scan(`<div className="bg-card-2 text-danger"><span className="text-supporting-foreground">safe</span><span className="text-link-foreground">safe</span></div>`)).toEqual([])
})
it('does not count safely styled JSX branches as text in their wrapper', () => {
  expect(scan(`<div className="bg-card-2 text-danger">{ok === true && <span className="text-muted-foreground">safe</span>}{ok ? <span className="text-foreground">safe</span> : null}</div>`)).toEqual([])
  expect(scan(`<div className="bg-card-2 text-danger">{ok ? <span className="text-foreground">safe</span> : 'bad'}</div>`)).toHaveLength(1)
})
it('checks numeric falsy text rendered by logical guards', () => {
  expect(scan(`<div className="bg-card-2 text-danger text-xs">{0 && <span className="text-muted-foreground">safe</span>}</div>`)).toHaveLength(1)
  expect(scan(`<div className="bg-card-2 text-danger text-xs">{count && <span className="text-muted-foreground">safe</span>}</div>`)).toHaveLength(1)
  expect(scan(`<div className="bg-card-2 text-danger text-xs">{count > 0 && <span className="text-muted-foreground">safe</span>}{!!count && <span className="text-foreground">safe</span>}</div>`)).toEqual([])
})
it('does not allow the card-2 small-text baseline to grow or retain fixed instances', () => {
  function walk(dir: string): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap(e => e.isDirectory() ? walk(join(dir, e.name)) : e.name.endsWith('.tsx') && !e.name.includes('.test.') ? [join(dir, e.name)] : [])
  }
  const actual = walk(root).flatMap(path => scan(readFileSync(path, 'utf8')).map(site => `${relative(root, path)}: ${site}`)).sort()
  const baseline = JSON.parse(readFileSync(baselinePath, 'utf8')) as string[]
  expect(actual, 'Fix new sites; remove fixed entries from the baseline. Never add allowances.').toEqual(baseline)
})

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

function scan(source: string): string[] {
  const file = parse(source, { sourceType: 'module', plugins: ['typescript', 'jsx'] })
  const sites: string[] = []
  function visit(node: Node, card = false, color = '', size = ''): void {
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
      const background = classes.find(c => /^bg-(?!gradient)/.test(c))
      const onCard = background ? background === 'bg-card-2' : card || ['tool-error', 'tool-command', 'hook-entry', 'hook-source', 'hook-raw-toggle', 'hook-stdout', 'hook-stderr'].includes(slot ?? '')
      const ownColors = classes.filter(c => /^text-(?:danger|soft-foreground|muted-foreground|foreground|signal-word-red)$/.test(c))
      const colors = ownColors.length ? ownColors : [color]
      const ownSize = classes.find(c => /^text-(?:xs|sm|base|lg|xl|\d?xl|\[\d+(?:\.\d+)?px\])$/.test(c)) ?? size
      const large = /^(?:text-(?:[2-9]xl)|text-\[(?:2[4-9]|[3-9]\d)px\])$/.test(ownSize)
      const children = node.children
      const hasText = children.some(c => c.type === 'JSXText' ? c.value.trim() !== '' : c.type === 'JSXExpressionContainer' && c.expression.type !== 'JSXEmptyExpression')
      if (onCard && !large && hasText && colors.some(c => c === 'text-danger' || c === 'text-soft-foreground')) {
        sites.push(source.slice(opening.start ?? 0, opening.end ?? 0).replace(/\s+/g, ' '))
      }
      for (const child of children) visit(child, onCard, colors.find(c => c === 'text-danger' || c === 'text-soft-foreground') ?? colors[0] ?? '', ownSize)
      return
    }
    eachChild(node, child => visit(child, card, color, size))
  }
  visit(file)
  return sites
}

it('catches unsafe small text on the element, descendants, conditional classes and known body slots', () => {
  expect(scan(`<><p className="bg-card-2 text-danger text-xs">bad</p><div className="bg-card-2"><span className={cn('text-xs', bad ? 'text-danger' : 'text-muted-foreground')}>bad</span></div><div data-slot="tool-error" className="text-soft-foreground">bad</div></>`)).toHaveLength(3)
})
it('follows inherited ink and size through expressions and fragments', () => {
  expect(scan(`<div className="bg-card-2 text-danger text-[11px]">{ok && <><span>bad</span></>}</div>`)).toHaveLength(2)
  expect(scan(`<div className="bg-card-2 text-danger text-[24px]"><span className="text-xs">bad</span></div>`)).toHaveLength(1)
})
it('accepts safe ink, separate surfaces, large text, icons and unrelated text', () => {
  expect(scan(`<><div className="bg-card-2"><p className="text-muted-foreground text-xs">ok</p><svg className="text-danger"/><p className="text-danger text-[24px]">large</p><p className="bg-background text-danger">other</p></div><p className="text-danger">elsewhere</p></>`)).toEqual([])
})
it('does not allow the card-2 small-text baseline to grow or retain fixed instances', () => {
  function walk(dir: string): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap(e => e.isDirectory() ? walk(join(dir, e.name)) : e.name.endsWith('.tsx') && !e.name.includes('.test.') ? [join(dir, e.name)] : [])
  }
  const actual = walk(root).flatMap(path => scan(readFileSync(path, 'utf8')).map(site => `${relative(root, path)}: ${site}`)).sort()
  const baseline = JSON.parse(readFileSync(baselinePath, 'utf8')) as string[]
  expect(actual, 'Fix new sites; remove fixed entries from the baseline. Never add allowances.').toEqual(baseline)
})

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parse } from '@babel/parser'
import type { Node, JSXAttribute } from '@babel/types'
import { repoRoot, type SourceRule } from './source-rule.ts'

export const WEB_SRC = 'packages/web/src/'
export const baselineFile = 'packages/web/src/test/card-2-contrast.baseline.json'
export const readContrastBaseline = (root = repoRoot): string[] => JSON.parse(readFileSync(join(root, baselineFile), 'utf8')) as string[]

let surfaces: Set<string> | undefined
// Only named palette colors establish an opaque surface. Unknown arbitrary images,
// gradients and layout utilities retain the ancestor surface conservatively.
export function paletteSurfaces(): Set<string> {
  return surfaces ??= new Set([
    ...Array.from(readFileSync(join(repoRoot, WEB_SRC, 'styles/index.css'), 'utf8').matchAll(/--color-([\w-]+):/g), m => `bg-${m[1]}`),
    'bg-black', 'bg-white',
  ])
}

/** Static guard, not a computed-style audit. Unknown sizes are conservatively small.
 * Literal branches in cn()/templates are inspected; arbitrary runtime class values are not. */
function eachChild(node: Node, visit: (node: Node) => void): void {
  for (const value of Object.values(node)) {
    for (const child of Array.isArray(value) ? value : [value]) {
      if (child && typeof child === 'object' && typeof child.type === 'string') visit(child as Node)
    }
  }
}

/** Preserve empty alternatives: a missing size/background keeps the inherited default.
 * Bound expansion; overflow collapses to a conservative union with a small size. */
function classBranches(node: Node | null | undefined): string[] {
  if (!node) return ['']
  const combine = (groups: string[][], separator = ' '): string[] => groups.reduce((left, right) => {
    if (left.length * right.length > 128) return [[...left, ...right, 'text-xs'].join(' ')]
    return [...new Set(left.flatMap(a => right.map(b => a + separator + b)))]
  }, [''])
  switch (node.type) {
    case 'StringLiteral': return [node.value]
    case 'JSXExpressionContainer': case 'TSAsExpression': case 'TSSatisfiesExpression':
    case 'TSNonNullExpression': return classBranches(node.expression)
    case 'SpreadElement': return classBranches(node.argument)
    case 'ConditionalExpression': return [...classBranches(node.consequent), ...classBranches(node.alternate)]
    case 'LogicalExpression': return ['', ...classBranches(node.left), ...classBranches(node.right)]
    case 'CallExpression': return combine(node.arguments.map(classBranches))
    case 'ArrayExpression': return combine(node.elements.map(classBranches))
    case 'TemplateLiteral': return combine(node.quasis.flatMap((q, i) => i < node.expressions.length
      ? [[q.value.raw], classBranches(node.expressions[i])] : [[q.value.raw]]), '')
    case 'ObjectExpression': return combine(node.properties.map(p => p.type === 'ObjectProperty' && !p.computed
      ? ['', p.key.type === 'StringLiteral' ? p.key.value : p.key.type === 'Identifier' ? p.key.name : '']
      : ['']))
    default: return [''] // arbitrary runtime values still require rendered checks
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
    case 'JSXFragment': return node.children.some(rendersText)
    case 'JSXElement': case 'JSXEmptyExpression':
    case 'NullLiteral': case 'BooleanLiteral': return false
    case 'JSXExpressionContainer': case 'TSAsExpression': case 'TSSatisfiesExpression':
    case 'TSNonNullExpression': return rendersText(node.expression)
    case 'BinaryExpression': return !['===', '!==', '==', '!=', '<', '>', '<=', '>=', 'in', 'instanceof'].includes(node.operator)
    case 'UnaryExpression': return !['!', 'delete', 'void'].includes(node.operator)
    case 'ConditionalExpression': return rendersText(node.consequent) || rendersText(node.alternate)
    case 'LogicalExpression': return (node.operator === '&&' ? mayRenderFalsyNumber(node.left) : rendersText(node.left)) || rendersText(node.right)
    default: return true // identifiers and calls can contain runtime text
  }
}

/** Keep the default state and a union of possible variant ink/size changes.
 * Variant surfaces cannot guarantee opacity in every state, so only card-2 is
 * added to the union. This deliberately favors findings over unsafe exemptions. */
function utilityStates(branch: string): string[][] {
  const base: string[] = []
  const variants: string[] = []
  for (const token of branch.split(/\s+/)) {
    let depth = 0
    let lastColon = -1
    for (let i = 0; i < token.length; i++) {
      if (token[i] === '[' || token[i] === '(') depth++
      else if (token[i] === ']' || token[i] === ')') depth--
      else if (token[i] === ':' && depth === 0) lastColon = i
    }
    const utility = token.slice(lastColon + 1).replace(/^!|!$/g, '')
      .replace(/^(bg-[^/]+)\/(?:100(?:\.0+)?|\[1(?:\.0+)?\]|\[100(?:\.0+)?%\])$/, '$1')
    if (lastColon === -1) base.push(utility)
    else {
      if (utility.startsWith('text-') || utility.startsWith('font-') || utility === 'bg-card-2') variants.push(utility)
    }
  }
  return variants.length ? [base, [...base, ...variants]] : [base]
}

const namedSizes: Record<string, number> = { xs: 12, sm: 14, base: 16, lg: 18, xl: 20, '2xl': 24, '3xl': 30, '4xl': 36, '5xl': 48, '6xl': 60, '7xl': 72, '8xl': 96, '9xl': 128 }
function fontSize(utility: string): number {
  const value = utility.slice(5).split('/')[0] ?? ''
  const pixels = /^\[(\d+(?:\.\d+)?)px\]$/.exec(value)
  return pixels ? Number(pixels[1]) : namedSizes[value] ?? 0 // unknown explicit size is conservatively small
}

export function scan(source: string, surfaceClasses: Set<string>): string[] {
  const file = parse(source, { sourceType: 'module', plugins: ['typescript', 'jsx'] })
  const sites: string[] = []
  function visit(node: Node, card = false, color = '', inheritedSize = 0, inheritedBold = false): void {
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
      const slot = strings(attr('data-slot')?.value)[0]
      const bodySlot = ['tool-error', 'tool-command', 'hook-entry', 'hook-source', 'hook-raw-toggle', 'hook-stdout', 'hook-stderr'].includes(slot ?? '')
      const states = classBranches(attr('className')?.value).flatMap(utilityStates).map(classes => {
        const backgrounds = classes.filter(c => surfaceClasses.has(c) || c === 'bg-transparent' || surfaceClasses.has(c.split('/')[0] ?? ''))
        const inheritsSurface = backgrounds.length === 0 || backgrounds.some(c => c === 'bg-transparent' || c.includes('/'))
        const onCard = backgrounds.includes('bg-card-2') || inheritsSurface && (card || bodySlot)
        const ownColors = classes.map(c => c.replace(/^(text-(?:danger|destructive|soft-foreground|pending-strong))\/.+$/, '$1')).filter(c => /^text-(?:danger|destructive|soft-foreground|pending-strong|muted-foreground|supporting-foreground|link-foreground|foreground|signal-word-red|signal-word-amber)$/.test(c))
        const colors = ownColors.length ? ownColors : [color]
        const sizes = classes.filter(c => /^text-(?:xs|sm|base|lg|xl|\d+xl)(?:\/.*)?$|^text-(?:\[|\(length:)/.test(c))
        const size = sizes.length ? Math.min(...sizes.map(fontSize)) : inheritedSize
        const weights = classes.filter(c => /^font-(?:thin|extralight|light|normal|medium|semibold|bold|extrabold|black)$|^font-(?:\[|\(weight:)/.test(c))
        const bold = weights.length ? weights.every(w => /^font-(?:bold|extrabold|black)$/.test(w)) : inheritedBold
        return { onCard, colors, size, bold, large: size >= 24 || bold && size >= 56 / 3 }
      })
      const unsafe = (ink: string) => ink === 'text-danger' || ink === 'text-destructive' || ink === 'text-soft-foreground' || ink === 'text-pending-strong'
      const children = node.children
      if (children.some(rendersText) && states.some(s => s.onCard && !s.large && s.colors.some(unsafe))) {
        sites.push(source.slice(opening.start ?? 0, opening.end ?? 0).replace(/\s+/g, ' '))
      }
      // Descendants conservatively inherit any unsafe alternative across a class branch.
      const inks = states.flatMap(s => s.colors)
      for (const child of children) visit(child, states.some(s => s.onCard), inks.find(unsafe) ?? inks[0] ?? '', Math.min(...states.map(s => s.size)), states.every(s => s.bold))
      return
    }
    eachChild(node, child => visit(child, card, color, inheritedSize, inheritedBold))
  }
  visit(file)
  return sites
}


/** Consume duplicate entries individually, as the original sorted-array equality did. */
export function compareContrast(actual: string[], baseline: string[]) {
  const remaining = [...baseline]
  const added = actual.filter(site => {
    const index = remaining.indexOf(site)
    if (index < 0) return true
    remaining.splice(index, 1)
    return false
  })
  return { added, stale: remaining }
}

export const scannedContrastFile = (file: string): boolean =>
  file.startsWith(WEB_SRC) && file.endsWith('.tsx') && !file.slice(file.lastIndexOf('/') + 1).includes('.test.')

let baseline: string[] | undefined
export const card2Contrast: SourceRule = {
  name: 'card-2-contrast',
  description: 'Guard small-text contrast on card-2 (hearsay-tools/cezarion#1133, hearsay-tools/cezarion#2423).',
  applies: scannedContrastFile,
  check: (file, source) => {
    const local = file.slice(WEB_SRC.length)
    const actual = scan(source, paletteSurfaces()).map(site => `${local}: ${site}`)
    return compareContrast(actual, baseline ??= readContrastBaseline()).added.map(site => ({
      line: 1,
      message: `Unsafe small text: ${site}. Use text-muted-foreground for soft ink, text-signal-word-red for danger ink or text-signal-word-amber for amber ink. Fix new sites; remove fixed entries from the baseline. Never add allowances. (hearsay-tools/cezarion#1133, hearsay-tools/cezarion#2423).`,
    }))
  },
}

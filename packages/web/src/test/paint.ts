/**
 * The Tailwind classes that paint one property of an element, so a unit test can ask whether a
 * visible state is painted at all without copying which token paints it. jsdom resolves no CSS,
 * so the class is the only paint a unit test can read; browser specs check the resolved colours.
 */
export type PaintedProperty = 'fill' | 'stroke' | 'ink'

// Utilities that share a prefix with a colour but set something else.
const NOT_STROKE_COLOR = /^border-(?:\d|\[[\d.]+(?:px|rem)\]|solid|dashed|dotted|double|hidden|none|[xytrblse](?:-|$))/
const NOT_INK = /^text-(?:xs|sm|base|lg|[2-9]?xl|\[[\d.]+(?:px|rem|em)\]|left|center|right|justify|start|end|wrap|nowrap|balance|pretty|ellipsis|clip)$/

export function paintClasses(el: Element, property: PaintedProperty): string[] {
  const classes = (el.getAttribute('class') ?? '').split(/\s+/).filter(Boolean)
  // Variant-prefixed classes (`hover:`, `md:`) paint another state; only the resting paint counts.
  const resting = classes.filter((cls) => !cls.includes(':'))
  if (property === 'fill') return resting.filter((cls) => cls.startsWith('bg-'))
  if (property === 'stroke') return resting.filter((cls) => cls.startsWith('border-') && !NOT_STROKE_COLOR.test(cls))
  return resting.filter((cls) => cls.startsWith('text-') && !NOT_INK.test(cls))
}

/** A number written as `15`, `.0`, `0.5` or `0%`; anything else reads as fully opaque. */
const amount = (raw: string) => {
  const value = Number.parseFloat(raw.trim().replace(/%$/, ''))
  return Number.isNaN(value) ? 1 : value
}

/** True when an arbitrary colour (the text inside `bg-[…]`) has zero alpha. */
function clearArbitrary(value: string): boolean {
  const text = value.replaceAll('_', ' ').trim().toLowerCase()
  if (text === 'transparent') return true
  const hex = /^#([\da-f]{4}|[\da-f]{8})$/.exec(text)?.[1]
  if (hex) return hex.length === 4 ? hex.endsWith('0') : hex.endsWith('00')
  const args = /^[a-z]+\((.*)\)$/.exec(text)?.[1]
  if (args === undefined) return false
  const alpha = args.includes('/') ? args.slice(args.lastIndexOf('/') + 1) : args.split(',')[3]
  return alpha !== undefined && amount(alpha) === 0
}

/**
 * Present and not see-through: at least one class, none transparent or none (at any opacity),
 * none at zero opacity, and no arbitrary colour with zero alpha. A string cannot evaluate every
 * CSS colour (`var(…)`, `color-mix(…)`); the browser specs own the rendered colour.
 */
export function isPainted(classes: readonly string[]): boolean {
  return classes.length > 0 && classes.every((cls) => {
    // `bg-danger/15` is the colour `bg-danger` at 15%. Only a trailing number or bracketed value is an
    // opacity, so a slash inside an arbitrary value such as `bg-[url(/a.png)]` stays part of the colour.
    const [, color = cls, opacity] = /^(.*)\/(\d*\.?\d+|\[[^\]]*\])$/.exec(cls) ?? []
    if (/-(?:transparent|none)$/.test(color)) return false
    if (opacity !== undefined && amount(opacity.replace(/^\[|\]$/g, '')) === 0) return false
    const arbitrary = /-\[([^\]]*)\]$/.exec(color)?.[1]
    return arbitrary === undefined || !clearArbitrary(arbitrary)
  })
}

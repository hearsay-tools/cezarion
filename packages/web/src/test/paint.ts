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

/** Present and not see-through: at least one class, none transparent, none at zero opacity. */
export function isPainted(classes: readonly string[]): boolean {
  return classes.length > 0 && classes.every((cls) => !/-(?:transparent|none)$/.test(cls) && !/\/0$/.test(cls))
}

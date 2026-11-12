import { describe, expect, it } from 'vitest'

import { isPainted, paintClasses } from './paint'

const el = (className: string) => {
  const span = document.createElement('span')
  span.className = className
  return span
}

describe('paintClasses', () => {
  it('splits fill, stroke colour and ink from size, width, side and state classes', () => {
    const node = el('size-[7px] rounded-full border-[1.5px] border-t border-dashed border-danger/20 bg-card hover:bg-muted text-[13px] text-center text-foreground md:text-sm')
    expect(paintClasses(node, 'fill')).toEqual(['bg-card'])
    expect(paintClasses(node, 'stroke')).toEqual(['border-danger/20'])
    expect(paintClasses(node, 'ink')).toEqual(['text-foreground'])
  })
})

describe('isPainted', () => {
  it('needs a class and refuses transparent, none and zero opacity', () => {
    expect(isPainted(['bg-card'])).toBe(true)
    expect(isPainted(['text-inherit'])).toBe(true)
    expect(isPainted([])).toBe(false)
    expect(isPainted(['bg-transparent'])).toBe(false)
    expect(isPainted(['border-transparent'])).toBe(false)
    expect(isPainted(['bg-none'])).toBe(false)
    expect(isPainted(['bg-danger/0'])).toBe(false)
  })
})

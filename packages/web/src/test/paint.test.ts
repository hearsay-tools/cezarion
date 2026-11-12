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

  it('reads the colour before its opacity suffix', () => {
    expect(isPainted(['bg-danger/15'])).toBe(true)
    expect(isPainted(['border-accent-strong/25'])).toBe(true)
    expect(isPainted(['bg-transparent/15'])).toBe(false)
    expect(isPainted(['border-transparent/20'])).toBe(false)
    expect(isPainted(['text-transparent/50'])).toBe(false)
    expect(isPainted(['bg-none/40'])).toBe(false)
    expect(isPainted(['bg-danger/[0]'])).toBe(false)
    expect(isPainted(['bg-[url(/a/b.png)]'])).toBe(true)
  })

  it('refuses a zero opacity in every spelling', () => {
    for (const cls of ['bg-danger/[.0]', 'bg-danger/[0%]', 'bg-danger/[0.00]', 'bg-danger/.0']) expect(isPainted([cls]), cls).toBe(false)
    for (const cls of ['bg-danger/[.5]', 'bg-danger/[50%]', 'bg-danger/5']) expect(isPainted([cls]), cls).toBe(true)
  })

  it('refuses an arbitrary colour with zero alpha', () => {
    for (const cls of ['bg-[#0000]', 'bg-[#0000]/15', 'bg-[#11223300]', 'bg-[rgba(0,0,0,0)]', 'bg-[hsla(0,0%,0%,0)]',
      'bg-[rgb(0_0_0_/_0)]', 'bg-[oklch(0.5_0.1_200/0)]', 'bg-[transparent]', 'border-[rgb(0_0_0/0%)]']) {
      expect(isPainted([cls]), cls).toBe(false)
    }
    for (const cls of ['bg-[#000]', 'bg-[#0000ff]', 'bg-[#000f]', 'bg-[rgba(0,0,0,0.4)]', 'bg-[oklch(0.5_0.1_200/0.5)]', 'bg-[var(--card)]']) {
      expect(isPainted([cls]), cls).toBe(true)
    }
  })
})

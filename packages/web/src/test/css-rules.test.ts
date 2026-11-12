import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

import { cssRules, paintsBefore, targets } from './css-rules'

describe('cssRules', () => {
  it('reads each selector of a list with its at-rule chain, ignoring spacing, quotes and comments', () => {
    const rules = cssRules(`/* a { color: red } */
      @media (max-width:767px) { @container x (min-width: 1px) { [data-slot="a"]>b ,:is(.c, .d) { color : red ; content: '}' } } }
      .e{margin:0}`)
    expect(rules.map(({ selector, at, declarations }) => ({ selector, at, declarations }))).toEqual([
      { selector: "[data-slot='a'] > b", at: ['@media (max-width:767px)', '@container x (min-width: 1px)'], declarations: { color: 'red', content: "'}'" } },
      { selector: ':is(.c, .d)', at: ['@media (max-width:767px)', '@container x (min-width: 1px)'], declarations: { color: 'red', content: "'}'" } },
      { selector: '.e', at: [], declarations: { margin: '0' } },
    ])
  })

  it('resolves nested rules and nested conditions against their parent selector', () => {
    const rules = cssRules(`.e, .f { color: red; &:focus { border: 0 } .g { margin: 0 } @media (max-width: 767px) { border: none!important } }`)
    expect(rules.map(({ selector, at, declarations }) => [selector, at, declarations])).toEqual([
      ['.e', [], { color: 'red' }],
      ['.f', [], { color: 'red' }],
      ['.e:focus', [], { border: '0' }],
      ['.f:focus', [], { border: '0' }],
      ['.e .g', [], { margin: '0' }],
      ['.f .g', [], { margin: '0' }],
      ['.e', ['@media (max-width: 767px)'], { border: 'none !important' }],
      ['.f', ['@media (max-width: 767px)'], { border: 'none !important' }],
    ])
  })

  it('keeps an important declaration over a later normal one, and lets a later important one win', () => {
    expect(cssRules('.a { border: none!important; border: 1px solid red }')[0]?.declarations).toEqual({ border: 'none !important' })
    expect(cssRules('.a { border: 0; border: none !important }')[0]?.declarations).toEqual({ border: 'none !important' })
  })

  it('carries no declaration for statements such as @apply', () => {
    expect(cssRules('.a { @apply hover:bg-muted; color: red }')[0]?.declarations).toEqual({ color: 'red' })
  })

  it('throws on a sheet it cannot balance rather than returning a partial read', () => {
    expect(() => cssRules('.a { color: red')).toThrow(/unclosed block/)
    expect(() => cssRules('.a { color: red } }')).toThrow(/unbalanced/)
  })

  it('reads the Tailwind entry sheet past its @theme, @custom-variant, @utility and @keyframes blocks', () => {
    const rules = cssRules(readFileSync(path.join(import.meta.dirname, '../styles/index.css'), 'utf8'))
    const inside = (at: string) => rules.some((rule) => rule.at.includes(at))
    expect(inside('@layer base')).toBe(true)
    expect(inside('@media (prefers-reduced-motion: reduce)')).toBe(true)
  })
})

describe('targets', () => {
  it('matches the subject compound, not an ancestor', () => {
    expect(targets("[data-route='new'] .editor:focus-within", '.editor')).toBe(true)
    expect(targets(".editor > [data-slot='x y']", '.editor')).toBe(false)
    expect(targets(".editor [data-slot='x y']", "[data-slot='x y']")).toBe(true)
  })

  it('reads attribute spacing as one form and never matches a longer class name', () => {
    expect(targets("[data-slot = 'gh-issue-filters' ]", "[data-slot='gh-issue-filters']")).toBe(true)
    expect(targets('.editor-extra', '.editor')).toBe(false)
    expect(targets('.editor.x', '.editor')).toBe(true)
    expect(targets('.editor:has(> textarea)', '.editor')).toBe(true)
    expect(targets(".editor:is([data-x='a b'], .y) .z", '.editor')).toBe(false)
  })
})

describe('paintsBefore', () => {
  it('finds ::before on the subject behind state pseudo-classes, but not on a descendant', () => {
    expect(paintsBefore("[data-slot='model-pill']:hover::before", "pill']")).toBe(true)
    expect(paintsBefore("[data-slot=\"runner-pill\"]:before", "pill']")).toBe(true)
    expect(paintsBefore("[data-slot='model-pill'] span::before", "pill']")).toBe(false)
    expect(paintsBefore("[data-slot='model-pill']:is(:hover, :focus)::before", "pill']")).toBe(true)
  })
})

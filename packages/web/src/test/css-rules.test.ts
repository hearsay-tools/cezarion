import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

import { cssRules, targets } from './css-rules'

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
})

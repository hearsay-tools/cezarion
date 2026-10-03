import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * The docked layout is CSS, and jsdom does not lay anything out, so these pin the rules that keep the
 * task header and the pane's address field usable (#781 visual QA). The measured proof is the
 * live-preview e2e spec, which reads the real boxes in a browser.
 */
const css = readFileSync(join(import.meta.dirname, 'preview.css'), 'utf8')

/** The declarations of the first rule whose selector (whitespace-normalised) contains `selector`. */
function rule(selector: string): string {
  const flat = css.replace(/\s+/g, ' ')
  const at = flat.indexOf(selector)
  if (at < 0) throw new Error(`no rule for ${selector}`)
  return flat.slice(flat.indexOf('{', at) + 1, flat.indexOf('}', at))
}

describe('docked preview layout', () => {
  it('the pane cannot be squeezed below a width its toolbar fits in, nor take the whole row', () => {
    const pane = rule('.preview-pane {')
    expect(pane).toMatch(/min-width: min\(\d+px, 100%\)/)
    expect(pane).toMatch(/max-width: calc\(100% - \d+px\)/)
  })

  it('the task title keeps one truncated line and its own row, so the chips and toggle fit under it', () => {
    expect(css.replace(/\s+/g, ' ')).toMatch(/@container \(max-width: \d+px\)/)
    const title = rule("[data-slot='task-split'][data-pane='open'] [data-slot='run-title-row'] h1")
    expect(title).toContain('white-space: nowrap')
    expect(title).toContain('text-overflow: ellipsis')
    expect(title).toContain('overflow: hidden')
    expect(rule("[data-slot='task-split'][data-pane='open'] [data-slot='run-title-row'] > .group")).toMatch(/flex: 1 1 100%/)
    expect(rule("[data-slot='task-split'][data-pane='open'] [data-slot='run-title-row'] {")).toContain('flex-wrap: wrap')
  })

  it('a closed pane adds no boxes: the split and its main column lay out as if absent', () => {
    expect(rule("[data-slot='task-split'][data-pane='closed'],")).toContain('display: contents')
    expect(css.replace(/\s+/g, ' ')).toContain("[data-slot='task-split'][data-pane='closed'] > [data-slot='task-main'] {")
  })
})

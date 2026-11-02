import { paletteHex } from './test/palette'
// @vitest-environment node

import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

/** Pinned content of named cockpit files. Per-file design rules run in npm run lint
 * (hearsay-tools/cezarion#2422); these tests never walk the source tree. */

const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

function cssBlock(css: string, open: string): string {
  const idx = css.indexOf(open)
  if (idx < 0) throw new Error(`missing ${open}`)
  const brace = css.indexOf('{', idx)
  let depth = 0
  for (let i = brace; i < css.length; i++) {
    if (css[i] === '{') depth += 1
    else if (css[i] === '}') {
      depth -= 1
      if (depth === 0) return css.slice(brace + 1, i)
    }
  }
  throw new Error(`unclosed ${open}`)
}

function cssTokenMap(css: string, open: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const match of cssBlock(css, open).matchAll(/--([\w-]+):\s*([^;]+);/g)) {
    const name = match[1]
    const value = match[2]
    if (name === undefined || value === undefined) continue
    out[name] = paletteHex(value.trim().toLowerCase())
  }
  return out
}

describe('design guardian', () => {
  it('binds the approved self-hosted Poppins UI typeface', () => {
    const css = readFileSync(path.join(APP_ROOT, 'src/styles/index.css'), 'utf8')
    expect(css).toContain('@import "@fontsource/poppins/400.css"')
    expect(css).toContain('@import "@fontsource/poppins/500.css"')
    expect(css).toContain('@import "@fontsource/poppins/600.css"')
    expect(css).toContain("--sans: 'Poppins'")
    const requireFromWeb = createRequire(path.join(APP_ROOT, 'package.json'))
    const poppinsRoot = path.dirname(requireFromWeb.resolve('@fontsource/poppins/package.json'))
    expect(existsSync(path.join(poppinsRoot, 'LICENSE'))).toBe(true)
  })

  it('defines the approved mineral-teal chrome and gold action token vocabulary', () => {
    const css = readFileSync(path.join(APP_ROOT, 'src/styles/index.css'), 'utf8')
    const dark = cssTokenMap(css, ':root {')
    const light = cssTokenMap(css, '.light {')

    expect(dark['action']).toBe('#f4c542')
    expect(dark['pending']).toBe('var(--action)')
    expect(light['action'] ?? dark['action']).toBe('#f4c542')

    expect(dark).toMatchObject({
      'accent-text': '#71d2c2',
      'accent-strong': '#50c0b0',
      'accent-strong-foreground': '#0b0f17',
      'accent-icon': '#50c0b0bf',
      'task-brand-selected': '#123c3a',
      'composer-border': '#376e68',
      'message-agent-accent': 'var(--accent-text)',
      'message-agent-bg': 'var(--surface-raised)',
      'message-agent-border': 'var(--border-subtle)',
      'syn-key': '#5eead4',
      'merged-strong': '#7c3aed',
      'merged-text': '#d7bdff',
      running: '#7c3aed',
    })
    expect(light).toMatchObject({
      'accent-text': '#0f766e',
      'accent-strong': '#0f766e',
      'accent-strong-foreground': '#ffffff',
      'accent-icon': '#0f766ecc',
      'task-brand-selected': '#ccfbf1',
      'composer-border': '#438c84',
      'message-agent-accent': '#0f766e',
      'message-agent-bg': '#f1f8f7',
      'message-agent-border': '#c9deda',
      'syn-key': '#0f766e',
      'merged-strong': '#7c3aed',
      'merged-text': '#6d28d9',
      running: '#7c3aed',
    })

    const reservedPurple = new Set(['#6d28d9', '#7c3aed', '#d7bdff', '#7c3aedcc', '#8f86e8b3'])
    for (const [name, value] of [...Object.entries(dark), ...Object.entries(light)]) {
      if (reservedPurple.has(value)) {
        expect(
          name.startsWith('merged') || name === 'running' || name === 'status-running',
          `${name} still carries reserved purple ${value}`,
        ).toBe(true)
      }
    }
  })

  it('paints live-run dots with dedicated running purple, not review-required info', () => {
    const css = readFileSync(path.join(APP_ROOT, 'src/styles/index.css'), 'utf8')
    const dark = cssTokenMap(css, ':root {')
    const light = cssTokenMap(css, '.light {')
    expect(dark['running']).toBe('#7c3aed')
    expect(light['running']).toBe('#7c3aed')
    expect(dark['info']).toBe('#83baff')
    expect(light['info']).toBe('#2366b1')

    // #617: the status dot's violet family has its own sidebar-safe token; `--running` above is
    // unchanged for its other users.
    expect(dark['status-running']).toBe('#a78bfa')
    expect(light['status-running']).toBe('#7c3aed')
    const source = readFileSync(path.join(APP_ROOT, 'src/components/status-dot.tsx'), 'utf8')
    expect(source).toMatch(/tone:\s*"running",\s*className:\s*"bg-status-running"/)
    expect(source).not.toMatch(/tone:\s*"running",\s*className:\s*"bg-info"/)
  })

  it('keeps summary merged chips on reserved purple, not brand accent', () => {
    const css = readFileSync(path.join(APP_ROOT, 'src/routes/task-lists.css'), 'utf8')
    expect(css).toMatch(
      /\[data-slot="pr-chip"\]\[data-status="merged"\][^{]*\{[^}]*color:\s*var\(--merged-text\)/,
    )
    expect(css).not.toMatch(
      /\[data-slot="pr-chip"\]:is\(\[data-status="merged"\],\s*\[data-conflicting="true"\]\)[^{]*\{[^}]*color:\s*var\(--accent-text\)/,
    )
  })

  it('builds shared controls on the 44px Cezarion rhythm and composer accent', () => {
    const button = readFileSync(path.join(APP_ROOT, 'src/components/ui/button.tsx'), 'utf8')
    const input = readFileSync(path.join(APP_ROOT, 'src/components/ui/input.tsx'), 'utf8')
    const select = readFileSync(path.join(APP_ROOT, 'src/components/ui/select.tsx'), 'utf8')
    const composer = readFileSync(path.join(APP_ROOT, 'src/components/composer/composer.tsx'), 'utf8')
    expect(button).toContain('default: "h-11')
    expect(input).toContain('h-11 w-full')
    expect(select).toContain('data-[size=default]:h-11')
    expect(composer).toContain('border-[var(--composer-border)]')
  })

})

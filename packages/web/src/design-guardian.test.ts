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
  it('ships the license of the self-hosted Poppins UI typeface', () => {
    const requireFromWeb = createRequire(path.join(APP_ROOT, 'package.json'))
    const poppinsRoot = path.dirname(requireFromWeb.resolve('@fontsource/poppins/package.json'))
    expect(existsSync(path.join(poppinsRoot, 'LICENSE'))).toBe(true)
  })

  it('reserves purple for the merged and running tokens', () => {
    const css = readFileSync(path.join(APP_ROOT, 'src/styles/index.css'), 'utf8')
    const dark = cssTokenMap(css, ':root {')
    const light = cssTokenMap(css, '.light {')
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
})

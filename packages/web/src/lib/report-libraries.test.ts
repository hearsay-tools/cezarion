import { describe, expect, it } from 'vitest'
import { findLibraries, loadLibraries, scriptLibrary, TAILWIND_V3_COMPAT } from './report-libraries'

describe('scriptLibrary', () => {
  it.each([
    ['https://cdn.tailwindcss.com', 'tailwind-v3'],
    ['https://cdn.tailwindcss.com/', 'tailwind-v3'],
    ['https://cdn.tailwindcss.com/3.4.17', 'tailwind-v3'],
    ['https://cdn.tailwindcss.com?plugins=forms,typography', 'tailwind-v3'],
    ['  https://cdn.jsdelivr.net/npm/@tailwindcss/browser@4  ', 'tailwind'],
    ['https://cdn.jsdelivr.net/npm/@tailwindcss/browser@4.1.11/dist/index.global.js', 'tailwind'],
    ['https://unpkg.com/@tailwindcss/browser@4', 'tailwind'],
    ['https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.min.js', 'mermaid'],
    ['https://unpkg.com/mermaid@11.4.1/dist/mermaid.js', 'mermaid'],
    ['https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.esm.min.mjs', 'mermaid'],
  ])('maps %s to %s', (src, id) => expect(scriptLibrary(src)).toBe(id))

  it.each([
    'https://cdn.tailwindcss.com.evil.test/x.js',
    'https://evil.test/https://cdn.tailwindcss.com',
    'https://cdn.jsdelivr.net/npm/@tailwindcss/browser@3',
    'https://cdn.jsdelivr.net/npm/mermaid@10/dist/mermaid.min.js',
    'https://cdn.jsdelivr.net/npm/mermaid@110/dist/mermaid.min.js',
    'https://cdn.jsdelivr.net/npm/chart.js',
    'mermaid.min.js',
  ])('leaves %s blocked', src => expect(scriptLibrary(src)).toBeNull())
})

describe('findLibraries', () => {
  it('names each library a report loads, from tags and module imports', () => {
    expect(findLibraries('<script src="https://cdn.tailwindcss.com"></script>')).toEqual(['tailwind', 'tailwind-v3'])
    expect(findLibraries(`<script type="module">import mermaid from "https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.esm.min.mjs"</script>
      <script type="module">await import('https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.esm.min.mjs')</script>`)).toEqual(['mermaid'])
    expect(findLibraries('<script>const url = "https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.esm.min.mjs"</script><p>x</p>')).toEqual([])
  })
})

describe('loadLibraries', () => {
  it('loads the pinned code, which an inline script can carry as it is', async () => {
    const libraries = await loadLibraries(['mermaid', 'tailwind', 'tailwind-v3'])
    expect(libraries['tailwind-v3']).toBe(TAILWIND_V3_COMPAT)
    for (const id of ['mermaid', 'tailwind'] as const) {
      expect(libraries[id]!.length, id).toBeGreaterThan(100_000)
      // `<script` inside an inline script's text can change how the HTML parser ends the element.
      expect(libraries[id], id).not.toMatch(/<script/i)
    }
  })
})

describe('TAILWIND_V3_COMPAT', () => {
  it('imports Tailwind without layers and restores the v3 palette', () => {
    expect(TAILWIND_V3_COMPAT).toContain('@import "tailwindcss/utilities.css";')
    expect(TAILWIND_V3_COMPAT).not.toMatch(/layer\(/)
    expect(TAILWIND_V3_COMPAT).toContain('--color-red-600:#dc2626;')
    expect(TAILWIND_V3_COMPAT.match(/--color-[a-z]+-\d+:#[\da-f]{6};/g)).toHaveLength(242)
  })
})

// @vitest-environment node

import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

/**
 * Design guardian — a static scan enforcing the spec's design-system rules over the cockpit
 * sources (ported from mercato's guardian). It runs inside `npm test`, so a violation fails
 * the validation gate with the exact file, line, and offending token.
 *
 * Scope:
 *  - "style" rules scan shipped UI sources (`src/**` minus `*.test.*`) — tests legitimately
 *    quote forbidden tokens when asserting user-visible copy (a PR chip's `#402`) or when
 *    asserting a rule holds (`expect(...).not.toContain('h-screen')`).
 *  - "code" rules (native dialogs) scan everything that executes: `src/**` and `e2e/**`,
 *    tests included.
 *  - Comments are stripped before matching (issue references like `#377` share the hex-color
 *    grammar), with string awareness so a `//` inside a URL literal is not treated as one.
 */

const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SELF = path.basename(fileURLToPath(import.meta.url))

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
    out[name] = value.trim().toLowerCase()
  }
  return out
}

interface SourceFile {
  /** Path relative to packages/web, always with `/` separators (allowlists match on it). */
  rel: string
  ext: string
  isTest: boolean
  isE2e: boolean
  /** Comment-stripped source; stripping preserves line numbers and column positions. */
  lines: string[]
}

interface Rule {
  name: string
  why: string
  pattern: RegExp
  applies: (file: SourceFile) => boolean
  /** Files where the token is legitimate (the token definition site, primitives). */
  allowed?: (rel: string) => boolean
}

/** Shipped UI code and stylesheets — where the design tokens are the only color vocabulary. */
const styleSources = (f: SourceFile) => !f.isTest && !f.isE2e
/** Everything that executes in or against the app, tests and e2e drivers included. */
const codeSources = (f: SourceFile) => f.ext !== '.css'

const RULES: Rule[] = [
  {
    name: 'no-raw-hex-colors',
    why: 'colors go through the design tokens in src/styles/index.css, never raw hex',
    // 3/4/6/8-digit hex only (the CSS color grammar); the lookarounds reject HTML entities
    // (`&#8203;`) and longer hashes, and comment stripping removes issue refs like `#402`.
    pattern: /(?<![&\w])#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3,4})(?![\w-])/g,
    applies: styleSources,
    allowed: (rel) => rel === 'src/styles/index.css',
  },
  {
    name: 'no-amber-text',
    why: 'amber ink goes through --pending-strong, the per-theme readable token; --pending itself is a dot & spinner FILL and fails contrast as text on the light theme (token sheet rule)',
    // `text-pending-strong` is excluded by the lookahead — it is the sanctioned spelling, and it
    // is a different token, not a loophole: `--pending` is amber-400 in both themes, while
    // `--pending-strong` darkens to amber-700 on light. Everything else amber stays banned.
    pattern: /\btext-(?:pending(?!-strong)|amber(?:-\d+)?)\b/g,
    applies: styleSources,
  },
  {
    name: 'no-color-named-or-ambiguous-brand-utilities',
    why: 'UI consumes action and accent roles, never the ambiguous primary or color-named violet utilities',
    pattern: /\b(?:accent|bg|border|text|ring)-(?:primary|violet)(?:-[\w-]+)?(?:\/(?:\[[^\]]+\]|[\w.-]+))?/g,
    applies: styleSources,
    // The token sheet's `--text-primary` means primary BODY TEXT, not a brand-color utility.
    allowed: (rel) => rel === 'src/styles/index.css',
  },
  {
    name: 'no-action-color-as-chrome',
    why: 'action is reserved for action fills; selection, focus, and other chrome use the accent token family',
    pattern: /\b(?:border-action(?!-foreground)|(?:selection:)?bg-action(?!-foreground))(?:\/(?:\[[^\]]+\]|[\w.-]+))?/g,
    applies: styleSources,
    // These are the deliberate gold surfaces: shared action buttons, the mobile create action,
    // the inline Save action, the confirmed task-commit View changes link action,
    // and decorative gold points in the sparse twinkle backdrop.
    allowed: (rel) =>
      rel === 'src/components/ui/button.tsx' ||
      rel === 'src/routes/tasks-overview.tsx' ||
      rel === 'src/routes/task-thread/thread-items.tsx' ||
      rel === 'src/routes/task-git/commit-list.tsx' ||
      rel === 'src/components/centered-state.tsx' ||
      rel === 'src/styles/index.css',
  },
  {
    name: 'no-fill-accent-as-ink',
    why: 'accent-strong is a fill and border role; readable labels use accent-text and icons use accent-icon',
    pattern: /(?:\btext-accent-strong(?!-foreground)\b|\btext-\[var\(--accent-strong\)\]|\[color:\s*var\(--accent-strong\)\]|(?<![-\w])color\s*:\s*['"]?var\(--accent-strong\))/g,
    applies: styleSources,
  },
  {
    name: 'no-raw-black-white',
    why: 'use surface/foreground tokens so both themes work; bg/text-white/black bypass them',
    pattern: /\b(?:bg|text)-(?:white|black)\b/g,
    applies: styleSources,
    // The shadcn overlay scrims (dialog, sheet) and the image lightbox scrim are deliberately
    // bg-black/xx in both themes — a dark backdrop is theme-agnostic by design.
    allowed: (rel) =>
      rel.startsWith('src/components/ui/') || rel === 'src/components/zoomable-image.tsx',
  },
  {
    name: 'no-native-dialogs',
    why: 'native confirm()/alert()/prompt() block the event loop and ignore the design system',
    // Bare or window./globalThis.-qualified calls; `foo.confirm(` (someone's API) stays legal.
    pattern: /(?<![\w$.])(?:window\.|globalThis\.)?(?:confirm|alert|prompt)\s*\(/g,
    applies: codeSources,
    // The bookmarklet generator's `alert(` lives inside the javascript: PROGRAM STRING it
    // emits (spec 011, ported verbatim from web/app.js). That program runs on github.com,
    // where the cockpit's toaster does not exist — alert() is its only honest surface. The
    // cockpit's own code in that file never calls a native dialog.
    allowed: (rel) => rel === 'src/lib/bookmarklet.ts',
  },
  {
    name: 'no-dark-variant',
    why: 'theming keys off the [data-theme] tokens, not prefers-color-scheme dark: variants',
    // `dark:` immediately followed by a utility (letter, `[`, `!`, `-`, `/`) — an object
    // literal's `dark: value` key has whitespace after the colon and stays legal.
    pattern: /\bdark:(?=[a-z![/-])/g,
    applies: styleSources,
  },
  {
    name: 'fixture-serve-must-pin-cez-home',
    why: "a spec-owned `cezar serve` takes its env from fixtureServeEnv(dataRoot) — a hand-rolled { CEZ_DRY_RUN } leaves CEZ_HOME at the developer's real ~/.cezar, so every run appends a dead /tmp fixture to their project registry",
    // Line-level: a CEZ_DRY_RUN that is not accompanied by a CEZ_HOME on the same line. Both
    // fixtureServeEnv() and the specs that spell the pair inline satisfy it.
    pattern: /^(?![^\n]*CEZ_HOME)[^\n]*\bCEZ_DRY_RUN\b/g,
    applies: (f) => f.isE2e,
  },
  {
    name: 'no-100vh',
    why: 'viewport height is 100dvh/h-dvh — 100vh ignores mobile browser chrome (iOS rule)',
    pattern: /\b(?:(?:h|min-h|max-h)-screen|100vh)\b/g,
    applies: styleSources,
  },
]

/**
 * Blanks out comments while preserving the file's shape (every non-newline comment char
 * becomes a space). Tracks string state so comment openers inside literals are ignored.
 * Known limitation: regex literals are not lexed, so `/` pairs inside one can eat the rest
 * of a line — acceptable for a guardian (it can only under-report on that one line).
 */
function stripComments(source: string, lineComments: boolean): string {
  let out = ''
  let mode: 'code' | 'line' | 'block' | 'single' | 'double' | 'template' = 'code'
  let i = 0
  while (i < source.length) {
    const c = source[i]!
    const n = source[i + 1]
    if (mode === 'code') {
      if (lineComments && c === '/' && n === '/') {
        mode = 'line'
        out += '  '
        i += 2
        continue
      }
      if (c === '/' && n === '*') {
        mode = 'block'
        out += '  '
        i += 2
        continue
      }
      if (c === "'") mode = 'single'
      else if (c === '"') mode = 'double'
      else if (c === '`') mode = 'template'
      out += c
      i += 1
      continue
    }
    if (mode === 'line') {
      if (c === '\n') {
        mode = 'code'
        out += c
      } else {
        out += ' '
      }
      i += 1
      continue
    }
    if (mode === 'block') {
      if (c === '*' && n === '/') {
        mode = 'code'
        out += '  '
        i += 2
        continue
      }
      out += c === '\n' ? c : ' '
      i += 1
      continue
    }
    // String modes: honor escapes, close on the matching quote (or, for ' and ", a newline —
    // an unterminated string must not swallow the rest of the file).
    if (c === '\\') {
      out += c + (n ?? '')
      i += 2
      continue
    }
    if (
      (mode === 'single' && (c === "'" || c === '\n')) ||
      (mode === 'double' && (c === '"' || c === '\n')) ||
      (mode === 'template' && c === '`')
    ) {
      mode = 'code'
    }
    out += c
    i += 1
    continue
  }
  return out
}

const SCANNED_EXTENSIONS = new Set(['.ts', '.tsx', '.css'])

function walk(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules') continue
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...walk(full))
    else if (SCANNED_EXTENSIONS.has(path.extname(entry.name))) out.push(full)
  }
  return out
}

function loadSources(): SourceFile[] {
  const files: SourceFile[] = []
  for (const root of ['src', 'e2e']) {
    for (const abs of walk(path.join(APP_ROOT, root))) {
      const rel = path.relative(APP_ROOT, abs).split(path.sep).join('/')
      // This file defines the forbidden patterns as literals; scanning it would be circular.
      if (path.basename(rel) === SELF) continue
      const ext = path.extname(rel)
      const stripped = stripComments(readFileSync(abs, 'utf8'), ext !== '.css')
      files.push({
        rel,
        ext,
        isTest: /\.test\.(?:ts|tsx)$/.test(rel),
        isE2e: rel.startsWith('e2e/'),
        lines: stripped.split('\n'),
      })
    }
  }
  return files
}

const sources = loadSources()

describe('design guardian', () => {
  it('actually scans the codebase (guards against a broken walker)', () => {
    const rels = new Set(sources.map((f) => f.rel))
    expect(rels.has('src/app.tsx')).toBe(true)
    expect(rels.has('src/styles/index.css')).toBe(true)
    expect(rels.has('e2e/smoke.e2e.ts')).toBe(true)
    expect(sources.length).toBeGreaterThan(40)
  })

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
      'accent-text': '#5eead4',
      'accent-strong': '#2dd4bf',
      'accent-strong-foreground': '#0b0f17',
      'accent-icon': '#2dd4bfb3',
      'task-brand-selected': '#123c3a',
      'composer-border': '#347d75',
      'message-agent-accent': '#5eead4',
      'message-agent-bg': '#10201f',
      'message-agent-border': '#29423f',
      'syn-key': '#5eead4',
      'merged-strong': '#7c3aed',
      'merged-text': '#d7bdff',
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
    })

    const reservedPurple = new Set(['#6d28d9', '#7c3aed', '#d7bdff', '#7c3aedcc', '#8f86e8b3'])
    for (const [name, value] of [...Object.entries(dark), ...Object.entries(light)]) {
      if (reservedPurple.has(value)) {
        expect(name.startsWith('merged'), `${name} still carries reserved purple ${value}`).toBe(true)
      }
    }
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

  it('recognizes every direct fill-accent ink spelling the cockpit supports', () => {
    const rule = RULES.find(({ name }) => name === 'no-fill-accent-as-ink')!
    const pattern = new RegExp(rule.pattern.source)
    for (const source of [
      'text-accent-strong',
      'text-[var(--accent-strong)]',
      '[color:var(--accent-strong)]',
      "style={{ color: 'var(--accent-strong)' }}",
      'color: var(--accent-strong);',
    ]) {
      expect(source, source).toMatch(pattern)
    }
  })

  for (const rule of RULES) {
    it(`${rule.name}: ${rule.why}`, () => {
      const violations: string[] = []
      for (const file of sources) {
        if (!rule.applies(file)) continue
        if (rule.allowed?.(file.rel)) continue
        file.lines.forEach((line, index) => {
          for (const match of line.matchAll(rule.pattern)) {
            violations.push(`packages/web/${file.rel}:${index + 1}  ${match[0].trim()}`)
          }
        })
      }
      expect(violations, `${rule.name} — ${rule.why}`).toEqual([])
    })
  }
})

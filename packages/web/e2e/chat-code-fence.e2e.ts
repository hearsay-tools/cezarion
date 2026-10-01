import { spawn, type ChildProcess } from 'node:child_process'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { stopFixtureServer } from './fixture-server'
import { AgentBrowser, bootProjectId, cezarCli, fixtureServeEnv } from './agent-browser'
import { applyContrastQaVariant, contrastQaVariants, restoreContrastQaDefaults } from './contrast'
import record from './fixtures/thread-run.record.json'
import { waitForHealth } from './poll'

/**
 * #742: a fenced code block in chat must keep one source line per visual line, in the user's
 * bubble and in the assistant's message. Streamdown renders each source line as a bare `<span>`
 * inside `<code>`; only its line-number mode gives that span `display: block`, and the cockpit
 * passes `lineNumbers={false}`, so without the `.thread-markdown` rule every line ran into the
 * next. The assertions are on rendered POSITIONS (top of each line, left of each indent), not on
 * the DOM shape, because the DOM was always fine.
 *
 * Same boot-own-server doctrine as task-thread.e2e.ts: the transcript is the recorded NDJSON
 * with its user follow-up and markdown reply swapped for the fences below.
 */

const sessionId = `e2e-chat-fence-${process.pid}`
const RUN_ID: string = record.id
const FENCES = [
  { lang: '', body: '## Firewall\n- asd\n- bcd\n\n## Users\n- something' },
  { lang: 'ts', body: 'function f() {\n  return 1\n\n}' },
  { lang: 'wat', body: '(a)\n  (b)\n\n(c)' },
]
/** The final fence is left unterminated, the shape a message has mid-stream. */
const OPEN_FENCE = { lang: '', body: '## Firewall\n- asd\n- bcd\n\n## Users\n- something' }
const document_ = (): string =>
  FENCES.map((f, i) => `Fence ${i + 1}:\n\n\`\`\`${f.lang}\n${f.body}\n\`\`\`\n`).join('\n')
  + `\nOpen fence:\n\n\`\`\`\n${OPEN_FENCE.body}`
const ALL = [...FENCES, OPEN_FENCE]

function freePort(): Promise<number> {
  return new Promise((done, fail) => {
    const probe = createServer()
    probe.once('error', fail)
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address()
      const port = typeof address === 'object' && address ? address.port : 0
      probe.close(() => done(port))
    })
  })
}

let browser: AgentBrowser
let server: ChildProcess
let dataRoot: string
let baseUrl: string
let bootProject: string

function transcript(): string {
  const text = document_()
  return readFileSync(resolve(import.meta.dirname, 'fixtures/thread-run.ndjson'), 'utf8')
    .split('\n')
    .map((line) => {
      if (!line) return line
      const event = JSON.parse(line)
      if (event.type === 'user-message') event.text = text
      else if (event.type === 'text' && String(event.text).startsWith('## Markdown fixture')) event.text = text
      else if (event.item?.kind === 'message' && String(event.item.text).startsWith('## Markdown fixture')) event.item.text = text
      return JSON.stringify(event)
    })
    .join('\n')
}

beforeAll(async () => {
  dataRoot = mkdtempSync(join(tmpdir(), 'cezar-e2e-fence-'))
  mkdirSync(join(dataRoot, '.ai/cezar/runs'), { recursive: true })
  writeFileSync(join(dataRoot, '.ai/cezar/runs.json'), JSON.stringify([record], null, 2), 'utf8')
  writeFileSync(join(dataRoot, '.ai/cezar/runs', `${RUN_ID}.ndjson`), transcript())
  cpSync(resolve(import.meta.dirname, 'fixtures/thread-run-images'), join(dataRoot, '.ai/cezar/runs', `${RUN_ID}-images`), { recursive: true })

  const port = await freePort()
  baseUrl = `http://localhost:${port}`
  server = spawn(process.execPath, [cezarCli, 'serve', '--repo', dataRoot, '--port', String(port), '--no-open'], {
    env: fixtureServeEnv(dataRoot), stdio: 'ignore',
  })
  await waitForHealth(baseUrl)
  bootProject = await bootProjectId(baseUrl)
  browser = AgentBrowser.open(sessionId)
  browser.setViewport(1440, 900)
  browser.goto(`${baseUrl}/p/${bootProject}/tasks/${RUN_ID}`)
  browser.waitForFunction(`document.querySelectorAll('[data-slot="user-bubble"] [data-streamdown="code-block"]').length >= ${ALL.length}
    && document.querySelectorAll('[data-slot="assistant-message"] [data-streamdown="code-block"]').length >= ${ALL.length}`)
}, 120_000)

afterAll(async () => {
  browser?.close()
  await stopFixtureServer(server)
  if (dataRoot) rmSync(dataRoot, { recursive: true, force: true })
})

interface Line { text: string; top: number; height: number; left: number }
interface Measure { lines: Line[]; lineHeight: number; codeLeft: number }

/** Every fence under `scope`, as the rendered rows: top of each source line's box and the left of
 *  its first non-space glyph (a Range, so a blank line reports no left). */
const measure = (scope: string): Measure[] => browser.evaluate(`(() => [...document.querySelectorAll(${JSON.stringify(scope + ' [data-streamdown="code-block"]')})].map((block) => {
  const code = block.querySelector('code')
  const lineHeight = parseFloat(getComputedStyle(code).lineHeight)
  const lines = [...code.children].map((span) => {
    const box = span.getBoundingClientRect()
    const text = span.textContent.replace(/\\n$/, '')
    let left = 0
    const walker = document.createTreeWalker(span, NodeFilter.SHOW_TEXT)
    for (let node = walker.nextNode(); node && !left; node = walker.nextNode()) {
      const at = node.textContent.search(/\\S/)
      if (at < 0) continue
      const range = document.createRange(); range.setStart(node, at); range.setEnd(node, at + 1)
      left = range.getBoundingClientRect().left
    }
    return { text, top: box.top, height: box.height, left }
  })
  return { lines, lineHeight, codeLeft: code.getBoundingClientRect().left }
}))()`) as Measure[]

function expectSourceLines(blocks: Measure[], label: string): void {
  expect(blocks, label).toHaveLength(ALL.length)
  blocks.forEach((block, index) => {
    const source = ALL[index]!.body.split('\n')
    const where = `${label} fence ${index + 1}`
    expect(block.lines.map((l) => l.text), where).toEqual(source)
    block.lines.forEach((line, row) => {
      if (row === 0) return
      // One line box per source line — the blank line included — never two on the same row.
      const step = line.top - block.lines[row - 1]!.top
      expect(step, `${where} row ${row}`).toBeGreaterThan(block.lineHeight - 1)
      expect(step, `${where} row ${row}`).toBeLessThan(block.lineHeight + 1)
    })
    source.forEach((text, row) => {
      const indent = text.length - text.trimStart().length
      if (text && indent) expect(block.lines[row]!.left - block.codeLeft, `${where} indent`).toBeGreaterThan(indent * 3)
    })
  })
}

const noPageOverflow = () => browser.evaluate(`document.documentElement.scrollWidth <= window.innerWidth`)

describe('chat fenced code blocks (#742)', () => {
  for (const variant of contrastQaVariants.filter((v) => v.density === 'comfortable')) {
    it(`keeps every source line on its own row in user and assistant messages (${variant.id})`, () => {
      applyContrastQaVariant(browser, variant)
      try {
        expectSourceLines(measure('[data-slot="user-bubble"]'), `${variant.id} user`)
        expectSourceLines(measure('[data-slot="assistant-message"]'), `${variant.id} assistant`)
        expect(noPageOverflow()).toBe(true)
      } finally {
        restoreContrastQaDefaults(browser)
      }
    })
  }

  it('keeps syntax highlighting on a supported language and copies the exact source', () => {
    // Highlighting survived the layout rule: the lazy Shiki singleton coloured some ts token
    // beyond the plain `--syn-var` ink.
    browser.waitForFunction(`[...document.querySelectorAll('[data-slot="assistant-message"] [data-streamdown="code-block"][data-language="ts"] code span span')]
      .some((s) => !['', 'var(--syn-var)'].includes(s.style.getPropertyValue('--sdm-c')))`)
    browser.evaluate(`window.__copied = []; navigator.clipboard.writeText = (t) => { window.__copied.push(t); return Promise.resolve() }`)
    for (const [index, fence] of ALL.entries()) {
      browser.evaluate(`document.querySelectorAll('[data-slot="assistant-message"] [data-streamdown="code-copy-button"], [data-slot="assistant-message"] [data-streamdown="code-block-copy-button"]')[${index}].click()`)
      browser.waitForFunction(`window.__copied.length === ${index + 1}`)
      // Streamdown copies the fence value with the one trailing newline the mdast `code` node carries.
      expect(browser.evaluate(`window.__copied[${index}]`)).toBe(`${fence.body}\n`)
    }
  })
})

import { spawn, type ChildProcess } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { waitForSettledSample } from './visual-ready'
import { stopFixtureServer } from './fixture-server'
import { AgentBrowser, bootProjectId, fixtureServeEnv } from './agent-browser'
import record from './fixtures/thread-run.record.json'
import { waitForHealth } from './poll'

/**
 * #730 — an assistant reply's single newlines render as visible line breaks in the loaded
 * (reloaded-history) thread, while blank lines, lists, tables, links, emphasis and code keep
 * their formatting, and long lines wrap without horizontal page overflow at desktop and 360px
 * in both themes. The streaming and remount paths are covered against the real component in
 * `thread-items.test.tsx`.
 */
const repoRoot = resolve(import.meta.dirname, '../../..')
const artifactsDir = resolve(repoRoot, '.ai/qa/artifacts_e2e')
const sessionId = `e2e-assistant-line-breaks-${process.pid}`
const RUN_ID = 'aaaaaaaa-7300-4222-8333-bbbbbbbbbbbb'
const RUN = {
  ...record,
  id: RUN_ID,
  title: 'Assistant line breaks',
  titleSummary: 'Assistant line breaks',
  task: 'Show the plan.',
  status: 'review',
  steps: [record.steps[0]],
  pullRequestUrl: undefined,
}
const LONG = 'a-very-long-unbroken-token-'.repeat(12)
const REPLY = [
  'Step one done',
  'Step two **bold** with `inline`',
  `Long line ${LONG} and then more words that must wrap inside the column`,
  '',
  '- item a',
  '- item b',
  '',
  '| h1 | h2 |',
  '| -- | -- |',
  '| a | b |',
  '',
  '```ts',
  'const a = 1',
  'const b = 2',
  '```',
].join('\n')
const events = [
  { type: 'step-start', stepId: 'task', name: 'Do the task', kind: 'agent', iteration: 1 },
  { type: 'session.started', sessionId: 's', backend: 'claude', stepId: 'task' },
  { type: 'turn.started', turnId: 'turn_1', stepId: 'task' },
  { type: 'item.started', item: { kind: 'message', id: 'm1', role: 'assistant', text: REPLY }, stepId: 'task' },
  { type: 'item.completed', item: { kind: 'message', id: 'm1', role: 'assistant', text: REPLY }, stepId: 'task' },
].map((event, index) => ({ ...event, seq: index + 1, ts: new Date(Date.parse(RUN.createdAt) + index * 10).toISOString() }))

function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const probe = createServer()
    probe.once('error', reject)
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address()
      const port = typeof address === 'object' && address ? address.port : 0
      probe.close(() => resolvePort(port))
    })
  })
}

let browser: AgentBrowser
let server: ChildProcess
let dataRoot: string
let baseUrl: string
let bootProject: string

const MESSAGE = `document.querySelector('[data-slot="assistant-message"] .thread-markdown')`

beforeAll(async () => {
  dataRoot = mkdtempSync(join(tmpdir(), 'cezar-e2e-assistant-breaks-'))
  mkdirSync(join(dataRoot, '.ai/cezar/runs'), { recursive: true })
  writeFileSync(join(dataRoot, '.ai/cezar/runs.json'), JSON.stringify([RUN], null, 2), 'utf8')
  writeFileSync(
    join(dataRoot, '.ai/cezar/runs', `${RUN_ID}.ndjson`),
    events.map((event) => JSON.stringify(event)).join('\n') + '\n',
    'utf8',
  )
  const port = await freePort()
  baseUrl = `http://localhost:${port}`
  server = spawn(
    process.execPath,
    [join(repoRoot, 'packages/cezar/dist/index.js'), 'serve', '--repo', dataRoot, '--port', String(port), '--no-open'],
    { env: fixtureServeEnv(dataRoot), stdio: 'ignore' },
  )
  await waitForHealth(baseUrl)
  bootProject = await bootProjectId(baseUrl)
  browser = AgentBrowser.open(sessionId)
  browser.setViewport(1440, 900)
  browser.goto(`${baseUrl}/p/${bootProject}/tasks/${RUN_ID}`)
  browser.waitForFunction(`${MESSAGE} !== null`)
}, 120_000)

afterAll(async () => {
  browser?.close()
  await stopFixtureServer(server)
  if (dataRoot) rmSync(dataRoot, { recursive: true, force: true })
})

describe('assistant reply line breaks (#730)', () => {
  const sizes = [[1440, 900, 'desktop'], [360, 640, '360']] as const
  const themes = ['light', 'dark'] as const

  for (const [width, height, label] of sizes) {
    for (const theme of themes) {
      it(`keeps single newlines and formatting, and wraps long lines, at ${label} in ${theme}`, () => {
        browser.setViewport(width, height)
        browser.evaluate(`(() => {
          document.documentElement.classList.remove('light', 'dark')
          document.documentElement.classList.add('${theme}')
        })()`)
        const shape = waitForSettledSample(browser,
          `(() => {
            const md = ${MESSAGE}
            if (!md) return null
            // #795/#758: scroll lazy markdown, but read only a later rendered sample.
            const rendered = md.checkVisibility({ contentVisibilityAuto: true })
            md.scrollIntoView({ block: 'start' })
            if (!rendered) return null
            const scroller = document.scrollingElement
            return {
              paragraphBreaks: md.querySelectorAll('p br').length,
              paragraphs: md.querySelectorAll('p').length,
              strong: md.querySelectorAll('[data-streamdown="strong"]').length,
              items: md.querySelectorAll('li').length,
              tables: md.querySelectorAll('table').length,
              fences: md.querySelectorAll('[data-streamdown="code-block"]').length,
              pageOverflow: scroller.scrollWidth - scroller.clientWidth,
              messageOverflow: md.scrollWidth - md.clientWidth,
            }
          })()`,
        ) as Record<string, number>
        expect(shape).toMatchObject({ paragraphBreaks: 2, paragraphs: 1, strong: 1, items: 2, tables: 1, fences: 1 })
        expect(shape.pageOverflow).toBeLessThanOrEqual(0)
        expect(shape.messageOverflow).toBeLessThanOrEqual(0)
        browser.evaluate(`${MESSAGE}.scrollIntoView({ block: 'start' })`)
        browser.screenshot(join(artifactsDir, `assistant-line-breaks-${label}-${theme}.png`), { viewport: true })
      })
    }
  }
})

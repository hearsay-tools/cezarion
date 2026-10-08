import type { ChildProcess } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { waitForSettledSample } from './visual-ready'
import { spawnFixtureServer, stopFixtureServer, waitForFixtureServer } from './fixture-server'
import { AgentBrowser, bootProjectId, fixtureServeEnv } from './agent-browser'
import {
  contrastSampleExpression,
  focusWithKeyboard,
  restoreContrastQaDefaults,
  type ContrastSample,
} from './contrast'
import record from './fixtures/thread-run.record.json'

/**
 * #927 — Agent Response Copy / Copy markdown live in the header row (label + timestamp),
 * stay visible without hover, and keep their clipboard payloads. Unit coverage pins the
 * DOM contract; this exercises the real cockpit at phone and desktop widths.
 */
const repoRoot = resolve(import.meta.dirname, '../../..')
const sessionId = `e2e-assistant-reply-copy-${process.pid}`
const RUN_ID = 'aaaaaaaa-0927-4222-8333-bbbbbbbbbbbb'
const RUN = {
  ...record,
  id: RUN_ID,
  title: 'Assistant reply copy',
  titleSummary: 'Assistant reply copy',
  task: 'Show the plan.',
  status: 'review',
  steps: [record.steps[0]],
  pullRequestUrl: undefined,
}
const REPLY = [
  '## Heading',
  '',
  '- item',
  '',
  'See [docs](https://example.com).',
  '',
  '```ts',
  'const a = 1',
  '```',
].join('\n')
const REPLY_AT = '2026-07-31T14:32:00.000Z'
const events = [
  { type: 'step-start', stepId: 'task', name: 'Do the task', kind: 'agent', iteration: 1 },
  { type: 'session.started', sessionId: 's', backend: 'claude', stepId: 'task' },
  { type: 'turn.started', turnId: 'turn_1', stepId: 'task' },
  {
    type: 'item.started',
    item: { kind: 'message', id: 'm1', role: 'assistant', text: REPLY },
    stepId: 'task',
  },
  {
    type: 'item.completed',
    item: { kind: 'message', id: 'm1', role: 'assistant', text: REPLY },
    stepId: 'task',
  },
].map((event, index) => ({
  ...event,
  seq: index + 1,
  ts: new Date(Date.parse(REPLY_AT) + index * 10).toISOString(),
}))

let browser: AgentBrowser
let server: ChildProcess
let dataRoot: string
let baseUrl: string
let bootProject: string

const MESSAGE = `[data-slot="assistant-message"]`
const COPY = `${MESSAGE} [aria-label="Copy reply"]`
const MARKDOWN = `${MESSAGE} [aria-label="Copy reply as markdown"]`
const HEADER = `${MESSAGE} > p`
const ACTIONS = `${MESSAGE} [data-slot="bubble-actions"]`

beforeAll(async () => {
  dataRoot = mkdtempSync(join(tmpdir(), 'cezar-e2e-reply-copy-'))
  mkdirSync(join(dataRoot, '.ai/cezar/runs'), { recursive: true })
  writeFileSync(join(dataRoot, '.ai/cezar/runs.json'), JSON.stringify([RUN], null, 2), 'utf8')
  writeFileSync(
    join(dataRoot, '.ai/cezar/runs', `${RUN_ID}.ndjson`),
    events.map((event) => JSON.stringify(event)).join('\n') + '\n',
    'utf8',
  )

  server = spawnFixtureServer(
    [join(repoRoot, 'packages/cezar/dist/index.js'), 'serve', '--repo', dataRoot, '--port', '0', '--no-open'],
    { env: fixtureServeEnv(dataRoot), stdio: 'ignore' },
  )
  baseUrl = await waitForFixtureServer(server)
  bootProject = await bootProjectId(baseUrl)
  browser = AgentBrowser.open(sessionId)
  browser.setViewport(1440, 900)
  browser.goto(`${baseUrl}/p/${bootProject}/tasks/${RUN_ID}`)
  browser.waitForFunction(`document.querySelector(${JSON.stringify(COPY)}) !== null`)
}, 120_000)

afterAll(async () => {
  browser?.close()
  await stopFixtureServer(server)
  if (dataRoot) rmSync(dataRoot, { recursive: true, force: true })
})

function revealMessage(): void {
  waitForSettledSample(
    browser,
    `(() => {
      const message = document.querySelector(${JSON.stringify(MESSAGE)});
      if (!message) return null;
      message.scrollIntoView({ block: 'center' });
      return message.checkVisibility({ contentVisibilityAuto: true }) ? true : null;
    })()`,
  )
}

function placementFacts(width: number) {
  browser.setViewport(width, 900)
  return waitForSettledSample<{
    inHeader: boolean
    hasTime: boolean
    actionsOpacity: number
    bodyActions: number
    headerOverflow: boolean
    pageOverflow: boolean
    copyH: number
    copyW: number
    markdownH: number
    markdownW: number
    label: string
  }>(
    browser,
    `(() => {
      const message = document.querySelector(${JSON.stringify(MESSAGE)});
      const header = document.querySelector(${JSON.stringify(HEADER)});
      const actions = document.querySelector(${JSON.stringify(ACTIONS)});
      const copy = document.querySelector(${JSON.stringify(COPY)});
      const markdown = document.querySelector(${JSON.stringify(MARKDOWN)});
      if (!message || !header || !actions || !copy || !markdown) return null;
      message.scrollIntoView({ block: 'center' });
      if (!message.checkVisibility({ contentVisibilityAuto: true })) return null;
      const body = message.querySelector(':scope > div');
      const scroller = document.scrollingElement;
      const copyBox = copy.getBoundingClientRect();
      const mdBox = markdown.getBoundingClientRect();
      return {
        inHeader: header.contains(copy) && header.contains(markdown) && header.contains(actions),
        hasTime: header.querySelector('[data-slot="message-time"]') !== null,
        actionsOpacity: Number(getComputedStyle(actions).opacity),
        bodyActions: body ? body.querySelectorAll('[data-slot="bubble-actions"]').length : -1,
        headerOverflow: header.scrollWidth - header.clientWidth > 1,
        pageOverflow: (scroller?.scrollWidth ?? 0) - (scroller?.clientWidth ?? 0) > 1,
        copyH: copyBox.height,
        copyW: copyBox.width,
        markdownH: mdBox.height,
        markdownW: mdBox.width,
        label: header.textContent ?? '',
      };
    })()`,
  )
}

describe('assistant reply copy in header (#927)', () => {
  it('keeps Copy and Copy markdown visible in the header at desktop and phone widths', () => {
    try {
      for (const width of [1440, 360]) {
        const facts = placementFacts(width)
        expect(facts.inHeader, `width ${width}`).toBe(true)
        expect(facts.hasTime, `width ${width}`).toBe(true)
        expect(facts.label, `width ${width}`).toContain('AGENT RESPONSE')
        expect(facts.actionsOpacity, `width ${width}`).toBe(1)
        expect(facts.bodyActions, `width ${width}`).toBe(0)
        expect(facts.headerOverflow, `width ${width}`).toBe(false)
        expect(facts.pageOverflow, `width ${width}`).toBe(false)
        expect(facts.copyH, `width ${width}`).toBeGreaterThanOrEqual(44)
        expect(facts.copyW, `width ${width}`).toBeGreaterThanOrEqual(44)
        expect(facts.markdownH, `width ${width}`).toBeGreaterThanOrEqual(44)
        expect(facts.markdownW, `width ${width}`).toBeGreaterThanOrEqual(44)
      }
    } finally {
      browser.setViewport(1440, 900)
    }
  })

  it('copies markdown source and rendered HTML from the header controls', () => {
    browser.setViewport(1440, 900)
    revealMessage()
    browser.evaluate(`(() => {
      window.__copiedText = [];
      window.__copiedWrite = [];
      window.__htmlText = null;
      window.__plainText = null;
      const plain = (t) => { window.__copiedText.push(t); return Promise.resolve(); };
      const write = (items) => {
        window.__copiedWrite.push(items);
        const first = items?.[0];
        const bag = first?.items ?? first;
        if (bag?.['text/html']?.text && bag?.['text/plain']?.text) {
          Promise.all([bag['text/html'].text(), bag['text/plain'].text()]).then(([html, plain]) => {
            window.__htmlText = html;
            window.__plainText = plain;
          });
        }
        return Promise.resolve();
      };
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: { writeText: plain, write },
      });
      window.ClipboardItem = class ClipboardItem {
        constructor(items) { this.items = items; }
      };
    })()`)

    // Prefer keyboard activation so a sticky chrome header cannot intercept the click point.
    focusWithKeyboard(browser, MARKDOWN)
    browser.press('Enter')
    browser.waitForFunction(`window.__copiedText.length === 1`)
    expect(browser.evaluate(`window.__copiedText[0]`)).toBe(REPLY)
    expect(
      browser.waitForValue(
        `document.querySelector(${JSON.stringify(MARKDOWN)})?.textContent`,
        (value) => typeof value === 'string' && value.includes('Copied'),
      ),
    ).toContain('Copied')

    focusWithKeyboard(browser, COPY)
    browser.press('Enter')
    browser.waitForFunction(`window.__copiedWrite.length === 1`)
    const settledHtml = browser.waitForValue(
      `window.__htmlText`,
      (value) => typeof value === 'string' && value.includes('Heading'),
    ) as string
    expect(settledHtml).toMatch(/<li\b/i)
    expect(settledHtml).toMatch(/<a\b/i)
    expect(settledHtml).toContain('https://example.com')
    expect(browser.evaluate(`window.__plainText`)).toBe(REPLY)
    expect(
      browser.waitForValue(
        `document.querySelector(${JSON.stringify(COPY)})?.textContent`,
        (value) => typeof value === 'string' && value.includes('Copied'),
      ),
    ).toContain('Copied')
  })

  it('keeps header copy controls keyboard-reachable and AA readable in light and dark', () => {
    try {
      for (const theme of ['light', 'dark'] as const) {
        browser.evaluate(`(() => {
          document.documentElement.classList.remove('light', 'dark');
          document.documentElement.classList.add('${theme}');
        })()`)
        revealMessage()

        const icon = browser.evaluate(
          contrastSampleExpression(`${COPY} svg`, 'color', 'parent'),
        ) as ContrastSample
        const markdownIcon = browser.evaluate(
          contrastSampleExpression(`${MARKDOWN} svg`, 'color', 'parent'),
        ) as ContrastSample
        expect(icon.ratio, `${theme} copy icon`).toBeGreaterThanOrEqual(3)
        expect(markdownIcon.ratio, `${theme} markdown icon`).toBeGreaterThanOrEqual(3)

        focusWithKeyboard(browser, COPY)
        expect(
          browser.waitForValue(
            `document.activeElement?.getAttribute('aria-label')`,
            (value) => value === 'Copy reply',
          ),
        ).toBe('Copy reply')
        const copyFocus = browser.waitForValue<{ ring: boolean; active: boolean }>(
          `(() => {
            const el = document.querySelector(${JSON.stringify(COPY)});
            if (!el || document.activeElement !== el) return null;
            const style = getComputedStyle(el);
            const ring = style.boxShadow !== 'none' || (style.outlineStyle !== 'none' && Number.parseFloat(style.outlineWidth) > 0);
            return { ring, active: true };
          })()`,
          (value) => Boolean(value?.active && value.ring),
        )
        expect(copyFocus.ring, `${theme} copy focus ring`).toBe(true)

        focusWithKeyboard(browser, MARKDOWN)
        expect(
          browser.waitForValue(
            `document.activeElement?.getAttribute('aria-label')`,
            (value) => value === 'Copy reply as markdown',
          ),
        ).toBe('Copy reply as markdown')
        const mdFocus = browser.waitForValue<{ ring: boolean; active: boolean }>(
          `(() => {
            const el = document.querySelector(${JSON.stringify(MARKDOWN)});
            if (!el || document.activeElement !== el) return null;
            const style = getComputedStyle(el);
            const ring = style.boxShadow !== 'none' || (style.outlineStyle !== 'none' && Number.parseFloat(style.outlineWidth) > 0);
            return { ring, active: true };
          })()`,
          (value) => Boolean(value?.active && value.ring),
        )
        expect(mdFocus.ring, `${theme} markdown focus ring`).toBe(true)
      }
    } finally {
      restoreContrastQaDefaults(browser)
      browser.setViewport(1440, 900)
    }
  })
})

import type { ChildProcess } from 'node:child_process'
import { rmSync } from 'node:fs'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { waitForSettledSample } from './visual-ready'
import { spawnFixtureServer, stopFixtureServer, waitForFixtureServer } from './fixture-server'
import { revealControl } from './control-ready'
import { AgentBrowser, bootProjectId, squawkCli, fixtureServeEnv } from './agent-browser'
import {
  applyContrastQaVariant,
  contrastQaVariants,
  contrastSampleExpression,
  focusWithKeyboard,
  normalizeColorSample,
  hoverVisiblePoint,
  restoreContrastQaDefaults,
  type ContrastSample,
} from './contrast'
import { artifactsDir, BARE_COMMAND, HOOK_RUN, RUN, RUN_ID, seedThreadDataRoot, TYPO_RUNS } from './task-thread-fixture'
// fixture-server starts: 1

/**
 * The task thread's transcript and assets (`/tasks/:id`, R3 Steps 1.1 + 1.2) in a real browser,
 * against a real cezar: user and assistant messages, markdown, links, lazy Shiki highlighting,
 * tool and hook cards, the agent screenshot, and the agent type scale (hearsay-tools/cezarion#522).
 *
 * The runs and their transcripts come from `task-thread-fixture.ts`. This spec owns its own
 * server, browser session and cleanup, so it passes alone and in any order.
 */

const sessionId = `e2e-thread-transcript-${process.pid}`

let browser: AgentBrowser
let server: ChildProcess
let dataRoot: string
let baseUrl: string
let bootProject: string

/** A flat route target under this server's own project prefix (multi-project spec, step 3.2):
 *  every cockpit link is scoped, and every legacy flat URL redirects onto its scoped twin. */
const scoped = (path: string) => `/p/${bootProject}${path}`

beforeAll(async () => {
  dataRoot = seedThreadDataRoot('cezar-e2e-thread-transcript-', [RUN, HOOK_RUN, TYPO_RUNS[1]!])
  server = spawnFixtureServer([squawkCli, 'serve', '--repo', dataRoot, '--port', '0', '--no-open'],
    { env: fixtureServeEnv(dataRoot), stdio: 'ignore' },
  )
  baseUrl = await waitForFixtureServer(server)
  bootProject = await bootProjectId(baseUrl)

  browser = AgentBrowser.open(sessionId)
  browser.setViewport(1440, 900)
  browser.goto(`${baseUrl}${scoped(`/tasks/${RUN_ID}`)}`)
  // The thread is async twice over (lazy route chunk, then the SSE replay) — wait for content.
  browser.waitForFunction(`document.querySelectorAll('[data-slot="user-bubble"]').length >= 2`)
}, 120_000)

afterAll(async () => {
  browser?.close()
  await stopFixtureServer(server)
  if (dataRoot) rmSync(dataRoot, { recursive: true, force: true })
})

describe('task thread', () => {
  it('renders the task and follow-up as labeled full-width user messages', () => {
    const bubbles = browser.evaluate(
      `[...document.querySelectorAll('[data-slot="user-bubble"] .thread-markdown')].map((el) => el.textContent)`,
    ) as string[]
    expect(bubbles).toHaveLength(2)
    expect(bubbles[0]).toContain('Summarize what this project does.')
    expect(bubbles[1]).toBe('Thanks — now show the markdown summary. mock:md')

    // The revised document layout fills the reading column; the role label identifies authorship.
    const geometry = waitForSettledSample(browser, `(() => {
      const bubble = document.querySelector('[data-slot="user-bubble"]')
      const message = document.querySelector('[data-slot="assistant-message"]')
      // #795/#758: presence is not rendering for content-visibility thread rows.
      const rendered = [bubble, message].every(el => el.checkVisibility({ contentVisibilityAuto: true }))
      bubble.scrollIntoView({ block: 'center' })
      if (!rendered) return null
      const column = bubble.parentElement
      const b = bubble.getBoundingClientRect(), c = column.getBoundingClientRect(), m = message.getBoundingClientRect()
      return { rightGap: c.right - b.right, bubbleLeft: b.left, mid: c.left + c.width / 2, messageLeft: m.left - c.left }
    })()`) as { rightGap: number; bubbleLeft: number; mid: number; messageLeft: number }
    expect(geometry.rightGap).toBeLessThan(40) // only the column padding separates them
    expect(geometry.bubbleLeft).toBeLessThan(geometry.mid)
    expect(browser.evaluate(`document.querySelector('[data-slot="user-bubble"] > p > span:first-child').textContent`)).toBe('YOUR MESSAGE')
    expect(geometry.messageLeft).toBeLessThan(40)
  })

  it('renders the assistant reply as markdown — heading, table, list, no raw ** anywhere', () => {
    expect(
      browser.evaluate(`document.querySelector('[data-slot="assistant-message"] [data-streamdown="heading-2"]')?.textContent`),
    ).toBe('Markdown fixture')
    expect(browser.count('[data-slot="assistant-message"] [data-streamdown="table"]')).toBe(1)
    expect(browser.count('[data-slot="assistant-message"] [data-streamdown="list-item"]')).toBeGreaterThan(3)
    expect(
      browser.evaluate(`document.querySelector('[data-slot="assistant-message"]').textContent.includes('**')`),
    ).toBe(false)
    // The dedup rule end-to-end: the fixture file carries the v1 `text` twin of this message —
    // exactly one copy renders.
    expect(browser.count('[data-slot="assistant-message"] [data-streamdown="heading-2"]')).toBe(1)
  })

  it('keeps transcript links AA-readable with a permanent affordance and visible focus across the QA matrix', () => {
    const link = '[data-slot="assistant-message"] [data-streamdown="link"]'
    browser.goto(`${baseUrl}${scoped(`/tasks/${RUN_ID}`)}`)
    browser.waitForFunction(`document.querySelector(${JSON.stringify(link)}) !== null`)
    try {
      for (const variant of contrastQaVariants) {
        applyContrastQaVariant(browser, variant)
        browser.evaluate(`(() => {
          const target = document.querySelector(${JSON.stringify(link)})
          target?.scrollIntoView({ block: 'center', inline: 'nearest' })
        })()`)
        const normal = browser.evaluate(contrastSampleExpression(link)) as ContrastSample
        hoverVisiblePoint(browser, link)
        const hovered = browser.evaluate(contrastSampleExpression(link)) as ContrastSample
        expect(normal.ratio, `${variant.id} normal: ${normal.foreground} on ${normal.background}`).toBeGreaterThanOrEqual(4.5)
        expect(hovered.ratio, `${variant.id} hover: ${hovered.foreground} on ${hovered.background}`).toBeGreaterThanOrEqual(4.5)
        focusWithKeyboard(browser, link)
        browser.evaluate(`(() => {
          const target = document.querySelector(${JSON.stringify(link)})
          const scroller = document.querySelector('[data-slot="main"]')
          scroller.scrollTop += target.getBoundingClientRect().top - 180
        })()`)
        const affordance = browser.evaluate(`(() => {
          const link = document.querySelector(${JSON.stringify(link)})
          const style = getComputedStyle(link)
          const probe = document.createElement('span')
          probe.style.color = 'var(--link-foreground)'
          document.body.append(probe)
          const semantic = getComputedStyle(probe).color
          probe.remove()
          return { active: document.activeElement === link, decoration: style.textDecorationLine, outline: style.outlineStyle, width: style.outlineWidth, semantic }
        })()` ) as { active: boolean; decoration: string; outline: string; width: string; semantic: string }
        const focus = browser.evaluate(contrastSampleExpression(link, 'outline-color')) as ContrastSample
        expect(affordance.decoration).toContain('underline')
        expect(affordance.active).toBe(true)
        expect(affordance.outline).not.toBe('none')
        expect(Number.parseFloat(affordance.width)).toBeGreaterThanOrEqual(2)
        expect(focus.foreground).toBe(affordance.semantic)
        expect(focus.ratio, `${variant.id} focus: ${focus.foreground} on ${focus.background}`).toBeGreaterThanOrEqual(3)
        browser.screenshot(`${artifactsDir}/issue-165-thread-${variant.id}.png`, { viewport: true })
      }
    } finally {
      restoreContrastQaDefaults(browser)
      browser.goto(`${baseUrl}${scoped(`/tasks/${RUN_ID}`)}`)
      browser.waitForFunction(`document.querySelectorAll('[data-slot="user-bubble"]').length >= 2`)
    }
  })

  it('highlights the ts fence through the lazy Shiki singleton, themed by the --syn-* tokens', () => {
    // Highlighting is async (shiki core + grammar are lazy chunks) — wait for a colored token.
    browser.waitForFunction(
      `[...document.querySelectorAll('[data-streamdown="code-block-body"] span')].some((s) => s.style.getPropertyValue('--sdm-c') === 'var(--syn-key)')`,
    )
    const block = browser.evaluate(`(() => {
      const block = document.querySelector('[data-streamdown="code-block"]')
      const keyword = [...block.querySelectorAll('span')].find((s) => s.style.getPropertyValue('--sdm-c') === 'var(--syn-key)')
      return {
        language: block.dataset.language,
        chip: block.querySelector('[data-streamdown="code-block-header"]').textContent,
        copy: block.querySelector('[data-streamdown="code-block-copy-button"]') !== null,
        keywordText: keyword.textContent,
        keywordToken: keyword.style.getPropertyValue('--sdm-c'),
        synKey: getComputedStyle(document.documentElement).getPropertyValue('--syn-key').trim(),
      }
    })()`) as { language: string; chip: string; copy: boolean; keywordText: string; keywordToken: string; synKey: string }

    expect(block.language).toBe('ts')
    expect(block.chip).toBe('ts')
    expect(block.copy).toBe(true)
    expect(block.keywordText).toBe('const')
    // Streamdown owns how its custom token variable is painted; our contract is that Shiki
    // maps the keyword to cezar's theme token and that the active palette defines that token.
    expect(block.keywordToken).toBe('var(--syn-key)')
    expect(normalizeColorSample(browser, block.synKey)).toBe('rgb(94, 234, 212)')
  })

  it('keeps Shiki out of the main bundle — its chunks load lazily, after the thread route', () => {
    browser.waitForFunction(
      `[...document.querySelectorAll('[data-streamdown="code-block-body"] span')].some((s) => s.style.getPropertyValue('--sdm-c') === 'var(--syn-key)')`,
    )
    const chunks = browser.evaluate(`performance.getEntriesByType('resource')
      .map((e) => e.name.split('/').pop())
      .filter((n) => /^(core|engine-javascript|typescript)-/.test(n))`) as string[]
    // They loaded (the fence above is highlighted)…
    expect(chunks.length).toBeGreaterThanOrEqual(3)
    // …as their own files, which is what "not in the main bundle" means at runtime.
    expect(chunks.every((n) => !n.startsWith('index-'))).toBe(true)
  })

  it('renders the transcript tool calls as cards — and the TodoWrite cards not at all (#382)', () => {
    const cards = browser.evaluate(`[...document.querySelectorAll('[data-slot="tool-card"]')].map((el) => ({
      status: el.dataset.status,
      kind: el.dataset.kind,
      title: el.querySelector('[data-slot="collapsible-trigger"]').textContent,
    }))`) as Array<{ status: string; kind: string; title: string }>
    // Bash + Screenshot + the check-step card. The transcript ALSO carries two TodoWrite
    // tool items — the plan dock is their surface, so no plan-kind card may render.
    expect(cards).toHaveLength(3)
    expect(cards[0]).toMatchObject({ status: 'completed', kind: 'execute' })
    expect(cards[0]!.title).toContain('Ran')
    expect(cards[0]!.title).toContain('git status --short')
    expect(cards[1]).toMatchObject({ status: 'completed', kind: 'other' })
    expect(cards[1]!.title).toContain('Screenshot')
    expect(cards[2]).toMatchObject({ status: 'completed', kind: 'execute' })
    expect(browser.count('[data-slot="tool-card"][data-kind="plan"]')).toBe(0)
  })

  it('the check step renders as a command card with the pass pill and its output', () => {
    const card = browser.evaluate(`(() => {
      const el = [...document.querySelectorAll('[data-slot="tool-card"]')].at(-1)
      return {
        kind: el.dataset.kind,
        status: el.dataset.status,
        title: el.querySelector('[data-slot="collapsible-trigger"]').textContent,
        exit: el.querySelector('[data-slot="tool-exit"]')?.textContent,
      }
    })()`) as { kind: string; status: string; title: string; exit?: string }
    expect(card.kind).toBe('execute')
    expect(card.status).toBe('completed')
    expect(card.title).toContain('Ran')
    expect(card.title).toContain('npm test')
    expect(card.exit).toBe('0') // exit code 0 → the success-tinted pill

    // Expands to the mono output block, like any execute card.
    browser.evaluate(`[...document.querySelectorAll('[data-slot="tool-card"]')].at(-1)
      .querySelector('[data-slot="collapsible-trigger"]').click()`)
    browser.waitForFunction(
      `[...document.querySelectorAll('[data-slot="tool-card"]')].at(-1).querySelector('[data-slot="tool-output"] pre') !== null`,
    )
    expect(
      browser.evaluate(
        `[...document.querySelectorAll('[data-slot="tool-card"]')].at(-1).querySelector('[data-slot="tool-output"] pre').textContent`,
      ),
    ).toContain('72 passed')
  })

  it('serves and renders the agent screenshot the transcript persisted', () => {
    browser.waitForFunction(`document.querySelector('[data-slot="thread-image"]')?.naturalWidth > 0`)
    expect(
      browser.evaluate(`document.querySelector('[data-slot="thread-image"]').getAttribute('src')`),
    ).toBe(`/api/v1/runs/${RUN_ID}/images/screenshot-1.png`)
  })

  it('renders hook entries as cards that expand readably in every QA variant (#961)', () => {
    const card = (id: string) => `[...document.querySelectorAll('[data-slot="hook-card"]')].find((el) => el.textContent.includes(${JSON.stringify(id)}))`
    browser.goto(`${baseUrl}${scoped(`/tasks/${HOOK_RUN.id}`)}`)
    browser.waitForFunction(`document.querySelectorAll('[data-slot="hook-card"]').length === 2`)
    // Placed where they ran: after the Bash card, before the Screenshot card.
    expect(browser.evaluate(`[...document.querySelectorAll('[data-slot="tool-card"], [data-slot="hook-card"]')]
      .map((el) => el.dataset.slot === 'hook-card' ? 'hook:' + el.dataset.status : el.dataset.kind).slice(0, 4)`))
      .toEqual(['execute', 'hook:completed', 'hook:failed', 'other'])
    expect(browser.evaluate(`${card('Stop')}.className.includes('border-danger/25')`)).toBe(true)
    for (const id of ['PostToolBatch', 'Stop']) {
      browser.evaluate(`${card(id)}.querySelector(':scope > [data-slot="collapsible-trigger"]').click()`)
    }
    browser.waitForFunction(`document.querySelectorAll('[data-slot="hook-entry"]').length === 2`)
    expect(browser.evaluate(`document.querySelector('[data-slot="hook-entry"][data-kind="context"]').textContent`))
      .toBe('SQUEAL · revision 4\n✗ thread-items.test.tsx › ToolCard renders hook rows — new failure')
    try {
      for (const variant of contrastQaVariants) {
        applyContrastQaVariant(browser, variant)
        for (const selector of [
          '[data-slot="hook-entry"][data-kind="context"]',
          '[data-slot="hook-entry"][data-kind="error"]',
          '[data-slot="hook-source"]',
          '[data-slot="hook-raw-toggle"]',
        ]) {
          const sample = waitForSettledSample<ContrastSample>(browser, contrastSampleExpression(selector, 'color', 'parent'))
          expect(sample.ratio, `${variant.id} ${selector}: ${sample.foreground} on ${sample.background}`).toBeGreaterThanOrEqual(4.5)
        }
        expect(waitForSettledSample(browser, `document.documentElement.scrollWidth <= window.innerWidth`), variant.id).toBe(true)
        // The transcript pins to its end; bring the hooks into the QA screenshot.
        browser.screenshotElement('[data-slot="hook-card"][data-status="completed"]', `${artifactsDir}/issue-961-hooks-${variant.id}.png`)
      }
    } finally {
      restoreContrastQaDefaults(browser)
      browser.setViewport(1440, 900)
    }
  })
})

it.each([375, 1280])('uses the readable agent type scale and preserves full tool commands at %ipx (hearsay-tools/cezarion#522)', (width) => {
  browser.setViewport(width, 800)
  browser.goto(`${baseUrl}${scoped(`/tasks/${RUN_ID}`)}`)
  const facts = waitForSettledSample(browser, `(() => {
    const message = document.querySelector('[data-slot="assistant-message"]');
    const body = message?.querySelector(':scope > div');
    const eyebrow = message?.querySelector(':scope > p');
    const command = document.querySelector('[data-slot="tool-card"][data-kind="execute"] > button code');
    if (!body || !eyebrow || !command) return null;
    const rendered = body.checkVisibility({ contentVisibilityAuto: true });
    message.scrollIntoView({ block: 'center' });
    if (!rendered) return null;
    const style = getComputedStyle(body);
    const cardStyle = getComputedStyle(message);
    return { fontSize: style.fontSize, lineHeight: style.lineHeight,
      width: body.getBoundingClientRect().width, maxWidth: style.maxWidth,
      availableWidth: message.clientWidth - parseFloat(cardStyle.paddingLeft) - parseFloat(cardStyle.paddingRight),
      eyebrowLineHeight: getComputedStyle(eyebrow).lineHeight,
      command: command.textContent, title: command.title,
      overflow: getComputedStyle(command).textOverflow, whiteSpace: getComputedStyle(command).whiteSpace };
  })()`) as { fontSize: string; lineHeight: string; width: number; maxWidth: string; availableWidth: number; eyebrowLineHeight: string; command: string; title: string; overflow: string; whiteSpace: string }
  expect(facts.fontSize).toBe(width < 768 ? '15px' : '14px')
  expect(facts.lineHeight).toBe(width < 768 ? '24px' : '22.4px')
  expect(facts.maxWidth).toBe('none')
  expect(Math.abs(facts.width - facts.availableWidth)).toBeLessThanOrEqual(1)
  expect(facts.eyebrowLineHeight).toBe('13.2px')
  expect(facts.title).toBe(facts.command)
  expect(facts.overflow).toBe('ellipsis')
  expect(facts.whiteSpace).toBe('nowrap')
})

it('ellipsizes a bare OpenCode command and reveals it on expansion (hearsay-tools/cezarion#522)', () => {
  browser.setViewport(906, 800)
  browser.goto(`${baseUrl}${scoped('/tasks/typography-short-model')}`)
  browser.waitForFunction(`document.querySelector('[data-slot="tool-card"][data-kind="execute"]') !== null`)
  const facts = waitForSettledSample(browser, `(() => {
    const card = document.querySelector('[data-slot="tool-card"][data-kind="execute"]');
    const rendered = card.checkVisibility({ contentVisibilityAuto: true });
    card.scrollIntoView({ block: 'center' });
    if (!rendered) return null;
    const button = card.querySelector('button');
    const code = button.querySelector('code');
    return { code: code?.textContent, title: code?.title, overflow: code && getComputedStyle(code).textOverflow,
      width: code?.getBoundingClientRect().width, rowWidth: button.getBoundingClientRect().width };
  })()`) as { code?: string; title?: string; overflow?: string; width?: number; rowWidth: number }
  expect(facts.code).toBe(BARE_COMMAND)
  expect(facts.title).toBe(BARE_COMMAND)
  expect(facts.overflow).toBe('ellipsis')
  expect(facts.width).toBeLessThan(facts.rowWidth)
  revealControl(browser, '[data-slot="tool-card"][data-kind="execute"] > button')
  browser.screenshot(`${artifactsDir}/522-opencode-command-collapsed.png`, { viewport: true })
  browser.click('[data-slot="tool-card"][data-kind="execute"] > button')
  browser.waitForFunction(`document.querySelector('[data-slot="tool-card"][data-kind="execute"] [data-slot="tool-command"]') !== null`)
  expect(browser.text('[data-slot="tool-card"][data-kind="execute"] [data-slot="tool-command"]')).toBe(BARE_COMMAND)
  browser.screenshot(`${artifactsDir}/522-opencode-command-expanded.png`, { viewport: true })
})

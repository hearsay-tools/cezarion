import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { once } from 'node:events'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { AgentBrowser, cezarCli, fixtureServeEnv } from './agent-browser'
import { waitForHealth } from './poll'

/**
 * #484 end-to-end: skill search must rank the (almost-)exact match to the TOP wherever it is
 * used — the cmdk source picker on /new AND the composer `/` autocomplete — against a LIVE
 * dry-run server. This is the regression guard for the reported bug ("even we've got almost
 * perfect match it's not sorted by it"): before the fix the picker showed matches in the
 * server's own order (so a skill literally named `review` sat below `auto-review-pr`), because
 * cmdk's built-in score-sort does not re-order the list in this app. The specs seed skills
 * whose server order is the OPPOSITE of the desired match order, so an unranked list fails.
 */

const artifactsDir = resolve(import.meta.dirname, '../../../.ai/qa/artifacts_e2e')
const sessionId = `e2e-skill-search-${process.pid}`

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

beforeAll(async () => {
  dataRoot = mkdtempSync(join(tmpdir(), 'cezar-e2e-skill-search-'))
  const git = (...args: string[]) => execFileSync('git', ['-C', dataRoot, ...args])
  git('init', '-q', '-b', 'main')
  git('config', 'user.email', 'e2e@cezar.test')
  git('config', 'user.name', 'cezar e2e')
  writeFileSync(join(dataRoot, 'README.md'), '# skill-search e2e fixture repo\n', 'utf8')
  git('add', '.')
  git('commit', '-qm', 'init')

  // Skills chosen so the SERVER order (`auto-review-pr`, `review`, `ship` — the directory
  // listing) is the inverse of the desired MATCH order for the query "review": the exact-name
  // `review` must jump to the top past `auto-review-pr`. An unranked list would leave it last.
  mkdirSync(join(dataRoot, '.ai/skills'), { recursive: true })
  writeFileSync(
    join(dataRoot, '.ai/skills/auto-review-pr.md'),
    // These tokens match only auto-review-pr among our fixture skills. Global skills
    // may also fuzzy-match them, so assertions below scope membership to the fixture.
    '---\ndescription: Open and merge a pull request zebratoken quokkatoken\n---\n\nReview and merge.\n',
    'utf8',
  )
  writeFileSync(
    join(dataRoot, '.ai/skills/review.md'),
    '---\ndescription: The exact match target\n---\n\nJust review.\n',
    'utf8',
  )
  writeFileSync(
    join(dataRoot, '.ai/skills/ship.md'),
    '---\ndescription: Deploy the build\n---\n\nShip it.\n',
    'utf8',
  )

  for (let i = 0; i < 24; i += 1) {
    const name = `qz163browse-${String(i).padStart(2, '0')}`
    writeFileSync(join(dataRoot, `.ai/skills/${name}.md`), `---\ndescription: Browse fixture ${i}\n---\n\nTest skill.\n`)
  }

  const port = await freePort()
  baseUrl = `http://localhost:${port}`
  server = spawn(
    process.execPath,
    [cezarCli, 'serve', '--repo', dataRoot, '--port', String(port), '--no-open'],
    { env: fixtureServeEnv(dataRoot), stdio: 'ignore' },
  )
  await waitForHealth(baseUrl)

  browser = AgentBrowser.open(sessionId)
  browser.setViewport(1440, 900)
}, 180_000)

afterAll(async () => {
  browser?.close()
  if (server && server.exitCode === null) {
    server.kill()
    await once(server, 'exit')
  }
  if (dataRoot) rmSync(dataRoot, { recursive: true, force: true })
})

/** The picker's skill options in current DOM order (top-ranked first). */
function pickerSkillRefs(): string[] {
  return browser.evaluate(
    `[...document.querySelectorAll('[data-slot="source-option"][data-source-kind="skill"]')].map(o => o.dataset.sourceRef)`,
  ) as string[]
}

/** Open the source picker and type a query, waiting until the results settle to `expectFirst`. */
function searchPicker(query: string, expectFirst: string): void {
  if (browser.count('[data-slot="source-menu"]') === 0) {
    browser.click('[data-slot="source-pill"]')
    browser.waitForFunction(`document.querySelector('[data-slot="source-menu"]') !== null`)
  }
  browser.fill('input[placeholder="search skills & workflows…"]', query)
  browser.waitForFunction(
    `[...document.querySelectorAll('[data-slot="source-option"][data-source-kind="skill"]')][0]?.dataset.sourceRef === ${JSON.stringify(expectFirst)}`,
  )
}

describe('#484 skill search ranks the (almost-)exact match first', () => {
  it('the /new source picker floats the exact-name match to the top, past a mid-name match', () => {
    browser.goto(`${baseUrl}/new`)
    browser.waitForFunction(`document.querySelector('[data-route="new"]') !== null`)
    // Sources loaded once the pill shows a real skill (no ellipsis placeholder).
    browser.waitForFunction(
      `!document.querySelector('[data-slot="source-pill"]')?.textContent.includes('…')`,
    )
    // Type the exact name of the skill that sorts LAST in the server's directory order.
    searchPicker('review', 'review')

    const refs = pickerSkillRefs()
    // The exact match is #1, the mid-name match follows, and the non-match is gone.
    expect(refs[0]).toBe('review')
    expect(refs).toContain('auto-review-pr')
    expect(refs).not.toContain('ship')
    expect(refs.indexOf('review')).toBeLessThan(refs.indexOf('auto-review-pr'))
    browser.screenshot(`${artifactsDir}/skill-search-picker-review.png`, { viewport: true })
  })

  it('multi-keyword search still matches across name + description (#411 preserved)', () => {
    // Both rare tokens live only in auto-review-pr's description — the ranker must keep the
    // multi-word "every word must match somewhere" rule (a query missing either word drops it).
    searchPicker('zebratoken quokkatoken', 'auto-review-pr')
    const fixtureRefs = pickerSkillRefs().filter(ref => ['auto-review-pr', 'review', 'ship'].includes(ref))
    expect(fixtureRefs).toEqual(['auto-review-pr'])

    // Close the picker so it does not overlay the composer in the next spec.
    browser.press('Escape')
    browser.waitForFunction(`document.querySelector('[data-slot="source-menu"]') === null`)
  })

  it('the composer `/` autocomplete ranks the exact match first too', () => {
    browser.click('[data-slot="composer"] textarea')
    browser.fill('[data-slot="composer"] textarea', '/review')
    browser.waitForFunction(
      `document.querySelector('[data-slot="composer-menu"] [data-slot="composer-menu-item"]') !== null`,
    )
    const firstLabel = browser.evaluate(
      `document.querySelector('[data-slot="composer-menu-item"] span')?.textContent`,
    ) as string
    // The literal `review` skill leads; `auto-review-pr` would start with "auto".
    expect(firstLabel).toBe('review')
    browser.screenshot(`${artifactsDir}/skill-search-composer-review.png`)
  })
})

// Chrome verifies focus, layout and query retention; actual iPhone keyboard behavior
// still requires device QA. Resizing this viewport is not a software-keyboard test.
describe('#163 mobile skill picker', () => {
  it('browses without autofocus, keeps search through resizing, and selects the last result', () => {
    browser.setViewport(360, 640)
    browser.goto(`${baseUrl}/new`)
    browser.waitForFunction(`document.querySelector('[data-slot="source-pill"]')?.disabled === false`)
    browser.evaluate(`(() => {
      const trigger = document.querySelector('[data-slot="source-pill"]');
      trigger.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerType: 'touch' }));
      trigger.click();
    })()`)
    browser.waitForFunction(`document.querySelector('[data-slot="source-menu"]') !== null`)
    expect(browser.evaluate(`document.activeElement?.dataset.slot`)).toBe('popover-content')
    const input = 'input[placeholder="search skills & workflows…"]'
    browser.click(input)
    expect(browser.evaluate(`document.activeElement?.dataset.slot`)).toBe('command-input')
    browser.fill(input, 'qz163browse')
    browser.waitForFunction(`document.querySelectorAll('[data-slot="source-option"]').length === 24`)

    browser.setViewport(360, 340)
    browser.setViewport(360, 640)
    expect(browser.evaluate(`document.querySelector('${input}').value`)).toBe('qz163browse')
    browser.evaluate(`(() => {
      const input = document.querySelector('[data-slot="command-input"]');
      input.blur();
      const list = document.querySelector('[data-slot="source-menu"]');
      list.lastElementChild.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, pointerType: 'touch' }));
      list.scrollTo(0, list.scrollHeight);
    })()`)
    browser.waitForFunction(`(() => {
      const list = document.querySelector('[data-slot="source-menu"]');
      return list.scrollTop > 0 && list.scrollTop + list.clientHeight >= list.scrollHeight - 1;
    })()`)
    expect(browser.evaluate(`document.activeElement?.dataset.slot === 'command-input'`)).toBe(false)
    expect(browser.count('[data-slot="source-menu"]')).toBe(1)
    const geometry = browser.evaluate(`(() => {
      const popover = document.querySelector('[data-slot="popover-content"]').getBoundingClientRect();
      const input = document.querySelector('[data-slot="command-input"]');
      return { left: popover.left, right: popover.right, top: popover.top, bottom: popover.bottom,
        fontSize: parseFloat(getComputedStyle(input).fontSize),
        overflow: document.documentElement.scrollWidth > innerWidth };
    })()`) as { left: number; right: number; top: number; bottom: number; fontSize: number; overflow: boolean }
    expect(geometry.left).toBeGreaterThanOrEqual(0)
    expect(geometry.right).toBeLessThanOrEqual(360)
    expect(geometry.top).toBeGreaterThanOrEqual(0)
    expect(geometry.bottom).toBeLessThanOrEqual(640)
    expect(geometry.fontSize).toBeGreaterThanOrEqual(16)
    expect(geometry.overflow).toBe(false)
    browser.evaluate(`document.documentElement.classList.add('light')`)
    browser.screenshot(`${artifactsDir}/skill-picker-mobile-light.png`, { viewport: true })
    browser.evaluate(`document.documentElement.classList.remove('light')`)
    browser.screenshot(`${artifactsDir}/skill-picker-mobile-dark.png`, { viewport: true })
    browser.click('[data-slot="source-option"][data-source-ref="qz163browse-23"]')
    browser.waitForFunction(`document.querySelector('[data-slot="source-menu"]') === null`)
    expect(browser.evaluate(`document.querySelector('[data-slot="source-pill"]').textContent`)).toContain('qz163browse-23')
  })
})

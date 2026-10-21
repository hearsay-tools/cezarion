import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { AgentBrowser, bootProjectId, readTestEnv, servedRoot } from './agent-browser'
import { pollFor, pollJson } from './poll'
import {
  applyContrastQaVariant,
  contrastQaVariants,
  contrastSampleExpression,
  focusWithKeyboard,
  restoreContrastQaDefaults,
  type ContrastSample,
} from './contrast'

/**
 * Settings → Skills (R6 Step 1.4) end-to-end against the shared dry-run environment.
 *
 * Reachability: fully reachable. The server discovers skills fresh on every GET, so the
 * suite seeds two real project skills into this worktree's `.ai/skills/` (removed in
 * afterAll) — the catalog renders them bold and first (#377) next to whatever global skills
 * the host machine genuinely has. Refresh hits the real POST (no team repos configured in
 * dry-run → a fast no-op fetch answering the same catalog), which is exactly the #384
 * scenario: a refetch must not lose selection. Nothing else mutates state.
 */

const artifactsDir = resolve(import.meta.dirname, '../../../.ai/qa/artifacts_e2e')
const sessionId = `e2e-settings-skills-${process.pid}`

const DESKTOP = { width: 1440, height: 900 }

const skillsDir = resolve(servedRoot(), '.ai/skills')
const ALPHA = 'e2e-alpha-skill'
const BETA = 'e2e-beta-skill'

let browser: AgentBrowser
let baseUrl: string
let createdSkillsDir = false
let bootProject: string

/** A flat route target under this server's own project prefix (multi-project spec, step 3.2):
 *  every cockpit link is scoped, and every legacy flat URL redirects onto its scoped twin. */
const scoped = (path: string) => `/p/${bootProject}${path}`

beforeAll(async () => {
  baseUrl = readTestEnv().baseUrl
  bootProject = await bootProjectId(baseUrl)
  createdSkillsDir = !existsSync(skillsDir)
  mkdirSync(skillsDir, { recursive: true })
  writeFileSync(
    resolve(skillsDir, `${ALPHA}.md`),
    `---\nname: ${ALPHA}\ndescription: An e2e-seeded project skill\n---\n\n# Alpha skill\n\nDo the alpha thing.\n`,
    'utf8',
  )
  writeFileSync(
    resolve(skillsDir, `${BETA}.md`),
    `---\nname: ${BETA}\ndescription: The second seeded skill\n---\n\nDo the beta thing.\n`,
    'utf8',
  )
  browser = AgentBrowser.open(sessionId)
  browser.setViewport(DESKTOP.width, DESKTOP.height)
})

afterAll(() => {
  // Never leave test skills in a developer's catalog.
  rmSync(resolve(skillsDir, `${ALPHA}.md`), { force: true })
  rmSync(resolve(skillsDir, `${BETA}.md`), { force: true })
  if (createdSkillsDir) rmSync(skillsDir, { recursive: true, force: true })
  browser?.close()
})

const row = (name: string) => `[data-slot="skill-row"][data-skill="${name}"]`

describe('settings → skills against the live dry-run server', () => {
  it('the catalog renders the seeded project skills bold-first, and a click opens the markdown detail', () => {
    browser.goto(`${baseUrl}${scoped('/settings/skills')}`)
    browser.waitForFunction(`document.querySelector('${row(ALPHA)}') !== null`)

    // Seeded repo skills are project skills — tagged, emphasized, and ahead of every
    // global/team skill in the list (#377).
    expect(browser.count(`${row(ALPHA)}[data-project="true"]`)).toBe(1)
    expect(browser.count(`${row(BETA)}[data-project="true"]`)).toBe(1)
    const ordered = browser.evaluate(
      `(() => {
        const rows = [...document.querySelectorAll('[data-slot="skill-row"]')]
        const firstGlobal = rows.findIndex((r) => !r.hasAttribute('data-project'))
        const lastProject = rows.map((r) => r.hasAttribute('data-project')).lastIndexOf(true)
        return firstGlobal === -1 || lastProject < firstGlobal
      })()`,
    )
    expect(ordered).toBe(true)

    browser.click(row(ALPHA))
    browser.waitForFunction(
      `document.querySelector('[data-slot="skills-detail"] [data-slot="skill-detail"] h2')?.textContent === '${ALPHA}'`,
    )
    // The body rendered as MARKDOWN: the seeded `# Alpha skill` became a real heading.
    browser.waitForFunction(
      `[...document.querySelectorAll('[data-slot="skill-body"] h1')].some((h) => h.textContent === 'Alpha skill')`,
    )
    expect(browser.text('[data-slot="skill-body"]')).toContain('Do the alpha thing.')
    browser.screenshot(`${artifactsDir}/settings-skills.png`)
  })

  it('keeps selected and hovered skill descriptions AA-readable with visible keyboard focus', () => {
    browser.goto(`${baseUrl}${scoped('/skills')}`)
    browser.waitForFunction(`document.querySelector('${row(ALPHA)} > span:last-child') !== null`)
    try {
      for (const variant of contrastQaVariants) {
        applyContrastQaVariant(browser, variant)
        const selectedSelector = `${row(ALPHA)} > span:last-child`
        const selected = browser.evaluate(contrastSampleExpression(selectedSelector)) as ContrastSample
        expect(selected.ratio, `${variant.id} selected: ${selected.foreground} on ${selected.background}`).toBeGreaterThanOrEqual(4.5)

        // Scroll BETA into view: the update card now heads the list (#1408), so at 360×640 the row
        // starts under the mobile tab bar. Evidence: this case failed with "covered by
        // <a.relative.flex inside div#root>" (bundle .ai/qa/failures/settings-skills/
        // keeps-selected-and-hovered-skill-descriptions-AA-readable-with-visible-keyboard--1/:
        // probe.json hover refused at the click point; PR #1424 comment 6316871712). Reproduce with
        // `npm run test:e2e -- skills-update.e2e.ts settings-skills.e2e.ts` — 1 of 2 failed
        // before, 2 of 2 passed after.
        browser.evaluate(`document.querySelector(${JSON.stringify(row(BETA))}).scrollIntoView({ block: 'center' })`)
        browser.hover(row(BETA))
        const hoveredSelector = `${row(BETA)} > span:last-child`
        const hovered = browser.evaluate(contrastSampleExpression(hoveredSelector)) as ContrastSample
        expect(hovered.ratio, `${variant.id} hover: ${hovered.foreground} on ${hovered.background}`).toBeGreaterThanOrEqual(4.5)

        focusWithKeyboard(browser, row(ALPHA))
        const focusStyle = browser.evaluate(`(() => {
          const row = document.querySelector(${JSON.stringify(row(ALPHA))})
          const probe = document.createElement('span')
          probe.style.color = 'var(--link-foreground)'
          document.body.append(probe)
          const color = getComputedStyle(probe).color
          probe.remove()
          const style = getComputedStyle(row)
          return { active: document.activeElement === row, color, outline: style.outlineStyle, width: style.outlineWidth }
        })()` ) as { active: boolean; color: string; outline: string; width: string }
        const focus = browser.evaluate(contrastSampleExpression(row(ALPHA), 'outline-color')) as ContrastSample
        expect(focusStyle.active).toBe(true)
        expect(focusStyle.outline).not.toBe('none')
        expect(Number.parseFloat(focusStyle.width)).toBeGreaterThanOrEqual(2)
        expect(focus.foreground).toBe(focusStyle.color)
        expect(focus.ratio, `${variant.id} focus: ${focus.foreground} on ${focus.background}`).toBeGreaterThanOrEqual(3)
        browser.screenshot(`${artifactsDir}/issue-165-skills-${variant.id}.png`, { viewport: true })
      }
    } finally {
      restoreContrastQaDefaults(browser)
    }
  })

  it('every row has its own switch with a 44 px target at 360×640, light and dark (#1408)', () => {
    // Dry-run has no default team skills, so the seeded project skills show their locked
    // "always enabled" switch; a live switch shares the same component and hit area.
    const toggle = `[data-slot="skills-list"] [data-slot="skill-switch"][data-skill="${ALPHA}"]`
    browser.goto(`${baseUrl}${scoped('/skills')}`)
    browser.waitForFunction(`document.querySelector(${JSON.stringify(toggle)}) !== null`)
    try {
      for (const variant of contrastQaVariants.filter((v) => v.id.startsWith('mobile-') && v.density === 'comfortable')) {
        applyContrastQaVariant(browser, variant)
        // Scroll the switch into view: the update card heads the list, so at 360×640 the row starts
        // below the fold. Evidence: this case failed with "hit area: expected [ false, false,
        // false, false ]" (bundle .ai/qa/failures/settings-skills/
        // every-row-has-its-own-switch-with-a-44-px-target-at-360-640-light-and-dark-1408-1/:
        // probe.json all four elementFromPoint probes missed; PR #1424 comment 6316871712).
        // Reproduce with `npm run test:e2e -- skills-update.e2e.ts settings-skills.e2e.ts` —
        // 2 of 2 failed before, 2 of 2 passed after.
        const target = browser.waitForValue(`(() => {
          const el = document.querySelector(${JSON.stringify(toggle)})
          if (!el) return null
          el.scrollIntoView({ block: 'center' })
          const box = el.getBoundingClientRect()
          const x = box.left + box.width / 2
          const y = box.top + box.height / 2
          // The hit area, not the drawn track: a tap 22 px off-centre must still land on the switch.
          const hits = [[x - 21, y], [x + 21, y], [x, y - 21], [x, y + 21]]
            .map(([px, py]) => el.contains(document.elementFromPoint(px, py)))
          return {
            role: el.getAttribute('role'),
            label: el.getAttribute('aria-label'),
            insideRow: el.closest('[data-slot="skill-row"]') !== null,
            hits,
          }
        })()`, (value) => value !== null && typeof value === 'object') as {
          role: string; label: string; insideRow: boolean; hits: boolean[]
        }
        expect(target.role).toBe('switch')
        expect(target.label).toBe(`${ALPHA} is always enabled`)
        expect(target.insideRow).toBe(false)
        expect(target.hits, `${variant.id} hit area`).toEqual([true, true, true, true])
        browser.screenshot(`${artifactsDir}/issue-1408-skills-${variant.id}.png`, { viewport: true })
      }
    } finally {
      restoreContrastQaDefaults(browser)
    }
  })

  it('a default skill switches off and back on by keyboard, and the project saves each change (#1408)', async () => {
    // Dry-run serves the default team skills, so their live switches are reachable here.
    const uiStateFile = resolve(servedRoot(), '.ai/cezar/ui-state.json')
    const savedUiState = existsSync(uiStateFile) ? readFileSync(uiStateFile, 'utf8') : null
    const live = '[data-slot="skills-list"] [data-slot="skill-switch"]:not([data-locked]):not([disabled])'
    browser.goto(`${baseUrl}${scoped('/skills')}`)
    const name = String(browser.waitForValue(
      `document.querySelector(${JSON.stringify(live)})?.getAttribute('data-skill') ?? null`,
      (value) => typeof value === 'string' && value.length > 0,
    ))
    const toggle = `[data-slot="skills-list"] [data-slot="skill-switch"][data-skill="${name}"]`
    const saved = (included: boolean) => pollFor(async (signal) => {
      const state = await pollJson<{ importedSkills?: string[] }>(`${baseUrl}/api/v1/p/${bootProject}/ui-state`, signal)
      return Array.isArray(state.importedSkills) && state.importedSkills.includes(name) === included ? state : undefined
    }, () => `ui-state never saved ${name} as ${included ? 'enabled' : 'disabled'}`, { timeoutMs: 10_000, intervalMs: 100 })
    try {
      focusWithKeyboard(browser, toggle)
      browser.press('Space')
      expect(browser.waitForValue(
        `document.querySelector('[data-slot="skills-group-available"] [data-slot="skill-row"][data-skill="${name}"]') !== null`,
        (value) => value === true,
      )).toBe(true)
      await saved(false)
      // The row moved groups; its switch is a new element, so focus it again before the second press.
      focusWithKeyboard(browser, toggle)
      browser.press('Space')
      expect(browser.waitForValue(
        `document.querySelector(${JSON.stringify(toggle)})?.getAttribute('aria-checked') ?? null`,
        (value) => value === 'true',
      )).toBe('true')
      await saved(true)
    } finally {
      if (savedUiState === null) rmSync(uiStateFile, { force: true })
      else writeFileSync(uiStateFile, savedUiState, 'utf8')
    }
  })

  it('refresh keeps the selection and the list scroll position (#384)', () => {
    browser.click(row(BETA))
    browser.waitForFunction(
      `document.querySelector('[data-slot="skills-detail"] [data-slot="skill-detail"] h2')?.textContent === '${BETA}'`,
    )

    // The host's real global catalog makes the list overflow — pin a scroll offset on it.
    // The read-back must be 150: if the container did not truly overflow the browser would
    // clamp to 0 and the whole scroll assertion would be vacuous.
    browser.evaluate(`document.querySelector('[data-slot="skill-rows"]').scrollTop = 150`)
    const before = Number(browser.evaluate(`document.querySelector('[data-slot="skill-rows"]').scrollTop`))
    expect(before).toBe(150)

    // Scroll Refresh into view: clicking BETA scrolls the main pane on a long team catalog, so the
    // page header covers the button. Evidence: this case failed with "covered by
    // <header.row-start-1.hidden>" (bundle .ai/qa/failures/settings-skills/
    // refresh-keeps-the-selection-and-the-list-scroll-position-384-1/: probe.json main pane
    // scrolled to the BETA row; CI run 39596536546, artifact cockpit-failures-shard-4). Reproduce
    // with `npm run test:e2e -- settings-skills.e2e.ts` — 1 of 1 CI run failed before (0 of 3
    // local: the local catalog is short), 1 of 1 CI run and 4 of 4 local passed after.
    browser.evaluate(`document.querySelector('[data-slot="skills-refresh"]').scrollIntoView({ block: 'center' })`)
    browser.click('[data-slot="skills-refresh"]')
    // The button disables while the POST runs; wait until the round-trip settled.
    browser.waitForFunction(`!document.querySelector('[data-slot="skills-refresh"]').disabled`)
    browser.waitForFunction(`document.querySelector('[data-slot="toaster"]')?.textContent.includes('refreshed')`)

    // Selection and scroll both survived the refetch.
    expect(browser.count(`${row(BETA)}[aria-current="page"]`)).toBe(1)
    expect(
      browser.evaluate(
        `document.querySelector('[data-slot="skills-detail"] [data-slot="skill-detail"] h2').textContent`,
      ),
    ).toBe(BETA)
    expect(Number(browser.evaluate(`document.querySelector('[data-slot="skill-rows"]').scrollTop`))).toBe(
      before,
    )
  })

  it('the pinned bookmarklet panel generates javascript: launchers against /new', () => {
    // The pinned row sits at the bottom of the (viewport-tall) list column, which a long
    // skill detail can push past the fold — scroll it in before the click, as a user would.
    browser.evaluate(
      `document.querySelector('[data-slot="bookmarklets-row"]').scrollIntoView({ block: 'center' })`,
    )
    browser.click('[data-slot="bookmarklets-row"]')
    browser.waitForFunction(`document.querySelector('[data-slot="bookmarklet-panel"]') !== null`)
    // The imperative href lands after mount — wait for the real javascript: URL.
    browser.waitForFunction(
      `(document.querySelector('[data-slot="bm-generic"] [data-slot="bm-link"]')?.getAttribute('href') ?? '').startsWith('javascript:')`,
    )

    const generic = String(
      browser.evaluate(`document.querySelector('[data-slot="bm-generic"] [data-slot="bm-link"]').getAttribute('href')`),
    )
    // The protected /new deep-link grammar, baked with the server's real launch key — now
    // under this project's own URL prefix (multi-project spec, step 3.6).
    expect(decodeURIComponent(generic)).toContain(`${scoped('/new')}?'+q`)
    expect(decodeURIComponent(generic)).toMatch(/auto=0&key=[^&]+&ref=/)

    // One launcher per catalog skill, the seeded ones included.
    browser.waitForFunction(
      `[...document.querySelectorAll('[data-slot="bm-list"] [data-slot="bm-link"]')].some((a) => a.textContent.includes('/${ALPHA}'))`,
    )
    browser.screenshot(`${artifactsDir}/settings-skills-bookmarklets.png`)
  })
})

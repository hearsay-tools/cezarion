import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { parse } from 'yaml'

import { AgentBrowser, readTestEnv } from './agent-browser'
import { contrastSampleExpression, focusWithKeyboard, type ContrastSample } from './contrast'

/**
 * The workflow builder (R6 Step 1.6) end-to-end against the shared dry-run environment.
 *
 * Reachability: fully reachable. The server discovers skills fresh on every GET, so the suite
 * seeds two real project skills into this worktree's `.ai/skills/` (removed in afterAll) and
 * builds a small workflow from them: palette → canvas adds, the YAML preview, Save (a real
 * file lands in `.ai/cezar/workflows/`, read back and parsed here), keyboard reorder through
 * dnd-kit's defaults, Import through the server's `/api/v1/workflows/parse`, and the 8-step
 * limit. The saved file is removed in afterAll so a developer's repo stays clean.
 */

const artifactsDir = resolve(import.meta.dirname, '../../../.ai/qa/artifacts_e2e')
const sessionId = `e2e-workflows-${process.pid}`

const DESKTOP = { width: 1440, height: 900 }

const repoRoot = resolve(import.meta.dirname, '../../..')
const skillsDir = resolve(repoRoot, '.ai/skills')
const ALPHA = 'e2e-wb-alpha'
const BETA = 'e2e-wb-beta'
const FLOW = 'e2e-wb-flow'
const savedFlowPath = resolve(repoRoot, `.ai/cezar/workflows/${FLOW}.yaml`)
const presentationArtifacts = resolve(artifactsDir, 'workflow-editor-presentation')

let browser: AgentBrowser
let baseUrl: string
let createdSkillsDir = false

beforeAll(() => {
  baseUrl = readTestEnv().baseUrl
  // A crashed earlier run may have left the saved flow behind — Save would then 409.
  rmSync(savedFlowPath, { force: true })
  createdSkillsDir = !existsSync(skillsDir)
  mkdirSync(skillsDir, { recursive: true })
  mkdirSync(presentationArtifacts, { recursive: true })
  writeFileSync(
    resolve(skillsDir, `${ALPHA}.md`),
    `---\nname: ${ALPHA}\ndescription: Fix the issue, verify the regression, and leave a concise review note for the next person.\n---\n\nDo the alpha thing.\n`,
    'utf8',
  )
  writeFileSync(
    resolve(skillsDir, `${BETA}.md`),
    `---\nname: ${BETA}\ndescription: Second e2e-seeded skill\n---\n\nDo the beta thing.\n`,
    'utf8',
  )
  browser = AgentBrowser.open(sessionId)
  browser.setViewport(DESKTOP.width, DESKTOP.height)
})

afterAll(() => {
  // Never leave test skills or test workflow files in a developer's repo.
  rmSync(resolve(skillsDir, `${ALPHA}.md`), { force: true })
  rmSync(resolve(skillsDir, `${BETA}.md`), { force: true })
  if (createdSkillsDir) rmSync(skillsDir, { recursive: true, force: true })
  rmSync(savedFlowPath, { force: true })
  browser?.close()
})

const palettePill = (name: string) => `[data-slot="wb-skill"][data-skill="${name}"]`
const addButton = (name: string) => `${palettePill(name)} [data-slot="wb-skill-add"]`
const stepIdsJs = `[...document.querySelectorAll('[data-slot="wb-step"]')].map((s) => s.dataset.id).join(',')`

describe('workflow builder against the live dry-run server', () => {
  it('builds a small workflow from the palette and previews the portable YAML', () => {
    browser.goto(`${baseUrl}/workflows`)
    browser.waitForFunction(`document.querySelector('${palettePill(ALPHA)}') !== null`)

    // Start from a clean canvas: whatever the repo's first saved workflow is, "+ new" resets.
    browser.click('[data-slot="wb-new"]')
    browser.waitForFunction(`document.querySelectorAll('[data-slot="wb-step"]').length === 0`)

    browser.click(addButton(ALPHA))
    browser.click(addButton(BETA))
    browser.waitForFunction(`${stepIdsJs} === '${ALPHA},${BETA}'`)
    expect(browser.text('[data-slot="wb-count"]')).toBe('2 skills')

    browser.click('[data-slot="wb-yaml-toggle"]') // The portable source is disclosed on demand.

    // The preview speaks the portable compact form for a pure skill stack (spec 012).
    const yaml = browser.text('[data-slot="wb-yaml"]')
    expect(yaml).toContain('skills:')
    expect(yaml).toContain(`- ${ALPHA}`)
    expect(yaml).toContain(`- ${BETA}`)
    expect(yaml).not.toContain('steps:')
    browser.screenshot(`${artifactsDir}/workflows-builder.png`)
  })

  it('reorders steps with the keyboard (dnd-kit defaults: Space lifts, arrows move, Space drops)', () => {
    // Each phase gets an explicit sync point — pressing before the previous phase settled is a
    // race the sensor loses silently (the lift needs focus; the move needs the lift's measuring
    // pass). dnd-kit marks the activator with aria-pressed="true" for the duration of the drag.
    const grip = `document.querySelector('[data-slot="wb-step"][data-id="${ALPHA}"] [data-slot="wb-step-grip"]')`
    browser.evaluate(`${grip}.focus()`)
    browser.waitForFunction(`document.activeElement === ${grip}`)
    browser.press('Space')
    browser.waitForFunction(`${grip}.getAttribute('aria-pressed') === 'true'`)
    // An arrow pressed before the lift's measuring pass settles is swallowed, and dropping
    // before the move settles resolves the collision against stale coordinates — both land the
    // item back where it started. Drive it like a user: press, watch dnd-kit's live region for
    // the settled move-over announcement, retry a swallowed press. Two items — no overshoot.
    const overBeta = () =>
      String(
        browser.evaluate(`[...document.querySelectorAll('[aria-live]')].map((n) => n.textContent).join(' ')`),
      ).includes(`was moved over droppable area ${BETA}`)
    let moved = false
    for (let press = 0; press < 5 && !moved; press++) {
      browser.press('ArrowDown')
      for (let poll = 0; poll < 10 && !moved; poll++) moved = overBeta()
    }
    expect(moved).toBe(true)
    browser.press('Space')
    browser.waitForFunction(`${stepIdsJs} === '${BETA},${ALPHA}'`)
    // Order is execution order — the YAML preview follows the move.
    expect(browser.text('[data-slot="wb-yaml"]').indexOf(BETA)).toBeLessThan(
      browser.text('[data-slot="wb-yaml"]').indexOf(ALPHA),
    )
    // dnd-kit's keyboard auto-scroll can leave the toolbar underneath the sticky app header.
    // Return to the top before the next test operates that toolbar, as a user would.
    browser.evaluate(`document.querySelector('[data-slot="main"]').scrollTop = 0`)
  })

  it('Save writes a real portable workflow file the server round-trips', () => {
    browser.fill('[data-slot="wb-name"]', FLOW)
    browser.click('[data-slot="wb-save"]')
    browser.waitForFunction(
      `document.querySelector('[data-slot="toaster"]')?.textContent.includes('Saved — ${FLOW}.yaml')`,
    )

    // The exported artifact on disk IS the compact portable form.
    const doc = parse(readFileSync(savedFlowPath, 'utf8')) as Record<string, unknown>
    expect(doc).toEqual({ name: FLOW, skills: [BETA, ALPHA] })

    // The catalog refetched: the new chain is selectable, and Delete now exists for it.
    browser.waitForFunction(`document.querySelector('[data-slot="wb-load-option"][data-name="${FLOW}"]') !== null`)
    browser.waitForFunction(`document.querySelector('[data-slot="wb-delete"]') !== null`)
    browser.screenshot(`${artifactsDir}/workflows-saved.png`)
  })

  it('keeps action hierarchy and readable summaries across viewport, theme, and density', () => {
    for (const [width, height] of [[360, 640], [1440, 900]] as const) {
      for (const density of ['comfortable', 'compact', 'ultra']) {
        for (const theme of ['light', 'dark']) {
          browser.setViewport(width, height)
          browser.evaluate(`(() => {
            document.documentElement.dataset.density = ${JSON.stringify(density)};
            document.documentElement.classList.toggle('light', ${JSON.stringify(theme)} === 'light');
          })()`)

          // Measure the settled theme, rather than an intermediate button color transition.
          browser.waitForFunction(`document.querySelector('[data-slot="wb-actions"]').getAnimations({ subtree: true }).every(animation => animation.playState !== 'running')`)
          const presentation = browser.evaluate(`(() => {
            const save = document.querySelector('[data-slot="wb-save"]');
            const removeFile = document.querySelector('[data-slot="wb-delete"]');
            const step = document.querySelector('[data-slot="wb-step"][data-id="${ALPHA}"]');
            const heading = step.querySelector('[data-slot="wb-step-heading"]');
            const summary = step.querySelector('[data-slot="wb-step-summary"]');
            const sr = summary.getBoundingClientRect(), hr = heading.getBoundingClientRect(), cr = step.getBoundingClientRect();
            const style = getComputedStyle(summary), saveStyle = getComputedStyle(save), deleteStyle = getComputedStyle(removeFile);
            const controls = ['[data-slot="wb-step-grip"]', '[data-slot="wb-step-actions"]', '${addButton(ALPHA)}']
              .map(selector => document.querySelector(selector).getBoundingClientRect())
              .map(rect => ({ width: rect.width, height: rect.height }));
            return {
              saveVariant: save.dataset.variant,
              deleteVariant: removeFile.dataset.variant,
              saveBackground: saveStyle.backgroundColor,
              deleteBackground: deleteStyle.backgroundColor,
              whiteSpace: style.whiteSpace,
              textOverflow: style.textOverflow,
              summaryTop: sr.top,
              summaryBottom: sr.bottom,
              headingBottom: hr.bottom,
              cardRight: cr.right,
              summaryRight: sr.right,
              lineHeight: parseFloat(style.lineHeight),
              controls,
              pageFits: document.documentElement.scrollWidth <= innerWidth,
            };
          })()`) as {
            saveVariant: string
            deleteVariant: string
            saveBackground: string
            deleteBackground: string
            whiteSpace: string
            textOverflow: string
            summaryTop: number
            summaryBottom: number
            headingBottom: number
            cardRight: number
            summaryRight: number
            lineHeight: number
            controls: Array<{ width: number; height: number }>
            pageFits: boolean
          }

          expect(presentation.saveVariant).toBe('primary')
          expect(presentation.deleteVariant).toBe('ghost')
          expect(presentation.saveBackground).not.toBe(presentation.deleteBackground)
          const deleteContrast = browser.evaluate(
            contrastSampleExpression('[data-slot="wb-delete"]'),
          ) as ContrastSample
          expect(
            deleteContrast.ratio,
            `${width}/${density}/${theme}: ${deleteContrast.foreground} on ${deleteContrast.background}`,
          ).toBeGreaterThanOrEqual(4.5)
          expect(presentation.whiteSpace).toBe('normal')
          expect(presentation.textOverflow).not.toBe('ellipsis')
          expect(presentation.summaryTop).toBeGreaterThanOrEqual(presentation.headingBottom)
          expect(presentation.summaryRight).toBeLessThanOrEqual(presentation.cardRight)
          expect(presentation.pageFits).toBe(true)
          if (width === 360) {
            expect(presentation.summaryBottom - presentation.summaryTop).toBeGreaterThan(
              presentation.lineHeight,
            )
            for (const control of presentation.controls) {
              expect(control.width).toBeGreaterThanOrEqual(44)
              expect(control.height).toBeGreaterThanOrEqual(44)
            }
          } else {
            for (const selector of [
              '[data-slot="wb-delete"]',
              '[data-slot="wb-save"]',
              '[data-slot="wb-step-grip"]',
              '[data-slot="wb-step-actions"]',
              addButton(ALPHA),
            ]) {
              focusWithKeyboard(browser, selector)
              expect(browser.evaluate(`(() => {
                const element = document.querySelector(${JSON.stringify(selector)});
                const style = getComputedStyle(element);
                return document.activeElement === element && element.matches(':focus-visible') &&
                  ((style.outlineStyle !== 'none' && parseFloat(style.outlineWidth) > 0) || style.boxShadow !== 'none');
              })()`), `${density}/${theme}: ${selector}`).toBe(true)
            }
          }

          browser.screenshot(
            `${presentationArtifacts}/${width}-${density}-${theme}.png`,
            { viewport: true },
          )
        }
      }
    }
  }, 60_000)

  it('keeps workflow actions reachable and visibly focused under reduced motion', () => {
    browser.setReducedMotion()
    for (const [width, height, density, theme] of [
      [360, 640, 'ultra', 'dark'],
      [1440, 900, 'comfortable', 'light'],
    ] as const) {
      browser.setViewport(width, height)
      browser.evaluate(`(() => {
        document.documentElement.dataset.density = ${JSON.stringify(density)};
        document.documentElement.classList.toggle('light', ${JSON.stringify(theme)} === 'light');
      })()`)
      // Establish keyboard modality before focusing Save so :focus-visible is exercised.
      browser.press('Tab')
      browser.evaluate(`document.querySelector('[data-slot="wb-save"]').focus()`)

      const facts = browser.evaluate(`(() => {
        const save = document.querySelector('[data-slot="wb-save"]');
        const saveStyle = getComputedStyle(save);
        const actions = [...document.querySelectorAll('[data-slot="wb-actions"] button')]
          .map(button => button.getBoundingClientRect())
          .map(rect => ({ width: rect.width, height: rect.height, right: rect.right }));
        return {
          reducedMotion: matchMedia('(prefers-reduced-motion: reduce)').matches,
          focused: document.activeElement === save && save.matches(':focus-visible'),
          focusRing: saveStyle.boxShadow,
          animationName: saveStyle.animationName,
          actions,
          pageFits: document.documentElement.scrollWidth <= innerWidth,
        };
      })()`) as {
        reducedMotion: boolean
        focused: boolean
        focusRing: string
        animationName: string
        actions: Array<{ width: number; height: number; right: number }>
        pageFits: boolean
      }

      expect(facts.reducedMotion).toBe(true)
      expect(facts.focused).toBe(true)
      expect(facts.focusRing).not.toBe('none')
      expect(facts.animationName).toBe('none')
      expect(facts.pageFits).toBe(true)
      if (width === 360) {
        for (const action of facts.actions) {
          expect(action.width).toBeGreaterThanOrEqual(44)
          expect(action.height).toBeGreaterThanOrEqual(44)
          expect(action.right).toBeLessThanOrEqual(width)
        }
      }
      browser.screenshot(
        `${presentationArtifacts}/${width}-${density}-${theme}-reduced-motion.png`,
        { viewport: true },
      )
    }
  })

  it('Import parses pasted YAML through the server and renders richer flows as full steps', () => {
    const pasted = [
      `name: ${FLOW}-imported`,
      'steps:',
      '  - id: fix',
      `    skill: ${ALPHA}`,
      "    prompt: '{{task}}'",
      '  - id: tests',
      '    command: npm test',
      '    onFail:',
      '      retry: fix',
      '      max: 2',
    ].join('\n')
    browser.click('[data-slot="wb-import"]')
    browser.waitForFunction(`document.querySelector('[data-slot="wb-import-text"]') !== null`)
    browser.fill('[data-slot="wb-import-text"]', pasted)
    // The expanded import card can place its actions below the nested page viewport.
    browser.evaluate(`document.querySelector('[data-slot="wb-import-run"]').scrollIntoView({ block: 'center' })`)
    browser.click('[data-slot="wb-import-run"]')

    browser.waitForFunction(`${stepIdsJs} === 'fix,tests' || document.querySelector('[data-slot="wb-import-error"]') !== null`)
    expect(browser.evaluate(`document.querySelector('[data-slot="wb-import-error"]')?.textContent ?? ''`)).toBe('')
    expect(String(browser.evaluate(stepIdsJs))).toBe('fix,tests')
    expect(browser.text('[data-slot="wb-count"]')).toBe('2 steps')
    // The check step retains its kind and retry count below the summary; YAML stays complete.
    expect(browser.text('[data-slot="wb-step"][data-id="tests"] [data-slot="wb-step-kind"]')).toBe('Command step · Retry ×2')
    expect(browser.text('[data-slot="wb-yaml"]')).toContain('steps:')
    expect(browser.text('[data-slot="wb-yaml"]')).toContain('command: npm test')
    const separation = browser.evaluate(`(() => {
      const step = document.querySelector('[data-slot="wb-step"][data-id="tests"]');
      const heading = step.querySelector('[data-slot="wb-step-heading"]').getBoundingClientRect();
      const summary = step.querySelector('[data-slot="wb-step-summary"]').getBoundingClientRect();
      const kind = step.querySelector('[data-slot="wb-step-kind"]').getBoundingClientRect();
      return { summaryTop: summary.top, summaryBottom: summary.bottom, headingBottom: heading.bottom, kindTop: kind.top };
    })()`) as { summaryTop: number; summaryBottom: number; headingBottom: number; kindTop: number }
    expect(separation.summaryTop).toBeGreaterThanOrEqual(separation.headingBottom)
    expect(separation.kindTop).toBeGreaterThanOrEqual(separation.summaryBottom)
    browser.screenshot(`${artifactsDir}/workflows-imported.png`)
  })

  it('refuses the 9th step with the legacy limit message', () => {
    // 2 imported steps on the canvas — fill up to the server's cap of 8, then one more.
    for (let i = 0; i < 6; i++) browser.click(addButton(ALPHA))
    browser.waitForFunction(`document.querySelectorAll('[data-slot="wb-step"]').length === 8`)

    browser.click(addButton(ALPHA))
    browser.waitForFunction(
      `document.querySelector('[data-slot="toaster"]')?.textContent.includes('at most 8 steps')`,
    )
    expect(browser.count('[data-slot="wb-step"]')).toBe(8)
  })
})

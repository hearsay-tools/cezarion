import { resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { AgentBrowser, bootProjectId, readTestEnv } from './agent-browser'

const artifactsDir = resolve(import.meta.dirname, '../../../.ai/qa/artifacts_e2e')
const sessionId = `e2e-page-headings-${process.pid}`

const PHONE = { width: 360, height: 640 }
const DESKTOP = { width: 1440, height: 900 }

let browser: AgentBrowser
let baseUrl: string
let bootProject: string

const scoped = (path: string) => `/p/${bootProject}${path}`

beforeAll(async () => {
  baseUrl = readTestEnv().baseUrl
  bootProject = await bootProjectId(baseUrl)
  browser = AgentBrowser.open(sessionId)
})

afterAll(() => {
  browser?.close()
})

describe('Git page headings at the review viewports', () => {
  for (const page of [
    {
      name: 'Git',
      title: 'Git · Changes',
      path: '/git',
      header: '[data-slot="repo-header"]',
      context: '[data-slot="branch-chip"]',
      content: '[data-slot="repo-changes-toolbar"]',
    },
    {
      name: 'GitHub',
      title: 'GitHub',
      path: '/github',
      header: '[data-slot="gh-header"]',
      context: '[data-slot="gh-repo"]',
      content: '[data-slot="gh-row"]',
    },
  ] as const) {
    for (const viewport of [PHONE, DESKTOP]) {
      for (const theme of ['light', 'dark'] as const) {
        it(`${page.name} at ${viewport.width}x${viewport.height} in ${theme} keeps one visible title, context, and first-row access`, () => {
          browser.setViewport(viewport.width, viewport.height)
          browser.goto(`${baseUrl}${scoped(page.path)}`)
          browser.waitForFunction(`document.querySelector(${JSON.stringify(page.content)}) !== null`)
          // Repo discovery is independent of route data. Before it resolves, the mobile
          // bar deliberately shows the route title in place of the project picker.
          browser.waitForFunction(`document.querySelector('[data-slot="mobile-project-picker"]') !== null`)
          browser.evaluate(`document.documentElement.classList.toggle('light', ${theme === 'light'})`)

          const facts = browser.evaluate(`(() => {
            const header = document.querySelector(${JSON.stringify(page.header)})
            const routeTitle = header.querySelector('h1')
            const shell = document.querySelector('[data-slot="mobile-top-bar"]')
            const shellTitle = [...shell.querySelectorAll('span')].find((node) => node.textContent.trim() === ${JSON.stringify(page.name)})
            const context = document.querySelector(${JSON.stringify(page.context)})
            const content = document.querySelector(${JSON.stringify(page.content)})
            const painted = (element) => {
              if (!element) return false
              const rect = element.getBoundingClientRect()
              const style = getComputedStyle(element)
              return element.checkVisibility({ opacityProperty: true, visibilityProperty: true }) && rect.width > 2 && rect.height > 2 && style.display !== 'none' &&
                style.visibility !== 'hidden' && Number(style.opacity) > 0
            }
            const headerRect = header.getBoundingClientRect()
            const contentRect = content.getBoundingClientRect()
            return {
              routeTitleText: routeTitle.textContent.trim(),
              routeTitleTag: routeTitle.tagName,
              routeTitleAriaHidden: routeTitle.getAttribute('aria-hidden'),
              routeTitlePainted: painted(routeTitle),
              shellTitlePainted: painted(shellTitle),
              contextPainted: painted(context),
              contextText: context.textContent.trim(),
              firstRowBelowHeader: contentRect.top >= headerRect.bottom - 1,
              firstRowInViewport: contentRect.top < innerHeight && contentRect.bottom > 0,
              pageOverflow: document.documentElement.scrollWidth > innerWidth,
              light: document.documentElement.classList.contains('light'),
            }
          })()`) as {
            routeTitleText: string
            routeTitleTag: string
            routeTitleAriaHidden: string | null
            routeTitlePainted: boolean
            shellTitlePainted: boolean
            contextPainted: boolean
            contextText: string
            firstRowBelowHeader: boolean
            firstRowInViewport: boolean
            pageOverflow: boolean
            light: boolean
          }

          expect(facts.light).toBe(theme === 'light')
          expect(facts.routeTitleText).toBe(page.title)
          expect(facts.routeTitleTag).toBe('H1')
          expect(facts.routeTitleAriaHidden).toBeNull()
          expect(browser.snapshot()).toContain(page.name)
          expect(facts.contextPainted).toBe(true)
          expect(facts.contextText.length).toBeGreaterThan(0)
          expect(facts.firstRowBelowHeader).toBe(true)
          expect(facts.firstRowInViewport).toBe(true)
          expect(facts.pageOverflow).toBe(false)

          // Page headings remain in the route at both widths; the mobile bar is brand/context.
          expect(facts.routeTitlePainted).toBe(true)
          expect(facts.shellTitlePainted).toBe(false)

          browser.screenshot(
            `${artifactsDir}/page-heading-${page.path.slice(1)}-${viewport.width}-${theme}.png`,
            { viewport: true },
          )
        })
      }
    }
  }
})

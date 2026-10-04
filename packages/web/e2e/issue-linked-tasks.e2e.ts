import { afterAll, beforeAll, expect, it } from 'vitest'

import { artifactsDir, createGitHubFixture, type GitHubFixture, type GithubPayload } from './github-fixture'
import { settleVisual } from './visual-ready'

let fixture: GitHubFixture
beforeAll(async () => { fixture = await createGitHubFixture(`e2e-linked-${process.pid}`) })
afterAll(() => { fixture?.browser.close() })

it.each(['light', 'dark'] as const)('discloses parent tasks with pointer and keyboard on a narrow %s screen (#787)', async (theme) => {
  const { browser, api, openGitHub, scoped } = fixture
  const gh = await api<GithubPayload>('/api/v1/github')
  const number = gh.issues[0]!.number
  const runs = [
    { id: 'linked-parent', title: 'Archived parent task with a long title that wraps on a narrow screen', archived: true },
    { id: 'linked-worker', title: 'Owned worker must stay hidden', delegation: { role: 'worker', parentRunId: 'linked-parent' } },
  ].map(run => ({ task: run.title, workflow: 'quick-task', status: 'done', createdAt: '2026-10-01T12:00:00Z', tokensUsed: 0, steps: [], issueNumber: number, ...run }))
  const toggle = '[data-slot="gh-detail"] h3 button[aria-expanded]'
  browser.routeJson('*/runs', runs)
  browser.setReducedMotion()
  browser.setViewport(360, 640)
  try {
    await openGitHub(`/github/issues/${number}?filter=all`)
    browser.waitForFunction(`document.querySelector('${toggle}')?.textContent.includes('Linked tasks (1)')`)
    browser.evaluate(`document.documentElement.classList.toggle('light', ${theme === 'light'}); document.querySelector('${toggle}').scrollIntoView({block:'center'})`)
    settleVisual(browser, '[data-slot="gh-detail"]', { theme, idle: true })
    const initial = browser.waitForValue<{ expanded: string; height: number; links: number }>(`(() => {
      const button = document.querySelector('${toggle}');
      return { expanded: button.getAttribute('aria-expanded'), height: button.getBoundingClientRect().height,
        links: document.getElementById(button.getAttribute('aria-controls')).querySelectorAll('a').length };
    })()`)
    expect(initial).toEqual({ expanded: 'false', height: 44, links: 0 })
    browser.screenshot(`${artifactsDir}/linked-tasks-${theme}-collapsed.png`, { viewport: true })
    browser.click(toggle)
    browser.waitForFunction(`document.querySelector('${toggle}').getAttribute('aria-expanded') === 'true'`)
    settleVisual(browser, '[data-slot="gh-detail"]', { theme, idle: true })
    const expanded = browser.waitForValue<{ hrefs: string[]; archived: boolean; overflow: boolean; reduced: boolean; animations: number }>(`(() => {
      const button = document.querySelector('${toggle}');
      const panel = document.getElementById(button.getAttribute('aria-controls'));
      return { hrefs: [...panel.querySelectorAll('a')].map(a => a.getAttribute('href')),
        archived: panel.textContent.includes('Archived'), overflow: document.documentElement.scrollWidth > innerWidth,
        reduced: matchMedia('(prefers-reduced-motion: reduce)').matches,
        animations: button.closest('section').getAnimations({subtree:true}).length };
    })()`)
    expect(expanded).toEqual({ hrefs: [scoped('/tasks/linked-parent')], archived: true, overflow: false, reduced: true, animations: 0 })
    browser.screenshot(`${artifactsDir}/linked-tasks-${theme}-expanded.png`, { viewport: true })
    browser.press('Enter')
    browser.waitForFunction(`document.querySelector('${toggle}').getAttribute('aria-expanded') === 'false' && document.activeElement === document.querySelector('${toggle}')`)
    browser.press('Space')
    browser.waitForFunction(`document.querySelector('${toggle}').getAttribute('aria-expanded') === 'true'`)
    browser.press('Tab')
    browser.waitForFunction(`document.activeElement?.getAttribute('href') === '${scoped('/tasks/linked-parent')}'`)
    browser.press('Enter')
    browser.waitForFunction(`location.pathname === '${scoped('/tasks/linked-parent')}'`)
  } finally { browser.unroute('*/runs') }
}, 90_000)

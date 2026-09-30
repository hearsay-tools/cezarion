import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest'

import { AgentBrowser } from './agent-browser'
import { artifactsDir, createGitHubFixture, DESKTOP } from './github-fixture'
import type { GitHubFixture } from './github-fixture'

const sessionId = `e2e-ghs-${process.pid}`

let browser: GitHubFixture['browser']
let baseUrl: GitHubFixture['baseUrl']
let api: GitHubFixture['api']
let scoped: GitHubFixture['scoped']
let rememberGithubView: GitHubFixture['rememberGithubView']

beforeAll(async () => {
  ({ browser, baseUrl, api, scoped, rememberGithubView } = await createGitHubFixture(sessionId))
})

beforeEach(async () => {
  await rememberGithubView('issues')
  browser.setViewport(DESKTOP.width, DESKTOP.height)
  browser.goto('about:blank')
})

afterAll(() => {
  browser?.close()
})

it.each(['loading', 'empty', 'error'].flatMap(state => ['light', 'dark'].map(theme => ({ state, theme }))))('renders GitHub $state in $theme without losing navigation', async ({ state, theme }) => {
  const stateBrowser = AgentBrowser.open(`${sessionId}-${state}-${theme}`)
  const previous = await api<{ githubView?: 'issues' | 'prs' }>('/api/v1/ui-state')
  try {
    // The bare Issues list restores the last tab (#417); set a deterministic fixture
    // before this fresh browser loads its UI-state cache, and restore it below.
    await rememberGithubView('issues')
    stateBrowser.setViewport(402, 900)
    stateBrowser.goto(`${baseUrl}${scoped('/')}`)
    stateBrowser.waitForFunction(`document.querySelector('a[href="${scoped('/github')}"]') !== null`)
    stateBrowser.evaluate(`(() => {
      const nativeFetch = window.fetch;
      window.fetch = (input, init) => {
        const url = typeof input === 'string' ? input : input instanceof Request ? input.url : String(input);
        if (new URL(url, location.href).pathname.endsWith('/github')) {
          ${state === 'loading' ? 'return new Promise(() => {});' : `return Promise.resolve(new Response(JSON.stringify(${JSON.stringify(state === 'empty' ? { available: true, repo: 'fixture/repo', issues: [], prs: [], projects: [], viewerLogin: 'fixture' } : { error: 'Fixture connection unavailable' })}), { status: ${state === 'error' ? 500 : 200}, headers: { 'content-type': 'application/json' } }));`}
        }
        return nativeFetch(input, init);
      };
      document.querySelector('a[href="${scoped('/github')}"]').click();
    })()`)
    // 402px is a phone: the link opens the filter index (#622); choosing All issues pushes the list.
    stateBrowser.waitForFunction(`document.querySelector('[data-slot="github-filter-screen"] [data-gh-filter="all"]') !== null`)
    stateBrowser.click('[data-slot="github-filter-screen"] [data-gh-filter="all"]')
    const expected = state === 'loading' ? 'Loading GitHub' : state === 'error' ? 'Could not load GitHub' : 'No open issues'
    stateBrowser.waitForFunction(`document.querySelector('[data-route="github"]')?.textContent.includes(${JSON.stringify(expected)}) === true`)
    stateBrowser.evaluate(`document.documentElement.classList.toggle('light', ${theme === 'light'}); document.documentElement.dataset.width = 'wide'; new Promise(resolve => setTimeout(resolve, 250))`)
    expect(stateBrowser.evaluate(`document.documentElement.scrollWidth <= innerWidth`)).toBe(true)
    stateBrowser.screenshot(`${artifactsDir}/revised-github-${state}-${theme}.png`, { viewport: true })
  } finally { stateBrowser.close(); await rememberGithubView(previous.githubView ?? 'issues') }
}, 90_000)

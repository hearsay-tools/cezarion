import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest'

import { AgentBrowser } from './agent-browser'
import { artifactsDir, createGitHubFixture, DESKTOP } from './github-fixture'
import type { GitHubFixture, GithubPayload } from './github-fixture'

const sessionId = `e2e-ghp-${process.pid}`

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

it.each(['ready', 'unknown', 'conflicting'].flatMap(state => [1440, 402].flatMap(width => ['light', 'dark'].map(theme => ({ state, width, theme })))))('preserves PR $state review at $width / $theme', async ({ state, width, theme }) => {
  const gh = await api<GithubPayload>('/api/v1/github')
  const item = gh.prs[0]!
  const stateBrowser = AgentBrowser.open(`${sessionId}-pr-${state}-${width}-${theme}`)
  try {
    stateBrowser.setViewport(width, 1000)
    stateBrowser.goto(`${baseUrl}${scoped('/')}`)
    stateBrowser.waitForFunction(`document.querySelector('[data-slot="main"]') !== null`)
    const mergeState = {
      available: true,
      mergeState: {
        number: item.number, title: item.title, url: `https://github.com/mock/repo/pull/${item.number}`,
        state: 'open', isDraft: false, headRef: 'fixture/review', baseRef: 'main', headSha: '0123456789abcdef0123456789abcdef01234567',
        mergeable: state === 'conflicting' ? 'conflicting' : 'mergeable', reviewDecision: state === 'ready' ? 'approved' : 'unknown',
        checks: [{ name: 'fixture-check', state: 'passing', required: state === 'unknown' ? null : true }],
        methods: ['squash'], defaultMethod: 'squash', eligibility: state === 'ready' ? 'ready' : state === 'unknown' ? 'unknown' : 'blocked',
        blockers: [], canMerge: state === 'ready', canOverride: state === 'unknown',
      },
    }
    stateBrowser.evaluate(`(() => {
      const nativeFetch = window.fetch; window.__mergePosts = 0;
      window.fetch = (input, init) => {
        const url = typeof input === 'string' ? input : input instanceof Request ? input.url : String(input);
        if (url.includes('/merge-state')) return Promise.resolve(new Response(JSON.stringify(${JSON.stringify(mergeState)}), {headers:{'content-type':'application/json'}}));
        if (url.includes('/merge') && init?.method === 'POST') { window.__mergePosts++; throw new Error('Fixture PRs must never merge'); }
        return nativeFetch(input, init);
      };
      history.pushState(null, '', ${JSON.stringify(scoped(`/github/prs/${item.number}`))}); dispatchEvent(new PopStateEvent('popstate'));
    })()`)
    stateBrowser.waitForFunction(`document.querySelector('[data-slot="gh-merge-box"]') !== null`)
    stateBrowser.evaluate(`document.documentElement.classList.toggle('light', ${theme === 'light'}); document.documentElement.dataset.width = 'wide'; document.querySelector('[data-slot="gh-merge-box"]').scrollIntoView({block:'center'}); new Promise(resolve => setTimeout(resolve, 250))`)
    expect(stateBrowser.evaluate(`document.documentElement.scrollWidth <= innerWidth`)).toBe(true)
    expect(stateBrowser.text('[data-slot="gh-merge-box"]')).toContain(state === 'ready' ? 'Ready to merge' : state === 'unknown' ? 'Requirements unknown' : 'Conflicts must be resolved')
    if (state === 'unknown') {
      expect(stateBrowser.evaluate(`document.querySelector('[data-slot="gh-merge-box"] input[type="checkbox"]').checked`)).toBe(false)
      expect(stateBrowser.evaluate(`[...document.querySelectorAll('[data-slot="gh-merge-box"] button')].find(el => el.textContent === 'Squash and merge').disabled`)).toBe(true)
    }
    stateBrowser.screenshot(`${artifactsDir}/revised-pr-${state}-${width}-${theme}.png`, { viewport: true })
    if (state === 'ready') {
      stateBrowser.evaluate(`[...document.querySelectorAll('[data-slot="gh-merge-box"] button')].find(el => el.textContent === 'Squash and merge').click()`)
      stateBrowser.waitForFunction(`document.querySelector('[data-slot="gh-merge-confirm"]') !== null`)
      expect(stateBrowser.text('[data-slot="gh-merge-confirm"]')).toContain('exact reviewed head')
      stateBrowser.screenshot(`${artifactsDir}/revised-pr-confirm-${width}-${theme}.png`, { viewport: true })
      stateBrowser.press('Escape')
    }
    if (state === 'conflicting') {
      stateBrowser.evaluate(`[...document.querySelectorAll('[data-slot="gh-merge-box"] button')].find(el => el.textContent === 'Run agent on this PR').click()`)
      // Focus moves to the prompt in the product's own handler; wait for it rather than sample it.
      // Not a flake fix: no failure is on record for this line. Wait-discipline rule 7 (#410)
      // surfaced it as a one-shot read of the focused element after an in-page click, and a
      // wait on the same condition costs nothing while a sample is only ever right by timing.
      stateBrowser.waitForFunction(`document.activeElement === document.querySelector('[data-slot="gh-custom-prompt"]')`)
    }
    expect(stateBrowser.evaluate('window.__mergePosts')).toBe(0)
  } finally { stateBrowser.close() }
}, 90_000)

import { describe, expect, it } from 'vitest'

import {
  formatGitHubNavFailure,
  githubSurfaceReadyJs,
} from './github-nav-contract'

const ISSUES = '/p/cezar/github'
const PRS = '/p/cezar/github/prs'

function surfaceReady(pathname: string, html: string): boolean {
  window.history.replaceState({}, '', pathname)
  document.body.innerHTML = html
  return Boolean(new Function(`return ${githubSurfaceReadyJs({
    pathname: ISSUES,
    issuesHref: ISSUES,
    prsHref: PRS,
  })}`)())
}

describe('githubSurfaceReadyJs', () => {
  it('is not ready while the github route is loading without tabs', () => {
    expect(surfaceReady(ISSUES, `<div data-route="github"></div>`)).toBe(false)
  })

  it('is not ready when tabs exist outside the github route surface', () => {
    expect(
      surfaceReady(
        ISSUES,
        `<nav data-slot="gh-tabs"><a href="${ISSUES}">Issues</a><a href="${PRS}">PRs</a></nav>`,
      ),
    ).toBe(false)
  })

  it('is not ready while a remembered-tab redirect has left the issues path', () => {
    expect(
      surfaceReady(
        PRS,
        `<div data-route="github"><div data-slot="gh-tabs"><a href="${ISSUES}">Issues</a><a href="${PRS}">PRs</a></div></div>`,
      ),
    ).toBe(false)
  })

  it('is ready only when the github route owns both tabs on the requested path', () => {
    expect(
      surfaceReady(
        ISSUES,
        `<div data-route="github"><div data-slot="gh-tabs"><a href="${ISSUES}">Issues · 3</a><a href="${PRS}">Pull requests · 2</a></div></div>`,
      ),
    ).toBe(true)
  })
})

describe('formatGitHubNavFailure', () => {
  it('reports the active URL and tab markup so a miss can be told from a driver lie', () => {
    expect(
      formatGitHubNavFailure({
        url: 'http://127.0.0.1:4318/p/cezar/github/prs',
        tabMarkup: '<div data-slot="gh-tabs"><a href="/p/cezar/github">Issues · 3</a></div>',
        message: 'cezar e2e: agent-browser click [data-slot="gh-tabs"] a[href="/p/cezar/github"] failed',
      }),
    ).toBe(
      [
        'cezar e2e: agent-browser click [data-slot="gh-tabs"] a[href="/p/cezar/github"] failed',
        'active URL: http://127.0.0.1:4318/p/cezar/github/prs',
        'tab markup: <div data-slot="gh-tabs"><a href="/p/cezar/github">Issues · 3</a></div>',
      ].join('\n'),
    )
  })

  it('names missing tab markup instead of looking like an empty surface', () => {
    expect(
      formatGitHubNavFailure({
        url: 'http://127.0.0.1:4318/p/cezar/',
        tabMarkup: '',
        message: 'timed out waiting for github tabs',
      }),
    ).toContain('tab markup: (none)')
  })
})

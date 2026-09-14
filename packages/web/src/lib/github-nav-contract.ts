/** Predicate for waiting until the GitHub route that owns the Issues/PRs tabs is on screen. */
export function githubSurfaceReadyJs(opts: {
  pathname: string
  issuesHref: string
  prsHref: string
}): string {
  return `(() => {
    if (location.pathname !== ${JSON.stringify(opts.pathname)}) return false;
    const tabs = document.querySelector('[data-route="github"] [data-slot="gh-tabs"]');
    if (!tabs) return false;
    return tabs.querySelector(${JSON.stringify(`a[href="${opts.issuesHref}"]`)}) !== null
      && tabs.querySelector(${JSON.stringify(`a[href="${opts.prsHref}"]`)}) !== null;
  })()`
}

/** Capture the tab strip as rendered, for navigation-failure diagnostics. */
export const GITHUB_TAB_MARKUP_JS =
  `document.querySelector('[data-route="github"] [data-slot="gh-tabs"]')?.outerHTML ?? ''`

export function formatGitHubNavFailure(opts: {
  url: string
  tabMarkup: string
  message: string
}): string {
  return [
    opts.message,
    `active URL: ${opts.url}`,
    `tab markup: ${opts.tabMarkup || '(none)'}`,
  ].join('\n')
}

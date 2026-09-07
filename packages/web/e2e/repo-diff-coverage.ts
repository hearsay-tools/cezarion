import { expect } from 'vitest'

import type { AgentBrowser } from './agent-browser'

/**
 * Completeness of a repo Git diff without treating mounted card count as a total-files
 * oracle. Virtualization (#136) mounts a viewport window; the displayed total, the file
 * tree, and (when virtualized) selecting the last tree row are what can still be observed.
 */
export function assertDiffCoverage(
  browser: AgentBrowser,
  files: Array<{ path: string }>,
  opts: { tree: boolean; expectWindow?: boolean },
): { virtualized: boolean } {
  const count = files.length
  const label = `${count} ${count === 1 ? 'file' : 'files'} changed`
  browser.waitForFunction(`document.querySelector('[data-slot="diff-files"]') !== null`)
  browser.waitForFunction(
    `document.querySelector('[data-slot="diff-totals"] > span')?.textContent?.trim() === ${JSON.stringify(label)}`,
  )

  if (opts.tree) {
    const expectedJson = JSON.stringify([...files.map((file) => file.path)].sort())
    browser.waitForFunction(
      `JSON.stringify([...document.querySelectorAll('[data-slot="tree-file"]')].map((el) => el.dataset.path).sort()) === ${JSON.stringify(expectedJson)}`,
    )
  }

  const virtualized =
    browser.evaluate(`document.querySelector('[data-slot="diff-files"]')?.dataset.virtualized`) === 'true'
  browser.waitForFunction(`document.querySelector('[data-slot="diff-file"]') !== null`)

  if (!virtualized) {
    browser.waitForFunction(`document.querySelectorAll('[data-slot="diff-file"]').length === ${count}`)
    return { virtualized }
  }

  if (opts.expectWindow) {
    expect(browser.count('[data-slot="diff-file"]')).toBeLessThan(count)
  }

  if (opts.tree) {
    const lastPath = browser.evaluate(`(() => {
      const nodes = [...document.querySelectorAll('[data-slot="tree-file"]')]
      const last = nodes[nodes.length - 1]
      if (!(last instanceof HTMLElement)) return null
      last.click()
      return last.dataset.path ?? null
    })()`) as string | null
    expect(lastPath).not.toBeNull()
    browser.waitForFunction(
      `[...document.querySelectorAll('[data-slot="diff-file"]')].some((el) => el.dataset.path === ${JSON.stringify(lastPath)})`,
    )
  }

  return { virtualized }
}

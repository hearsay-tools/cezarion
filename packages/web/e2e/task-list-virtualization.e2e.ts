import { settleVisual, waitForSettledSample } from './visual-ready'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { AgentBrowser } from './agent-browser'
import { createTabFixture } from './tab-fixture'

let fixture: Awaited<ReturnType<typeof createTabFixture>>
let browser: AgentBrowser
beforeAll(async () => {
  fixture = await createTabFixture(process.cwd(), { taskList: 'project', taskListSizes: { active: 150, archived: 0, projects: 1 } })
  browser = AgentBrowser.open(`task-list-virtual-${process.pid}`)
  browser.setViewport(1440, 900)
  browser.goto(`${fixture.origin}/p/boot/?tasks=virtual`)
  browser.waitForFunction(`document.querySelector('[data-virtualized="true"] [data-slot="task-summary-row"]') !== null`)
})
afterAll(async () => { browser?.close(); await fixture?.stop() })

it('bounds rows, preserves focused controls and expansion, and follows pathname scroll rules', () => {
  const count = browser.waitForValue(`document.querySelectorAll('[data-slot="task-summary-row"]').length`) as number
  expect(count).toBeGreaterThan(0)
  expect(count).toBeLessThan(150)
  const first = browser.waitForValue(`document.querySelector('[data-slot="task-summary-row"]').dataset.runId`) as string
  const row = `[data-slot="task-summary-row"][data-run-id="${first}"]`
  browser.click(`${row} button[aria-label^="Show resources"]`)
  browser.waitForFunction(`document.querySelector('${row} button[aria-expanded="true"]') !== null`)
  // Keyboard traversal crosses the spanning preview into the next logical run.
  const next = browser.waitForValue(`(() => { const current=document.querySelector('${row}');const index=Number(current.getAttribute('aria-rowindex'))+2;return current.closest('[role="table"]').querySelector('[data-slot="task-summary-row"][aria-rowindex="'+index+'"]')?.dataset.runId })()`) as string
  browser.evaluate(`const detail=document.querySelector('${row}').nextElementSibling;const controls=detail.querySelectorAll('a[href],button:not([disabled]),[tabindex="0"]');controls[controls.length-1].focus()`)
  browser.press('Tab')
  expect(browser.waitForValue(`document.activeElement?.closest('[data-run-id]')?.dataset.runId`)).toBe(next)
  // Focus is pinned with its keyboard neighbours even when the viewport moves far away.
  browser.evaluate(`document.querySelector('${row} a').focus();document.querySelector('[data-slot="main"]').scrollTop=7000`)
  expect(browser.waitForValue(`document.activeElement?.closest('[data-run-id]')?.dataset.runId`)).toBe(first)
  browser.waitForFunction(`document.querySelector('[data-slot="main"]').scrollTop > 1000`)
  expect(browser.waitForValue(`document.querySelector('${row}') !== null`)).toBe(true)
  browser.evaluate(`document.querySelector('input[aria-label="Search tasks"]').focus();document.querySelector('[data-slot="main"]').scrollTop=7000`)
  browser.waitForFunction(`document.querySelector('${row}') === null`)
  browser.evaluate(`document.querySelector('[data-slot="main"]').scrollTop=0`)
  browser.waitForFunction(`document.querySelector('${row} button[aria-expanded="true"]') !== null`)
  settleVisual(browser, row, { idle: true })
  browser.click(`${row} [data-slot="row-rename"]`)
  browser.fill(`${row} input[aria-label="Task title"]`, 'Pinned rename draft')
  browser.evaluate(`document.querySelector('[data-slot="main"]').scrollTop=7000`)
  expect(browser.waitForValue(`document.activeElement?.value`)).toBe('Pinned rename draft')
  browser.evaluate(`document.querySelector('[data-slot="main"]').scrollTop=0`)
  browser.click(`${row} button[aria-label="Cancel rename"]`)
  settleVisual(browser, row, { idle: true })
  browser.evaluate(`document.querySelector('${row} [data-slot="row-rename"]').focus()`)
  browser.press('Enter')
  browser.waitForFunction(`document.querySelector('${row} input[aria-label="Task title"]') !== null`)
  browser.click(`${row} button[aria-label="Cancel rename"]`)
  // The measurement override is a query change: it must retain the page offset.
  browser.evaluate(`document.querySelector('[data-slot="main"]').scrollTop=500`)
  browser.evaluate(`history.replaceState(null,'','?tasks=flat');window.dispatchEvent(new PopStateEvent('popstate'))`)
  browser.waitForFunction(`document.querySelector('[data-virtualized="false"]') !== null`)
  expect(browser.waitForValue(`document.querySelector('[data-slot="main"]').scrollTop`)).toBeGreaterThan(0)
  browser.evaluate(`document.querySelector('[data-slot="main"]').scrollTop=0`)
  browser.click(`${row} a`)
  browser.waitForFunction(`location.pathname.endsWith('/tasks/${first}')`)
  expect(browser.waitForValue(`document.querySelector('[data-slot="main"]').scrollTop`)).toBe(0)
})

it.each([undefined, 'Tab task 130'])('keeps the first visible row anchored after insertion above it (%s)', async (beforeTitle) => {
  browser.setViewport(1440, 900)
  browser.goto(`${fixture.origin}/p/boot/?tasks=virtual`)
  browser.waitForFunction(`document.querySelector('[data-virtualized="true"] [data-slot="task-summary-row"]') !== null`)
  browser.evaluate(`document.querySelector('[data-slot="main"]').scrollTop=6500`)
  const firstVisible = `(() => { const owner=document.querySelector('[data-slot="main"]'); const edge=owner.getBoundingClientRect().top; const row=[...document.querySelectorAll('[data-slot="task-summary-row"]')].find(row=>row.getBoundingClientRect().bottom>edge && row.getBoundingClientRect().top<edge+owner.clientHeight); return row ? {id:row.dataset.runId,top:row.getBoundingClientRect().top} : null })()`
  const before = waitForSettledSample(browser, firstVisible) as { id: string; top: number }
  const count = browser.waitForValue(`Number(document.querySelector('[data-slot="tasks-summary"] [role="table"]').getAttribute('aria-rowcount'))`) as number
  await fixture.control({ insertTask: { title: `Inserted ${beforeTitle ?? 'prepend'}`, beforeTitle } })
  browser.waitForFunction(`Number(document.querySelector('[data-slot="tasks-summary"] [role="table"]').getAttribute('aria-rowcount')) === ${count + 1} && window.__cezIdle && !document.querySelector('[data-slot="task-summary-row"][data-status="queued"]')`)
  const after = waitForSettledSample(browser, `(() => { const row=document.querySelector('[data-slot="task-summary-row"][data-run-id="${before.id}"]');return row ? {id:row.dataset.runId,top:row.getBoundingClientRect().top} : null })()`) as { id: string; top: number }
  expect(after.id).toBe(before.id)
  expect(Math.abs(after.top - before.top)).toBeLessThanOrEqual(2)
})

it('keeps global summary column headers accessible on phones', () => {
  browser.setViewport(390, 844)
  browser.goto(`${fixture.origin}/tasks?tasks=virtual`)
  browser.waitForFunction(`document.querySelector('[data-slot="global-task-row"]') !== null`)
  const headers = browser.waitForValue(`(() => { const table=document.querySelector('[data-slot="global-tasks-table"][role="table"]'); return [...table.querySelectorAll('[role="columnheader"]')].map(cell=>({name:cell.textContent,hidden:[cell,cell.parentElement].some(node=>getComputedStyle(node).display==='none'||getComputedStyle(node).visibility==='hidden')})) })()`)
  expect(headers).toEqual(['Task', 'Workflow', 'Changes', 'Pull request', 'Started'].map(name => ({ name, hidden: false })))
})

it('paints rows on the first frame that contains a large list', async () => {
  browser.setViewport(1440, 900)
  const currentUrl = browser.url()
  await browser.withCdp(async (request) => {
    const { targetInfos } = await request('Target.getTargets')
    const target = targetInfos.find((entry: { type: string; url: string }) => entry.type === 'page' && entry.url === currentUrl)
    const { sessionId } = await request('Target.attachToTarget', { targetId: target.targetId, flatten: true })
    try {
      await request('Page.enable', {}, sessionId)
      const { identifier } = await request('Page.addScriptToEvaluateOnNewDocument', { source: `
        const observeFirstFrame = () => {
          const list = document.querySelector('[data-slot="task-list-items"]');
          if (!list) { requestAnimationFrame(observeFirstFrame); return; }
          window.__taskListFirstFrameRows = list.querySelectorAll('[data-task-item]').length;
        };
        requestAnimationFrame(observeFirstFrame);
      ` }, sessionId)
      browser.goto(`${fixture.origin}/p/boot/?tasks=virtual`)
      browser.waitForFunction('window.__taskListFirstFrameRows !== undefined')
      expect(browser.waitForValue('window.__taskListFirstFrameRows')).toBeGreaterThan(0)
      await request('Page.removeScriptToEvaluateOnNewDocument', { identifier }, sessionId)
    } finally { await request('Target.detachFromTarget', { sessionId }) }
  })
})

it.each([['summary', 2], ['detailed', 2], ['phone', 34], ['global', 8]] as const)('bounds the %s archived footer correction and accepts a settled paging click', async (presentation, bound) => {
  const archived = await createTabFixture(process.cwd(), { taskList: 'project', taskListSizes: { active: 0, archived: 300, projects: 1 } })
  try {
    browser.setViewport(presentation === 'phone' ? 360 : 1440, presentation === 'phone' ? 640 : 900)
    browser.goto(`${archived.origin}${presentation === 'global' ? '/tasks' : '/p/boot/'}?tasks=virtual`)
    browser.waitForFunction(`document.querySelector('[data-view="archived"]') !== null`)
    if (presentation === 'detailed') {
      browser.click('[data-slot="task-columns-trigger"]')
      browser.click('[data-slot="popover-content"] button')
      browser.press('Escape')
    }
    browser.click('[data-view="archived"]')
    const footer = presentation === 'global' ? '[data-slot="task-list-items"]' : '[data-route="tasks"] button.self-center'
    browser.waitForFunction(`document.querySelector('${footer}') !== null && window.__cezIdle`)
    const before = browser.evaluate(`(() => {const e=document.querySelector('${footer}');e.scrollIntoView({block:'end'});return e.getBoundingClientRect().bottom})()`) as number
    const after = waitForSettledSample<number>(browser, `document.querySelector('${footer}').getBoundingClientRect().bottom`)
    // Measured fixed-row residual <=1px; card end padding costs32px, global rounding4px.
    expect(Math.abs(after - before)).toBeLessThanOrEqual(bound)
    if (presentation !== 'global') {
      browser.click(footer)
      browser.waitForFunction(`document.querySelector('[data-slot="tasks-result-count"]')?.textContent.includes('300 tasks') && !document.querySelector('${footer}')`)
    }
  } finally { await archived.stop() }
})

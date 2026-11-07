import { RUN_STATUS } from '@open-mercato/cezar-api-client/contract/test-factories.testkit'
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

// Samples every frame from now until stopped: the saved row's top and how many rows cover the viewport.
const startFrames = (id: string) => `(() => {const owner=document.querySelector('[data-slot="main"]'),frames=window.__anchorFrames=[];window.__stopFrames=false;
  const step=()=>{const view=owner.getBoundingClientRect(),row=document.querySelector('[data-run-id="${id}"]');
    frames.push({top:row?row.getBoundingClientRect().top:null,rows:[...document.querySelectorAll('[data-task-item]')].filter(e=>{const r=e.getBoundingClientRect();return r.bottom>view.top&&r.top<view.bottom}).length});
    if(!window.__stopFrames&&frames.length<600)requestAnimationFrame(step)};requestAnimationFrame(step)})()`
// A one-frame jump or an empty viewport is visible even when the final position is right.
function expectEveryFrame(browser: AgentBrowser, top: number) {
  const frames = browser.evaluate('(() => {window.__stopFrames=true;return window.__anchorFrames})()') as { top: number | null; rows: number }[]
  expect(frames.length).toBeGreaterThan(0)
  for (const frame of frames) {
    expect(frame.rows).toBeGreaterThan(0)
    expect(frame.top).not.toBeNull()
    expect(Math.abs(frame.top! - top)).toBeLessThanOrEqual(2)
  }
}

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

it.each([[1440, 900], [360, 640]] as const)('fills a large global list before any scroll at %s px', async (width, height) => {
  const large = await createTabFixture(process.cwd(), { taskList: 'global' })
  try {
    browser.setViewport(width, height)
    browser.goto(`${large.origin}/tasks?tasks=virtual`)
    browser.waitForFunction(`document.querySelector('[data-view="archived"]') !== null && window.__cezIdle`)
    browser.click('[data-view="archived"]')
    browser.waitForFunction(`document.querySelector('[data-slot="global-task-row"]') !== null && window.__cezIdle`)
    const sample = waitForSettledSample<{ mounted: number; expected: number; covered: boolean; scrollTop: number }>(browser, `(() => {
      const owner=document.querySelector('[data-slot="main"]'), viewport=owner.getBoundingClientRect();
      const rows=[...document.querySelectorAll('[data-slot="global-task-row"]')].map(e=>e.getBoundingClientRect());
      const first=rows[0], available=Math.max(0,viewport.bottom-Math.max(first.top,viewport.top));
      return {mounted:rows.length,expected:Math.ceil(available/first.height),covered:available===0||Math.max(...rows.map(r=>r.bottom))>=viewport.bottom,scrollTop:owner.scrollTop};
    })()`)
    expect(sample.scrollTop).toBe(0)
    expect(sample.mounted).toBeGreaterThan(1)
    expect(sample.mounted).toBeGreaterThanOrEqual(sample.expected)
    expect(sample.covered).toBe(true)
  } finally { await large.stop() }
})

it.each(['project', 'global'] as const)('restores ordinary %s virtual-row focus across both breakpoint flips', async (scope) => {
  const large = await createTabFixture(process.cwd(), { taskList: scope, taskListSizes: { active: 310, archived: 0, projects: 1 } })
  try {
    browser.setViewport(1440, 900)
    browser.goto(`${large.origin}${scope === 'project' ? '/p/boot/' : '/tasks'}?tasks=virtual`)
    browser.waitForFunction(`document.querySelector('[data-virtualized="true"] [data-run-id] a') !== null && window.__cezIdle`)
    const id = browser.evaluate(`(() => {const row=document.querySelector('[data-virtualized="true"] [data-run-id]');row.querySelector('[data-task-control=title]').focus();return row.dataset.runId})()`)
    browser.waitForFunction(`document.activeElement?.dataset.taskControl === 'title' && document.activeElement.closest('[data-run-id]')?.dataset.runId === ${JSON.stringify(id)}`)
    for (const [width, height] of [[360, 640], [1440, 900], [360, 640]]) {
      browser.setViewport(width!, height!)
      browser.waitForFunction(`document.activeElement?.tagName === 'A' && document.activeElement.closest('[data-run-id]')?.dataset.runId === ${JSON.stringify(id)}`)
    }
  } finally { await large.stop() }
})

it.each([['project', 1440, 900], ['project', 360, 640], ['global', 1440, 900], ['global', 360, 640]] as const)('anchors %s at %s px after a run moves into an earlier group', async (scope, width, height) => {
  const large = await createTabFixture(process.cwd(), { taskList: scope, taskListSizes: { active: scope === 'global' ? 1000 : 310, archived: 0, projects: scope === 'global' ? 2 : 1 } })
  try {
    await large.control({ update: large.runs.slice(0, 120).map(run => ({ ...run, patch: { status: RUN_STATUS.done } })) })
    browser.setViewport(width, height)
    browser.goto(`${large.origin}${scope === 'project' ? '/p/boot/' : '/tasks'}?tasks=virtual`)
    browser.waitForFunction(`document.querySelector('[data-virtualized="true"] [data-run-id]') !== null && window.__cezIdle`)
    const route = `[data-route="${scope === 'project' ? 'tasks' : 'global-tasks'}"]`
    const finished = Number(browser.evaluate(`document.querySelector('${route} [data-bucket="Finished"] [data-slot="status-group-toggle"]').getAttribute('aria-label').match(/\\d+/)[0]`))
    browser.evaluate(`(() => {const owner=document.querySelector('[data-slot="main"]'),group=document.querySelector('${route} [data-bucket="Working"]');owner.scrollTop+=group.getBoundingClientRect().top-owner.getBoundingClientRect().top+${scope === 'global' ? 90445 : 6500}})()`)
    const sample = `(() => {const owner=document.querySelector('[data-slot="main"]'),edge=owner.getBoundingClientRect().top;const rows=[...document.querySelectorAll('${route} [data-run-id]')].filter(e=>e.getBoundingClientRect().bottom>edge&&e.getBoundingClientRect().top<edge+owner.clientHeight);return rows.length>1?{id:rows[0].dataset.runId,top:rows[0].getBoundingClientRect().top,move:rows[rows.length-1].dataset.runId,project:rows[rows.length-1].dataset.project}:null})()`
    const before = waitForSettledSample(browser, sample) as { id: string; top: number; move: string; project?: string }
    browser.evaluate(startFrames(before.id))
    await large.control({ update: [{ projectId: before.project ?? 'boot', runId: before.move, patch: { status: RUN_STATUS.done } }] })
    browser.waitForFunction(`document.querySelector('${route} [data-bucket="Finished"] [data-slot="status-group-toggle"]')?.getAttribute('aria-label')?.startsWith('Finished ${finished + 1}') && window.__cezIdle`)
    const after = waitForSettledSample(browser, `(() => {const row=document.querySelector('${route} [data-run-id="${before.id}"]');return row?row.getBoundingClientRect().top:null})()`) as number
    expect(Math.abs(after - before.top)).toBeLessThanOrEqual(2)
    expectEveryFrame(browser, before.top)
  } finally { await large.stop() }
})

it.each([
  ['project', 1440, 900, 'fold'], ['project', 360, 640, 'fold'],
  ['global', 1440, 900, 'fold'], ['global', 360, 640, 'fold'],
  ['project', 1440, 900, 'preview'], ['project', 360, 640, 'preview'],
  ['global', 1440, 900, 'preview'], ['global', 360, 640, 'preview'],
  ['global', 1440, 900, 'storage'],
  // A Finished group below the threshold renders flat above the virtual Working group.
  ['project', 1440, 900, 'flat fold'], ['project', 360, 640, 'flat fold'], ['project', 360, 640, 'flat storage'],
] as const)('anchors %s at %s x %s after an earlier %s collapses', async (scope, width, height, kind) => {
  const change = kind.replace('flat ', '') as 'fold' | 'preview' | 'storage'
  const large = await createTabFixture(process.cwd(), { taskList: scope, taskListSizes: { active: 310, archived: 0, projects: scope === 'global' ? 3 : 1 } })
  try {
    await large.control({ update: large.runs.slice(0, scope === 'global' ? 1 : kind.startsWith('flat') ? 80 : 120).map(run => ({ ...run, patch: { status: RUN_STATUS.done } })) })
    browser.setViewport(width, height)
    browser.goto(`${large.origin}${scope === 'project' ? '/p/boot/' : '/tasks'}?tasks=virtual`)
    const route = `[data-route="${scope === 'project' ? 'tasks' : 'global-tasks'}"]`
    const finished = `${route} [data-bucket="Finished"]`
    browser.waitForFunction(`document.querySelector('${finished} [data-run-id]') !== null && window.__cezIdle`)
    const preview = `${finished} [data-run-id] button[data-task-control="resources"]`
    if (change === 'preview') {
      // Pin this control so the same expanded row remains mounted above the viewport.
      browser.evaluate(`window.__collapsePreview=document.querySelector('${preview}');window.__collapsePreview.focus();window.__collapsePreview.click()`)
      browser.waitForFunction(`window.__collapsePreview.getAttribute('aria-expanded') === 'true' && window.__cezIdle`)
    }
    browser.evaluate(`(() => {const owner=document.querySelector('[data-slot="main"]'),group=document.querySelector('${route} [data-bucket="Working"]');owner.scrollTop+=group.getBoundingClientRect().top-owner.getBoundingClientRect().top+${scope === 'global' ? 12000 : 15000}})()`)
    const sample = `(() => {const owner=document.querySelector('[data-slot="main"]'),edge=owner.getBoundingClientRect().top;const row=[...document.querySelectorAll('${route} [data-bucket="Working"] [data-run-id]')].find(e=>e.getBoundingClientRect().bottom>edge&&e.getBoundingClientRect().top<edge+owner.clientHeight);return row?{id:row.dataset.runId,top:row.getBoundingClientRect().top}:null})()`
    const before = waitForSettledSample(browser, sample) as { id: string; top: number }
    browser.evaluate(startFrames(before.id))
    if (change !== 'preview') {
      if (change === 'storage') browser.evaluate(`localStorage.setItem('cez-task-list-folds',JSON.stringify({[JSON.stringify([${JSON.stringify(scope === 'global' ? 'global' : 'project:boot')},'active','Finished'])]:true}));window.dispatchEvent(new StorageEvent('storage',{key:'cez-task-list-folds'}))`)
      else browser.evaluate(`document.querySelector('${finished} [data-slot="status-group-toggle"]').click()`)
      browser.waitForFunction(`document.querySelector('${finished} [data-slot="status-group-toggle"]').getAttribute('aria-expanded') === 'false'`)
    } else {
      browser.evaluate('window.__collapsePreview.click()')
      browser.waitForFunction(`window.__collapsePreview.getAttribute('aria-expanded') === 'false'`)
    }
    const after = waitForSettledSample(browser, `(() => {const row=document.querySelector('${route} [data-run-id="${before.id}"]');return row?row.getBoundingClientRect().top:null})()`) as number
    expect(Math.abs(after - before.top)).toBeLessThanOrEqual(2)
    expectEveryFrame(browser, before.top)
  } finally { await large.stop() }
})

it.each(['project', 'global'] as const)('keeps %s query scroll when the anchor survives or leaves the filtered list', (scope) => {
  browser.setViewport(1440, 900)
  browser.goto(`${fixture.origin}${scope === 'project' ? '/p/boot/' : '/tasks'}?tasks=virtual`)
  const route = `[data-route="${scope === 'project' ? 'tasks' : 'global-tasks'}"]`
  browser.waitForFunction(`document.querySelector('${route} [data-run-id]') !== null && window.__cezIdle`)
  browser.evaluate(`document.querySelector('[data-slot="main"]').scrollTop=6500`)
  const sample = `(() => {const owner=document.querySelector('[data-slot="main"]'),edge=owner.getBoundingClientRect().top;const row=[...document.querySelectorAll('${route} [data-run-id]')].find(e=>e.getBoundingClientRect().bottom>edge&&e.getBoundingClientRect().top<edge+owner.clientHeight);return row?{id:row.dataset.runId,top:row.getBoundingClientRect().top,scroll:owner.scrollTop}:null})()`
  const before = waitForSettledSample(browser, sample) as { id: string; top: number; scroll: number }
  const query = (value: string) => browser.evaluate(`(()=>{const input=document.querySelector('${route} input[placeholder*="Search"]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,${JSON.stringify(value)});input.dispatchEvent(new Event('input',{bubbles:true}))})()`)
  query('Tab task')
  browser.waitForFunction(`new URLSearchParams(location.search).get('q') === 'Tab task' && window.__cezIdle`)
  const after = waitForSettledSample(browser, `(() => {const row=document.querySelector('${route} [data-run-id="${before.id}"]');return row?row.getBoundingClientRect().top:null})()`) as number
  expect(Math.abs(after - before.top)).toBeLessThanOrEqual(2)
  query('Tab task 149')
  browser.waitForFunction(`new URLSearchParams(location.search).get('q') === 'Tab task 149' && window.__cezIdle && document.querySelector('${route} [data-run-id="${before.id}"]') === null`)
  const removed = waitForSettledSample(browser, `(()=>{const owner=document.querySelector('[data-slot="main"]');return {scroll:owner.scrollTop,max:Math.max(0,owner.scrollHeight-owner.clientHeight)}})()`) as { scroll: number; max: number }
  expect(Math.abs(removed.scroll - Math.min(before.scroll, removed.max))).toBeLessThanOrEqual(2)
})

/** #795: actual cockpit + actual server repo response, held across the original prompt save.
 * Query receipt releases the held response, proving an unguarded read and a target wait differ.
 * It returns the actual DOM node/null; it never manufactures a branch or changes React's DOM. */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { AgentBrowser, browserSpawnPlan, readTestEnv } from '../agent-browser'
import { waitForConfig } from '../poll'
import { waitForSettingsControl } from '../settings-control'

const env = readTestEnv()
const session = `e2e-settings-mounted-${process.pid}`
const selector = '[data-slot="agents-base-branch"]'
const originalRead = `document.querySelector('[data-slot="agents-base-branch"]').options[1]?.value ?? ''`
const before = await (await fetch(`${env.baseUrl}/api/v1/config`, { headers: { connection: 'close' } })).json() as { systemPrompt: string | null }
const browser = AgentBrowser.open(session)

async function installBeforeNavigation(source: string): Promise<() => Promise<void>> {
  const plan = browserSpawnPlan(env.browser, session, ['get', 'cdp-url'])
  const result = JSON.parse(execFileSync(env.browser.command, plan.argv, { encoding: 'utf8', env: plan.env }))
  const socket = new WebSocket(result.data.cdpUrl)
  let sequence = 0
  const request = <T = unknown>(method: string, params: object, sessionId?: string): Promise<T> => new Promise((resolve, reject) => {
    const id = ++sequence
    const timeout = setTimeout(() => { socket.removeEventListener('message', receive); reject(new Error(`fixture CDP ${method} timed out`)) }, 5000)
    const receive = (event: MessageEvent) => {
      const response = JSON.parse(String(event.data))
      if (response.id !== id) return
      clearTimeout(timeout); socket.removeEventListener('message', receive)
      if (response.error) reject(new Error(JSON.stringify(response.error)))
      else resolve(response.result as T)
    }
    socket.addEventListener('message', receive)
    socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }))
  })
  try {
    await new Promise<void>((resolve, reject) => {
      socket.addEventListener('open', () => resolve(), { once: true })
      socket.addEventListener('error', () => reject(new Error('fixture CDP failed')), { once: true })
    })
    const { targetInfos } = await request<{ targetInfos: { type: string; url: string; targetId: string }[] }>('Target.getTargets', {})
    const target = targetInfos.find((entry: { type: string; url: string }) => entry.type === 'page' && entry.url === browser.url())
    assert.ok(target, 'owned browser page exists')
    const attached = await request<{ sessionId: string }>('Target.attachToTarget', { targetId: target.targetId, flatten: true })
    await request('Page.enable', {}, attached.sessionId)
    await request('Page.addScriptToEvaluateOnNewDocument', { source }, attached.sessionId)
    // CDP init scripts belong to this attachment; retain it through the actual navigation.
    return async () => {
      try { await request('Target.detachFromTarget', { sessionId: attached.sessionId }) }
      finally { socket.close() }
    }
  } catch (error) { socket.close(); throw error }
}

let detach = async () => {}
let proofFailed = false
let proofError: unknown
const cleanupFailures: Error[] = []
const attemptCleanup = async (label: string, action: () => unknown | Promise<unknown>) => {
  try { await action() }
  catch (error) { cleanupFailures.push(new Error(`Settings fixture cleanup: ${label} failed`, { cause: error })) }
}
try {
  const reset = await fetch(`${env.baseUrl}/api/v1/config`, { method: 'PUT', headers: { 'content-type': 'application/json', connection: 'close' }, body: JSON.stringify({ systemPrompt: null }) })
  assert.ok(reset.ok, 'fixture prompt setup succeeds')
  // A unique existing page avoids attaching to the browser's other blank startup target.
  browser.goto(`${env.baseUrl}/api/v1/health#${session}`)
  detach = await installBeforeNavigation(`(() => {
    const original = window.fetch.bind(window);
    window.__heldRepo = false; window.__repoReleased = false; window.__repoWaiters = [];
    window.fetch = async (...args) => {
      const response = await original(...args);
      const url = String(args[0]?.url ?? args[0]);
      if (url.endsWith('/repo')) {
        const repo = await response.clone().json();
        window.__realRepoInfo = Boolean(repo.info); window.__realBranchCount = repo.branches?.length;
        window.__heldRepo = true;
        await new Promise(resolve => window.__repoWaiters.push(resolve));
      }
      return response;
    };
  })()`)
  browser.setViewport(1440, 900)
  browser.goto(`${env.baseUrl}/settings/agents`)
  browser.waitForFunction(`document.querySelector('[data-slot="agents-section"]') !== null && window.__heldRepo === true`)
  assert.equal(browser.count(selector), 0, 'real form mounted while real repo response is held')
  assert.equal(browser.evaluate('window.__realRepoInfo'), true)
  assert.ok(Number(browser.evaluate('window.__realBranchCount')) > 0, 'actual server supplied real branches')
  browser.click('[data-slot="agents-system-prompt"]')
  browser.fill('[data-slot="agents-system-prompt"]', 'Always add tests. (e2e)')
  browser.waitForFunction(`document.querySelector('[data-action="agents-save-prompt"]')?.disabled === false`)
  browser.evaluate(`document.querySelector('[data-action="agents-save-prompt"]').click()`)
  await waitForConfig<{ systemPrompt: string | null }>(env.baseUrl, config => config.systemPrompt === 'Always add tests. (e2e)', 'original prompt persisted')
  browser.waitForFunction(`document.querySelector('[data-slot="toaster"]')?.textContent.includes('System prompt saved')`)
  assert.equal(browser.count(selector), 0, 'config-save invalidation did not invent cold repo data')
  browser.evaluate(`(() => {
    const nativeQuery = document.querySelector.bind(document);
    window.__branchQueries = [];
    document.querySelector = function(selector) {
      const element = nativeQuery(selector);
      if (selector === ${JSON.stringify(selector)}) {
        window.__branchQueries.push({ mounted: element !== null, at: performance.now() });
        if (!element && !window.__repoReleased) {
          // Controlled boundary: AFTER this real null is returned, allow the actual HTTP answer.
          window.__repoReleased = true;
          queueMicrotask(() => window.__repoWaiters.forEach(resolve => resolve()));
        }
      }
      return element;
    };
  })()`)
  let actionError: unknown
  let branch: string | undefined
  try {
    waitForSettingsControl(browser, selector)
    branch = String(browser.evaluate(originalRead))
    assert.notEqual(branch, '') // Original nonempty-branch assertion, not part of readiness.
  } catch (error) { actionError = error }
  console.log(JSON.stringify({ branch, actionError: actionError instanceof Error ? actionError.message : actionError,
    trace: browser.evaluate(`({ queries: window.__branchQueries, repoReleased: window.__repoReleased, mounted: document.querySelector(${JSON.stringify(selector)}) !== null })`) }, null, 2))
  if (actionError) throw actionError
  const setSelect = (value: string) => {
    waitForSettingsControl(browser, selector)
    browser.evaluate(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(el, ${JSON.stringify(value)});
      el.dispatchEvent(new Event('change', { bubbles: true }));
    })()`)
  }
  const previousBranch = (await (await fetch(`${env.baseUrl}/api/v1/config`, { headers: { connection: 'close' } })).json() as { baseBranch: string | null }).baseBranch
  try {
    setSelect(branch!)
    await waitForConfig<{ baseBranch: string | null }>(env.baseUrl, config => config.baseBranch === branch, 'original branch persisted')
    setSelect('')
    await waitForConfig<{ baseBranch: string | null }>(env.baseUrl, config => config.baseBranch === null, 'original branch cleared')
  } finally {
    await attemptCleanup('branch restoration', async () => {
      const restored = await fetch(`${env.baseUrl}/api/v1/config`, { method: 'PUT', headers: { 'content-type': 'application/json', connection: 'close' }, body: JSON.stringify({ baseBranch: previousBranch }) })
      assert.ok(restored.ok, 'fixture branch restoration succeeds')
    })
  }
} catch (error) {
  proofFailed = true
  proofError = error
} finally {
  await attemptCleanup('held response release', () => browser.evaluate(`window.__repoWaiters?.forEach(resolve => resolve())`))
  await attemptCleanup('prompt restoration', async () => {
    const restored = await fetch(`${env.baseUrl}/api/v1/config`, { method: 'PUT', headers: { 'content-type': 'application/json', connection: 'close' }, body: JSON.stringify({ systemPrompt: before.systemPrompt }) })
    assert.ok(restored.ok, 'fixture prompt restoration succeeds')
  })
  await attemptCleanup('CDP detach', detach)
  await attemptCleanup('browser close', () => browser.close())
  if (cleanupFailures.length) {
    throw new AggregateError(
      proofFailed ? [proofError, ...cleanupFailures] : cleanupFailures,
      proofFailed ? 'Settings fixture proof and cleanup failed' : 'Settings fixture cleanup failed',
      proofFailed ? { cause: proofError } : undefined,
    )
  }
  if (proofFailed) throw proofError
}

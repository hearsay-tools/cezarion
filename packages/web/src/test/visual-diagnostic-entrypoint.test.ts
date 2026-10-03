// @vitest-environment node
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runInNewContext } from 'node:vm'
import { afterEach, expect, it, vi } from 'vitest'
import { AgentBrowser, WaitForValueError, configureFailureCapture } from '../../e2e/agent-browser'
import { settleVisual, waitForSettledSample } from '../../e2e/visual-ready'

const cleanups: Array<() => void> = []
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup()
  configureFailureCapture({ root: undefined, spec: undefined, test: undefined })
  vi.restoreAllMocks(); vi.unstubAllEnvs()
})

// Real existing entrypoints + wait + generated eval + failure capture. Only the
// external command and monotonic clock are controlled; no new production API.
function failedVisual(source: 'fonts' | 'native' | 'raw-null', entrypoint: 'visual' | 'measurement') {
  const root = mkdtempSync(join(tmpdir(), 'cez-visual-wire-'))
  configureFailureCapture({ root, spec: 'wire', test: source })
  vi.stubEnv('AGENT_BROWSER_DEFAULT_TIMEOUT', '25000')
  const browser = AgentBrowser.attach({ installed: true, command: '/never-launch', version: 'unit', notes: '' }, 'wire')
  let now = 0, capture = false, evals = 0, fonts = 0, native = 0
  const calls: Array<{ action: string; budget: number | undefined }> = []
  const page = {
    document: { documentElement: {}, querySelector: () => ({ checkVisibility: () => { native++; return false } }),
      get fonts() { fonts++; return { status: source === 'fonts' ? 'loading' : 'loaded' } },
      readyState: 'complete', visibilityState: 'visible' },
    location: { pathname: '/owned' }, performance: { timeOrigin: 123, now: () => 4 },
  }
  vi.spyOn(performance, 'now').mockImplementation(() => now)
  vi.spyOn(browser as unknown as { run(args: string[], budget?: number): Record<string, unknown> }, 'run').mockImplementation((args, budget) => {
    if (args[0] === 'close') return {}
    if (args[0] === 'eval' && !capture) {
      evals++; now = 25000
      const value = source === 'raw-null' ? null : runInNewContext(args[1]!, page)
      return JSON.parse(JSON.stringify({ result: value }))
    }
    calls.push({ action: args[0]!, budget })
    if (args[0] === 'screenshot') { capture = true; writeFileSync(args[1]!, 'PNG'); return {} }
    if (args[0] === 'snapshot') return { snapshot: 'owned' }
    return { result: {} }
  })
  cleanups.push(() => { browser.close(); rmSync(root, { recursive: true, force: true }) })
  let error: unknown
  try { entrypoint === 'visual' ? settleVisual(browser, 'body') : waitForSettledSample(browser, 'false') }
  catch (caught) { error = caught }
  expect(error).toBeInstanceOf(WaitForValueError)
  const failure = error as WaitForValueError
  expect(failure.lastValue).toBeNull()
  expect(failure.cause).toBeUndefined()
  expect(evals).toBe(1)
  expect(calls).toEqual([{ action: 'screenshot', budget: 5000 }, { action: 'snapshot', budget: 5000 }, { action: 'eval', budget: 5000 }])
  expect(fonts).toBe(source === 'raw-null' ? 0 : 1)
  expect(native).toBe(source === 'native' ? 1 : 0)
  return JSON.parse(readFileSync(join(failure.bundle, 'probe.json'), 'utf8'))
}

it.each(['visual', 'measurement'] as const)('%s entrypoint records the actual generated font rejection', entrypoint => {
  const bundle = failedVisual('fonts', entrypoint)
  expect(JSON.stringify(bundle)).toContain('"reason":"fonts"')
  expect(bundle.poll.visual.latest).toMatchObject({ qualification: 'qualified', attempt: 1, reason: 'fonts', fontStatus: 'loading',
    document: { kind: 'session-timeOrigin-path', session: 'wire', timeOrigin: 123, path: '/owned' } })
})
it('records the generated native rejection instead of inferring a font cause from null', () => {
  const bundle = failedVisual('native', 'visual')
  expect(JSON.stringify(bundle)).toContain('"reason":"native"')
  expect(bundle.poll.visual.latest).toMatchObject({ qualification: 'qualified', reason: 'native', fontStatus: 'loaded' })
})
it('keeps raw provider null explicitly unqualified through the original helper', () => {
  const bundle = failedVisual('raw-null', 'measurement')
  expect(JSON.stringify(bundle)).toContain('unqualified-provider-null')
  expect(bundle.poll.visual.latest).toEqual({ qualification: 'unqualified-provider-null', attempt: 1, resultPropertyPresent: true })
  expect(bundle.poll.visual.latestQualified).toBeNull()
})

// @vitest-environment node
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AgentBrowser, WaitForValueError, configureFailureCapture } from '../../e2e/agent-browser'
import { waitForSettledSample } from '../../e2e/visual-ready'

// Exercise the real wait/hold/capture code with only its external command seam
// and monotonic scheduling controlled. No browser or wall-clock jitter.
type Probe = { at: number; value?: unknown; error?: Error }
const disposals: Array<() => void> = []
function controlled(probes: Probe[], label: string) {
  const root = mkdtempSync(join(tmpdir(), 'cez-deadline-proof-'))
  configureFailureCapture({ root, spec: 'deadline-proof', test: label })
  vi.stubEnv('AGENT_BROWSER_DEFAULT_TIMEOUT', '25000')
  const browser = AgentBrowser.attach({ installed: true, command: '/never-launch-a-browser', version: 'scripted-seam', notes: '' }, label)
  let now = 0, count = 0, capturing = false
  const captureCalls: Array<{ action: string; budget: number | undefined }> = []
  const probeBudgets: number[] = []
  const sleeps: number[] = []
  vi.spyOn(performance, 'now').mockImplementation(() => now)
  vi.spyOn(Atomics, 'wait').mockImplementation((_array, _index, _value, timeout) => { sleeps.push(timeout ?? 0); now += timeout ?? 0; return 'timed-out' })
  vi.spyOn(browser as unknown as { run(args: string[], timeoutMs?: number): Record<string, unknown> }, 'run')
    .mockImplementation((args, timeoutMs) => {
      if (args[0] === 'close') return {}
      if (args[0] === 'eval' && !capturing) {
        const next = probes[count++]
        if (!next) throw new Error('unexpected extra sample')
        probeBudgets.push(timeoutMs!)
        if (next.at < now) throw new Error('fixture monotonic time went backwards')
        now = next.at
        if (next.error) throw next.error
        return { result: next.value }
      }
      captureCalls.push({ action: args[0]!, budget: timeoutMs })
      if (args[0] === 'screenshot') { capturing = true; writeFileSync(args[1]!, 'controlled screenshot'); return {} }
      if (args[0] === 'snapshot') return { snapshot: 'controlled snapshot' }
      if (args[0] === 'eval') return { result: { url: 'http://owned.invalid/fixture', readyState: 'complete' } }
      throw new Error('unexpected capture command')
    })
  disposals.push(() => { browser.close(); rmSync(root, { recursive: true, force: true }) })
  return { browser, captureCalls, probeBudgets, sleeps, count: () => count, now: () => now }
}
function failed(state: ReturnType<typeof controlled>, options: { intervalMs?: number; matcher?: (value: unknown) => boolean } = {}) {
  let error: unknown
  try { state.browser.waitForStable('fixtureExpression()', { holdMs: 200, intervalMs: 0, ...options }) }
  catch (cause) { error = cause }
  expect(error).toBeInstanceOf(WaitForValueError)
  const failure = error as WaitForValueError
  const bundle = JSON.parse(readFileSync(join(failure.bundle, 'probe.json'), 'utf8'))
  return { failure, bundle }
}
afterEach(() => {
  for (const dispose of disposals.splice(0)) dispose()
  configureFailureCapture({ root: undefined, spec: undefined, test: undefined })
  vi.restoreAllMocks(); vi.unstubAllEnvs()
})

describe('poll failure diagnostics (#795)', () => {
  it('retains the terminal transport error after an earlier completed null', () => {
    const state = controlled([{ at: 100, value: null }, { at: 25001, error: new Error('terminal transport ETIMEDOUT') }], 'null then timeout')
    const { failure, bundle } = failed(state)
    expect(failure.lastValue).toBeNull() // existing focus/error callers retain their last observed value
    expect(state.probeBudgets).toEqual([25000, 24900])
    expect(state.count()).toBe(2)
    // The prior null remains useful to callers, while the terminal error is separate evidence.
    expect(JSON.stringify(bundle)).toContain('terminal transport ETIMEDOUT')
    expect(failure.cause).toBeUndefined()
    expect(bundle.lastError).toBeUndefined()
    expect(bundle.error).toBe('Error: last value: null')
    expect(bundle.poll).toEqual({
      timeoutMs: 25000, holdMs: 200, elapsedMs: 25001,
      attempts: 2, completedSamples: 1, nullSamples: 1, commandErrors: 1, lateReturns: 0, matcherErrors: 0,
      lastSample: { attempt: 1, completedAtMs: 100 },
      terminalProbe: { attempt: 2, startMs: 100, endMs: 25001, durationMs: 24901, budgetMs: 24900,
        outcome: 'threw', browserCompletion: 'unknown', error: 'Error: terminal transport ETIMEDOUT' },
    })
  })
  it('records a late returned match while still rejecting it and retaining the previous null', () => {
    const state = controlled([{ at: 100, value: null }, { at: 25001, value: 'late-but-matching' }], 'null then late success')
    const matcher = vi.fn(value => value !== null)
    const { failure, bundle } = failed(state, { matcher })
    expect(failure.lastValue).toBeNull()
    expect(state.count()).toBe(2)
    expect(JSON.stringify(bundle)).toContain('late-but-matching')
    expect(matcher.mock.calls).toEqual([[null], [null]]) // never match or hold the late return
    expect(bundle.poll).toEqual({
      timeoutMs: 25000, holdMs: 200, elapsedMs: 25001,
      attempts: 2, completedSamples: 1, nullSamples: 1, commandErrors: 0, lateReturns: 1, matcherErrors: 0,
      lastSample: { attempt: 1, completedAtMs: 100 },
      terminalProbe: { attempt: 2, startMs: 100, endMs: 25001, durationMs: 24901, budgetMs: 24900,
        outcome: 'returned-after-deadline', browserCompletion: 'returned',
        result: { type: 'string', present: true, summary: '"late-but-matching"' } },
    })
  })
  it('retains the earlier page error and the final transport error as separate evidence', () => {
    const state = controlled([{ at: 100, error: new Error('page evaluation exception') }, { at: 25001, error: new Error('terminal transport ETIMEDOUT') }], 'page error then timeout')
    const { failure, bundle } = failed(state)
    expect(JSON.stringify(bundle)).toContain('page evaluation exception')
    expect(JSON.stringify(bundle)).toContain('terminal transport ETIMEDOUT')
    expect((failure.cause as Error).message).toBe('page evaluation exception')
    expect(bundle.poll).toMatchObject({ attempts: 2, completedSamples: 0, nullSamples: 0, commandErrors: 2,
      lateReturns: 0, lastSample: null, terminalProbe: { outcome: 'threw', browserCompletion: 'unknown' } })
  })
  it('records a matcher exception without falsely reporting a failed browser command', () => {
    const state = controlled([{ at: 25000, value: 'ready' }], 'matcher throws')
    const { failure, bundle } = failed(state, { matcher: () => { throw new Error('matcher exception') } })
    expect(failure.lastValue).toBe('ready')
    expect(bundle.poll).toMatchObject({ attempts: 1, completedSamples: 1, commandErrors: 0, matcherErrors: 1,
      lastSample: { attempt: 1, completedAtMs: 25000 },
      terminalProbe: { outcome: 'returned', browserCompletion: 'returned', matcherError: 'Error: matcher exception' } })
  })
  it('preserves undefined result presence without confusing it with a returned null', () => {
    const state = controlled([{ at: 25000, value: undefined }], 'undefined result')
    const { failure, bundle } = failed(state)
    expect(failure.lastValue).toBeUndefined()
    expect(bundle.poll).toMatchObject({ completedSamples: 1, nullSamples: 0,
      terminalProbe: { outcome: 'returned', result: { type: 'undefined', present: false, summary: 'undefined' } } })
  })
  it('bounds late value summaries without discarding their type or presence', () => {
    const state = controlled([{ at: 100, value: null }, { at: 25001, value: { text: 'x'.repeat(10000) } }], 'large late result')
    const { failure, bundle } = failed(state)
    expect(failure.lastValue).toBeNull()
    expect(bundle.poll.terminalProbe.result).toMatchObject({ type: 'object', present: true })
    expect(bundle.poll.terminalProbe.result.summary.length).toBeLessThanOrEqual(401)
    expect(bundle.poll.terminalProbe).not.toHaveProperty('value')
  })
  it('counts repeated eligible null samples separately from command failures', () => {
    const state = controlled([{ at: 100, value: null }, { at: 10000, value: null }, { at: 20000, value: null }, { at: 25000, value: null }], 'null sample counts')
    const { bundle } = failed(state)
    expect(bundle.poll).toEqual({
      timeoutMs: 25000, holdMs: 200, elapsedMs: 25000,
      attempts: 4, completedSamples: 4, nullSamples: 4, commandErrors: 0, lateReturns: 0, matcherErrors: 0,
      lastSample: { attempt: 4, completedAtMs: 25000 },
      terminalProbe: { attempt: 4, startMs: 20000, endMs: 25000, durationMs: 5000, budgetMs: 5000,
        outcome: 'returned', browserCompletion: 'returned', result: { type: 'null', present: true, summary: 'null' } },
    })
  })
  it('does not let unreadable terminal error metadata mask the original failure', () => {
    const error = new Error('unreadable')
    Object.defineProperty(error, 'message', { get: () => { throw new Error('metadata getter') } })
    const state = controlled([{ at: 100, value: null }, { at: 25001, error }], 'unreadable error metadata')
    const { failure, bundle } = failed(state)
    expect(failure.lastValue).toBeNull()
    expect(failure.cause).toBeUndefined()
    expect(bundle.poll.terminalProbe.error).toBe('<unreadable error>')
    expect(state.captureCalls.map(call => call.action)).toEqual(['screenshot', 'snapshot', 'eval'])
  })
  it('bounds each error cause while retaining the terminal code and excluding raw output', () => {
    const cause = Object.assign(new Error('transport failed'), { code: 'ETIMEDOUT', signal: 'SIGTERM', stdout: 'RAW-STDOUT', stderr: 'RAW-STDERR' })
    const error = new Error('command ' + 'x'.repeat(10000), { cause })
    const state = controlled([{ at: 100, value: null }, { at: 25001, error }], 'large command error')
    const { bundle } = failed(state)
    const detail = bundle.poll.terminalProbe.error
    expect(detail.length).toBeLessThanOrEqual(2000)
    expect(detail).toContain('ETIMEDOUT')
    expect(detail).toContain('SIGTERM')
    expect(detail).toContain('transport failed')
    expect(detail).not.toContain('RAW-STDOUT')
    expect(detail).not.toContain('RAW-STDERR')
  })
})

describe('poll behavior and capture guarantees', () => {
  it('rejects completed nulls throughout the original deadline and captures once with bounded calls', () => {
    const state = controlled([{ at: 100, value: null }, { at: 10000, value: null }, { at: 20000, value: null }, { at: 25000, value: null }], 'repeated completed null')
    const { failure, bundle } = failed(state)
    expect(failure.lastValue).toBeNull()
    expect(bundle.lastError).toBeUndefined()
    expect(state.now()).toBe(25000)
    expect(state.count()).toBe(4)
    expect(state.captureCalls).toEqual([{ action: 'screenshot', budget: 5000 }, { action: 'snapshot', budget: 5000 }, { action: 'eval', budget: 5000 }])
    expect(readFileSync(join(failure.bundle, 'screenshot.png'), 'utf8')).toBe('controlled screenshot')
    expect(readFileSync(join(failure.bundle, 'snapshot.txt'), 'utf8')).toBe('controlled snapshot')
    expect(bundle.page.readyState).toBe('complete')
    expect(state.browser.captureTestFailure([failure])).toBeNull()
    expect(state.count()).toBe(4) // capture never re-executes the original measurement
  })
  it('preserves the interval clamp and remaining budget even at the deadline boundary', () => {
    const state = controlled([{ at: 24950, value: null }, { at: 25001, error: new Error('deadline boundary') }], 'interval clamp')
    const { bundle } = failed(state, { intervalMs: 100 })
    expect(state.sleeps).toEqual([50])
    expect(state.probeBudgets).toEqual([25000, 0])
    expect(bundle.lastValue).toBeNull()
  })
  it('recovers from a page exception but starts its hold at the completed good sample', () => {
    const state = controlled([{ at: 100, error: new Error('temporary page exception') }, { at: 200, value: 'ready' }, { at: 300, value: 'ready' }, { at: 400, value: 'ready' }], 'page recovery')
    expect(state.browser.waitForStable('fixtureExpression()', { holdMs: 200, intervalMs: 0 })).toBe('ready')
    expect(state.count()).toBe(4)
    expect(state.now()).toBe(400)
    expect(state.captureCalls).toEqual([])
  })
  it.each([false, 0])('returns valid held measurement %s without accepting a readiness null', value => {
    const sample = { layout: { boxes: [[0, 0, 20, 44]] }, focus: 0, value }
    const state = controlled([{ at: 100, value: null }, { at: 300, value: sample }, { at: 400, value: sample }, { at: 500, value: sample }], 'valid measurement')
    expect(waitForSettledSample(state.browser, 'fixtureMeasurement()')).toBe(value)
    expect(state.count()).toBe(4)
    expect(state.now()).toBe(500)
  })
  it.each([
    { name: 'earlier transport latency is not hold time', probes: [{ at: 300, value: 'ready' }, { at: 310, value: 'ready' }, { at: 410, value: 'ready' }, { at: 510, value: 'ready' }], count: 4, end: 510 },
    { name: 'changed value resets hold', probes: [{ at: 100, value: 'old' }, { at: 200, value: 'ready' }, { at: 300, value: 'ready' }, { at: 400, value: 'ready' }], count: 4, end: 400 },
    { name: 'null resets hold', probes: [{ at: 100, value: 'ready' }, { at: 200, value: null }, { at: 300, value: 'ready' }, { at: 400, value: 'ready' }, { at: 500, value: 'ready' }], count: 5, end: 500 },
    { name: 'error resets hold', probes: [{ at: 100, value: 'ready' }, { at: 200, error: new Error('temporary') }, { at: 300, value: 'ready' }, { at: 400, value: 'ready' }, { at: 500, value: 'ready' }], count: 5, end: 500 },
  ])('$name', scenario => {
    const state = controlled(scenario.probes, scenario.name)
    expect(state.browser.waitForStable('fixtureExpression()', { holdMs: 200, intervalMs: 0 })).toBe('ready')
    expect(state.count()).toBe(scenario.count)
    expect(state.now()).toBe(scenario.end)
  })
})

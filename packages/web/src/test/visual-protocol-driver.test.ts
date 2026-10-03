// @vitest-environment node
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { AgentBrowser, WaitForValueError, configureFailureCapture } from '../../e2e/agent-browser'
import { settleVisual, waitForSettledSample } from '../../e2e/visual-ready'
import { decodeVisualSample, VisualProtocolError, type VisualProgram } from '../../e2e/visual-sample-protocol'
import { scriptedVisualResult } from './helpers/visual-wire-fixture'

const cleanups: Array<() => void> = []
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup()
  configureFailureCapture({ root: undefined, spec: undefined, test: undefined })
  vi.restoreAllMocks(); vi.unstubAllEnvs()
})
// Capture the descriptor from the actual helper; neither enrollment nor its
// expression is synthesized by this fixture. Wire values are explicitly scripted.
function program(): VisualProgram {
  let result!: VisualProgram
  settleVisual({ waitForStable: (_js: string, options: { visualDiagnostic: VisualProgram }) => { result = options.visualDiagnostic } } as unknown as AgentBrowser, 'body')
  return result
}
type Step = { at: number; value?: unknown; error?: Error; response?: (expression: string, advance: (time: number) => void) => Record<string, unknown> }
function controlled(steps: Step[]) {
  const root = mkdtempSync(join(tmpdir(), 'cez-protocol-driver-'))
  configureFailureCapture({ root, spec: 'protocol-driver', test: 'controlled' })
  vi.stubEnv('AGENT_BROWSER_DEFAULT_TIMEOUT', '25000')
  const browser = AgentBrowser.attach({ installed: true, command: '/never-launch', version: 'scripted-seam', notes: '' }, 'protocol')
  let now = 0, index = 0, capturing = false
  const probes: Array<{ expression: string; budget: number | undefined }> = [], captures: Array<[string, number | undefined]> = [], sleeps: number[] = []
  vi.spyOn(performance, 'now').mockImplementation(() => now)
  vi.spyOn(Atomics, 'wait').mockImplementation((_a, _i, _v, ms) => { sleeps.push(ms!); now += ms!; return 'timed-out' })
  vi.spyOn(browser as unknown as { run(args: string[], budget?: number): Record<string, unknown> }, 'run').mockImplementation((args, budget) => {
    if (args[0] === 'close') return {}
    if (args[0] === 'eval' && !capturing) {
      probes.push({ expression: args[1]!, budget })
      const step = steps[index++]
      if (!step) { now = 25001; throw new Error('unexpected extra sample') }
      if (step.at < now) throw new Error('fixture clock went backwards')
      now = step.at
      if (step.error) throw step.error
      return step.response ? step.response(args[1]!, time => { now = time }) : { result: scriptedVisualResult(args[1]!, step.value) }
    }
    captures.push([args[0]!, budget])
    if (args[0] === 'screenshot') { capturing = true; writeFileSync(args[1]!, 'PNG'); return {} }
    return args[0] === 'snapshot' ? { snapshot: 'scripted' } : { result: {} }
  })
  cleanups.push(() => { browser.close(); rmSync(root, { recursive: true, force: true }) })
  return { browser, probes, captures, sleeps, advance: (time: number) => { now = time } }
}
function failed(state: ReturnType<typeof controlled>, options: { matcher?: (value: unknown) => boolean; visualDiagnostic?: VisualProgram; holdMs?: number; intervalMs?: number } = {}) {
  let caught: unknown
  try { state.browser.waitForStable('legacyExpression()', { holdMs: 200, intervalMs: 0, visualDiagnostic: program(), ...options }) } catch (error) { caught = error }
  expect(caught).toBeInstanceOf(WaitForValueError)
  const error = caught as WaitForValueError
  const bundle = JSON.parse(readFileSync(join(error.bundle, 'probe.json'), 'utf8'))
  expect(state.captures).toEqual([['screenshot', 5000], ['snapshot', 5000], ['eval', 5000]])
  expect(state.browser.captureTestFailure([error])).toBeNull()
  return { error, bundle }
}
function wire(expression: string, value: unknown) {
  return scriptedVisualResult(expression, value) as Record<string, any>
}

it.each([
  ['protocol', (v: any) => { v.protocol = 'other' }],
  ['version', (v: any) => { v.version = 2 }],
  ['token', (v: any) => { v.token += 'stale' }],
  ['attempt', (v: any) => { v.attempt++ }],
  ['kind', (v: any) => { v.kind = 'settled' }],
  ['extra field', (v: any) => { v.unbounded = 'no' }],
  ['missing field', (v: any) => { delete v.evidence }],
  ['presence', (v: any) => { v.public.present = false }],
  ['missing public value', (v: any) => { delete v.public.value }],
  ['unknown reason', (v: any) => { v.evidence.reason = 'invented' }],
  ['phase', (v: any) => { v.evidence.phase = 'measurement' }],
  ['font short circuit', (v: any) => { v.evidence.reason = 'missing-target' }],
  ['unobserved font field', (v: any) => { v.evidence.fontObserved = false }],
  ['oversized font status', (v: any) => { v.evidence.fontStatus = 'x'.repeat(65) }],
  ['nonfinite identity', (v: any) => { v.evidence.document.timeOrigin = Infinity }],
  ['oversized path', (v: any) => { v.evidence.document.path = '/'.repeat(513) }],
  ['negative clock', (v: any) => { v.evidence.document.observedAt = -1 }],
  ['unknown document field', (v: any) => { v.evidence.document.extra = true }],
] as const)('fails closed for %s after a returned command, before matching', (_name, corrupt) => {
  const state = controlled([{ at: 25000, response: expression => { const value = wire(expression, null); corrupt(value); return { result: value } } }])
  const matcher = vi.fn(() => true)
  const { error, bundle } = failed(state, { matcher, holdMs: 0 })
  expect(error.cause).toBeInstanceOf(VisualProtocolError)
  expect(error.lastValue).toBeUndefined()
  expect(matcher).not.toHaveBeenCalled()
  expect(state.probes).toHaveLength(1)
  expect(bundle.poll).toMatchObject({ completedSamples: 0, commandErrors: 0, decoderErrors: 1, matcherErrors: 0,
    terminalProbe: { outcome: 'returned', browserCompletion: 'returned', decoderError: expect.stringContaining('VisualProtocolError') },
    visual: { latest: { qualification: 'protocol-error', attempt: 1 }, firstQualified: null, latestQualified: null, reasons: {} } })
  expect(bundle.poll.terminalProbe).not.toHaveProperty('result')
})
it.each([false, 0, 'bare', [], { value: false }])('never accepts a bare structured/primitive opted-in result: %j', value => {
  const state = controlled([{ at: 25000, response: () => ({ result: value }) }])
  const { bundle } = failed(state)
  expect(bundle.poll.decoderErrors).toBe(1)
})
it.each([
  [{ result: null }, 'unqualified-provider-null', true, null],
  [{}, 'missing-provider-result', false, undefined],
  [{ result: undefined }, 'missing-provider-result', true, undefined],
] as const)('current raw or missing result cannot inherit qualified evidence: %j', (response, qualification, present, value) => {
  const state = controlled([{ at: 100, value: null }, { at: 25000, response: () => response }])
  const { error, bundle } = failed(state)
  expect(error.lastValue).toBe(value)
  expect(bundle.poll.visual.latest).toEqual({ qualification, attempt: 2, resultPropertyPresent: present })
  expect(bundle.poll.visual.firstQualified).toMatchObject({ attempt: 1, reason: 'fonts' })
  expect(bundle.poll.visual.latestQualified).toEqual(bundle.poll.visual.firstQualified)
  expect(bundle.poll.visual.reasons).toEqual({ fonts: 1 })
  expect(bundle.poll.decoderErrors).toBe(0)
})
it('separates explicit wire undefined presence from null without touching the payload', () => {
  const descriptor = program()
  if (descriptor.mode !== 'envelope') throw new Error('expected diagnostic program')
  for (const value of [null, undefined, false, 0, { then: 'opaque' }]) {
    const result = decodeVisualSample(wire(descriptor.build('token', 1), value), true, { token: 'token', attempt: 1, kind: 'visual', session: 'owned' })
    expect(result.value).toBe(value)
    expect(result.observation.qualification).toBe('qualified')
  }
})
it('keeps bounded first/latest evidence and counts while metadata identity changes do not reset the hold', () => {
  const stable = { layout: { boxes: [1] }, focus: 0, value: false }
  const state = controlled([100, 200, 300].map(at => ({ at, response: (expression: string) => {
    const value = wire(expression, stable)
    value.evidence.document.timeOrigin = at; value.evidence.document.path = `/page-${at}`
    return { result: value }
  } })))
  expect(waitForSettledSample(state.browser, 'false')).toBe(false)
  expect(state.probes).toHaveLength(3)
  expect(state.captures).toEqual([])
  expect(state.probes.map(p => p.budget)).toEqual([25000, 24800, 24700])
})
it('counts qualified reasons without retaining every sample', () => {
  const state = controlled([100, 200, 25000].map(at => ({ at, value: null })))
  const { bundle } = failed(state)
  expect(bundle.poll.visual.reasons).toEqual({ fonts: 3 })
  expect(bundle.poll.visual.firstQualified.attempt).toBe(1)
  expect(bundle.poll.visual.latestQualified.attempt).toBe(3)
  expect(Object.keys(bundle.poll.visual).sort()).toEqual(['firstQualified', 'kind', 'latest', 'latestQualified', 'reasons', 'token'])
})
it('keeps original null and failure selection after terminal command failure', () => {
  const state = controlled([{ at: 100, value: null }, { at: 25001, error: new Error('transport timeout') }])
  const { error, bundle } = failed(state)
  expect(error.lastValue).toBeNull(); expect(error.cause).toBeUndefined()
  expect(bundle.poll.visual.latest).toEqual({ qualification: 'command-error', attempt: 2 })
  expect(bundle.poll.visual.latestQualified.attempt).toBe(1)
  expect(bundle.poll.terminalProbe).toMatchObject({ browserCompletion: 'unknown', error: 'Error: transport timeout' })
})
it('keeps decoder failure distinct from command and matcher errors after a prior null', () => {
  const state = controlled([{ at: 100, value: null }, { at: 25001, response: () => ({ result: { token: 'bad' } }) }])
  const { error, bundle } = failed(state)
  expect(error.lastValue).toBeNull(); expect(error.cause).toBeUndefined()
  expect(bundle.poll).toMatchObject({ completedSamples: 1, commandErrors: 0, decoderErrors: 1, matcherErrors: 0, lateReturns: 1,
    terminalProbe: { outcome: 'returned-after-deadline', browserCompletion: 'returned' } })
})
it('recovers from a page error using only public samples and original hold', () => {
  const state = controlled([{ at: 100, error: new Error('page error') }, { at: 200, value: 0 }, { at: 400, value: 0 }])
  expect(state.browser.waitForStable('original', { holdMs: 200, intervalMs: 0, visualDiagnostic: program(), matcher: value => value === 0 })).toBe(0)
  expect(state.probes).toHaveLength(3); expect(state.captures).toEqual([])
})
it('classifies matcher exceptions after decoding without transport or decoder errors', () => {
  const state = controlled([{ at: 25000, value: 0 }])
  const { error, bundle } = failed(state, { matcher: () => { throw new Error('match') } })
  expect(error.lastValue).toBe(0)
  expect(bundle.poll).toMatchObject({ commandErrors: 0, decoderErrors: 0, matcherErrors: 1, terminalProbe: { matcherError: 'Error: match' } })
})
it('decodes late evidence but never calls a matcher or replaces the previous eligible value', () => {
  const state = controlled([{ at: 100, value: null }, { at: 25001, value: 0 }])
  const matcher = vi.fn(value => value === 0)
  const { error, bundle } = failed(state, { matcher })
  expect(error.lastValue).toBeNull(); expect(matcher.mock.calls).toEqual([[null], [null]])
  expect(bundle.poll.visual.latestQualified).toMatchObject({ attempt: 2, reason: 'visual-ready' })
  expect(bundle.poll).toMatchObject({ completedSamples: 1, lateReturns: 1, lastSample: { attempt: 1, completedAtMs: 100 } })
})
it('charges expression construction to the original remaining command budget', () => {
  const state = controlled([{ at: 25000, value: null }])
  const descriptor = program()
  if (descriptor.mode !== 'envelope') throw new Error('expected diagnostic program')
  const { bundle } = failed(state, { visualDiagnostic: { ...descriptor, build: (token, attempt) => { state.advance(75); return descriptor.build(token, attempt) } } })
  expect(state.probes[0]!.budget).toBe(24925)
  expect(bundle.poll.terminalProbe).toMatchObject({ startMs: 75, endMs: 25000, budgetMs: 24925 })
})
it('discards a timely command if decoding consumes the remaining deadline', () => {
  const state = controlled([{ at: 100, value: null }, { at: 24999, response: (expression, advance) => {
    const value = wire(expression, 0)
    // Scripted seam models decoder work; native JSON objects have no getters.
    Object.defineProperty(value.evidence.document, 'observedAt', { enumerable: true, get: () => { advance(25001); return 100 } })
    return { result: value }
  } }])
  const matcher = vi.fn(value => value === 0)
  const { error, bundle } = failed(state, { holdMs: 0, matcher })
  expect(error.lastValue).toBeNull(); expect(matcher.mock.calls).toEqual([[null], [null]])
  expect(bundle.poll).toMatchObject({ completedSamples: 1, lateReturns: 0,
    terminalProbe: { outcome: 'returned', endMs: 24999, browserCompletion: 'returned', decoderExceededDeadline: true } })
})
it('leaves unmarked protocol-looking values and expression strings completely arbitrary', () => {
  const value = { protocol: 'cez.visual', version: 999, public: { present: true, value: false } }
  const state = controlled([{ at: 100, response: () => ({ result: value }) }])
  const expression = '/*cez-visual:not-a-real-header*/ Promise.resolve({value: false})'
  expect(state.browser.waitForStable(expression, { holdMs: 0 })).toBe(value)
  expect(state.probes).toEqual([{ expression, budget: 25000 }])
  expect(state.captures).toEqual([])
})
it('keeps excluded dynamic expressions on the legacy path with explicit fallback evidence', () => {
  const state = controlled([{ at: 25000, value: null }])
  let caught: unknown
  try { waitForSettledSample(state.browser, 'eval("false")') } catch (error) { caught = error }
  expect(caught).toBeInstanceOf(WaitForValueError)
  expect(state.probes[0]!.expression.startsWith('/*cez-visual:')).toBe(false)
  const bundle = JSON.parse(readFileSync(join((caught as WaitForValueError).bundle, 'probe.json'), 'utf8'))
  expect(bundle.poll.visual).toMatchObject({ fallback: 'dynamic-or-introspective-source', latest: { qualification: 'legacy-fallback', attempt: 1 }, firstQualified: null })
})

it.each(['/*cez-visual:', '/*cez-visual:broken*/', '/*cez-visual:{"version":1,"token":"","attempt":1,"kind":"visual"}*/'])('rejects malformed scripted fixture correlation instead of inventing a token: %s', expression => {
  expect(() => scriptedVisualResult(expression, false)).toThrow('malformed scripted visual header')
})

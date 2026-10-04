// @vitest-environment node
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runInNewContext } from 'node:vm'
import { afterEach, expect, it, vi } from 'vitest'
import { AgentBrowser, WaitForValueError, configureFailureCapture } from '../../e2e/agent-browser'
import { waitForSettledSample } from '../../e2e/visual-ready'
import { decodeVisualSample, VisualProtocolError, type VisualProgram } from '../../e2e/visual-sample-protocol'

const disposals: Array<() => void> = []
afterEach(() => {
  for (const dispose of disposals.splice(0)) dispose()
  configureFailureCapture({ root: undefined, spec: undefined, test: undefined })
  vi.restoreAllMocks(); vi.unstubAllEnvs()
})
// Native ECMAScript JSON at a controlled Node command seam; no browser or
// naturally observed provider corruption. Actual helper/generator/driver used.
function exercise(expression: string, options: { legacy?: boolean; mutate?: 'null' | 'undefined'; measurements?: unknown[] } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'cez-measurement-wire-'))
  configureFailureCapture({ root, spec: 'measurement-wire', test: expression })
  vi.stubEnv('AGENT_BROWSER_DEFAULT_TIMEOUT', '25000')
  const browser = AgentBrowser.attach({ installed: true, command: '/never-launch', version: 'scripted JSON seam', notes: '' }, 'measurement-wire')
  let now = 0, probes = 0, capturing = false
  const captures: Array<[string, number | undefined]> = [], wires: unknown[] = [], measurementReads: number[] = [], serializationCalls: number[] = []
  const matcher = vi.fn(() => true)
  vi.spyOn(performance, 'now').mockImplementation(() => now)
  vi.spyOn(Atomics, 'wait').mockImplementation((_a, _i, _v, ms) => { now += ms!; return 'timed-out' })
  if (options.legacy) {
    const original = browser.waitForStable.bind(browser)
    vi.spyOn(browser, 'waitForStable').mockImplementation(((js: string, opts: Parameters<AgentBrowser['waitForStable']>[1]) => original(js, { ...opts, visualDiagnostic: undefined })) as AgentBrowser['waitForStable'])
  }
  vi.spyOn(browser as unknown as { run(args: string[], budget?: number): Record<string, unknown> }, 'run').mockImplementation((args, budget) => {
    if (args[0] === 'close') return {}
    if (args[0] === 'eval' && !capturing) {
      probes++; now++
      const target = { parentElement: null, checkVisibility: () => true, querySelectorAll: () => [], getAnimations: () => [],
        getBoundingClientRect: () => ({ x: 0, y: 0, width: 100, height: 40 }), textContent: 'owned', scrollWidth: 100 }
      let reads = 0
      const window = { effects: 0, get measurement() { reads++; return options.measurements![(probes - 1) % options.measurements!.length] } }
      const value = JSON.parse(JSON.stringify(runInNewContext(args[1]!, {
        document: { documentElement: target, querySelector: () => target, fonts: { status: 'loaded' }, activeElement: null, readyState: 'complete', visibilityState: 'visible' },
        window, performance: { timeOrigin: 123, now: () => 4 }, location: { pathname: '/owned' }, innerWidth: 100,
      })))
      measurementReads.push(reads); serializationCalls.push(window.effects)
      if (options.mutate) value.public.value.value = options.mutate === 'null' ? null : undefined
      if (wires.length < 3) wires.push(value)
      return { result: value }
    }
    captures.push([args[0]!, budget])
    if (args[0] === 'screenshot') { capturing = true; writeFileSync(args[1]!, 'scripted PNG'); return {} }
    return args[0] === 'snapshot' ? { snapshot: 'scripted' } : { result: {} }
  })
  disposals.push(() => { browser.close(); rmSync(root, { recursive: true, force: true }) })
  let value: unknown, error: unknown
  try { value = waitForSettledSample(browser, expression, matcher) } catch (caught) { error = caught }
  const bundle = error instanceof WaitForValueError ? JSON.parse(readFileSync(join(error.bundle, 'probe.json'), 'utf8')) : undefined
  return { value, error, bundle, captures, matcher, probes, now, wires, browser, measurementReads, serializationCalls }
}
it.each(['null', 'undefined'] as const)('rejects generated false mutated to nested %s before the custom matcher', mutate => {
  const state = exercise('false', { mutate })
  expect(state.error).toBeInstanceOf(WaitForValueError)
  expect((state.error as WaitForValueError).cause).toBeInstanceOf(VisualProtocolError)
  expect((state.error as WaitForValueError).lastValue).toBeUndefined()
  expect(state.matcher).not.toHaveBeenCalled()
  expect(state.probes).toBe(249); expect(state.now).toBe(25001)
  expect(state.captures).toEqual([['screenshot', 5000], ['snapshot', 5000], ['eval', 5000]])
  expect(state.browser.captureTestFailure([state.error])).toBeNull()
  expect(state.bundle.poll).toMatchObject({ completedSamples: 0, commandErrors: 0, matcherErrors: 0, decoderErrors: 249,
    terminalProbe: { browserCompletion: 'returned' }, visual: { latest: { qualification: 'protocol-error' } } })
})
for (const legacy of [true, false]) {
  it.each([
    ['false', false], ['0', 0], ['7.25', 7.25], ["'text'", 'text'], ['({a: 1, nested: null})', { a: 1, nested: null }], ['Promise.resolve(42)', {}],
    ['NaN', null], ['Infinity', null], ['-Infinity', null], ['({toJSON(){return null}})', null],
  ] as const)('preserves JSON measurement %s with legacy=' + legacy, (expression, expected) => {
    const state = exercise(expression, { legacy })
    expect(state.error).toBeUndefined(); expect(state.value).toEqual(expected)
    expect(state.probes).toBe(3); expect(state.now).toBe(203)
    expect(state.matcher.mock.calls).toEqual([[expected], [expected], [expected]])
    expect(state.captures).toEqual([])
  })
  it.each(['null', 'undefined'])('preserves authored %s rejection with legacy=' + legacy, expression => {
    const state = exercise(expression, { legacy })
    expect(state.error).toBeInstanceOf(WaitForValueError)
    expect((state.error as WaitForValueError).lastValue).toBeNull()
    expect((state.error as WaitForValueError).cause).toBeUndefined()
    expect(state.matcher).not.toHaveBeenCalled()
    expect(state.probes).toBe(249); expect(state.now).toBe(25001)
    expect(state.captures).toEqual([['screenshot', 5000], ['snapshot', 5000], ['eval', 5000]])
    expect(state.browser.captureTestFailure([state.error])).toBeNull()
  })
}

it('preserves the hold when only original scalar serialization qualification changes', () => {
  const state = exercise('window.measurement', { measurements: [NaN, { toJSON: () => null }, Infinity] })
  expect(state.error).toBeUndefined(); expect(state.value).toBeNull()
  expect(state.probes).toBe(3); expect(state.now).toBe(203)
  expect(state.matcher.mock.calls).toEqual([[null], [null], [null]])
  expect(state.measurementReads).toEqual([1, 1, 1]); expect(state.captures).toEqual([])
  expect(state.wires.map(wire => (wire as { evidence: { measurementSerialization: string } }).evidence.measurementSerialization)).toEqual(['nonfinite-number', 'opaque', 'nonfinite-number'])
})
it.each([true, false])('does not serialize an opaque measured object an extra time with legacy=%s', legacy => {
  const state = exercise('({toJSON(){window.effects++; return null}})', { legacy })
  expect(state.error).toBeUndefined(); expect(state.value).toBeNull()
  expect(state.serializationCalls).toEqual([1, 1, 1])
  expect(state.probes).toBe(3); expect(state.now).toBe(203)
})

// Obtain each wire from the real opt-in helper/generator, then vary only the
// claimed original category or transported scalar. No provider bypass exists.
function generated(expression = 'false') {
  let program!: VisualProgram
  const browser = { waitForStable: (_js: string, opts: { visualDiagnostic: VisualProgram }) => { program = opts.visualDiagnostic; return { value: false } } } as unknown as AgentBrowser
  waitForSettledSample(browser, expression)
  if (program.mode !== 'envelope') throw Error('expected generated program')
  const target = { parentElement: null, checkVisibility: () => true, querySelectorAll: () => [], getAnimations: () => [],
    getBoundingClientRect: () => ({ x: 0, y: 0, width: 100, height: 40 }), textContent: 'owned', scrollWidth: 100 }
  const context = { document: { documentElement: target, querySelector: () => target, fonts: { status: 'loaded' }, activeElement: null, readyState: 'complete', visibilityState: 'visible' },
    performance: { timeOrigin: 123, now: () => 4 }, location: { pathname: '/owned' }, innerWidth: 100, window: { measurement: undefined as unknown } }
  const raw = () => runInNewContext(program.mode === 'envelope' ? program.build('measurement-token', 1) : '', context)
  return { context, raw, json: () => JSON.parse(JSON.stringify(raw())) }
}
const decoded = (wire: unknown, kind: 'settled' | 'visual' = 'settled') => decodeVisualSample(wire, true, { token: 'measurement-token', attempt: 1, kind, session: 'owned' })
it.each([
  ['false', 'finite-scalar'], ['0', 'finite-scalar'], ['-3.5', 'finite-scalar'], ["'text'", 'finite-scalar'],
  ['NaN', 'nonfinite-number'], ['Infinity', 'nonfinite-number'], ['-Infinity', 'nonfinite-number'],
  ['({nested:null})', 'opaque'], ['Promise.resolve(42)', 'opaque'], ['({toJSON(){return null}})', 'opaque'],
] as const)('qualifies original %s without changing its public serialized value', (expression, category) => {
  const wire = generated(expression).json()
  expect(wire.evidence.measurementSerialization).toBe(category)
  const value = decoded(wire)
  expect(value.value).toBe(wire.public.value)
  expect(value.observation).toMatchObject({ qualification: 'qualified', measurementSerialization: category })
})
const categories = ['finite-scalar', 'nonfinite-number', 'opaque'] as const
const payloads = [null, undefined, false, 0, -3.5, '', 'text', {}, [], { nested: null }, NaN, Infinity]
it.each(categories.flatMap(category => payloads.map((value, index) => ({ category, value, index,
  allowed: category === 'finite-scalar' ? typeof value === 'boolean' || typeof value === 'string' || typeof value === 'number' && Number.isFinite(value)
    : category === 'nonfinite-number' ? value === null : value !== undefined }))))('checks generated category/$category and wire cell $index (allowed=$allowed)', ({ category, value, allowed }) => {
  const wire = generated().json()
  wire.evidence.measurementSerialization = category
  wire.public.value.value = value
  if (allowed) {
    const result = decoded(wire)
    expect(result.value).toBe(wire.public.value)
    expect((result.value as { value: unknown }).value).toBe(value)
  } else expect(() => decoded(wire)).toThrow(VisualProtocolError)
})
it.each([undefined, null, '', 'number', [], {}, false, 0])('rejects invalid sample-ready qualification: %j', category => {
  const wire = generated().json()
  wire.evidence.measurementSerialization = category
  expect(() => decoded(wire)).toThrow(VisualProtocolError)
})
it('requires an own qualification for a ready sample', () => {
  const wire = generated().json()
  delete wire.evidence.measurementSerialization
  expect(() => decoded(wire)).toThrow(VisualProtocolError)
})
const rejectedKinds = [
  ...['missing-target', 'fonts', 'native', 'theme', 'width', 'idle', 'finite-animation', 'zero-box', 'visual-ready'].map(reason => ({ kind: 'visual' as const, reason })),
  ...['missing-target', 'fonts', 'native', 'finite-animation', 'zero-box', 'measurement-null', 'measurement-undefined'].map(reason => ({ kind: 'settled' as const, reason })),
]
it.each(rejectedKinds.flatMap(cell => categories.map(category => ({ ...cell, category }))))('does not allow $category qualification on $kind/$reason', ({ kind, reason, category }) => {
  const wire = generated().json()
  wire.kind = kind
  wire.evidence.reason = reason
  wire.evidence.phase = reason.startsWith('measurement-') ? 'measurement' : 'visual'
  wire.evidence.fontObserved = reason !== 'missing-target'
  if (reason === 'missing-target') delete wire.evidence.fontStatus
  else wire.evidence.fontStatus = reason === 'fonts' ? 'loading' : 'loaded'
  wire.public.value = reason === 'visual-ready' ? wire.public.value.layout : null
  wire.evidence.measurementSerialization = category
  expect(() => decoded(wire, kind)).toThrow(VisualProtocolError)
})
it('qualifies an opaque proxy with zero property reads and no coercion', () => {
  let reads = 0
  const value = new Proxy({}, { get: () => { reads++; throw Error('opaque read') }, ownKeys: () => { reads++; throw Error('opaque enumeration') } })
  const sample = generated('window.measurement')
  sample.context.window.measurement = value
  const wire = sample.raw()
  expect(wire.evidence.measurementSerialization).toBe('opaque')
  expect((decoded(wire).value as { value: unknown }).value).toBe(value)
  expect(reads).toBe(0)
})

it.each(['0', 'NaN', 'Infinity', '-Infinity'])('classifies %s with primitive arithmetic, without an added global function lookup', expression => {
  const sample = generated(expression)
  Object.defineProperty(sample.context, 'Number', { get: () => { throw Error('unexpected Number lookup') } })
  const wire = sample.json()
  expect(wire.evidence.measurementSerialization).toBe(expression === '0' ? 'finite-scalar' : 'nonfinite-number')
  expect(decoded(wire).value).toBe(wire.public.value)
})

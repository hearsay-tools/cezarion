// @vitest-environment node
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runInNewContext } from 'node:vm'
import { afterEach, expect, it, vi } from 'vitest'
import { AgentBrowser, WaitForValueError, configureFailureCapture } from '../../e2e/agent-browser'
import { settleVisual, waitForSettledSample } from '../../e2e/visual-ready'
import { decodeVisualSample, visualReasons, VisualProtocolError, type VisualReason, type VisualProgram } from '../../e2e/visual-sample-protocol'

import { scriptedVisualResult } from './helpers/visual-wire-fixture'

const cleanup: Array<() => void> = []
afterEach(() => {
  for (const dispose of cleanup.splice(0)) dispose()
  configureFailureCapture({ root: undefined, spec: undefined, test: undefined })
  vi.restoreAllMocks(); vi.unstubAllEnvs()
})

// The actual helper generates a genuine font rejection in the VM. Only the
// JSON transport's public.value is mutated; no native corruption is claimed.
it.each([true, false])('keeps a generated font rejection from passing when public.value is mutated: %s', mutate => {
  const root = mkdtempSync(join(tmpdir(), 'cez-visual-root-'))
  configureFailureCapture({ root, spec: 'root-contract', test: String(mutate) })
  vi.stubEnv('AGENT_BROWSER_DEFAULT_TIMEOUT', '25000')
  const browser = AgentBrowser.attach({ installed: true, command: '/never-launch', version: 'scripted-seam', notes: '' }, 'root-contract')
  let now = 0, probes = 0, fonts = 0, capturing = false
  const captures: Array<[string, number | undefined]> = []
  vi.spyOn(performance, 'now').mockImplementation(() => now)
  vi.spyOn(Atomics, 'wait').mockImplementation((_a, _i, _v, ms) => { now += ms!; return 'timed-out' })
  vi.spyOn(browser as unknown as { run(args: string[], budget?: number): Record<string, unknown> }, 'run').mockImplementation((args, budget) => {
    if (args[0] === 'close') return {}
    if (args[0] === 'eval' && !capturing) {
      probes++; now++
      const value = JSON.parse(JSON.stringify(runInNewContext(args[1]!, {
        document: { documentElement: {}, querySelector: () => ({}), get fonts() { fonts++; return { status: 'loading' } }, readyState: 'complete', visibilityState: 'visible' },
        performance: { timeOrigin: 123, now: () => 4 }, location: { pathname: '/owned' },
      })))
      expect(value.evidence).toMatchObject({ reason: 'fonts', fontStatus: 'loading' })
      expect(value.public).toEqual({ present: true, value: null })
      if (mutate) value.public.value = {}
      return { result: value }
    }
    captures.push([args[0]!, budget])
    if (args[0] === 'screenshot') { capturing = true; writeFileSync(args[1]!, 'scripted PNG'); return {} }
    return args[0] === 'snapshot' ? { snapshot: 'scripted' } : { result: {} }
  })
  cleanup.push(() => { browser.close(); rmSync(root, { recursive: true, force: true }) })
  let error: unknown
  try { settleVisual(browser, 'body') } catch (caught) { error = caught }
  expect(error).toBeInstanceOf(WaitForValueError)
  const failure = error as WaitForValueError
  expect(probes).toBe(249); expect(fonts).toBe(probes); expect(now).toBe(25001)
  expect(captures).toEqual([['screenshot', 5000], ['snapshot', 5000], ['eval', 5000]])
  expect(browser.captureTestFailure([error])).toBeNull()
  const bundle = JSON.parse(readFileSync(join(failure.bundle, 'probe.json'), 'utf8'))
  expect(bundle.poll).toMatchObject({ attempts: 249, commandErrors: 0, matcherErrors: 0, lateReturns: 1,
    terminalProbe: { outcome: 'returned-after-deadline', browserCompletion: 'returned' } })
  if (mutate) {
    expect(failure.cause).toBeInstanceOf(VisualProtocolError)
    expect(failure.lastValue).toBeUndefined()
    expect(bundle.poll).toMatchObject({ completedSamples: 0, nullSamples: 0, decoderErrors: 249,
      visual: { latest: { qualification: 'protocol-error', attempt: 249 }, firstQualified: null, latestQualified: null, reasons: {} } })
  } else {
    expect(failure.cause).toBeUndefined(); expect(failure.lastValue).toBeNull()
    expect(bundle.poll).toMatchObject({ completedSamples: 248, nullSamples: 248, decoderErrors: 0,
      visual: { latest: { qualification: 'qualified', reason: 'fonts' } } })
  }
})

const signature = () => ({ boxes: [[0, 0, 100, 40]], text: 'owned', scrollWidth: 100, viewport: 100 })
type Kind = 'visual' | 'settled'
const visualRejects = ['missing-target', 'fonts', 'native', 'theme', 'width', 'idle', 'finite-animation', 'zero-box']
const settledRejects = ['missing-target', 'fonts', 'native', 'finite-animation', 'zero-box', 'measurement-null', 'measurement-undefined']
function generatedRoot(kind: Kind, reason: VisualReason, measured: unknown = false) {
  const ready = reason === 'visual-ready' || reason === 'sample-ready'
  const value = !ready ? null : reason === 'visual-ready' ? signature() : { layout: signature(), focus: -1, value: measured }
  return { protocol: 'cez.visual', version: 1, token: 'root-token', attempt: 3, kind,
    public: { present: true, value },
    evidence: { reason, phase: reason.startsWith('measurement-') || reason === 'sample-ready' ? 'measurement' : 'visual',
      ...(reason === 'sample-ready' ? { measurementSerialization: typeof measured === 'number' ? (Number.isFinite(measured) ? 'finite-scalar' : 'nonfinite-number') : typeof measured === 'boolean' || typeof measured === 'string' ? 'finite-scalar' : 'opaque' } : {}),
      fontObserved: reason !== 'missing-target', ...(reason === 'missing-target' ? {} : { fontStatus: reason === 'fonts' ? 'loading' : 'loaded' }),
      document: { timeOrigin: 123, path: '/root-contract', readyState: 'complete', visibilityState: 'visible', observedAt: 4 } },
  }
}
const decode = (value: unknown, kind: Kind = 'visual') => decodeVisualSample(value, true, { token: 'root-token', attempt: 3, kind, session: 'owned' })
const cells = (['visual', 'settled'] as const).flatMap(kind => visualReasons.map(reason => ({ kind, reason,
  allowed: (kind === 'visual' ? [...visualRejects, 'visual-ready'] : [...settledRejects, 'sample-ready']).includes(reason) })))

it.each(cells)('pins generated kind/reason cell $kind/$reason (allowed=$allowed)', ({ kind, reason, allowed }) => {
  const wire = generatedRoot(kind, reason)
  if (allowed) {
    const decoded = decode(wire, kind)
    expect(decoded.value).toBe(wire.public.value)
    expect(decoded.observation).toMatchObject({ qualification: 'qualified', reason })
  } else expect(() => decode(wire, kind)).toThrow(VisualProtocolError)
})
it.each(cells.filter(cell => cell.allowed && !['visual-ready', 'sample-ready'].includes(cell.reason)))('rejects nonnull public values for every generated rejection $kind/$reason', ({ kind, reason }) => {
  for (const value of [{}, false, 0, signature(), { layout: signature(), focus: -1, value: false }]) {
    const wire = generatedRoot(kind, reason)
    Object.assign(wire.public, { value })
    expect(() => decode(wire, kind)).toThrow(VisualProtocolError)
  }
})
it.each(cells.filter(cell => cell.allowed))('requires explicit public null/value presence for $kind/$reason', ({ kind, reason }) => {
  const wire = generatedRoot(kind, reason)
  Object.assign(wire, { public: { present: false } })
  expect(() => decode(wire, kind)).toThrow(VisualProtocolError)
})
it.each(cells.filter(cell => cell.allowed && cell.reason !== 'missing-target'))('checks cached font state against the original branch $kind/$reason', ({ kind, reason }) => {
  const wire = generatedRoot(kind, reason)
  wire.evidence.fontStatus = reason === 'fonts' ? 'loaded' : 'loading'
  expect(() => decode(wire, kind)).toThrow(VisualProtocolError)
})
it.each([false, 0, {}, { then: {} }, { arbitrary: [null, false, 0, { protocol: 'other' }] }])('keeps nested measured payload opaque and identical: %j', value => {
  const wire = generatedRoot('settled', 'sample-ready', value)
  const decoded = decode(wire, 'settled')
  expect(decoded.value).toBe(wire.public.value)
  expect((decoded.value as { value: unknown }).value).toBe(value)
})
it('never enumerates, serializes, or reads an opaque measured object', () => {
  const value = new Proxy({}, { ownKeys: () => { throw Error('opaque enumeration') }, get: () => { throw Error('opaque read') } })
  const wire = generatedRoot('settled', 'sample-ready', value)
  expect((decode(wire, 'settled').value as { value: unknown }).value).toBe(value)
})
it('keeps raw provider null and missing results distinct from malformed generated roots', () => {
  expect(decode(null)).toMatchObject({ value: null, observation: { qualification: 'unqualified-provider-null' } })
  expect(decode(undefined)).toMatchObject({ value: undefined, observation: { qualification: 'missing-provider-result' } })
})

it.each(['visual', 'settled'] as const)('requires the generated ready outer result for %s', kind => {
  const reason = kind === 'visual' ? 'visual-ready' : 'sample-ready'
  for (const value of [null, false, 0, [], {}, { value: false }]) {
    const wire = generatedRoot(kind, reason)
    Object.assign(wire.public, { value })
    expect(() => decode(wire, kind)).toThrow(VisualProtocolError)
  }
})
it.each(['boxes', 'text', 'scrollWidth', 'viewport'])('requires generated visual signature field %s at either root', field => {
  for (const kind of ['visual', 'settled'] as const) {
    const wire = generatedRoot(kind, kind === 'visual' ? 'visual-ready' : 'sample-ready')
    const publicValue = wire.public.value as Record<string, unknown>
    const layout = (kind === 'visual' ? publicValue : publicValue.layout) as Record<string, unknown>
    delete layout[field]
    expect(() => decode(wire, kind)).toThrow(VisualProtocolError)
  }
})
it.each([
  ['boxes', {}], ['text', []], ['scrollWidth', '100'], ['viewport', null],
] as const)('rejects malformed generated signature field %s', (field, invalid) => {
  const wire = generatedRoot('visual', 'visual-ready')
  Object.assign(wire.public.value!, { [field]: invalid })
  expect(() => decode(wire)).toThrow(VisualProtocolError)
})
it.each(['layout', 'focus', 'value'])('requires settled generated outer field %s without reading inside measured value', field => {
  const wire = generatedRoot('settled', 'sample-ready')
  delete (wire.public.value as Record<string, unknown>)[field]
  expect(() => decode(wire, 'settled')).toThrow(VisualProtocolError)
})
it.each([null, {}, '0', 0.5, -2])('requires the original focus index shape: %j', focus => {
  const wire = generatedRoot('settled', 'sample-ready')
  Object.assign(wire.public.value!, { focus })
  expect(() => decode(wire, 'settled')).toThrow(VisualProtocolError)
})
it('does not reinterpret unknown nonloaded status as font readiness', () => {
  for (const fontStatus of [null, 'loading', 'unexpected-status']) {
    const wire = generatedRoot('visual', 'fonts')
    Object.assign(wire.evidence, { fontStatus })
    expect(decode(wire)).toMatchObject({ value: null, observation: { qualification: 'qualified', reason: 'fonts', fontStatus } })
  }
})
it.each([null, {}, [[]], [[0, 0, 1]], [[0, 0, 1, 1, 1]], [[0, 0, '1', 1]]])('checks only generated box tuple structure: %j', boxes => {
  const wire = generatedRoot('visual', 'visual-ready')
  Object.assign(wire.public.value!, { boxes })
  expect(() => decode(wire)).toThrow(VisualProtocolError)
})
it('does not add geometry thresholds to structurally valid signatures', () => {
  const wire = generatedRoot('visual', 'visual-ready')
  Object.assign(wire.public.value!, { boxes: [[-100, -20, 0, 0]], text: null, scrollWidth: 0, viewport: 0 })
  expect(decode(wire).value).toBe(wire.public.value)
})
it('rejects unknown generated root fields without interpreting measured object fields', () => {
  for (const kind of ['visual', 'settled'] as const) {
    const wire = generatedRoot(kind, kind === 'visual' ? 'visual-ready' : 'sample-ready')
    Object.assign(wire.public.value!, { extra: false })
    expect(() => decode(wire, kind)).toThrow(VisualProtocolError)
  }
})

it.each([false, 0])('completes only scripted wire metadata while retaining original sample states and legacy identity: %s', value => {
  let program!: VisualProgram
  const browser = { waitForStable: (_js: string, options: { visualDiagnostic: VisualProgram }) => { program = options.visualDiagnostic; return { value } } } as unknown as AgentBrowser
  waitForSettledSample(browser, String(value))
  if (program.mode !== 'envelope') throw Error('expected actual generated header')
  const expression = program.build('root-token', 3)
  for (const [width, focus] of [[20, 1], [30, 1], [30, 2]]) {
    const sample = { layout: { boxes: [[0, 0, width, 44]] }, focus, value }, before = structuredClone(sample)
    expect(scriptedVisualResult('legacyExpression()', sample)).toBe(sample)
    const wire = scriptedVisualResult(expression, sample) as { public: { value: { layout: { boxes: unknown }; focus: number; value: unknown } } }
    expect(wire.public.value.layout.boxes).toBe(sample.layout.boxes)
    expect(wire.public.value.focus).toBe(focus); expect(wire.public.value.value).toBe(value)
    expect(wire.public.value.layout).toEqual({ boxes: sample.layout.boxes, text: 'scripted', scrollWidth: 100, viewport: 100 })
    expect(sample).toEqual(before)
    expect(decode(wire, 'settled').value).toBe(wire.public.value)
  }
})

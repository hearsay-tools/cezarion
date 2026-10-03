// @vitest-environment node
import { createHash } from 'node:crypto'
import { runInNewContext } from 'node:vm'
import { expect, it } from 'vitest'
import { contrastSampleExpression } from '../../e2e/contrast'
import type { AgentBrowser } from '../../e2e/agent-browser'
import { settleVisual, waitForSettledSample, visualSampleExpression, settledSampleExpression } from '../../e2e/visual-ready'
import { decodeVisualSample, type VisualProgram } from '../../e2e/visual-sample-protocol'

function program(expression?: string, appearance = {}) {
  let descriptor: VisualProgram | undefined, legacy = ''
  const browser = { waitForStable: (js: string, options: { visualDiagnostic?: VisualProgram }) => { legacy = js; descriptor = options.visualDiagnostic; return { value: 0 } } } as unknown as AgentBrowser
  if (expression === undefined) settleVisual(browser, 'main', appearance)
  else waitForSettledSample(browser, expression, () => true, 'main')
  return { descriptor: descriptor!, legacy }
}
type State = { missing?: boolean; font?: string; fontTrap?: boolean; native?: boolean; theme?: boolean; width?: string; idle?: boolean; finite?: boolean; infinite?: boolean; zero?: boolean; skipChild?: boolean; focus?: boolean }
function page(state: State = {}) {
  const trace: string[] = []
  const animation = (infinite: boolean) => ({ playState: 'running', effect: { getComputedTiming: () => { trace.push('timing'); return { iterations: infinite ? Infinity : 1 } } } })
  function element(id: string, parentElement: any = null): any {
    return { id, parentElement,
      checkVisibility: () => { trace.push('native:' + id); return id === 'child' ? !state.skipChild : state.native !== false },
      getAnimations: () => { trace.push('animations:' + id); return id === 'main' && state.finite ? [animation(false)] : id === 'child' && state.infinite ? [animation(true)] : [] },
      getBoundingClientRect: () => { trace.push('rect:' + id); if (id === 'child' && state.skipChild) throw Error('forced skipped geometry'); return { x: 1, y: 2, width: state.zero && id === 'main' ? 0 : 20, height: 30 } },
      get textContent() { trace.push('text'); return 'stable' },
    }
  }
  const root = element('root'), target = element('main', root), child = element('child', target)
  root.classList = { contains: () => { trace.push('theme'); return state.theme ?? false } }
  root.dataset = { get width() { trace.push('width'); return state.width } }
  Object.defineProperty(root, 'scrollWidth', { get: () => { trace.push('scrollWidth'); return 200 } })
  target.querySelectorAll = () => { trace.push('descendants'); return [child] }
  const document = {
    get documentElement() { trace.push('root'); return root },
    querySelector: () => { trace.push('target'); return state.missing ? null : target },
    get fonts() { trace.push('fonts'); if (state.fontTrap) throw Error('forbidden font getter'); return { get status() { trace.push('font.status'); return state.font ?? 'loaded' }, get ready() { throw Error('forbidden font ready') }, [Symbol.iterator]() { throw Error('forbidden font iteration') } } },
    get activeElement() { trace.push('active'); return state.focus ? child : null },
    querySelectorAll: () => { trace.push('focus'); return [root, target, child] }, readyState: 'complete', visibilityState: 'visible',
  }
  const window = { get __cezIdle() { trace.push('idle'); return state.idle }, effects: 0, trace }
  return { trace, window, context: { document, window, location: { pathname: '/owned' }, performance: { timeOrigin: 1, now: () => 2 }, innerWidth: 300 } }
}
const transport = (value: unknown) => JSON.parse(JSON.stringify(value))
function parity(state: State, reason: string, expression?: string, appearance = {}) {
  const p = program(expression, appearance), old = page(state), observed = page(state)
  expect(p.descriptor.mode).toBe('envelope')
  if (p.descriptor.mode !== 'envelope') throw Error('expected descriptor')
  const expected = runInNewContext(p.legacy, old.context)
  const wire = runInNewContext(p.descriptor.build('token', 7), observed.context)
  const decoded = decodeVisualSample(transport(wire), true, { token: 'token', attempt: 7, kind: p.descriptor.kind, session: 'unit' })
  expect(decoded.value).toEqual(transport(expected))
  expect(observed.trace).toEqual(old.trace)
  expect(observed.window.effects).toBe(old.window.effects)
  expect(decoded.observation).toMatchObject({ qualification: 'qualified', reason })
  return { old, observed, decoded, wire }
}

it('keeps the exact existing public expression strings', () => {
  const hash = (s: string) => createHash('sha256').update(s).digest('hex')
  expect(hash(visualSampleExpression('main'))).toBe('4fa3798239d63a27ae68309d38fbf19403d47c20f63f47243ffb591ea2d10c4d')
  expect(hash(visualSampleExpression('#x', { theme: 'light', width: 'wide', idle: true }))).toBe('80362fc6bb61773df58d93866e55a435df3def08c56ba6a2f0364dfc8ba505a2')
  expect(hash(settledSampleExpression('({layout, active, focus, value: 0})'))).toBe('0556c96b86af700b675d30198cf4fabdad8f7ce7ba2826393463cbc0a1418d07')
})
it('short-circuits missing target before the forbidden font getter', () => {
  const p = parity({ missing: true, fontTrap: true }, 'missing-target')
  expect(p.observed.trace).toEqual(['root', 'target'])
  expect(p.decoded.observation).not.toHaveProperty('fontStatus')
})
it('reads font status once and rejects before all native/animation/geometry operations', () => {
  const p = parity({ font: 'loading' }, 'fonts', '(window.effects++, 0)')
  expect(p.observed.trace).toEqual(['root', 'target', 'fonts', 'font.status'])
  expect(p.observed.window.effects).toBe(0)
})
it('rejects native skipped target before descendant collection or geometry', () => {
  const p = parity({ native: false }, 'native')
  expect(p.observed.trace).toEqual(['root', 'target', 'fonts', 'font.status', 'native:main'])
})
it('never reads skipped descendant geometry', () => {
  const p = parity({ skipChild: true }, 'visual-ready')
  expect(p.observed.trace).not.toContain('rect:child')
})
it.each([
  [{}, 'theme', { theme: 'light' }], [{ theme: true }, 'width', { theme: 'light', width: 'wide' }],
  [{ theme: true, width: 'wide', idle: false }, 'idle', { theme: 'light', width: 'wide', idle: true }],
  [{ finite: true }, 'finite-animation', {}], [{ zero: true }, 'zero-box', {}], [{ infinite: true }, 'visual-ready', {}],
] as const)('preserves gate and original operation counts: %j', (state, reason, appearance) => { parity(state, reason, undefined, appearance) })
it('keeps infinite spinner ink out of the stable geometry', () => {
  expect(parity({ infinite: true }, 'visual-ready').observed.trace).not.toContain('rect:child')
})
it.each(['false', '0', '(window.effects++, false)', '[layout.text, active.id, focus]', 'typeof __cezVisualEvidence', 'Promise.resolve(42)'])('keeps opaque measurement and original lexical position: %s', expression => {
  const p = parity({ focus: true }, 'sample-ready', expression)
  if (expression.includes('effects')) expect(p.observed.window.effects).toBe(1)
})
it.each([['null', 'measurement-null'], ['undefined', 'measurement-undefined']] as const)('keeps public null while distinguishing %s', (expression, reason) => { expect(parity({}, reason, expression).decoded.value).toBeNull() })
it('does not catch or re-execute a throwing measurement', () => {
  const p = program(`(() => { window.effects++; throw 'page-sentinel' })()`)
  if (p.descriptor.mode !== 'envelope') throw Error('expected envelope')
  for (const script of [p.legacy, p.descriptor.build('token', 1)]) { const state = page(); let error; try { runInNewContext(script, state.context) } catch (e) { error = e } expect(error).toBe('page-sentinel'); expect(state.window.effects).toBe(1) }
})
it.each([`eval('typeof __cezVisualEvidence')`, `Function('return 0')()`, `arguments`, `new Error().stack`, `({}).constructor`, `Reflect.ownKeys({})`, `(() => { with /* scope */ ({}) { return 0 } })()`, String.raw`typeof __cezVisualEvidenc\u0065`])('transparently retains legacy for unproved introspective syntax: %s', expression => {
  const p = program(expression)
  expect(p.descriptor).toEqual({ mode: 'legacy', kind: 'settled', fallback: 'dynamic-or-introspective-source' })
  expect(p.legacy).toBe(settledSampleExpression(expression, 'main'))
})

it('does not exclude ordinary comments containing with', () => { parity({}, 'sample-ready', '(() => { /* with its own layout */ return false })()') })
it('preserves a nested thenable without invoking then', () => { parity({}, 'sample-ready', '({ then() { window.effects++; } })') })
it('retains original temporal-dead-zone behavior for the value local', () => {
  const p = program('value')
  if (p.descriptor.mode !== 'envelope') throw Error('expected envelope')
  for (const script of [p.legacy, p.descriptor.build('token', 1)]) { expect(() => runInNewContext(script, page().context)).toThrow(/before initialization/) }
})
it('keeps the original focus index in public identity', () => {
  const a = parity({}, 'sample-ready', '0'), b = parity({ focus: true }, 'sample-ready', '0')
  expect(a.decoded.value).toMatchObject({ focus: -1, value: 0 })
  expect(b.decoded.value).toMatchObject({ focus: 2, value: 0 })
})

it('keeps the current embedded contrast constructor on the documented legacy fallback', () => {
  const expression = `({ glyph: ${contrastSampleExpression('#glyph')} })`
  const p = program(expression)
  expect(p.descriptor).toEqual({ mode: 'legacy', kind: 'settled', fallback: 'dynamic-or-introspective-source' })
  expect(p.legacy).toBe(settledSampleExpression(expression, 'main'))
})

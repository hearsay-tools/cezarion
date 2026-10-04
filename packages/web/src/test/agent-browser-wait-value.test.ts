// @vitest-environment node
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AgentBrowser, WaitForValueError, configureFailureCapture } from '../../e2e/agent-browser'
import { waitForSettledSample } from '../../e2e/visual-ready'
import { dismissWithEscape, focusWithKeyboard, hoverVisiblePoint } from '../../e2e/contrast'

/**
 * A stand-in `agent-browser` whose `eval` answers are scripted per call: the n-th `eval`
 * returns `results[n]` (the last one repeats), and an entry of `{ error }` fails the call the way
 * the CLI fails an expression that throws. Only the seam runs — no Chrome — so what these prove
 * is the polling contract of `waitForValue` (#409): keep sampling until the matcher passes,
 * hand back that sample, and fail through the #408 bundle when it never does.
 */
function fakeBrowser(results: unknown[]) {
  const dir = mkdtempSync(join(tmpdir(), 'cez-fake-agent-browser-wait-value-'))
  const log = join(dir, 'calls.ndjson')
  const counter = join(dir, 'evals')
  const script = join(dir, 'fake.mjs')
  writeFileSync(counter, '0')
  writeFileSync(script, `
    import { appendFileSync, readFileSync, writeFileSync } from 'node:fs'
    const args = process.argv.slice(2)
    appendFileSync(process.env.FAKE_LOG, JSON.stringify(args) + '\\n')
    const command = args[2]
    if (command === 'eval') {
      const results = JSON.parse(process.env.FAKE_EVAL_RESULTS)
      const n = Number(readFileSync(process.env.FAKE_COUNTER, 'utf8'))
      writeFileSync(process.env.FAKE_COUNTER, String(n + 1))
      let result = results[Math.min(n, results.length - 1)]
      if (result && typeof result === 'object' && 'delayMs' in result) {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, result.delayMs)
        result = result.value
      }
      if (result && typeof result === 'object' && 'error' in result) {
        process.stdout.write(JSON.stringify({ success: false, error: result.error }))
      } else {
        process.stdout.write(JSON.stringify({ success: true, data: { result } }))
      }
    } else if (command === 'screenshot') {
      writeFileSync(args[3], 'PNG')
      process.stdout.write(JSON.stringify({ success: true, data: { path: args[3] } }))
    } else if (command === 'snapshot') {
      process.stdout.write(JSON.stringify({ success: true, data: { snapshot: '- button "Tools"' } }))
    } else {
      process.stdout.write(JSON.stringify({ success: true, data: {} }))
    }
  `)
  const bin = join(dir, 'agent-browser')
  writeFileSync(bin, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(script)} "$@"\n`)
  chmodSync(bin, 0o755)
  const failures = join(dir, 'failures')
  configureFailureCapture({ root: failures, spec: 'selection-states', test: 'model pill hover' })
  const browser = AgentBrowser.attach(
    {
      installed: true,
      command: bin,
      version: 'fake',
      notes: '',
      runtimeEnv: { FAKE_LOG: log, FAKE_COUNTER: counter, FAKE_EVAL_RESULTS: JSON.stringify(results) },
    },
    'wait-value-test',
  )
  /** Each invocation's command, with the `--session <id>` prefix and `--json` suffix stripped. */
  const commands = () =>
    readFileSync(log, 'utf8')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => (JSON.parse(line) as string[]).slice(2, -1))
  return { browser, commands, failures, dispose: () => rmSync(dir, { recursive: true, force: true }) }
}

const fakes: Array<{ browser: AgentBrowser; dispose: () => void }> = []
const savedTimeout = process.env.AGENT_BROWSER_DEFAULT_TIMEOUT
afterEach(() => {
  for (const fake of fakes.splice(0)) {
    fake.browser.close()
    fake.dispose()
  }
  configureFailureCapture({ root: undefined, spec: undefined, test: undefined })
  if (savedTimeout === undefined) delete process.env.AGENT_BROWSER_DEFAULT_TIMEOUT
  else process.env.AGENT_BROWSER_DEFAULT_TIMEOUT = savedTimeout
})
function open(results: unknown[]) {
  const fake = fakeBrowser(results)
  fakes.push(fake)
  return fake
}
/** The seam reads the CLI's own timeout variable, so a test can keep a timeout short without
 *  the helpers under test growing a parameter for it. */
function shortTimeout(ms = 400) {
  process.env.AGENT_BROWSER_DEFAULT_TIMEOUT = String(ms)
}
const actions = (commands: string[][]) => commands.map(([action]) => action)

/** Script only the probe transport and its completed-sample time. Failure capture still
 * invokes the real fake CLI and writes its artifacts, outside the polling deadline. */
function scriptProbes(browser: AgentBrowser, expression: string, samples: Array<{ value: unknown; durationMs: number }>) {
  let now = 0
  const budgets: Array<number | undefined> = []
  const clock = vi.spyOn(performance, 'now').mockImplementation(() => now)
  const transport = browser as unknown as { run: (args: string[], timeoutMs?: number) => Record<string, unknown> }
  const invoke = transport.run.bind(browser)
  const run = vi.spyOn(transport, 'run').mockImplementation((args, timeoutMs) => {
    if (args[0] === 'eval' && args[1] === expression) {
      const sample = samples[Math.min(budgets.length, samples.length - 1)]!
      budgets.push(timeoutMs)
      now += sample.durationMs
      return { result: sample.value }
    }
    return invoke(args, timeoutMs)
  })
  return { budgets, elapsed: () => now, restore: () => { run.mockRestore(); clock.mockRestore() } }
}

describe('AgentBrowser.waitForStable (#415)', () => {
  it.each([
    { name: 'starts after the first probe completes', values: ['ready'], durations: [300, 10, 100, 100], holdMs: 200, probes: 4, endedAt: 510, expected: 'ready' },
    { name: 'restarts after the matching value changes', values: ['old', 'ready'], durations: [300, 10, 100, 100], holdMs: 200, probes: 4, endedAt: 510, expected: 'ready' },
    { name: 'restarts after a miss', values: ['ready', false, 'ready'], durations: [300, 10, 10, 100, 100], holdMs: 200, probes: 5, endedAt: 520, expected: 'ready' },
    { name: 'returns the first matching sample for hold zero', values: ['ready'], durations: [300], holdMs: 0, probes: 1, endedAt: 300, expected: 'ready' },
  ])('completed-sample hold $name without counting earlier CLI latency', scenario => {
    const { browser } = open([])
    let now = 0
    let probes = 0
    const monotonic = vi.spyOn(performance, 'now').mockImplementation(() => now)
    const wallClock = vi.spyOn(Date, 'now').mockImplementation(() => now)
    const run = vi.spyOn(browser as unknown as { run: (args: string[], timeoutMs?: number) => { result: unknown } }, 'run')
      .mockImplementation(() => {
        const index = probes++
        now += scenario.durations[index] ?? 100
        return { result: scenario.values[Math.min(index, scenario.values.length - 1)] }
      })
    try {
      expect(browser.waitForStable('ready()', { holdMs: scenario.holdMs, intervalMs: 0 })).toBe(scenario.expected)
      expect(probes).toBe(scenario.probes)
      expect(now).toBe(scenario.endedAt)
    } finally {
      run.mockRestore(); wallClock.mockRestore(); monotonic.mockRestore()
    }
  })

  it('returns only after the matcher holds across polls spanning holdMs', () => {
    const { browser, commands } = open(['Skills', 'Skills', 'Skills'])
    const start = Date.now()
    let clockReads = 0
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => start + 100 * clockReads++)
    try {
      expect(browser.waitForStable('activeLabel()', { holdMs: 200, intervalMs: 1 })).toBe('Skills')
    } finally {
      clock.mockRestore()
    }
    expect(actions(commands()).filter((action) => action === 'eval').length).toBeGreaterThanOrEqual(2)
  })

  it('a predicate that flips inside the hold window fails the wait, not a later expect', () => {
    shortTimeout()
    const { browser } = open(['Skills', 'Settings'])
    const probes = scriptProbes(browser, 'activeLabel()', [
      { value: 'Skills', durationMs: 100 },
      { value: 'Settings', durationMs: 100 },
    ])
    let error: unknown
    try {
      browser.waitForStable('activeLabel()', { holdMs: 200, intervalMs: 0, matcher: (v) => v === 'Skills' })
    } catch (caught) {
      error = caught
    } finally {
      probes.restore()
    }
    expect(error).toBeInstanceOf(WaitForValueError)
    const failure = error as WaitForValueError
    expect(failure.message).toMatch(/value never stayed stable: activeLabel\(\)/)
    expect(failure.lastValue).toBe('Settings')
    expect(probes.budgets).toEqual([400, 300, 200, 100])
  })
})

describe('AgentBrowser.waitForValue (#409)', () => {
  it('polls evaluate until the matcher passes and returns that sample', () => {
    const { browser, commands } = open([0, 1, 2, 3])
    const value = browser.waitForValue<number>('document.querySelectorAll("li").length', (n) => n >= 2)
    expect(value).toBe(2)
    expect(actions(commands())).toEqual(['eval', 'eval', 'eval'])
  })

  it('without a matcher, waits for a value that is not null, undefined or false', () => {
    const { browser, commands } = open([null, false, 0])
    expect(browser.waitForValue('x')).toBe(0)
    expect(actions(commands())).toEqual(['eval', 'eval', 'eval'])
  })

  it('a sample that throws in the page is a miss, not a failure', () => {
    const { browser } = open([{ error: 'TypeError: null has no properties' }, { x: 1 }])
    expect(browser.waitForValue('document.querySelector("a").getBoundingClientRect()')).toEqual({ x: 1 })
  })

  it('a value that never matches fails through the failure bundle, naming the last sample', () => {
    shortTimeout()
    const { browser, commands, failures } = open([{ ready: false, seen: 'button#other' }])
    const probes = scriptProbes(browser, 'probe()', [
      { value: { ready: false, seen: 'button#other' }, durationMs: 100 },
    ])
    let error: unknown
    try {
      browser.waitForValue<{ ready: boolean }>('probe()', (v) => v.ready, { intervalMs: 0 })
    } catch (caught) {
      error = caught
    } finally {
      probes.restore()
    }
    expect(error).toBeInstanceOf(WaitForValueError)
    const failure = error as WaitForValueError
    expect(failure.message).toMatch(/value never matched: probe\(\)/)
    expect(failure.message).toContain('button#other')
    expect(failure.lastValue).toEqual({ ready: false, seen: 'button#other' })
    expect(failure.bundle.startsWith(join(failures, 'selection-states', 'model-pill-hover-1'))).toBe(true)
    const probe = JSON.parse(readFileSync(join(failure.bundle, 'probe.json'), 'utf8')) as Record<string, unknown>
    expect(probe).toMatchObject({
      kind: 'wait-value',
      expression: 'probe()',
      lastValue: { ready: false, seen: 'button#other' },
      spec: 'selection-states',
    })
    expect(probes.budgets).toEqual([400, 300, 200, 100])
    expect(probes.elapsed()).toBe(400)
    expect(actions(commands())).toEqual(['screenshot', 'snapshot', 'eval'])
    expect(readFileSync(join(failure.bundle, 'screenshot.png'), 'utf8')).toBe('PNG')
    expect(readFileSync(join(failure.bundle, 'snapshot.txt'), 'utf8')).toBe('- button "Tools"')
    expect(probe.captureErrors).toBeUndefined()
  })

  it('a sample that kept throwing reports the page error instead of a value', () => {
    shortTimeout()
    const { browser } = open([{ error: 'ReferenceError: nope' }])
    expect(() => browser.waitForValue('nope()')).toThrow(/ReferenceError: nope/)
  })
})

describe('hoverVisiblePoint (#409)', () => {
  const selector = '[data-slot="assistant-message"] [data-streamdown="link"]'

  it('reads scroll, hit-test and point in one polled expression, then moves the pointer once', () => {
    const { browser, commands } = open([null, null, { x: 10.4, y: 20.6 }])
    hoverVisiblePoint(browser, selector)
    const seen = commands()
    expect(seen[0]).toEqual(['mouse', 'move', '0', '0'])
    expect(seen.slice(1, 4).map(([action]) => action)).toEqual(['eval', 'eval', 'eval'])
    // The point comes from the sample that passed; no second eval recomputes it.
    expect(seen.slice(4)).toEqual([['mouse', 'move', '10', '21']])
    const expression = seen[1]?.[1] ?? ''
    expect(expression).toContain('scrollIntoView')
    expect(expression).toContain('elementFromPoint')
    expect(expression).toContain(JSON.stringify(selector))
  })

  it('a target that never paints a hit-testable point fails naming the selector and the bundle', () => {
    shortTimeout()
    const { browser, commands } = open([null])
    expect(() => hoverVisiblePoint(browser, selector)).toThrow(
      new RegExp(`no visible hover point for .*data-streamdown[\\s\\S]*\\(failure bundle: `),
    )
    expect(actions(commands())).not.toContain('hover')
    expect(commands().filter(([action, sub]) => action === 'mouse' && sub === 'move')).toHaveLength(1)
  })
})

describe('focusWithKeyboard (#409)', () => {
  const selector = 'button[data-slot="model-pill"]'

  it('focuses the visible predecessor, presses Tab, and waits for focus to land on the target', () => {
    const { browser, commands } = open([
      { ready: true, predecessor: 'button#source' },
      { onTarget: false, active: 'button#source' },
      { onTarget: true, active: 'button.model-pill' },
    ])
    focusWithKeyboard(browser, selector)
    expect(actions(commands())).toEqual(['eval', 'press', 'eval', 'eval'])
    expect(commands()[1]).toEqual(['press', 'Tab'])
    // The predecessor filter must refuse what `.focus()` refuses.
    expect(commands()[0]?.[1]).toContain('visibility')
  })

  it('names the element that took focus when the target never receives it', () => {
    shortTimeout()
    const { browser } = open([
      { ready: true, predecessor: 'button#source' },
      { onTarget: false, active: 'a.sidebar-link#tasks' },
    ])
    expect(() => focusWithKeyboard(browser, selector)).toThrow(
      /focus never reached button\[data-slot="model-pill"\]; it is on a\.sidebar-link#tasks/,
    )
  })

  it('a target with no visible predecessor fails after polling, naming the selector', () => {
    shortTimeout()
    const { browser, commands } = open([{ ready: false, predecessor: null }])
    expect(() => focusWithKeyboard(browser, selector)).toThrow(/no visible keyboard predecessor for button/)
    expect(actions(commands())).not.toContain('press')
  })
})

describe('dismissWithEscape (#410)', () => {
  const content = '[data-slot="popover-content"]'
  const focus = '[data-slot="task-columns-trigger"]'

  it('presses Escape, then waits for the content to be gone AND focus to have returned', () => {
    const { browser, commands } = open([])
    dismissWithEscape(browser, { content, focus })
    expect(actions(commands())).toEqual(['press', 'wait'])
    expect(commands()[0]).toEqual(['press', 'Escape'])
    const [, flag, predicate] = commands()[1] ?? []
    expect(flag).toBe('--fn')
    // The absence alone is the race (#410): Radix refocuses the trigger one task AFTER the
    // content unmounts, so the wait must name where focus ends up, not only what disappears.
    expect(predicate).toContain(`document.querySelector(${JSON.stringify(content)}) === null`)
    expect(predicate).toContain(`document.activeElement === document.querySelector(${JSON.stringify(focus)})`)
  })
})

describe('setViewport (#794)', () => {
  it('resizes, then waits for an animation frame that reports the new size', () => {
    const { browser, commands } = open([
      { width: 360, height: 640 },
      { width: 1440, height: 900 },
    ])
    browser.setViewport(1440, 900)
    expect(commands()[0]).toEqual(['set', 'viewport', '1440', '900'])
    expect(actions(commands())).toEqual(['set', 'eval', 'eval'])
    // The breakpoint's `matchMedia` listeners run in the same rendering update, before the
    // frame callbacks: the frame is the signal, not the size alone.
    expect(commands()[1]?.[1]).toContain('requestAnimationFrame')
  })

  it('a page that never renders a frame at the new size fails naming the size', () => {
    shortTimeout()
    const { browser } = open([{ width: 360, height: 640 }])
    expect(() => browser.setViewport(1440, 900)).toThrow(/the page never rendered a frame at 1440x900/)
  })
})


it('bounds a hung CLI probe without charging failure capture to the wait deadline (#764)', () => {
  shortTimeout(100)
  const { browser, commands } = open([{ delayMs: 1500, value: 'ready' }, 'ready'])
  let error: unknown
  try {
    browser.waitForValue('late()', value => value === 'ready', { intervalMs: 0 })
  } catch (caught) {
    error = caught
  }
  // Prove the real subprocess was timed out, rather than relying on the whole call's
  // elapsed time: screenshot, snapshot and diagnostic eval each have a separate budget.
  expect(error).toBeInstanceOf(WaitForValueError)
  expect(error).toMatchObject({ expression: 'late()', cause: { cause: { code: 'ETIMEDOUT' } } })
  const failure = error as WaitForValueError
  expect(failure.lastValue).toBeUndefined()
  expect(actions(commands()).slice(-3)).toEqual(['screenshot', 'snapshot', 'eval'])
  expect(readFileSync(join(failure.bundle, 'screenshot.png'), 'utf8')).toBe('PNG')
  expect(readFileSync(join(failure.bundle, 'snapshot.txt'), 'utf8')).toBe('- button "Tools"')
  const probe = JSON.parse(readFileSync(join(failure.bundle, 'probe.json'), 'utf8')) as Record<string, unknown>
  expect(probe).toMatchObject({ kind: 'wait-value', expression: 'late()', page: 'ready' })
  expect(probe.captureErrors).toBeUndefined()
})

it('rejects a matching sample completed after the deadline even when the CLI returns it (#764)', () => {
  shortTimeout(100)
  const { browser, commands } = open(['diagnostic page'])
  const probes = scriptProbes(browser, 'late()', [
    { value: false, durationMs: 60 },
    { value: 'ready', durationMs: 60 },
  ])
  let error: unknown
  try {
    browser.waitForValue('late()', value => value === 'ready', { intervalMs: 0 })
  } catch (caught) {
    error = caught
  } finally {
    probes.restore()
  }
  expect(error).toBeInstanceOf(WaitForValueError)
  expect(probes.budgets).toEqual([100, 40])
  expect((error as WaitForValueError).lastValue).toBe(false)
  expect(actions(commands())).toEqual(['screenshot', 'snapshot', 'eval'])
  const probe = JSON.parse(readFileSync(join((error as WaitForValueError).bundle, 'probe.json'), 'utf8')) as Record<string, unknown>
  expect(probe).toMatchObject({ kind: 'wait-value', expression: 'late()', lastValue: false, page: 'diagnostic page' })
  expect(probe.captureErrors).toBeUndefined()
})

// #795: first truth, changing geometry, and returned focus may all precede
// settlement. Exercise the real seam hold, including a false assertion value.
it.each([false, 0])('returns the held measurement %s after geometry and focus settle', value => {
  const { browser } = open([])
  const sample = (width: number, focus: number) => ({ layout: { boxes: [[0, 0, width, 44]] }, focus, value })
  const states = [null, sample(20, 1), sample(30, 1), sample(30, 2), sample(30, 2), sample(30, 2)]
  let now = 0
  let probes = 0
  const monotonic = vi.spyOn(performance, 'now').mockImplementation(() => now)
  const pause = vi.spyOn(Atomics, 'wait').mockReturnValue('timed-out')
  const run = vi.spyOn(browser as unknown as { run: (args: string[], timeoutMs?: number) => { result: unknown } }, 'run')
    .mockImplementation(() => { now += 100; return { result: states[probes++] } })
  try {
    expect(waitForSettledSample(browser, String(value))).toBe(value)
    expect(probes).toBe(6) // no second read after the accepted sample
  } finally { run.mockRestore(); pause.mockRestore(); monotonic.mockRestore() }
})

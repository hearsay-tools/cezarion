// @vitest-environment node
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AgentBrowser, WaitForValueError, configureFailureCapture } from '../../e2e/agent-browser'
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
      const result = results[Math.min(n, results.length - 1)]
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

describe('AgentBrowser.waitForStable (#415)', () => {
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
    const start = Date.now()
    let clockReads = 0
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => start + 100 * clockReads++)
    let error: unknown
    try {
      browser.waitForStable('activeLabel()', { holdMs: 200, intervalMs: 1, matcher: (v) => v === 'Skills' })
    } catch (caught) {
      error = caught
    } finally {
      clock.mockRestore()
    }
    expect(error).toBeInstanceOf(WaitForValueError)
    const failure = error as WaitForValueError
    expect(failure.message).toMatch(/value never stayed stable: activeLabel\(\)/)
    expect(failure.lastValue).toBe('Settings')
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
    const start = Date.now()
    let clockReads = 0
    // The initial deadline read starts at zero; each sample's clock read advances one interval.
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => start + 100 * clockReads++)
    let error: unknown
    try {
      browser.waitForValue<{ ready: boolean }>('probe()', (v) => v.ready)
    } catch (caught) {
      error = caught
    } finally {
      clock.mockRestore()
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
    // Sampled more than once before giving up, then captured: screenshot, snapshot, probe eval.
    const seen = actions(commands())
    expect(seen.filter((a) => a === 'eval').length).toBeGreaterThan(2)
    expect(seen.slice(-3)).toEqual(['screenshot', 'snapshot', 'eval'])
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

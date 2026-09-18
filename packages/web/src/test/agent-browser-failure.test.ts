// @vitest-environment node
import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, rmdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  AgentBrowser,
  configureFailureCapture,
  lastAttachedBrowser,
} from '../../e2e/agent-browser'

/**
 * A stand-in `agent-browser` that records every invocation, fails `wait`, and answers the
 * capture commands the way the real CLI does: `screenshot` writes a file at the path it was
 * given, `snapshot -i` returns a tree, `eval` returns the probe object. Only the seam runs, so
 * what these pin is the capture sequence a failed wait triggers (#408) — the evidence every red
 * shard used to leave behind as nothing but `Wait timed out after 25000ms`.
 */
function fakeBrowser() {
  const dir = mkdtempSync(join(tmpdir(), 'cez-fake-agent-browser-failure-'))
  const log = join(dir, 'calls.ndjson')
  const script = join(dir, 'fake.mjs')
  writeFileSync(script, `
    import { appendFileSync, writeFileSync } from 'node:fs'
    const args = process.argv.slice(2)
    appendFileSync(process.env.FAKE_LOG, JSON.stringify(args) + '\\n')
    const command = args[2]
    if (command === 'wait') {
      process.stdout.write(JSON.stringify({ success: false, error: 'Wait timed out after 25000ms' }))
    } else if (command === 'screenshot') {
      writeFileSync(args[3], 'PNG')
      process.stdout.write(JSON.stringify({ success: true, data: { path: args[3] } }))
    } else if (command === 'snapshot') {
      process.stdout.write(JSON.stringify({ success: true, data: { snapshot: '- button "Tools"' } }))
    } else if (command === 'eval') {
      process.stdout.write(JSON.stringify({ success: true, data: { result: { url: 'http://fake/p/x', target: { count: 0 } } } }))
    } else if (command === 'get') {
      process.stdout.write(JSON.stringify({ success: true, data: { url: 'http://fake/p/x' } }))
    } else {
      process.stdout.write(JSON.stringify({ success: true, data: {} }))
    }
  `)
  const bin = join(dir, 'agent-browser')
  writeFileSync(bin, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(script)} "$@"\n`)
  chmodSync(bin, 0o755)
  const failures = join(dir, 'failures')
  configureFailureCapture({ root: failures, spec: 'quick-list', test: 'pencil shows on hover' })
  const browser = AgentBrowser.attach(
    { installed: true, command: bin, version: 'fake', notes: '', runtimeEnv: { FAKE_LOG: log } },
    'failure-test',
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
afterEach(() => {
  // Close before disposing: a seam left open stays on the attached stack and would be what the
  // next test's `lastAttachedBrowser()` finds.
  for (const fake of fakes.splice(0)) {
    fake.browser.close()
    fake.dispose()
  }
  configureFailureCapture({ root: undefined, spec: undefined, test: undefined })
})
function open() {
  const fake = fakeBrowser()
  fakes.push(fake)
  return fake
}

function bundleFrom(error: unknown): string {
  const match = /\(failure bundle: (.+)\)$/.exec(String((error as Error).message))
  if (!match?.[1]) throw new Error(`no bundle in: ${String((error as Error).message)}`)
  return match[1]
}

describe('AgentBrowser failure bundles (#408)', () => {
  it('a timed-out click target captures screenshot, snapshot and probe, then names the bundle', () => {
    const { browser, commands, failures } = open()
    let error: unknown
    try {
      browser.click('[data-slot="never"]')
    } catch (caught) {
      error = caught
    }
    expect(String((error as Error).message)).toMatch(/click target never appeared: \[data-slot="never"\]/)
    const bundle = bundleFrom(error)
    expect(bundle.startsWith(join(failures, 'quick-list', 'pencil-shows-on-hover-1'))).toBe(true)

    expect(commands().map(([action, ...rest]) => (action === 'screenshot' ? [action] : [action, ...rest]))).toEqual([
      ['wait', '[data-slot="never"]'],
      ['screenshot'],
      ['snapshot', '-i'],
      ['eval', expect.stringContaining('[data-slot=\\"never\\"]')],
    ])
    expect(readdirSync(bundle).sort()).toEqual(['probe.json', 'screenshot.png', 'snapshot.txt'])
    expect(readFileSync(join(bundle, 'screenshot.png'), 'utf8')).toBe('PNG')
    expect(readFileSync(join(bundle, 'snapshot.txt'), 'utf8')).toBe('- button "Tools"')
    const probe = JSON.parse(readFileSync(join(bundle, 'probe.json'), 'utf8')) as Record<string, unknown>
    expect(probe).toMatchObject({
      kind: 'wait-selector',
      action: 'click',
      selector: '[data-slot="never"]',
      spec: 'quick-list',
      test: 'pencil shows on hover',
      error: expect.stringContaining('Wait timed out after 25000ms'),
      page: { url: 'http://fake/p/x', target: { count: 0 } },
    })
  })

  it('a timed-out waitForFunction records the predicate without re-running it', () => {
    const { browser, commands } = open()
    let error: unknown
    try {
      browser.waitForFunction('document.querySelector("button").click()')
    } catch (caught) {
      error = caught
    }
    const bundle = bundleFrom(error)
    const probe = JSON.parse(readFileSync(join(bundle, 'probe.json'), 'utf8')) as Record<string, unknown>
    expect(probe).toMatchObject({ kind: 'wait-fn', predicate: 'document.querySelector("button").click()' })
    // A predicate can carry a side effect (thread-scroll clicks inside one), so the probe's
    // `eval` must not contain it: the capture reads the page, it never drives it.
    const probeEval = commands().find(([action]) => action === 'eval')
    expect(probeEval?.[1]).not.toContain('.click()')
    expect(probeEval?.[1]).not.toContain('eval(')
  })

  it('a second capture in the same test gets the next bundle number', () => {
    const { browser, failures } = open()
    const bundles: string[] = []
    for (let i = 0; i < 2; i += 1) {
      try {
        browser.waitForFunction('false')
      } catch (caught) {
        bundles.push(bundleFrom(caught))
      }
    }
    expect(bundles.map((b) => b.slice(failures.length))).toEqual([
      join('/quick-list', 'pencil-shows-on-hover-1'),
      join('/quick-list', 'pencil-shows-on-hover-2'),
    ])
  })

  it('captureTestFailure writes a bundle for an expect failure, once per test', () => {
    const { browser, commands, failures } = open()
    const first = browser.captureTestFailure([new Error('expected 1 to be 2')])
    expect(first).toBe(join(failures, 'quick-list', 'pencil-shows-on-hover-1'))
    expect(existsSync(join(first as string, 'screenshot.png'))).toBe(true)
    const probe = JSON.parse(readFileSync(join(first as string, 'probe.json'), 'utf8')) as Record<string, unknown>
    expect(probe).toMatchObject({ kind: 'test', error: expect.stringContaining('expected 1 to be 2') })
    // The test already has a bundle (a wait failure captured one); the hook must not write a twin.
    expect(browser.captureTestFailure([new Error('again')])).toBeNull()
    expect(commands().filter(([action]) => action === 'screenshot')).toHaveLength(1)
  })

  it('a wait failure followed by the test-failed hook writes one bundle, not two', () => {
    const { browser } = open()
    let bundle = ''
    try {
      browser.waitForFunction('false')
    } catch (caught) {
      bundle = bundleFrom(caught)
    }
    expect(browser.captureTestFailure([new Error('wrapped')])).toBeNull()
    expect(readdirSync(join(bundle, '..'))).toEqual(['pencil-shows-on-hover-1'])
  })

  it('the last attached seam is reachable for the hook and forgotten on close', () => {
    const { browser } = open()
    expect(lastAttachedBrowser()).toBe(browser)
    browser.close()
    expect(lastAttachedBrowser()).toBeNull()
  })

  it('closing a per-test browser hands the hook back to the one the spec still holds', () => {
    // github.e2e.ts keeps its main browser open and attaches a short-lived one per state; its
    // `finally` closes that one before `onTestFailed` runs, so the hook must still find the
    // main browser rather than nothing.
    const main = open().browser
    const perTest = open().browser
    expect(lastAttachedBrowser()).toBe(perTest)
    perTest.close()
    expect(lastAttachedBrowser()).toBe(main)
    main.close()
    expect(lastAttachedBrowser()).toBeNull()
  })

  it('closing browsers out of order forgets only the one closed', () => {
    const first = open().browser
    const second = open().browser
    first.close()
    expect(lastAttachedBrowser()).toBe(second)
    second.close()
    expect(lastAttachedBrowser()).toBeNull()
  })

  it('the bundle root falls back to .ai/qa/failures under the repo root', () => {
    configureFailureCapture({ root: undefined })
    const { browser } = open()
    configureFailureCapture({ root: undefined })
    let error: unknown
    try {
      browser.waitForFunction('false')
    } catch (caught) {
      error = caught
    }
    const bundle = bundleFrom(error)
    expect(bundle).toMatch(/\.ai\/qa\/failures\/quick-list\/pencil-shows-on-hover-\d+$/)
    // Leave the repo as found: drop this test's spec directory, and the root only when this
    // test created it (`rmdirSync` refuses a root holding a developer's real bundles).
    rmSync(join(bundle, '..'), { recursive: true, force: true })
    try {
      rmdirSync(join(bundle, '..', '..'))
    } catch {
      /* not empty: real bundles live here */
    }
  })
})

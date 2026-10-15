// @vitest-environment node
import { chmodSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { AgentBrowser, configureFailureCapture, OPEN_OVERLAY_PROBE } from '../../e2e/agent-browser'

/**
 * A stand-in `agent-browser` that records every invocation and answers `{ success: true }`.
 * Only the seam runs — no Chrome, no daemon — so what these prove is the command sequence the
 * seam emits per operation, which is the whole of the auto-wait contract (#405).
 */
function fakeBrowser(opts: { waitFails?: boolean; tabTarget?: unknown; evalResult?: unknown } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'cez-fake-agent-browser-'))
  const log = join(dir, 'calls.ndjson')
  const script = join(dir, 'fake.mjs')
  writeFileSync(script, `
    import { appendFileSync, writeFileSync } from 'node:fs'
    const args = process.argv.slice(2)
    appendFileSync(process.env.FAKE_LOG, JSON.stringify(args) + '\\n')
    if (process.env.FAKE_WAIT_FAILS === '1' && args[2] === 'wait') {
      process.stdout.write(JSON.stringify({ success: false, error: 'Wait timed out after 25000ms' }))
    } else if (args[2] === 'tab' && args[3] === 'new') {
      process.stdout.write(JSON.stringify({ success: true, data: { targetId: ${JSON.stringify(opts.tabTarget === undefined ? 'target-two' : opts.tabTarget)} } }))
    } else if (args[2] === 'screenshot') {
      writeFileSync(args[args.length - 2], 'png')
      process.stdout.write(JSON.stringify({ success: true, data: {} }))
    } else {
      process.stdout.write(JSON.stringify({ success: true, data: { visible: true, result: ${JSON.stringify(opts.evalResult ?? 0)} } }))
    }
  `)
  const bin = join(dir, 'agent-browser')
  writeFileSync(bin, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(script)} "$@"\n`)
  chmodSync(bin, 0o755)
  // A failed wait writes a failure bundle (#408); keep it under the fake's own directory
  // rather than the repo's `.ai/qa/failures`.
  configureFailureCapture({ root: join(dir, 'failures') })
  const browser = AgentBrowser.attach(
    {
      installed: true,
      command: bin,
      version: 'fake',
      notes: '',
      runtimeEnv: { FAKE_LOG: log, ...(opts.waitFails ? { FAKE_WAIT_FAILS: '1' } : {}) },
    },
    'interact-test',
  )
  /** Each invocation's command, with the `--session <id>` prefix and `--json` suffix stripped. */
  const commands = () =>
    readFileSync(log, 'utf8')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => (JSON.parse(line) as string[]).slice(2, -1))
  return { browser, commands, dir, dispose: () => rmSync(dir, { recursive: true, force: true }) }
}

const fakes: Array<{ dispose: () => void }> = []
afterEach(() => {
  for (const fake of fakes.splice(0)) fake.dispose()
  configureFailureCapture({ root: undefined })
})
function open(opts?: { waitFails?: boolean; tabTarget?: unknown; evalResult?: unknown }) {
  const fake = fakeBrowser(opts)
  fakes.push(fake)
  return fake
}

describe('AgentBrowser auto-wait (#405)', () => {
  it('creates a tab through the provider lifecycle and returns its CDP target', () => {
    const { browser, commands } = open()
    expect(browser.newTab()).toBe('target-two')
    expect(commands()).toEqual([['tab', 'new', 'about:blank']])
  })

  it.each([null, '', 42])('rejects a provider tab result without a usable target: %s', tabTarget => {
    const { browser } = open({ tabTarget })
    expect(() => browser.newTab()).toThrow(/tab.*target/i)
  })

  it('click waits for the selector to appear before clicking it', () => {
    const { browser, commands } = open()
    browser.click('[aria-label="Tools"]')
    expect(commands()).toEqual([
      ['wait', '[aria-label="Tools"]'],
      ['click', '[aria-label="Tools"]'],
    ])
  })

  it('hover waits for the selector before hovering', () => {
    const { browser, commands } = open()
    browser.hover('[data-slot="row"]')
    expect(commands()).toEqual([
      ['wait', '[data-slot="row"]'],
      ['hover', '[data-slot="row"]'],
    ])
  })

  it('fill waits for the selector before filling', () => {
    const { browser, commands } = open()
    browser.fill('#automation-name', 'nightly')
    expect(commands()).toEqual([
      ['wait', '#automation-name'],
      ['fill', '#automation-name', 'nightly'],
    ])
  })

  it('count, isVisible and evaluate assert without waiting', () => {
    const { browser, commands } = open()
    browser.count('[data-slot="drawer"]')
    browser.isVisible('[data-slot="drawer"]')
    browser.evaluate('1 + 1')
    expect(commands().map(([action]) => action)).toEqual(['eval', 'is', 'eval'])
  })

  it('a click target that never appears fails naming the selector, and never clicks', () => {
    const { browser, commands } = open({ waitFails: true })
    expect(() => browser.click('[data-slot="never"]')).toThrow(/click.*\[data-slot="never"\]/)
    const actions = commands().map(([action]) => action)
    expect(actions[0]).toBe('wait')
    expect(actions).not.toContain('click')
    // What follows the failed wait is the failure-bundle capture, pinned in
    // agent-browser-failure.test.ts (#408).
    expect(actions.slice(1)).toEqual(['screenshot', 'snapshot', 'eval'])
  })
})

describe('AgentBrowser screenshots never flip the desktop layout under an overlay (hearsay-tools/cezarion#1046)', () => {
  // agent-browser's `screenshot --full` resizes the window to 1x1 and back; the md breakpoint
  // reads false for that frame and breakpoint-switched subtrees remount, closing dialogs.
  it('captures the viewport by default: no --full, so no resize', () => {
    const { browser, commands, dir } = open()
    const path = browser.screenshot(join(dir, 'shots', 'a.png'))
    expect(commands()).toEqual([['screenshot', path]])
  })

  it('`viewport: false`, the old spelling of full-page, no longer selects --full', () => {
    const { browser, commands, dir } = open()
    const path = browser.screenshot(join(dir, 'shots', 'a.png'), { viewport: false })
    expect(commands()).toEqual([['screenshot', path]])
  })

  it('`full: true` checks for an open overlay first, then captures the whole page', () => {
    const { browser, commands, dir } = open({ evalResult: null })
    const path = browser.screenshot(join(dir, 'shots', 'a.png'), { full: true })
    expect(commands()).toEqual([['eval', OPEN_OVERLAY_PROBE], ['screenshot', '--full', path]])
  })

  it('`full: true` refuses while an overlay is open, and never resizes the window', () => {
    const { browser, commands, dir } = open({ evalResult: '[role="dialog"] <div>' })
    expect(() => browser.screenshot(join(dir, 'shots', 'a.png'), { full: true }))
      .toThrow(/full-page.*overlay is open.*role="dialog"/)
    expect(commands().map(([action]) => action)).toEqual(['eval'])
  })

  it('the overlay probe covers dialogs, menus, popovers and open Radix state', () => {
    for (const selector of ['[role="dialog"]', '[role="alertdialog"]', '[role="menu"]', '[data-radix-popper-content-wrapper]', '[data-state="open"]', ':popover-open']) {
      expect(OPEN_OVERLAY_PROBE).toContain(selector)
    }
  })

  // Deliberately a raw-text match: comments count too. A lexer this side of the TypeScript
  // parser misses real uses (comment markers inside strings or regex literals), while a false
  // positive costs only rewording, so name the full-page flag in prose without quoting it.
  it('no spec or helper reaches --full except through the guarded seam', () => {
    const e2eDir = join(import.meta.dirname, '../../e2e')
    const offenders = readdirSync(e2eDir)
      .filter((name) => name.endsWith('.ts') && name !== 'agent-browser.ts')
      .filter((name) => /['"`]--full\b/.test(readFileSync(join(e2eDir, name), 'utf8')))
    expect(offenders).toEqual([])
    const seam = readFileSync(join(e2eDir, 'agent-browser.ts'), 'utf8')
    expect(seam.match(/'--full'/g)).toHaveLength(1)
  })
})

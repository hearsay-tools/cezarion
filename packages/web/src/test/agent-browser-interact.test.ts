// @vitest-environment node
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { AgentBrowser, configureFailureCapture } from '../../e2e/agent-browser'

/**
 * A stand-in `agent-browser` that records every invocation and answers `{ success: true }`.
 * Only the seam runs — no Chrome, no daemon — so what these prove is the command sequence the
 * seam emits per operation, which is the whole of the auto-wait contract (#405).
 */
function fakeBrowser(opts: { waitFails?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'cez-fake-agent-browser-'))
  const log = join(dir, 'calls.ndjson')
  const script = join(dir, 'fake.mjs')
  writeFileSync(script, `
    import { appendFileSync } from 'node:fs'
    const args = process.argv.slice(2)
    appendFileSync(process.env.FAKE_LOG, JSON.stringify(args) + '\\n')
    if (process.env.FAKE_WAIT_FAILS === '1' && args[2] === 'wait') {
      process.stdout.write(JSON.stringify({ success: false, error: 'Wait timed out after 25000ms' }))
    } else {
      process.stdout.write(JSON.stringify({ success: true, data: { visible: true, result: 0 } }))
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
  return { browser, commands, dispose: () => rmSync(dir, { recursive: true, force: true }) }
}

const fakes: Array<{ dispose: () => void }> = []
afterEach(() => {
  for (const fake of fakes.splice(0)) fake.dispose()
  configureFailureCapture({ root: undefined })
})
function open(opts?: { waitFails?: boolean }) {
  const fake = fakeBrowser(opts)
  fakes.push(fake)
  return fake
}

describe('AgentBrowser auto-wait (#405)', () => {
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

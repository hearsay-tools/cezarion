// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { browserSpawnPlan } from '../../e2e/agent-browser'

describe('browserSpawnPlan', () => {
  it('passes the resolved container args and keeps a short caller TMPDIR', () => {
    const plan = browserSpawnPlan(
      {
        installed: true,
        command: '/cache/agent-browser',
        version: 'test',
        notes: '',
        launchArgs: ['--no-sandbox'],
        runtimeEnv: { TMPDIR: '/tmp', TMP: '/tmp', TEMP: '/tmp' },
        namespace: 'cez-e2e',
      },
      'smoke',
      ['open', 'about:blank'],
      { PATH: '/bin' },
    )
    expect(plan.argv).toEqual([
      '--namespace', 'cez-e2e',
      '--args', '--no-sandbox',
      '--session', 'smoke',
      'open', 'about:blank',
      '--json',
    ])
    expect(plan.env).toEqual({ PATH: '/bin' })
  })

  // hearsay-tools/cezarion#1090: the descriptor's runtimeEnv is the BOOTER's answer.
  // The caller that launches Chrome decides from its own TMPDIR.
  it('rewrites an over-budget caller TMPDIR even when the booter saved no runtimeEnv', () => {
    const long = `/home/agent/projects/cezar/.ai/cezar/tmp/${'x'.repeat(80)}`
    const plan = browserSpawnPlan(
      { installed: true, command: 'agent-browser', version: 'test', notes: '', namespace: 'cez-e2e' },
      'smoke',
      ['open', 'about:blank'],
      { PATH: '/bin', TMPDIR: long, TMP: long, TEMP: long },
    )
    expect(plan.env).toMatchObject({ PATH: '/bin', TMPDIR: '/tmp', TMP: '/tmp', TEMP: '/tmp' })
  })

  it('keeps a short caller TMPDIR even when the booter saved a /tmp runtimeEnv', () => {
    const plan = browserSpawnPlan(
      {
        installed: true,
        command: 'agent-browser',
        version: 'test',
        notes: '',
        runtimeEnv: { TMPDIR: '/tmp', TMP: '/tmp', TEMP: '/tmp' },
        namespace: 'cez-e2e',
      },
      'smoke',
      ['open', 'about:blank'],
      { PATH: '/bin', TMPDIR: '/tmp/cez-e2e-lane', TMP: '/tmp/cez-e2e-lane', TEMP: '/tmp/cez-e2e-lane' },
    )
    expect(plan.env).toMatchObject({ TMPDIR: '/tmp/cez-e2e-lane', TMP: '/tmp/cez-e2e-lane', TEMP: '/tmp/cez-e2e-lane' })
  })

  it('still applies runtimeEnv keys other than the temp dirs', () => {
    const plan = browserSpawnPlan(
      {
        installed: true,
        command: 'agent-browser',
        version: 'test',
        notes: '',
        runtimeEnv: { TMPDIR: '/tmp', AGENT_BROWSER_SOCKET_DIR: '/tmp/cez-tab-x', AGENT_BROWSER_NAMESPACE: '' },
      },
      'tab-lifecycle',
      ['open', 'about:blank'],
      { PATH: '/bin', TMPDIR: '/tmp/short' },
    )
    expect(plan.env).toEqual({
      PATH: '/bin',
      TMPDIR: '/tmp/short',
      AGENT_BROWSER_SOCKET_DIR: '/tmp/cez-tab-x',
      AGENT_BROWSER_NAMESPACE: '',
    })
  })

  it('omits chrome flags on a sandboxed desktop descriptor', () => {
    const plan = browserSpawnPlan(
      {
        installed: true,
        command: '/usr/bin/agent-browser',
        version: 'test',
        notes: '',
        launchArgs: [],
        namespace: 'cez-e2e',
      },
      'desktop',
      ['snapshot', '-i'],
      { PATH: '/bin' },
    )
    expect(plan.argv).toEqual([
      '--namespace', 'cez-e2e',
      '--session', 'desktop',
      'snapshot', '-i',
      '--json',
    ])
    expect(plan.env.TMPDIR).toBeUndefined()
  })
})

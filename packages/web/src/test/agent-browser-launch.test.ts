// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { browserSpawnPlan } from '../../e2e/agent-browser'
import { captureLaunchArguments, sessionLaunchArguments } from '../../e2e/browser-launch'

describe('provider launch configuration', () => {
  it('preserves descriptor entries and raw environment arguments without deduplication', () => {
    const descriptor = ['--no-sandbox', '--window-position=800,600', '--no-sandbox']
    const extra = '--window-size=800,600,--window-position=800,600\n--no-sandbox\r--disable-features=A,B'
    expect(sessionLaunchArguments({ launchArgs: descriptor }, { AGENT_BROWSER_ARGS: extra })).toEqual([...descriptor, extra])
    const plan = browserSpawnPlan(
      { installed: true, command: 'agent-browser', version: 'test', notes: '', launchArgs: descriptor },
      'environment-test', ['open', 'about:blank'], { AGENT_BROWSER_ARGS: extra },
    )
    expect(plan.argv.slice(0, 2)).toEqual(['--args', [...descriptor, extra].join(',')])
    expect(captureLaunchArguments({ launchArgs: descriptor }, { AGENT_BROWSER_ARGS: extra })).toEqual([...descriptor, extra])
  })

  it('preserves comma-valued and newline-separated config flags for the provider parser', () => {
    const home = mkdtempSync(join(tmpdir(), 'cez-launch-config-'))
    try {
      const config = join(home, 'explicit.json')
      const args = '--window-size=800,600,--window-position=800,600\n--disable-features=A,B'
      writeFileSync(config, JSON.stringify({ args }))
      const launchArgs = captureLaunchArguments({}, { AGENT_BROWSER_CONFIG: config })
      expect(launchArgs).toEqual([args])
      const plan = browserSpawnPlan(
        { installed: true, command: 'agent-browser', version: 'test', notes: '', launchArgs },
        'config-test', ['open', 'about:blank'], { AGENT_BROWSER_ARGS: '' },
      )
      expect(plan.argv.slice(0, 2)).toEqual(['--args', args])
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  it('keeps user config args, explicit config precedence, and explicit empty overrides', () => {
    const home = mkdtempSync(join(tmpdir(), 'cez-launch-config-'))
    try {
      mkdirSync(join(home, '.agent-browser'))
      writeFileSync(join(home, '.agent-browser', 'config.json'), JSON.stringify({ args: '--user-flag' }))
      const explicit = join(home, 'explicit.json')
      writeFileSync(explicit, JSON.stringify({ args: '--explicit-flag' }))
      const env = { HOME: home }
      expect(captureLaunchArguments({}, env)).toEqual(['--user-flag'])
      expect(captureLaunchArguments({}, { ...env, AGENT_BROWSER_CONFIG: explicit })).toEqual(['--explicit-flag'])
      expect(captureLaunchArguments({}, { ...env, AGENT_BROWSER_ARGS: '' })).toEqual([])
      expect(captureLaunchArguments({ launchArgs: ['--descriptor'] }, env)).toEqual(['--descriptor'])
      expect(captureLaunchArguments({}, { ...env, AGENT_BROWSER_ARGS: '--environment' })).toEqual(['--environment'])
      writeFileSync(explicit, '{')
      expect(() => captureLaunchArguments({}, { ...env, AGENT_BROWSER_CONFIG: explicit })).toThrow('cannot read agent-browser config')
      writeFileSync(join(home, '.agent-browser', 'config.json'), '{')
      expect(captureLaunchArguments({}, env)).toEqual([])
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })
})

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

// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { browserSpawnPlan } from '../../e2e/agent-browser'

describe('browserSpawnPlan', () => {
  it('passes the same resolved container args and runtime path that doctor used', () => {
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
    expect(plan.env.TMPDIR).toBe('/tmp')
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

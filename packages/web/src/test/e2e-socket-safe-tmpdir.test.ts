// @vitest-environment node
import { existsSync, rmSync } from 'node:fs'
import { afterEach, describe, expect, it } from 'vitest'
import { CHROME_SINGLETON_OVERHEAD, UNIX_SOCKET_MAX } from '../../../../.ai/scripts/resolve-browser-launch.mjs'
import { useSocketSafeTmpdir } from '../../e2e/environment'

// hearsay-tools/cezarion#1090: the e2e globalSetup gives Chrome a short TMPDIR from its own
// caller's env, never the shared test env descriptor's.
const long = `/home/agent/projects/cezar/.ai/cezar/tmp/${'x'.repeat(80)}`
const created: string[] = []

afterEach(() => {
  for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('useSocketSafeTmpdir', () => {
  it('points every temp variable at a fresh short directory and restores them on release', () => {
    const env: NodeJS.ProcessEnv = { PATH: '/bin', TMPDIR: long, TMP: long }
    const release = useSocketSafeTmpdir(env, 'linux')
    const dir = env.TMPDIR as string
    created.push(dir)
    expect(dir.startsWith('/tmp/cez-e2e-')).toBe(true)
    expect(existsSync(dir)).toBe(true)
    expect(env.TMP).toBe(dir)
    expect(env.TEMP).toBe(dir)
    expect(Buffer.byteLength(dir) + CHROME_SINGLETON_OVERHEAD).toBeLessThanOrEqual(UNIX_SOCKET_MAX)

    release()
    expect(existsSync(dir)).toBe(false)
    expect(env).toEqual({ PATH: '/bin', TMPDIR: long, TMP: long })
    expect('TEMP' in env).toBe(false)
  })

  it('leaves a short TMPDIR untouched and creates nothing', () => {
    const env: NodeJS.ProcessEnv = { PATH: '/bin', TMPDIR: '/tmp/short' }
    const release = useSocketSafeTmpdir(env, 'linux')
    expect(env).toEqual({ PATH: '/bin', TMPDIR: '/tmp/short' })
    release()
    expect(env).toEqual({ PATH: '/bin', TMPDIR: '/tmp/short' })
  })

  it('is a no-op on Windows', () => {
    const env: NodeJS.ProcessEnv = { TMPDIR: long, TMP: long, TEMP: long }
    const release = useSocketSafeTmpdir(env, 'win32')
    expect(env).toEqual({ TMPDIR: long, TMP: long, TEMP: long })
    release()
    expect(env).toEqual({ TMPDIR: long, TMP: long, TEMP: long })
  })
})

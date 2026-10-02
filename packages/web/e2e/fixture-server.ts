import type { ChildProcess } from 'node:child_process'

/** Stop a spec-owned server before removing the directory it may still be writing. */
export async function stopFixtureServer(child: ChildProcess | undefined, timeoutMs = 5_000): Promise<void> {
  if (!child || child.exitCode !== null || child.signalCode !== null) return

  await new Promise<void>((resolve, reject) => {
    let forceTimer: ReturnType<typeof setTimeout> | undefined
    const cleanup = () => {
      clearTimeout(graceTimer)
      if (forceTimer) clearTimeout(forceTimer)
      child.off('exit', onExit)
      child.off('error', onError)
    }
    const onExit = () => { cleanup(); resolve() }
    const onError = (error: Error) => { cleanup(); reject(error) }
    child.once('exit', onExit)
    child.once('error', onError)
    const graceTimer = setTimeout(() => {
      child.kill('SIGKILL')
      forceTimer = setTimeout(() => {
        cleanup()
        reject(new Error('Fixture server did not exit after SIGKILL'))
      }, timeoutMs)
    }, timeoutMs)
    child.kill('SIGTERM')
  })
}


/** Drain piped output immediately and retain a bounded tail even before browser setup exists. */
export function captureFixtureServer(child: ChildProcess, outputLimit = 16_384) {
  const startedAt = Date.now()
  const lifecycle: Array<{ kind: string; elapsedMs: number; detail?: string }> = []
  const event = (kind: string, detail?: string) => {
    lifecycle.push({ kind, elapsedMs: Date.now() - startedAt, ...(detail === undefined ? {} : { detail }) })
    if (lifecycle.length > 16) lifecycle.shift()
  }
  let stdout = '', stderr = '', stdoutDropped = 0, stderrDropped = 0
  child.stdout?.on('data', chunk => {
    const next = stdout + String(chunk)
    stdoutDropped += Math.max(0, next.length - outputLimit)
    stdout = next.slice(-outputLimit)
  })
  child.stderr?.on('data', chunk => {
    const next = stderr + String(chunk)
    stderrDropped += Math.max(0, next.length - outputLimit)
    stderr = next.slice(-outputLimit)
  })
  child.once('spawn', () => event('spawn'))
  child.on('error', error => event('error', String(error).slice(0, outputLimit)))
  child.once('exit', (code, signal) => event('exit', `code=${code} signal=${signal}`))
  child.once('close', (code, signal) => event('close', `code=${code} signal=${signal}`))
  return () => ({
    pid: child.pid ?? null, spawnfile: child.spawnfile, spawnargs: child.spawnargs,
    elapsedMs: Date.now() - startedAt, exitCode: child.exitCode, signalCode: child.signalCode,
    lifecycle: [...lifecycle], stdout, stderr, stdoutDropped, stderrDropped,
  })
}

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

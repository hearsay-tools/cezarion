import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { AgentBrowser, readTestEnv } from './agent-browser'

/** A private provider daemon whose next native tab command releases a held target drain. */
export function createHeldBrowserDaemon(launchArgs: string[] = []) {
  // Hold only this test's daemon, so raw CDP cannot depend on its background target drain.
  // The wrapper releases it on the next provider command, simulating delayed initialization
  // without a sleep. A provider-owned tab waits for initialization; raw creation bypasses it.
  const root = mkdtempSync('/tmp/cez-tab-')
  const session = 'tab-lifecycle'
  const provider = readTestEnv().browser
  const wrapper = join(root, 'browser.mjs')
  const pidFile = join(root, `${session}.pid`)
  writeFileSync(wrapper, `#!${process.execPath}
import { readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
const args = process.argv.slice(2)
const command = args.indexOf('--session') + 2
if (args[command] === 'tab' && args[command + 1] === 'new') {
  process.kill(Number(readFileSync(${JSON.stringify(pidFile)}, 'utf8')), 'SIGCONT')
}
const child = spawnSync(${JSON.stringify(provider.command)}, args, { stdio: 'inherit', env: process.env })
process.exit(child.status ?? 1)
`)
  chmodSync(wrapper, 0o755)
  const browser = AgentBrowser.attach({
    ...provider, command: wrapper, namespace: undefined,
    launchArgs: [...(provider.launchArgs ?? []), ...launchArgs],
    runtimeEnv: { ...provider.runtimeEnv, AGENT_BROWSER_SOCKET_DIR: root, AGENT_BROWSER_NAMESPACE: '' },
  }, session)
  let daemonPid: number | undefined
  return {
    browser,
    hold: () => {
      daemonPid = Number(readFileSync(pidFile, 'utf8'))
      process.kill(daemonPid, 'SIGSTOP')
    },
    close: () => {
      // Always release this owned daemon before its provider's graceful close.
      if (daemonPid) process.kill(daemonPid, 'SIGCONT')
      browser.close()
      rmSync(root, { recursive: true, force: true })
    },
  }
}

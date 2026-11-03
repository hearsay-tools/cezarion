import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** agent-browser v0.39.4 ignores args in auto-discovered project config. */
export function captureLaunchArguments(browser: { launchArgs?: string[] | undefined }, env: NodeJS.ProcessEnv): string[] {
  if (browser.launchArgs?.length || env.AGENT_BROWSER_ARGS !== undefined) return sessionLaunchArguments(browser, env)
  const explicit = env.AGENT_BROWSER_CONFIG
  const path = explicit ?? join(env.HOME ?? homedir(), '.agent-browser', 'config.json')
  let args: string | null | undefined
  try {
    const config: unknown = JSON.parse(readFileSync(path, 'utf8'))
    if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error('invalid config')
    const value = 'args' in config ? config.args : undefined
    if (value != null && typeof value !== 'string') throw new Error('invalid args')
    args = value
  } catch {
    if (explicit !== undefined) throw new Error(`cezar e2e: cannot read agent-browser config: ${path}`)
  }
  return args ? [args] : []
}

export function sessionLaunchArguments(browser: { launchArgs?: string[] | undefined }, env: NodeJS.ProcessEnv): string[] {
  const extra = env.AGENT_BROWSER_ARGS
  return [...(browser.launchArgs ?? []), ...(extra ? [extra] : [])]
}


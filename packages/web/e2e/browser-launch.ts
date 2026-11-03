export function sessionLaunchArguments(browser: { launchArgs?: string[] | undefined }, env: NodeJS.ProcessEnv): string[] {
  const extra = (env.AGENT_BROWSER_ARGS ?? '')
    .split(/[,\n]/)
    .map((part) => part.trim())
    .filter(Boolean)
  const launchArgs = [...(browser.launchArgs ?? [])]
  for (const arg of extra) if (!launchArgs.includes(arg)) launchArgs.push(arg)
  return launchArgs
}


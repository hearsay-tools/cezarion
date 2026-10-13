import { expect, it } from 'vitest'
import { createHeldBrowserDaemon } from './held-browser-daemon'
import { pollFor } from './poll'

it.skipIf(process.platform === 'win32').each([
  { source: 'none', launchArgs: [], ambientArgs: false },
  { source: 'descriptor', launchArgs: ['--no-sandbox'], ambientArgs: false },
  { source: 'environment', launchArgs: [], ambientArgs: true },
])('initializes a native tab before a separate CDP client navigates it (launch flags: $source)', async ({ launchArgs, ambientArgs }) => {
  const previousArgs = process.env.AGENT_BROWSER_ARGS
  if (ambientArgs) process.env.AGENT_BROWSER_ARGS = [previousArgs, '--no-sandbox'].filter(Boolean).join(',')
  const fixture = createHeldBrowserDaemon(launchArgs)
  const { browser } = fixture
  try {
    browser.goto('about:blank')
    await browser.withCdp(async request => {
      fixture.hold()
      const targetId = browser.newTab()
      const { sessionId } = await request('Target.attachToTarget', { targetId, flatten: true })
      const navigation = await request('Page.navigate', { url: 'data:text/html,<title>Initialized tab</title>' }, sessionId)
      expect(navigation.errorText).toBeUndefined()
      const title = await pollFor(async () => {
        const sample = await request('Runtime.evaluate', { expression: 'document.title', returnByValue: true }, sessionId)
        return sample.result.value === 'Initialized tab' ? sample.result.value : undefined
      }, () => 'the initialized tab did not commit navigation')
      expect(title).toBe('Initialized tab')
    })
  } finally {
    try { fixture.close() } finally {
      if (previousArgs === undefined) delete process.env.AGENT_BROWSER_ARGS
      else process.env.AGENT_BROWSER_ARGS = previousArgs
    }
  }
}, 30_000)

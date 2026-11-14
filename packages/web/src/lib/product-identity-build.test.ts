// @vitest-environment node
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { build, type Plugin, type Rollup } from 'vite'
import { describe, expect, it, vi } from 'vitest'
import { productIdentityPlugin, readProductIdentity } from '../../product-identity'

vi.mock('node:child_process', async importOriginal => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  return { ...actual, execFileSync: vi.fn(actual.execFileSync) }
})

const root = fileURLToPath(new URL('../../', import.meta.url))

/** Keep the real HTML shell, but isolate its build from unrelated application chunks. */
const shellEntry: Plugin = {
  name: 'shell-entry-fixture',
  enforce: 'pre',
  resolveId: id => id.endsWith('/src/main.tsx') ? '\0shell-entry' : undefined,
  load: id => id === '\0shell-entry' ? 'globalThis.cockpitReady = true' : undefined,
}

async function builtHtml(plugins: Plugin[]): Promise<string> {
  const bundle = await build({
    configFile: false, root, logLevel: 'silent', plugins: [shellEntry, ...plugins],
    build: { write: false, minify: false },
  }) as Rollup.RolldownOutput
  const html = bundle.output.find(asset => asset.fileName === 'index.html')
  if (!html || html.type !== 'asset') throw new Error('build did not emit index.html')
  return String(html.source)
}

describe('product identity in the HTML build', () => {
  it('fails the build when the metadata command fails or returns an invalid shape', () => {
    vi.mocked(execFileSync).mockImplementationOnce(() => { throw new Error('identity command failed') })
    expect(() => productIdentityPlugin()).toThrow('identity command failed')
    vi.mocked(execFileSync).mockReturnValueOnce(Buffer.from('{}'))
    expect(() => productIdentityPlugin()).toThrow('invalid display metadata')
  })

  it('builds the title from the shared metadata', async () => {
    const identity = readProductIdentity()
    expect(await builtHtml([productIdentityPlugin()])).toContain(`<title>${identity.displayName}</title>`)
  })
})

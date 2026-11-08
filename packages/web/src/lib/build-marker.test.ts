import { expect, it, vi } from 'vitest'
import { e2eBuildMarker } from '../../vite.config.ts'

it.each([
  [{VITE_HSQ_E2E: '1', VITE_CEZ_E2E: '0'}, true],
  [{VITE_HSQ_E2E: '', VITE_CEZ_E2E: '1'}, false],
  [{VITE_CEZ_E2E: 'true'}, true],
  [{}, false],
])('Vite marker follows the compiled E2E flag with %j', (env, enabled) => {
  const plugin = e2eBuildMarker()
  const resolved = plugin.configResolved as (config: {env: Record<string, string>}) => void
  const generate = plugin.generateBundle as unknown as (this: {emitFile: ReturnType<typeof vi.fn>}) => void
  const emitFile = vi.fn()
  resolved({env})
  generate.call({emitFile})
  expect(emitFile).toHaveBeenCalledTimes(enabled ? 1 : 0)
  if (enabled) expect(emitFile).toHaveBeenCalledWith({type: 'asset', fileName: '.cez-e2e-build', source: 'e2e\n'})
})

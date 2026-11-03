import { checkWorkspaceResolution } from '../../scripts/check-workspace-resolution.mjs'
import { defineConfig, mergeConfig } from 'vitest/config'

checkWorkspaceResolution()

// Keep plugin imports behind the install check, including when Vite bundles this config.
const { default: viteConfig } = await import(new URL('./vite.config.ts', import.meta.url).href)

// Reuse the build config verbatim (root, React plugin, `@` → packages/web/src) and only add the
// test layer, so a component under test resolves its imports exactly like the shipped bundle.
export default mergeConfig(
  viteConfig,
  defineConfig({
    test: {
      name: 'web',
      environment: 'jsdom',
      // Node 26 exposes undefined localStorage without --localstorage-file. Disable
      // the Node globals so Vitest installs jsdom's per-window storage instead
      // (hearsay-tools/cezarion#2454). Node 24 accepts this flag too.
      execArgv: ['--no-experimental-webstorage'],
      setupFiles: ['./vitest.setup.ts'],
      include: ['src/**/*.test.{ts,tsx}'],
    },
  }),
)

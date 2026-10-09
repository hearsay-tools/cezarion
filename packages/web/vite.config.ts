import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig, type Plugin } from 'vite'

const appDir = dirname(fileURLToPath(import.meta.url))
const packagesDir = resolve(appDir, '..')

// The cockpit server (packages/cezar/src/server/server.ts) owns /api and serves the built app.
// `npm run dev` (scripts/dev.mjs) picks a free port and pins both processes to it via
// CEZ_API_PORT, so a stray cockpit already sitting on 4321 (another repo, an older install)
// can never end up behind the proxy. Standalone `npm run dev:web` keeps the 4321 default.
const API_TARGET = `http://127.0.0.1:${process.env.CEZ_API_PORT ?? 4321}`

// React DOM is large enough to push the otherwise route-split entry chunk over Vite's 500 kB
// warning threshold. Keep the tightly coupled React runtime in one stable, cacheable chunk
// rather than silencing the warning: future growth in either the app or vendor chunk stays
// visible. Module ids from Vite/Rolldown use forward slashes on every platform.
export const reactRuntimeChunk = {
  name: 'react-runtime',
  test: /node_modules\/(?:react(?:-dom)?|scheduler)\//,
}

function e2eBuildMarker(): Plugin {
  let e2eBuild = false
  return {
    name: 'cez-e2e-build-marker',
    apply: 'build' as const,
    configResolved(config) {
      // Read Vite's resolved env, the same value compiled into isCockpitE2e().
      const value = config.env.VITE_CEZ_E2E
      e2eBuild = value === '1' || value === 'true'
    },
    generateBundle() {
      // #649: a later production build empties outDir and removes this proof of the e2e bundle.
      if (e2eBuild) this.emitFile({ type: 'asset', fileName: '.cez-e2e-build', source: 'e2e\n' })
    },
  }
}

export default defineConfig({
  root: appDir,
  base: '/',
  // Tailwind v4 is CSS-first: the whole theme lives in src/styles/index.css, there is no tailwind.config.js.
  plugins: [react(), tailwindcss(), e2eBuildMarker()],
  // `@/…` → packages/web/src — the alias shadcn/ui components import `cn` through. Mirrored in
  // tsconfig.json `paths`.
  //
  // The api-client resolves to its SOURCE, not to its published `dist`. The package builds
  // (for Node consumers and for npm) but nothing in the web toolchain should have to wait for
  // that build: aliasing to source keeps `npm run dev` a single step and gives HMR when the
  // contract changes. Vite maps the package's internal `./x.ts` specifiers directly. Mirrored
  // in tsconfig.json `paths`.
  resolve: {
    alias: {
      '@': resolve(appDir, 'src'),
      '@open-mercato/cezar-api-client': resolve(packagesDir, 'api-client/src/index.ts'),
    },
  },
  build: {
    // Built INTO the server package, because the CLI ships and serves it: `resolveWebDir()`
    // looks for `<pkg>/web/dist` next to its own `dist/`, and `files` puts it in the tarball.
    // A cross-package output is the honest expression of that coupling — the cockpit bundle is
    // an artifact of the service, not a separately shipped thing.
    outDir: resolve(packagesDir, 'cezar/web/dist'),
    emptyOutDir: true,
    rolldownOptions: {
      input: { index: resolve(appDir, 'index.html'), 'live-worker': resolve(appDir, 'src/api/live-worker.ts') },
      output: {
        entryFileNames: chunk => chunk.name === 'live-worker' ? 'live-worker.js' : 'assets/[name]-[hash].js',
        codeSplitting: {
          groups: [reactRuntimeChunk],
        },
      },
    },
  },
  server: {
    proxy: {
      // `ws: true` — /api/ws (the subscription socket) upgrades through the same proxy.
      '/api': { target: API_TARGET, changeOrigin: true, ws: true },
    },
  },
})

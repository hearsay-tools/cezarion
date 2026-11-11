import { execFileSync } from 'node:child_process'
import { fileURLToPath, URL as NodeURL } from 'node:url'
import type { Plugin } from 'vite'

export interface DisplayIdentity {
  rebrand: boolean
  displayName: string
  command: string
  npx: string
  npmPackage: string
}

/** Read the service's single source at build time, without bundling its package. */
export function readProductIdentity(rebrand?: boolean): DisplayIdentity {
  // Keep this Node-only script path out of Vite's browser asset URL transform.
  const script = fileURLToPath(new NodeURL('../cezar/scripts/product-identity.mjs', import.meta.url))
  const args = rebrand === undefined ? [] : ['--rebrand', rebrand ? 'on' : 'off']
  const identity: DisplayIdentity = JSON.parse(execFileSync(process.execPath, [script, ...args], { encoding: 'utf8' }))
  if (typeof identity.rebrand !== 'boolean' || typeof identity.displayName !== 'string'
    || typeof identity.command !== 'string' || typeof identity.npx !== 'string' || typeof identity.npmPackage !== 'string') {
    throw new Error('product-identity.mjs returned invalid display metadata')
  }
  return { rebrand: identity.rebrand, displayName: identity.displayName, command: identity.command, npx: identity.npx, npmPackage: identity.npmPackage }
}

export function productIdentityPlugin(rebrand?: boolean): Plugin {
  const identity = readProductIdentity(rebrand)
  return {
    name: 'product-display-identity',
    config: () => ({ define: { __PRODUCT_IDENTITY__: JSON.stringify(identity) } }),
    transformIndexHtml: html => identity.rebrand
      ? html.replace('<title>cezar</title>', `<title>${identity.displayName}</title>`)
      : html,
  }
}

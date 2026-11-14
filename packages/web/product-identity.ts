import { execFileSync } from 'node:child_process'
import { fileURLToPath, URL as NodeURL } from 'node:url'
import type { Plugin } from 'vite'

export interface DisplayIdentity {
  displayName: string
  command: string
  npx: string
}

/** Read the service's single source at build time, without bundling its package. */
export function readProductIdentity(): DisplayIdentity {
  // Keep this Node-only script path out of Vite's browser asset URL transform.
  const script = fileURLToPath(new NodeURL('../cezar/scripts/product-identity.mjs', import.meta.url))
  const identity: DisplayIdentity = JSON.parse(execFileSync(process.execPath, [script], { encoding: 'utf8' }))
  if (typeof identity.displayName !== 'string' || typeof identity.command !== 'string' || typeof identity.npx !== 'string') {
    throw new Error('product-identity.mjs returned invalid display metadata')
  }
  return { displayName: identity.displayName, command: identity.command, npx: identity.npx }
}

export function productIdentityPlugin(): Plugin {
  const identity = readProductIdentity()
  return {
    name: 'product-display-identity',
    config: () => ({ define: { __PRODUCT_IDENTITY__: JSON.stringify(identity) } }),
    transformIndexHtml: html => html.replace('<title>cezar</title>', `<title>${identity.displayName}</title>`),
  }
}

import type { PreviewServer } from '@open-mercato/cezar-api-client'

/**
 * What the address field turns into. A bare port is the owner's shorthand: a registered one opens
 * that server (so its approval flow applies), any other becomes `http://localhost:<port>`. The
 * server validates the URL again; this only keeps an obvious refusal from costing a round trip.
 */
export type PreviewAddress =
  | { kind: 'server'; port: number }
  | { kind: 'url'; url: string }
  | { kind: 'error'; message: string }

const SCHEME = /^([a-z][a-z0-9+.-]*):/i

export function resolveAddress(input: string, servers: readonly PreviewServer[]): PreviewAddress {
  const text = input.trim()
  if (text === '') return { kind: 'error', message: 'Type a URL or a port.' }
  if (/^\d{1,5}$/.test(text)) {
    const port = Number(text)
    if (port < 1 || port > 65535) return { kind: 'error', message: 'A port is a number from 1 to 65535.' }
    return servers.some(server => server.port === port)
      ? { kind: 'server', port }
      : { kind: 'url', url: `http://localhost:${port}` }
  }
  // `localhost:3000` parses as the scheme `localhost`; it is a host and a port.
  const scheme = SCHEME.exec(text)?.[1]?.toLowerCase()
  if (scheme && !/^[a-z0-9.-]+:\d/i.test(text)) {
    if (scheme !== 'http' && scheme !== 'https') return { kind: 'error', message: 'Only http and https addresses open here.' }
    return { kind: 'url', url: text }
  }
  return { kind: 'url', url: `http://${text}` }
}

/** `http://localhost:5173/members` as the field shows it when it is not being edited. */
export function displayUrl(url: string): string {
  return url.replace(/^https?:\/\//i, '')
}

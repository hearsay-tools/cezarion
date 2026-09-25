/** How the cockpit names a task webhook (#589): host and path, never the query string or any
 *  credentials in the URL, which may carry a secret the user would rather not have on screen.
 *  Falls back to the input when it does not parse. */
export function webhookLabel(url: string): string {
  try {
    const parsed = new URL(url)
    const path = parsed.pathname === '/' ? '' : parsed.pathname.replace(/\/$/, '')
    return `${parsed.host}${path}` || url
  } catch {
    return url
  }
}

/**
 * The preview URL bar's one rule (#781, spec 2026-10-02-live-preview-v1): a bare port means the
 * host's localhost, an address without a scheme means `http://`, and only http(s) reaches Chromium.
 * `javascript:`, `file:`, `chrome:` and `data:` would turn the URL bar into a way past the page.
 */
export function normalizePreviewUrl(input: string): string {
  const text = input.trim();
  if (/^\d+$/.test(text)) return new URL(`http://localhost:${text}/`).href;
  // `localhost:5173/x` parses as scheme `localhost:`; a host followed by a port is an address, not a scheme.
  const hasScheme = /^[a-z][a-z0-9+.-]*:/i.test(text) && !/^[a-z0-9.-]+:\d+(?:[/?#]|$)/i.test(text);
  const url = new URL(hasScheme ? text : `http://${text}`);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('only http(s)');
  return url.href;
}

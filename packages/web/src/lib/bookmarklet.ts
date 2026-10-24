/**
 * Generate a bookmarklet that navigates to this cockpit and optional project. Preserve the
 * protected skill/auto/key/ref query grammar and flat-path fallback. Carry that project’s launch
 * key for auto-start; alert() runs on the source page.
 */

/** The cockpit's default origin — the fallback when a caller can't supply `window.location.origin`. */
export const DEFAULT_COCKPIT_ORIGIN = 'http://localhost:4321'

export function bookmarkletUrl(
  skillName: string,
  auto: boolean,
  key: string,
  origin: string = DEFAULT_COCKPIT_ORIGIN,
  projectId: string | null = null,
): string {
  // `'` survives encodeURIComponent — it would break the single-quoted JS strings below.
  const enc = (s: string) => encodeURIComponent(s).replaceAll("'", '%27')
  const query = `${skillName ? `skill=${enc(skillName)}&` : ''}auto=${auto ? '1' : '0'}&key=${enc(key)}&ref=`
  // Keep the origin's `://` intact (do NOT URI-encode it — it goes straight into `open()`); only
  // neutralize a stray apostrophe so it can't break the embedded string.
  const base = origin.replaceAll("'", '%27')
  // The composer's path for the named project. Null (no scope) keeps the legacy flat `/new`,
  // which the cockpit redirects to the boot project anyway — so both spellings still land.
  const path = projectId === null || projectId === '' ? '/new' : `/p/${enc(projectId)}/new`
  const code =
    `(()=>{const m=location.href.match(/^https:\\/\\/github\\.com\\/([^\\/]+)\\/([^\\/]+)\\/(pull|issues)\\/\\d+/);` +
    `if(!m){alert('Open a GitHub PR or issue first');return;}` +
    `const q='${query}'+encodeURIComponent(location.href);` +
    `open('${base}${path}?'+q,'_blank');})();`
  return `javascript:${encodeURIComponent(code)}`
}

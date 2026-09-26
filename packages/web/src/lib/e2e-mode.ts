/**
 * Build-time gate for the cockpit e2e suite (#415).
 *
 * `VITE_CEZ_E2E=1` is set only when `.ai/scripts/test-env-up.sh` builds the bundle the
 * suite drives. A production `npm run build` leaves it unset, so `useNow` and every
 * `refetchInterval` keep their live cadences.
 */
export function isCockpitE2e(): boolean {
  return import.meta.env.VITE_CEZ_E2E === '1' || import.meta.env.VITE_CEZ_E2E === 'true'
}

declare global {
  interface Window {
    /**
     * E2e-only: scroll the thread through the product owner (virtua `scrollTo` when
     * virtualized). A raw `scrollTop` write loses to virtua's jump compensation.
     */
    __cezThreadScrollTo?: (top: number) => void
  }
}

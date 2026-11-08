import { e2eBuildEnabled } from './build-env'

/**
 * Build-time gate for the cockpit e2e suite (#415).
 *
 * `VITE_CEZ_E2E=1` is set only when `.ai/scripts/build-e2e.sh` builds the bundle the
 * suite drives, into `.ai/qa/build/cezar`. A production `npm run build` leaves it unset, so `useNow` and every
 * `refetchInterval` keep their live cadences.
 */
export function isCockpitE2e(): boolean {
  return e2eBuildEnabled(import.meta.env.VITE_HSQ_E2E, import.meta.env.VITE_CEZ_E2E)
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

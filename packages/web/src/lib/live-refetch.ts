import { isCockpitE2e } from './e2e-mode'

/**
 * Every live `refetchInterval` in the cockpit goes through here so e2e mode can pin them
 * in one place (#415). Production passes the interval through unchanged.
 */
export function liveRefetchInterval<T>(interval: T): T {
  // e2e returns `false` at runtime; the identity return type keeps TanStack Query's
  // callback-interval inference (wrapping a function as `T | false` collapsed `query` to `never`).
  return (isCockpitE2e() ? false : interval) as T
}

/** Disposable reviewer pilot. Deliberately contains defects. Never merge. */

/**
 * Return true when nowMs is at or after expiresAtMs.
 * Both inputs are finite Unix timestamps in milliseconds.
 */
export function isLeaseExpired(nowMs: number, expiresAtMs: number): boolean {
  return nowMs >= expiresAtMs;
}

/**
 * Return true when candidate is root itself or a descendant of root.
 * Inputs are normalized, case-sensitive, absolute slash-separated paths.
 * Neither input has a trailing slash, empty segment, '.' or '..'; root is not '/'.
 */
export function isPathContained(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(root + '/');
}

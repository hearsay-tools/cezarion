/**
 * hearsay-tools/cezarion#1112: a follow-up whose native turn starts late. A mock that sees
 * the token in a follow-up holds that turn's native start past the 250 ms held-input
 * recheck (HELD_HUMAN_INPUT_RECHECK_MS in workflows/run.ts), the window a loaded host
 * opened between a Cursor print process spawning and its init frame.
 *
 * Callers test for the token inline before a dynamic import, so a mock without it keeps
 * its exact event-loop ordering (an unconditional `await` would yield on every turn), and
 * a testkit that copies a mock elsewhere and rewrites `import('./` still resolves it.
 */
export const DEFERRED_TURN_START_TOKEN = 'mock:deferred-turn-start';
export const DEFERRED_TURN_START_MS = 800;

export function deferredTurnStart() {
  return new Promise(resolve => setTimeout(resolve, DEFERRED_TURN_START_MS));
}

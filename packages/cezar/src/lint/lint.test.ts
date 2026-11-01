import { describe, expect, it } from 'vitest';
import { lint } from './run.ts';

/**
 * A bridge, not a check of its own (hearsay-tools/cezarion#2416): `npm run lint` is the gate, and
 * CI runs it whatever tests a change selects. Squeal runs Vitest on every edit but no oxlint yet,
 * so this one case runs the whole lint and shows its diagnostics while an edit is fresh. Remove it
 * when Squeal runs oxlint itself.
 */
// bound: oxlint and ast-grep together take a few seconds on an idle host; this is a hang guard for
// a loaded host, and the runner's 300 s process timeout per tool stays the outer limit.
const LINT_TIMEOUT_MS = 330_000;

describe('npm run lint', () => {
  it('finds no problem in the repository', { timeout: LINT_TIMEOUT_MS }, async () => {
    expect(await lint(), 'npm run lint reports these; docs/sdlc/lint.md says how to fix each rule').toEqual([]);
  });
});

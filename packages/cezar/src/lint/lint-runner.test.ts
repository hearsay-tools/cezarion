import { describe, expect, it } from 'vitest';
import { lintWithoutOxlint } from './run.ts';

/** Squeal runs oxlint itself; this bridge keeps every other repository check at edit time. */
// bound: ast-grep and repository checks take seconds on an idle host; this guards a loaded host,
// and the runner's 300 s process timeout per tool stays the outer limit.
const LINT_TIMEOUT_MS = 330_000;

describe('repository lint outside oxlint', () => {
  it('finds no problem in the repository', { timeout: LINT_TIMEOUT_MS }, async () => {
    expect(await lintWithoutOxlint(), 'npm run lint reports these; docs/sdlc/lint.md says how to fix each rule').toEqual([]);
  });
});

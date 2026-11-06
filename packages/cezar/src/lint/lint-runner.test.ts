import { describe, expect, it } from 'vitest';
import { repositoryProblems, waitProblems } from './run.ts';

/** Squeal runs oxlint itself; ast-grep has two separate bridge files. */
// bound: repository scans take seconds on an idle host; this guards a loaded host.
const LINT_TIMEOUT_MS = 330_000;

describe('repository lint outside oxlint', () => {
  it('finds no problem in the repository', { timeout: LINT_TIMEOUT_MS }, () => {
    expect([...waitProblems(), ...repositoryProblems()], 'npm run lint reports these; docs/sdlc/lint.md says how to fix each rule').toEqual([]);
  });
});

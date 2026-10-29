import { expect, it } from 'vitest'

// TEMPORARY LIVE CI PROBE — NEVER MERGE.
// This isolated fixture proves failed-job retry behavior after review passes.
// GitHub's official attempt number controls the fixture: native PR attempt 1
// fails; attempt 2 or later at the same commit passes. Other environments pass.
// No workflow, review result, credential, or product behavior is changed.
it('temporary probe: a native PR test failure recovers on the same-head retry', () => {
  const firstNativeAttempt = process.env.GITHUB_ACTIONS === 'true'
    && process.env.GITHUB_EVENT_NAME === 'pull_request_target'
    && process.env.GITHUB_RUN_ATTEMPT === '1'

  expect(firstNativeAttempt, 'Intentional attempt-1 failure in the never-merge live CI retry probe').toBe(false)
})

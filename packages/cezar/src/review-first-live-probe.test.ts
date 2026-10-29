import { expect, it } from 'vitest'

// TEMPORARY LIVE CI PROBE — NEVER MERGE.
// This isolated fixture proves failed-job retry behavior after review passes.
// GitHub's official attempt number controls the fixture: native PR attempt 2
// fails; attempt 1 and attempts 3+ at the same commit pass. Other environments pass.
// No workflow, review result, credential, or product behavior is changed.
it('temporary probe: a provider retry test failure recovers on the same-head retry', () => {
  const secondNativeAttempt = process.env.GITHUB_ACTIONS === 'true'
    && process.env.GITHUB_EVENT_NAME === 'pull_request_target'
    && process.env.GITHUB_RUN_ATTEMPT === '2'

  expect(secondNativeAttempt, 'Intentional attempt-2 failure in the never-merge live CI retry probe').toBe(false)
})

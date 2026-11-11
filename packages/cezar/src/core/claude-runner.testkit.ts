import { ClaudeCliRunner } from './claude-cli-runner.ts';
import { offerRunners, onlyRunner, RUNNER_OFFER } from './runners-under-test.testkit.ts';

// Importing this module makes the Claude CLI runner the test file's only runner. `createRunner`
// gives Claude to `claude`, `claude-cli` and a task with no backend, and so does `onlyRunner`; any
// other backend fails the run at once. Use it when a test drives runs but never a non-Claude
// backend: it loads one adapter, not six. It is an offer, so `core/every-runner.testkit.ts` beats it
// when the same test file loads both (hearsay-tools/cezarion#3242).
offerRunners(onlyRunner('claude', () => new ClaudeCliRunner()), RUNNER_OFFER.claude);

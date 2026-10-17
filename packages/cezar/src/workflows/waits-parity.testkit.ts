import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { expect } from 'vitest';
import type { RunnerId } from '../core/agent-runner.ts';
import { HARNESS_ADAPTERS } from '../core/harness-parity.testkit.ts';

// hearsay-tools/cezarion#1233: the wait list's RUNNER_IDS cells. U0 (tool admission) lives in
// `core/ci-tools.test.ts`; Task 5 appends U2, U3, U7 and U8 here.
export const WAIT_CRITERIA = [
  { id: 'U1', scenario: 'baseline', name: 'ci and timer register through cezar_wait on the native wire, park, and wake with their result' },
  { id: 'U4', scenario: 'baseline', name: 'cezar_cancel_wait cancels and no observation is delivered' },
  { id: 'U9', scenario: 'provider-error', name: 'provider failure and clean close with a ci or timer wait open leave the run recoverable and the next wake delivers' },
] as const;

/** The native mocks' `mock:cezar-tool` prompt: one cezar tool call through the runner's own wire.
 *  Several in one prompt run in order; `wait_id: 'last'` names the previous answer's wait. */
export function toolCall(name: 'cezar_wait' | 'cezar_cancel_wait', args: Record<string, unknown>): string {
  return `mock:cezar-tool ${name} ${Buffer.from(JSON.stringify(args)).toString('base64url')}`;
}

// Hold the existing native provider-error fixture until CI intent is durable.
// A scheduler-owned opening prompt fails once; the next process/turn uses the
// unchanged success fixture. No runner methods or normalized events are mocked.
export function gatedProviderFailure(root: string, runner: RunnerId) {
  const adapter = HARNESS_ADAPTERS[runner];
  const held = join(root, 'provider-held'), released = join(root, 'provider-released'), failed = join(root, 'provider-failed');
  const anchor: Record<RunnerId, string> = {
    claude: "if (userText.includes('mock:auth-error')) {",
    codex: "if (turnText.includes('mock:provider-error') || turnText.includes('mock:empty-success')) {",
    opencode: "if (body.includes('mock:provider-error')) {",
    pi: "if (command.type === 'prompt' && command.message.includes('mock:provider-error')) {",
    cursor: "if (mode === 'provider-error') {",
    omp: "if (message.includes('mock:provider-error')) {",
  };
  const text: Record<RunnerId, string> = { claude: 'userText', codex: 'turnText', opencode: 'body', pi: 'command.message', cursor: 'prompt', omp: 'message' };
  let source = readFileSync(adapter.mockBin, 'utf8').replace(/^#!.*\n/, '');
  expect(source.split(anchor[runner])).toHaveLength(2);
  source = source.replace(anchor[runner], `if (ciFailurePrompt(${text[runner]})) { await ciFailureGate();`);
  if (runner === 'cursor') source = source.replace("prompt.includes('mock:provider-error')", 'ciFailurePrompt(prompt)');
  source = source.replace(/import\('(\.\/[^']+)'\)/g, (_match, path: string) => `import(${JSON.stringify(pathToFileURL(join(dirname(adapter.mockBin), path)).href)})`);
  source = `import * as ciFailureFs from 'node:fs';
function ciFailurePrompt(text) {
  return typeof text === 'string' && !ciFailureFs.existsSync(${JSON.stringify(failed)}) && (text.includes(${JSON.stringify(adapter.scenarios['provider-error'])}) || text.includes('Resume to receive the queued CI observation.'));
}
async function ciFailureGate() {
  ciFailureFs.writeFileSync(${JSON.stringify(held)}, 'held');
  while (!ciFailureFs.existsSync(${JSON.stringify(released)})) await new Promise(resolve => setTimeout(resolve, 5));
  ciFailureFs.writeFileSync(${JSON.stringify(failed)}, 'failed');
}
${source}`;
  const mock = join(root, 'ci-failure-native.mjs');
  writeFileSync(mock, '#!/usr/bin/env node\n' + source, { mode: 0o755 });
  process.env.CEZ_DRY_RUN = '0'; process.env[adapter.binEnv] = mock;
  return { held: () => existsSync(held), release: () => writeFileSync(released, '') };
}

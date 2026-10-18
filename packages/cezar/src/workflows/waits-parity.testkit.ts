import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { expect } from 'vitest';
import type { RunnerId } from '../core/agent-runner.ts';
import { HARNESS_ADAPTERS } from '../core/harness-parity.testkit.ts';

// hearsay-tools/cezarion#1233: the wait list's RUNNER_IDS cells. U0 (tool admission) lives in
// `core/ci-tools.test.ts`.
export const WAIT_CRITERIA = [
  { id: 'U1', scenario: 'baseline', name: 'ci and timer register through cezar_wait on the native wire, park, and wake with their result' },
  { id: 'U4', scenario: 'baseline', name: 'cezar_cancel_wait cancels and no observation is delivered' },
  { id: 'U9', scenario: 'provider-error', name: 'provider failure and clean close with a ci or timer wait open leave the run recoverable and the next wake delivers' },
  { id: 'U2', scenario: 'baseline', name: 'ci and timer open: the timer wakes, ci stays open and is in the footer, the turn end re-parks without re-registering, the later ci result is delivered' },
  { id: 'U3', scenario: 'hold', name: 'a human message during a ci wait is delivered, the wait stays open, and its result arrives in a later turn' },
  { id: 'U7', scenario: 'turn-messages', name: 'cezar_wait_for_ci, the monitoring line and ScheduleWakeup land in the same wait list' },
  { id: 'U8', scenario: 'baseline', name: 'a ci or timer park keeps its slot and wakes without queueing at maxParallel 1' },
  { id: 'U10', scenario: 'hold-gated', name: 'timer wakes stop at the automatic-wake budget; one admitted turn is charged once' },
  { id: 'U11', scenario: 'turn-messages', name: 'an alias timer survives a later worker park with its deadline, is held while the workers outrank it, and is delivered after the worker wake' },
  { id: 'U12', scenario: 'turn-messages', name: 'a wait result beside a pending portable question is checkpointed only on its delayed provider acknowledgement, and the question stays answerable' },
  { id: 'U13', scenario: 'turn-messages', name: 'a wait result beside a pending portable question whose acknowledgement is rejected stays resolved, is retried, and the question stays answerable' },
  { id: 'U14', scenario: 'provider-error', name: 'a wait-result delivery whose sessions persistently fail or close cleanly stops at the delivery bound, the run fails keeping its result, Continue delivers it once, and Stop discards it' },
  { id: 'U16', scenario: 'baseline', name: 'a scheduler continuation keeps the automatic-wake budget and a human Continue resets it' },
  // hearsay-tools/cezarion#1234: human waits.
  { id: 'U7h', scenario: 'ask', name: 'the ask line, cezar_wait human and a native ask land in the same wait list' },
  { id: 'U9h', scenario: 'provider-error', name: 'provider failure and clean close with a human wait open leave the run recoverable' },
  { id: 'U6', scenario: 'baseline', name: 'cezar_done is refused with live workers and with settled but uncollected workers, accepted once collected, and open waits are cancelled' },
  { id: 'U7d', scenario: 'baseline', name: 'the done line and cezar_done finish through the same path' },
] as const;

/** The native mocks' `mock:cezar-tool` prompt: one cezar tool call through the runner's own wire.
 *  Several in one prompt run in order; `wait_id: 'last'` names the previous answer's wait. */
export function toolCall(name: 'cezar_wait' | 'cezar_wait_for_ci' | 'cezar_cancel_wait' | 'cezar_done', args: Record<string, unknown>): string {
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

/** The opening prompt of the scheduler continuation that delivers a timer result. */
export const TIMER_WAKE_OPENING = 'Resume to receive the queued timer result.';

// Fail every timer-wake continuation's opening prompt through the runner's own provider-error
// branch (Claude's auth-error branch, as `gatedProviderFailure` uses), or with `usageLimit`
// through Claude's usage-limit envelope, until the test lifts it. Every other prompt is unchanged.
export function persistentWakeFailure(root: string, runner: RunnerId, { usageLimit = false } = {}) {
  const adapter = HARNESS_ADAPTERS[runner];
  const lifted = join(root, 'wake-failure-lifted');
  const anchor: Record<RunnerId, string> = {
    claude: usageLimit ? "if (userText.includes('mock:limit')) {" : "if (userText.includes('mock:auth-error')) {",
    codex: "if (turnText.includes('mock:provider-error') || turnText.includes('mock:empty-success')) {",
    opencode: "if (body.includes('mock:provider-error')) {",
    pi: "if (command.type === 'prompt' && command.message.includes('mock:provider-error')) {",
    cursor: "if (mode === 'provider-error') {",
    omp: "if (message.includes('mock:provider-error')) {",
  };
  if (usageLimit) expect(runner).toBe('claude');
  const text: Record<RunnerId, string> = { claude: 'userText', codex: 'turnText', opencode: 'body', pi: 'command.message', cursor: 'prompt', omp: 'message' };
  let source = readFileSync(adapter.mockBin, 'utf8').replace(/^#!.*\n/, '');
  expect(source.split(anchor[runner])).toHaveLength(2);
  source = source.replace(anchor[runner], `if (wakeFailurePrompt(${text[runner]})) {`);
  if (runner === 'cursor') source = source.replace("prompt.includes('mock:provider-error')", 'wakeFailurePrompt(prompt)');
  source = source.replace(/import\('(\.\/[^']+)'\)/g, (_match, path: string) => `import(${JSON.stringify(pathToFileURL(join(dirname(adapter.mockBin), path)).href)})`);
  source = `import * as wakeFailureFs from 'node:fs';
function wakeFailurePrompt(text) {
  return typeof text === 'string' && text.includes(${JSON.stringify(TIMER_WAKE_OPENING)}) && !wakeFailureFs.existsSync(${JSON.stringify(lifted)});
}
${source}`;
  const mock = join(root, 'wake-failure-native.mjs');
  writeFileSync(mock, '#!/usr/bin/env node\n' + source, { mode: 0o755 });
  process.env.CEZ_DRY_RUN = '0'; process.env[adapter.binEnv] = mock;
  return { lift: () => writeFileSync(lifted, '') };
}

type NativeInput = {
  userText?: string; method?: string; prompt?: string; url?: string;
  params?: { input?: Array<{ text?: string }>; prompt?: Array<{ text?: string }> };
  body?: { parts?: Array<{ text?: string }> };
};

/** Read the prompts admitted by each runner's native mock, not normalized events. */
export function ciNativeMessages(runner: RunnerId, dir: string): string[] {
  const records = (name: string): Array<NativeInput | string[]> => {
    const path = join(dir, name);
    return existsSync(path) ? readFileSync(path, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : [];
  };
  const stdin = runner === 'claude' || runner === 'pi' || runner === 'omp';
  const rows = runner === 'cursor' ? [...records('args'), ...records('stdin')] : records(stdin ? 'stdin' : 'args');
  return rows.flatMap(row => {
    if (Array.isArray(row)) return runner === 'cursor' && row.at(-1)?.includes('\n\n---\n\n') ? [row.at(-1)!] : [];
    if (stdin) return row.userText === undefined ? [] : [row.userText];
    if (runner === 'cursor' && row.method === 'cursor-print/stdin' && row.prompt !== undefined) return [row.prompt];
    const parts = runner === 'codex' && row.method === 'turn/start' ? row.params?.input
      : runner === 'cursor' && row.method === 'session/prompt' ? row.params?.prompt
      : runner === 'opencode' && /\/(message|prompt_async)$/.test(row.url ?? '') ? row.body?.parts : undefined;
    return parts ? [parts.map((part: { text?: string }) => part.text ?? '').join('\n')] : [];
  });
}

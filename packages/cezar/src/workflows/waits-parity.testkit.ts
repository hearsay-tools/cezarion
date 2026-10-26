import { join } from 'node:path';
import { createFailureControl, type FailureControlOptions } from '../../scripts/mock-failure-control.mjs';
import { expect } from 'vitest';
import type { RunnerId } from '../core/agent-runner.ts';
import { HARNESS_ADAPTERS } from '../core/harness-parity.testkit.ts';
import { readMockRecords } from '../mock-records.testkit.ts';

// hearsay-tools/cezarion#1233: the wait list's RUNNER_IDS cells. U0 (tool admission) lives in
// `core/ci-tools.test.ts`.
export const WAIT_CRITERIA = [
  { id: 'U1', scenario: 'baseline', name: 'ci and timer register through cezar_wait on the native wire, park, and wake with their result' },
  { id: 'U4', scenario: 'baseline', name: 'cezar_cancel_wait cancels and no observation is delivered' },
  { id: 'U9', scenario: 'provider-error', name: 'provider failure and clean close with a ci or timer wait open leave the run recoverable and the next wake delivers' },
  { id: 'U2', scenario: 'baseline', name: 'ci and timer open: the timer wakes, ci stays open and is in the footer, the turn end re-parks without re-registering, the later ci result is delivered' },
  { id: 'U3', scenario: 'hold', name: 'a human message during a ci wait is delivered, the wait stays open, and its result arrives in a later turn' },
  { id: 'U7', scenario: 'turn-messages', name: 'cezar_wait, the monitoring line and ScheduleWakeup land in the same wait list' },
  { id: 'U7m', scenario: 'turn-messages', name: 'the monitoring line adds no timer beside an open ci, timer or worker wait' },
  { id: 'U7f', scenario: 'turn-messages', name: 'the monitoring line alone opens an identifiable timer and keeps its deadline' },
  { id: 'U8', scenario: 'baseline', name: 'a ci or timer park keeps its slot and wakes without queueing at maxParallel 1' },
  { id: 'U8l', scenario: 'hold-gated', name: 'a wake of a started run takes the slot before an unstarted task that queued earlier, at maxParallel 1' },
  { id: 'U8h', scenario: 'baseline', name: 'a ci result for a park on a held account waits in the line and is delivered once the hold lifts' },
  { id: 'U10', scenario: 'hold-gated', name: 'timer wakes stop at the automatic-wake budget; one admitted turn is charged once' },
  { id: 'U11', scenario: 'turn-messages', name: 'an alias timer open at a blocked done keeps its deadline, the run parks on it with the refusal as a note and no nudge, and its result is delivered' },
  { id: 'U12', scenario: 'turn-messages', name: 'a wait result beside a pending portable question is checkpointed only on its delayed provider acknowledgement, and the question stays answerable' },
  { id: 'U13', scenario: 'turn-messages', name: 'a wait result beside a pending portable question whose acknowledgement is rejected stays resolved, is retried, and the question stays answerable' },
  { id: 'U14', scenario: 'provider-error', name: 'a wait-result delivery whose sessions persistently fail or close cleanly stops at the delivery bound, the run fails keeping its result, Continue delivers it once, and Stop discards it' },
  { id: 'U16', scenario: 'baseline', name: 'a scheduler continuation keeps the automatic-wake budget and a human Continue resets it' },
  { id: 'U16b', scenario: 'baseline', name: 'timers due at the spent budget with no live session are cancelled, and the last one opens a budget human wait the user answers' },
  { id: 'U9c', scenario: 'baseline', name: 'with a delivery-failure count on the record and the store refusing writes, Finish still stops the run' },
  // hearsay-tools/cezarion#1234: human waits.
  { id: 'U7h', scenario: 'ask', name: 'the ask line, cezar_ask (an open question included) and a native ask land in the same wait list' },
  { id: 'U7k', scenario: 'ask', name: 'cezar_ask delivers its context to the human wait and the card' },
  { id: 'U9h', scenario: 'provider-error', name: 'provider failure and clean close with a human wait open leave the run recoverable' },
  { id: 'U6', scenario: 'baseline', name: 'cezar_done is refused with live workers and with settled but uncollected workers, accepted once collected, and open waits are cancelled' },
  { id: 'U7d', scenario: 'baseline', name: 'the done line and cezar_done finish through the same path' },
  { id: 'U7q', scenario: 'baseline', name: 'a deferred message that answers the question removes its queue entry in the answer\'s commit' },
  { id: 'U6s', scenario: 'baseline', name: 'cezar_done in a workflow step that is not the last completes that step, and the next step runs' },
  // hearsay-tools/cezarion#1234 phase 2b: the turn-end rule.
  { id: 'U5', scenario: 'baseline', name: 'a turn end with no wait gets one nudge, then a second no-wait turn end opens a no-wait human wait and reads needs you' },
  { id: 'U5a', scenario: 'baseline', name: 'a nudge the agent answers with cezar_ask parks on that question after one extra turn' },
  { id: 'U5c', scenario: 'baseline', name: 'a root parked on its no-wait human wait is finished by the user, and an agent question still blocks it' },
  { id: 'U5d', scenario: 'baseline', name: 'the no-wait human wait raises no question, and the agent\'s own wait replaces it' },
  { id: 'U18', scenario: 'baseline', name: 'Finish on a run parked on an agent question closes the question without answering it' },
  { id: 'U17', scenario: 'turn-messages', name: 'a question in prose without a wait no longer parks the run by itself' },
  { id: 'U15', scenario: 'autonomous-cap', name: 'an autonomous run is nudged with the autonomous wording until the budget, then opens a budget human wait' },
  // hearsay-tools/cezarion#1235 phase 3a: worker waits.
  { id: 'U2w', scenario: 'baseline', name: 'ci and worker open: the worker resolving wakes the agent with ci still open and in the footer, and the later ci result is delivered' },
  { id: 'U2t', scenario: 'baseline', name: 'timer and worker open: the timer resolving wakes the agent with the worker wait still open and in the footer, and the later worker result is delivered' },
  { id: 'U2c', scenario: 'baseline', name: 'ci and worker open: the ci result wakes the agent with the worker wait still open and in the footer, and the later worker result is delivered' },
  { id: 'U3w', scenario: 'baseline', name: 'a worker message during a worker wait wakes the parent and the worker wait stays open' },
  // hearsay-tools/cezarion#1327: a worker that parks while its parent waits on it tells the parent why.
  { id: 'U3n', scenario: 'turn-messages', name: 'a worker that parks on the monitoring line while its parent waits on it wakes the parent with one notice naming its timer, the wait stays open, a second park sends none, and settlement resolves the wait' },
  { id: 'U3r', scenario: 'turn-messages', name: 'a worker parked before its parent waits on it sends its notice when the wait opens' },
  { id: 'U3d', scenario: 'turn-messages', name: 'a worker that finishes while its parent waits on it sends no notice' },
  { id: 'U7w', scenario: 'baseline', name: 'cez worker wait and cezar_wait kind worker land in the same wait list' },
  { id: 'U9w', scenario: 'provider-error', name: 'provider failure and clean close with a worker wait open leave the run recoverable and the next resolution delivers' },
  { id: 'U14m', scenario: 'provider-error', name: 'a message-only wake beside a worker wait whose sessions persistently fail stops at the delivery bound keeping the message, Continue delivers it once, and a delivered message clears the failure count' },
  { id: 'U9u', scenario: 'baseline', name: 'after an upgrade, a cancelled worker wait\'s queued wake is delivered as ordinary input, and a parent whose message stand-in a provider took before the crash resumes' },
  { id: 'U9v', scenario: 'baseline', name: 'an upgraded completion wait wakes once through the list' },
  { id: 'U19', scenario: 'turn-messages', name: 'a worker message beside a pending portable question is delivered and the question stays answerable' },
  // hearsay-tools/cezarion#1301 phase 3b: a blocked done at the turn end.
  { id: 'U20', scenario: 'baseline', name: 'a done blocked by live workers at the turn end gets one refusal nudge with the will-wait sentence and opens no wait' },
  { id: 'U20u', scenario: 'baseline', name: 'a done blocked by a settled, uncollected worker gets the uncollected refusal nudge without the will-wait sentence' },
  { id: 'U20h', scenario: 'baseline', name: 'a human message, in the opening session or a continuation, after an unanswered refusal nudge starts a fresh cycle' },
  { id: 'U20m', scenario: 'baseline', name: 'a worker message after an unanswered refusal nudge starts a fresh cycle' },
  { id: 'U20a', scenario: 'baseline', name: 'a done blocked in the turn that answers a worker message acknowledged after that turn ended still gets the refusal nudge' },
  { id: 'U21', scenario: 'baseline', name: 'an ignored refusal with live workers parks on a Cezar worker wait that settlement wakes' },
  { id: 'U21r', scenario: 'baseline', name: 'after a restart, a deadline-less completion wait resolves on the worker\'s settlement and wakes the parent once' },
  { id: 'U21m', scenario: 'baseline', name: 'a worker message wakes a parent parked on the completion wait and the wait stays open' },
  { id: 'U21t', scenario: 'baseline', name: 'an agent timer registered beside a completion-wait park keeps its deadline and wakes beside it' },
  { id: 'U21h', scenario: 'baseline', name: 'an ignored refusal with only uncollected results parks on Cezar\'s human wait' },
  { id: 'U21a', scenario: 'autonomous-cap', name: 'an autonomous parent\'s ignored refusal is nudged again until the budget' },
  { id: 'U22', scenario: 'baseline', name: 'a done blocked after the session closed reopens it and delivers the refusal' },
  { id: 'U22s', scenario: 'baseline', name: 'a refusal reopened into a session that acknowledges it and never answers parks on Cezar\'s human wait at the nudge\'s reply bound' },
  { id: 'U22c', scenario: 'baseline', name: 'a refusal whose reopened sessions keep closing cleanly is queued once, stops at the delivery bound, and Continue delivers it once' },
  { id: 'U22f', scenario: 'baseline', name: 'a refusal whose reopened session closes once counts the failure, and its delivery clears it' },
  { id: 'U22k', scenario: 'baseline', name: 'after a refusal failed at the delivery bound, Continue delivers it within the nudge\'s reply bound and the closing sessions\' delivery retry' },
  { id: 'U22r', scenario: 'baseline', name: 'after a restart, a refusal queued for a closed session is delivered within the nudge\'s reply bound and the closing sessions\' delivery retry' },
  { id: 'U22x', scenario: 'baseline', name: 'Stop retires a refusal a closed session still owes, and a Continue after it does not deliver it' },
  { id: 'U24', scenario: 'baseline', name: 'a worker\'s second no-wait turn end asks its parent, and the reply resumes it' },
  { id: 'U24r', scenario: 'baseline', name: 'a parent\'s reply to a worker question whose session closed opens a continuation that answers it in one commit' },
  { id: 'U26', scenario: 'baseline', name: 'footer capability follows provisioning on opening, live delivery, Continue and no-session recovery' },
  { id: 'U25', scenario: 'baseline', name: 'an automatic message supersedes a worker\'s fallback question' },
  // hearsay-tools/cezarion#1446: process waits.
  { id: 'U1p', scenario: 'baseline', name: 'a process wait registers through cezar_wait on the native wire, parks keeping its slot, and wakes with its exit code' },
  { id: 'U2p', scenario: 'baseline', name: 'process and timer open: the timer wakes, the process wait stays open and is in the footer, the later process result is delivered' },
  { id: 'U4p', scenario: 'baseline', name: 'cezar_cancel_wait cancels a process wait, aborts its watch, and no result is delivered' },
  { id: 'U9p', scenario: 'provider-error', name: 'provider failure and clean close with a process wait open leave the run recoverable and the next result delivers' },
  { id: 'U9pr', scenario: 'baseline', name: 'after a restart with no live session a process wait is watched again and its result delivers through the continuation' },
  // hearsay-tools/cezarion#1525: one turn-settlement method for every entry.
  { id: 'U27', scenario: 'baseline', name: 'U5, U6, U11, U20 and U20u settle alike from a fresh step, a Continue and a late acknowledgement, each with its heartbeat word' },
] as const;

/** The native mocks' `mock:cezar-tool` prompt: one cezar tool call through the runner's own wire.
 *  Several in one prompt run in order; `wait_id: 'last'` names the previous answer's wait. */
export function toolCall(name: 'cezar_wait' | 'cezar_ask' | 'cezar_cancel_wait' | 'cezar_done', args: Record<string, unknown>): string {
  return `mock:cezar-tool ${name} ${Buffer.from(JSON.stringify(args)).toString('base64url')}`;
}
/** After the `toolCall`s in the same prompt, the turn ends with `text`. */
export function thenSay(text: string): string {
  return `mock:then ${Buffer.from(text).toString('base64url')}`;
}

// Hold the existing native provider-error fixture until CI intent is durable.
// A scheduler-owned opening prompt fails once; the next process/turn uses the
// unchanged success fixture. No runner methods or normalized events are mocked.
export function gatedProviderFailure(root: string, runner: RunnerId) {
  const { held, release } = nativeFailureControl(root, runner, { mode: 'gated-once' });
  return { held, release };
}

/** The opening prompt of the scheduler continuation that delivers a timer result. */
export const TIMER_WAKE_OPENING = 'Resume to receive the queued timer result.';
/** The opening prompt of the scheduler continuation that delivers messages alone. */
export const MESSAGE_WAKE_OPENING = 'Resume to receive queued messages.';

// Fail every timer-wake continuation's opening prompt through the runner's own provider-error
// branch (Claude's auth-error branch, as `gatedProviderFailure` uses), or with `usageLimit`
// through Claude's usage-limit envelope, until the test lifts it. `opening` names another wake
// continuation's prompt instead. Claude's mock reads every line it is sent after a failed turn, so
// a message steered behind the opening would be read; `unread` makes Claude's failure end the
// process instead, as a crash would, before it reads one. Every other prompt is unchanged.
export function persistentWakeFailure(root: string, runner: RunnerId, { usageLimit = false, opening = TIMER_WAKE_OPENING, unread = false } = {}) {
  if (usageLimit) expect(runner).toBe('claude');
  const { lift } = nativeFailureControl(root, runner, { mode: 'persistent', opening,
    failure: unread && runner === 'claude' ? 'unread' : usageLimit ? 'usage-limit' : 'provider' });
  return { lift };
}

function nativeFailureControl(root: string, runner: RunnerId, options: FailureControlOptions) {
  const control = createFailureControl(root, options);
  const adapter = HARNESS_ADAPTERS[runner];
  process.env.CEZ_DRY_RUN = '0';
  process.env[adapter.binEnv] = adapter.mockBin;
  process.env.CEZ_MOCK_FAILURE_CONTROL = control.path;
  return control;
}

type NativeInput = {
  userText?: string; method?: string; prompt?: string; url?: string;
  params?: { input?: Array<{ text?: string }>; prompt?: Array<{ text?: string }> };
  body?: { parts?: Array<{ text?: string }> };
};

/** Read the prompts admitted by each runner's native mock, not normalized events. */
export function ciNativeMessages(runner: RunnerId, dir: string): string[] {
  const records = (name: string) => readMockRecords<NativeInput | string[]>(join(dir, name));
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

/** Input the Codex mock took into an open turn through `turn/steer`, which `ciNativeMessages`
 *  leaves out. Every other runner returns none. */
export function ciNativeSteers(runner: RunnerId, dir: string): string[] {
  if (runner !== 'codex') return [];
  return readMockRecords<NativeInput>(join(dir, 'args')).flatMap(row =>
    row.method === 'turn/steer' && row.params?.input ? [row.params.input.map(part => part.text ?? '').join('\n')] : []);
}

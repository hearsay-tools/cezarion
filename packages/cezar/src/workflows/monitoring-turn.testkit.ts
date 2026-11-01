import { HARNESS_ADAPTERS } from '../core/harness-parity.testkit.ts';
import type { RunnerId } from '../core/agent-runner.ts';

// hearsay-tools/cezarion#2397: a turn monitors through `cezar_wait` (a timer) or live workers, asks
// through `cezar_ask` and finishes through `cezar_done`; the rows that only read marker lines are gone.
export const MONITORING_TURN_CRITERIA = [
  { id: 'M1', scenario: 'turn-messages', name: 'a cezar_wait timer survives same-turn acknowledgement and wakes autonomously' },
  { id: 'M2', scenario: 'turn-messages', name: 'a later prose question leaves the cezar_wait timer in place' },
  { id: 'M3', scenario: 'turn-messages', name: 'a review request in prose leaves monitoring with live workers in place' },
  { id: 'M4', scenario: 'turn-messages', name: 'a later cezar_ask beats the cezar_wait timer' },
  { id: 'M5', scenario: 'turn-messages', name: 'a later cezar_done reaches completion' },
  { id: 'M7', scenario: 'turn-messages', name: 'idle closure preserves a question and its delivered answer clears later monitoring' },
  { id: 'M18', scenario: 'turn-messages', name: 'a cezar_ask survives later acknowledgement with its card and answer lifecycle' },
  { id: 'M19', scenario: 'turn-messages', name: 'a cezar_done survives later acknowledgement and reaches review' },
  { id: 'M21', scenario: 'turn-messages', name: 'cezar_done is refused while the turn\'s question is pending' },
] as const;
export const MONITORING_ORDER_CRITERIA = [
  { id: 'M13', scenario: 'turn-messages', name: 'fresh ordinary markerless prose questions keep autonomous nudges' },
  { id: 'M14', scenario: 'turn-messages', name: 'Continue ordinary markerless prose questions keep autonomous nudges' },
  { id: 'M17', scenario: 'turn-messages', name: 'fresh a clean session close with an accepted worker wait open parks the run on it' },
  { id: 'M23', scenario: 'turn-messages', name: 'an autonomous cezar_ask followed by acknowledgement is refused, and the run continues' },
] as const;

// Agent-echo follows a real owned-input ACK on each adapter's existing wire.
export const MONITORING_ACK_CRITERIA = [
  { id: 'M26', scenario: 'baseline', name: 'fresh input ACK keeps monitoring with live workers' },
  { id: 'M27', scenario: 'baseline', name: 'Continue input ACK keeps monitoring with live workers' },
] as const;
export function messagesPrompt(backend: RunnerId, messages: string[]): string {
  return `${HARNESS_ADAPTERS[backend].scenarios['turn-messages']}:${Buffer.from(JSON.stringify(messages)).toString('base64')}`;
}
export const ACK_TEXT = 'I’ll fetch and merge the latest `main` before opening the draft PR, resolve any conflicts, and rerun the checks affected by the merged changes.';

import { HARNESS_ADAPTERS } from '../core/harness-parity.testkit.ts';
import type { RunnerId } from '../core/agent-runner.ts';

export const MONITORING_TURN_CRITERIA = [
  { id: 'M1', scenario: 'turn-messages', name: 'monitoring survives same-turn acknowledgement and wakes autonomously' },
  { id: 'M2', scenario: 'turn-messages', name: 'a later unstructured question beats monitoring' },
  { id: 'M3', scenario: 'turn-messages', name: 'a later explicit review gate beats monitoring with live workers' },
  { id: 'M4', scenario: 'turn-messages', name: 'a later structured ASK beats monitoring' },
  { id: 'M5', scenario: 'turn-messages', name: 'a later DONE reaches completion' },
  { id: 'M6', scenario: 'turn-messages', name: 'quoted and fenced monitoring examples stay ordinary waiting' },
  { id: 'M7', scenario: 'turn-messages', name: 'idle closure preserves a question and its delivered answer clears later monitoring' },
  { id: 'M11', scenario: 'turn-messages', name: 'quoted human gates and routine review progress do not cancel monitoring' },
  { id: 'M12', scenario: 'turn-messages', name: 'a resolved prose question before monitoring does not latch attention' },
  { id: 'M15', scenario: 'turn-messages', name: 'active Markdown human gates beat monitoring' },
  { id: 'M16', scenario: 'turn-messages', name: 'a prose gate retires its registered wait and survives idle, restart and late worker input' },
  { id: 'M8', scenario: 'turn-messages', name: 'spent parent completion remains actionable' },
] as const;
export const MONITORING_ORDER_CRITERIA = [
  { id: 'M13', scenario: 'turn-messages', name: 'fresh ordinary markerless prose questions keep autonomous nudges' },
  { id: 'M14', scenario: 'turn-messages', name: 'Continue ordinary markerless prose questions keep autonomous nudges' },
  { id: 'M17', scenario: 'turn-messages', name: 'fresh genuine accepted-wait session loss still fails' },
] as const;

// Agent-echo follows a real owned-input ACK on each adapter's existing wire.
export const MONITORING_ACK_CRITERIA = [
  { id: 'M9', scenario: 'baseline', name: 'fresh input ACK retains an explicit human gate with live workers' },
  { id: 'M10', scenario: 'baseline', name: 'Continue input ACK retains an explicit human gate with live workers' },
] as const;
export function messagesPrompt(backend: RunnerId, messages: string[]): string {
  return `${HARNESS_ADAPTERS[backend].scenarios['turn-messages']}:${Buffer.from(JSON.stringify(messages)).toString('base64')}`;
}
export const MONITORING_TEXT = 'The diagnostics are reviewed and approved. The load campaign is still running.\n\nCEZ:MONITORING';
export const ACK_TEXT = 'I’ll fetch and merge the latest `main` before opening the draft PR, resolve any conflicts, and rerun the checks affected by the merged changes.';
export const ASK_TEXT = 'CEZ:ASK {"questions":[{"header":"Choice","question":"Which module?","options":[{"label":"Parser"},{"label":"Runner"}]}]}';

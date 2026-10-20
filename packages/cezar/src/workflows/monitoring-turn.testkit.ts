import { HARNESS_ADAPTERS } from '../core/harness-parity.testkit.ts';
import type { RunnerId } from '../core/agent-runner.ts';

export const MONITORING_TURN_CRITERIA = [
  { id: 'M1', scenario: 'turn-messages', name: 'monitoring survives same-turn acknowledgement and wakes autonomously' },
  { id: 'M2', scenario: 'turn-messages', name: 'a later prose question leaves monitoring in place' },
  { id: 'M3', scenario: 'turn-messages', name: 'a later review request in prose leaves monitoring with live workers in place' },
  { id: 'M4', scenario: 'turn-messages', name: 'a later structured ASK beats monitoring' },
  { id: 'M5', scenario: 'turn-messages', name: 'a later DONE reaches completion' },
  { id: 'M6', scenario: 'turn-messages', name: 'quoted and fenced monitoring examples stay ordinary waiting' },
  { id: 'M7', scenario: 'turn-messages', name: 'idle closure preserves a question and its delivered answer clears later monitoring' },
  { id: 'M11', scenario: 'turn-messages', name: 'quoted human gates and routine review progress do not cancel monitoring' },
  { id: 'M12', scenario: 'turn-messages', name: 'a resolved prose question before monitoring does not latch attention' },
  { id: 'M18', scenario: 'turn-messages', name: 'a structured ASK survives later acknowledgement with its card and answer lifecycle' },
  { id: 'M19', scenario: 'turn-messages', name: 'a DONE declaration survives later acknowledgement and reaches review' },
  { id: 'M20', scenario: 'turn-messages', name: 'quoted, fenced and example ASK and DONE declarations remain inert' },
  { id: 'M21', scenario: 'turn-messages', name: 'a later DONE supersedes an earlier portable ASK before acknowledgement' },
  { id: 'M22', scenario: 'turn-messages', name: 'a trailing malformed ASK keeps its diagnostic and raw fallback over an earlier valid ASK' },
  { id: 'M24', scenario: 'turn-messages', name: 'a rejected active ASK keeps its diagnostic and leaves monitoring in place' },
] as const;
export const MONITORING_ORDER_CRITERIA = [
  { id: 'M13', scenario: 'turn-messages', name: 'fresh ordinary markerless prose questions keep autonomous nudges' },
  { id: 'M14', scenario: 'turn-messages', name: 'Continue ordinary markerless prose questions keep autonomous nudges' },
  { id: 'M17', scenario: 'turn-messages', name: 'fresh a clean session close with an accepted worker wait open parks the run on it' },
  { id: 'M23', scenario: 'turn-messages', name: 'an autonomous ask line followed by acknowledgement is not registered, and the run continues' },
  { id: 'M28', scenario: 'turn-messages', name: 'an ordinary rejected ASK keeps the existing autonomous nudge policy' },
  { id: 'M29', scenario: 'turn-messages', name: 'ordered channel expansion clears resolved prose but retains structured and rejected ASK gates' },
  { id: 'M30', scenario: 'turn-messages', name: 'ordered channel expansion retains later DONE precedence' },
] as const;

// Agent-echo follows a real owned-input ACK on each adapter's existing wire.
export const MONITORING_ACK_CRITERIA = [
  { id: 'M26', scenario: 'baseline', name: 'fresh input ACK keeps a rejected ASK diagnostic and monitoring with live workers' },
  { id: 'M27', scenario: 'baseline', name: 'Continue input ACK keeps a rejected ASK diagnostic and monitoring with live workers' },
] as const;
export function messagesPrompt(backend: RunnerId, messages: string[]): string {
  return `${HARNESS_ADAPTERS[backend].scenarios['turn-messages']}:${Buffer.from(JSON.stringify(messages)).toString('base64')}`;
}
export const MONITORING_TEXT = 'The diagnostics are reviewed and approved. The load campaign is still running.\n\nCEZ:MONITORING';
export const ACK_TEXT = 'I’ll fetch and merge the latest `main` before opening the draft PR, resolve any conflicts, and rerun the checks affected by the merged changes.';
export const ASK_TEXT = 'CEZ:ASK {"questions":[{"header":"Choice","question":"Which module?","options":[{"label":"Parser"},{"label":"Runner"}]}]}';
export const REJECTED_ASK_TEXT = 'CEZ:ASK {"questions":[{"header":"Deploy","question":"Should I deploy?","options":[{"label":"Deploy"}]}]}';

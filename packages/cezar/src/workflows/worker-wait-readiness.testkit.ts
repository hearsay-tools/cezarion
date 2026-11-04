import { randomUUID } from 'node:crypto';

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect } from 'vitest';

import { COMPLETION_NUDGE_NOTE } from './run.ts';
import type { AgentSession } from '../core/agent-runner.ts';

import { gate, thenSay, toolCall } from './waits-parity.testkit.ts';

import { manager, root, store, until } from './worker-wait.testkit.ts';

/** The refusal nudges a blocked done received (hearsay-tools/cezarion#1301), as their notes. */
export const completionNudges = (id: string) => store.readEvents(id).filter(event => event.type === 'note' && String(event.message).startsWith(COMPLETION_NUDGE_NOTE));
/** The agent inputs Cezar submitted on the session, by text. */
export const sentTexts = (sent: string[], text: string) => sent.filter(entry => entry.includes(text));
/** Record every text a session is sent through Cezar's agent-input seam. */
export function recordAgentInput(id: string): string[] {
  const sent: string[] = [];
  const session = (manager as unknown as { active: Map<string, { session: AgentSession }> }).active.get(id)!.session;
  const real = session.sendAgentMessage.bind(session);
  session.sendAgentMessage = ((content, ...rest) => {
    sent.push(content.map(block => block.type === 'text' ? block.text : '').join('\n'));
    return real(content, ...rest);
  }) as AgentSession['sendAgentMessage'];
  return sent;
}

/** hearsay-tools/cezarion#2397: cezar_done refuses a done that workers already block, and that answer
 *  is the agent's. The turn end's refusal comes from a done the tool accepted before `block` added
 *  the blocker later in the same turn, as an agent that spawns a worker after its done does. `send`
 *  opens the turn: a human message unless the test sends straight to the session. */
export async function blockedDone<T>(id: string, block: () => Promise<T>, send: (text: string) => unknown = text => manager.sendMessage(id, [{ type: 'text', text }])): Promise<T> {
  const opened = join(root, `gate-${randomUUID()}`);
  expect(send(`${toolCall('cezar_done', {})} ${gate(opened)} ${thenSay('All done.')}`)).toBe(true);
  await until(() => !!(manager as unknown as { active: Map<string, { doneRequested?: unknown }> }).active.get(id)?.doneRequested);
  const blocker = await block();
  writeFileSync(opened, '');
  return blocker;
}
export const sessionOf = (id: string) => (manager as unknown as { active: Map<string, { session: AgentSession }> }).active.get(id)!.session;


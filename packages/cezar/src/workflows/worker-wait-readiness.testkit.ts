import { randomUUID } from 'node:crypto';

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, expect, onTestFinished } from 'vitest';
import { captureSessions } from './runner-session-capture.testkit.ts';
import { observationClock } from '../core/observation-clock.testkit.ts';
import { IDLE_TIMEOUT_MS } from './run/constants.ts';
import type { RunManager } from './run.ts';
import type { RunStore } from '../runs/store.ts';

import { COMPLETION_NUDGE_NOTE } from './run.ts';
import type { AgentSession } from '../core/agent-runner.ts';

import { gate, thenSay, toolCall } from './waits-parity.testkit.ts';

import { manager, root, store, until } from './worker-wait.testkit.ts';

let sessions: ReturnType<typeof captureSessions>;
const answers = new Map<string, string>();

// Own the real runner boundary. Never inspect manager state.
beforeEach(() => {
  answers.clear();
  const responses = mkdtempSync(join(tmpdir(), 'cez-readiness-tools-'));
  onTestFinished(() => rmSync(responses, { recursive: true, force: true }));
  sessions = captureSessions({ env: id => {
    const answer = join(responses, `${id}.json`);
    answers.set(id, answer);
    return { CEZ_MOCK_CI_RESULT: answer };
  } });
});

/** Freeze only TurnSettler's idle timers; child-process drain timers keep real time. */
export function observeIdleClose(ownedStore: RunStore = store) {
  let published: string | undefined;
  const timerOf = new Map<string, number>();
  const onRun = (run: { id: string; status: string }) => { published = run.status === 'waiting' ? run.id : undefined; };
  ownedStore.on('run', onRun);
  onTestFinished(() => { ownedStore.off('run', onRun); });
  const clock = observationClock(delay => {
    if (delay !== IDLE_TIMEOUT_MS || !/\bat (?:[^ (\n]+\.)?armIdleTimer \(/.test(new Error().stack ?? '')) return false;
    if (!published) throw new Error('idle timer armed without a published waiting run');
    timerOf.set(published, clock.captured);
    return true;
  });
  return { ...clock, fireRun(id: string) {
    const index = timerOf.get(id);
    if (index === undefined) throw new Error(`No idle timer observed for ${id}`);
    clock.fire(index);
  } };
}

/** Close the selected run through the product timer and observe its durable lifecycle. */
export async function idleClose(clock: ReturnType<typeof observeIdleClose>, id: string,
  ownedManager: RunManager, ownedStore: RunStore, wait: (predicate: () => boolean) => Promise<void>) {
  const session = sessionOf(id);
  expect(session.open).toBe(true);
  const before = ownedStore.readEvents(id).filter(event => event.type === 'lifecycle' &&
    String(event.message).includes('of inactivity')).length;
  clock.fireRun(id);
  // bound: the caller bounds a missing session-settlement signal; inactivity is the predicate.
  await wait(() => !ownedManager.isActive(id));
  expect(session.open).toBe(false);
  expect(ownedStore.readEvents(id).filter(event => event.type === 'lifecycle' &&
    event.message === `session closed after ${Math.round(IDLE_TIMEOUT_MS / 60_000)}m of inactivity`)).toHaveLength(before + 1);
}

/** The refusal nudges a blocked done received (hearsay-tools/cezarion#1301), as their notes. */
export const completionNudges = (id: string) => store.readEvents(id).filter(event => event.type === 'note' && String(event.message).startsWith(COMPLETION_NUDGE_NOTE));
/** The agent inputs Squawk submitted on the session, by text. */
export const sentTexts = (sent: string[], text: string) => sent.filter(entry => entry.includes(text));
/** Record every text a session is sent through Squawk's agent-input seam. */
export function recordAgentInput(id: string): string[] {
  const sent: string[] = [];
  const session = sessionOf(id);
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
  const answer = answers.get(id);
  if (!answer) throw new Error(`No tool-result wire observed for ${id}`);
  rmSync(answer, { force: true });
  expect(send(`${toolCall('cezar_done', {})} ${gate(opened)} ${thenSay('All done.')}`)).toBe(true);
  await until(() => existsSync(answer));
  const result = JSON.parse(readFileSync(answer, 'utf8'));
  expect(JSON.parse(result.response.content[0].text.split('\n')[0])).toMatchObject({ ok: true, finishes: 'at_turn_end' });
  const blocker = await block();
  writeFileSync(opened, '');
  return blocker;
}
export const sessionOf = (id: string): AgentSession => sessions(id);

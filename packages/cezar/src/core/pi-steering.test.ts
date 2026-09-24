import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import type { AgentEvent, SessionOptions } from './agent-runner.ts';
import { PiRunner } from './pi-runner.ts';

const mockBin = fileURLToPath(new URL('../../scripts/mock-pi-rpc.mjs', import.meta.url));
const waitUntil = async (cond: () => boolean) => {
  const start = Date.now();
  while (!cond()) { if (Date.now() - start > 10_000) throw new Error('waitUntil timed out'); await new Promise(r => setTimeout(r, 10)); }
};
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const start = (prompt: string, opts: SessionOptions = {}) => {
  const dir = mkdtempSync(join(tmpdir(), 'cez-pi-steer-')); dirs.push(dir);
  const stdinLog = join(dir, 'stdin.ndjson');
  const events: AgentEvent[] = [];
  const session = new PiRunner({ bin: mockBin, timeoutMs: 0 }).startSession(
    { userPrompt: prompt, cwd: dir, env: { CEZ_MOCK_STDIN_FILE: stdinLog } }, event => events.push(event), opts);
  const prompts = () => readFileSync(stdinLog, 'utf8').trim().split('\n').map(line => JSON.parse(line) as { userText: string; streamingBehavior?: string });
  return { session, events, prompts };
};

describe('pi agent input steering (#505)', () => {
  it('steers agent input into the running turn and reports consumption by text', async () => {
    const consumed: string[][] = [];
    const { session, events, prompts } = start('mock:steer-tool', { onAgentInputConsumed: ids => consumed.push([...ids]) });
    await waitUntil(() => events.some(e => e.type === 'tool-call'));
    const ack = session.sendAgentMessage([{ type: 'text', text: 'mid-turn update' }], ['in-1']);
    expect(ack).not.toBe(false);
    await ack;
    expect(consumed).toEqual([]); // the RPC response is not consumption
    await waitUntil(() => events.some(e => e.type === 'turn-end'));
    expect(consumed).toEqual([['in-1']]);
    expect(events.filter(e => e.type === 'turn-end')).toEqual([{ type: 'turn-end' }]);
    // Cezar's follow-up kind is never mapped to Pi's delayed followUp.
    expect(prompts().find(p => p.userText === 'mid-turn update')?.streamingBehavior).toBe('steer');
    session.end(); await session.result;
  });

  it('runs a steer acknowledged after the final model call as the next turn, never unconsumed', async () => {
    const consumed: string[][] = [];
    const { session, events } = start('mock:steer-late', { onAgentInputConsumed: ids => consumed.push([...ids]) });
    await waitUntil(() => events.some(e => e.type === 'text'));
    await session.sendAgentMessage([{ type: 'text', text: 'mock:agent-echo too late' }], ['in-late']);
    await waitUntil(() => events.filter(e => e.type === 'turn-end').length === 2);
    expect(events.filter(e => e.type === 'turn-end')).toEqual([{ type: 'turn-end' }, { type: 'turn-end' }]);
    expect(consumed).toEqual([['in-late']]);
    session.end(); await session.result;
  });

  it('counts a steer sent as the turn settles as read by the next turn', async () => {
    const consumed: string[][] = [];
    const { session, events } = start('inspect the working tree', { onAgentInputConsumed: ids => consumed.push([...ids]) });
    await waitUntil(() => events.some(e => e.type === 'turn-end'));
    const first = session.sendAgentMessage([{ type: 'text', text: 'mock:agent-echo next 0' }], ['n0']);
    await first;
    await session.sendAgentMessage([{ type: 'text', text: 'mock:agent-echo next 1' }], ['n1']);
    await waitUntil(() => events.filter(e => e.type === 'turn-end').length === 3);
    expect(events.filter(e => e.type === 'turn-end').every(e => !('unconsumedInputIds' in e))).toBe(true);
    expect(consumed).toEqual([['n0'], ['n1']]);
    session.end(); await session.result;
  });

  it('counts a prompt that opened a turn as read when that turn settles', async () => {
    const consumed: string[][] = [];
    const { session, events } = start('inspect the working tree', { onAgentInputConsumed: ids => consumed.push([...ids]) });
    await waitUntil(() => events.some(e => e.type === 'turn-end'));
    await session.sendAgentMessage([{ type: 'text', text: 'mock:agent-echo idle start' }], ['in-idle']);
    await waitUntil(() => events.filter(e => e.type === 'turn-end').length === 2);
    expect(consumed).toEqual([['in-idle']]);
    session.end(); await session.result;
  });

  it('never marks carried input read by a turn that failed on a provider error (#505 review)', async () => {
    const consumed: string[][] = [];
    const dir = mkdtempSync(join(tmpdir(), 'cez-pi-steer-fail-')); dirs.push(dir);
    const events: AgentEvent[] = [];
    const session = new PiRunner({ bin: mockBin, timeoutMs: 0 }).startSession({ userPrompt: 'inspect the working tree', cwd: dir, env: { CEZ_MOCK_PI_NO_USER_START: '1' } },
      event => events.push(event), { onAgentInputConsumed: ids => consumed.push([...ids]) });
    await waitUntil(() => events.some(e => e.type === 'turn-end'));
    await session.sendAgentMessage([{ type: 'text', text: 'mock:provider-error guidance' }], ['in-failed']);
    await waitUntil(() => events.filter(e => e.type === 'turn-end').length === 2);
    expect(consumed).toEqual([]);
    session.end(); await session.result.catch(() => undefined);
  });
});

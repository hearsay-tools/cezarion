import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import type { AgentEvent, SessionOptions } from './agent-runner.ts';
import { CodexAppServerRunner } from './codex-app-server-runner.ts';

const mockBin = fileURLToPath(new URL('../../scripts/mock-codex-app-server.mjs', import.meta.url));
const waitUntil = async (cond: () => boolean) => {
  const start = Date.now();
  while (!cond()) { if (Date.now() - start > 10_000) throw new Error('waitUntil timed out'); await new Promise(r => setTimeout(r, 10)); }
};
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const start = (prompt: string, opts: SessionOptions = {}, env: Record<string, string> = {}) => {
  const dir = mkdtempSync(join(tmpdir(), 'cez-codex-steer-')); dirs.push(dir);
  const rpcLog = join(dir, 'rpc.ndjson');
  const events: AgentEvent[] = [];
  const session = new CodexAppServerRunner({ bin: mockBin, timeoutMs: 0 }).startSession(
    { userPrompt: prompt, cwd: dir, env: { CEZ_MOCK_ARGS_FILE: rpcLog, ...env } }, event => events.push(event), opts);
  const requests = () => readFileSync(rpcLog, 'utf8').trim().split('\n').map(line => JSON.parse(line) as { method?: string; params?: Record<string, unknown> });
  return { session, events, requests };
};

describe('codex agent input steering (#505)', () => {
  it('steers agent input into the active turn and correlates consumption', async () => {
    const consumed: string[][] = [];
    const { session, events } = start('mock:steer-tool', { onAgentInputConsumed: ids => consumed.push([...ids]) });
    await waitUntil(() => events.some(e => e.type === 'tool-call'));
    const ack = session.sendAgentMessage([{ type: 'text', text: 'mid-turn update' }], ['in-1']);
    expect(ack).not.toBe(false);
    await ack;
    expect(consumed).toEqual([]); // an RPC acknowledgement is not consumption
    await waitUntil(() => events.some(e => e.type === 'turn-end'));
    expect(consumed).toEqual([['in-1']]);
    expect(events.filter(e => e.type === 'turn-end')).toEqual([{ type: 'turn-end' }]);
    expect(events.some(e => e.type === 'text' && e.text.includes('saw: mid-turn update'))).toBe(true);
    session.end(); await session.result;
  });

  it('reports a steer the finished turn never consumed', async () => {
    const { session, events } = start('mock:steer-late');
    await waitUntil(() => events.some(e => e.type === 'text'));
    await session.sendAgentMessage([{ type: 'text', text: 'too late' }], ['in-late']);
    await waitUntil(() => events.some(e => e.type === 'turn-end'));
    expect(events.find(e => e.type === 'turn-end')).toEqual({ type: 'turn-end', unconsumedInputIds: ['in-late'] });
    session.end(); await session.result;
  });

  it('falls back to turn/start only when the steered turn ended first', async () => {
    const { session, events, requests } = start('mock:steer-race');
    await waitUntil(() => events.some(e => e.type === 'tool-call'));
    await session.sendAgentMessage([{ type: 'text', text: 'mock:agent-echo raced' }], ['in-race']);
    const sent = requests().filter(r => r.method === 'turn/steer' || r.method === 'turn/start').slice(1);
    expect(sent.map(r => r.method)).toEqual(['turn/steer', 'turn/start']);
    expect(sent[1]!.params!.clientUserMessageId).toBe(sent[0]!.params!.clientUserMessageId);
    await waitUntil(() => events.some(e => e.type === 'text' && e.text.includes('raced')));
    session.end(); await session.result;
  });

  it('starts a turn with a steer the server acknowledged after its turn completed', async () => {
    const consumed: string[][] = [];
    const { session, events, requests } = start('mock:steer-strand', { onAgentInputConsumed: ids => consumed.push([...ids]) });
    await waitUntil(() => events.some(e => e.type === 'tool-call'));
    await session.sendAgentMessage([{ type: 'text', text: 'mock:agent-echo stranded' }], ['in-strand']);
    const sent = requests().filter(r => r.method === 'turn/steer' || r.method === 'turn/start').slice(1);
    expect(sent.map(r => r.method)).toEqual(['turn/steer', 'turn/start']);
    await waitUntil(() => consumed.length > 0);
    expect(consumed).toEqual([['in-strand']]);
    session.end(); await session.result;
  });

  it('counts a turn/start submission as read when its turn completes without a userMessage item', async () => {
    const consumed: string[][] = [];
    const { session, events } = start('inspect the working tree', { onAgentInputConsumed: ids => consumed.push([...ids]) }, { CEZ_MOCK_CODEX_NO_USER_ITEM: '1' });
    await waitUntil(() => events.some(e => e.type === 'turn-end'));
    await session.sendAgentMessage([{ type: 'text', text: 'mock:agent-echo idle start' }], ['in-idle']);
    await waitUntil(() => events.filter(e => e.type === 'turn-end').length === 2);
    expect(consumed).toEqual([['in-idle']]);
    expect(events.filter(e => e.type === 'turn-end')[1]).toEqual({ type: 'turn-end' });
    session.end(); await session.result;
  });

  it('reports a turn/start submission unread when its turn fails (#505 review)', async () => {
    const consumed: string[][] = [];
    const { session, events } = start('inspect the working tree', { onAgentInputConsumed: ids => consumed.push([...ids]) }, { CEZ_MOCK_CODEX_NO_USER_ITEM: '1' });
    await waitUntil(() => events.some(e => e.type === 'turn-end'));
    await session.sendAgentMessage([{ type: 'text', text: 'mock:provider-error after guidance' }], ['in-failed']);
    await waitUntil(() => events.filter(e => e.type === 'turn-end').length === 2);
    expect(consumed).toEqual([]);
    expect(events.filter(e => e.type === 'turn-end')[1]).toEqual({ type: 'turn-end', unconsumedInputIds: ['in-failed'] });
    session.end(); await session.result.catch(() => undefined);
  });

  it('rejects a steer whose transport closed unanswered, without retrying it as turn/start (#505 review)', async () => {
    const { session, events, requests } = start('mock:steer-tool', {}, { CEZ_MOCK_CODEX_EXIT_ON_STEER: '1' });
    await waitUntil(() => events.some(e => e.type === 'tool-call'));
    const ack = session.sendAgentMessage([{ type: 'text', text: 'ambiguous' }], ['in-ambiguous']);
    expect(ack).not.toBe(false);
    await expect(ack).rejects.toThrow();
    const methods = requests().map(r => r.method).filter(m => m === 'turn/steer' || m === 'turn/start');
    expect(methods).toEqual(['turn/start', 'turn/steer']); // the opening turn, then the unanswered steer only
    await session.result.catch(() => undefined);
  });
});

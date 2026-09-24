import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import type { AgentEvent, SessionOptions } from './agent-runner.ts';
import type { UiEvent } from './ui-events.ts';
import { OpencodeServerRunner } from './opencode-server-runner.ts';

const mockBin = fileURLToPath(new URL('../../scripts/mock-opencode-serve.mjs', import.meta.url));
const waitUntil = async (cond: () => boolean) => {
  const start = Date.now();
  while (!cond()) { if (Date.now() - start > 10_000) throw new Error('waitUntil timed out'); await new Promise(r => setTimeout(r, 10)); }
};
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const start = (prompt: string, opts: SessionOptions = {}) => {
  const dir = mkdtempSync(join(tmpdir(), 'cez-opencode-steer-')); dirs.push(dir);
  const events: AgentEvent[] = []; const ui: UiEvent[] = [];
  const session = new OpencodeServerRunner({ bin: mockBin, timeoutMs: 0 }).startSession(
    { userPrompt: prompt, cwd: dir }, event => events.push(event), { ...opts, onUiEvent: event => { ui.push(event); opts.onUiEvent?.(event); } });
  return { session, events, ui };
};

describe('opencode agent input steering (#505)', () => {
  it('posts busy agent input into the running turn and reports consumption by parentID', async () => {
    const consumed: string[][] = [];
    const { session, events, ui } = start('mock:steer-tool', { onAgentInputConsumed: ids => consumed.push([...ids]) });
    await waitUntil(() => events.some(e => e.type === 'tool-call'));
    const ack = session.sendAgentMessage([{ type: 'text', text: 'mid-turn update' }], ['in-1']);
    expect(ack).not.toBe(false);
    await ack;
    expect(consumed).toEqual([]); // the HTTP acknowledgement is not consumption
    await waitUntil(() => events.some(e => e.type === 'turn-end'));
    expect(consumed).toEqual([['in-1']]);
    expect(events.filter(e => e.type === 'turn-end')).toEqual([{ type: 'turn-end' }]);
    // Busy input joins the running turn: one normalized turn, not two.
    expect(ui.filter(e => e.type === 'turn.started')).toHaveLength(1);
    expect(events.some(e => e.type === 'text' && e.text.includes('mid-turn update'))).toBe(true);
    session.end(); await session.result;
  });

  it('reports busy input a quiet idle session never read, after the lost-wake grace window', async () => {
    const { session, events } = start('mock:steer-late');
    await waitUntil(() => events.some(e => e.type === 'text'));
    await session.sendAgentMessage([{ type: 'text', text: 'too late' }], ['in-late']);
    await waitUntil(() => events.some(e => e.type === 'turn-end'));
    expect(events.find(e => e.type === 'turn-end')).toEqual({ type: 'turn-end' });
    expect(events.some(e => e.type === 'input-unconsumed')).toBe(false); // grace window still open
    await waitUntil(() => events.some(e => e.type === 'input-unconsumed'));
    expect(events.find(e => e.type === 'input-unconsumed')).toEqual({ type: 'input-unconsumed', inputIds: ['in-late'] });
    session.end(); await session.result;
  });

  it('opens a new turn when the server runs steered input after going idle', async () => {
    // The steer lands as the first turn ends; the mock runs it as its own server run.
    const consumed: string[][] = [];
    const { session, events, ui } = start('inspect the working tree', { onAgentInputConsumed: ids => consumed.push([...ids]) });
    await waitUntil(() => events.some(e => e.type === 'turn-end'));
    await session.sendAgentMessage([{ type: 'text', text: 'mock:agent-echo next 0' }], ['n0']);
    await session.sendAgentMessage([{ type: 'text', text: 'mock:agent-echo next 1' }], ['n1']);
    await waitUntil(() => consumed.flat().includes('n1'));
    await new Promise(resolve => setTimeout(resolve, 2_500));
    expect(events.some(e => e.type === 'input-unconsumed')).toBe(false);
    // Opening turn, n0's turn, and the server run that answered n1 each end once.
    expect(events.filter(e => e.type === 'turn-end')).toHaveLength(3);
    expect(ui.filter(e => e.type === 'turn.started')).toHaveLength(3);
    session.end(); await session.result;
  }, 15_000);

  it('counts an idle prompt as read when its turn goes idle', async () => {
    const consumed: string[][] = [];
    const { session, events } = start('inspect the working tree', { onAgentInputConsumed: ids => consumed.push([...ids]) });
    await waitUntil(() => events.some(e => e.type === 'turn-end'));
    await session.sendAgentMessage([{ type: 'text', text: 'mock:agent-echo idle start' }], ['in-idle']);
    await waitUntil(() => events.filter(e => e.type === 'turn-end').length === 2);
    expect(consumed).toEqual([['in-idle']]);
    session.end(); await session.result;
  });

  it('never marks an idle prompt read when its turn fails before any assistant message (#505 review)', async () => {
    const consumed: string[][] = [];
    const { session, events } = start('inspect the working tree', { onAgentInputConsumed: ids => consumed.push([...ids]) });
    await waitUntil(() => events.some(e => e.type === 'turn-end'));
    await session.sendAgentMessage([{ type: 'text', text: 'mock:provider-error-early guidance' }], ['in-failed']);
    await waitUntil(() => events.filter(e => e.type === 'turn-end').length === 2);
    expect(consumed).toEqual([]);
    session.end(); await session.result.catch(() => undefined);
  });
});

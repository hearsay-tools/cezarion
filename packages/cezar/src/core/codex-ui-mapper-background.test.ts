/**
 * A Codex child that outlives the parent turn (hearsay-tools/cezarion#2431). Codex 0.164.0 reports
 * the spawn as `subAgentActivity(kind: started)` and the child's end as a parent-thread
 * `subAgentActivity(kind: completed)` stamped with the parent turn that already completed. The
 * spawn row carries `background: true` and completes exactly once. The golden
 * `background-subagent` fixture pins the captured sequence; these cases pin each branch and the
 * runner path that delivers the late frame.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';

import { CodexAppServerRunner } from './codex-app-server-runner.ts';
import { createCodexUiState, mapCodexNotification, type CodexUiMapperState } from './codex-ui-mapper.ts';
import type { UiEvent, UiToolItem } from './ui-events.ts';
import { UNSET_TOOL_GRANT } from './tool-grant.testkit.ts';

const HERE = dirname(fileURLToPath(import.meta.url));

function fold(frames: readonly unknown[], start: CodexUiMapperState = createCodexUiState()): { events: UiEvent[]; state: CodexUiMapperState } {
  let state = start;
  const events: UiEvent[] = [];
  for (const frame of frames) {
    const mapped = mapCodexNotification(frame, state);
    state = mapped.state;
    events.push(...mapped.events);
  }
  return { events, state };
}

const tools = (events: readonly UiEvent[]): Array<{ type: string; item: UiToolItem }> =>
  events.flatMap(event => 'item' in event && event.item.kind === 'tool' ? [{ type: event.type, item: event.item }] : []);

const onParent = (method: string, item: Record<string, unknown>) => ({ method, params: { threadId: 'th_parent', turnId: 'turn_parent', item } });
const started = { type: 'subAgentActivity', id: 'call_1', kind: 'started', agentThreadId: 'th_child', agentPath: '/root/sleep_child' };
const ended = (thread = 'th_child') => ({ type: 'subAgentActivity', id: 'subagent-completed-turn_child', kind: 'completed', agentThreadId: thread, agentPath: '/root/sleep_child' });
const turnCompleted = { method: 'turn/completed', params: { threadId: 'th_parent', turn: { id: 'turn_parent', status: 'completed' } } };

describe('codex background sub-agents (hearsay-tools/cezarion#2431)', () => {
  it('starts the spawn row as a running background task and completes it once after the parent turn', () => {
    const { events } = fold([
      { method: 'turn/started', params: { threadId: 'th_parent', turn: { id: 'turn_parent', status: 'inProgress', items: [] } } },
      onParent('item/started', started), onParent('item/completed', started), turnCompleted,
      onParent('item/started', ended()), onParent('item/completed', ended()),
      onParent('item/started', ended()), onParent('item/completed', ended()),
    ]);
    expect(tools(events).map(({ type, item }) => [type, item.id, item.status, item.background])).toEqual([
      ['item.started', 'call_1', 'running', true],
      ['item.completed', 'call_1', 'completed', true],
    ]);
    expect(events.filter(event => event.type === 'turn.started')).toHaveLength(1);
  });

  it('completes the row when the child ends inside the parent turn', () => {
    const { events } = fold([onParent('item/completed', started), onParent('item/completed', ended()), turnCompleted]);
    expect(events.map(event => [event.type, 'item' in event ? event.item.id : undefined])).toEqual([
      ['item.started', 'call_1'], ['item.completed', 'call_1'], ['turn.completed', undefined],
    ]);
  });

  it('emits nothing for a completion it cannot match', () => {
    expect(tools(fold([onParent('item/completed', started), onParent('item/completed', ended('th_other'))]).events))
      .toEqual([expect.objectContaining({ type: 'item.started' })]);
  });

  it('leaves a collaboration tool-call spawn to its own wait call', () => {
    const spawn = { type: 'collabAgentToolCall', id: 'spawn_1', tool: 'spawnAgent', status: 'inProgress', receiverThreadIds: ['th_child'] };
    const { events } = fold([onParent('item/started', spawn), onParent('item/completed', ended())]);
    expect(tools(events).map(({ type, item }) => [type, item.id, item.background])).toEqual([['item.started', 'spawn_1', undefined]]);
  });
});

describe('codex background sub-agents on the mock wire (hearsay-tools/cezarion#2431)', () => {
  const mockBin = join(HERE, '__fixtures__', 'codex', 'mock-codex-app-server.mjs');

  async function driveMock(tokens: string): Promise<UiEvent[]> {
    const dir = mkdtempSync(join(tmpdir(), 'cez-codex-bg-'));
    const release = join(dir, 'release');
    const ui: UiEvent[] = [];
    const session = new CodexAppServerRunner({ bin: mockBin, timeoutMs: 0 }).startSession(
      { toolGrant: UNSET_TOOL_GRANT, userPrompt: `mock:subagent-background ${tokens} parity-release=${release}`, cwd: dir },
      () => {},
      { onUiEvent: event => ui.push(event) },
    );
    const completions = () => ui.filter(event => event.type === 'item.completed' && event.item.kind === 'tool' && event.item.background === true);
    try {
      // bound: the mock's parking turn completes before the release file exists.
      await vi.waitFor(() => expect(ui.some(event => event.type === 'turn.completed')).toBe(true), { timeout: 20_000 });
      expect(completions()).toEqual([]);
      writeFileSync(release, 'go');
      const children = Number(/subagents=(\d+)/.exec(tokens)?.[1] ?? 1);
      // bound: the mock reports each child's end after the release.
      await vi.waitFor(() => expect(completions()).toHaveLength(children), { timeout: 20_000 });
      return ui;
    } finally {
      session.end();
      await session.result.catch(() => undefined);
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it('keeps the row running past the parent turn and completes it from the stale-turn frame, with no new turn', async () => {
    const ui = await driveMock('');
    expect(ui.filter(event => event.type === 'turn.started')).toHaveLength(1);
    const rows = tools(ui).filter(({ item }) => item.id === 'call_bg_01').map(({ type, item }) => [type, item.status]);
    expect(rows).toEqual([['item.started', 'running'], ['item.completed', 'completed']]);
  }, 60_000);

  // The second child's end is written after the first child's duplicate, so waiting for it reads
  // past that duplicate.
  it('completes two children once each and ignores duplicates', async () => {
    const ui = await driveMock('subagents=2 subagent-duplicate');
    const done = ui.filter(event => event.type === 'item.completed' && event.item.kind === 'tool' && event.item.background === true).map(event => (event as { item: UiToolItem }).item.id);
    expect(done).toEqual(['call_bg_01', 'call_bg_02']);
    expect(ui.filter(event => event.type === 'turn.started')).toHaveLength(1);
  }, 60_000);
});

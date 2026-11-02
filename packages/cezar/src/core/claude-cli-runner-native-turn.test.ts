/**
 * hearsay-tools/cezarion#1512: Claude resumes the parent agent without a stdin line — after a
 * background task's notification or a native peer message. The runner emits exactly one
 * `turn.started` for that work, at its first parent `assistant` frame, so the workflow sees the
 * run working again. Passive frames never open a turn, and a stdin-opened or queued-line turn
 * keeps its single `turn.started`.
 */
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AgentEvent } from './agent-runner.ts';
import { ClaudeCliRunner } from './claude-cli-runner.ts';
import type { UiEvent } from './ui-events.ts';
import { UNSET_TOOL_GRANT } from './tool-grant.testkit.ts';

const spawnHook = vi.hoisted(() => ({ override: null as null | (() => unknown) }));

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    spawn: (...args: Parameters<typeof actual.spawn>) =>
      spawnHook.override ? spawnHook.override() : actual.spawn(...args),
  };
});

afterEach(() => { spawnHook.override = null; });

/** A fake claude child whose stdout the test writes frame by frame. */
function pipeSession() {
  const emitter = new EventEmitter();
  const stdout = new PassThrough();
  const stdin = new PassThrough();
  const written: Array<{ uuid: string }> = [];
  let buffered = '';
  stdin.on('data', chunk => {
    buffered += String(chunk);
    let i;
    while ((i = buffered.indexOf('\n')) >= 0) { written.push(JSON.parse(buffered.slice(0, i))); buffered = buffered.slice(i + 1); }
  });
  const child = Object.assign(emitter, {
    stdin, stdout, stderr: new PassThrough(), exitCode: null as number | null, signalCode: null as NodeJS.Signals | null, killed: false,
    kill: () => { close(); return true; },
  }) as unknown as ChildProcessWithoutNullStreams;
  const close = () => {
    if (child.exitCode !== null) return;
    Object.assign(child, { exitCode: 0 });
    stdout.end();
    emitter.emit('exit', 0, null);
    emitter.emit('close', 0, null);
  };
  spawnHook.override = () => child;
  const v1: AgentEvent[] = [];
  const ui: UiEvent[] = [];
  const session = new ClaudeCliRunner({ bin: 'unused-pipe-fixture' }).startSession(
    { toolGrant: UNSET_TOOL_GRANT, userPrompt: 'opening', cwd: '/tmp', timeoutMs: 0, sessionId: 'native-turn' },
    event => v1.push(event),
    { onUiEvent: event => ui.push(event) },
  );
  /** Write frames, then wait until the runner has mapped a passive hook probe written after them. */
  let probes = 0;
  const frames = async (...lines: unknown[]): Promise<void> => {
    const hookId = `probe-${++probes}`;
    const probe = { type: 'system', subtype: 'hook_response', hook_id: hookId, hook_name: 'Notification', hook_event: 'Notification', stdout: 'probe', stderr: '', exit_code: 0, outcome: 'success' };
    for (const line of [...lines, probe]) stdout.write(`${JSON.stringify(line)}\n`);
    // bound: the runner maps the probe frame we just wrote.
    await vi.waitFor(() => expect(ui.some(event => event.type === 'item.completed' && event.item.id === `hook_${hookId}`)).toBe(true), { timeout: 10_000 });
  };
  const starts = () => ui.filter(event => event.type === 'turn.started').map(event => (event as { turnId: string }).turnId);
  const finish = async () => { session.interrupt(); close(); await session.result; };
  return { session, v1, ui, written, frames, starts, finish };
}

const init = { type: 'system', subtype: 'init', session_id: 'native-turn', model: 'claude-test' };
const parentText = (text: string) => ({ type: 'assistant', parent_tool_use_id: null, message: { role: 'assistant', content: [{ type: 'text', text }] } });
const result = (text: string, uuids?: string[]) => ({
  type: 'result', subtype: 'success', is_error: false, result: text, usage: { input_tokens: 1, output_tokens: 1 },
  ...(uuids ? { user_message_uuids: uuids } : {}),
});
const passiveFrames = [
  init,
  { type: 'system', subtype: 'hook_started', hook_id: 'h1', hook_name: 'Stop', hook_event: 'Stop' },
  { type: 'system', subtype: 'hook_response', hook_id: 'h1', hook_name: 'Stop', hook_event: 'Stop', stdout: 'context', stderr: '', exit_code: 0, outcome: 'success' },
  { type: 'system', subtype: 'task_started', task_id: 'abg01', tool_use_id: 'toolu_bg_01', is_backgrounded: true, task_type: 'local_agent' },
  { type: 'assistant', parent_tool_use_id: 'toolu_bg_01', message: { role: 'assistant', content: [{ type: 'text', text: 'child output' }] } },
  { type: 'user', parent_tool_use_id: 'toolu_bg_01', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'child-read', content: 'ok' }] } },
  { type: 'user', isReplay: true, uuid: 'not-ours', message: { role: 'user', content: [{ type: 'text', text: 'echo' }] } },
  { type: 'system', subtype: 'task_notification', task_id: 'abg01', tool_use_id: 'toolu_bg_01', status: 'completed' },
];

describe('Claude native parent turns (hearsay-tools/cezarion#1512)', () => {
  it('opens no turn for passive frames after the turn ended', async () => {
    const fixture = pipeSession();
    try {
      // bound: wait for the seed stdin write before answering it.
      await vi.waitFor(() => expect(fixture.written).toHaveLength(1), { timeout: 10_000 });
      await fixture.frames(init, parentText('Started a background agent.'), result('Started a background agent.'));
      expect(fixture.starts()).toEqual(['turn_1']);
      await fixture.frames(...passiveFrames);
      expect(fixture.starts()).toEqual(['turn_1']);
    } finally { await fixture.finish(); }
  });

  it('opens exactly one turn at the first parent assistant frame of unprompted work', async () => {
    const fixture = pipeSession();
    try {
      // bound: wait for the seed stdin write before answering it.
      await vi.waitFor(() => expect(fixture.written).toHaveLength(1), { timeout: 10_000 });
      await fixture.frames(init, parentText('Waiting.'), result('Waiting.'));
      await fixture.frames(...passiveFrames, parentText('The agent finished.'), parentText('Next step.'), result('Next step.'));
      expect(fixture.starts()).toEqual(['turn_1', 'turn_2']);
      const types = fixture.ui.map(event => event.type);
      expect(types.indexOf('turn.started', types.indexOf('turn.completed'))).toBeLessThan(types.lastIndexOf('item.started'));
      expect(fixture.ui.filter(event => event.type === 'turn.completed').map(event => (event as { turnId: string }).turnId)).toEqual(['turn_1', 'turn_2']);
      expect(fixture.v1.filter(event => event.type === 'turn-end')).toHaveLength(2);
      // A second unprompted turn after that one ended opens its own turn.
      await fixture.frames(parentText('A peer wrote.'), result('A peer wrote.'));
      expect(fixture.starts()).toEqual(['turn_1', 'turn_2', 'turn_3']);
    } finally { await fixture.finish(); }
  });

  it('keeps a stdin-opened turn to one turn.started', async () => {
    const fixture = pipeSession();
    try {
      // bound: wait for the seed stdin write before answering it.
      await vi.waitFor(() => expect(fixture.written).toHaveLength(1), { timeout: 10_000 });
      await fixture.frames(init, parentText('Done.'), result('Done.'));
      expect(fixture.session.sendMessage([{ type: 'text', text: 'follow-up' }])).toBe(true);
      expect(fixture.starts()).toEqual(['turn_1', 'turn_2']);
      await fixture.frames(parentText('Answering.'), result('Answering.', [fixture.written[1]!.uuid]));
      expect(fixture.starts()).toEqual(['turn_1', 'turn_2']);
    } finally { await fixture.finish(); }
  });

  it('keeps a queued-line turn to one turn.started', async () => {
    const fixture = pipeSession();
    try {
      // bound: wait for the seed stdin write before answering it.
      await vi.waitFor(() => expect(fixture.written).toHaveLength(1), { timeout: 10_000 });
      expect(fixture.session.sendMessage([{ type: 'text', text: 'late line' }])).toBe(true);
      await fixture.frames(init, parentText('First.'), result('First.', [fixture.written[0]!.uuid]));
      expect(fixture.starts()).toEqual(['turn_1']);
      await fixture.frames(parentText('Second.'), result('Second.', [fixture.written[1]!.uuid]));
      expect(fixture.starts()).toEqual(['turn_1', 'turn_2']);
    } finally { await fixture.finish(); }
  });

  it('lets a line written during unprompted work join that turn', async () => {
    const fixture = pipeSession();
    try {
      // bound: wait for the seed stdin write before answering it.
      await vi.waitFor(() => expect(fixture.written).toHaveLength(1), { timeout: 10_000 });
      await fixture.frames(init, parentText('Waiting.'), result('Waiting.'));
      await fixture.frames(parentText('Resumed.'));
      expect(fixture.starts()).toEqual(['turn_1', 'turn_2']);
      expect(fixture.session.sendMessage([{ type: 'text', text: 'human' }])).toBe(true);
      await fixture.frames(result('Resumed.', [fixture.written[1]!.uuid]));
      expect(fixture.starts()).toEqual(['turn_1', 'turn_2']);
    } finally { await fixture.finish(); }
  });

  it('reads the ask marker of the unprompted turn only', async () => {
    const fixture = pipeSession();
    try {
      // bound: wait for the seed stdin write before answering it.
      await vi.waitFor(() => expect(fixture.written).toHaveLength(1), { timeout: 10_000 });
      const ask = 'Which one?\n\nCEZ:ASK {"questions":[{"header":"Pick","question":"Which one?","multiSelect":false,"options":[{"label":"A"},{"label":"B"}]}]}';
      await fixture.frames(init, parentText(ask), result(ask));
      expect(fixture.session.sendAgentMessage([{ type: 'text', text: 'wake' }], ['wake-1'])).toBe(false);
      // The unprompted turn writes no text of its own, so only a reset turn start drops the old marker.
      const read = { type: 'assistant', parent_tool_use_id: null, message: { role: 'assistant', content: [{ type: 'tool_use', id: 'read-1', name: 'Read', input: { file_path: 'a' } }] } };
      const readResult = { type: 'user', parent_tool_use_id: null, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'read-1', content: 'ok' }] } };
      await fixture.frames(read, readResult, result(''));
      const sent = fixture.session.sendAgentMessage([{ type: 'text', text: 'wake' }], ['wake-1']);
      expect(sent).not.toBe(false);
      await sent;
    } finally { await fixture.finish(); }
  });
});

describe('Claude native parent turns on the mock wire (hearsay-tools/cezarion#1512)', () => {
  const mockBin = fileURLToPath(new URL('../../scripts/mock-claude.mjs', import.meta.url));

  async function driveMock(tokens: string): Promise<UiEvent[]> {
    const dir = mkdtempSync(join(tmpdir(), 'cez-native-turn-'));
    const release = join(dir, 'release');
    const ui: UiEvent[] = [];
    const session = new ClaudeCliRunner({ bin: mockBin, timeoutMs: 0 }).startSession(
      { toolGrant: UNSET_TOOL_GRANT, userPrompt: `mock:subagent-background ${tokens} parity-release=${release}`, cwd: dir, sessionId: 'native-turn',
        env: { CEZ_HANDOFF_FILE: '', CEZ_TODOS_FILE: '', CEZ_MOCK_ARGS_FILE: '', CEZ_MOCK_NOTES: '0' } },
      () => {},
      { onUiEvent: event => ui.push(event) },
    );
    try {
      // bound: the mock's parking turn ends before the release file exists.
      await vi.waitFor(() => expect(ui.some(event => event.type === 'turn.completed')).toBe(true), { timeout: 20_000 });
      writeFileSync(release, 'go');
      // bound: the mock reports the child's end after the release.
      await vi.waitFor(() => expect(ui.some(event => event.type === 'item.completed' && event.item.id === 'toolu_bg_01')).toBe(true), { timeout: 20_000 });
      if (tokens.includes('subagent-resume')) {
        // bound: the unprompted parent turn follows the notification.
        await vi.waitFor(() => expect(ui.filter(event => event.type === 'turn.completed')).toHaveLength(2), { timeout: 20_000 });
      }
      return ui;
    } finally {
      session.end();
      await session.result.catch(() => undefined);
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it('opens one turn for the parent turn Claude starts after the background child ends', async () => {
    const ui = await driveMock('subagent-resume');
    expect(ui.filter(event => event.type === 'turn.started').map(event => (event as { turnId: string }).turnId)).toEqual(['turn_1', 'turn_2']);
    const completed = ui.filter(event => event.type === 'item.completed' && event.item.id === 'toolu_bg_01');
    expect(completed).toHaveLength(1);
    expect(completed[0]).toMatchObject({ item: { status: 'completed', background: true } });
  }, 60_000);

  it('opens no turn when the child ends and the parent does not resume', async () => {
    const ui = await driveMock('subagent-duplicate');
    expect(ui.filter(event => event.type === 'turn.started')).toHaveLength(1);
    const completed = ui.filter(event => event.type === 'item.completed' && event.item.id === 'toolu_bg_01');
    expect(completed).toHaveLength(1);
    expect(completed[0]).toMatchObject({ item: { background: true } });
    expect(ui.indexOf(completed[0]!)).toBeGreaterThan(ui.findIndex(event => event.type === 'turn.completed'));
  }, 60_000);
});

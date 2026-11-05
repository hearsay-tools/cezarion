import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { ActivityTool } from '@open-mercato/cezar-contract';
import { activityToolSchema } from '@open-mercato/cezar-contract/activity';
import { RUNNER_IDS, type RunnerId } from '../core/agent-runner.ts';
import type { UiEvent } from '../core/ui-events.ts';
import { z } from 'zod';
import { createOpencodeUiState, mapOpencodeEvent, opencodeSessionStarted, opencodeTurnStarted, STATUS_MAP as OPENCODE_TOOL_STATUS_MAP, type OpencodeUiMapperState } from '../core/opencode-ui-mapper.ts';
import { UiEventSink } from '../runs/ui-event-sink.ts';
import { ToolActivityTracker } from './tool-activity.ts';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '..', 'core', '__fixtures__');
const NOW = Date.parse('2026-11-05T12:00:00.000Z');
const AT = new Date(NOW).toISOString();
/** The contract's tool statuses, named through the schema. */
const TOOL_STATUS = activityToolSchema.shape.status.enum;
/** OpenCode's own tool states on the wire. */
const WIRE_TOOL_STATUS = z.enum(Object.keys(OPENCODE_TOOL_STATUS_MAP)).enum;

/**
 * One golden fixture for each runner: the events its mapper emits for that wire (each mapper's own
 * test holds the replay equal to `<fixture>.expected.json`), and what the tracker must show after
 * them. The `Record` makes a new runner fail to compile until it has a row.
 */
const CASES: Record<RunnerId, { fixture: string; calls: number; latest: Omit<ActivityTool, 'startedAt' | 'endedAt'> }> = {
  // The denied call is first seen at its completion.
  claude: { fixture: 'claude/failed-and-denied', calls: 2, latest: { title: 'Ran rm -rf node_modules', toolKind: 'execute', status: TOOL_STATUS.declined } },
  codex: { fixture: 'codex/command-lifecycle', calls: 2, latest: { title: 'Ran bash -lc npm run lint', toolKind: 'execute', status: TOOL_STATUS.failed } },
  // A pending → running update replaces the title.
  opencode: { fixture: 'opencode/tool-lifecycle', calls: 2, latest: { title: 'Fetch https://example.com/docs', toolKind: 'fetch', status: TOOL_STATUS.failed } },
  pi: { fixture: 'pi/rpc-lifecycle', calls: 4, latest: { title: 'Ran npm test', toolKind: 'execute', status: TOOL_STATUS.failed } },
  cursor: { fixture: 'cursor/print-tools', calls: 3, latest: { title: 'Task: Survey tests', toolKind: 'task', status: TOOL_STATUS.completed } },
  // Two edits take their final title only at completion.
  omp: { fixture: 'omp/rpc-edit-todo', calls: 7, latest: { title: 'Update plan', toolKind: 'plan', status: TOOL_STATUS.completed } },
};

function events(fixture: string): UiEvent[] {
  return JSON.parse(readFileSync(join(FIXTURES, `${fixture}.expected.json`), 'utf8')) as UiEvent[];
}

/** Feed `fixture` through a UI event sink as a run's session does, the tracker observing it. */
function track(fixture: string, runId = 'run-1'): ToolActivityTracker {
  const tracker = new ToolActivityTracker({ now: () => NOW });
  const sink = new UiEventSink({ persist: () => undefined, emitLive: () => undefined, observe: (event) => tracker.observe(runId, event, (text) => text) });
  for (const event of events(fixture)) sink.handle(event);
  sink.sessionEnded('end_turn');
  return tracker;
}

describe('tool activity from each runner’s mapper output', () => {
  it('has a fixture for every runner', () => {
    expect(Object.keys(CASES).sort()).toEqual([...RUNNER_IDS].sort());
  });

  it.each(RUNNER_IDS)('%s: its tool items reach the tracker through the UI event sink', (runner) => {
    const { fixture, calls, latest } = CASES[runner];
    const read = track(fixture).read('run-1', NOW);
    expect(read?.tool).toEqual({ ...latest, startedAt: AT, endedAt: AT });
    expect(read?.rate.at(-1)).toBe(calls);
    expect(read?.rate.slice(0, -1).every((count) => count === 0)).toBe(true);
  });

  it('omp: an edit’s final title arrives with its completion', () => {
    const tracker = new ToolActivityTracker({ now: () => NOW });
    const all = events('omp/rpc-edit-todo');
    const end = all.findIndex((event) => event.type === 'item.completed' && event.item.id === 'toolu_edit_1');
    for (const event of all.slice(0, end + 1)) tracker.observe('run-1', event, (text) => text);
    expect(tracker.read('run-1', NOW)?.tool).toMatchObject({ title: 'Edit src/greet.ts', status: TOOL_STATUS.completed });
  });

  /**
   * OpenCode completes a task tool item twice: at its child session's idle, and again when the task
   * result arrives. The second completion is not a new call.
   */
  describe('opencode: a task completed twice', () => {
    const MAIN = 'ses_main';
    /** Wire frames as the opencode server sends them, run through the real mapper and a sink. */
    function replay(withNewerTool: boolean) {
      const clock = { now: NOW };
      const tracker = new ToolActivityTracker({ now: () => clock.now });
      const sink = new UiEventSink({ persist: () => undefined, emitLive: () => undefined, observe: (event) => tracker.observe('run-1', event, (text) => text) });
      let state: OpencodeUiMapperState = opencodeTurnStarted(opencodeSessionStarted(MAIN, createOpencodeUiState()).state).state;
      const send = (frame: unknown) => {
        const mapped = mapOpencodeEvent(frame, state);
        state = mapped.state;
        for (const event of mapped.events) sink.handle(event);
      };
      const part = (fields: Record<string, unknown>) => ({ type: 'message.part.updated', properties: { part: { messageID: 'msg_a', sessionID: MAIN, ...fields } } });
      send({ type: 'message.updated', properties: { info: { id: 'msg_a', sessionID: MAIN, role: 'assistant' } } });
      send(part({ id: 'prt_task', type: 'tool', tool: 'task', state: { status: WIRE_TOOL_STATUS.running, input: { description: 'Dig in' } } }));
      send({ type: 'message.updated', properties: { info: { id: 'msg_child', sessionID: 'ses_child', role: 'assistant' } } });
      send(part({ id: 'prt_c', messageID: 'msg_child', sessionID: 'ses_child', type: 'text', text: 'found it' }));
      clock.now += 2_000;
      send({ type: 'session.idle', properties: { sessionID: 'ses_child' } });
      const afterIdle = tracker.read('run-1', clock.now);
      if (withNewerTool) {
        clock.now += 1_000;
        send(part({ id: 'prt_bash', type: 'tool', tool: 'bash', state: { status: WIRE_TOOL_STATUS.running, input: { command: 'npm test', description: 'npm test' } } }));
      }
      clock.now += 1_000;
      send(part({ id: 'prt_task', type: 'tool', tool: 'task', state: { status: WIRE_TOOL_STATUS.completed, input: { description: 'Dig in' }, output: 'the answer' } }));
      return { afterIdle, after: tracker.read('run-1', clock.now), sum: (rate: readonly number[] | undefined) => rate?.reduce((a, b) => a + b, 0) };
    }

    it('counts the task once and keeps its times', () => {
      const { afterIdle, after, sum } = replay(false);
      expect(afterIdle?.tool).toMatchObject({ toolKind: 'task', status: TOOL_STATUS.completed, startedAt: AT, endedAt: new Date(NOW + 2_000).toISOString() });
      expect(after?.tool).toEqual(afterIdle?.tool);
      expect(sum(after?.rate)).toBe(1);
    });

    it('keeps a newer tool as the latest', () => {
      const { after, sum } = replay(true);
      expect(after?.tool).toMatchObject({ toolKind: 'execute', status: TOOL_STATUS.running, startedAt: new Date(NOW + 3_000).toISOString() });
      expect(sum(after?.rate)).toBe(2);
    });
  });
});

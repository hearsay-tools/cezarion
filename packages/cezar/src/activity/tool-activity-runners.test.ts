import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { ActivityTool } from '@open-mercato/cezar-contract';
import { activityToolSchema } from '@open-mercato/cezar-contract/activity';
import { RUNNER_IDS, type RunnerId } from '../core/agent-runner.ts';
import type { UiEvent } from '../core/ui-events.ts';
import { UiEventSink } from '../runs/ui-event-sink.ts';
import { ToolActivityTracker } from './tool-activity.ts';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '..', 'core', '__fixtures__');
const NOW = Date.parse('2026-11-05T12:00:00.000Z');
const AT = new Date(NOW).toISOString();
/** The contract's tool statuses, named through the schema. */
const TOOL_STATUS = activityToolSchema.shape.status.enum;

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
  const sink = new UiEventSink({ persist: () => undefined, emitLive: () => undefined, observe: (event) => tracker.observe(runId, event) });
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
    for (const event of all.slice(0, end + 1)) tracker.observe('run-1', event);
    expect(tracker.read('run-1', NOW)?.tool).toMatchObject({ title: 'Edit src/greet.ts', status: TOOL_STATUS.completed });
  });
});

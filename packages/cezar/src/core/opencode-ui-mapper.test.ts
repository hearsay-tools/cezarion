/**
 * Golden tests for the opencode SSE-bus → v2 mapper: each fixture in
 * `__fixtures__/opencode/` is a wire-faithful `{type, properties}` bus-event
 * transcript (shapes from `.ai/analysis/cockpit-ui-redesign/agent-event-protocols.md`
 * §4); its `.expected.json` is the EXACT `UiEvent` sequence the mapper must
 * produce. Plus edge cases (never-throw, cursor/delta correctness, the
 * pending-phase distinction, cost propagation, session.idle semantics) and a
 * live wiring test through the real runner against the bundled mock server —
 * including that both streams take their turn-end from `session.idle`, not
 * from the `prompt_async` HTTP response (#4).
 */
import { readFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';

import type { AgentEvent } from './agent-runner.ts';
import type { UiEvent } from './ui-events.ts';
import {
  createOpencodeUiState,
  mapOpencodeEvent,
  opencodeSessionStarted,
  opencodeTurnStarted,
  type OpencodeUiMapperState,
  type OpencodeUiMapping,
} from './opencode-ui-mapper.ts';
import { OpencodeServerRunner } from './opencode-server-runner.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(HERE, '__fixtures__', 'opencode');

/** The main-session id every fixture uses (opencode has no wire-level
 *  session-start — the runner gets the id from its POST /session). */
const SESSION_ID = 'ses_01J8ZE00MAIN';

/** Replay a fixture exactly as the runner drives the mapper: the POST
 *  /session result and the prompt POST fire the out-of-band helpers BEFORE
 *  the SSE frames stream in; unparseable frames are skipped. */
function replay(fixture: string): UiEvent[] {
  const raw = readFileSync(join(FIXTURES, `${fixture}.ndjson`), 'utf8');
  let state = createOpencodeUiState();
  const events: UiEvent[] = [];
  const fold = (mapped: OpencodeUiMapping): void => {
    state = mapped.state;
    events.push(...mapped.events);
  };
  fold(opencodeSessionStarted(SESSION_ID, state));
  fold(opencodeTurnStarted(state));
  for (const line of raw.split('\n')) {
    if (line.trim() === '') continue;
    let evt: unknown;
    try {
      evt = JSON.parse(line);
    } catch {
      continue; // mirrors the runner: malformed SSE frames are skipped
    }
    fold(mapOpencodeEvent(evt, state));
  }
  return events;
}

function expectedEvents(fixture: string): unknown {
  return JSON.parse(readFileSync(join(FIXTURES, `${fixture}.expected.json`), 'utf8'));
}

const GOLDEN_FIXTURES = [
  'text-turn',
  'tool-lifecycle',
  'todowrite-plan',
  'patch-and-step-finish',
  'subtask-nested',
  'subtask-overlapping',
  'session-error',
] as const;

describe('opencode → v2 golden fixtures', () => {
  for (const fixture of GOLDEN_FIXTURES) {
    it(`maps ${fixture} to the exact UiEvent sequence`, () => {
      // Round-trip through JSON so stray `undefined` properties fail loudly —
      // these events get persisted as NDJSON in step 2.1.
      const actual = JSON.parse(JSON.stringify(replay(fixture)));
      expect(actual).toStrictEqual(expectedEvents(fixture));
    });
  }
});

/** A started session with one assistant message role recorded — the baseline
 *  most part-level edge cases need. */
function startedState(): OpencodeUiMapperState {
  let state = opencodeSessionStarted(SESSION_ID, createOpencodeUiState()).state;
  state = opencodeTurnStarted(state).state;
  return mapOpencodeEvent(
    { type: 'message.updated', properties: { info: { id: 'msg_a', sessionID: SESSION_ID, role: 'assistant' } } },
    state,
  ).state;
}

function part(fields: Record<string, unknown>, delta?: string): Record<string, unknown> {
  const properties: Record<string, unknown> = {
    part: { messageID: 'msg_a', sessionID: SESSION_ID, ...fields },
  };
  if (delta !== undefined) properties.delta = delta;
  return { type: 'message.part.updated', properties };
}

describe('mapOpencodeEvent edge cases', () => {
  it('malformed events produce no events and never throw', () => {
    const state = startedState();
    const frames: unknown[] = [
      null,
      undefined,
      42,
      'session.idle',
      [],
      {},
      { type: 5 },
      { type: 'server.connected' },
      { type: 'session.updated', properties: { info: { id: SESSION_ID } } },
      { type: 'message.part.removed', properties: { part: { id: 'prt_x' } } },
      { type: 'permission.updated', properties: { id: 'perm_1' } }, // reserved for permission.*
      { type: 'message.part.updated' }, // no properties
      { type: 'message.part.updated', properties: { part: 'oops' } },
      { type: 'message.part.updated', properties: { part: { type: 'text' } } }, // no id
      { type: 'message.part.updated', properties: { part: { id: 'prt_x' } } }, // no type
      part({ id: 'prt_x', type: 'file', filename: 'a.png' }), // unmapped part type
      part({ id: 'prt_x', type: 'step-start' }),
      part({ id: 'prt_x', type: 'tool', tool: 'bash' }), // no state → pending, but…
      part({ id: 'prt_sf', type: 'step-finish' }), // no tokens and no cost
      part({ id: 'prt_p', type: 'patch' }), // no files
      part({ id: 'prt_p', type: 'patch', files: [] }),
      { type: 'message.updated', properties: {} }, // no info
      { type: 'session.error', properties: { sessionID: 'ses_other' } }, // foreign, no subtask
      { type: 'session.idle', properties: { sessionID: 'ses_other' } }, // foreign, no subtask
    ];
    for (const frame of frames) {
      const mapped = mapOpencodeEvent(frame, state);
      // A bare tool part IS renderable (pending, no input) — everything else
      // above maps to zero events.
      if (isBareTool(frame)) continue;
      expect(mapped.events).toEqual([]);
    }
  });

  it('parts of non-assistant (or not-yet-known) messages map to zero events', () => {
    let state = startedState();
    state = mapOpencodeEvent(
      { type: 'message.updated', properties: { info: { id: 'msg_user', sessionID: SESSION_ID, role: 'user' } } },
      state,
    ).state;
    // The user's own prompt echoes over the same feed…
    expect(
      mapOpencodeEvent(part({ id: 'prt_u1', messageID: 'msg_user', type: 'text', text: 'do the thing' }), state).events,
    ).toEqual([]);
    // …and a part whose message role is unknown is "not assistant yet".
    expect(
      mapOpencodeEvent(part({ id: 'prt_q1', messageID: 'msg_unseen', type: 'text', text: 'early' }), state).events,
    ).toEqual([]);
  });

  it('cursor logic: full accumulated text diffs into true deltas; overlaps and retransmits emit nothing', () => {
    let state = startedState();
    const first = mapOpencodeEvent(part({ id: 'prt_t', type: 'text', text: 'Hello' }), state);
    expect(first.events).toEqual([
      { type: 'item.started', item: { kind: 'message', id: 'prt_t', role: 'assistant', text: '' } },
      { type: 'item.delta', itemId: 'prt_t', field: 'text', delta: 'Hello' },
    ]);
    state = first.state;
    // Retransmit of the same accumulated text → no delta.
    expect(mapOpencodeEvent(part({ id: 'prt_t', type: 'text', text: 'Hello' }), state).events).toEqual([]);
    // A SHORTER accumulated text (out-of-order snapshot) → no delta, no throw.
    expect(mapOpencodeEvent(part({ id: 'prt_t', type: 'text', text: 'Hell' }), state).events).toEqual([]);
    // Growth emits only the newly-appended tail.
    const grown = mapOpencodeEvent(part({ id: 'prt_t', type: 'text', text: 'Hello world' }), state);
    expect(grown.events).toEqual([{ type: 'item.delta', itemId: 'prt_t', field: 'text', delta: ' world' }]);
    // …without mutating the previous state (explicit-state contract).
    expect(mapOpencodeEvent(part({ id: 'prt_t', type: 'text', text: 'Hello world' }), state).events).toHaveLength(1);
  });

  it('a server-sent delta field wins over cursor diffing and keeps the cursor consistent', () => {
    let state = startedState();
    state = mapOpencodeEvent(part({ id: 'prt_t', type: 'text', text: 'Hello' }), state).state;
    const viaDelta = mapOpencodeEvent(part({ id: 'prt_t', type: 'text', text: 'Hello world' }, ' world'), state);
    expect(viaDelta.events).toEqual([{ type: 'item.delta', itemId: 'prt_t', field: 'text', delta: ' world' }]);
    // A follow-up full-text-only update covering the same text adds nothing.
    expect(mapOpencodeEvent(part({ id: 'prt_t', type: 'text', text: 'Hello world' }), viaDelta.state).events).toEqual([]);
  });

  it('time.end completes a text part exactly once', () => {
    let state = startedState();
    const done = mapOpencodeEvent(
      part({ id: 'prt_t', type: 'text', text: 'All set.', time: { start: 1, end: 2 } }),
      state,
    );
    expect(done.events).toEqual([
      { type: 'item.started', item: { kind: 'message', id: 'prt_t', role: 'assistant', text: '' } },
      { type: 'item.delta', itemId: 'prt_t', field: 'text', delta: 'All set.' },
      { type: 'item.completed', item: { kind: 'message', id: 'prt_t', role: 'assistant', text: 'All set.' } },
    ]);
    state = done.state;
    expect(
      mapOpencodeEvent(part({ id: 'prt_t', type: 'text', text: 'All set.', time: { start: 1, end: 2 } }), state).events,
    ).toEqual([]);
  });

  it('opencode is the only backend with a real pending phase — first sight of a pending tool emits status pending', () => {
    const state = startedState();
    const [started] = mapOpencodeEvent(
      part({ id: 'prt_b', type: 'tool', tool: 'bash', state: { status: 'pending', input: { command: 'ls' } } }),
      state,
    ).events;
    expect(started).toEqual({
      type: 'item.started',
      item: { kind: 'tool', id: 'prt_b', name: 'bash', toolKind: 'execute', title: 'Ran ls', status: 'pending', input: { command: 'ls' } },
    });
  });

  it('tool state carries across updates: pending→running flips via item.updated, error settles as failed', () => {
    let state = startedState();
    state = mapOpencodeEvent(
      part({ id: 'prt_b', type: 'tool', tool: 'bash', state: { status: 'pending', input: { command: 'ls' } } }),
      state,
    ).state;
    const running = mapOpencodeEvent(
      part({ id: 'prt_b', type: 'tool', tool: 'bash', state: { status: 'running', input: { command: 'ls' }, title: 'ls', time: { start: 1 } } }),
      state,
    );
    expect(running.events).toEqual([
      {
        type: 'item.updated',
        item: { kind: 'tool', id: 'prt_b', name: 'bash', toolKind: 'execute', title: 'ls', status: 'running', input: { command: 'ls' } },
      },
    ]);
    state = running.state;
    // A repeated running update with the same title is a no-op…
    expect(mapOpencodeEvent(
      part({ id: 'prt_b', type: 'tool', tool: 'bash', state: { status: 'running', input: { command: 'ls' }, title: 'ls' } }),
      state,
    ).events).toEqual([]);
    // …but a new live title re-renders the card.
    expect(mapOpencodeEvent(
      part({ id: 'prt_b', type: 'tool', tool: 'bash', state: { status: 'running', input: { command: 'ls' }, title: 'ls -la' } }),
      state,
    ).events).toEqual([
      {
        type: 'item.updated',
        item: { kind: 'tool', id: 'prt_b', name: 'bash', toolKind: 'execute', title: 'ls -la', status: 'running', input: { command: 'ls' } },
      },
    ]);
    const failed = mapOpencodeEvent(
      part({ id: 'prt_b', type: 'tool', tool: 'bash', state: { status: 'error', input: { command: 'ls' }, error: 'killed', time: { start: 1, end: 2 } } }),
      state,
    );
    expect(failed.events).toEqual([
      {
        type: 'item.completed',
        item: { kind: 'tool', id: 'prt_b', name: 'bash', toolKind: 'execute', title: 'ls', status: 'failed', input: { command: 'ls' }, error: 'killed' },
      },
    ]);
    // A duplicate settled snapshot emits nothing.
    expect(mapOpencodeEvent(
      part({ id: 'prt_b', type: 'tool', tool: 'bash', state: { status: 'error', input: { command: 'ls' }, error: 'killed' } }),
      failed.state,
    ).events).toEqual([]);
  });

  it('a tool part first seen already completed is a lone final snapshot', () => {
    const [event] = mapOpencodeEvent(
      part({ id: 'prt_g', type: 'tool', tool: 'read', state: { status: 'completed', input: { filePath: 'src/a.ts' }, output: 'contents' } }),
      startedState(),
    ).events;
    expect(event).toMatchObject({ type: 'item.completed', item: { status: 'completed', output: 'contents' } });
  });

  it('identical todowrite snapshots emit plan.updated once (full-replacement, deduplicated)', () => {
    let state = startedState();
    const todos = { todos: [{ id: '1', content: 'Fix it', status: 'in_progress', priority: 'high' }] };
    const first = mapOpencodeEvent(
      part({ id: 'prt_td', type: 'tool', tool: 'todowrite', state: { status: 'pending', input: todos } }),
      state,
    );
    expect(first.events).toContainEqual({
      type: 'plan.updated',
      entries: [{ content: 'Fix it', status: 'in_progress', priority: 'high' }],
    });
    state = first.state;
    const second = mapOpencodeEvent(
      part({ id: 'prt_td', type: 'tool', tool: 'todowrite', state: { status: 'running', input: todos } }),
      state,
    );
    expect(second.events.filter((e) => e.type === 'plan.updated')).toHaveLength(0);
  });

  it('todowrite with malformed rows filters them; non-array todos emit no plan', () => {
    const state = startedState();
    const mapped = mapOpencodeEvent(
      part({
        id: 'prt_td',
        type: 'tool',
        tool: 'todowrite',
        state: {
          status: 'completed',
          input: { todos: [{ content: 'ok', status: 'pending' }, { status: 'pending' }, 'junk'] },
        },
      }),
      state,
    );
    expect(mapped.events).toContainEqual({ type: 'plan.updated', entries: [{ content: 'ok', status: 'pending' }] });
    const noPlan = mapOpencodeEvent(
      part({ id: 'prt_td2', type: 'tool', tool: 'todowrite', state: { status: 'completed', input: { todos: 'nope' } } }),
      state,
    );
    expect(noPlan.events.filter((e) => e.type === 'plan.updated')).toHaveLength(0);
  });

  // opencode types `status` as a free-form string (`Schema.String`), not an enum;
  // its documented vocabulary is pending|in_progress|completed|cancelled.
  it('keeps cancelled todos — an abandoned row stays visible instead of vanishing', () => {
    const mapped = mapOpencodeEvent(
      part({
        id: 'prt_td',
        type: 'tool',
        tool: 'todowrite',
        state: {
          status: 'completed',
          input: {
            todos: [
              { content: 'Ship the fix', status: 'completed', priority: 'high' },
              { content: 'Rework the parser', status: 'cancelled', priority: 'low' },
            ],
          },
        },
      }),
      startedState(),
    );
    expect(mapped.events).toContainEqual({
      type: 'plan.updated',
      entries: [
        { content: 'Ship the fix', status: 'completed', priority: 'high' },
        { content: 'Rework the parser', status: 'cancelled', priority: 'low' },
      ],
    });
  });

  it('falls back to pending for a status outside the documented vocabulary', () => {
    const mapped = mapOpencodeEvent(
      part({
        id: 'prt_td',
        type: 'tool',
        tool: 'todowrite',
        state: { status: 'completed', input: { todos: [{ content: 'Odd one', status: 'later' }] } },
      }),
      startedState(),
    );
    expect(mapped.events).toContainEqual({ type: 'plan.updated', entries: [{ content: 'Odd one', status: 'pending' }] });
  });

  // opencode publishes the tool part BEFORE the arguments finish parsing, with
  // `input: {}` — that must not wipe the plan the previous snapshot established.
  it('a pending part with unparsed input emits no plan', () => {
    const mapped = mapOpencodeEvent(
      part({ id: 'prt_td', type: 'tool', tool: 'todowrite', state: { status: 'pending', input: {}, raw: '' } }),
      startedState(),
    );
    expect(mapped.events.filter((e) => e.type === 'plan.updated')).toHaveLength(0);
  });

  it('patch parts accept the paths-only wire shape too (diff entries without unified content)', () => {
    const [event] = mapOpencodeEvent(
      part({ id: 'prt_p', type: 'patch', hash: 'abc123', files: ['src/a.ts', 'src/b.ts'] }),
      startedState(),
    ).events;
    expect(event).toEqual({
      type: 'item.completed',
      item: {
        kind: 'tool',
        id: 'prt_p',
        name: 'patch',
        toolKind: 'edit',
        title: 'Edit 2 files',
        status: 'completed',
        diffs: [
          { path: 'src/a.ts', oldText: null },
          { path: 'src/b.ts', oldText: null },
        ],
        locations: [{ path: 'src/a.ts' }, { path: 'src/b.ts' }],
      },
    });
  });

  it('cost propagation: message.updated carries USD; step-finish increments; the larger total wins per message', () => {
    let state = startedState();
    const step = mapOpencodeEvent(
      part({ id: 'prt_sf1', type: 'step-finish', cost: 0.001, tokens: { input: 100, output: 20, reasoning: 0, cache: { read: 0, write: 0 } } }),
      state,
    );
    expect(step.events).toEqual([
      { type: 'usage.updated', usage: { input: 100, output: 20, total: 120, cacheRead: 0, cacheWrite: 0, reasoning: 0 }, costUsd: 0.001 },
    ]);
    state = step.state;
    // A second step accumulates.
    const step2 = mapOpencodeEvent(
      part({ id: 'prt_sf2', type: 'step-finish', cost: 0.002, tokens: { input: 50, output: 10, reasoning: 0, cache: { read: 0, write: 0 } } }),
      state,
    );
    expect(step2.events[0]).toMatchObject({ usage: { input: 150, output: 30, total: 180 }, costUsd: 0.003 });
    state = step2.state;
    // The message.updated snapshot describes the SAME accumulation — a
    // smaller/equal snapshot must not double-count on top of the steps.
    const stale = mapOpencodeEvent(
      {
        type: 'message.updated',
        properties: {
          info: { id: 'msg_a', sessionID: SESSION_ID, role: 'assistant', cost: 0.003, tokens: { input: 150, output: 30, reasoning: 0, cache: { read: 0, write: 0 } } },
        },
      },
      state,
    );
    expect(stale.events).toEqual([]);
    // A larger snapshot wins and re-emits.
    const fresh = mapOpencodeEvent(
      {
        type: 'message.updated',
        properties: {
          info: { id: 'msg_a', sessionID: SESSION_ID, role: 'assistant', cost: 0.004, tokens: { input: 150, output: 60, reasoning: 0, cache: { read: 0, write: 0 } } },
        },
      },
      stale.state,
    );
    expect(fresh.events[0]).toMatchObject({ usage: { total: 210 }, costUsd: 0.004 });
  });

  it('session.idle closes the current turn once; stray and repeated idles close nothing', () => {
    let state = opencodeSessionStarted(SESSION_ID, createOpencodeUiState()).state;
    // Idle before any prompt POST → nothing to close.
    expect(mapOpencodeEvent({ type: 'session.idle', properties: { sessionID: SESSION_ID } }, state).events).toEqual([]);
    state = opencodeTurnStarted(state).state;
    const closed = mapOpencodeEvent({ type: 'session.idle', properties: { sessionID: SESSION_ID } }, state);
    expect(closed.events).toEqual([{ type: 'turn.completed', turnId: 'turn_1', stopReason: 'end_turn' }]);
    // The idle is consumed — a duplicate closes nothing.
    expect(mapOpencodeEvent({ type: 'session.idle', properties: { sessionID: SESSION_ID } }, closed.state).events).toEqual([]);
    // The next prompt mints turn_2.
    const turn2 = opencodeTurnStarted(closed.state);
    expect(turn2.events).toEqual([{ type: 'turn.started', turnId: 'turn_2' }]);
  });

  it('sums only message usage observed in the active turn and clears it at idle', () => {
    let state = opencodeSessionStarted(SESSION_ID, createOpencodeUiState()).state;
    state = mapOpencodeEvent(
      { type: 'message.updated', properties: { info: { id: 'msg_old', sessionID: SESSION_ID, role: 'assistant', cost: 0.5, tokens: { input: 100, output: 20 } } } },
      state,
    ).state;
    state = opencodeTurnStarted(state).state;
    state = mapOpencodeEvent(
      { type: 'message.updated', properties: { info: { id: 'msg_new', sessionID: SESSION_ID, role: 'assistant', cost: 0.02, tokens: { input: 7, output: 3 } } } },
      state,
    ).state;
    const first = mapOpencodeEvent({ type: 'session.idle', properties: { sessionID: SESSION_ID } }, state);
    expect(first.events).toEqual([
      { type: 'turn.completed', turnId: 'turn_1', stopReason: 'end_turn', usage: { input: 7, output: 3, total: 10 }, costUsd: 0.02 },
    ]);
    state = opencodeTurnStarted(first.state).state;
    expect(mapOpencodeEvent({ type: 'session.idle', properties: { sessionID: SESSION_ID } }, state).events).toEqual([
      { type: 'turn.completed', turnId: 'turn_2', stopReason: 'end_turn' },
    ]);
  });

  it('a session.error inside the turn surfaces as non-fatal and flips the idle stopReason to error', () => {
    let state = opencodeSessionStarted(SESSION_ID, createOpencodeUiState()).state;
    state = opencodeTurnStarted(state).state;
    const errored = mapOpencodeEvent(
      { type: 'session.error', properties: { sessionID: SESSION_ID, error: { name: 'UnknownError', data: { message: 'boom' } } } },
      state,
    );
    expect(errored.events).toEqual([{ type: 'session.error', message: 'boom', fatal: false }]);
    const idle = mapOpencodeEvent({ type: 'session.idle', properties: { sessionID: SESSION_ID } }, errored.state);
    expect(idle.events).toEqual([{ type: 'turn.completed', turnId: 'turn_1', stopReason: 'error' }]);
    // The error flag does not leak into the next turn.
    const next = opencodeTurnStarted(idle.state).state;
    expect(mapOpencodeEvent({ type: 'session.idle', properties: { sessionID: SESSION_ID } }, next).events).toEqual([
      { type: 'turn.completed', turnId: 'turn_2', stopReason: 'end_turn' },
    ]);
  });

  it('foreign-session parts are dropped outside a subtask scope and nested inside one', () => {
    let state = startedState();
    state = mapOpencodeEvent(
      { type: 'message.updated', properties: { info: { id: 'msg_child', sessionID: 'ses_child', role: 'assistant' } } },
      state,
    ).state;
    const orphan = mapOpencodeEvent(
      part({ id: 'prt_f1', messageID: 'msg_child', sessionID: 'ses_child', type: 'text', text: 'noise' }),
      state,
    );
    expect(orphan.events).toEqual([]);
    // Open a subtask scope, and the same foreign part nests under it.
    state = mapOpencodeEvent(
      part({ id: 'prt_st', type: 'subtask', prompt: 'dig in', description: 'Investigate', agent: 'general' }),
      state,
    ).state;
    const nested = mapOpencodeEvent(
      part({ id: 'prt_f1', messageID: 'msg_child', sessionID: 'ses_child', type: 'text', text: 'found it' }),
      state,
    );
    expect(nested.events[0]).toEqual({
      type: 'item.started',
      item: { kind: 'message', id: 'prt_f1', role: 'assistant', text: '', parentItemId: 'prt_st' },
    });
    // The child session going idle completes the subtask item and closes the scope.
    const childIdle = mapOpencodeEvent({ type: 'session.idle', properties: { sessionID: 'ses_child' } }, nested.state);
    expect(childIdle.events).toEqual([
      {
        type: 'item.completed',
        item: {
          kind: 'tool',
          id: 'prt_st',
          name: 'subtask',
          toolKind: 'task',
          title: 'Task: Investigate',
          status: 'completed',
          input: { prompt: 'dig in', description: 'Investigate', agent: 'general' },
        },
      },
    ]);
    expect(
      mapOpencodeEvent(part({ id: 'prt_f2', messageID: 'msg_child', sessionID: 'ses_child', type: 'text', text: 'late' }), childIdle.state)
        .events,
    ).toEqual([]);
  });

  it('main-session idle settles and clears child sessions that never went idle', () => {
    let state = startedState();
    state = mapOpencodeEvent(
      part({ id: 'prt_st', type: 'subtask', prompt: 'dig in', description: 'Investigate', agent: 'general' }),
      state,
    ).state;
    state = mapOpencodeEvent(
      { type: 'message.updated', properties: { info: { id: 'msg_child', sessionID: 'ses_child', role: 'assistant' } } },
      state,
    ).state;
    state = mapOpencodeEvent(
      part({ id: 'prt_child', messageID: 'msg_child', sessionID: 'ses_child', type: 'text', text: 'working' }),
      state,
    ).state;

    const mainIdle = mapOpencodeEvent({ type: 'session.idle', properties: { sessionID: SESSION_ID } }, state);
    expect(mainIdle.events).toContainEqual({
      type: 'item.completed',
      item: {
        kind: 'tool',
        id: 'prt_st',
        name: 'subtask',
        toolKind: 'task',
        title: 'Task: Investigate',
        status: 'completed',
        input: { prompt: 'dig in', description: 'Investigate', agent: 'general' },
      },
    });
    expect(mainIdle.events.at(-1)).toEqual({ type: 'turn.completed', turnId: 'turn_1', stopReason: 'end_turn' });
    expect(mapOpencodeEvent({ type: 'session.idle', properties: { sessionID: 'ses_child' } }, mainIdle.state).events).toEqual([]);
  });

  it('two pending subtasks bind to their child sessions first-in-first-out', () => {
    let state = startedState();
    state = mapOpencodeEvent(part({ id: 'prt_st_a', type: 'subtask', prompt: 'Inspect A', description: 'Task A' }), state).state;
    state = mapOpencodeEvent(part({ id: 'prt_st_b', type: 'subtask', prompt: 'Inspect B', description: 'Task B' }), state).state;
    for (const [msg, sid] of [
      ['msg_child_a', 'ses_child_a'],
      ['msg_child_b', 'ses_child_b'],
    ] as const) {
      state = mapOpencodeEvent(
        { type: 'message.updated', properties: { info: { id: msg, sessionID: sid, role: 'assistant' } } },
        state,
      ).state;
    }
    // The first child to speak takes the oldest pending subtask; the second takes the next one.
    const a = mapOpencodeEvent(
      part({ id: 'prt_a', messageID: 'msg_child_a', sessionID: 'ses_child_a', type: 'text', text: 'A' }),
      state,
    );
    expect(a.events[0]).toMatchObject({ type: 'item.started', item: { id: 'prt_a', parentItemId: 'prt_st_a' } });
    const b = mapOpencodeEvent(
      part({ id: 'prt_b', messageID: 'msg_child_b', sessionID: 'ses_child_b', type: 'text', text: 'B' }),
      a.state,
    );
    expect(b.events[0]).toMatchObject({ type: 'item.started', item: { id: 'prt_b', parentItemId: 'prt_st_b' } });
    // Each child's idle completes its own subtask, and only that one.
    const idleB = mapOpencodeEvent({ type: 'session.idle', properties: { sessionID: 'ses_child_b' } }, b.state);
    expect(idleB.events).toEqual([
      { type: 'item.completed', item: expect.objectContaining({ id: 'prt_st_b', status: 'completed' }) },
    ]);
    const idleA = mapOpencodeEvent({ type: 'session.idle', properties: { sessionID: 'ses_child_a' } }, idleB.state);
    expect(idleA.events).toEqual([
      { type: 'item.completed', item: expect.objectContaining({ id: 'prt_st_a', status: 'completed' }) },
    ]);
  });

  it('a top-level task tool call is a pending subtask its child session binds to', () => {
    let state = startedState();
    const started = mapOpencodeEvent(
      part({
        id: 'prt_task',
        type: 'tool',
        tool: 'task',
        state: { status: 'running', input: { description: 'Dig in', prompt: 'dig', subagent_type: 'general' } },
      }),
      state,
    );
    expect(started.events).toEqual([
      {
        type: 'item.started',
        item: expect.objectContaining({ kind: 'tool', id: 'prt_task', name: 'task', toolKind: 'task', status: 'running' }),
      },
    ]);
    state = mapOpencodeEvent(
      { type: 'message.updated', properties: { info: { id: 'msg_child', sessionID: 'ses_child', role: 'assistant' } } },
      started.state,
    ).state;
    const nested = mapOpencodeEvent(
      part({ id: 'prt_c', messageID: 'msg_child', sessionID: 'ses_child', type: 'text', text: 'found it' }),
      state,
    );
    expect(nested.events[0]).toMatchObject({ type: 'item.started', item: { id: 'prt_c', parentItemId: 'prt_task' } });
    // The child's idle completes the task item under its own name and title.
    const idle = mapOpencodeEvent({ type: 'session.idle', properties: { sessionID: 'ses_child' } }, nested.state);
    expect(idle.events).toEqual([
      {
        type: 'item.completed',
        item: {
          kind: 'tool',
          id: 'prt_task',
          name: 'task',
          toolKind: 'task',
          title: 'Task: Dig in',
          status: 'completed',
          input: { description: 'Dig in', prompt: 'dig', subagent_type: 'general' },
        },
      },
    ]);
  });

  it('a task tool that settles releases its scope so the child idle does not re-complete it', () => {
    let state = startedState();
    state = mapOpencodeEvent(
      part({ id: 'prt_task', type: 'tool', tool: 'task', state: { status: 'running', input: { description: 'Dig in' } } }),
      state,
    ).state;
    state = mapOpencodeEvent(
      { type: 'message.updated', properties: { info: { id: 'msg_child', sessionID: 'ses_child', role: 'assistant' } } },
      state,
    ).state;
    state = mapOpencodeEvent(
      part({ id: 'prt_c', messageID: 'msg_child', sessionID: 'ses_child', type: 'text', text: 'found it' }),
      state,
    ).state;
    const done = mapOpencodeEvent(
      part({
        id: 'prt_task',
        type: 'tool',
        tool: 'task',
        state: { status: 'completed', input: { description: 'Dig in' }, output: 'the answer' },
      }),
      state,
    );
    expect(done.events).toEqual([
      { type: 'item.completed', item: expect.objectContaining({ id: 'prt_task', name: 'task', output: 'the answer' }) },
    ]);
    // The tool's own completion carried the output; a later child idle must not overwrite it.
    expect(mapOpencodeEvent({ type: 'session.idle', properties: { sessionID: 'ses_child' } }, done.state).events).toEqual([]);
    // Nor does the main idle settle it a second time.
    const mainIdle = mapOpencodeEvent({ type: 'session.idle', properties: { sessionID: SESSION_ID } }, done.state);
    expect(mainIdle.events).toEqual([{ type: 'turn.completed', turnId: 'turn_1', stopReason: 'end_turn' }]);
  });

  it('a child whose task settled cannot claim a pending sibling with a late idle', () => {
    let state = startedState();
    for (const [id, description] of [
      ['prt_task_a', 'Task A'],
      ['prt_task_b', 'Task B'],
    ] as const) {
      state = mapOpencodeEvent(
        part({ id, type: 'tool', tool: 'task', state: { status: 'running', input: { description } } }),
        state,
      ).state;
    }
    state = mapOpencodeEvent(
      { type: 'message.updated', properties: { info: { id: 'msg_child_a', sessionID: 'ses_child_a', role: 'assistant' } } },
      state,
    ).state;
    // Child A speaks and binds task A; task A then settles before child A goes idle.
    state = mapOpencodeEvent(
      part({ id: 'prt_a', messageID: 'msg_child_a', sessionID: 'ses_child_a', type: 'text', text: 'A' }),
      state,
    ).state;
    state = mapOpencodeEvent(
      part({ id: 'prt_task_a', type: 'tool', tool: 'task', state: { status: 'completed', input: { description: 'Task A' }, output: 'a' } }),
      state,
    ).state;
    // Child A's late idle belongs to a released scope: it must not complete task B.
    const lateIdle = mapOpencodeEvent({ type: 'session.idle', properties: { sessionID: 'ses_child_a' } }, state);
    expect(lateIdle.events).toEqual([]);
    // Task B is still pending for child B, which is only heard from now.
    state = mapOpencodeEvent(
      { type: 'message.updated', properties: { info: { id: 'msg_child_b', sessionID: 'ses_child_b', role: 'assistant' } } },
      lateIdle.state,
    ).state;
    const b = mapOpencodeEvent(
      part({ id: 'prt_b', messageID: 'msg_child_b', sessionID: 'ses_child_b', type: 'text', text: 'B' }),
      state,
    );
    expect(b.events[0]).toMatchObject({ type: 'item.started', item: { id: 'prt_b', parentItemId: 'prt_task_b' } });
    expect(mapOpencodeEvent({ type: 'session.idle', properties: { sessionID: 'ses_child_b' } }, b.state).events).toEqual([
      { type: 'item.completed', item: expect.objectContaining({ id: 'prt_task_b', status: 'completed' }) },
    ]);
  });

  it('a child that already went idle cannot claim a pending sibling with a late event', () => {
    let state = startedState();
    state = mapOpencodeEvent(part({ id: 'prt_st_a', type: 'subtask', prompt: 'A', description: 'Task A' }), state).state;
    state = mapOpencodeEvent(part({ id: 'prt_st_b', type: 'subtask', prompt: 'B', description: 'Task B' }), state).state;
    state = mapOpencodeEvent(
      { type: 'message.updated', properties: { info: { id: 'msg_child_a', sessionID: 'ses_child_a', role: 'assistant' } } },
      state,
    ).state;
    state = mapOpencodeEvent({ type: 'session.idle', properties: { sessionID: 'ses_child_a' } }, state).state;
    // A trailing message.updated (final usage) from child A after its idle.
    state = mapOpencodeEvent(
      { type: 'message.updated', properties: { info: { id: 'msg_child_a', sessionID: 'ses_child_a', role: 'assistant', cost: 0.01 } } },
      state,
    ).state;
    const late = mapOpencodeEvent(
      part({ id: 'prt_a_late', messageID: 'msg_child_a', sessionID: 'ses_child_a', type: 'text', text: 'late' }),
      state,
    );
    expect(late.events).toEqual([]);
    // Task B still binds to child B.
    state = mapOpencodeEvent(
      { type: 'message.updated', properties: { info: { id: 'msg_child_b', sessionID: 'ses_child_b', role: 'assistant' } } },
      late.state,
    ).state;
    const b = mapOpencodeEvent(
      part({ id: 'prt_b', messageID: 'msg_child_b', sessionID: 'ses_child_b', type: 'text', text: 'B' }),
      state,
    );
    expect(b.events[0]).toMatchObject({ type: 'item.started', item: { id: 'prt_b', parentItemId: 'prt_st_b' } });
  });

  it('a task scope follows later tool snapshots, so completion carries the final title and input', () => {
    let state = startedState();
    // OpenCode publishes the tool part before its arguments finish parsing.
    state = mapOpencodeEvent(part({ id: 'prt_task', type: 'tool', tool: 'task', state: { status: 'pending', input: {} } }), state).state;
    state = mapOpencodeEvent(
      part({ id: 'prt_task', type: 'tool', tool: 'task', state: { status: 'running', input: { description: 'Dig in', prompt: 'dig' } } }),
      state,
    ).state;
    state = mapOpencodeEvent(
      { type: 'message.updated', properties: { info: { id: 'msg_child', sessionID: 'ses_child', role: 'assistant' } } },
      state,
    ).state;
    const idle = mapOpencodeEvent({ type: 'session.idle', properties: { sessionID: 'ses_child' } }, state);
    expect(idle.events).toEqual([
      {
        type: 'item.completed',
        item: {
          kind: 'tool',
          id: 'prt_task',
          name: 'task',
          toolKind: 'task',
          title: 'Task: Dig in',
          status: 'completed',
          input: { description: 'Dig in', prompt: 'dig' },
        },
      },
    ]);
  });

  it('a child closed in one turn cannot bind to a task pending in the next turn', () => {
    let state = startedState();
    state = mapOpencodeEvent(part({ id: 'prt_st_a', type: 'subtask', prompt: 'A', description: 'Task A' }), state).state;
    state = mapOpencodeEvent(
      { type: 'message.updated', properties: { info: { id: 'msg_child_a', sessionID: 'ses_child_a', role: 'assistant' } } },
      state,
    ).state;
    // The main turn ends while child A never went idle: the turn settles it.
    state = mapOpencodeEvent({ type: 'session.idle', properties: { sessionID: SESSION_ID } }, state).state;
    // Next turn, a fresh subtask is pending.
    state = opencodeTurnStarted(state).state;
    state = mapOpencodeEvent(
      { type: 'message.updated', properties: { info: { id: 'msg_b', sessionID: SESSION_ID, role: 'assistant' } } },
      state,
    ).state;
    state = mapOpencodeEvent(part({ id: 'prt_st_b', messageID: 'msg_b', type: 'subtask', prompt: 'B', description: 'Task B' }), state).state;
    // A delayed event from the old child must not nest under (or complete) the new subtask.
    const stale = mapOpencodeEvent(
      part({ id: 'prt_a_stale', messageID: 'msg_child_a', sessionID: 'ses_child_a', type: 'text', text: 'stale' }),
      state,
    );
    expect(stale.events).toEqual([]);
    expect(mapOpencodeEvent({ type: 'session.idle', properties: { sessionID: 'ses_child_a' } }, stale.state).events).toEqual([]);
    state = mapOpencodeEvent(
      { type: 'message.updated', properties: { info: { id: 'msg_child_b', sessionID: 'ses_child_b', role: 'assistant' } } },
      stale.state,
    ).state;
    const b = mapOpencodeEvent(
      part({ id: 'prt_b', messageID: 'msg_child_b', sessionID: 'ses_child_b', type: 'text', text: 'B' }),
      state,
    );
    expect(b.events[0]).toMatchObject({ type: 'item.started', item: { id: 'prt_b', parentItemId: 'prt_st_b' } });
  });

  it('a task scope picks up an input-only snapshot that emits no item event', () => {
    let state = startedState();
    state = mapOpencodeEvent(
      part({ id: 'prt_task', type: 'tool', tool: 'task', state: { status: 'running', input: { description: 'Dig in' } } }),
      state,
    ).state;
    // Same status, same derived title, richer input: no UI event, but the scope must follow.
    const quiet = mapOpencodeEvent(
      part({ id: 'prt_task', type: 'tool', tool: 'task', state: { status: 'running', input: { description: 'Dig in', prompt: 'dig' } } }),
      state,
    );
    expect(quiet.events).toEqual([]);
    state = mapOpencodeEvent(
      { type: 'message.updated', properties: { info: { id: 'msg_child', sessionID: 'ses_child', role: 'assistant' } } },
      quiet.state,
    ).state;
    const idle = mapOpencodeEvent({ type: 'session.idle', properties: { sessionID: 'ses_child' } }, state);
    expect(idle.events).toEqual([
      {
        type: 'item.completed',
        item: expect.objectContaining({ id: 'prt_task', status: 'completed', input: { description: 'Dig in', prompt: 'dig' } }),
      },
    ]);
  });

  it('a task tool that names its child session in metadata binds to it, ahead of the FIFO queue', () => {
    let state = startedState();
    // Task B is queued first with no wire link; task A arrives with its child session id.
    state = mapOpencodeEvent(
      part({ id: 'prt_task_b', type: 'tool', tool: 'task', state: { status: 'running', input: { description: 'Task B' } } }),
      state,
    ).state;
    state = mapOpencodeEvent(
      part({
        id: 'prt_task_a',
        type: 'tool',
        tool: 'task',
        state: { status: 'running', input: { description: 'Task A' }, metadata: { parentSessionId: SESSION_ID, sessionId: 'ses_child_a' } },
      }),
      state,
    ).state;
    state = mapOpencodeEvent(
      { type: 'message.updated', properties: { info: { id: 'msg_child_a', sessionID: 'ses_child_a', role: 'assistant' } } },
      state,
    ).state;
    const a = mapOpencodeEvent(
      part({ id: 'prt_a', messageID: 'msg_child_a', sessionID: 'ses_child_a', type: 'text', text: 'A' }),
      state,
    );
    expect(a.events[0]).toMatchObject({ type: 'item.started', item: { id: 'prt_a', parentItemId: 'prt_task_a' } });
    // Task B is still pending for the next unknown child.
    state = mapOpencodeEvent(
      { type: 'message.updated', properties: { info: { id: 'msg_child_b', sessionID: 'ses_child_b', role: 'assistant' } } },
      a.state,
    ).state;
    const b = mapOpencodeEvent(
      part({ id: 'prt_b', messageID: 'msg_child_b', sessionID: 'ses_child_b', type: 'text', text: 'B' }),
      state,
    );
    expect(b.events[0]).toMatchObject({ type: 'item.started', item: { id: 'prt_b', parentItemId: 'prt_task_b' } });
  });

  it('a task that settles before its child ever spoke still tombstones the child named in metadata', () => {
    let state = startedState();
    state = mapOpencodeEvent(
      part({
        id: 'prt_task_a',
        type: 'tool',
        tool: 'task',
        state: { status: 'running', input: { description: 'Task A' }, metadata: { sessionId: 'ses_child_a' } },
      }),
      state,
    ).state;
    state = mapOpencodeEvent(
      part({ id: 'prt_task_b', type: 'tool', tool: 'task', state: { status: 'running', input: { description: 'Task B' } } }),
      state,
    ).state;
    // Task A settles with no event from child A having arrived.
    state = mapOpencodeEvent(
      part({
        id: 'prt_task_a',
        type: 'tool',
        tool: 'task',
        state: { status: 'completed', input: { description: 'Task A' }, output: 'a', metadata: { sessionId: 'ses_child_a' } },
      }),
      state,
    ).state;
    // Child A's first (late) event must not take task B.
    state = mapOpencodeEvent(
      { type: 'message.updated', properties: { info: { id: 'msg_child_a', sessionID: 'ses_child_a', role: 'assistant' } } },
      state,
    ).state;
    const late = mapOpencodeEvent(
      part({ id: 'prt_a_late', messageID: 'msg_child_a', sessionID: 'ses_child_a', type: 'text', text: 'late' }),
      state,
    );
    expect(late.events).toEqual([]);
    expect(mapOpencodeEvent({ type: 'session.idle', properties: { sessionID: 'ses_child_a' } }, late.state).events).toEqual([]);
    state = mapOpencodeEvent(
      { type: 'message.updated', properties: { info: { id: 'msg_child_b', sessionID: 'ses_child_b', role: 'assistant' } } },
      late.state,
    ).state;
    const b = mapOpencodeEvent(
      part({ id: 'prt_b', messageID: 'msg_child_b', sessionID: 'ses_child_b', type: 'text', text: 'B' }),
      state,
    );
    expect(b.events[0]).toMatchObject({ type: 'item.started', item: { id: 'prt_b', parentItemId: 'prt_task_b' } });
  });

  it('a task tool issued from a child session scopes its own grandchild under itself', () => {
    let state = startedState();
    state = mapOpencodeEvent(
      part({
        id: 'prt_task_a',
        type: 'tool',
        tool: 'task',
        state: { status: 'running', input: { description: 'Task A' }, metadata: { sessionId: 'ses_child_a' } },
      }),
      state,
    ).state;
    state = mapOpencodeEvent(
      { type: 'message.updated', properties: { info: { id: 'msg_child_a', sessionID: 'ses_child_a', role: 'assistant' } } },
      state,
    ).state;
    // Child A dispatches a task of its own; OpenCode names the grandchild session on it.
    const nestedTask = mapOpencodeEvent(
      part({
        id: 'prt_task_aa',
        messageID: 'msg_child_a',
        sessionID: 'ses_child_a',
        type: 'tool',
        tool: 'task',
        state: { status: 'running', input: { description: 'Task AA' }, metadata: { sessionId: 'ses_grandchild' } },
      }),
      state,
    );
    expect(nestedTask.events[0]).toMatchObject({ type: 'item.started', item: { id: 'prt_task_aa', parentItemId: 'prt_task_a' } });
    state = mapOpencodeEvent(
      { type: 'message.updated', properties: { info: { id: 'msg_gc', sessionID: 'ses_grandchild', role: 'assistant' } } },
      nestedTask.state,
    ).state;
    // The grandchild's output nests under the nested task, not under task A and not dropped.
    const gc = mapOpencodeEvent(
      part({ id: 'prt_gc', messageID: 'msg_gc', sessionID: 'ses_grandchild', type: 'text', text: 'deep' }),
      state,
    );
    expect(gc.events[0]).toMatchObject({ type: 'item.started', item: { id: 'prt_gc', parentItemId: 'prt_task_aa' } });
    // The grandchild's idle completes the nested task, still nested under task A.
    const idle = mapOpencodeEvent({ type: 'session.idle', properties: { sessionID: 'ses_grandchild' } }, gc.state);
    expect(idle.events).toEqual([
      {
        type: 'item.completed',
        item: expect.objectContaining({ id: 'prt_task_aa', name: 'task', status: 'completed', parentItemId: 'prt_task_a' }),
      },
    ]);
    // Task A itself is untouched by the grandchild's idle.
    expect(mapOpencodeEvent({ type: 'session.idle', properties: { sessionID: 'ses_child_a' } }, idle.state).events).toEqual([
      { type: 'item.completed', item: expect.objectContaining({ id: 'prt_task_a', status: 'completed' }) },
    ]);
  });

  it('session.started is emitted once and requires an id', () => {
    const state = createOpencodeUiState();
    expect(opencodeSessionStarted('', state).events).toEqual([]);
    const started = opencodeSessionStarted(SESSION_ID, state);
    expect(started.events).toEqual([{ type: 'session.started', sessionId: SESSION_ID, backend: 'opencode' }]);
    expect(opencodeSessionStarted(SESSION_ID, started.state).events).toEqual([]);
  });
});

function isBareTool(frame: unknown): boolean {
  if (typeof frame !== 'object' || frame === null) return false;
  const props = (frame as { properties?: { part?: { type?: string; state?: unknown } } }).properties;
  return props?.part?.type === 'tool' && props.part.state === undefined;
}

describe('OpencodeServerRunner v2 wiring (against the bundled mock server)', () => {
  const mockBin = join(FIXTURES, 'mock-opencode-serve.mjs');

  it('uses the mock’s announced port when the runner’s requested port is occupied', async () => {
    const occupied = createServer();
    await new Promise<void>(resolve => occupied.listen(0, '127.0.0.1', resolve));
    const address = occupied.address();
    if (!address || typeof address === 'string') throw Error('missing test port');
    const random = vi.spyOn(Math, 'random').mockReturnValue((address.port - 40000) / 20000);
    try {
      const events: AgentEvent[] = [];
      const session = new OpencodeServerRunner({ bin: mockBin, timeoutMs: 60_000 }).startSession(
        { userPrompt: 'check the working tree', cwd: process.cwd() }, event => events.push(event), { autoEndAfterFirstTurn: true },
      );
      await session.result;
      expect(events.filter(event => event.type === 'error')).toEqual([]);
      expect(events.map(event => event.type)).toContain('session');
    } finally { random.mockRestore(); await new Promise<void>(resolve => occupied.close(() => resolve())); }
  });

  it('emits v2 events through opts.onUiEvent while v1 events keep flowing; turn.completed comes from session.idle, not the HTTP response', async () => {
    const runner = new OpencodeServerRunner({ bin: mockBin, timeoutMs: 60_000 });
    const v1: AgentEvent[] = [];
    const v2: UiEvent[] = [];
    const session = runner.startSession(
      { userPrompt: 'check the working tree', cwd: process.cwd() },
      (e) => v1.push(e),
      { autoEndAfterFirstTurn: true, onUiEvent: (e) => v2.push(e) },
    );
    await session.result;

    // v1 stays intact (old NDJSON recordings must keep replaying).
    const v1Types = v1.map((e) => e.type);
    expect(v1Types).toContain('session');
    expect(v1Types).toContain('text');
    expect(v1Types).toContain('tool-call');
    expect(v1Types).toContain('tool-result');
    expect(v1Types).toContain('token-usage');
    expect(v1Types).toContain('cost');
    expect(v1Types).toContain('turn-end');
    expect(v1Types).toContain('done');

    // v2 rides alongside: session.started exactly once and first.
    expect(v2[0]).toEqual({ type: 'session.started', sessionId: 'ses_mock_1', backend: 'opencode' });
    expect(v2.filter((e) => e.type === 'session.started')).toHaveLength(1);
    expect(v2[1]).toEqual({ type: 'turn.started', turnId: 'turn_1' });

    expect(v2).toContainEqual({ type: 'item.delta', itemId: 'prt_mock_t1', field: 'text', delta: 'Checking the working tree.' });
    const pending = v2.find(
      (e): e is Extract<UiEvent, { type: 'item.started' }> => e.type === 'item.started' && e.item.id === 'prt_mock_c1',
    );
    expect(pending?.item).toMatchObject({ kind: 'tool', name: 'bash', status: 'pending' });
    const cmdDone = v2.find(
      (e): e is Extract<UiEvent, { type: 'item.completed' }> => e.type === 'item.completed' && e.item.id === 'prt_mock_c1',
    );
    expect(cmdDone?.item).toMatchObject({
      toolKind: 'execute',
      title: 'git status --short',
      status: 'completed',
      output: ' M src/example.ts\n',
      exitCode: 0,
    });
    expect(v2).toContainEqual({
      type: 'usage.updated',
      usage: { input: 1200, output: 300, total: 1500, cacheRead: 0, cacheWrite: 0, reasoning: 0 },
      costUsd: 0.0021,
    });

    // The ordering proof: the mock acknowledges the prompt_async POST BEFORE
    // streaming any part. Both streams must take their turn-end from
    // session.idle — i.e. AFTER the late "Done." delta/text (#4: the old
    // long-poll synthesized v1's turn-end from the HTTP response, which
    // undici's 300s timeout turned into a mid-turn `prompt failed`).
    const v1LateText = v1.findIndex((e) => e.type === 'text' && e.text === 'Done.');
    const v1TurnEnd = v1.findIndex((e) => e.type === 'turn-end');
    expect(v1LateText).toBeGreaterThan(-1);
    expect(v1TurnEnd).toBeGreaterThan(v1LateText);
    const lateDelta = v2.findIndex((e) => e.type === 'item.delta' && e.itemId === 'prt_mock_t2');
    const turnDone = v2.findIndex((e) => e.type === 'turn.completed');
    expect(lateDelta).toBeGreaterThan(-1);
    expect(turnDone).toBeGreaterThan(lateDelta);
    expect(v2[turnDone]).toEqual({
      type: 'turn.completed',
      turnId: 'turn_1',
      stopReason: 'end_turn',
      usage: { input: 1200, output: 300, total: 1500, cacheRead: 0, cacheWrite: 0, reasoning: 0 },
      costUsd: 0.0021,
    });
    expect(v2.filter((e) => e.type === 'turn.completed')).toHaveLength(1);
  }, 30_000);
});

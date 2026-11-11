/**
 * The mapper robustness contract, for every runner at once.
 *
 * A UI mapper reads frames off a wire, so a frame may be `null`, partial or malformed. For any
 * input a mapper must not throw, must return `{ events, state }`, and must leave the state it was
 * given unchanged. A value of no known type produces no events.
 *
 * The corpus is deterministic. Each runner's golden fixtures are replayed in order, as its runner
 * drives the mapper, and before each frame is folded the mapper also gets, on that same state:
 *
 * - every value of `HOSTILE`;
 * - the frame with one field broken: every path into it, at any depth, deleted, set to `null` and
 *   set to a wrong type (`breakages`);
 * - the frame hollowed out: its string fields kept, so the mapper still recognises the type, and
 *   every other value replaced (`hollowed`).
 *
 * After each broken frame the next `FOLLOW_UP_FRAMES` real frames are folded onto the state it
 * returned, because a malformed frame must not leave a state that makes a later valid frame throw.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { RUNNER_IDS } from './agent-runner.ts';
import type { RunnerId } from './agent-runner.ts';
import { claudeTurnStarted, createClaudeUiState, mapClaudeMessage } from './claude-ui-mapper.ts';
import { createCodexUiState, mapCodexNotification } from './codex-ui-mapper.ts';
import { createCursorPrintUiState, mapCursorPrintMessage } from './cursor-print-ui-mapper.ts';
import { createOmpUiState, mapOmpRpcMessage, ompTurnStarted } from './omp-ui-mapper.ts';
import {
  createOpencodeUiState,
  mapOpencodeEvent,
  opencodeSessionStarted,
  opencodeTurnStarted,
} from './opencode-ui-mapper.ts';
import { createPiUiState, mapPiRpcMessage, piTurnStarted } from './pi-ui-mapper.ts';
import type { UiEvent } from './ui-events.ts';

/** One runner's mapper with its state type erased, so one loop can drive all of them. */
interface Mapper {
  /** The state the runner holds when the first wire frame arrives. */
  seed(): object;
  map(frame: unknown, state: object): unknown;
}

function mapper<S extends object>(
  seed: () => S,
  map: (frame: unknown, state: S) => { events: UiEvent[]; state: S },
): Mapper {
  return { seed, map: (frame, state) => map(frame, state as S) };
}

/** A new runner id fails typecheck here until its mapper has a row. */
const MAPPERS: Record<RunnerId, Mapper> = {
  claude: mapper(() => claudeTurnStarted(createClaudeUiState()).state, mapClaudeMessage),
  codex: mapper(createCodexUiState, mapCodexNotification),
  opencode: mapper(
    () => opencodeTurnStarted(opencodeSessionStarted('ses_01J8ZE00MAIN', createOpencodeUiState()).state).state,
    mapOpencodeEvent,
  ),
  pi: mapper(() => piTurnStarted(createPiUiState()).state, mapPiRpcMessage),
  cursor: mapper(createCursorPrintUiState, mapCursorPrintMessage),
  omp: mapper(() => ompTurnStarted(createOmpUiState(), 'p').state, mapOmpRpcMessage),
};

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '__fixtures__');

/** Real frames folded after each broken frame. This is the one bound on the corpus: folding the
 *  whole rest of each fixture makes three times the calls and takes five times as long. */
const FOLLOW_UP_FRAMES = 3;
/** A failing mapper fails on thousands of inputs; the first few name the cause. */
const FAILURES_SHOWN = 10;

const UNKNOWN = '__unknown__';

/** Values of no known type: a mapper returns no events for any of them. */
const HOSTILE: ReadonlyArray<readonly [label: string, value: unknown]> = [
  ['null', null],
  ['undefined', undefined],
  ['0', 0],
  ['-1', -1],
  ['NaN', Number.NaN],
  ['true', true],
  ['empty string', ''],
  ['string', 'assistant'],
  ['[]', []],
  ['[null]', [null]],
  ['[{}]', [{}]],
  ['{}', {}],
  ['{type:null}', { type: null }],
  ['{type:7}', { type: 7 }],
  ['{type:{}}', { type: {} }],
  ['{type:[]}', { type: [] }],
  ['{type:""}', { type: '' }],
  ['{type:unknown}', { type: UNKNOWN }],
  ['{method:null}', { method: null }],
  ['{method:7}', { method: 7 }],
  ['{method:unknown}', { method: UNKNOWN }],
  ['unknown type, null bodies', { type: UNKNOWN, method: UNKNOWN, message: null, params: null, properties: null, item: null }],
  ['unknown type, nested nulls', {
    type: UNKNOWN,
    method: UNKNOWN,
    message: { content: [null], usage: null },
    params: { item: null, turn: null },
    properties: { part: null, info: null },
  }],
];

interface Frame {
  /** `<fixture file>:<line>`. */
  readonly at: string;
  /** A fresh copy on each call: an input is never shared between two mapper calls. */
  parse(): unknown;
}

function fixtureFrames(runner: RunnerId): Frame[][] {
  const dir = join(FIXTURES, runner);
  return readdirSync(dir)
    .filter((file) => file.endsWith('.ndjson'))
    .sort()
    .map((file) =>
      readFileSync(join(dir, file), 'utf8')
        .split('\n')
        .flatMap((line, index): Frame[] => {
          try {
            JSON.parse(line);
          } catch {
            return []; // as the runners do: an unparseable line is skipped
          }
          return [{ at: `${file}:${index + 1}`, parse: () => JSON.parse(line) as unknown }];
        }),
    );
}

function isContainer(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** Every path into `value`. Array indexes count as keys. */
function paths(value: unknown, prefix: readonly string[] = []): string[][] {
  if (!isContainer(value)) return [];
  return Object.keys(value).flatMap((key) => [[...prefix, key], ...paths(value[key], [...prefix, key])]);
}

/** The ways one field breaks: gone, `null`, an unknown string, a wrong scalar, a wrong container. */
const BREAKS: ReadonlyArray<readonly [kind: string, apply: (parent: Record<string, unknown>, key: string) => void]> = [
  ['deleted', (parent, key) => {
    if (Array.isArray(parent)) parent.splice(Number(key), 1);
    else delete parent[key];
  }],
  ['null', (parent, key) => { parent[key] = null; }],
  ['unknown string', (parent, key) => { parent[key] = UNKNOWN; }],
  ['wrong scalar', (parent, key) => { parent[key] = typeof parent[key] === 'number' ? true : 7; }],
  ['wrong container', (parent, key) => { parent[key] = Array.isArray(parent[key]) ? {} : []; }],
];

/** `frame` with one field broken, once for each path and each way to break it. */
function* breakages(frame: Frame): Generator<readonly [label: string, value: unknown]> {
  for (const path of paths(frame.parse())) {
    for (const [kind, apply] of BREAKS) {
      const broken = frame.parse();
      let parent = broken as Record<string, unknown>;
      for (const key of path.slice(0, -1)) parent = parent[key] as Record<string, unknown>;
      apply(parent, path[path.length - 1] as string);
      yield [`${path.join('.')} ${kind}`, broken];
    }
  }
}

/** `value` with its strings kept down to `depth` keys and everything else replaced by `fill`. */
function hollow(value: unknown, depth: number, fill: () => unknown): unknown {
  if (typeof value === 'string') return value;
  if (!isContainer(value) || depth === 0) return fill();
  if (Array.isArray(value)) return value.map((entry) => hollow(entry, depth - 1, fill));
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, hollow(entry, depth - 1, fill)]));
}

function hollowed(frame: Frame): Array<readonly [label: string, value: unknown]> {
  return [1, 2, 3].flatMap((depth) => [
    [`hollowed to depth ${depth} with null`, hollow(frame.parse(), depth, () => null)] as const,
    [`hollowed to depth ${depth} with {}`, hollow(frame.parse(), depth, () => ({}))] as const,
  ]);
}

/** A state as text. `Object.freeze` does not stop `Map.set` or `Set.add`, so the test compares
 *  this before and after a call instead of freezing the state. */
function snapshot(state: unknown): string {
  return JSON.stringify(state, (_key, value: unknown) => {
    if (value instanceof Map) return { $map: [...value] };
    if (value instanceof Set) return { $set: [...value] };
    return value === undefined ? '$undefined' : value;
  });
}

/** A state and its snapshot, taken before the calls that must leave it unchanged. */
interface Held {
  readonly state: object;
  snapshot: string;
}

function hold(state: object): Held {
  return { state, snapshot: snapshot(state) };
}

interface Outcome {
  /** What broke the contract, or `null`. */
  readonly failure: string | null;
  readonly events: readonly unknown[];
  /** The state to fold the next frame onto; the state passed in when the call failed. */
  readonly state: object;
}

/** One mapper call, checked against the contract. */
function call(row: Mapper, input: unknown, held: Held): Outcome {
  const { state } = held;
  let result: unknown;
  try {
    result = row.map(input, state);
  } catch (error) {
    return { failure: `threw ${String(error)}`, events: [], state };
  }
  const after = snapshot(state);
  if (after !== held.snapshot) {
    held.snapshot = after; // so the next input is judged on its own
    return { failure: 'mutated the state it was given', events: [], state };
  }
  if (!isContainer(result) || !Array.isArray(result.events) || !isContainer(result.state)) {
    return { failure: `returned ${JSON.stringify(result)}, not { events, state }`, events: [], state };
  }
  const events: unknown[] = result.events;
  if (!events.every((event) => isContainer(event) && typeof event.type === 'string')) {
    return { failure: `returned an event without a type: ${JSON.stringify(events)}`, events, state };
  }
  return { failure: null, events, state: result.state };
}

interface Report {
  calls: number;
  readonly failures: string[];
}

/** One fixture position: `frames[index]` is about to be folded onto `held.state`. */
interface Position {
  readonly report: Report;
  readonly frames: readonly Frame[];
  readonly index: number;
  readonly held: Held;
}

/** Replays every fixture of `runner` and gives `visit` each position. */
function replay(runner: RunnerId, visit: (position: Position) => void): Report {
  const row = MAPPERS[runner];
  const report: Report = { calls: 0, failures: [] };
  for (const frames of fixtureFrames(runner)) {
    let state = row.seed();
    // `<=`: the last visit has no frame, only the state the whole fixture leaves.
    for (let index = 0; index <= frames.length; index += 1) {
      const held = hold(state);
      visit({ report, frames, index, held });
      const frame = frames[index];
      if (frame === undefined) break;
      const folded = call(row, frame.parse(), held);
      if (folded.failure !== null) report.failures.push(`${frame.at} unchanged: ${folded.failure}`);
      state = folded.state;
    }
  }
  return report;
}

function expectNoFailures(report: Report): void {
  expect(report.calls).toBeGreaterThan(0);
  expect({ failed: report.failures.length, first: report.failures.slice(0, FAILURES_SHOWN) }).toEqual({ failed: 0, first: [] });
}

describe.each(RUNNER_IDS)('%s UI mapper robustness', (runner) => {
  const row = MAPPERS[runner];

  it('has golden fixture frames to replay', () => {
    expect(fixtureFrames(runner).flat().length).toBeGreaterThan(0);
  });

  it('returns no events for a value of no known type, in any state', () => {
    const result = replay(runner, ({ report, frames, index, held }) => {
      const at = frames[index]?.at ?? 'end of fixture';
      for (const [label, value] of HOSTILE) {
        report.calls += 1;
        const outcome = call(row, value, held);
        const failure = outcome.failure ?? (outcome.events.length > 0 ? `returned events ${JSON.stringify(outcome.events)}` : null);
        if (failure !== null) report.failures.push(`before ${at}, ${label}: ${failure}`);
      }
    });
    expectNoFailures(result);
  });

  it('never throws and never mutates its state when one field of a frame is broken', () => {
    const result = replay(runner, ({ report, frames, index, held }) => {
      const frame = frames[index];
      if (frame === undefined) return;
      for (const [label, value] of [...hollowed(frame), ...breakages(frame)]) {
        report.calls += 1;
        let outcome = call(row, value, held);
        if (outcome.failure !== null) report.failures.push(`${frame.at} ${label}: ${outcome.failure}`);
        for (const next of frames.slice(index + 1, index + 1 + FOLLOW_UP_FRAMES)) {
          if (outcome.failure !== null) break;
          report.calls += 1;
          outcome = call(row, next.parse(), hold(outcome.state));
          if (outcome.failure !== null) report.failures.push(`${frame.at} ${label}, then ${next.at}: ${outcome.failure}`);
        }
      }
    });
    expectNoFailures(result);
  });
});

import { createBoundaryGroup, type BoundaryGroup } from './run/turn-boundary.ts';
import { createWaitGroup, type WaitGroup } from './run/wait-registry.ts';
import { createAutosaveGroup, type AutosaveGroup } from './run/worktree-autosave.ts';
import { createInputGroup, type InputGroup } from './run/input-delivery.ts';
import { createSessionGroup, type SessionGroup } from './run/live-session-state.ts';
import { createChildrenGroup, type ChildrenGroup } from './run/subagent-waits.ts';
import { createSkillsGroup, type SkillsGroup } from './run/run-skills.ts';
import { createUsageGroup, type UsageGroup } from './run/usage-accounting.ts';

/**
 * The in-memory state of a run this manager is executing, and the one place it is built
 * (hearsay-tools/cezarion#1806). `RunManager` registers every instance through `activate`.
 */
export interface ActiveRun {
  readonly boundary: BoundaryGroup;
  readonly waitIdentity: WaitGroup;
  readonly autosave: AutosaveGroup;
  readonly inputState: InputGroup;
  readonly usage: UsageGroup;
  readonly liveSession: SessionGroup;
  readonly skills: SkillsGroup;
  readonly children: ChildrenGroup;
}

/** Run Squawk's own write into the session: a parent turn the runner starts during it is Squawk's
 *  (hearsay-tools/cezarion#2431). Claude emits `turn.started` inside the write itself. */
export function writeInput<T>(state: ActiveRun, write: () => T): T {
  return state.inputState.writeInput(write);
}

/** What differs between the ways a run starts executing. Every other `ActiveRun` field starts the
 *  same on all of them, so a field with no value here has one in `createActiveRun`. */
export interface ActiveRunInit {
  /** Where this run's steps execute: the task worktree, or the repo root. */
  cwd: string;
  pendingHumanAsk: boolean;
  /** The run's durable mode: `input.autonomous` for a fresh run, the record's for a Continue. */
  autonomous: boolean;
}

/**
 * The ONE place an `ActiveRun` is built (hearsay-tools/cezarion#1806). `execute` (a fresh run) and
 * `runContinuation` (Continue and restart recovery) both call it, then register the result through
 * `RunManager.activate`. A field added to `ActiveRun` as required fails to compile here until this
 * sets it, and one that differs by entry path becomes a required `ActiveRunInit` field, which
 * fails to compile at both callers. open-mercato/cezar#811 shipped a field set in one of two
 * literals; a second literal is refused by the `active-run-literal` ast-grep rule.
 *
 * The skill registry is not built here: it needs I/O after the run is registered, so
 * `RunSkills.loadRunSkills` loads it, from the same two callers.
 */
export function createActiveRun(init: ActiveRunInit): ActiveRun {
  const state = {
    boundary: createBoundaryGroup(init.pendingHumanAsk, init.autonomous),
    waitIdentity: createWaitGroup(),
    autosave: createAutosaveGroup(),
    inputState: createInputGroup(),
    usage: createUsageGroup(),
    liveSession: createSessionGroup(init.cwd),
    children: createChildrenGroup(),
    skills: createSkillsGroup(),
  };
  Object.defineProperty(state, 'boundary', { writable: false, configurable: false });
  Object.defineProperty(state, 'waitIdentity', { writable: false, configurable: false });
  Object.defineProperty(state, 'autosave', { writable: false, configurable: false });
  Object.defineProperty(state, 'inputState', { writable: false, configurable: false });
  Object.defineProperty(state, 'liveSession', { writable: false, configurable: false });
  Object.defineProperty(state, 'usage', { writable: false, configurable: false });
  Object.defineProperty(state, 'children', { writable: false, configurable: false });
  Object.defineProperty(state, 'skills', { writable: false, configurable: false });
  return Object.freeze(state);
}

import { runInternals } from './run-internals.testkit.ts';
import { spawn } from 'node:child_process';
import * as fc from 'fast-check';
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import type { CiWaitResult, ProcessWaitResult } from '@open-mercato/cezar-contract';
import { WAIT_KIND } from '@open-mercato/cezar-contract/test-factories.testkit';
import { CiWatcherSupervisor } from '../ci-wait/supervisor.ts';
import { HARNESS_ADAPTERS } from '../core/harness-parity.testkit.ts';
import { ProcessWaitSupervisor } from '../process-wait/supervisor.ts';
import { RUN_TRIGGERS, stateOf, takeRunExitViolations, type RunState } from './run-states.ts';
import { QUICK_TASK_WORKFLOW } from './types.ts';
import { toolCall } from './waits-parity.testkit.ts';
import { manager, restart, store, timeline, until, useWorkerWaitFixture } from './worker-wait.testkit.ts';

/**
 * The run state table drives a real run (hearsay-tools/cezarion#1804). Each command takes its
 * expected state from a trigger row of `RUN_TRIGGERS`, and the run must reach it: a real store,
 * RunManager and scheduler, the Claude native mock on its own wire, and only GitHub and the process
 * probe controlled, as the waits parity cells do. Time triggers fire the timer the engine armed, so
 * a timer the table promises and the engine never armed fails here instead of hanging a run.
 *
 * A failure prints fast-check's seed and command path. Replay it with
 * `fc.assert(…, { seed, path, endOnFailure: true })` in this file.
 *
 * Left to existing cells, which a row names in `pinnedBy` where one drives it: owned workers, the
 * usage-limit hold, permission prompts, workflow and check steps, provider failures, the nudge reply
 * bound and the review gate. One run is live at a time, so the fixture's single slot changes no row.
 */

const SEED = 1804;
const RUNS = 15;
const MAX_COMMANDS = 8;

type Kind = 'pr' | 'process' | 'timer';
type Reply = Kind | 'ask' | 'done' | 'nothing';
const REPLIES: readonly Reply[] = ['pr', 'timer', 'process', 'ask', 'done', 'nothing'];
/** computeWaitingOn's order among the waits this test opens. */
const TOP: readonly Kind[] = ['pr', 'process', 'timer'];

/** `question` names who asked: the agent, or Cezar after a turn with no wait or done. */
type Model = { state: RunState; open: Set<Kind>; question: false | 'agent' | 'cezar'; session: boolean };
type Real = { id: string };

const pr = 'https://github.com/acme/repo/pull/12';
const identity = { prUrl: pr, repository: 'acme/repo', prNumber: 12, headSha: 'a'.repeat(40) };
let ciWatches: Array<(result: CiWaitResult) => void> = [];
let processWatches: Array<(result: ProcessWaitResult) => void> = [];

function controlExternalWatches() {
  ciWatches = []; processWatches = [];
  vi.spyOn(CiWatcherSupervisor.prototype, 'resolve').mockResolvedValue(identity);
  vi.spyOn(CiWatcherSupervisor.prototype, 'watch').mockImplementation(() => new Promise<CiWaitResult>((resolve) => { ciWatches.push(resolve); }));
  vi.spyOn(ProcessWaitSupervisor.prototype, 'watch').mockImplementation(() => new Promise<ProcessWaitResult>((resolve) => { processWatches.push(resolve); }));
}

/** A live process of this test's own to wait on, killed when the test ends. */
function sleeper(): number {
  const child = spawn('sleep', ['300'], { stdio: 'ignore' });
  onTestFinished(() => { child.kill('SIGKILL'); });
  return child.pid!;
}

function prompt(reply: Reply): string {
  switch (reply) {
    case 'pr': return toolCall('cezar_wait', { kind: WAIT_KIND.pr, pr });
    case 'timer': return toolCall('cezar_wait', { kind: WAIT_KIND.timer, seconds: 600, note: 'model' });
    case 'process': return toolCall('cezar_wait', { kind: WAIT_KIND.process, pid: sleeper() });
    case 'ask': return 'mock:cezar-ask';
    case 'done': return 'mock:cezar-done';
    case 'nothing': return 'A plain reply.';
  }
}

/** The row a trigger takes from `state`, from the table. */
function row(id: string, state: RunState) {
  const found = RUN_TRIGGERS.find((candidate) => candidate.id === id);
  expect(found?.states, `row ${id} from ${state}`).toContain(state);
  return found!;
}
/** The state a row reaches: its one target, or the one `pick` names among several. */
function target(id: string, from: RunState, pick?: RunState): RunState {
  const { to } = row(id, from);
  if (to === 'same') return from;
  if (to.length === 1) return to[0]!;
  expect(to, `row ${id} reaches ${pick}`).toContain(pick);
  return pick!;
}

function engine() {
  return manager as unknown as {
    active: Map<string, { idleTimer?: NodeJS.Timeout & { _onTimeout(): void } }>;

  };
}
const turnEnds = (id: string) => store.readEvents(id).filter((event) => event.type === 'turn-end').length;
const isPark = (state: RunState) => state.startsWith('waiting:');
const final = (state: RunState) => state === 'done' || state === 'failed' || state === 'cancelled';

/** A turn the run is in ends with `reply`: the turn-end rows of `running`. Returns the turns it takes. */
function endTurn(model: Model, reply: Reply): number {
  if (reply === 'done') {
    model.state = target('running.done', 'running');
    model.open.clear(); model.question = false; model.session = false;
    return 1;
  }
  if (reply === 'ask') model.question = 'agent';
  else if (reply !== 'nothing') model.open.add(reply);
  if (model.question) { model.state = target('running.ask', 'running'); return 1; }
  const top = TOP.find((kind) => model.open.has(kind));
  if (top) { model.state = target('running.park-monitoring', 'running', `waiting:${top}`); return 1; }
  // No wait: one nudge, whose plain reply opens Cezar's no-wait question.
  expect(target('running.no-wait-nudge', 'running')).toBe('running');
  model.state = target('running.no-wait-human', 'running');
  model.question = 'cezar';
  return 2;
}

/** Wait for the product's signal: `turns` more turn ends, then the expected state at rest. */
async function settle(real: Real, model: Model, before: number, turns: number) {
  await until(() => turnEnds(real.id) >= before + turns && stateOf(store.getRun(real.id)!) === model.state
    && (model.session || !manager.isActive(real.id)), () => `expected ${model.state} after ${before + turns} turn ends; `
    + `read ${stateOf(store.getRun(real.id)!)} after ${turnEnds(real.id)}, active ${manager.isActive(real.id)}, waits ${JSON.stringify(store.getRun(real.id)?.waits)}\n${timeline(real.id)}`);
  expect(takeRunExitViolations()).toEqual([]);
}

type Command = fc.AsyncCommand<Model, Real>;

class HumanMessage implements Command {
  constructor(readonly reply: Reply) {}
  check = (m: Readonly<Model>) => isPark(m.state) && m.session && (this.reply === 'nothing' || this.reply === 'done' || this.reply === 'ask' || !m.open.has(this.reply));
  async run(m: Model, r: Real) {
    const before = turnEnds(r.id);
    expect(target(m.question ? 'human.answer' : 'waiting.message', m.state)).toBe('running');
    m.question = false;
    const turns = endTurn(m, this.reply);
    expect(manager.sendMessage(r.id, [{ type: 'text', text: prompt(this.reply) }])).toBe(true);
    await settle(r, m, before, turns);
  }
  toString = () => `HumanMessage(${this.reply})`;
}

class Continue implements Command {
  constructor(readonly reply: Reply) {}
  check(m: Readonly<Model>) {
    return (final(m.state) || (isPark(m.state) && !m.session)) && (this.reply === 'nothing' || this.reply === 'done' || this.reply === 'ask' || !m.open.has(this.reply));
  }
  async run(m: Model, r: Real) {
    const before = turnEnds(r.id);
    expect(target('continue.now', m.state)).toBe('running');
    m.question = false; m.session = true;
    const turns = endTurn(m, this.reply);
    expect(manager.continueRun(r.id, { text: prompt(this.reply) })).toMatchObject({ ok: true });
    await settle(r, m, before, turns);
  }
  toString = () => `Continue(${this.reply})`;
}

class ResolveWait implements Command {
  constructor(readonly kind: Kind) {}
  // The top wait resolves, or a wait beside a question: the rows a park's state names.
  check = (m: Readonly<Model>) => isPark(m.state) && m.open.has(this.kind) && (m.question !== false || TOP.find((kind) => m.open.has(kind)) === this.kind);
  async run(m: Model, r: Real) {
    const before = turnEnds(r.id);
    const id = m.question ? 'human.beside' : !m.session ? 'waiting.wake-no-session' : this.kind === 'timer' ? 'timer.fires' : `${this.kind}.resolves`;
    target(id, m.state, m.session || m.question ? 'running' : 'queued');
    m.open.delete(this.kind); m.session = true;
    // The wake turn's reply is the mock's plain one.
    const turns = endTurn(m, 'nothing');
    const wait = store.getRun(r.id)!.waits!.find((entry) => entry.kind === this.kind && entry.phase === 'open')!;
    if (this.kind === 'timer') {
      const armed = runInternals(manager).waitWatches.waitTimers.get(wait.id);
      expect(armed, 'the table promises the timer the engine arms').toBeDefined();
      armed!.timer._onTimeout();
    } else if (this.kind === 'pr') {
      ciWatches.at(-1)!({ outcome: 'passed', headSha: identity.headSha, observedAt: new Date().toISOString(), checks: [], totalChecks: 1, truncated: false });
    } else {
      processWatches.at(-1)!({ outcome: 'exited', observedAt: new Date().toISOString() });
    }
    await settle(r, m, before, turns);
  }
  toString = () => `ResolveWait(${this.kind})`;
}

class IdleElapses implements Command {
  check = (m: Readonly<Model>) => m.session && RUN_TRIGGERS.find((candidate) => candidate.id === 'waiting.idle')!.states.includes(m.state);
  async run(m: Model, r: Real) {
    // Cezar's own question ends with the session; the agent's stays open.
    const cezarAsks = m.state === 'waiting:human' && m.question === 'cezar';
    m.state = target(cezarAsks ? 'human.idle-cezar-question' : 'waiting.idle', m.state);
    if (cezarAsks) m.question = false;
    m.session = false;
    const idle = engine().active.get(r.id)?.idleTimer;
    expect(idle, 'the table promises the idle timer the engine arms').toBeDefined();
    const expire = idle!._onTimeout;
    clearTimeout(idle); expire();
    await settle(r, m, turnEnds(r.id), 0);
  }
  toString = () => 'IdleElapses';
}

class Stop implements Command {
  check = (m: Readonly<Model>) => isPark(m.state);
  async run(m: Model, r: Real) {
    m.state = target('waiting.stop', m.state);
    m.open.clear(); m.question = false; m.session = false;
    expect(manager.cancel(r.id)).toBe(true);
    await settle(r, m, turnEnds(r.id), 0);
  }
  toString = () => 'Stop';
}

class Finish implements Command {
  check = (m: Readonly<Model>) => isPark(m.state);
  async run(m: Model, r: Real) {
    m.state = target('waiting.finish', m.state);
    m.open.clear(); m.question = false; m.session = false;
    expect(manager.finish(r.id)).toBe(true);
    await settle(r, m, turnEnds(r.id), 0);
  }
  toString = () => 'Finish';
}

/** The process exits and a new one recovers: the same disk, no live session. */
class Restart implements Command {
  check = () => true;
  async run(m: Model, r: Real) {
    if (isPark(m.state)) target(m.state === 'waiting:human' ? 'human.restart' : 'waiting.restart', m.state);
    m.session = false;
    await restart();
    await settle(r, m, turnEnds(r.id), 0);
  }
  toString = () => 'Restart';
}

const reply = fc.constantFrom(...REPLIES);
const commands = fc.commands([
  reply.map((value) => new HumanMessage(value)),
  reply.map((value) => new Continue(value)),
  fc.constantFrom<Kind>('pr', 'timer', 'process').map((kind) => new ResolveWait(kind)),
  fc.constant(new IdleElapses()),
  fc.constant(new Stop()),
  fc.constant(new Finish()),
  fc.constant(new Restart()),
], { maxCommands: MAX_COMMANDS });

/** Run before the generated cases, so each time trigger fires on every run of this test: random
 *  commands reach a timer's resolution rarely, and a timer the engine never armed went unseen. */
const EXAMPLES: Array<[Reply, Command[]]> = [
  ['timer', [new ResolveWait('timer')]],
  ['pr', [new ResolveWait('pr')]],
  ['process', [new ResolveWait('process')]],
  ['nothing', [new IdleElapses(), new Continue('done')]],
];

describe('the run state table drives a real run', { timeout: 600_000 }, () => {
  useWorkerWaitFixture();
  afterEach(() => vi.restoreAllMocks());

  it('reaches the state each trigger row names, across restarts with no live session', async () => {
    process.env.CEZ_DRY_RUN = '0';
    process.env.CEZ_CLAUDE_BIN = HARNESS_ADAPTERS.claude.mockBin;
    controlExternalWatches();
    await fc.assert(fc.asyncProperty(reply, commands, async (first, steps) => {
      const model: Model = { state: 'running', open: new Set(), question: false, session: true };
      expect(target('queued.start', 'queued')).toBe('running');
      const turns = endTurn(model, first);
      // No worktree: past 10 finished runs, retention removes worktrees in the background, and the
      // fixture's teardown cannot wait for that (ENOTEMPTY in CI run 40313882525).
      const run = manager.startRun(QUICK_TASK_WORKFLOW, { task: prompt(first), runner: 'claude', worktree: false });
      const real = { id: run.id };
      await settle(real, model, 0, turns);
      try {
        await fc.asyncModelRun(() => ({ model, real }), steps);
      } finally {
        manager.cancel(real.id);
        await until(() => !manager.isActive(real.id));
        takeRunExitViolations();
      }
    }), { seed: SEED, numRuns: RUNS, examples: EXAMPLES });
  });
});

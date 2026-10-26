import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { RUN_STATUS, WAIT_PHASE, makeHumanWait, makeTimerWait } from '@open-mercato/cezar-contract/test-factories.testkit';
import { blank } from '../test-wait-discipline.testkit.ts';
import {
  AUTOMATIC, RUN_EXITS, RUN_STATES, RUN_TRIGGERS, WAIT_KINDS, stateOf, statusOf, strictRunExits, takeRunExitViolations,
  throwRunExitViolations, transition, transitionVia, type RunState, type RunStateSpec, type TriggerRow,
} from './run-states.ts';

const src = resolve(import.meta.dirname, '..');
const blanked = (file: string) => blank(readFileSync(resolve(src, file), 'utf8'));

/** A row that leaves the state with no person, no restart and no condition behind it. */
const automaticExit = (row: TriggerRow, state: RunState) =>
  AUTOMATIC.has(row.firedBy) && row.when === undefined && row.to !== 'same' && row.to.some((to) => to !== state);

/** The non-final states with an automatic exit and a human-only reason, or with neither. */
function uncovered(states: Readonly<Record<RunState, RunStateSpec>>, rows: readonly TriggerRow[]): string[] {
  const problems: string[] = [];
  for (const [state, spec] of Object.entries(states) as [RunState, RunStateSpec][]) {
    if (spec.final) continue;
    const automatic = rows.some((row) => row.states.includes(state) && automaticExit(row, state));
    if (automatic && spec.humanOnly) problems.push(`${state} has an automatic exit and a human-only reason`);
    if (!automatic && !spec.humanOnly?.trim()) problems.push(`${state} has no automatic exit and no recorded reason`);
  }
  return problems;
}

describe('run states and their exits (hearsay-tools/cezarion#1804)', () => {
  it('gives every non-final state an automatic exit or a recorded human-only reason', () => {
    expect(uncovered(RUN_STATES, RUN_TRIGGERS)).toEqual([]);
  });

  // The open-mercato/cezar#661 shape: a park whose only automatic exit was removed.
  it('names a state whose automatic exit is removed', () => {
    const rows = RUN_TRIGGERS.filter((row) => row.id !== 'timer.fires');
    expect(uncovered(RUN_STATES, rows)).toEqual(['waiting:timer has no automatic exit and no recorded reason']);
  });

  it('gives every wait kind an automatic resolution or a human-only reason', () => {
    const problems = Object.entries(WAIT_KINDS).filter(([, spec]) =>
      !spec.resolves.some((resolve) => AUTOMATIC.has(resolve.firedBy)) === !spec.humanOnly);
    expect(problems.map(([kind]) => kind)).toEqual([]);
  });

  it('keeps every row inside its exit, and uses every exit', () => {
    const ids = RUN_TRIGGERS.map((row) => row.id);
    expect(ids.filter((id, index) => ids.indexOf(id) !== index)).toEqual([]);
    const problems: string[] = [];
    for (const row of RUN_TRIGGERS) {
      if (!row.exit) continue;
      const exit = RUN_EXITS[row.exit];
      for (const state of row.states) {
        if (!(exit.from as readonly string[]).includes(statusOf(state))) problems.push(`${row.id}: ${state} is not a from of ${row.exit}`);
        const reached = row.to === 'same' ? [state] : row.to;
        for (const to of reached) if (statusOf(to) !== exit.to) problems.push(`${row.id}: reaches ${to}, but ${row.exit} writes ${exit.to}`);
      }
    }
    expect(problems).toEqual([]);
    const used = new Set(RUN_TRIGGERS.map((row) => row.exit));
    expect(Object.keys(RUN_EXITS).filter((exit) => !used.has(exit as keyof typeof RUN_EXITS))).toEqual([]);
  });

  it('names only functions that exist', () => {
    const files = { run: blanked('workflows/run.ts'), store: blanked('runs/store.ts'), server: blanked('server/server.ts') };
    const missing = [...new Set(RUN_TRIGGERS.flatMap((row) => row.via))].filter((name) => {
      const [file, fn] = name.includes(':') ? name.split(':') as ['store' | 'server', string] : ['run' as const, name];
      const defined = file === 'server'
        ? new RegExp(`\\b${fn}\\(`)
        : new RegExp(`^\\s*(?:export\\s+)?(?:function\\s+|(?:private|public|protected|static|async|readonly)\\s+)*${fn}\\s*[(<]`, 'm');
      return !defined.test(files[file]);
    });
    expect(missing).toEqual([]);
  });

  // Each exit is a write `run.ts` makes, through move(), transition() or transitionVia().
  it('writes every exit in run.ts', () => {
    const source = readFileSync(resolve(src, 'workflows/run.ts'), 'utf8');
    expect(Object.keys(RUN_EXITS).filter((exit) => !source.includes(`'${exit}'`))).toEqual([]);
  });

  it('reaches a final or human-only state from every other state through automatic rows', () => {
    const settled = (state: RunState) => RUN_STATES[state].final || RUN_STATES[state].humanOnly !== undefined;
    const stuck = (Object.keys(RUN_STATES) as RunState[]).filter((start) => {
      if (settled(start)) return false;
      const seen = new Set<RunState>([start]);
      const next = [start];
      for (let state = next.pop(); state; state = next.pop()) {
        if (settled(state)) return false;
        for (const row of RUN_TRIGGERS) {
          if (!row.states.includes(state) || !automaticExit(row, state) || row.to === 'same') continue;
          for (const to of row.to) if (!seen.has(to)) { seen.add(to); next.push(to); }
        }
      }
      return true;
    });
    expect(stuck).toEqual([]);
  });

  it('cites tests that exist', () => {
    const missing = RUN_TRIGGERS.filter((row) => row.pinnedBy).filter(({ pinnedBy }) => {
      const file = resolve(src, pinnedBy!.file);
      return !existsSync(file) || !readFileSync(file, 'utf8').includes(pinnedBy!.test);
    });
    expect(missing.map((row) => row.id)).toEqual([]);
  });

  it('refines waiting by what the run waits on', () => {
    const { running, waiting } = RUN_STATUS;
    expect(stateOf({ status: running })).toBe('running');
    expect(stateOf({ status: waiting, hasPendingPermission: true, waits: [makeHumanWait()] })).toBe('waiting:permission');
    expect(stateOf({ status: waiting, waits: [makeHumanWait()] })).toBe('waiting:human');
    expect(stateOf({ status: waiting, waits: [makeTimerWait()] })).toBe('waiting:timer');
    expect(stateOf({ status: waiting, autoResumeAt: new Date().toISOString() })).toBe('waiting:usage-limit');
    expect(stateOf({ status: waiting, waits: [makeTimerWait({ phase: WAIT_PHASE.resolved })] })).toBe('waiting:capacity');
    expect(stateOf({ status: waiting })).toBe('waiting:plain');
  });

  describe('the guard', () => {
    let previous: boolean;
    afterEach(() => {
      strictRunExits(previous);
      takeRunExitViolations();
    });
    function at(status: string | undefined) {
      return () => { return (status ? { status } : undefined) as never; };
    }

    it('does nothing outside strict mode', () => {
      previous = strictRunExits(false);
      let reads = 0;
      expect(transition('accept-review', () => { reads++; return { status: RUN_STATUS.running }; })).toBe('done');
      let commits = 0;
      expect(transitionVia('cancel', () => { reads++; return { status: RUN_STATUS.running }; }, () => ++commits)).toBe(1);
      expect({ reads, commits }).toEqual({ reads: 0, commits: 1 });
      expect(takeRunExitViolations()).toEqual([]);
    });

    it('refuses and records an exit from a status it does not leave, in strict mode', () => {
      previous = strictRunExits(true);
      expect(() => transition('accept-review', at('running'))).toThrow('undeclared run transition: exit accept-review from running');
      expect(takeRunExitViolations()).toHaveLength(1);
      expect(transition('cancel', at('running'))).toBe('cancelled');
      expect(transition('cancel', at('cancelled'))).toBe('cancelled');
      expect(transition('cancel', at(undefined))).toBe('cancelled');
      expect(takeRunExitViolations()).toEqual([]);
    });

    it('checks a store commit against its exit after it runs, in strict mode', () => {
      previous = strictRunExits(true);
      let status = 'running';
      const read = () => { return { status } as never; };
      expect(() => transitionVia('cancel', read, () => { status = 'waiting'; })).toThrow('exit cancel wrote waiting, not cancelled');
      expect(status).toBe('waiting');
      status = 'done';
      expect(() => transitionVia('cancel', read, () => { status = 'cancelled'; })).toThrow('exit cancel from done');
      expect(takeRunExitViolations()).toHaveLength(2);
      status = 'waiting';
      expect(transitionVia('park', read, () => 'refused')).toBe('refused');
      expect(transitionVia('withdraw-hold', read, () => { status = 'failed'; return true; })).toBe(true);
      expect(takeRunExitViolations()).toEqual([]);
    });

    it('throws every recorded violation once, for the test setup', () => {
      previous = strictRunExits(true);
      expect(() => throwRunExitViolations()).not.toThrow();
      expect(() => transition('accept-review', at('running'))).toThrow();
      expect(() => transition('accept-review', at('queued'))).toThrow();
      expect(() => throwRunExitViolations()).toThrow('exit accept-review from running (declare it in workflows/run-states.ts)\nundeclared run transition: exit accept-review from queued');
      expect(() => throwRunExitViolations()).not.toThrow();
    });
  });
});

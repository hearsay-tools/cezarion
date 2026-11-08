import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { RUNNER_IDS } from './agent-runner.ts';
import { HARNESS_PARITY_GROUPS, harnessGroupRows, parityRowScenarios } from './harness-parity-cells.testkit.ts';
import { CI_FAILURE_GROUPS, ciFailureRowId } from '../workflows/ci-wait-failure-rows.testkit.ts';
import { RESUME_DIAGNOSTICS_GROUPS, resumeDiagnosticsCells } from '../workflows/resume-diagnostics.testkit.ts';
import { registrationCollector } from './split-registration.testkit.ts';
import {
  AUTONOMOUS_CRITERIA, FINAL_MESSAGE_CRITERIA, FOLLOWUP_CRITERIA, MODEL_REFUSAL_CRITERIA, NO_PROGRESS_CRITERIA, SHUTDOWN_CRITERIA,
  SKILL_PROVISION_CRITERIA, SKILL_RESUME_CRITERIA, STEP_COMPLETION_CRITERIA, WORKFLOW_ASK_CRITERIA, WORKFLOW_TIMEOUT_CRITERIA,
  WORKTREE_SETUP_CRITERIA, HARNESS_ADAPTERS, type ScenarioName,
} from './harness-parity-core.testkit.ts';
import { WAIT_CRITERIA } from '../workflows/waits-parity.testkit.ts';
import { MONITORING_ACK_CRITERIA, MONITORING_ORDER_CRITERIA, MONITORING_TURN_CRITERIA } from '../workflows/monitoring-turn.testkit.ts';
import {
  NO_SESSION_RUNNER, PARITY_FAMILIES, PARITY_FILES, SHARED_RUNNERS, deriveRunnerSet, parityRowId, parityRunners, turnPathValues,
  type ParityFamilyName,
  SCENARIO_CLASSES,
} from './parity-classes.testkit.ts';
import { RUNNER_FACTS, type RunnerFacts } from './runner-facts.ts';
import { COMBINATION_ROWS, type CombinationException } from '../lint/runner-fact-combination.ts';

const src = join(import.meta.dirname, '..');
const facts = (overrides: Partial<RunnerFacts['inputDelivery']> & { systemPromptOnResume?: RunnerFacts['systemPromptOnResume'] } = {}): RunnerFacts => {
  const { systemPromptOnResume = 'resent', ...delivery } = overrides;
  return {
    ...RUNNER_FACTS.codex, systemPromptOnResume,
    inputDelivery: { ...RUNNER_FACTS.codex.inputDelivery, ...delivery } as RunnerFacts['inputDelivery'],
  };
};

describe('the shared parity runner set (hearsay-tools/cezarion#2991)', () => {
  // Guard 1: a value no member shows fails here, and deriveRunnerSet then picks a runner that has it.
  it('shows every declared value of every turn-path fact', () => {
    const declared = turnPathValues(RUNNER_IDS, RUNNER_FACTS);
    const shown = turnPathValues(SHARED_RUNNERS, RUNNER_FACTS);
    for (const [fact, values] of Object.entries(declared)) expect([...shown[fact]!].sort(), fact).toEqual([...values].sort());
  });

  it('is the smallest such set, in RUNNER_IDS order, and the no-session runner is its first', () => {
    const declared = turnPathValues(RUNNER_IDS, RUNNER_FACTS);
    const subsets = (size: number, from = 0): string[][] => size === 0 ? [[]]
      : RUNNER_IDS.slice(from).flatMap((id, at) => subsets(size - 1, from + at + 1).map(rest => [id, ...rest]));
    for (let size = 1; size < SHARED_RUNNERS.length; size++) {
      for (const set of subsets(size)) {
        const shown = turnPathValues(set as typeof RUNNER_IDS[number][], RUNNER_FACTS);
        expect(Object.entries(declared).every(([fact, values]) => [...values].every(value => shown[fact]!.has(value))), set.join(',')).toBe(false);
      }
    }
    expect(SHARED_RUNNERS).toEqual(RUNNER_IDS.filter(id => SHARED_RUNNERS.includes(id)));
    expect(NO_SESSION_RUNNER).toBe(SHARED_RUNNERS[0]);
  });

  it('takes in a runner that declares a new value, and breaks ties by order', () => {
    const table = { a: facts(), b: facts({ humanInputAtTurnEnd: 'never-held' }), c: facts({ systemPromptOnResume: 'in-thread' }) };
    expect(deriveRunnerSet(['a', 'b', 'c'], table)).toEqual(['b', 'c']);
    const grown = { ...table, d: facts({ mode: 'boundary', humanInputAtTurnEnd: 'always-held', acknowledgement: 'model-work' }) };
    expect(deriveRunnerSet(['a', 'b', 'c', 'd'], grown)).toEqual(['b', 'c', 'd']);
    const tie = { a: facts({ consumption: 'unobservable' }), b: facts({ consumption: 'unobservable' }), c: facts() };
    expect(deriveRunnerSet(['a', 'b', 'c'], tie)).toEqual(['a', 'c']);
  });
});

describe('the parity classification table (hearsay-tools/cezarion#2991)', () => {
  const parityFiles = ['core', 'workflows', 'server'].flatMap(dir => readdirSync(join(src, dir))
    // A parity test file: `<family>-parity.test.ts`, a server `contract-parity.<area>.test.ts`, the harness closure
    // guard and the monitoring-turn files. A testkit's own unit test is not one.
    .filter(file => /-parity(?:\.[a-z]+|-closure)?\.test\.ts$/.test(file) && !file.endsWith('.testkit.test.ts')
      || (dir === 'workflows' && /^monitoring-turn-.*\.test\.ts$/.test(file)))
    .map(file => `${dir}/${file}`));

  // Guard 3: each family has one class (one table entry), and every parity test file belongs to one.
  it('places every parity test file in exactly one file pattern, and every family has a file', () => {
    expect(parityFiles.length).toBeGreaterThan(100);
    const unplaced = parityFiles.filter(file => PARITY_FILES.filter(([pattern]) => pattern.test(file)).length !== 1);
    expect(unplaced).toEqual([]);
    const placed = new Set(PARITY_FILES.filter(([pattern]) => parityFiles.some(file => pattern.test(file))).flatMap(([, families]) => families));
    expect(Object.keys(PARITY_FAMILIES).filter(family => !placed.has(family as ParityFamilyName))).toEqual([]);
  });

  it('names one family for each harness group', () => {
    const groups = Object.values(HARNESS_PARITY_GROUPS).flat();
    expect(Object.keys(PARITY_FAMILIES).filter(family => family.startsWith('harness:')).sort()).toEqual(groups.map(group => `harness:${group}`).sort());
  });

  it('lists every-runner rows only in shared families, each with a reason', () => {
    for (const [family, entry] of Object.entries(PARITY_FAMILIES) as Array<[string, { class: string; everyRunner?: Record<string, string> }]>) {
      if (entry.class !== 'shared') expect(entry.everyRunner, family).toBeUndefined();
      for (const [row, why] of Object.entries(entry.everyRunner ?? {})) {
        expect(parityRowId(`runner ${row} …`), `${family} ${row}`).toBe(row);
        expect(why.length, `${family} ${row}`).toBeGreaterThan(10);
      }
    }
  });

  it('runs the per-runner smoke rows R1 and U1 on every runner', () => {
    expect(parityRunners('harness:run', 'R1')).toEqual(RUNNER_IDS);
    expect(parityRunners('waits', 'U1')).toEqual(RUNNER_IDS);
  });

  it('runs a row any runner is exempt from, and a cell with no row id, on every runner', () => {
    expect(parityRunners('waits', 'U27')).toEqual(RUNNER_IDS);
    expect(parityRunners('workflow-autonomous', 'A9')).toEqual(RUNNER_IDS);
    expect(parityRunners('waits', undefined)).toEqual(RUNNER_IDS);
    expect(parityRunners('waits', 'U2')).toEqual(SHARED_RUNNERS);
    expect(parityRunners('server-contract', 'R1')).toEqual([NO_SESSION_RUNNER]);
  });

  // A row whose scenario runs the runner's own code cannot be shared: a provider error is mapped by
  // each runner, and a native ask or native subagents exist only where the facts say. Every
  // registered row a catalog below lists is held to that, so a new shared row of this kind fails here.
  it('runs every registered row whose scenario runs runner code on every runner', () => {
    const shared = [...familyRowScenarios()].flatMap(([family, rows]) => [...rows]
      .filter(([row, scenarios]) => [...scenarios].some(scenario => SCENARIO_CLASSES[scenario][0] === 'runner-code')
        && parityRunners(family as ParityFamilyName, row).length !== RUNNER_IDS.length)
      .map(([row, scenarios]) => `${family} ${row} (${[...scenarios].join(', ')})`));
    expect(shared).toEqual([]);
    expect(familyRowCatalog().get('ci-wait-failure')).toEqual(new Set(['R72', 'R73', 'R74', 'R75', 'R76']));
    // Complete: every shared family is checked, and every shared row it lists has a known scenario.
    const checked = familyRowScenarios();
    expect(Object.entries(PARITY_FAMILIES).filter(([family, entry]) => entry.class === 'shared' && !checked.has(family)).map(([family]) => family)).toEqual([]);
    expect([...checked].flatMap(([family, rows]) => [...rows]
      .filter(([row, scenarios]) => scenarios.size === 0 && parityRunners(family as ParityFamilyName, row).length !== RUNNER_IDS.length)
      .map(([row]) => `${family} ${row}`))).toEqual([]);
    expect(familyRowCatalog().get('resume-diagnostics')).toEqual(new Set(['R85', 'R86', 'R87', 'R88', 'R89', 'R90', 'R91']));
  });

  it('classes every scenario a native mock declares, and every scenario a row drives', () => {
    const declared = new Set(Object.values(HARNESS_ADAPTERS).flatMap(adapter => Object.keys(adapter.scenarios)));
    expect([...declared].filter(name => !Object.hasOwn(SCENARIO_CLASSES, name))).toEqual([]);
    expect(parityRowScenarios().filter(row => !Object.hasOwn(SCENARIO_CLASSES, row.scenario)).map(row => row.id)).toEqual([]);
    for (const [name, [kind, why]] of Object.entries(SCENARIO_CLASSES) as Array<[ScenarioName, readonly [string, string]]>) {
      expect(['runner-code', 'shared'], name).toContain(kind);
      expect(why.length, name).toBeGreaterThan(10);
    }
  });

  // cez/runner-fact-combination lets a reported function pass only with a reason. A real combination
  // also names a registered row of a classified family that runs on every runner; a family with no
  // row catalog here fails closed. A false positive (an unrelated same-named key) names no row.
  it('gives every fact-combination exception a reason, and a real one a registered row on every runner', () => {
    expect(combinationRowProblems(COMBINATION_ROWS)).toEqual([]);
    const real = (row: string): CombinationException => ({ reason: 'decides on two facts together', row });
    expect(combinationRowProblems({ 'a#f': real('harness:run R1'), 'b#g': real('waits U1'), 'c#h': real('workflow-followup H1'),
      'd#i': { reason: 'options.mode is the CLI mode, not a delivery mode' } })).toEqual([]);
    expect(combinationRowProblems({ 'a#f': real('waits') })).toEqual(['a#f: "waits" names no row id']);
    expect(combinationRowProblems({ 'a#f': real('harness:contract S999') })).toEqual(['a#f: S999 is not a registered row of harness:contract']);
    expect(combinationRowProblems({ 'a#f': real('waits U2') })).toEqual(['a#f: waits U2 does not run on every runner']);
    expect(combinationRowProblems({ 'a#f': real('nowhere R1') })).toEqual(['a#f: nowhere is not a classified family']);
    expect(combinationRowProblems({ 'a#f': real('ci-wait-retry R92') })).toEqual(['a#f: ci-wait-retry has no row catalog here; add one before naming its rows']);
    expect(combinationRowProblems({ 'a#f': { reason: ' ' } })).toEqual(['a#f: the exception gives no reason']);
  });
});


/**
 * The scenarios each registered row drives, by family. A family with its own criteria table reads
 * the row's scenario there. The others (harness groups, CI failure, resume diagnostics) read the
 * matrix inventory, where an id two families reuse (R85: resume diagnostics and CI rerun) carries
 * every scenario listed for it, so the check fails closed.
 */
function familyRowScenarios(): Map<string, Map<string, Set<ScenarioName>>> {
  const inventory = new Map<string, Set<ScenarioName>>();
  for (const row of parityRowScenarios()) inventory.set(row.id, (inventory.get(row.id) ?? new Set()).add(row.scenario));
  const tables = familyTables();
  const scanned = Object.entries(SCANNED_KITS).map(([family, files]) => [family, new Map([['*', kitScenarios(files)]])] as const);
  return new Map([...scanned, ...[...familyRowCatalog()].map(([family, rows]) => {
    const own = tables[family];
    return [family, new Map([...rows].map(row => {
      const listed = own?.filter(entry => entry.id === row).map(entry => entry.scenario);
      return [row, new Set(listed?.length ? listed : inventory.get(row) ?? [])];
    }))] as const;
  })]);
}

/**
 * Shared families whose rows no criteria table lists, with the kit files that hold their cells.
 * Their one pseudo-row `*` stands for every row, and carries every scenario name its kit source
 * spells (`scenarios.baseline`, `'cezar-done'`), so a kit that starts driving runner code fails.
 * `mock:ci-wait` is the dry-run mock's `cezar_wait` call, counted as `cezar-wait`.
 */
const SCANNED_KITS: Record<string, readonly string[]> = {
  'ci-wait-registration': ['workflows/ci-wait-registration-parity.testkit.ts'],
  'ci-wait-conflict': ['workflows/ci-wait-conflict-parity.testkit.ts'],
  'ci-wait-rerun': ['workflows/ci-wait-rerun-parity.testkit.ts'],
  'ci-wait-retry': ['workflows/ci-wait-retry-parity.test.ts'],
  'pr-merge-wait': ['workflows/pr-merge-wait-parity.test.ts'],
  'session-context': ['workflows/session-context-cells.testkit.ts'],
  'completion-options': ['workflows/completion-options-cells.testkit.ts'],
};

function kitScenarios(files: readonly string[]): Set<ScenarioName> {
  const names = Object.keys(SCENARIO_CLASSES) as ScenarioName[];
  const found = new Set<ScenarioName>();
  for (const file of files) {
    const source = readFileSync(join(src, file), 'utf8');
    for (const name of names) {
      if (source.includes(`'${name}'`) || source.includes(`"${name}"`) || new RegExp(`\\.${name.replace(/-/g, '\\-')}\\b(?!-)`).test(source)) found.add(name);
    }
    if (source.includes('mock:ci-wait')) found.add('cezar-wait');
  }
  return found;
}

/** The criteria tables that list a family's rows with their scenarios. */
function familyTables(): Record<string, ReadonlyArray<{ id: string; scenario: ScenarioName }>> {
  return {
    waits: WAIT_CRITERIA, 'workflow-autonomous': AUTONOMOUS_CRITERIA, 'workflow-ask': WORKFLOW_ASK_CRITERIA,
    'workflow-final-message': FINAL_MESSAGE_CRITERIA, 'workflow-followup': FOLLOWUP_CRITERIA, 'workflow-no-progress': NO_PROGRESS_CRITERIA,
    'workflow-step-completion': STEP_COMPLETION_CRITERIA, 'workflow-timeout': WORKFLOW_TIMEOUT_CRITERIA, 'skill-resume': SKILL_RESUME_CRITERIA,
    'skill-provision': SKILL_PROVISION_CRITERIA, 'worktree-setup': WORKTREE_SETUP_CRITERIA, 'runner-shutdown': SHUTDOWN_CRITERIA,
    'model-refusal': MODEL_REFUSAL_CRITERIA,
    'monitoring-turn': [...MONITORING_TURN_CRITERIA, ...MONITORING_ORDER_CRITERIA, ...MONITORING_ACK_CRITERIA],
  };
}

/** Row ids each family registers, where this guard can list them. */
function familyRowCatalog(): Map<string, Set<string>> {
  const ids = (rows: ReadonlyArray<{ id: string }>) => new Set(rows.map(row => row.id));
  const catalog = new Map<string, Set<string>>([...harnessGroupRows()].map(([group, rows]) => [`harness:${group}`, rows]));
  catalog.set('ci-wait-failure', new Set(Object.values(CI_FAILURE_GROUPS).flat().map(ciFailureRowId)));
  const titles: string[] = [];
  for (const rows of Object.values(RESUME_DIAGNOSTICS_GROUPS)) for (const row of rows) resumeDiagnosticsCells[row.family](row.runner, registrationCollector(titles));
  catalog.set('resume-diagnostics', new Set(titles.map(parityRowId).filter((row): row is string => row !== undefined)));
  for (const [family, rows] of Object.entries(familyTables())) catalog.set(family, ids(rows));
  return catalog;
}

/** Each exception with no reason, or whose row is not `<family> <row>`: a registered row of a classified family that runs on every runner. */
function combinationRowProblems(exceptions: Readonly<Record<string, CombinationException>>): string[] {
  const catalog = familyRowCatalog();
  return Object.entries(exceptions).flatMap(([site, { reason, row: entry }]) => {
    if (!reason.trim()) return [`${site}: the exception gives no reason`];
    if (entry === undefined) return [];
    const [family = '', row, ...rest] = entry.split(' ');
    if (!Object.hasOwn(PARITY_FAMILIES, family)) return [`${site}: ${family} is not a classified family`];
    if (row === undefined || rest.length) return [`${site}: "${entry}" names no row id`];
    const registered = catalog.get(family);
    if (!registered) return [`${site}: ${family} has no row catalog here; add one before naming its rows`];
    if (!registered.has(row)) return [`${site}: ${row} is not a registered row of ${family}`];
    if (parityRunners(family as ParityFamilyName, row).length !== RUNNER_IDS.length) return [`${site}: ${entry} does not run on every runner`];
    return [];
  });
}

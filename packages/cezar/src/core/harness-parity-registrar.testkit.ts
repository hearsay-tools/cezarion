import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { RunnerId } from './agent-runner.ts';
import { exemptionFor, HARNESS_ADAPTERS, type ScenarioName, type SeamObservation } from './harness-parity-core.testkit.ts';
import { HARNESS_PARITY_GROUPS, harnessParityCellsFile, type HarnessParityPart } from './harness-parity-parts.testkit.ts';
import { parityRowId, runsOn, type ParityFamilyName } from './parity-classes.testkit.ts';
import type { describeToolGrantParity } from './tool-grant-parity-cells.testkit.ts';

/**
 * How the harness parity groups register their cells. Each part module
 * (`harness-parity-<part>.cells.testkit.ts`) holds its groups as functions of one
 * `HarnessRegistrar`; `harness-parity-cells.testkit.ts` runs every group for the guards
 * (hearsay-tools/cezarion#3242). This module loads no runner and no workflow engine.
 */

/** One row of the matrix, named once and applied to every harness. */
export interface SeamCriterion<T = SeamObservation> {
  /** Stable id the exemption table references. */
  readonly id: string;
  readonly name: string;
  readonly scenario: ScenarioName;
  /** Throws when the backend does not satisfy the criterion. */
  readonly assert: (obs: T) => void;
}

/** What this kit adds to each plain row of `harness-parity-rows.testkit.ts`, by row id. */
export type Cells<Rows extends readonly { readonly id: string }[], Criterion> =
  Readonly<Record<Rows[number]['id'], Omit<Criterion, 'id' | 'name' | 'scenario'>>>;

export type HarnessParityScope = { runner: RunnerId; part: HarnessParityPart } | 'once';

// The once file keeps matrix guards and single-runner checks. Runner parts own disjoint groups.
export type HarnessRegistration = Pick<typeof import('vitest'), 'describe' | 'it' | 'beforeAll' | 'afterAll'> & {
  /** The tool-grant cells; the session part registers `describeToolGrantParity` when absent. */
  toolGrants?: typeof describeToolGrantParity;
  allGroups?: boolean;
  /** A dry collection, for `groupCellCounts` and `harnessGroupRows`. A function also hears each
   *  cell the file's runner registers, with its group. */
  probe?: true | ((group: string, title: string) => void);
};

export const vitestRegistration = (): HarnessRegistration => ({ describe, it, beforeAll, afterAll });

/** What one registration of the groups shares: its scope, its runners and the cell helpers. */
export interface HarnessRegistrar {
  readonly scope: HarnessParityScope;
  readonly runners: readonly RunnerId[];
  readonly registration: HarnessRegistration;
  readonly describe: HarnessRegistration['describe'];
  readonly it: HarnessRegistration['it'];
  readonly beforeAll: HarnessRegistration['beforeAll'];
  readonly afterAll: HarnessRegistration['afterAll'];
  /** Every group `describeRunners` was called for, in order; the once file's routing guard reads it. */
  readonly registeredGroups: string[];
  readonly describeRunners: (group: string, name: string, body: () => void, once?: boolean) => void;
  readonly parityRow: <T = SeamObservation>(backend: RunnerId, criterion: SeamCriterion<T>, observe: () => Promise<T>) => void;
  readonly permissionExemption: (id: string, backend: RunnerId, scenario: ScenarioName) => boolean;
}

/** One or more `describeRunners` groups, registered through the registrar it is given. */
export type HarnessGroup = (r: HarnessRegistrar) => void;

function createRegistrar(scope: HarnessParityScope, registration: HarnessRegistration,
  cellCounts: Map<string, number> | undefined): HarnessRegistrar {
  // Each group is one parity family (core/parity-classes.testkit.ts, hearsay-tools/cezarion#2991):
  // a cell registers only when its row runs on this file's runner. The group is carried into each
  // suite factory, which Vitest may call after describeRunners returns.
  let currentGroup: string | undefined;
  const inGroup = <A extends unknown[]>(group: string | undefined, factory: (...args: A) => unknown) => {
    return (...args: A) => {
      const previous = currentGroup;
      currentGroup = group;
      try { return factory(...args); } finally { currentGroup = previous; }
    };
  };
  const describe = new Proxy(registration.describe, {
    apply: (target, self, args: unknown[]) => Reflect.apply(target, self, args.map(arg => typeof arg === 'function' ? inGroup(currentGroup, arg as () => unknown) : arg)),
  });
  const it = new Proxy(registration.it, {
    apply: (target, self, args: unknown[]) => {
      if (scope !== 'once' && currentGroup !== undefined && typeof args[0] === 'string'
        && !runsOn(`harness:${currentGroup}` as ParityFamilyName, parityRowId(args[0]), scope.runner)) return undefined;
      if (typeof registration.probe === 'function' && currentGroup !== undefined && typeof args[0] === 'string') registration.probe(currentGroup, args[0]);
      return Reflect.apply(target, self, args);
    },
  });
  /**
   * Register one cell. An exempt cell still produces a named test that fails the
   * day the backend gains the thing — see `ExemptionKind` for the two ways that
   * is pinned. Never relax an assertion to accommodate an exemption; delete the
   * exemption instead.
   */
  function parityRow<T = SeamObservation>(
    backend: RunnerId,
    criterion: SeamCriterion<T>,
    observe: () => Promise<T>,
  ): void {
    const exempt = exemptionFor(criterion.id, backend);
    if (!exempt) {
      it(
        `${backend} ${criterion.name}`,
        async () => {
          criterion.assert(await observe());
        },
        45_000,
      );
      return;
    }
    if (exempt.kind === 'scenario-unconstructible') {
      it(`${backend} is exempt from ${criterion.id} — ${exempt.reason}`, () => {
        // The pin: no prompt is declared, so nothing can drive this row here. Add
        // one and this fails, which is the signal to make the row live.
        expect(HARNESS_ADAPTERS[backend].scenarios[criterion.scenario]).toBeUndefined();
      });
      return;
    }
    it(
      `${backend} is exempt from ${criterion.id} — ${exempt.reason}`,
      async () => {
        const obs = await observe();
        expect(() => criterion.assert(obs)).toThrow();
      },
      45_000,
    );
  }

  /** Registers the exemption cell when there is one; P1's shape for every lifecycle criterion. */
  function permissionExemption(id: string, backend: RunnerId, scenario: ScenarioName): boolean {
    const exemption = exemptionFor(id, backend);
    if (!exemption) return false;
    it(`${backend} ${id} exemption — ${exemption.reason}`, () => {
      expect(exemption.kind).toBe('scenario-unconstructible');
      expect(HARNESS_ADAPTERS[backend].scenarios[scenario]).toBeUndefined();
    });
    return true;
  }

  const registeredGroups: string[] = [];
  const describeRunners = (group: string, name: string, body: () => void, once = false): void => {
    registeredGroups.push(group);
    if (scope === 'once') {
      if (once) describe(name, body);
      return;
    }
    if (cellCounts?.get(name) === 0) return;
    const grouped = inGroup(group, body) as () => void;
    // Iterate rather than use includes: duplicate routes register twice and fail the guard.
    if (registration.allGroups) { describe(name, grouped); return; }
    for (const selected of HARNESS_PARITY_GROUPS[scope.part]) {
      if (selected === group) describe(name, grouped);
    }
  };

  return {
    scope, runners: scope === 'once' ? [] : [scope.runner], registration,
    describe, it, beforeAll: registration.beforeAll, afterAll: registration.afterAll,
    registeredGroups, describeRunners, parityRow, permissionExemption,
  };
}

/** How many cells each group's suite registers for one runner, by suite name. A shared group can
 *  hold none for a runner outside the derived set, and Vitest 4 fails an empty suite. */
function groupCellCounts(scope: Exclude<HarnessParityScope, 'once'>, groups: readonly HarnessGroup[], toolGrantCells: number): Map<string, number> {
  const counts = new Map<string, number>();
  let cells = 0;
  describeHarnessGroups(scope, {
    describe: ((name: string, ...args: unknown[]) => {
      const before = cells;
      (args.at(-1) as () => void)();
      counts.set(name, (counts.get(name) ?? 0) + cells - before);
    }) as typeof describe,
    it: (() => { cells++; }) as unknown as typeof it,
    beforeAll: (() => undefined) as typeof beforeAll,
    afterAll: (() => undefined) as typeof afterAll,
    toolGrants: () => { cells += toolGrantCells; },
    allGroups: true,
    probe: true,
  }, groups, toolGrantCells);
  return counts;
}

/** Register `groups` in order. `toolGrantCells` is how many cells the tool-grant group adds for a
 *  runner, for the dry count; only the session part holds that group. */
export function describeHarnessGroups(scope: HarnessParityScope, registration: HarnessRegistration,
  groups: readonly HarnessGroup[], toolGrantCells = 0): HarnessRegistrar {
  const cellCounts = scope === 'once' || registration.probe ? undefined : groupCellCounts(scope, groups, toolGrantCells);
  const registrar = createRegistrar(scope, registration, cellCounts);
  for (const group of groups) group(registrar);
  return registrar;
}

/** One part module's `describeHarnessParity`: it registers that part and refuses any other. */
export function describeHarnessPart(part: HarnessParityPart, groups: Readonly<Record<string, HarnessGroup>>,
  scope: Exclude<HarnessParityScope, 'once'>, registration: HarnessRegistration = vitestRegistration(), toolGrantCells = 0): void {
  if (scope.part !== part) {
    throw new Error(`${harnessParityCellsFile(part)} registers the ${part} part, not ${scope.part}; import ${harnessParityCellsFile(scope.part)}`);
  }
  describeHarnessGroups(scope, registration, Object.values(groups), toolGrantCells);
}

/** The mock's own record of what reached it: argv or requests, then stdin where hooked. */
export function readRecording(dir: string, name: string): string[] {
  return [`${name}.args.ndjson`, `${name}.stdin.ndjson`].flatMap((file) => {
    const path = join(dir, file);
    return existsSync(path) ? readFileSync(path, 'utf8').trim().split('\n').filter(Boolean) : [];
  });
}

/** Env for a probe drive. The recording paths are RELATIVE on purpose: the mock
 *  resolves them against ITS cwd, so a recording that lands in `dir` is
 *  evidence for `cwd` and `env` in one stroke (the `process` probes). */
export const probeEnv = (name: string) => ({
  CEZ_MOCK_ARGS_FILE: `${name}.args.ndjson`,
  CEZ_MOCK_STDIN_FILE: `${name}.stdin.ndjson`,
  CEZ_HANDOFF_FILE: '',
  CEZ_TODOS_FILE: '',
});

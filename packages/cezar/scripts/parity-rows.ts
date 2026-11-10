/**
 * Prints the parity row index: every row the parity kits declare, and the runners exempt from it.
 *
 *   node packages/cezar/scripts/parity-rows.ts [--row <id>] [--runner <id>] [--json]
 *
 * `--row` prints one row id; `--runner` prints the rows that runner is exempt from.
 *
 * The index is read from the lists the kits export. This file names the kit modules and holds no
 * row and no exemption. `src/core/parity-rows.test.ts` fails when a kit declares a row id that is
 * missing here.
 */
import { parseArgs } from 'node:util';

import { RUNNER_IDS } from '../src/core/agent-runner.ts';
import * as harnessCore from '../src/core/harness-parity-core.testkit.ts';
import * as harnessRows from '../src/core/harness-parity-rows.testkit.ts';
import { PARITY_ROW_ID } from '../src/core/parity-classes.testkit.ts';
import * as seamContract from '../src/core/seam-contract.testkit.ts';
import * as monitoringTurn from '../src/workflows/monitoring-turn.testkit.ts';
import * as waits from '../src/workflows/waits-parity.testkit.ts';
import * as subagents from '../src/workflows/waits-subagents-rows.testkit.ts';

/** The kit modules that declare rows, by path under `packages/cezar/src`. */
const KITS: Readonly<Record<string, object>> = {
  'core/harness-parity-core.testkit.ts': harnessCore,
  'core/harness-parity-rows.testkit.ts': harnessRows,
  'core/seam-contract.testkit.ts': seamContract,
  'workflows/monitoring-turn.testkit.ts': monitoringTurn,
  'workflows/waits-parity.testkit.ts': waits,
  'workflows/waits-subagents-rows.testkit.ts': subagents,
};

export interface IndexedExemption {
  readonly runner: string;
  /** Absent where the kit's exemption list declares no kind. */
  readonly kind?: string;
  readonly reason: string;
}

/** One row id of one kit. Two kits that declare the same id give two rows. */
export interface IndexedRow {
  readonly id: string;
  readonly kit: string;
  /** The exported lists that declare it. */
  readonly lists: readonly string[];
  /** More than one where a list declares the id once for each variant. */
  readonly names: readonly string[];
  readonly scenarios: readonly string[];
  /** Exemption lists name a row by id only, so two kits' rows with one id show the same ones. */
  readonly exemptions: readonly IndexedExemption[];
}

type Entry = Readonly<Record<string, unknown>>;
const isEntry = (value: unknown): value is Entry => typeof value === 'object' && value !== null;
const text = (value: unknown): string | undefined => typeof value === 'string' ? value : undefined;

/** Every exported list of a kit whose entries all pass `match`. */
function exportedLists(kit: object, match: (entry: Entry) => boolean): [string, readonly Entry[]][] {
  return Object.entries(kit).filter((pair): pair is [string, Entry[]] => {
    const list: unknown = pair[1];
    return Array.isArray(list) && list.length > 0 && list.every(entry => isEntry(entry) && match(entry));
  });
}

const isRow = (entry: Entry) => PARITY_ROW_ID.test(text(entry.id) ?? '');
const isExemption = (entry: Entry) => text(entry.criterion) !== undefined && text(entry.reason) !== undefined
  && text(entry.backend ?? entry.runner) !== undefined;

export function parityRowIndex(): IndexedRow[] {
  const exemptions = new Map<string, IndexedExemption[]>();
  for (const kit of Object.values(KITS)) {
    for (const [, list] of exportedLists(kit, isExemption)) {
      for (const entry of list) {
        const kind = text(entry.kind);
        const exemption = { runner: text(entry.backend ?? entry.runner)!, ...(kind === undefined ? {} : { kind }), reason: text(entry.reason)! };
        exemptions.set(text(entry.criterion)!, [...(exemptions.get(text(entry.criterion)!) ?? []), exemption]);
      }
    }
  }
  const rows = new Map<string, { id: string; kit: string; lists: Set<string>; names: Set<string>; scenarios: Set<string> }>();
  for (const [kit, module] of Object.entries(KITS)) {
    for (const [list, entries] of exportedLists(module, isRow)) {
      for (const entry of entries) {
        const id = text(entry.id)!;
        const row = rows.get(`${kit} ${id}`) ?? { id, kit, lists: new Set(), names: new Set(), scenarios: new Set() };
        rows.set(`${kit} ${id}`, row);
        row.lists.add(list);
        if (text(entry.name) !== undefined) row.names.add(text(entry.name)!);
        if (text(entry.scenario) !== undefined) row.scenarios.add(text(entry.scenario)!);
      }
    }
  }
  return [...rows.values()].map(row => ({
    id: row.id, kit: row.kit, lists: [...row.lists], names: [...row.names], scenarios: [...row.scenarios],
    exemptions: exemptions.get(row.id) ?? [],
  }));
}

/** The exemption ids that name no indexed row. */
export function unmatchedExemptions(index: readonly IndexedRow[]): string[] {
  const ids = new Set(index.map(row => row.id));
  return Object.values(KITS).flatMap(kit => exportedLists(kit, isExemption))
    .flatMap(([, list]) => list.map(entry => text(entry.criterion)!)).filter(id => !ids.has(id));
}

function printRow(row: IndexedRow): void {
  // Some kits start a name with the row id; the id is already the first column.
  const names = row.names.map(name => name.startsWith(`${row.id} `) ? name.slice(row.id.length + 1) : name);
  console.log(`${row.id}  ${names[0] ?? '(no name: its cells carry it in their titles)'}`);
  for (const name of names.slice(1)) console.log(`    also: ${name}`);
  console.log(`    scenario: ${row.scenarios.join(', ') || '(none declared)'}`);
  console.log(`    kit: ${row.kit} (${row.lists.join(', ')})`);
  for (const { runner, kind, reason } of row.exemptions) console.log(`    exempt: ${runner}${kind === undefined ? '' : ` (${kind})`}: ${reason}`);
}

const count = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

function main(): void {
  const { values } = parseArgs({ options: { row: { type: 'string' }, runner: { type: 'string' }, json: { type: 'boolean' } } });
  if (values.runner !== undefined && !(RUNNER_IDS as readonly string[]).includes(values.runner)) {
    console.error(`unknown runner "${values.runner}"; the runners are ${RUNNER_IDS.join(', ')}`);
    process.exitCode = 1;
    return;
  }
  const rows = parityRowIndex()
    .filter(row => values.row === undefined || row.id === values.row)
    .map(row => values.runner === undefined ? row : { ...row, exemptions: row.exemptions.filter(exemption => exemption.runner === values.runner) })
    .filter(row => values.runner === undefined || row.exemptions.length > 0);
  if (values.json) {
    console.log(JSON.stringify(rows, null, 2));
  } else {
    for (const row of rows) printRow(row);
    console.log(`${count(rows.length, 'row')} in ${count(new Set(rows.map(row => row.kit)).size, 'kit')}`);
  }
  if (rows.length === 0 && values.row !== undefined) {
    console.error(`no kit declares row "${values.row}"`);
    process.exitCode = 1;
  }
}

if (import.meta.main) main();

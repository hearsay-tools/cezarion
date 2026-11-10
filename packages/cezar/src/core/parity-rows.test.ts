import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { formatRow, parityRowIndex, renderRows, unmatchedExemptions } from '../../scripts/parity-rows.ts';
import { PARITY_ROW_ID } from './parity-classes.testkit.ts';

const SRC = new URL('../', import.meta.url);

/** Every `id: '<row id>'` a kit file under `src` holds, as `[kit, id]`. */
function declaredRowIds(): [string, string][] {
  return readdirSync(SRC, { recursive: true, encoding: 'utf8' })
    .filter(file => file.endsWith('.testkit.ts'))
    .map(file => file.replaceAll('\\', '/'))
    .flatMap(kit => [...new Set([...readFileSync(new URL(kit, SRC), 'utf8').matchAll(/\bid: '([^']+)'/g)].map(match => match[1]!))]
      .filter(id => PARITY_ROW_ID.test(id)).map((id): [string, string] => [kit, id]));
}

describe('the parity row index (scripts/parity-rows.ts)', () => {
  const index = parityRowIndex();
  const kits = new Set(index.map(row => row.kit));
  const ids = new Set(index.map(row => row.id));
  const pairs = new Set(index.map(row => `${row.kit} ${row.id}`));

  it('holds every row id a kit declares', () => {
    const declared = declaredRowIds();
    expect(declared.length).toBeGreaterThan(0);
    // A kit the index reads must give each of its own ids; any other kit may repeat an indexed
    // row for its cells, and must not declare a new one.
    const missing = declared.filter(([kit, id]) => kits.has(kit) ? !pairs.has(`${kit} ${id}`) : !ids.has(id));
    expect(missing.map(([kit, id]) => `${kit}: ${id}`)).toEqual([]);
  });

  it('gives each row id to one kit, except the ids two kits share today', () => {
    const shared = [...ids].filter(id => index.filter(row => row.id === id).length > 1);
    // Each is two different rows under one id. A new shared id fails here: take a free id.
    expect(shared.sort()).toEqual(['R17', 'R92']);
  });

  it('matches every exemption to a row', () => {
    expect(unmatchedExemptions(index)).toEqual([]);
  });

  it('prints a row with its names, scenario, kit and exemptions', () => {
    expect(formatRow({
      id: 'Z1', kit: 'core/example.testkit.ts', lists: ['A_CRITERIA', 'B_CRITERIA'], names: ['Z1 first name', 'second name'],
      scenarios: [], exemptions: [{ runner: 'pi', kind: 'capability-absent', reason: 'the wire has no such frame' }, { runner: 'omp', reason: 'no kind' }],
    })).toEqual([
      'Z1  first name',
      '    also: second name',
      '    scenario: (none declared)',
      '    kit: core/example.testkit.ts (A_CRITERIA, B_CRITERIA)',
      '    exempt: pi (capability-absent): the wire has no such frame',
      '    exempt: omp: no kind',
    ]);
    expect(formatRow({ id: 'Z2', kit: 'k', lists: ['L'], names: [], scenarios: ['baseline'], exemptions: [] })[0])
      .toBe('Z2  (no name: its cells carry it in their titles)');
  });

  it('answers a row query, a runner query and their errors', () => {
    const exempt = index.find(row => row.exemptions.length > 0)!;
    const { runner } = exempt.exemptions[0]!;

    const one = renderRows(index, { row: exempt.id });
    expect(one.error).toBeUndefined();
    expect(one.out[0]).toMatch(new RegExp(`^${exempt.id}  `));
    expect(one.out.at(-1)).toMatch(/^\d+ rows? in \d+ kits?$/);

    const byRunner = JSON.parse(renderRows(index, { runner, json: true }).out[0]!) as { id: string; exemptions: { runner: string }[] }[];
    expect(byRunner.map(row => row.id)).toContain(exempt.id);
    expect(byRunner.every(row => row.exemptions.length > 0 && row.exemptions.every(exemption => exemption.runner === runner))).toBe(true);

    expect(renderRows(index, { row: 'no-such-row' })).toEqual({ out: ['0 rows in 0 kits'], error: 'no kit declares row "no-such-row"' });
    expect(renderRows(index, { runner: 'no-such-runner' }).error).toMatch(/^unknown runner "no-such-runner"; the runners are /);
  });
});

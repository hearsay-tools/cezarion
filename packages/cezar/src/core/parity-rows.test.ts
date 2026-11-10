import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { parityRowIndex, unmatchedExemptions } from '../../scripts/parity-rows.ts';
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
});

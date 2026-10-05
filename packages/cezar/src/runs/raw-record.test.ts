import { describe, expect, it } from 'vitest';

import { collectRawExtras, encodeRawRecord } from './raw-record.ts';

/** The raw-record codec (#779, plan step 4): what a parse dropped goes back into the next write. */

/** Encode `current` over what `raw` held beyond `parsed`, and decode the result as JSON. */
const roundTrip = (raw: unknown, parsed: unknown, current: unknown) =>
  JSON.parse(encodeRawRecord(current, collectRawExtras(raw, parsed)).data);

describe('collectRawExtras', () => {
  it('finds nothing when the parse kept every field', () => {
    const raw = { id: 'a', steps: [{ id: 's1', status: 'done' }], tags: ['x'] };
    expect(collectRawExtras(raw, structuredClone(raw))).toBeUndefined();
  });

  it('finds nothing in a parse that only added defaults', () => {
    expect(collectRawExtras({ id: 'a' }, { id: 'a', archived: false })).toBeUndefined();
  });
});

describe('encodeRawRecord', () => {
  it('writes exactly JSON.stringify(current) when there is nothing to restore', () => {
    const current = { id: 'a', title: 't' };
    expect(encodeRawRecord(current, undefined)).toEqual({ data: JSON.stringify(current), extras: undefined });
  });

  it('keeps an unknown top-level field through a change of a known one', () => {
    const raw = { id: 'a', title: 'old', futureField: { deep: [1, 2] } };
    const parsed = { id: 'a', title: 'old' };
    expect(roundTrip(raw, parsed, { id: 'a', title: 'new' })).toEqual({ id: 'a', title: 'new', futureField: { deep: [1, 2] } });
  });

  it('deletes a known field the runtime deleted, beside an unknown one it keeps', () => {
    const raw = { id: 'a', pinned: true, pinnedAt: 'then', futureField: 1 };
    const parsed = { id: 'a', pinned: true, pinnedAt: 'then' };
    expect(roundTrip(raw, parsed, { id: 'a' })).toEqual({ id: 'a', futureField: 1 });
  });

  it('lets the runtime value win once it has one for a key it could not read before', () => {
    // A `.catch(undefined)` field (workflowDef) dropped on parse, then set again by the runtime.
    const raw = { id: 'a', workflowDef: { shape: 'newer' } };
    expect(roundTrip(raw, { id: 'a' }, { id: 'a', workflowDef: { name: 'w' } })).toEqual({ id: 'a', workflowDef: { name: 'w' } });
  });

  it('applies nested known changes and deletions recursively, keeping unknown siblings', () => {
    const raw = { id: 'a', delegation: { role: 'root', wait: { mode: 'all' }, futureNested: 'keep' } };
    const parsed = { id: 'a', delegation: { role: 'root', wait: { mode: 'all' } } };
    expect(roundTrip(raw, parsed, { id: 'a', delegation: { role: 'root' } }))
      .toEqual({ id: 'a', delegation: { role: 'root', futureNested: 'keep' } });
  });

  it('drops the unknown fields under a known object the runtime removed', () => {
    const raw = { id: 'a', ciWait: { state: 'x', future: 1 } };
    const parsed = { id: 'a', ciWait: { state: 'x' } };
    expect(roundTrip(raw, parsed, { id: 'a' })).toEqual({ id: 'a' });
  });

  it('follows keyed array elements by id, through reordering, removal and insertion', () => {
    const raw = { id: 'a', steps: [{ id: 's1', status: 'done', hint: 'one' }, { id: 's2', status: 'pending', hint: 'two' }] };
    const parsed = { id: 'a', steps: [{ id: 's1', status: 'done' }, { id: 's2', status: 'pending' }] };
    const current = { id: 'a', steps: [{ id: 'new', status: 'pending' }, { id: 's2', status: 'running' }] };
    expect(roundTrip(raw, parsed, current)).toEqual({
      id: 'a', steps: [{ id: 'new', status: 'pending' }, { id: 's2', status: 'running', hint: 'two' }],
    });
  });

  it('restores unknown fields inside an unkeyed array only while its known content is unchanged', () => {
    const raw = { id: 'a', checks: [{ name: 'lint', extra: 1 }, { name: 'test', extra: 2 }] };
    const parsed = { id: 'a', checks: [{ name: 'lint' }, { name: 'test' }] };
    expect(roundTrip(raw, parsed, { id: 'a', title: 'x', checks: [{ name: 'lint' }, { name: 'test' }] }))
      .toEqual({ id: 'a', title: 'x', checks: [{ name: 'lint', extra: 1 }, { name: 'test', extra: 2 }] });
    // Changed: the array is replaced as the runtime has it, and what it carried goes with it.
    expect(roundTrip(raw, parsed, { id: 'a', checks: [{ name: 'test' }] })).toEqual({ id: 'a', checks: [{ name: 'test' }] });
  });

  it('drops extras whose parent changed type', () => {
    const raw = { id: 'a', thing: { known: 1, unknown: 2 } };
    expect(roundTrip(raw, { id: 'a', thing: { known: 1 } }, { id: 'a', thing: 'now a string' })).toEqual({ id: 'a', thing: 'now a string' });
  });

  it('reports only the extras that survived, so a later write cannot resurrect dropped ones', () => {
    const raw = { id: 'a', top: 1, steps: [{ id: 's1', hint: 'gone' }, { id: 's2', hint: 'kept' }] };
    const parsed = { id: 'a', steps: [{ id: 's1' }, { id: 's2' }] };
    const first = encodeRawRecord({ id: 'a', steps: [{ id: 's2' }] }, collectRawExtras(raw, parsed));
    // s1 comes back with the same id: it is a new element now, without the old one's hint.
    const second = encodeRawRecord({ id: 'a', steps: [{ id: 's1' }, { id: 's2' }] }, first.extras);
    expect(JSON.parse(second.data)).toEqual({ id: 'a', top: 1, steps: [{ id: 's1' }, { id: 's2', hint: 'kept' }] });
  });

  it('reports no extras once every one of them is gone', () => {
    const raw = { id: 'a', steps: [{ id: 's1', hint: 'x' }] };
    const encoded = encodeRawRecord({ id: 'a', steps: [] }, collectRawExtras(raw, { id: 'a', steps: [{ id: 's1' }] }));
    expect(encoded.extras).toBeUndefined();
  });

  it('treats an array with a repeated id as unkeyed', () => {
    const raw = { id: 'a', items: [{ id: 'x', n: 1, u: 'a' }, { id: 'x', n: 2, u: 'b' }] };
    const parsed = { id: 'a', items: [{ id: 'x', n: 1 }, { id: 'x', n: 2 }] };
    expect(roundTrip(raw, parsed, { id: 'a', items: [{ id: 'x', n: 1 }, { id: 'x', n: 2 }] })).toEqual(raw);
  });

  it('never changes the record it encodes', () => {
    const raw = { id: 'a', future: 1, steps: [{ id: 's1', hint: 'x' }] };
    const current = { id: 'a', steps: [{ id: 's1' }] };
    const before = structuredClone(current);
    encodeRawRecord(current, collectRawExtras(raw, { id: 'a', steps: [{ id: 's1' }] }));
    expect(current).toEqual(before);
  });
});

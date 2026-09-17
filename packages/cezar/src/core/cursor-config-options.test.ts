import { describe, expect, it } from 'vitest';
import { parseCursorConfigOptions, cursorEffortSelection } from './cursor-config-options.ts';
const option = (id: string, values: string[]) => ({ id, name: id, type: 'select', currentValue: 'medium', options: values.map(value => ({ value, name: value })) });
describe('Cursor advertised effort', () => {
  it.each(['effort', 'reasoning', 'reasoning_effort'])('selects %s without confusing a thinking toggle with effort', id => {
    const options = parseCursorConfigOptions([option('thinking', ['true', 'false']), option(id, ['low', 'medium', 'high'])])!;
    expect(cursorEffortSelection(options, 'high')).toEqual({ configId: id, value: 'high' });
    expect(() => cursorEffortSelection(options, 'max')).toThrow('does not advertise');
  });
  it('does not guess missing capabilities or reinterpret another parameter', () => {
    expect(() => cursorEffortSelection([], 'high')).toThrow('does not advertise');
    expect(() => cursorEffortSelection(parseCursorConfigOptions([option('thinking', ['true', 'false'])])!, 'high')).toThrow('does not advertise');
  });
  it('rejects malformed snapshots and preserves valid empty snapshots', () => {
    expect(parseCursorConfigOptions(undefined)).toBeUndefined();
    expect(parseCursorConfigOptions([{ id: 'effort' }])).toBeUndefined();
    expect(parseCursorConfigOptions([])).toEqual([]);
  });
});

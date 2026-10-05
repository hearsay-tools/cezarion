import { describe, expect, it } from 'vitest';
import { parseConfigContent } from './shared.ts';

describe('parseConfigContent', () => {
  it('parses every catalog format, YAML included (a yaml file must never fall through to JSON.parse)', () => {
    expect(parseConfigContent('{"a":{"b":"x"}}', 'json')).toEqual({ a: { b: 'x' } });
    expect(parseConfigContent('{"a":1,} // c', 'jsonc')).toEqual({ a: 1 });
    expect(parseConfigContent('[a]\nb = "x"', 'toml')).toEqual({ a: { b: 'x' } });
    expect(parseConfigContent('a:\n  b: x\n', 'yaml')).toEqual({ a: { b: 'x' } });
  });
});

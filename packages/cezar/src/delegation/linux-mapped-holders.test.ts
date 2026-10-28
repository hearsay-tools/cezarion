import { expect, it } from 'vitest';
import { mappedPathScope } from './linux-mapped-holders.ts';

const line = (path: string) => `7f00-8f00 r--s 00000000 08:01 123 ${path}\n`;
it('interprets spaces, deleted names and ambiguous newline escapes conservatively', () => {
  expect(mappedPathScope(line('/owned/a b (deleted)'), ['/owned'])).toBe('held');
  expect(mappedPathScope(line('/owned (deleted)'), ['/owned'])).toBe('unknown');
  expect(mappedPathScope(line('/owned\\012child/file'), ['/owned\nchild'])).toBe('unknown');
  expect(mappedPathScope(line('/owned/file\\012name'), ['/owned'])).toBe('held');
  expect(mappedPathScope(line('/else/file'), ['/owned'])).toBe('clear');
  expect(mappedPathScope(line('/else/' + '\\012'.repeat(20)), ['/owned'])).toBe('clear');
  expect(mappedPathScope(line('[heap]'), ['/owned'])).toBe('clear');
  expect(mappedPathScope('bad record\n', ['/owned'])).toBe('unknown');
});

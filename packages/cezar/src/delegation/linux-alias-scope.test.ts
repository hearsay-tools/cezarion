import { expect, it } from 'vitest';
import { AliasMappingScope } from './linux-alias-scope.ts';

it('retains detached mappings for the confirmed incarnation without authorizing signals', () => {
  const scope = new AliasMappingScope();
  const maps = '1-2 r--p 0 08:01 123 /detached/file (deleted)\n';
  scope.remember(42, 'start-a', [{ dev: '8:1', ino: 123n }]);
  expect(scope.recheck(42, undefined, maps, false)).toBe('unknown');
  expect(scope.recheck(42, 'start-a', undefined, false)).toBe('unknown');
  expect(scope.recheck(42, 'start-a', maps + 'malformed\n', false, [])).toBe('unknown');
  expect(scope.recheck(42, 'start-a', maps, false, [])).toBe('unknown');
  expect(scope.recheck(42, 'start-a', '', false, [{ handle: 'fd/3', dev: '8:1', ino: 123n }])).toBe('unknown');
  expect(scope.recheck(42, 'start-a', '', false, [])).toBe('clear');
  scope.remember(42, 'start-a', [{ dev: '8:1', ino: 123n }]);
  expect(scope.recheck(42, 'start-b', maps, false)).toBe('clear');
  scope.remember(42, 'start-b', [{ dev: '8:1', ino: 123n }]);
  expect(scope.recheck(42, undefined, undefined, true)).toBe('clear');
});

it('retains previously scoped cwd and descriptors, including a duplicated descriptor', () => {
  const scope = new AliasMappingScope();
  scope.rememberLink(42, 'start-a', { handle: 'cwd', dev: '8:1', ino: 123n });
  scope.rememberLink(42, 'start-a', { handle: 'fd/4', dev: '8:1', ino: 456n });
  expect(scope.snapshot()).toEqual([{ pid: 42, token: 'start-a', identities: [{ dev: '8:1', ino: '123' }, { dev: '8:1', ino: '456' }] }]);
  expect(scope.recheck(42, 'start-a', '', false)).toBe('unknown');
  expect(scope.recheck(42, 'start-a', '1-2 r--p 0 08:01 456 /detached/file\n', false, [])).toBe('unknown');
  expect(scope.recheck(42, 'start-a', '', false, [{ handle: 'fd/9', dev: '8:1', ino: 456n }])).toBe('unknown');
  expect(scope.recheck(42, 'start-a', '', false, [{ handle: 'fd/9', dev: '8:1', ino: 457n }])).toBe('clear');
});

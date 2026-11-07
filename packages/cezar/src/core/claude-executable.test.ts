import { fileURLToPath } from 'node:url';
import { afterEach, expect, it, vi } from 'vitest';
import { resolveClaudeExecutable } from './claude-executable.ts';

afterEach(() => vi.unstubAllEnvs());

it.each([
  ['/explicit', '/preferred', '/legacy', '1', '1', '/explicit'],
  ['', '/preferred', '/legacy', '1', '1', ''],
  [undefined, '/preferred', '/legacy', '1', '1', '/preferred'],
  [undefined, undefined, '/legacy', '1', '1', '/legacy'],
  [undefined, '', '/legacy', '1', '1', ''],
  [undefined, undefined, undefined, '1', '0', 'mock'],
  [undefined, undefined, undefined, '0', '1', 'claude'],
  [undefined, undefined, undefined, '', '1', 'claude'],
  [undefined, undefined, undefined, undefined, '1', 'mock'],
  [undefined, undefined, undefined, undefined, undefined, 'claude'],
] as const)('selects the executable with explicit override %s, HSQ bin %s, CEZ bin %s, HSQ dry-run %s, CEZ dry-run %s', (override, preferredBin, legacyBin, preferredDryRun, legacyDryRun, expected) => {
  vi.stubEnv('HSQ_CLAUDE_BIN', preferredBin);
  vi.stubEnv('CEZ_CLAUDE_BIN', legacyBin);
  vi.stubEnv('HSQ_DRY_RUN', preferredDryRun);
  vi.stubEnv('CEZ_DRY_RUN', legacyDryRun);
  expect(resolveClaudeExecutable(override)).toBe(expected === 'mock'
    ? fileURLToPath(new URL('../../scripts/mock-claude.mjs', import.meta.url)) : expected);
});

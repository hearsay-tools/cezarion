import { afterEach, expect, it, vi } from 'vitest';
import { existsSync } from 'node:fs';
import { resolveCodexExecutable } from './codex-app-server-transport.ts';
import { OpencodeServerRunner } from './opencode-server-runner.ts';

afterEach(() => vi.unstubAllEnvs());
it('selects bundled Codex and OpenCode mocks in dry runs without host binaries', () => {
  vi.stubEnv('CEZ_DRY_RUN', '1');
  vi.stubEnv('CEZ_CODEX_BIN', undefined);
  vi.stubEnv('CEZ_OPENCODE_BIN', undefined);
  const codex = resolveCodexExecutable();
  const opencode = (new OpencodeServerRunner() as unknown as { bin: string }).bin;
  expect(codex).toMatch(/scripts\/mock-codex-app-server\.mjs$/);
  expect(opencode).toMatch(/scripts\/mock-opencode-serve\.mjs$/);
  expect(existsSync(codex)).toBe(true);
  expect(existsSync(opencode)).toBe(true);
});
it('preserves explicit binary overrides during dry runs', () => {
  vi.stubEnv('CEZ_DRY_RUN', '1');
  vi.stubEnv('CEZ_CODEX_BIN', '/configured/codex');
  vi.stubEnv('CEZ_OPENCODE_BIN', '/configured/opencode');
  expect(resolveCodexExecutable()).toBe('/configured/codex');
  expect(resolveCodexExecutable('/explicit/codex')).toBe('/explicit/codex');
  expect((new OpencodeServerRunner() as unknown as { bin: string }).bin).toBe('/configured/opencode');
  expect((new OpencodeServerRunner({ bin: '/explicit/opencode' }) as unknown as { bin: string }).bin).toBe('/explicit/opencode');
});
